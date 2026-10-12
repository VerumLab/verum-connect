/** The typed-code flow inside a wallet selector.
 *
 *  RainbowKit shows the connect code as plain text it renders once, when its
 *  instructions screen opens. So the code has to be fresh on arrival, must not be
 *  replaced under someone who is choosing, and picking the wallet again must not
 *  re-pair — which would withdraw the very code on screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withStorage, options, CID } from './helpers.mjs';
import { createCodeController } from '../packages/dapp/shared/ui/dist/index.js';
import { ConnectAmbiguityError } from '../packages/dapp/shared/core/dist/index.js';
import { verumConnect } from '../packages/dapp/sdk/wagmi/dist/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Just enough of the provider for the controller: a code that can be parked,
 *  held connects, and the two events it listens to. */
function fakeProvider() {
  const listeners = new Map();
  const p = {
    pairingCodeStatus: 'none',
    pairingCode: null,
    pairingCodeParkedAt: null,
    pendingConnects: [],
    offers: 0,
    cleared: 0,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event).delete(handler);
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    async offerPairingCode() {
      p.offers += 1;
      p.pairingCodeStatus = 'ready';
      p.pairingCode = `CODE-${p.offers}`;
      p.pairingCodeParkedAt = Date.now();
      p.emit('code_changed');
      return p.pairingCode;
    },
    clearCodePairing() {
      p.cleared += 1;
      p.pairingCodeStatus = 'none';
      p.pairingCode = null;
      p.pairingCodeParkedAt = null;
      p.pendingConnects = [];
      p.emit('code_changed');
    },
    async selectPendingConnect() {
      return true;
    },
  };
  return p;
}

// ------------------------------------------------------------- controller

test('a code is replaced once it reaches the refresh age', async () => {
  const p = fakeProvider();
  const codes = createCodeController(p, { refreshAfterMs: 40 });

  await codes.offer();
  assert.equal(codes.getState().code, 'CODE-1');

  await wait(80);
  // At least once: under load the wait can span a second refresh, which is the
  // same behaviour, so the count is not pinned.
  assert.ok(p.offers >= 2, 'the timer replaces it without anyone asking');
  assert.equal(codes.getState().code, `CODE-${p.offers}`);
  codes.destroy();
});

test('a code is not replaced while someone is choosing', async () => {
  const p = fakeProvider();
  const codes = createCodeController(p, { refreshAfterMs: 40 });

  await codes.offer();
  // A wallet answered: replacing the code now would drop its connect.
  p.pendingConnects = [{ publicKey: 'a', code: [], codeString: 'lemon · earth · blaze · apron' }];
  p.emit('pending_connects_changed');

  await wait(80);
  assert.equal(p.offers, 1);
  codes.destroy();
});

test('refreshIfStale leaves a young code alone and replaces an old one', async () => {
  const p = fakeProvider();
  const codes = createCodeController(p, { refreshAfterMs: 60_000 });

  await codes.offer();
  await codes.refreshIfStale();
  assert.equal(p.offers, 1, 'young enough to keep');

  p.pairingCodeParkedAt = Date.now() - 61_000;
  await codes.refreshIfStale();
  assert.equal(p.offers, 2);
  codes.destroy();
});

test('a flooded code is not replaced automatically', async () => {
  // Minting another under attack only hands the attacker the next one.
  const p = fakeProvider();
  const codes = createCodeController(p, { refreshAfterMs: 10 });
  p.pairingCodeStatus = 'flooded';

  await codes.refreshIfStale();
  assert.equal(p.offers, 0);
  codes.destroy();
});

test('withdrawing clears the code and offers a fresh one', async () => {
  const p = fakeProvider();
  const codes = createCodeController(p, { refreshAfterMs: 60_000 });
  await codes.offer();

  codes.withdraw();
  await wait(0);

  assert.equal(p.cleared, 1);
  assert.equal(codes.getState().code, 'CODE-2');
  codes.destroy();
});

test('two wallets showing one session code is a failure, not a choice', () => {
  const p = fakeProvider();
  Object.defineProperty(p, 'pendingConnects', {
    get() {
      throw new ConnectAmbiguityError('same', ['a', 'b']);
    },
  });
  const codes = createCodeController(p);

  const state = codes.getState();
  assert.deepEqual(state.pending, []);
  assert.match(state.failure ?? '', /same session code/);
  codes.destroy();
});

// -------------------------------------------------------------- connector

/** A connector over a real provider whose network calls are replaced. */
async function stubbedConnector(extra = {}) {
  withStorage();
  let provider;
  const calls = { pair: 0, offer: 0, announce: 0 };
  let finish;
  const session = new Promise((resolve) => (finish = resolve));

  const create = verumConnect(options({ hubCid: CID, ...extra }), (p) => {
    provider = p;
    p.resumePairing = async () => null;
    p.pair = async () => {
      calls.pair += 1;
      return 'https://hub.example/#v=1';
    };
    p.offerPairingCode = async () => {
      calls.offer += 1;
      return 'CODE';
    };
    p.reannounceUri = () => {
      calls.announce += 1;
    };
    p.waitForSession = () => session;
  });

  const emitted = [];
  const connector = create({ emitter: { emit: (...args) => emitted.push(args) }, chains: [] });
  await connector.getProvider();
  return { connector, provider, calls, finish };
}

test('picking the wallet again joins the pairing instead of re-pairing', async () => {
  const { connector, calls, finish } = await stubbedConnector({ codeConnect: true });

  const first = connector.connect();
  await wait(0);
  const second = connector.connect();
  await wait(10);

  assert.equal(calls.pair, 1, 'a second pair() would withdraw the code on screen');
  assert.equal(calls.announce, 1, 'the selector waiting on display_uri still gets it');

  finish({ accounts: [], chainId: '0x1' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
});

test('the code is offered with the pairing only when asked for', async () => {
  const withCode = await stubbedConnector({ codeConnect: true });
  const pending = withCode.connector.connect();
  await wait(10);
  assert.equal(withCode.calls.offer, 1);
  withCode.finish({ accounts: [], chainId: '0x1' });
  await pending;

  const bare = await stubbedConnector();
  const pendingBare = bare.connector.connect();
  await wait(10);
  assert.equal(bare.calls.offer, 0, 'the bare connector has nowhere to show one');
  bare.finish({ accounts: [], chainId: '0x1' });
  await pendingBare;
});

test('a finished connect lets the next one pair afresh', async () => {
  const { connector, calls, finish } = await stubbedConnector();
  finish({ accounts: [], chainId: '0x1' });
  await connector.connect();
  await connector.connect();
  assert.equal(calls.pair, 2);
});

// ------------------------------------------------------------------ steps
