/** End-to-end over a real WebSocket relay: pairing, request/response, and the
 *  properties the design leans on. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from './relay-server.mjs';
import { RelayPool } from '../dist/relay.js';
import { Channel } from '../dist/channel.js';
import { generateKeypair, conversationKey } from '../dist/keys.js';
import { fingerprint } from '../dist/fingerprint.js';
import { buildEvent, KIND_SESSION } from '../dist/events.js';
import { encrypt } from '../dist/nip44.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

async function connectedPool(url) {
  const pool = new RelayPool([url]);
  pool.connect();
  assert.ok(await waitFor(() => pool.connectedCount === 1), 'pool should connect');
  return pool;
}

/** Build the two ends of a paired session. */
async function pairChannels(url) {
  const dapp = generateKeypair();
  const hub = generateKeypair();

  const dappPool = await connectedPool(url);
  const hubPool = await connectedPool(url);

  const dappChannel = new Channel({
    pool: dappPool,
    secretKey: dapp.secretKey,
    publicKey: dapp.publicKey,
    peerPublicKey: hub.publicKey,
    kind: KIND_SESSION,
  });
  const hubChannel = new Channel({
    pool: hubPool,
    secretKey: hub.secretKey,
    publicKey: hub.publicKey,
    peerPublicKey: dapp.publicKey,
    kind: KIND_SESSION,
  });

  dappChannel.open('dapp-sub');
  hubChannel.open('hub-sub');
  await wait(150);

  return { dapp, hub, dappPool, hubPool, dappChannel, hubChannel };
}

test('a request crosses the relay and the response comes back', async () => {
  const relay = await startRelay();
  const { dappPool, hubPool, dappChannel, hubChannel } = await pairChannels(relay.url);

  // The hub plays wallet: answer whatever the dapp asks.
  hubChannel.onEnvelope(async (envelope) => {
    if (envelope.type !== 'rpc_request') return;
    await hubChannel.send({
      type: 'rpc_response',
      id: envelope.id,
      result: `0xsigned:${envelope.method}`,
    });
  });

  const received = [];
  dappChannel.onEnvelope((envelope) => received.push(envelope));

  await dappChannel.send({
    type: 'rpc_request',
    id: 'req-1',
    method: 'personal_sign',
    params: ['0xdeadbeef', '0xabc'],
  });

  assert.ok(await waitFor(() => received.length > 0), 'dapp should receive a response');
  assert.equal(received[0].type, 'rpc_response');
  assert.equal(received[0].id, 'req-1');
  assert.equal(received[0].result, '0xsigned:personal_sign');

  dappPool.close();
  hubPool.close();
  await relay.close();
});

test('both ends independently derive the same session code', async () => {
  const relay = await startRelay();
  const { dappChannel, hubChannel, dappPool, hubPool } = await pairChannels(relay.url);

  assert.deepEqual(dappChannel.fingerprint, hubChannel.fingerprint);
  assert.equal(dappChannel.fingerprint.length, 4);

  dappPool.close();
  hubPool.close();
  await relay.close();
});

test('a third party who scanned the same QR gets a different session code', async () => {
  // The attacker knows the dapp pubkey — it was in the QR they photographed —
  // but their own key is theirs, so the ECDH lands somewhere else entirely.
  const dapp = generateKeypair();
  const victim = generateKeypair();
  const attacker = generateKeypair();

  const victimCode = fingerprint(conversationKey(victim.secretKey, dapp.publicKey));
  const attackerCode = fingerprint(conversationKey(attacker.secretKey, dapp.publicKey));

  assert.notDeepEqual(victimCode, attackerCode);

  // And the dapp's own view agrees with whichever side actually paired.
  assert.deepEqual(fingerprint(conversationKey(dapp.secretKey, victim.publicKey)), victimCode);
  assert.deepEqual(fingerprint(conversationKey(dapp.secretKey, attacker.publicKey)), attackerCode);
});

test('traffic addressed to a different session is not delivered', async () => {
  const relay = await startRelay();
  const { dapp, hub, dappPool, hubPool, dappChannel } = await pairChannels(relay.url);

  const received = [];
  dappChannel.onEnvelope((envelope) => received.push(envelope));

  // A stranger publishes a well-formed, correctly-signed event tagged at the
  // dapp — but encrypted under a conversation key the dapp does not hold.
  const stranger = generateKeypair();
  const strangerKey = conversationKey(stranger.secretKey, dapp.publicKey);
  const strangerPool = await connectedPool(relay.url);
  await strangerPool.publish(
    buildEvent(
      KIND_SESSION,
      encrypt(JSON.stringify({ type: 'rpc_response', v: 1, id: 'x', result: '0xevil' }), strangerKey),
      dapp.publicKey,
      stranger.secretKey,
    ),
  );

  await wait(400);
  assert.equal(received.length, 0, 'events from an unpaired peer must be dropped');
  void hub;

  strangerPool.close();
  dappPool.close();
  hubPool.close();
  await relay.close();
});

test('the pool reconnects and replays its subscriptions after a drop', async () => {
  const relay = await startRelay();
  const { dappPool, hubPool, dappChannel, hubChannel } = await pairChannels(relay.url);

  const received = [];
  dappChannel.onEnvelope((envelope) => received.push(envelope));

  // Kill every socket, as a flaky relay or a backgrounded tab would.
  relay.dropAllConnections();
  assert.ok(await waitFor(() => dappPool.connectedCount === 0, 2000), 'sockets should drop');

  // Backoff is jittered, so allow a beat for both ends to come back.
  assert.ok(
    await waitFor(() => dappPool.connectedCount === 1 && hubPool.connectedCount === 1, 6000),
    'pools should reconnect on their own',
  );
  await wait(200);

  // If subscriptions were not replayed onto the new socket, this never arrives.
  await hubChannel.send({ type: 'hello', accounts: ['0xabc'], chainId: '0x1' });
  assert.ok(
    await waitFor(() => received.some((e) => e.type === 'hello')),
    'subscription should survive a reconnect',
  );

  dappPool.close();
  hubPool.close();
  await relay.close();
});

test('a session survives when one relay of several is unreachable', async () => {
  const relay = await startRelay();

  const dapp = generateKeypair();
  const hub = generateKeypair();

  // One good relay, one that will never answer.
  const relays = [relay.url, 'ws://127.0.0.1:1'];
  const dappPool = new RelayPool(relays);
  const hubPool = new RelayPool(relays);
  dappPool.connect();
  hubPool.connect();

  assert.ok(await waitFor(() => dappPool.connectedCount >= 1 && hubPool.connectedCount >= 1));

  const dappChannel = new Channel({
    pool: dappPool,
    secretKey: dapp.secretKey,
    publicKey: dapp.publicKey,
    peerPublicKey: hub.publicKey,
  });
  const hubChannel = new Channel({
    pool: hubPool,
    secretKey: hub.secretKey,
    publicKey: hub.publicKey,
    peerPublicKey: dapp.publicKey,
  });
  dappChannel.open('dapp-sub');
  hubChannel.open('hub-sub');
  await wait(150);

  const received = [];
  dappChannel.onEnvelope((e) => received.push(e));
  await hubChannel.send({ type: 'hello', accounts: ['0x1'], chainId: '0x1' });

  assert.ok(await waitFor(() => received.length === 1), 'one live relay is enough');

  dappPool.close();
  hubPool.close();
  await relay.close();
});

test('duplicate delivery across relays is collapsed to one envelope', async () => {
  const relayA = await startRelay();
  const relayB = await startRelay();

  const dapp = generateKeypair();
  const hub = generateKeypair();
  const urls = [relayA.url, relayB.url];

  const dappPool = new RelayPool(urls);
  const hubPool = new RelayPool(urls);
  dappPool.connect();
  hubPool.connect();
  assert.ok(await waitFor(() => dappPool.connectedCount === 2 && hubPool.connectedCount === 2));

  const dappChannel = new Channel({
    pool: dappPool,
    secretKey: dapp.secretKey,
    publicKey: dapp.publicKey,
    peerPublicKey: hub.publicKey,
  });
  const hubChannel = new Channel({
    pool: hubPool,
    secretKey: hub.secretKey,
    publicKey: hub.publicKey,
    peerPublicKey: dapp.publicKey,
  });
  dappChannel.open('dapp-sub');
  hubChannel.open('hub-sub');
  await wait(150);

  const received = [];
  dappChannel.onEnvelope((e) => received.push(e));

  // Published to both relays, so the dapp's pool sees it twice on the wire.
  await hubChannel.send({ type: 'hello', accounts: ['0x1'], chainId: '0x1' });
  await wait(500);

  assert.equal(received.length, 1, 'the same event from two relays must dedupe');

  dappPool.close();
  hubPool.close();
  await relayA.close();
  await relayB.close();
});

test('publishToAll waits for relays that are still connecting', async () => {
  // The regression. publishToAll used to snapshot whichever relays were open at
  // call time and finish once those had answered — so publishing immediately
  // after connect(), when typically one socket of several is up, reported a
  // single acceptance for the whole set. A caller with a minimum then concluded
  // the publish had failed, which is what made a freshly re-paired dapp report
  // its connect code unavailable.
  const relays = await Promise.all([startRelay(), startRelay(), startRelay()]);
  const pool = new RelayPool(relays.map((r) => r.url));

  try {
    pool.connect();
    // Deliberately NOT waiting for all three: this is the state a pool is in
    // right after pair(), and the whole point is that it still reaches them.
    const keys = generateKeypair();
    const event = buildEvent(KIND_SESSION, 'x', keys.publicKey, keys.secretKey);
    const accepted = await pool.publishToAll(event);

    assert.equal(accepted.length, 3, `expected all three relays, got ${accepted.length}`);
    assert.deepEqual([...accepted].sort(), relays.map((r) => r.url).sort());
  } finally {
    pool.close();
    await Promise.all(relays.map((r) => r.close()));
  }
});
