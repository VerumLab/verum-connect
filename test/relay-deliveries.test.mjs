/** Which relays delivered an event, which is not the same as which handled it.
 *
 *  The pool hands each event to its subscriber once — every relay holding it
 *  sends a copy, and doing the signature check and the work N times would be
 *  waste. But the duplicates are the only evidence of *where* an event is, and
 *  a parked connect code is only useful where it is actually held: a relay that
 *  accepts one and quietly drops it is indistinguishable from one that keeps it
 *  until someone asks for it back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import {
  RelayPool,
  buildLookupEvent,
  codeForPubkey,
  lookupFilter,
} from '../packages/shared/protocol/dist/index.js';
import { generateKeypair } from '../packages/shared/protocol/dist/keys.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('every relay that served an event is recorded, not just the first', async () => {
  const a = await startRelay();
  const b = await startRelay();
  const keys = generateKeypair();
  const parked = buildLookupEvent(keys.secretKey);

  const pool = new RelayPool([a.url, b.url]);
  pool.connect();
  assert.ok(await pool.waitForConnection(5000), 'both relays are up');

  await pool.publishToAll(parked);

  let handled = 0;
  pool.subscribe('verify', [lookupFilter(codeForPubkey(keys.publicKey))], () => {
    handled += 1;
  });
  await wait(600);

  assert.equal(handled, 1, 'the subscriber sees it once');
  assert.deepEqual(
    pool.relaysWith(parked.id).sort(),
    [a.url, b.url].sort(),
    'both relays are known to hold it',
  );

  pool.close();
  await a.close();
  await b.close();
});

test('a relay that keeps nothing is absent from the list', async () => {
  // The case this exists for: accepted, then never served back.
  const kept = await startRelay();
  const drops = await startRelay({ store: false });
  const keys = generateKeypair();
  const parked = buildLookupEvent(keys.secretKey);

  const pool = new RelayPool([kept.url, drops.url]);
  pool.connect();
  assert.ok(await pool.waitForConnection(5000));

  const accepted = await pool.publishToAll(parked);
  assert.equal(accepted.length, 2, 'both said OK');

  pool.subscribe('verify', [lookupFilter(codeForPubkey(keys.publicKey))], () => {});
  await wait(600);

  assert.deepEqual(pool.relaysWith(parked.id), [kept.url], 'only the one that kept it');

  pool.close();
  await kept.close();
  await drops.close();
});
