/** The typed-code path end to end, with nothing published in the clear.
 *
 *  The parked event names only the pairing key. Everything a QR carries in its
 *  fragment — relays, hub CID, Arweave transaction, mobile URL — reaches the hub
 *  afterwards in `connect_ack`, encrypted. This test walks the whole path with
 *  the real provider and the real Hub to prove the second half actually arrives,
 *  because if it does not the failure is silent: pairing still works and only the
 *  deep-link handoff quietly goes bare.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import { VerumConnectProvider } from '../packages/dapp/shared/core/dist/index.js';
import { Hub, resolvePairingCode } from '../packages/wallet/sdk/dist/index.js';
import {
  KIND_PAIRING_LOOKUP,
  RelayPool,
  buildPairingFragment,
  parsePairingFragment,
} from '../packages/shared/protocol/dist/index.js';

const CID = 'bafybeihvcbfjfelqqdpmjwdyxtjtjckv7wdinui7epwfbojz47yvfnb7m4';
const TX = '60BQVxxTYI688pFQPCYzqHv_jCWZqJq1HvOTVDUakWI';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

function stubWallet() {
  return {
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
      if (method === 'eth_chainId') return '0x1';
      const err = new Error('unsupported');
      err.code = 4200;
      throw err;
    },
  };
}

test('a code pairing learns the dapp nomination over the encrypted channel', async () => {
  const relay = await startRelay();

  const provider = new VerumConnectProvider({
    hubCid: CID,
    hubTx: TX,
    metadata: { name: 'Test Dapp', origin: 'https://dapp.example' },
    relays: [relay.url],
  });

  await provider.pair();
  const code = await provider.offerPairingCode();

  const hub = new Hub({ storage: null });
  await hub.attachWallet(stubWallet(), 'Stub');

  const params = await resolvePairingCode(code, { relays: [relay.url], collectMs: 400 });

  // Everything the lookup could tell the hub: a key, and where it was found.
  assert.equal(typeof params.publicKey, 'string');
  assert.deepEqual(params.relays, [relay.url]);
  assert.equal(params.cid, undefined, 'the parked event names no hub build');
  assert.equal(params.tx, undefined);
  assert.equal(params.webviewUrl, undefined);

  // The dapp holds the connect until the user picks it out by session code, so
  // the ack — and the nomination with it — only exists after the selection.
  // Caught immediately rather than at the await: a rejection with no handler
  // attached takes the whole run down before the selection can happen.
  let pairError = null;
  const paired = hub.pair(params).catch((err) => {
    pairError = err;
    return null;
  });

  assert.ok(
    await waitFor(() => provider.pendingConnects.length === 1),
    'the connect must reach the dapp',
  );
  assert.ok(await provider.selectPendingConnect(provider.pendingConnects[0].codeString));

  const session = await paired;
  assert.ok(session, `pairing failed: ${pairError?.message}`);

  try {
    assert.deepEqual(session.nomination.relays, [relay.url]);
    assert.equal(session.nomination.cid, CID);
    assert.equal(session.nomination.tx, TX);
    // Arweave is preferred where both exist, so the phone is sent to a sandboxed
    // transaction origin rather than a path gateway.
    assert.ok(session.nomination.webviewUrl.includes(TX));

    // What the hub rebuilds for the deep-link handoff has to be a fragment a
    // cold hub on a phone can pair from — which is the whole reason any of this
    // still travels.
    const reparsed = parsePairingFragment(
      buildPairingFragment({ publicKey: session.id, ...session.nomination }),
    );
    assert.equal(reparsed.publicKey, session.id);
    assert.equal(reparsed.cid, CID);
    assert.equal(reparsed.tx, TX);
    assert.deepEqual(reparsed.relays, [relay.url]);
  } finally {
    for (const s of hub.state.sessions) await hub.removeSession(s.id);
    await provider.disconnect();
    await relay.close();
  }
});

test('nothing on the wire under the lookup kind carries the pairing data', async () => {
  const relay = await startRelay();

  const watcher = new RelayPool([relay.url]);
  watcher.connect();
  assert.ok(await waitFor(() => watcher.connectedCount === 1));

  const seen = [];
  watcher.subscribe('scrape', [{ kinds: [KIND_PAIRING_LOOKUP] }], (event) => seen.push(event));

  const provider = new VerumConnectProvider({
    hubCid: CID,
    hubTx: TX,
    metadata: { name: 'Test Dapp', origin: 'https://dapp.example' },
    relays: [relay.url],
  });
  await provider.pair();
  await provider.offerPairingCode();

  assert.ok(await waitFor(() => seen.length > 0), 'the code must be parked');

  // A scraper subscribing to this kind is the threat being measured. It gets a
  // pubkey — which the handshake's `p` tag already shows it — and no gateway,
  // network or relay preference at all.
  for (const event of seen) {
    assert.equal(event.content, '');
    const wire = JSON.stringify(event);
    assert.ok(!wire.includes(CID));
    assert.ok(!wire.includes(TX));
    assert.ok(!wire.includes('ws://'));
  }

  watcher.close();
  await provider.disconnect();
  await relay.close();
});
