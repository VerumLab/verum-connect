/**
 * Encrypted channel between one dapp and one hub session: a RelayPool plus the
 * conversation key, so callers deal in envelopes. Both sides use it identically;
 * the asymmetry lives above, in who sends `connect` and who sends `hello`.
 */

import {
  KIND_SESSION,
  buildEvent,
  isFresh,
  tagValue,
  type NostrEvent,
} from './events.js';
import { conversationKey } from './keys.js';
import { decrypt, encrypt } from './nip44.js';
import { fingerprint } from './fingerprint.js';
import { PROTOCOL_VERSION, parseEnvelope, type Envelope } from './envelope.js';
import type { RelayPool } from './relay.js';

export interface ChannelOptions {
  pool: RelayPool;
  secretKey: string;
  /** Our pubkey, to filter our own events back out. */
  publicKey: string;
  peerPublicKey: string;
  kind?: number;
}

export class Channel {
  readonly peerPublicKey: string;
  readonly publicKey: string;
  readonly conversationKey: Uint8Array;
  readonly fingerprint: string[];

  private readonly pool: RelayPool;
  private readonly secretKey: string;
  private readonly kind: number;
  private readonly handlers = new Set<(envelope: Envelope) => void>();
  private unsubscribe: (() => void) | null = null;
  /**
   * created_at of the newest event accepted from this peer. Anything at or below it
   * is dropped, closing the replay window clock skew leaves open.
   */
  private lastSeenAt = 0;

  constructor(opts: ChannelOptions) {
    this.pool = opts.pool;
    this.secretKey = opts.secretKey;
    this.publicKey = opts.publicKey;
    this.peerPublicKey = opts.peerPublicKey;
    this.kind = opts.kind ?? KIND_SESSION;
    this.conversationKey = conversationKey(opts.secretKey, opts.peerPublicKey);
    this.fingerprint = fingerprint(this.conversationKey);
  }

  /** Begin receiving. Safe to call more than once. */
  open(subscriptionId: string): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pool.subscribe(
      subscriptionId,
      [
        {
          kinds: [this.kind],
          authors: [this.peerPublicKey],
          '#p': [this.publicKey],
        },
      ],
      (event) => this.handleEvent(event),
    );
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handlers.clear();
  }

  onEnvelope(handler: (envelope: Envelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(envelope: Omit<Envelope, 'v'> & { v?: number }): Promise<void> {
    const payload = JSON.stringify({ ...envelope, v: PROTOCOL_VERSION });
    const content = encrypt(payload, this.conversationKey);
    const event = buildEvent(this.kind, content, this.peerPublicKey, this.secretKey);
    await this.pool.publish(event);
  }

  private handleEvent(event: NostrEvent): void {
    // The pool has already checked id and signature. What is left is whether
    // this event belongs to *this* channel and is not a replay.
    if (event.pubkey !== this.peerPublicKey) return;
    if (tagValue(event, 'p') !== this.publicKey) return;
    if (!isFresh(event)) return;
    if (event.created_at < this.lastSeenAt) return;

    let envelope: Envelope;
    try {
      envelope = parseEnvelope(decrypt(event.content, this.conversationKey));
    } catch {
      // Undecryptable or malformed: not addressed to us in any meaningful sense.
      return;
    }

    this.lastSeenAt = Math.max(this.lastSeenAt, event.created_at);
    for (const handler of this.handlers) {
      try {
        handler(envelope);
      } catch (err) {
        console.error('[verum-connect] envelope handler threw', err);
      }
    }
  }
}
