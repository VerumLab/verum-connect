/**
 * What the injected page script and the panel say to each other. They are split
 * because a dapp's CSP governs what its page may connect to, so relay sockets
 * opened from the page would be blocked; `postMessage` is no network connection,
 * so the page holds a provider that only forwards and the panel, on our origin,
 * holds the sockets. That also gives the panel the dapp's origin from
 * `MessageEvent.origin`, which the browser sets and the page cannot forge.
 */

export const PROTOCOL = 'verum-bookmarklet/1';

/**
 * Sent by the panel as soon as it can listen. Carries no state, so it is the one
 * message broadcast without a known target origin.
 */
export interface ReadyMessage {
  v: typeof PROTOCOL;
  type: 'ready';
}

/**
 * The page introducing itself: self-reported and shown as such; the origin comes
 * from the event.
 */
export interface HelloMessage {
  v: typeof PROTOCOL;
  type: 'hello';
  title: string;
  icon?: string;
  /**
   * This panel was not loaded from the address the bookmark was made with (a gateway
   * was chosen on the page). 
   */
  elsewhere?: boolean;
}

export interface RequestMessage {
  v: typeof PROTOCOL;
  type: 'request';
  id: number;
  method: string;
  params: unknown[];
}

export interface ResultMessage {
  v: typeof PROTOCOL;
  type: 'result';
  id: number;
  result: unknown;
}

export interface ErrorMessage {
  v: typeof PROTOCOL;
  type: 'error';
  id: number;
  error: { code: number; message: string };
}

/**
 * The session is live. The page answers `eth_accounts` from this without a round
 * trip.
 */
export interface SessionMessage {
  v: typeof PROTOCOL;
  type: 'session';
  accounts: string[];
  chainId: string;
  /**
   * The four words identifying this session, for the page to show beside the dapp's
   * own UI.
   */
  code?: string[];
}

export interface EventMessage {
  v: typeof PROTOCOL;
  type: 'event';
  event: 'accountsChanged' | 'chainChanged' | 'disconnect';
  data: unknown;
}

/**
 * Sent just before the page navigates the panel's window to raise it: a
 * navigation looks like a closing tab from inside and would make the panel tell
 * the hub the session is over.
 */
export interface RaiseMessage {
  v: typeof PROTOCOL;
  type: 'raise';
}

/**
 * The page's answer to `use-panel`: the preference is gone. Without it the window
 * could only guess, and an older bookmark does not know the request.
 */
export interface UsePanelDoneMessage {
  v: typeof PROTOCOL;
  type: 'use-panel-done';
}

export type ToPopup = HelloMessage | RequestMessage | RaiseMessage | UsePanelDoneMessage;
/**
 * Sent by a panel in its own window: open the side panel here next time. The
 * choice is kept in the dapp's storage. Nothing changes for the session in progress.
 */
export interface UsePanelMessage {
  v: typeof PROTOCOL;
  type: 'use-panel';
}

export type ToPage =
  | ReadyMessage
  | SessionMessage
  | ResultMessage
  | ErrorMessage
  | EventMessage
  | UsePanelMessage;

export function isVerumMessage(data: unknown): data is { v: string; type: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { v?: unknown }).v === PROTOCOL &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}
