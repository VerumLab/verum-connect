/** Nostr event construction, signing and verification. */

import { sha256 } from '@noble/hashes/sha256';
import { publicKeyFromSecret, sign, verify } from './keys.js';
import { bytesToHex, nowSeconds, utf8Encode } from './util.js';

/**
 * Ephemeral kinds (20000..29999): relays fan these out and persist nothing. Every
 * message is ephemeral on purpose: a request sent while the hub is closed is
 * re-sent on reconnect, not parked on someone else's disk.
 */
export const KIND_HANDSHAKE = 24141;
export const KIND_SESSION = 24140;

/** Reject anything whose timestamp is further than this from our clock. Bounds
 *  how long a captured event stays replayable. */
export const MAX_CLOCK_SKEW_SECONDS = 120;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>;

/** Canonical serialisation from NIP-01. Field order is part of the spec. */
function serializeEvent(pubkey: string, e: UnsignedEvent): string {
  return JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]);
}

export function eventHash(pubkey: string, e: UnsignedEvent): Uint8Array {
  return sha256(utf8Encode(serializeEvent(pubkey, e)));
}

export function finalizeEvent(e: UnsignedEvent, secretKey: string): NostrEvent {
  const pubkey = publicKeyFromSecret(secretKey);
  const hash = eventHash(pubkey, e);
  const id = bytesToHex(hash);
  return { ...e, pubkey, id, sig: sign(hash, secretKey) };
}

export function buildEvent(
  kind: number,
  content: string,
  recipientPubkey: string,
  secretKey: string,
): NostrEvent {
  return finalizeEvent(
    {
      kind,
      content,
      created_at: nowSeconds(),
      tags: [['p', recipientPubkey]],
    },
    secretKey,
  );
}

/** Structural sanity check before before the signature and decryption steps. */
export function isWellFormed(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === 'string' &&
    typeof ev.pubkey === 'string' &&
    typeof ev.sig === 'string' &&
    typeof ev.content === 'string' &&
    typeof ev.kind === 'number' &&
    typeof ev.created_at === 'number' &&
    Array.isArray(ev.tags)
  );
}

/** Verify id and signature. Relays are untrusted — nothing reaches session logic
 *  without passing through here first. */
export function verifyEvent(e: NostrEvent): boolean {
  if (!isWellFormed(e)) return false;
  const expectedId = bytesToHex(eventHash(e.pubkey, e));
  if (expectedId !== e.id) return false;
  return verify(e.sig, eventHash(e.pubkey, e), e.pubkey);
}

export function isFresh(e: NostrEvent, now: number = nowSeconds()): boolean {
  return Math.abs(now - e.created_at) <= MAX_CLOCK_SKEW_SECONDS;
}

export function tagValue(e: NostrEvent, name: string): string | undefined {
  for (const tag of e.tags) {
    if (tag[0] === name) return tag[1];
  }
  return undefined;
}
