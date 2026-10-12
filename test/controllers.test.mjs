/** The rules the renderers are not allowed to reimplement.
 *
 *  These exist because three integrations wrote them out separately and each
 *  got a different one wrong: the RainbowKit panel shipped without re-pairing,
 *  so a relay change silently did nothing; its Reset button bypassed the apply
 *  path entirely; and the gateway pickers collapsed two lists into one, sending
 *  an Arweave template to the IPFS resolver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withStorage, options, CID, TX } from './helpers.mjs';
import { VerumConnectProvider } from '../packages/dapp/shared/core/dist/index.js';
import {
  createGatewayController,
  createRelayController,
  mountGatewayPicker,
} from '../packages/dapp/shared/ui/dist/index.js';

/** A provider with pair() replaced, so the rules can be checked without a
 *  network. Counting the calls is the point: re-pairing is the step that was
 *  missing, and nothing else observes it. */
function provider(extra = {}) {
  const p = new VerumConnectProvider(options({ hubCid: CID, ...extra }));
  const calls = { pair: 0 };
  p.pair = async () => {
    calls.pair += 1;
    return 'https://hub.example/#v=1';
  };
  return { p, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------- relays

test('changing relays re-pairs', async () => {
  withStorage();
  const { p, calls } = provider();
  const c = createRelayController(p);

  c.add('wss://added.example');
  await settle();

  assert.equal(calls.pair, 1, 'setRelays alone leaves the pool on the old set');
  assert.ok(p.relayUrls.includes('wss://added.example'));
  c.destroy();
});

test('reset re-pairs too, rather than bypassing the apply path', async () => {
  withStorage();
  const { p, calls } = provider();
  const c = createRelayController(p);

  c.add('wss://mine.example');
  await settle();
  const afterAdd = calls.pair;

  c.reset();
  await settle();

  assert.equal(calls.pair, afterAdd + 1);
  // resetRelays keeps what the user added by hand and replaces only the presets.
  assert.ok(p.relayUrls.includes('wss://mine.example'));
  c.destroy();
});

test('the last relay cannot be removed', async () => {
  withStorage();
  const { p } = provider({ relays: ['wss://only.example'] });
  const c = createRelayController(p);

  c.remove('wss://only.example');
  await settle();

  // With none there is no transport at all, so this is refused rather than
  // left to fail later as a session that never connects.
  assert.deepEqual(c.getState().relays, ['wss://only.example']);
  c.destroy();
});

test('a locked controller refuses every change', async () => {
  withStorage();
  const { p, calls } = provider();
  const c = createRelayController(p);
  const before = [...p.relayUrls];

  c.setLocked(true);
  c.add('wss://nope.example');
  c.remove(before[0]);
  c.reset();
  await settle();

  assert.equal(calls.pair, 0);
  assert.deepEqual(p.relayUrls, before);
  c.destroy();
});

test('a rejected relay surfaces as an error, not a throw', async () => {
  withStorage();
  const { p } = provider();
  const c = createRelayController(p);

  c.add('http://not-a-websocket.example');
  await settle();

  assert.match(c.getState().error ?? '', /websocket/i);
  c.destroy();
});

test('subscribers see the change', async () => {
  withStorage();
  const { p } = provider();
  const c = createRelayController(p);

  let seen = null;
  const off = c.subscribe((state) => {
    seen = state;
  });
  c.add('wss://watched.example');
  await settle();

  assert.ok(seen?.relays.includes('wss://watched.example'));
  off();
  c.destroy();
});

// ------------------------------------------------------------------ gateways

test('ipfs gives the two roles different lists, arweave one', () => {
  withStorage();
  const p = new VerumConnectProvider(
    options({
      hubCid: CID,
      hubTx: TX,
      webviewGateways: ['https://path.example/ipfs/{cid}/'],
      arweaveGateways: ['https://{sandbox}.one.example/{tx}/'],
    }),
  );
  const c = createGatewayController(p);

  c.setNetwork('ipfs');
  const ipfs = c.getState();
  assert.notDeepEqual(ipfs.desktopGateways, ipfs.mobileGateways);
  assert.ok(ipfs.mobileGateways.some((t) => t.includes('path.example')));

  c.setNetwork('arweave');
  const arweave = c.getState();
  // A sandboxed transaction is isolated and WebView-loadable at once, so there
  // is nothing weaker to fall back to and no reason to offer a different set.
  assert.deepEqual(arweave.desktopGateways, arweave.mobileGateways);

  c.destroy();
});

test('the setters reach the network-appropriate gateway', () => {
  withStorage();
  const p = new VerumConnectProvider(
    options({
      hubCid: CID,
      hubTx: TX,
      webviewGateways: ['https://a.example/ipfs/{cid}/', 'https://b.example/ipfs/{cid}/'],
      arweaveGateways: ['https://{sandbox}.one.example/{tx}/', 'https://{sandbox}.two.example/{tx}/'],
    }),
  );
  const c = createGatewayController(p);

  c.setMobileGateway('https://{sandbox}.two.example/{tx}/');
  assert.ok(p.webviewHubUrl.includes('two.example'));

  c.setNetwork('ipfs');
  c.setMobileGateway('https://b.example/ipfs/{cid}/');
  assert.ok(p.webviewHubUrl.includes('b.example'));
  // The Arweave choice must not have been overwritten by the IPFS one.
  c.setNetwork('arweave');
  assert.ok(p.webviewHubUrl.includes('two.example'));

  c.destroy();
});

test('canSwitch follows what the dapp published', () => {
  withStorage();
  const one = createGatewayController(new VerumConnectProvider(options({ hubCid: CID })));
  const both = createGatewayController(
    new VerumConnectProvider(options({ hubCid: CID, hubTx: TX })),
  );
  assert.equal(one.getState().canSwitch, false);
  assert.equal(both.getState().canSwitch, true);
  one.destroy();
  both.destroy();
});

/** Just enough of a DOM for the picker to build into, so what it draws can be
 *  read back. */
class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.textContent = '';
    this.children = [];
  }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  setAttribute() {}
  remove() {}
}
const everything = (el, out = []) => {
  out.push(el);
  for (const c of el.children) everything(c, out);
  return out;
};

function drawn(providerOptions) {
  withStorage();
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const picker = mountGatewayPicker(new VerumConnectProvider(options(providerOptions)));
    const all = everything(picker.el);
    const result = {
      toggle: all.find((e) => e.className === 'verum-network'),
      options: all.filter((e) => e.tagName === 'option').map((e) => e.textContent),
      rows: all.filter((e) => e.className === 'verum-gateway').length,
    };
    picker.destroy();
    return result;
  } finally {
    delete globalThis.document;
  }
}

test('the network switch is drawn only when both a cid and a transaction exist', () => {
  assert.equal(drawn({ hubCid: CID }).toggle, undefined);
  assert.equal(drawn({ hubTx: TX }).toggle, undefined);

  const both = drawn({ hubCid: CID, hubTx: TX });
  assert.ok(both.toggle);
  assert.deepEqual(
    both.toggle.children.map((b) => b.textContent),
    ['Arweave', 'IPFS'],
  );
});

test('a dapp with one network sees that network\'s gateways and nothing about the other', () => {
  const ipfs = drawn({ hubCid: CID });
  assert.equal(ipfs.rows, 2);
  assert.ok(!ipfs.options.some((o) => /arweave|ar-io/i.test(o)));

  const arweave = drawn({ hubTx: TX });
  assert.equal(arweave.rows, 2);
  assert.ok(arweave.options.length > 0);
});

test('relay state carries what each relay did with the connect code', async () => {
  // The diagnostics belong to the SDK, not to one panel: a dapp, a wallet
  // selector and the bookmarklet all read the same state, and each of them
  // otherwise has to reach into the provider and invent its own vocabulary.
  const { createRelayController } = await import('../packages/dapp/shared/ui/dist/index.js');

  const provider = {
    relayUrls: ['wss://kept.example', 'wss://dropped.example', 'wss://rude.example'],
    relayStatuses: { 'wss://kept.example': 'open' },
    relayNotices: { 'wss://rude.example': 'refused: restricted' },
    pairingCode: 'ABCD-EFGH',
    pairingCodeRelays: ['wss://kept.example'],
    pairingCodeDropped: ['wss://dropped.example'],
    on: () => () => {},
  };

  const controller = createRelayController(provider, { pollMs: 10_000 });
  const state = controller.getState();

  assert.equal(state.codeParked, true);
  assert.deepEqual(state.codeKept, ['wss://kept.example']);
  assert.deepEqual(state.codeDropped, ['wss://dropped.example']);
  assert.equal(state.notices['wss://rude.example'], 'refused: restricted');
  controller.destroy();
});

test('changing relays re-parks the code so it is verified on the new set', async () => {
  // Entering relays is the developer's job; proving they can carry a code is
  // not. A set changed under a parked code leaves it on relays this dapp has
  // left, and pair() discards it — so a fresh one has to be offered.
  const { createRelayController } = await import('../packages/dapp/shared/ui/dist/index.js');

  const calls = [];
  const provider = {
    relayUrls: ['wss://one.example'],
    relayStatuses: {},
    relayNotices: {},
    pairingCode: 'ABCD-EFGH',
    pairingCodeRelays: [],
    pairingCodeDropped: [],
    on: () => () => {},
    setRelays: (urls) => calls.push(['setRelays', urls]),
    pair: async () => calls.push(['pair']),
    offerPairingCode: async () => calls.push(['offerPairingCode']),
  };

  const controller = createRelayController(provider, { pollMs: 10_000 });
  controller.add('wss://two.example');
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(calls.map(([name]) => name), ['setRelays', 'pair', 'offerPairingCode']);
  assert.deepEqual(calls[0][1], ['wss://one.example', 'wss://two.example']);
  controller.destroy();
});

test('relay state survives the pairing it describes', async () => {
  // Closing a wallet selector's modal ends the pairing, and the settings that
  // would explain what happened usually sit behind that modal — so reaching
  // them destroyed the answer: every dot grey, every code badge empty. The last
  // live state is kept, and flagged so it is not read as the present.
  const { createRelayController } = await import('../packages/dapp/shared/ui/dist/index.js');

  let live = true;
  const provider = {
    relayUrls: ['wss://one.example'],
    get relayStatuses() {
      return live ? { 'wss://one.example': 'open' } : {};
    },
    relayNotices: {},
    get pairingCode() {
      return live ? 'ABCD-EFGH' : null;
    },
    get pairingCodeRelays() {
      return live ? ['wss://one.example'] : [];
    },
    pairingCodeDropped: [],
    on: () => () => {},
  };

  const controller = createRelayController(provider, { pollMs: 10 });
  // Destroyed whatever happens: its poll keeps the process alive, so a failed
  // assertion here would hang the runner rather than report.
  try {
    assert.equal(controller.getState().stale, false);
    assert.equal(controller.getState().codeParked, true);

    live = false;
    await new Promise((r) => setTimeout(r, 40));

    const after = controller.getState();
    assert.equal(after.stale, true, 'flagged as the last pairing, not the present one');
    assert.deepEqual(after.statuses, { 'wss://one.example': 'open' }, 'and still readable');
    assert.deepEqual(after.codeKept, ['wss://one.example']);
  } finally {
    controller.destroy();
  }
});
