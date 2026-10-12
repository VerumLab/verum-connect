/**
 * What a wallet has to supply: one function. A wallet that speaks EIP-1193 (an
 * extension, desktop app, hardware companion, headless signer) implements
 * `request` and is done; the session handles nostr, pairing and the queue and
 * hands each call straight to it.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}
