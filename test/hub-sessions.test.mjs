/** Sessions are islands: one relay pool each.
 *
 *  The hub used to hold ONE pool shared by every session, built from the union
 *  of their relay lists. That coupled them three ways: pairing a session with an
 *  unseen relay rebuilt the pool and tore down every existing socket and
 *  subscription; a dapp's relay nomination pinned the shared pool, closing the
 *  relays other sessions were using; and the rebuild dropped the pins those
 *  sessions relied on.
 *
 *  Per-session pools make all three impossible rather than guarded against, and
 *  the property to hold onto is simply that no session's pool contains another
 *  session's relays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from '../packages/shared/protocol/test/relay-server.mjs';
import { Hub } from '../packages/wallet/sdk/dist/index.js';
import {
  KIND_HANDSHAKE,
  RelayPool,
  buildEvent,
  conversationKey,
  decrypt,
  encrypt,
  generateKeypair,
  parseEnvelope,
} from '../packages/shared/protocol/dist/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** A wallet that answers everything, so attachWallet completes. */
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

/** The dapp half of a pairing: answers `connect` with `connect_ack`.
 *
 *  Needed because `pair()` rolls the session back if no ack arrives, so there is
 *  no way to reach a paired state without one. Hand-rolled rather than using the
 *  provider, to keep the dapp's gateway and storage logic out of this file.
 *
 *  @param nominate a relay to name in the ack, or null to stay on fan-out
 */
async function fakeDapp(relayUrls, { nominate = null } = {}) {
  const keys = generateKeypair();
  const pool = new RelayPool(relayUrls);
  pool.connect();
  assert.ok(await waitFor(() => pool.connectedCount > 0), 'dapp pool should connect');

  pool.subscribe('dapp-handshake', [{ kinds: [KIND_HANDSHAKE], '#p': [keys.publicKey] }], (event) => {
    const convKey = conversationKey(keys.secretKey, event.pubkey);
    let envelope;
    try {
      envelope = parseEnvelope(decrypt(event.content, convKey));
    } catch {
      return;
    }
    if (envelope.type !== 'connect') return;

    const ack = JSON.stringify({
      type: 'connect_ack',
      v: 1,
      nonce: envelope.nonce,
      metadata: { name: 'Fake', origin: 'https://fake.example' },
      ...(nominate ? { relay: nominate } : {}),
    });
    void pool.publish(buildEvent(KIND_HANDSHAKE, encrypt(ack, convKey), event.pubkey, keys.secretKey));
  });

  return { keys, pool };
}

test('each session gets its own pool, holding only its own relays', async () => {
  const relayA = await startRelay();
  const relayB = await startRelay();
  const hub = new Hub({ storage: null });
  await hub.attachWallet(stubWallet(), 'Stub');

  const dappA = await fakeDapp([relayA.url]);
  const dappB = await fakeDapp([relayB.url]);

  try {
    await hub.pair({ publicKey: dappA.keys.publicKey, relays: [relayA.url] });
    // Session B brings a relay session A's pool has never seen — the case that
    // used to rebuild one shared pool and take A's sockets down with it.
    await hub.pair({ publicKey: dappB.keys.publicKey, relays: [relayB.url] });
    await wait(200);

    assert.equal(hub.state.sessions.length, 2, 'both sessions should be held');

    const forA = Object.keys(hub.relayStatusesFor(dappA.keys.publicKey));
    const forB = Object.keys(hub.relayStatusesFor(dappB.keys.publicKey));

    assert.deepEqual(forA, [relayA.url], "A's pool should hold only A's relay");
    assert.deepEqual(forB, [relayB.url], "B's pool should hold only B's relay");
    // The island property, stated directly: no overlap at all.
    assert.equal(forA.filter((url) => forB.includes(url)).length, 0);

    // Both are live, so neither pairing cost the other its connection.
    assert.ok(await waitFor(() => hub.relayStatusesFor(dappA.keys.publicKey)[relayA.url] === 'open'));
    assert.ok(await waitFor(() => hub.relayStatusesFor(dappB.keys.publicKey)[relayB.url] === 'open'));
  } finally {
    for (const s of hub.state.sessions) await hub.removeSession(s.id);
    dappA.pool.close();
    dappB.pool.close();
    await relayA.close();
    await relayB.close();
  }
});

test("a relay nomination narrows only the nominating session's pool", async () => {
  // The hostile case reduced to its observable shape. B nominates its own relay;
  // pin() closes every other relay in whichever pool it is called on, so with a
  // shared pool this reached into A. A's pool never holds B's relay now, so
  // there is nothing for the nomination to narrow it to.
  const shared = await startRelay();
  const attacker = await startRelay();
  const hub = new Hub({ storage: null });
  await hub.attachWallet(stubWallet(), 'Stub');

  const victim = await fakeDapp([shared.url]);
  const hostile = await fakeDapp([shared.url, attacker.url], { nominate: attacker.url });

  try {
    await hub.pair({ publicKey: victim.keys.publicKey, relays: [shared.url] });
    await hub.pair({
      publicKey: hostile.keys.publicKey,
      relays: [shared.url, attacker.url],
    });
    await wait(400);

    const forVictim = hub.relayStatusesFor(victim.keys.publicKey);
    assert.deepEqual(Object.keys(forVictim), [shared.url]);
    assert.ok(
      await waitFor(() => hub.relayStatusesFor(victim.keys.publicKey)[shared.url] === 'open'),
      "the victim's relay was closed by another session's nomination",
    );

    // And the nomination did land where it belongs: the hostile session narrowed
    // to the relay it named, closing the other one in ITS pool only.
    assert.ok(
      await waitFor(() => hub.relayStatusesFor(hostile.keys.publicKey)[shared.url] === 'closed'),
      'the nominating session should have narrowed to its chosen relay',
    );
  } finally {
    for (const s of hub.state.sessions) await hub.removeSession(s.id);
    victim.pool.close();
    hostile.pool.close();
    await shared.close();
    await attacker.close();
  }
});

test('closing a session leaves the other pool untouched', async () => {
  const relayA = await startRelay();
  const relayB = await startRelay();
  const hub = new Hub({ storage: null });
  await hub.attachWallet(stubWallet(), 'Stub');

  const dappA = await fakeDapp([relayA.url]);
  const dappB = await fakeDapp([relayB.url]);

  try {
    await hub.pair({ publicKey: dappA.keys.publicKey, relays: [relayA.url] });
    await hub.pair({ publicKey: dappB.keys.publicKey, relays: [relayB.url] });
    await wait(200);

    await hub.removeSession(dappB.keys.publicKey);
    await wait(200);

    assert.equal(hub.state.sessions.length, 1);
    // B's pool is gone with B, and A's is still up.
    assert.deepEqual(hub.relayStatusesFor(dappB.keys.publicKey), {});
    assert.equal(hub.relayStatusesFor(dappA.keys.publicKey)[relayA.url], 'open');
  } finally {
    for (const s of hub.state.sessions) await hub.removeSession(s.id);
    dappA.pool.close();
    dappB.pool.close();
    await relayA.close();
    await relayB.close();
  }
});
