/**
 * Persistence, the one thing every host supplies differently. The interface is
 * async because an async interface can wrap a synchronous store and not the
 * reverse, so it fits every backend (localStorage, extension storage, IndexedDB,
 * files, keychains).
 */

/**
 * What a host supplies to keep state across restarts. Strings only: every backend
 * can hold one, and callers already serialise.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const adapters = new WeakMap<Storage, KeyValueStorage>();

/**
 * localStorage behind the async interface, or null where there is none. Null
 * rather than an in-memory stand-in, which would make resuming look supported and
 * quietly never work. One adapter per Storage object, so callers can cache per
 * backend.
 */
export function browserStorage(): KeyValueStorage | null {
  let local: Storage | undefined;
  try {
    local = globalThis.localStorage;
  } catch {
    // Private mode and sandboxed iframes can throw on access alone.
    return null;
  }
  if (!local) return null;

  let adapter = adapters.get(local);
  if (!adapter) {
    const store = local;
    adapter = {
      getItem: async (key) => store.getItem(key),
      setItem: async (key, value) => store.setItem(key, value),
      removeItem: async (key) => store.removeItem(key),
    };
    adapters.set(local, adapter);
  }
  return adapter;
}

/**
 * A synchronous view over an async store, for reads that cannot await (a wallet
 * selector reads the hub URL while rendering, before any provider exists). Known
 * keys load into memory once; writes land in memory immediately and reach the
 * backend behind. Until `ready` resolves a read returns null, which callers treat
 * as nothing stored.
 */
export class StorageSnapshot {
  /**
   * Resolves once every key has been read. Never rejects: an unreadable key reads as
   * absent.
   */
  readonly ready: Promise<void>;

  private readonly keys: ReadonlySet<string>;
  private readonly values = new Map<string, string | null>();
  /** Keys written or removed here before hydration reached them. */
  private readonly touched = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: KeyValueStorage | null,
    keys: readonly string[],
  ) {
    this.keys = new Set(keys);
    this.ready = this.hydrate();
  }

  get(key: string): string | null {
    this.assertKnown(key);
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.assertKnown(key);
    this.values.set(key, value);
    this.touched.add(key);
    this.enqueue((backend) => backend.setItem(key, value));
  }

  remove(key: string): void {
    this.assertKnown(key);
    this.values.set(key, null);
    this.touched.add(key);
    this.enqueue((backend) => backend.removeItem(key));
  }

  /** Resolves once every write made so far has reached the backend. */
  flush(): Promise<void> {
    return this.writes;
  }

  private async hydrate(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    await Promise.all(
      [...this.keys].map(async (key) => {
        let value: string | null = null;
        try {
          value = await backend.getItem(key);
        } catch {
          // Unreadable reads as absent.
        }
        // A write made while this read was outstanding is newer than whatever
        // the backend returned, however the two raced.
        if (!this.touched.has(key)) this.values.set(key, value);
      }),
    );
  }

  /**
   * One write at a time, in order. Without the chain an async backend may apply two
   * writes to a key in either order and the older can land last, silently undoing
   * the newer. localStorage never shows this, which is why it would ship unnoticed.
   */
  private enqueue(write: (backend: KeyValueStorage) => Promise<void>): void {
    const backend = this.backend;
    if (!backend) return;
    this.writes = this.writes
      .then(() => write(backend))
      .catch(() => {
        // Quota or a revoked store. The value still holds in memory for this
        // run, and the next write is not held hostage to this one.
      });
  }

  /** A key missing from the list is never hydrated, so reading it would
   *  silently return null forever. Loud instead. */
  private assertKnown(key: string): void {
    if (!this.keys.has(key)) throw new Error(`storage: "${key}" was not declared`);
  }
}
