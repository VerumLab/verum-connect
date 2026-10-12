/** Async, injectable storage.
 *
 *  localStorage hid two failure modes that every other backend exposes: writes
 *  landing out of order, and a read that finishes after a newer write. Neither
 *  can happen synchronously, so neither would ever show up in a browser — they
 *  appear the first time the provider runs in an extension or on React Native,
 *  as a gateway choice that reverts or a pairing that disappears. The backend
 *  here is deliberately slow and uneven so both are forced rather than hoped for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { options, CID, TX } from './helpers.mjs';
import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import { StorageSnapshot, generateKeypair } from '../packages/shared/protocol/dist/index.js';
import { VerumConnectProvider, resolveHub } from '../packages/dapp/shared/core/dist/index.js';
import { Hub } from '../packages/wallet/sdk/dist/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A store with latency the test controls, per operation. */
function slowBackend({ readDelay = 0, writeDelay = () => 0, seed = {} } = {}) {
  const data = new Map(Object.entries(seed));
  let writes = 0;
  return {
    data,
    getItem: async (key) => {
      await wait(readDelay);
      return data.has(key) ? data.get(key) : null;
    },
    setItem: async (key, value) => {
      await wait(writeDelay(writes++));
      data.set(key, value);
    },
    removeItem: async (key) => {
      await wait(writeDelay(writes++));
      data.delete(key);
    },
  };
}

// ----------------------------------------------------------------- snapshot

test('writes reach the backend in the order they were made', async () => {
  // The first write is the slow one. Unserialised, the second lands first and
  // the first then overwrites it — the newer value silently lost.
  const backend = slowBackend({ writeDelay: (i) => (i === 0 ? 60 : 0) });
  const snapshot = new StorageSnapshot(backend, ['k']);
  await snapshot.ready;

  snapshot.set('k', 'older');
  snapshot.set('k', 'newer');
  await snapshot.flush();
  // And past the slow write, whether or not flush() waited for it: unchained,
  // flush() returns only the last write, and checking then would pass before
  // the stale one lands on top.
  await wait(100);

  assert.equal(backend.data.get('k'), 'newer');
});

test('a write made while loading is not undone by the load', async () => {
  // The stored value arrives after the user has already changed it. The change
  // is newer, whatever order the two promises settle in.
  // The write is slower than the read, so the read really does return the old
  // value — a fast write would reach the backend first and hide the race.
  const backend = slowBackend({ readDelay: 30, writeDelay: () => 90, seed: { k: 'stored' } });
  const snapshot = new StorageSnapshot(backend, ['k']);

  snapshot.set('k', 'chosen');
  await snapshot.ready;

  assert.equal(snapshot.get('k'), 'chosen');
});

test('reads are the defaults until the store has loaded', async () => {
  const backend = slowBackend({ readDelay: 30, seed: { k: 'stored' } });
  const snapshot = new StorageSnapshot(backend, ['k']);

  assert.equal(snapshot.get('k'), null);
  await snapshot.ready;
  assert.equal(snapshot.get('k'), 'stored');
});

test('a failed write does not block the ones after it', async () => {
  let calls = 0;
  const data = new Map();
  const backend = {
    getItem: async () => null,
    setItem: async (key, value) => {
      if (calls++ === 0) throw new Error('quota');
      data.set(key, value);
    },
    removeItem: async () => {},
  };
  const snapshot = new StorageSnapshot(backend, ['k']);

  snapshot.set('k', 'lost');
  snapshot.set('k', 'kept');
  await snapshot.flush();

  assert.equal(data.get('k'), 'kept');
  assert.equal(snapshot.get('k'), 'kept');
});

test('an undeclared key is refused rather than silently never loaded', () => {
  const snapshot = new StorageSnapshot(null, ['known']);
  assert.throws(() => snapshot.get('typo'), /not declared/);
  assert.throws(() => snapshot.set('typo', 'x'), /not declared/);
});

// ----------------------------------------------------------------- provider

test('stored choices apply once an async store has loaded', async () => {
  const backend = slowBackend({
    readDelay: 30,
    seed: {
      'verum-connect/relays/v2': JSON.stringify({ urls: ['wss://mine.example'], preset: [] }),
      'verum-connect/network/v1': 'ipfs',
    },
  });
  const provider = new VerumConnectProvider(options({ hubCid: CID, hubTx: TX, storage: backend }));

  let changed = 0;
  provider.on('session_changed', () => changed++);

  // Defaults first: nothing has been read yet.
  assert.equal(provider.network, 'arweave');

  await provider.ready;
  assert.equal(provider.network, 'ipfs');
  assert.deepEqual(provider.relayUrls, ['wss://mine.example']);
  // Announced, so a UI rendered on the defaults catches up.
  assert.equal(changed, 1);
});

test('the resolvers see what the provider saved, with no provider in hand', async () => {
  // A wallet selector asks for the hub URL while it renders, before it has a
  // provider. One snapshot per backend is what makes the choice visible there.
  const backend = slowBackend();
  const opts = options({ hubCid: CID, storage: backend });
  const provider = new VerumConnectProvider(opts);
  await provider.ready;

  provider.setGateway('http://localhost:8080/ipfs/{cid}/');

  assert.ok(resolveHub(opts).startsWith('http://localhost:8080/ipfs/'));
});

test('null storage keeps nothing, and still works', async () => {
  const opts = options({ hubCid: CID, storage: null });
  const provider = new VerumConnectProvider(opts);
  await provider.ready;

  provider.setGateway('http://localhost:8080/ipfs/{cid}/');
  assert.ok(provider.resolvedHubUrl.startsWith('http://localhost:8080/'));
  // Nothing was persisted, so a caller without the provider sees the default.
  assert.ok(!resolveHub(opts).startsWith('http://localhost:8080/'));
});

test('a resumed pairing takes the current hub build, and keeps its key and relays', async () => {
  // A release moved the hub to a new transaction while a pairing was in flight.
  // The stored record predates it — including the link that older builds kept
  // verbatim — and resuming must not send the user to the old build.
  const relay = await startRelay();
  const OLD_TX = 'O'.repeat(43);
  const NEW_TX = 'N'.repeat(43);
  const pairing = generateKeypair();
  const backend = slowBackend({
    seed: {
      'verum-connect/pending/v1': JSON.stringify({
        secretKey: pairing.secretKey,
        publicKey: pairing.publicKey,
        relays: [relay.url],
        uri: `https://old.example/${OLD_TX}/#v=1&p=${pairing.publicKey}&t=${OLD_TX}`,
        createdAt: Date.now(),
      }),
    },
  });

  const provider = new VerumConnectProvider(options({ hubTx: NEW_TX, storage: backend }));
  try {
    const uri = await provider.resumePairing();
    assert.ok(uri, 'the stored pairing should resume');
    assert.ok(uri.includes(NEW_TX), 'rebuilt from the current config');
    assert.ok(!uri.includes(OLD_TX), 'nothing of the stored link survives');
    // What the waiting wallet depends on is unchanged.
    assert.ok(uri.includes(`p=${pairing.publicKey}`));
    assert.ok(decodeURIComponent(uri).includes(relay.url));
  } finally {
    await provider.disconnect();
    await relay.close();
  }
});

// ---------------------------------------------------------------------- hub

test('the hub restores sessions from an async store', async () => {
  const relay = await startRelay();
  const dapp = generateKeypair();
  const own = generateKeypair();
  const backend = slowBackend({
    readDelay: 30,
    seed: {
      'verum-connect/hub/v1': JSON.stringify([
        {
          id: dapp.publicKey,
          secretKey: own.secretKey,
          publicKey: own.publicKey,
          relays: [relay.url],
          metadata: { name: 'test', origin: 'https://dapp.example' },
          connectedAt: Date.now(),
        },
      ]),
    },
  });

  const hub = new Hub({ storage: backend });
  try {
    await hub.restore();
    assert.equal(hub.state.sessions.length, 1);
    assert.equal(hub.state.sessions[0].id, dapp.publicKey);
  } finally {
    for (const s of hub.state.sessions) await hub.removeSession(s.id);
    await relay.close();
  }
});
