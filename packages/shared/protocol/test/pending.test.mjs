/** Pending connects and the selection rule.
 *
 *  The load-bearing ones are at the bottom: a re-sent connect must not read as a
 *  second wallet, an attacker's entry must not be selectable, and two wallets
 *  showing one code must abort. The last uses a real collision found by search
 *  and pinned as a fixture, because it is the branch that makes selection sound
 *  rather than usually-right.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectAmbiguityError,
  ConnectFloodError,
  DEFAULT_CAP,
  selectByCode,
  summarizeConnects,
} from '../dist/pending.js';
import { conversationKey, generateKeypair, publicKeyFromSecret } from '../dist/keys.js';
import { fingerprint } from '../dist/fingerprint.js';

const dapp = generateKeypair();
const wallet = generateKeypair();

/** What the wallet's own screen shows: fp(ECDH(w, D)). */
const walletShows = fingerprint(conversationKey(wallet.secretKey, dapp.publicKey)).join(' · ');

test('a single connect yields one entry, and its code is what the wallet shows', () => {
  const pending = summarizeConnects(dapp.secretKey, [wallet.publicKey]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].publicKey, wallet.publicKey);
  // Derived from opposite ends of the same ECDH, so the two agree.
  assert.equal(pending[0].codeString, walletShows);
  assert.equal(pending[0].code.length, 4);
});

test('a re-sent connect is one wallet, not two', () => {
  // A wallet re-sends on every relay reconnect, and fan-out delivers each copy
  // from several relays. This is the ordinary case and must never look like a
  // second wallet, or every reconnect would abort the pairing.
  const pending = summarizeConnects(dapp.secretKey, [
    wallet.publicKey,
    wallet.publicKey,
    wallet.publicKey,
  ]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].publicKey, wallet.publicKey);
});

test('two wallets give two entries with different codes', () => {
  const other = generateKeypair();
  const pending = summarizeConnects(dapp.secretKey, [wallet.publicKey, other.publicKey]);
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].codeString, pending[1].codeString);
});

test('the user selects by the code their wallet shows', () => {
  const attacker = generateKeypair();
  const pending = summarizeConnects(dapp.secretKey, [attacker.publicKey, wallet.publicKey]);

  // Arrival order puts the attacker first — that must not matter.
  assert.equal(selectByCode(pending, walletShows), wallet.publicKey);
});

test('an attacker entry is never what gets selected', () => {
  const attacker = generateKeypair();
  const pending = summarizeConnects(dapp.secretKey, [attacker.publicKey, wallet.publicKey]);
  const attackerShows = fingerprint(
    conversationKey(attacker.secretKey, dapp.publicKey),
  ).join(' · ');

  // The attacker can compute their own displayed code — this asserts they can,
  // to be explicit that it is not secret — but it is not the one the user has.
  assert.equal(pending.find((p) => p.publicKey === attacker.publicKey).codeString, attackerShows);
  assert.notEqual(attackerShows, walletShows);
  assert.equal(selectByCode(pending, walletShows), wallet.publicKey);
});

test('code comparison ignores spacing and case', () => {
  const pending = summarizeConnects(dapp.secretKey, [wallet.publicKey]);
  const words = walletShows.split(' · ');
  assert.equal(selectByCode(pending, words.join(' ')), wallet.publicKey);
  assert.equal(selectByCode(pending, words.join('-').toUpperCase()), wallet.publicKey);
});

test('no match is null, not an error', () => {
  // The ordinary "their connect has not arrived yet" case. Treating it as an
  // error would surface a failure every time the list renders early.
  const attacker = generateKeypair();
  const pending = summarizeConnects(dapp.secretKey, [attacker.publicKey]);
  assert.equal(selectByCode(pending, walletShows), null);
  assert.equal(selectByCode([], walletShows), null);
});

test('flooding past the cap is refused rather than rendered', () => {
  // The cap is a bound on the attack, not on the layout: each entry is an
  // independent 2^-32 guess at the user's code, so N entries give N * 2^-32.
  const many = Array.from({ length: DEFAULT_CAP + 1 }, () => generateKeypair().publicKey);
  assert.throws(() => summarizeConnects(dapp.secretKey, many), ConnectFloodError);

  // Duplicates are collapsed before the cap is applied, so a wallet re-sending
  // many times can never trip it.
  const resent = Array.from({ length: 50 }, () => wallet.publicKey);
  assert.equal(summarizeConnects(dapp.secretKey, resent).length, 1);
});

test('two wallets showing ONE code abort the pairing', () => {
  // A real 32-bit collision, found by birthday search against this fixed dapp
  // key in 30,790 tries and pinned here. This is the branch that makes selection
  // sound: with two identical codes the user cannot tell which is theirs, so
  // picking either would be a coin flip on a full session.
  //
  // An attacker reaches it only by winning a blind 2^-32 per submitted connect —
  // they cannot compute the user's code to aim at it.
  const d = '33'.repeat(32);
  const w1 = '1f48bab90a473264ef6d7d33b864ed4e3d93716076184a1e17ea5ea979155021';
  const w2 = '16bc5362d740fba32ef6913091010d86d7e310c44406b94678542d809a8dfcf2';
  const p1 = publicKeyFromSecret(w1);
  const p2 = publicKeyFromSecret(w2);

  // The fixture is only useful if it still collides — guard against a change to
  // the fingerprint derivation silently turning this into a pass-by-accident.
  const c1 = fingerprint(conversationKey(d, p1)).join(' · ');
  const c2 = fingerprint(conversationKey(d, p2)).join(' · ');
  assert.equal(c1, c2, 'fixture no longer collides — regenerate it');
  assert.equal(c1, 'cobra · gauge · brick · drift');

  let err;
  try {
    summarizeConnects(d, [p1, p2]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConnectAmbiguityError, 'expected the pairing to abort');
  assert.equal(err.code, c1);
  assert.deepEqual(err.pubkeys.sort(), [p1, p2].sort());
});

test('the abort does not depend on arrival order', () => {
  const d = '33'.repeat(32);
  const p1 = publicKeyFromSecret('1f48bab90a473264ef6d7d33b864ed4e3d93716076184a1e17ea5ea979155021');
  const p2 = publicKeyFromSecret('16bc5362d740fba32ef6913091010d86d7e310c44406b94678542d809a8dfcf2');
  assert.throws(() => summarizeConnects(d, [p1, p2]), ConnectAmbiguityError);
  assert.throws(() => summarizeConnects(d, [p2, p1]), ConnectAmbiguityError);
  // ...nor on an honest third wallet being present too.
  assert.throws(
    () => summarizeConnects(d, [generateKeypair().publicKey, p2, p1]),
    ConnectAmbiguityError,
  );
});

test('selectByCode refuses to pick if a duplicate ever reaches it', () => {
  // summarizeConnects already rejects duplicates, so this is an invariant check
  // on the second line of defence: if that guarantee is ever broken upstream,
  // selection must still abort rather than return an arbitrary entry.
  const forged = [
    { publicKey: 'a'.repeat(64), code: ['cobra'], codeString: 'cobra · gauge · brick · drift' },
    { publicKey: 'b'.repeat(64), code: ['cobra'], codeString: 'cobra · gauge · brick · drift' },
  ];
  assert.throws(() => selectByCode(forged, 'cobra · gauge · brick · drift'), ConnectAmbiguityError);
});
