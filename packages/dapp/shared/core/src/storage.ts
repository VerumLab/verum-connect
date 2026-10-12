/**
 * What the dapp side keeps across page loads: the ephemeral session key (so a
 * reload needs no re-scan; it authorises nothing on-chain but is still a secret,
 * so it stays in the host's own store and is wiped on disconnect), a pairing
 * awaiting its answer, and the user's gateway, network and relay choices. The
 * store is injected: localStorage by default, and null keeps nothing beyond the
 * run.
 */

import {
  StorageSnapshot,
  browserStorage,
  type DappMetadata,
  type KeyValueStorage,
} from '@verumlab/connect-protocol';

const SESSION_KEY = 'verum-connect/session/v1';
const PENDING_KEY = 'verum-connect/pending/v1';
const GATEWAY_KEY = 'verum-connect/gateway/v1';
const WEBVIEW_GATEWAY_KEY = 'verum-connect/gateway-webview/v1';
const RELAYS_KEY = 'verum-connect/relays/v2';
const NETWORK_KEY = 'verum-connect/network/v1';
const AR_GATEWAY_KEY = 'verum-connect/gateway-arweave/v1';
const AR_WEBVIEW_GATEWAY_KEY = 'verum-connect/gateway-arweave-webview/v1';

const KEYS = [
  SESSION_KEY,
  PENDING_KEY,
  GATEWAY_KEY,
  WEBVIEW_GATEWAY_KEY,
  RELAYS_KEY,
  NETWORK_KEY,
  AR_GATEWAY_KEY,
  AR_WEBVIEW_GATEWAY_KEY,
];

export interface StoredSession {
  secretKey: string;
  publicKey: string;
  peerPublicKey: string;
  relays: string[];
  accounts: string[];
  chainId: string;
  metadata: DappMetadata;
  createdAt: number;
}

/** How long a pairing is worth resuming; matches waitForSession's default. */
export const PENDING_TTL_MS = 300_000;

/**
 * A pairing minted but not yet answered. It exists because the mobile handoff
 * backgrounds the tab and iOS may discard it: without this the reload mints a new
 * keypair and a hub that paired meanwhile talks to a key nobody holds. No link is
 * stored: the hub address and build are rebuilt from the dapp's config on resume,
 * so a release that moves to a new hub build reaches a pairing in flight.
 */
export interface PendingPairing {
  secretKey: string;
  publicKey: string;
  relays: string[];
  createdAt: number;
}

export interface StoredRelays {
  urls: string[];
  /**
   * The dapp's own defaults at the moment they chose, stored so a later release can
   * be noticed: otherwise an override is permanent and silent after the developer
   * swaps out dead relays. It also separates relays the user added from inherited
   * ones, so a reset keeps the former.
   */
  preset: string[];
}

export class DappStorage {
  private readonly snapshot: StorageSnapshot;

  constructor(backend: KeyValueStorage | null) {
    this.snapshot = new StorageSnapshot(backend, KEYS);
  }

  /**
   * Resolves once what was stored has been read; before that loads return null,
   * which reads as the defaults.
   */
  get ready(): Promise<void> {
    return this.snapshot.ready;
  }

  /** Resolves once every write made so far has reached the backend. */
  flush(): Promise<void> {
    return this.snapshot.flush();
  }

  loadSession(): StoredSession | null {
    const parsed = this.json<StoredSession>(SESSION_KEY);
    if (!parsed?.secretKey || !parsed.peerPublicKey || !Array.isArray(parsed.relays)) return null;
    return parsed;
  }

  saveSession(session: StoredSession): void {
    this.snapshot.set(SESSION_KEY, JSON.stringify(session));
  }

  clearSession(): void {
    this.snapshot.remove(SESSION_KEY);
  }

  loadPending(): PendingPairing | null {
    const parsed = this.json<PendingPairing>(PENDING_KEY);
    if (!parsed?.secretKey || !parsed.publicKey || !Array.isArray(parsed.relays)) return null;
    if (typeof parsed.createdAt !== 'number') return null;
    if (Date.now() - parsed.createdAt > PENDING_TTL_MS) {
      this.clearPending();
      return null;
    }
    return parsed;
  }

  savePending(pending: PendingPairing): void {
    this.snapshot.set(PENDING_KEY, JSON.stringify(pending));
  }

  clearPending(): void {
    this.snapshot.remove(PENDING_KEY);
  }

  /**
   * The user's gateway choice, kept apart from session state so it survives
   * disconnects.
   */
  loadGateway(): string | null {
    return this.snapshot.get(GATEWAY_KEY);
  }

  saveGateway(template: string): void {
    this.snapshot.set(GATEWAY_KEY, template);
  }

  /**
   * Stored apart from the pairing gateway.
   */
  loadWebviewGateway(): string | null {
    return this.snapshot.get(WEBVIEW_GATEWAY_KEY);
  }

  saveWebviewGateway(template: string): void {
    this.snapshot.set(WEBVIEW_GATEWAY_KEY, template);
  }

  /** The user's relay choice, kept apart from session state for the same reason. */
  loadRelays(): StoredRelays | null {
    const parsed = this.json<Partial<StoredRelays>>(RELAYS_KEY);
    if (!parsed) return null;
    const urls = (parsed.urls ?? []).filter((u): u is string => typeof u === 'string');
    if (urls.length === 0) return null;
    const preset = (parsed.preset ?? []).filter((u): u is string => typeof u === 'string');
    return { urls, preset };
  }

  saveRelays(urls: string[], preset: string[]): void {
    this.snapshot.set(RELAYS_KEY, JSON.stringify({ urls, preset }));
  }

  /**
   * Which network the hub is fetched over ('arweave' or 'ipfs'). Separate because it
   * selects between the gateways, each network keeping its own.
   */
  loadNetwork(): string | null {
    return this.snapshot.get(NETWORK_KEY);
  }

  saveNetwork(network: string): void {
    this.snapshot.set(NETWORK_KEY, network);
  }

  loadArweaveGateway(): string | null {
    return this.snapshot.get(AR_GATEWAY_KEY);
  }

  saveArweaveGateway(template: string): void {
    this.snapshot.set(AR_GATEWAY_KEY, template);
  }

  loadArweaveWebviewGateway(): string | null {
    return this.snapshot.get(AR_WEBVIEW_GATEWAY_KEY);
  }

  saveArweaveWebviewGateway(template: string): void {
    this.snapshot.set(AR_WEBVIEW_GATEWAY_KEY, template);
  }

  private json<T>(key: string): T | null {
    const raw = this.snapshot.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

const shared = new WeakMap<KeyValueStorage, DappStorage>();

/**
 * The dapp storage for a backend, shared by everything naming the same one: the
 * resolvers run without a provider (a wallet selector asks for the hub URL while
 * rendering), so a choice the provider saves must show up there without
 * re-reading. `undefined` means the default (localStorage where present); `null`
 * keeps nothing, with a private empty store per caller.
 */
export function dappStorage(backend: KeyValueStorage | null | undefined): DappStorage {
  const resolved = backend === undefined ? browserStorage() : backend;
  if (!resolved) return new DappStorage(null);

  let storage = shared.get(resolved);
  if (!storage) {
    storage = new DappStorage(resolved);
    shared.set(resolved, storage);
  }
  return storage;
}
