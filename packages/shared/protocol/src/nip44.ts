/**
 * NIP-44 v2: ChaCha20 + HMAC-SHA256 (encrypt-then-MAC), keyed by HKDF over the
 * ECDH X coordinate, with length padding so ciphertext size leaks only a bucket.
 * Implemented here, not pulled in, to keep the hub a small single-file bundle: the
 * whole crypto surface is this file plus @noble.
 * Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
 */

import { chacha20 } from '@noble/ciphers/chacha';
import { extract, expand } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import {
  base64Decode,
  base64Encode,
  bytesEqual,
  concatBytes,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from './util.js';

const VERSION = 2;
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;

/** Round a plaintext length up to its NIP-44 padded size.
 *  Buckets are powers of two up to 256, then eighths of the next power of two. */
export function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 0) throw new Error('nip44: length must be positive');
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8Encode(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) {
    throw new Error(`nip44: plaintext must be ${MIN_PLAINTEXT}..${MAX_PLAINTEXT} bytes, got ${len}`);
  }
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, len, false);
  const suffix = new Uint8Array(calcPaddedLen(len) - len);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error('nip44: padded buffer too short');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const content = padded.subarray(2, 2 + len);
  // A mismatch here means the padding was forged or truncated. The MAC has
  // already passed at this point, so this is defence in depth rather than the
  // primary integrity check.
  if (len < MIN_PLAINTEXT || content.length !== len || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error('nip44: invalid padding');
  }
  return utf8Decode(content);
}

/** Per-message keys, expanded from the long-lived conversation key and a fresh nonce. */
function messageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32) throw new Error('nip44: conversation key must be 32 bytes');
  if (nonce.length !== 32) throw new Error('nip44: nonce must be 32 bytes');
  const keys = expand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/** HMAC over nonce-as-AAD followed by ciphertext, so a nonce swap invalidates the tag. */
function macWithAad(hmacKey: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Error('nip44: aad must be 32 bytes');
  return hmac(sha256, hmacKey, concatBytes(aad, ciphertext));
}

/** Derive the shared conversation key from one side's private key and the other's
 *  x-only public key. Symmetric: both peers land on the same 32 bytes. */
export function deriveConversationKey(sharedX: Uint8Array): Uint8Array {
  return extract(sha256, sharedX, utf8Encode('nip44-v2'));
}

export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = macWithAad(hmacKey, ciphertext, nonce);
  return base64Encode(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac));
}

export function decrypt(payload: string, conversationKey: Uint8Array): string {
  if (payload.length < 132 || payload.length > 87472) {
    throw new Error('nip44: payload length out of range');
  }
  if (payload[0] === '#') throw new Error('nip44: unsupported encryption version');

  const data = base64Decode(payload);
  const version = data[0];
  if (version !== VERSION) throw new Error(`nip44: unknown version ${version}`);

  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  if (ciphertext.length === 0) throw new Error('nip44: empty ciphertext');

  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  if (!bytesEqual(macWithAad(hmacKey, ciphertext, nonce), mac)) {
    throw new Error('nip44: invalid MAC');
  }
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
