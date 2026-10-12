/**
 * The typed-code pairing as rules a renderer does not reimplement: offering a code,
 * keeping it fresh, and turning the wallets that answer it into a choice. No DOM,
 * so a selector that owns its modal and one that can only show text read the same
 * state.
 */

import {
  ConnectAmbiguityError,
  type PairingCodeStatus,
  type PendingConnect,
  type VerumConnectProvider,
} from '@verumlab/connect-dapp';

/**
 * How old a code may get before replacement, in ms. 
 * Selectors that show the code as plain text cannot
 * redraw it, so it must be fresh on arrival with life left to type.
 */
export const CODE_REFRESH_AFTER_MS = 240_000;

export interface CodeState {
  status: PairingCodeStatus;
  /** Grouped for display, or null while none is usable. */
  code: string | null;
  /** Wallets that answered the code, each with the session code it shows. */
  pending: PendingConnect[];
  /** Why the pending list cannot be chosen from, when it cannot. */
  failure: string | null;
}

export interface CodeController {
  getState(): CodeState;
  subscribe(listener: (state: CodeState) => void): () => void;
  /** Park a new code, replacing any current one. Call once a pairing exists. */
  offer(): Promise<void>;
  /** Replace the code if it is older than the refresh age and nobody is
   *  mid-choice. For the moment a selector is about to show it. */
  refreshIfStale(): Promise<void>;
  /** Commit to the wallet showing this session code. */
  select(sessionCode: string): Promise<boolean>;
  /** None of the wallets matched: withdraw the code and offer a fresh one. */
  withdraw(): void;
  destroy(): void;
}

export interface CodeControllerOptions {
  refreshAfterMs?: number;
}

export function createCodeController(
  provider: VerumConnectProvider,
  { refreshAfterMs = CODE_REFRESH_AFTER_MS }: CodeControllerOptions = {},
): CodeController {
  const listeners = new Set<(state: CodeState) => void>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function read(): CodeState {
    let pending: PendingConnect[] = [];
    let failure: string | null = null;
    try {
      pending = provider.pendingConnects;
    } catch (err) {
      failure =
        err instanceof ConnectAmbiguityError
          ? 'Two wallets are showing the same session code, so there is no way to tell them apart.'
          : 'This code can no longer be used.';
    }
    return {
      status: provider.pairingCodeStatus,
      code: provider.pairingCode,
      pending,
      failure,
    };
  }

  /**
   * A choice in progress outranks freshness: replacing the code drops the held
   * connects and would take the matching wallet from someone halfway through
   * picking.
   */
  function deciding(state: CodeState): boolean {
    return state.pending.length > 0 || state.failure !== null;
  }

  function schedule(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    const parkedAt = provider.pairingCodeParkedAt;
    if (destroyed || parkedAt === null) return;
    refreshTimer = setTimeout(
      () => void refreshIfStale(),
      Math.max(0, parkedAt + refreshAfterMs - Date.now()),
    );
  }

  function notify(): void {
    schedule();
    const state = read();
    for (const listener of listeners) listener(state);
  }

  const offCode = provider.on('code_changed', notify);
  const offPending = provider.on('pending_connects_changed', notify);

  async function offer(): Promise<void> {
    if (destroyed || provider.pairingCodeStatus === 'publishing') return;
    try {
      await provider.offerPairingCode();
    } catch {
      // The status says failed, which is what a renderer shows; why is not the user's to
      // act on.
    }
    notify();
  }

  async function refreshIfStale(): Promise<void> {
    const state = read();
    if (deciding(state)) {
      // Checked again when the choice resolves, since that fires a change.
      return;
    }
    const parkedAt = provider.pairingCodeParkedAt;
    const stale = parkedAt === null || Date.now() - parkedAt >= refreshAfterMs;
    // Nothing on offer is stale too, unless spent on purpose: a flood means the code is
    // under attack, and minting another hands them the next.
    if (stale && state.status !== 'flooded') await offer();
  }

  return {
    getState: read,
    subscribe(listener) {
      listeners.add(listener);
      listener(read());
      return () => listeners.delete(listener);
    },
    offer,
    refreshIfStale,
    async select(sessionCode) {
      const ok = await provider.selectPendingConnect(sessionCode);
      notify();
      return ok;
    },
    withdraw() {
      // Withdrawn, not left alive: when nothing matches the code is being raced, and
      // keeping it invites the same choice.
      provider.clearCodePairing();
      void offer();
    },
    destroy() {
      destroyed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      offCode();
      offPending();
      listeners.clear();
    },
  };
}
