/**
 * Resolving a typed pairing code into a pairing: the wallet side of the code path.
 * The security checks live in `resolveLookup`; this only gets candidates in front
 * of it.
 */

import {
  DEFAULT_RELAYS,
  RelayPool,
  lookupFilter,
  normalizeCode,
  resolveLookup,
  type NostrEvent,
  type PairingParams,
  type RelayStatus,
} from '@verumlab/connect-protocol';

/**
 * How long to keep collecting candidates. Not an optimisation to trim: deciding on
 * the first event would defeat the conflict check, which needs every reachable
 * candidate seen.
 */
const COLLECT_MS = 2_500;

/** How long to wait for any relay at all before giving up. */
const CONNECT_MS = 8_000;

export interface ResolveCodeOptions {
  relays?: string[];
  collectMs?: number;
  /**
   * Called as the lookup's own relays connect. The pool is transient and never
   * appears in hub state, so without this a failure reads as "wrong code" rather
   * than "no relay".
   */
  onStatusChange?: (statuses: Record<string, RelayStatus>) => void;
  /** Called with whatever a relay says about a refusal during the search. */
  onNotice?: (relay: string, message: string) => void;
}

/**
 * The relays a lookup searches when none are named: fixed, since a wallet holding
 * only a code has nowhere to read a list from.
 */
export const CODE_LOOKUP_RELAYS = DEFAULT_RELAYS;

/**
 * Look up a typed pairing code and return the pairing it names. Rejects with
 * `LookupConflictError` when two keys claim the code (interference: switch to the
 * QR) and a plain error when nothing valid was found (expired or mistyped); a
 * caller must keep them apart. The relays returned are the ones searched: the
 * parked event names none, and the dapp is demonstrably reachable there. Its full
 * set arrives in `connect_ack`.
 */
export async function resolvePairingCode(
  code: string,
  {
    relays = CODE_LOOKUP_RELAYS,
    collectMs = COLLECT_MS,
    onStatusChange,
    onNotice,
  }: ResolveCodeOptions = {},
): Promise<PairingParams> {
  // Normalise first so a mistyped character fails before any socket opens.
  const normalized = normalizeCode(code);

  const events: NostrEvent[] = [];

  // The best each relay managed during the search, reported in place of live
  // statuses, which are all closed once the pool is: "no payload found" beside "0 of
  // 4 connected" would read as the search never running.
  const best: Record<string, RelayStatus> = {};
  const note = (statuses: Record<string, RelayStatus>): void => {
    for (const [url, status] of Object.entries(statuses)) {
      if (status === 'open' || !best[url]) best[url] = status;
    }
    onStatusChange?.(statuses);
  };

  const pool = new RelayPool(relays, {
    onStatusChange: note,
    // A lookup that finds nothing and a relay that refuses to answer look alike; this
    // says which.
    onNotice: (relay, message, kind) => {
      console.warn(`[verum-hub] ${relay} (${kind}): ${message}`);
      // Only refusals reach the UI: a relay talking is not a relay refusing.
      if (kind === 'refusal') onNotice?.(relay, message);
    },
  });

  try {
    pool.connect();
    if (!(await pool.waitForConnection(CONNECT_MS))) {
      throw new Error('No relay could be reached. Check your connection.');
    }

    pool.subscribe('verum-code-lookup', [lookupFilter(normalized)], (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, collectMs));
  } finally {
    pool.close();
    onStatusChange?.(best);
  }

  // Not truncated: these are the hub's own relays, not a list a link asked it to
  // trust.
  return { publicKey: resolveLookup(events, normalized), relays, relaysNamed: relays.length };
}
