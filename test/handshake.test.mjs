/** The pairing handshake, driven against the real VerumConnectProvider.
 *
 *  This is the path that had no coverage: earlier integration tests exercised
 *  Channel<->Channel on the session kind, which skips pairing entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import { VerumConnectProvider } from '../packages/dapp/shared/core/dist/provider.js';
import { RelayPool } from '../packages/shared/protocol/dist/relay.js';
import { Channel } from '../packages/shared/protocol/dist/channel.js';
import { generateKeypair, conversationKey } from '../packages/shared/protocol/dist/keys.js';
import { buildEvent, KIND_HANDSHAKE, KIND_SESSION, isFresh } from '../packages/shared/protocol/dist/events.js';
import { encrypt, decrypt } from '../packages/shared/protocol/dist/nip44.js';
import { parseEnvelope } from '../packages/shared/protocol/dist/envelope.js';
import { parsePairingUri } from '../packages/shared/protocol/dist/uri.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** The hub half of the handshake, mirroring Hub.pair()/Hub.handshake(). */
async function hubPair(uri) {
  const { publicKey: dappPubkey, relays } = parsePairingUri(uri);
  const keypair = generateKeypair();
  const convKey = conversationKey(keypair.secretKey, dappPubkey);

  const pool = new RelayPool(relays);
  pool.connect();

  const nonce = 'test-nonce';
  let ack = null;

  pool.subscribe(
    'hub-handshake',
    [{ kinds: [KIND_HANDSHAKE], authors: [dappPubkey], '#p': [keypair.publicKey] }],
    (event) => {
      if (!isFresh(event)) return;
      try {
        const envelope = parseEnvelope(decrypt(event.content, convKey));
        if (envelope.type === 'connect_ack' && envelope.nonce === nonce) ack = envelope;
      } catch {
        /* not ours */
      }
    },
  );

  await pool.publish(
    buildEvent(
      KIND_HANDSHAKE,
      encrypt(JSON.stringify({ type: 'connect', v: 1, nonce }), convKey),
      dappPubkey,
      keypair.secretKey,
    ),
  );

  return { pool, keypair, convKey, dappPubkey, getAck: () => ack };
}

test('the dapp answers a connect with connect_ack', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubUrl: 'http://localhost:5173/',
    metadata: { name: 'Test Dapp', origin: 'http://localhost:5174' },
    relays: [relay.url],
  });

  const uri = await provider.pair();
  await wait(200);

  const hub = await hubPair(uri);

  assert.ok(
    await waitFor(() => hub.getAck() !== null),
    'dapp must answer the connect with connect_ack',
  );
  assert.equal(hub.getAck().metadata.name, 'Test Dapp');

  hub.pool.close();
  await provider.disconnect();
  await relay.close();
});

test('the dapp reaches connected state after session_ready', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubUrl: 'http://localhost:5173/',
    metadata: { name: 'Test Dapp', origin: 'http://localhost:5174' },
    relays: [relay.url],
  });

  const uri = await provider.pair();
  await wait(200);
  const hub = await hubPair(uri);
  assert.ok(await waitFor(() => hub.getAck() !== null), 'handshake must complete');

  // Hub now opens the session channel and reports the wallet's accounts.
  const channel = new Channel({
    pool: hub.pool,
    secretKey: hub.keypair.secretKey,
    publicKey: hub.keypair.publicKey,
    peerPublicKey: hub.dappPubkey,
    kind: KIND_SESSION,
  });
  channel.open('hub-session');
  await wait(150);

  await channel.send({
    type: 'session_ready',
    accounts: ['0x1111111111111111111111111111111111111111'],
    chainId: '0x1',
    wallet: 'Test Wallet',
  });

  assert.ok(await waitFor(() => provider.isConnected), 'provider must reach connected');
  assert.deepEqual(provider.currentAccounts, ['0x1111111111111111111111111111111111111111']);
  assert.equal(provider.currentChainId, '0x1');

  channel.close();
  hub.pool.close();
  await provider.disconnect();
  await relay.close();
});

test('a request from the connected dapp reaches the hub and returns', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubUrl: 'http://localhost:5173/',
    metadata: { name: 'Test Dapp', origin: 'http://localhost:5174' },
    relays: [relay.url],
  });

  const uri = await provider.pair();
  await wait(200);
  const hub = await hubPair(uri);
  assert.ok(await waitFor(() => hub.getAck() !== null));

  const channel = new Channel({
    pool: hub.pool,
    secretKey: hub.keypair.secretKey,
    publicKey: hub.keypair.publicKey,
    peerPublicKey: hub.dappPubkey,
    kind: KIND_SESSION,
  });
  channel.onEnvelope(async (envelope) => {
    if (envelope.type !== 'rpc_request') return;
    await channel.send({ type: 'rpc_response', id: envelope.id, result: '0xsig' });
  });
  channel.open('hub-session');
  await wait(150);

  await channel.send({
    type: 'session_ready',
    accounts: ['0x1111111111111111111111111111111111111111'],
    chainId: '0x1',
  });
  assert.ok(await waitFor(() => provider.isConnected));

  const result = await provider.request({
    method: 'personal_sign',
    params: ['0xdeadbeef', '0x1111111111111111111111111111111111111111'],
  });
  assert.equal(result, '0xsig');

  channel.close();
  hub.pool.close();
  await provider.disconnect();
  await relay.close();
});

test('publishing immediately after connect() waits for a socket', async () => {
  const relay = await startRelay();

  const pool = new RelayPool([relay.url]);
  pool.connect();
  // No await between connect() and publish(): this is what Hub.pair() does, and
  // it used to throw "no relays connected" and silently drop the handshake.
  const kp = generateKeypair();
  const peer = generateKeypair();
  await pool.publish(buildEvent(KIND_HANDSHAKE, 'x', peer.publicKey, kp.secretKey));

  pool.close();
  await relay.close();
});
