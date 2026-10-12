/**
 * Typed pairing codes: a third way to deliver the pairing key, beside the QR and
 * the link. The dapp parks an empty event, signed by its pairing key, under the
 * code; the wallet looks it up, learns the key from the signature and continues
 * the ordinary pairing. Everything else a QR carries arrives later in
 * `connect_ack`, encrypted.
 *
 * The code is a fingerprint of the pairing pubkey, not a secret.
 *
 * An attacker cannot substitute a key (a 2^130 grind, see CODE_SYMBOLS) or take the
 * session (two connects halt it, and committing is a user action). They can deny
 * it, since the pubkey is public: this path is weakest on availability only, which
 * is why it uses its own keypair and is presented as a fallback.
 */

import { sha256 } from '@noble/hashes/sha256';
import { finalizeEvent, verifyEvent, type NostrEvent } from './events.js';
import { publicKeyFromSecret } from './keys.js';
import { concatBytes, hexToBytes, nowSeconds, utf8Encode } from './util.js';

/**
 * A regular kind (1000..9999), so relays keep every event and a competing one
 * cannot replace the honest one. The pubkey must be a keypair minted for this path
 * alone: it is published in the clear and anyone may connect to it to deny the
 * pairing, and that must not extend to the QR and link keypair, which never
 * reaches a relay.
 */
export const KIND_PAIRING_LOOKUP = 4140;

/**
 * How long the parked event stays valid (NIP-40). Cleanup only: nothing in it is
 * secret.
 */
export const LOOKUP_TTL_SECONDS = 300;

/**
 * Crockford base32 (no I, L, O, U). Built to be typed, unlike the session-code
 * wordlist, which is only ever compared by eye.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 26 symbols = 130 bits, the strength of the key it names (about 2^128 for the best
 * generic attack on secp256k1). The code is public, so an attacker knows exactly which
 * fingerprint they need, and each trial is a real keygen since they must hold the
 * secret to complete a pairing. With no per-pairing salt a table serves every pairing
 * forever, so the margin is sized to make both the search and the table out of reach.
 */
export const CODE_SYMBOLS = 26;

const CODE_DOMAIN = 'verum-connect/pairing-code/v2';

/**
 * The code for a pairing pubkey. Domain-separated from the session fingerprint's
 * use of the same key.
 */
export function codeForPubkey(pairingPublicKey: string): string {
  const digest = sha256(concatBytes(utf8Encode(CODE_DOMAIN), hexToBytes(pairingPublicKey)));
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < CODE_SYMBOLS) {
      out += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === CODE_SYMBOLS) break;
  }
  return out;
}

/** Group sizes for display and entry, summing to CODE_SYMBOLS. */
export const CODE_GROUP_SIZES = [5, 5, 4, 4, 4, 4];

/** Group for display: 26 symbols -> XXXXX-XXXXX-XXXX-XXXX-XXXX-XXXX. */
export function formatCode(code: string): string {
  const groups: string[] = [];
  let at = 0;
  for (const size of CODE_GROUP_SIZES) {
    if (at >= code.length) break;
    groups.push(code.slice(at, at + size));
    at += size;
  }
  if (at < code.length) groups.push(code.slice(at));
  return groups.join('-');
}

/**
 * Canonicalise typed input with Crockford's mapping (O is 0, I and L are 1). U is
 * rejected, not mapped.
 */
export function normalizeCode(input: string): string {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  let out = '';
  for (const ch of cleaned) {
    if (ch === 'O') out += '0';
    else if (ch === 'I' || ch === 'L') out += '1';
    else if (CODE_ALPHABET.includes(ch)) out += ch;
    else throw new Error(`lookup: code contains an unusable character: ${ch}`);
  }
  if (out.length === 0) throw new Error('lookup: empty code');
  return out;
}

export function codeMatches(pairingPublicKey: string, code: string): boolean {
  return codeForPubkey(pairingPublicKey) === normalizeCode(code);
}

/**
 * Park a pairing key under its own code, signed with the pairing key. 
 * The content is empty on purpose: `event.pubkey` is the
 * pairing key and `d` its fingerprint, so a scraper learns nothing it does not
 * already see, and relays, hub and gateways arrive later in `connect_ack`,
 * encrypted. `secretKey` is this path's own keypair, not the QR's.
 */
export function buildLookupEvent(secretKey: string): NostrEvent {
  const code = codeForPubkey(publicKeyFromSecret(secretKey));
  return finalizeEvent(
    {
      kind: KIND_PAIRING_LOOKUP,
      content: '',
      created_at: nowSeconds(),
      tags: [
        ['d', code],
        ['expiration', String(nowSeconds() + LOOKUP_TTL_SECONDS)],
      ],
    },
    secretKey,
  );
}

/** NIP-09 deletion request. */
export const KIND_DELETE = 5;

/**
 * Ask relays to drop a code the dapp is done with. Signed by the pairing key, the
 * only key a relay will honour, so retract before discarding the keypair.
 * Best-effort (NIP-09 is advisory): the NIP-40 expiry is the guarantee, this
 * shortens the window in which a stale code resolves.
 */
export function buildLookupRetraction(secretKey: string, eventId: string): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_DELETE,
      content: '',
      created_at: nowSeconds(),
      tags: [
        ['e', eventId],
        // Relays use this to refuse a deletion aimed at some other kind.
        ['k', String(KIND_PAIRING_LOOKUP)],
      ],
    },
    secretKey,
  );
}

/**
 * The filter a wallet subscribes with. No author: the code names the key, and the
 * wallet cannot know who published it before it arrives.
 */
export function lookupFilter(code: string): { kinds: number[]; '#d': string[] } {
  return { kinds: [KIND_PAIRING_LOOKUP], '#d': [normalizeCode(code)] };
}

/**
 * Two key-owned events name different pairing pubkeys under one code. Its own type
 * because it means unusable, not not-found. It is what makes a precomputed table
 * worthless: an attacker can add a matching event but cannot retract the honest
 * one, so the wallet sees two candidates and halts. Code length resists a
 * substitution that also suppresses the honest event; this resists one that does
 * not.
 */
export class LookupConflictError extends Error {
  readonly pubkeys: string[];
  constructor(pubkeys: string[]) {
    super('lookup: this code resolves to more than one pairing key. Ask for a new one.');
    this.name = 'LookupConflictError';
    this.pubkeys = pubkeys;
  }
}

/**
 * The pairing key a typed code names, from whatever the relays returned. Two
 * filters: the event verifies (relays are untrusted), and its pubkey hashes to the
 * typed code. Anything else is ignored, not counted as a conflict: the tag is
 * public, so junk would otherwise let a stranger disable a code for free. Copies
 * from several relays collapse to one answer; the event has no payload that could
 * differ.
 */
export function resolveLookup(events: NostrEvent[], code: string): string {
  const normalized = normalizeCode(code);
  const pubkeys = new Set<string>();

  for (const event of events) {
    if (event.kind !== KIND_PAIRING_LOOKUP) continue;
    if (!verifyEvent(event)) continue;
    if (codeForPubkey(event.pubkey) !== normalized) continue;
    pubkeys.add(event.pubkey);
  }

  if (pubkeys.size === 0) throw new Error('lookup: no payload found for this code');
  if (pubkeys.size > 1) throw new LookupConflictError([...pubkeys]);
  return [...pubkeys][0]!;
}
