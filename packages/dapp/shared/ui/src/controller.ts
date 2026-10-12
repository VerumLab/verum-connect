/**
 * The relay-editing rules, once, with no DOM or framework. Every change must
 * re-pair: setRelays only records the choice, and connectors resume an existing
 * pairing in preference to minting one, so the next connect would come back on the
 * replaced set. The last relay cannot be removed (no transport). Edits are refused
 * while a code is on screen: selectors read the URI once when they render the QR,
 * so a change behind a live code produces a link pairing the hub on relays the
 * dapp has left, failing silently on both sides.
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';

export interface RelayState {
  relays: string[];
  /** Per-relay connection state keyed by url: 'connecting' | 'open' | 'closed'. */
  statuses: Record<string, string>;
  /**
   * What a relay said when it refused something, by url: a socket can be open to a
   * relay that rejects every event (paid, or filtering unknown pubkeys), which the
   * status cannot show.
   */
  notices: Record<string, string>;
  /**
   * Whether a connect code is parked, which is what makes the three fields below
   * mean anything.
   */
  codeParked: boolean;
  /**
   * Relays that accepted the parked code and served it back; the hub can only find a
   * code on these.
   */
  codeKept: string[];
  /**
   * Relays that accepted it and had nothing when asked; they still carry QR or URL
   * sessions, which are stored nowhere.
   */
  codeDropped: string[];
  /** Last rejected change, e.g. a url that is not a websocket. */
  error: string | null;
  locked: boolean;
  /** False while a change is being applied, so a UI can disable during re-pair. */
  idle: boolean;
  /**
   * True when the four fields above describe the last pairing, not a live one.
   * Closing a selector's modal ends the pairing, and the settings behind it would
   * show a grey corpse; remembering the last state keeps the answer readable, and this
   * flag stops it being read as the present.
   */
  stale: boolean;
}

export interface RelayController {
  getState(): RelayState;
  /** Returns an unsubscribe. Fires on every state change. */
  subscribe(listener: (state: RelayState) => void): () => void;
  setLocked(locked: boolean): void;
  add(url: string): void;
  remove(url: string): void;
  /** Restores the dapp's defaults, keeping anything added by hand. */
  reset(): void;
  /** Stop polling and release listeners. */
  destroy(): void;
}

export interface RelayControllerOptions {
  /**
   * How often to re-read relay status: a relay can drop or reconnect with nothing
   * else changing, and that is no provider event.
   */
  pollMs?: number;
}

/**
 * Whether these statuses describe a pairing that exists. Not "are there any": a
 * closed pool still lists its relays, all closed, which is what a dismissed modal
 * leaves, and treating that as live overwrote the memory of the pairing. A pool torn
 * down outright reports nothing; both mean nothing is connected.
 */
function isLive(statuses: Record<string, string>): boolean {
  return Object.values(statuses).some((s) => s === 'open' || s === 'connecting');
}

export function createRelayController(
  provider: VerumConnectProvider,
  { pollMs = 1500 }: RelayControllerOptions = {},
): RelayController {
  /** The last pairing that actually existed, kept for after it ends. */
  let last: Pick<RelayState, 'statuses' | 'codeParked' | 'codeKept' | 'codeDropped'> = {
    statuses: {},
    codeParked: false,
    codeKept: [],
    codeDropped: [],
  };

  let state: RelayState = {
    relays: provider.relayUrls,
    statuses: provider.relayStatuses as Record<string, string>,
    notices: provider.relayNotices,
    codeParked: provider.pairingCode !== null,
    codeKept: provider.pairingCodeRelays,
    codeDropped: provider.pairingCodeDropped,
    error: null,
    locked: false,
    idle: true,
    stale: false,
  };

  // Seeded from the state above, so a controller created during a live pairing and
  // read after it ends remembers something.
  if (isLive(state.statuses)) {
    last = {
      statuses: state.statuses,
      codeParked: state.codeParked,
      codeKept: state.codeKept,
      codeDropped: state.codeDropped,
    };
  }

  const listeners = new Set<(s: RelayState) => void>();
  const emit = () => listeners.forEach((l) => l(state));
  const set = (patch: Partial<RelayState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const readBack = () => {
    const statuses = provider.relayStatuses as Record<string, string>;
    const live = isLive(statuses);
    if (live) {
      last = {
        statuses,
        codeParked: provider.pairingCode !== null,
        codeKept: provider.pairingCodeRelays,
        codeDropped: provider.pairingCodeDropped,
      };
    }

    set({
      relays: provider.relayUrls,
      notices: provider.relayNotices,
      ...(live
        ? {
            statuses,
            codeParked: provider.pairingCode !== null,
            codeKept: provider.pairingCodeRelays,
            codeDropped: provider.pairingCodeDropped,
            stale: false,
          }
        : { ...last, stale: Object.keys(last.statuses).length > 0 }),
    });
  };

  const offSession = provider.on('session_changed', readBack);
  // Parking a code, and the verification that follows it, both land here.
  const offCode = provider.on('code_changed', readBack);
  const timer = setInterval(readBack, pollMs);

  async function apply(next: string[]): Promise<void> {
    if (state.locked || !state.idle) return;
    const hadCode = provider.pairingCode !== null;
    set({ idle: false });
    try {
      provider.setRelays(next);
      await provider.pair();
      // A code parked before the change is on relays this dapp just left, and pair()
      // discarded it. Offering another puts it on the new set and runs the same
      // verification, the only thing that says whether the new relays can carry a code.
      if (hadCode) await provider.offerPairingCode();
      set({ error: null, idle: true });
      readBack();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), idle: true });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLocked: (locked) => set({ locked }),
    add: (url) => void apply([...state.relays, url.trim()]),
    remove: (url) => {
      if (state.relays.length <= 1) return;
      void apply(state.relays.filter((u) => u !== url));
    },
    reset: () => void apply(provider.resetRelays()),
    destroy() {
      clearInterval(timer);
      offSession();
      offCode();
      listeners.clear();
    },
  };
}

/** A colour role, not a colour: each renderer owns its palette. */
export type RelayTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface RelayDescription {
  /**
   * The dot beside the relay: `danger` whenever it refuses our events however open
   * its socket is, since an open connection to something that rejects everything is
   * the most misleading thing a list can show.
   */
  tone: RelayTone;
  /** What that dot means, for a title attribute. */
  status: string;
  /** What this relay did with the parked connect code, or null when there is no
   *  code to reason about or the relay refuses outright. */
  code: { text: string; tone: RelayTone; title: string } | null;
  /**
   * What the relay said when it refused, or null: shown on a click, as a tooltip
   * never arrives on a touch screen.
   */
  refused: string | null;
}

/**
 * How one relay is doing, as a description a renderer draws in its own style.
 * Markup is not shared but these decisions are: which badge a relay has earned,
 * what it means, and whether the dot should contradict the socket.
 */
export function describeRelay(
  state: Pick<RelayState, 'statuses' | 'notices' | 'codeParked' | 'codeKept' | 'codeDropped'>,
  url: string,
): RelayDescription {
  const refused = state.notices[url] ?? null;
  const status = state.statuses[url];

  if (refused) {
    return { tone: 'danger', status: 'refuses our events', code: null, refused };
  }

  const tone: RelayTone =
    status === 'open' ? 'ok' : status === 'connecting' ? 'warn' : 'muted';

  if (!state.codeParked) {
    return { tone, status: status ?? 'not connected', code: null, refused: null };
  }

  // Only a typed code needs a relay to keep anything (QR and URL sessions are
  // ephemeral), so failing here warns about one path, not the connection.
  const code = state.codeKept.includes(url)
    ? { text: 'code ✓', tone: 'ok' as const, title: 'Holds the connect code and served it back.' }
    : state.codeDropped.includes(url)
      ? {
          text: 'code ✗',
          tone: 'warn' as const,
          title: 'Accepted it and kept nothing — allows QR and URL, not code connect.',
        }
      : {
          // Silence is no evidence a QR would work here: nothing has been carried, so
          // nothing is known.
          text: 'code ?',
          tone: 'muted' as const,
          title:
            'Never answered the publish — nothing has been carried, so QR is untested here too.',
        };

  return { tone, status: status ?? 'not connected', code, refused: null };
}
