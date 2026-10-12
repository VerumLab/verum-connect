/** Typed pairing codes.
 *
 *  The load-bearing ones are at the bottom: a substitute must fail the
 *  fingerprint check, junk must not read as a conflict, and an honest republish
 *  must not either. Those three are why the code is a fingerprint of the pairing
 *  key rather than a secret index.
 *
 *  The other property under test here is what the parked event does NOT say. It
 *  used to carry the whole pairing fragment in the clear — relays, hub CID,
 *  mobile URL — which made the one path that publishes anything the only place a
 *  stranger could read a user's gateway preference. It now carries nothing, and
 *  that is asserted rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_ALPHABET,
  CODE_SYMBOLS,
  KIND_PAIRING_LOOKUP,
  LOOKUP_TTL_SECONDS,
  LookupConflictError,
  KIND_DELETE,
  buildLookupEvent,
  buildLookupRetraction,
  codeForPubkey,
  codeMatches,
  formatCode,
  normalizeCode,
  resolveLookup,
} from '../dist/lookup.js';
import { generateKeypair } from '../dist/keys.js';
import { verifyEvent, finalizeEvent, tagValue } from '../dist/events.js';

// This path uses its own keypair, never the QR's — see KIND_PAIRING_LOOKUP.
const dapp = generateKeypair();
const CODE = codeForPubkey(dapp.publicKey);

test('a code is the documented length and alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = codeForPubkey(generateKeypair().publicKey);
    assert.equal(code.length, CODE_SYMBOLS);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} not in alphabet`);
  }
});

test('a code is a deterministic function of the pubkey', () => {
  // Both sides must reach it independently: the dapp to display it, the wallet
  // to check a candidate against what was typed.
  assert.equal(codeForPubkey(dapp.publicKey), codeForPubkey(dapp.publicKey));
  assert.notEqual(codeForPubkey(generateKeypair().publicKey), CODE);
});

test('distinct keys give distinct codes', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(codeForPubkey(generateKeypair().publicKey));
  assert.equal(seen.size, 500);
});

test('typing confusables resolves to the same code', () => {
  assert.equal(normalizeCode('  4rj7-k2m9-qw8v-n3 '), '4RJ7K2M9QW8VN3');
  assert.equal(normalizeCode('O1I L'), '0111');
});

test('U is refused rather than guessed at', () => {
  // Excluded from the alphabet, so its presence means a mistype. Mapping it
  // would silently look up a different code and read as "not found".
  assert.throws(() => normalizeCode('4RJ7K2M9QW8VNU'), /unusable character/);
  assert.throws(() => normalizeCode(''), /empty code/);
  assert.throws(() => normalizeCode('---'), /empty code/);
});

test('codeMatches accepts the naming key and rejects any other', () => {
  assert.ok(codeMatches(dapp.publicKey, CODE));
  assert.ok(codeMatches(dapp.publicKey, formatCode(CODE).toLowerCase()));
  assert.ok(!codeMatches(generateKeypair().publicKey, CODE));
});

test('a parked event resolves to the pairing key', () => {
  const event = buildLookupEvent(dapp.secretKey);

  assert.equal(event.kind, KIND_PAIRING_LOOKUP);
  assert.equal(tagValue(event, 'd'), CODE);
  assert.ok(verifyEvent(event));
  // Signed by the pairing key itself, which is what proves key ownership.
  assert.equal(event.pubkey, dapp.publicKey);

  assert.equal(resolveLookup([event], CODE), dapp.publicKey);
});

test('the parked event discloses nothing but the key', () => {
  // The privacy property, asserted rather than assumed. Everything a QR carries
  // — relays, hub CID, Arweave transaction, mobile URL — now travels in
  // connect_ack instead, so a scraper harvesting this kind learns a pubkey it
  // already sees in the handshake's `p` tag.
  const event = buildLookupEvent(dapp.secretKey);
  assert.equal(event.content, '');

  const wire = JSON.stringify(event);
  for (const leak of ['wss://', 'https://', 'ipfs', '/', 'bafy']) {
    assert.ok(!wire.includes(leak), `parked event must not carry ${leak}`);
  }

  // The signature is the payload: strip it and the event names no key at all.
  assert.equal(event.pubkey, dapp.publicKey);
});

test('a code from a different pairing finds nothing', () => {
  const event = buildLookupEvent(dapp.secretKey);
  const other = codeForPubkey(generateKeypair().publicKey);
  assert.throws(() => resolveLookup([event], other), /no payload found/);
});

test('the event carries a NIP-40 expiration inside the TTL', () => {
  const event = buildLookupEvent(dapp.secretKey);
  assert.equal(Number(tagValue(event, 'expiration')) - event.created_at, LOOKUP_TTL_SECONDS);
});

test('a substitute key fails the fingerprint check', () => {
  // The attack the design exists to stop, and the reason the code is derived
  // from the key. An attacker may park anything under a public tag — but their
  // pubkey does not hash to the typed code, so it is filtered out rather than
  // becoming a candidate the wallet has to choose between.
  const attacker = generateKeypair();
  const honest = buildLookupEvent(dapp.secretKey);
  const forged = buildLookupEvent(attacker.secretKey);
  // Relabelled under our code, which is all an attacker can do without the grind.
  const relabelled = { ...forged, tags: [['d', CODE]] };

  for (const order of [[honest, relabelled], [relabelled, honest]]) {
    assert.equal(resolveLookup(order, CODE), dapp.publicKey);
  }

  // And with the honest one suppressed, there is no valid candidate at all —
  // a failure, never a silent substitution.
  assert.throws(() => resolveLookup([relabelled], CODE), /no payload found/);
});

test('an unsigned or tampered event is not a candidate', () => {
  // Relays are untrusted, so the signature is checked before the fingerprint.
  const event = buildLookupEvent(dapp.secretKey);
  const tampered = { ...event, content: 'injected' };
  assert.ok(!verifyEvent(tampered));
  assert.throws(() => resolveLookup([tampered], CODE), /no payload found/);
});

test('junk under the tag cannot disable the code', () => {
  // The tag is public, so anyone can park under it. Non-candidates are ignored,
  // not counted — counting them would let a stranger break a code for free.
  const honest = buildLookupEvent(dapp.secretKey);
  const stranger = generateKeypair();
  const junk = finalizeEvent(
    {
      kind: KIND_PAIRING_LOOKUP,
      content: 'not a fragment at all',
      created_at: honest.created_at,
      tags: [['d', CODE]],
    },
    stranger.secretKey,
  );

  assert.equal(resolveLookup([junk, honest, junk], CODE), dapp.publicKey);
});

test('the same event from several relays is one answer, not a conflict', () => {
  // Fan-out means the wallet normally receives N copies of the honest event.
  const event = buildLookupEvent(dapp.secretKey);
  assert.equal(resolveLookup([event, event, event, event], CODE), dapp.publicKey);
});

test('relabelling an event under our code does not make it a candidate', () => {
  // The `d` tag is only how relays index; it is never trusted. An attacker can
  // copy our code into their tag, and the fingerprint check still rejects them.
  // This is why the conflict branch in resolveLookup is unreachable in practice:
  // two candidates would need two keys with the same fingerprint, a 2^70 grind.
  const impostor = generateKeypair();
  const honest = buildLookupEvent(dapp.secretKey);
  const relabelled = { ...buildLookupEvent(impostor.secretKey), tags: [['d', CODE]] };

  assert.equal(resolveLookup([honest, relabelled], CODE), dapp.publicKey);
  assert.equal(typeof LookupConflictError, 'function'); // exported for callers that branch on it
});

test('a retraction names the parked event and is signed by its author', () => {
  // NIP-09: a relay honours a deletion only from the author of the event it
  // names. The parked event is signed by the pairing key for exactly that
  // reason, so the retraction has to be too — and the dapp has to send it
  // before it discards that keypair, since afterwards nothing can.
  const parked = buildLookupEvent(dapp.secretKey);
  const retraction = buildLookupRetraction(dapp.secretKey, parked.id);

  assert.equal(retraction.kind, KIND_DELETE);
  assert.ok(verifyEvent(retraction));
  assert.equal(retraction.pubkey, dapp.publicKey, 'must be signed by the parked events author');
  assert.equal(retraction.pubkey, parked.pubkey);

  // One id, not a list: an empty event cannot go stale, so a code is parked
  // exactly once and there is never a republish to chase.
  const named = retraction.tags.filter(([t]) => t === 'e').map(([, id]) => id);
  assert.deepEqual(named, [parked.id]);

  // Scoped to the lookup kind, so a relay can refuse a deletion aimed elsewhere.
  assert.deepEqual(
    retraction.tags.find(([t]) => t === 'k'),
    ['k', String(KIND_PAIRING_LOOKUP)],
  );
});

test('a retraction from any other key is not the author', () => {
  // The property that makes the parked event safe: nobody else can retract it,
  // so a stranger cannot make a live code vanish.
  const stranger = generateKeypair();
  const parked = buildLookupEvent(dapp.secretKey);
  const forged = buildLookupRetraction(stranger.secretKey, parked.id);

  assert.ok(verifyEvent(forged), 'it is a valid event, just not from the author');
  assert.notEqual(forged.pubkey, parked.pubkey);
});
