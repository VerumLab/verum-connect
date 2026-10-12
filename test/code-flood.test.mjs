/** Flooding the typed-code path.
 *
 *  The denial itself is accepted — the pairing pubkey is published, so anyone
 *  may connect to it. What must not follow from that is unbounded work on the
 *  dapp: the list of held connects, and the ECDH each new sender costs, are both
 *  driven by a stranger. So the cap is checked where the events arrive rather
 *  than where they are rendered, and the code is withdrawn once it is spent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import { VerumConnectProvider } from '../packages/dapp/shared/core/dist/provider.js';
import { RelayPool } from '../packages/shared/protocol/dist/relay.js';
import { DEFAULT_CAP } from '../packages/shared/protocol/dist/pending.js';
import { generateKeypair, conversationKey } from '../packages/shared/protocol/dist/keys.js';
import { buildEvent, KIND_HANDSHAKE } from '../packages/shared/protocol/dist/events.js';
import { encrypt } from '../packages/shared/protocol/dist/nip44.js';
import { KIND_PAIRING_LOOKUP } from '../packages/shared/protocol/dist/lookup.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** Watch for the pairing pubkey behind a code that has not been offered yet.
 *
 *  Exactly what an attacker sees, and the reason this path can be flooded at
 *  all: the parked event names a public key for anyone reading the relay, not
 *  only for the wallet the user is holding.
 *
 *  Subscribed before the code is offered because the test relay persists
 *  nothing — a real one would answer the same filter after the fact. */
function watchForPairingPubkey(pool) {
  let found = null;
  pool.subscribe('flood-lookup', [{ kinds: [KIND_PAIRING_LOOKUP] }], (event) => {
    found ??= event.pubkey;
  });
  return async () => {
    assert.ok(await waitFor(() => found !== null), 'the parked code must resolve');
    return found;
  };
}

/** A pool that is connected and ready to publish. */
async function connected(url) {
  const pool = new RelayPool([url]);
  pool.connect();
  assert.ok(await waitFor(() => pool.connectedCount === 1), 'pool should connect');
  return pool;
}

async function floodWith(pool, dappPubkey, count) {
  for (let i = 0; i < count; i++) {
    const attacker = generateKeypair();
    const convKey = conversationKey(attacker.secretKey, dappPubkey);
    await pool.publish(
      buildEvent(
        KIND_HANDSHAKE,
        encrypt(JSON.stringify({ type: 'connect', v: 1, nonce: `flood-${i}` }), convKey),
        dappPubkey,
        attacker.secretKey,
      ),
    );
  }
}

test('a flood is bounded and burns the code instead of growing', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubUrl: 'http://localhost:5173/',
    metadata: { name: 'Test Dapp', origin: 'http://localhost:5174' },
    relays: [relay.url],
  });

  await provider.pair();

  const attackers = await connected(relay.url);
  const pubkey = watchForPairingPubkey(attackers);

  const code = await provider.offerPairingCode();
  assert.equal(provider.pairingCodeStatus, 'ready');
  const dappPubkey = await pubkey();

  // One past the cap: the cap's worth fill the list, and the next is what the
  // dapp must refuse rather than hold.
  await floodWith(attackers, dappPubkey, DEFAULT_CAP + 1);

  assert.ok(
    await waitFor(() => provider.pairingCodeStatus === 'flooded'),
    'the code must be withdrawn once it is flooded past the cap',
  );
  // Withdrawn, so there is nothing to render and nothing to select — and
  // reading the list must not throw, which is what it used to do.
  assert.deepEqual(provider.pendingConnects, []);
  assert.equal(provider.pairingCode, null);
  assert.equal(await provider.selectPendingConnect('any thing at all'), false);

  // Unsubscribed, so continuing to publish reaches nothing. Without this the
  // bound would only be on what is displayed, not on what is decrypted.
  await floodWith(attackers, dappPubkey, 20);
  await wait(200);
  assert.equal(provider.pairingCodeStatus, 'flooded');
  assert.deepEqual(provider.pendingConnects, []);

  // The QR pairing is untouched: it has its own keypair, which the flood never
  // learned of.
  assert.equal(provider.isConnected, false);
  const again = await provider.offerPairingCode();
  assert.notEqual(again, code);
  assert.equal(provider.pairingCodeStatus, 'ready');

  attackers.close();
  await provider.disconnect();
  await relay.close();
});

test('connects below the cap are all held and selectable', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubUrl: 'http://localhost:5173/',
    metadata: { name: 'Test Dapp', origin: 'http://localhost:5174' },
    relays: [relay.url],
  });

  await provider.pair();

  const others = await connected(relay.url);
  const pubkey = watchForPairingPubkey(others);

  await provider.offerPairingCode();
  const dappPubkey = await pubkey();

  await floodWith(others, dappPubkey, DEFAULT_CAP);

  assert.ok(
    await waitFor(() => provider.pendingConnects.length === DEFAULT_CAP),
    'everything up to the cap is held for the user to choose from',
  );
  assert.equal(provider.pairingCodeStatus, 'ready');

  others.close();
  await provider.disconnect();
  await relay.close();
});
