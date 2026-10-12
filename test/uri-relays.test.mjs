/** What a scanned QR is allowed to ask the phone to do.
 *
 *  The relay list in a pairing fragment is attacker-controlled input: it arrives
 *  in whatever code the user pointed their camera at, and every entry costs a
 *  socket, a keepalive, and one more party able to see both ends of the session
 *  — spent before the wallet has agreed to anything. The cap is the only thing
 *  between a hostile link and a phone opening as many connections as it is told.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RELAYS,
  PROTOCOL_VERSION,
  parsePairingFragment,
} from '../packages/shared/protocol/dist/index.js';

const PUBKEY = 'a'.repeat(64);

function fragment(relays) {
  return `v=${PROTOCOL_VERSION}&p=${PUBKEY}&r=${relays.join(',')}`;
}

const many = Array.from({ length: 200 }, (_, i) => `wss://relay${i}.example`);

test('a pairing link cannot ask for more relays than the cap', () => {
  const { relays } = parsePairingFragment(fragment(many));
  assert.equal(relays.length, MAX_RELAYS);
});

test('the ones it keeps are the first, so both sides still overlap', () => {
  // Truncation has to be deterministic and from the front: the dapp is
  // connected to its own full list, and a wallet keeping a random subset could
  // land on relays the dapp never published to.
  const { relays } = parsePairingFragment(fragment(many));
  assert.deepEqual(relays, many.slice(0, MAX_RELAYS));
});

test('an ordinary list is untouched', () => {
  // The cap is a ceiling, not a target — a dapp naming three relays gets three.
  const few = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://offchain.pub'];
  assert.deepEqual(parsePairingFragment(fragment(few)).relays, few);
});

test('a list of only junk is still refused rather than truncated', () => {
  // Truncating first would turn a malformed link into a silently shorter one;
  // the scheme check has to see every entry it was given.
  assert.throws(
    () => parsePairingFragment(fragment([...many, 'http://relay.example'])),
    /websocket url/,
  );
});

test('what the link named is reported, not just what was kept', () => {
  // The gap between the two is the whole reason a truncated pairing can be
  // diagnosed instead of just timing out, so it has to survive the parse.
  assert.equal(parsePairingFragment(fragment(many)).relaysNamed, many.length);

  const few = ['wss://relay.damus.io', 'wss://nos.lol'];
  assert.equal(parsePairingFragment(fragment(few)).relaysNamed, few.length);
});
