/**
 * secp256k1 key handling. Nostr and Ethereum share a curve, but these keypairs are
 * ephemeral session identities that never hold funds; the wallet's Ethereum keys
 * are untouched.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { deriveConversationKey } from './nip44.js';
import { bytesToHex, hexToBytes, isHex, randomBytes } from './util.js';

export interface Keypair {
  secretKey: string;
  /** 32-byte x-only public key, hex (the nostr pubkey form). */
  publicKey: string;
}

export function generateKeypair(): Keypair {
  const secretKey = randomBytes(32);
  return {
    secretKey: bytesToHex(secretKey),
    publicKey: bytesToHex(schnorr.getPublicKey(secretKey)),
  };
}

export function publicKeyFromSecret(secretKey: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKey)));
}

export function isValidPublicKey(pubkey: string): boolean {
  return isHex(pubkey, 32);
}

/**
 * ECDH against an x-only pubkey: the parity byte is dropped, so an even prefix is
 * re-added before the multiply. Both peers do the same, so they derive the same
 * key.
 */
export function conversationKey(ourSecretKey: string, theirPublicKey: string): Uint8Array {
  if (!isHex(ourSecretKey, 32)) throw new Error('keys: invalid secret key');
  if (!isValidPublicKey(theirPublicKey)) throw new Error('keys: invalid public key');
  const shared = secp256k1.getSharedSecret(hexToBytes(ourSecretKey), '02' + theirPublicKey);
  // Drop the leading parity byte: NIP-44 keys off the X coordinate alone.
  return deriveConversationKey(shared.subarray(1, 33));
}

export function sign(messageHash: Uint8Array, secretKey: string): string {
  return bytesToHex(schnorr.sign(messageHash, hexToBytes(secretKey)));
}

export function verify(signature: string, messageHash: Uint8Array, publicKey: string): boolean {
  try {
    return schnorr.verify(hexToBytes(signature), messageHash, hexToBytes(publicKey));
  } catch {
    return false;
  }
}
