/** The wallet side, running with no browser.
 *
 *  This is the case any wallet outside a browser is in — a desktop application,
 *  a hardware wallet's companion app, a headless signer. If any of these need a
 *  DOM, a localStorage or a window, the session logic is not reusable outside
 *  the hub page and the integration story is false. So the whole file runs with
 *  those globals deliberately absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hub, browserStorage } from '../packages/wallet/sdk/dist/index.js';

/** No localStorage, no document, no window — the state a Node or Electron main
 *  process is actually in. */
function headless() {
  for (const key of ['localStorage', 'document', 'window']) {
    delete globalThis[key];
  }
}

test('a hub constructs with no browser globals at all', () => {
  headless();
  const hub = new Hub();
  assert.ok(hub);
  // Nowhere durable to keep a secret key, so it says so rather than pretending.
  assert.equal(browserStorage(), null);
});

test('restore is a no-op without storage rather than a crash', async () => {
  headless();
  const hub = new Hub();
  await hub.restore();
  assert.deepEqual(hub.state.sessions, []);
});

test('a wallet is anything with a request method', async () => {
  headless();
  const hub = new Hub();

  const seen = [];
  // Exactly what a desktop wallet supplies: one function. Everything it is
  // asked here is answered from its own key store and approval UI.
  const wallet = {
    request: async ({ method }) => {
      seen.push(method);
      if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
      if (method === 'eth_chainId') return '0x1';
      // EIP-2255 is optional; declining it is the ordinary case off-browser.
      const err = new Error('unsupported');
      err.code = 4200;
      throw err;
    },
  };

  await hub.attachWallet(wallet, 'Desktop wallet');

  assert.equal(hub.state.walletName, 'Desktop wallet');
  assert.deepEqual(hub.state.accounts, ['0x1111111111111111111111111111111111111111']);
  assert.equal(hub.state.chainId, '0x1');
  // It asked for the permission first and carried on when refused.
  assert.ok(seen.includes('wallet_requestPermissions'));
  assert.ok(seen.includes('eth_requestAccounts'));
});

test('a declined connection leaves no wallet attached', async () => {
  headless();
  const hub = new Hub();

  const declined = {
    request: async () => {
      const err = new Error('User rejected');
      err.code = 4001;
      throw err;
    },
  };

  await assert.rejects(() => hub.attachWallet(declined, 'Desktop wallet'));
  // Committed only once the wallet has actually answered — a refused prompt
  // must not leave the UI showing a live connection.
  assert.equal(hub.state.walletName, null);
});

test('an injected store is used instead of localStorage', async () => {
  headless();
  const store = new Map();
  const read = [];
  const storage = {
    getItem: async (k) => {
      read.push(k);
      return store.has(k) ? store.get(k) : null;
    },
    setItem: async (k, v) => void store.set(k, v),
    removeItem: async (k) => void store.delete(k),
  };

  const hub = new Hub({ storage });
  await hub.restore();
  // It went to the injected store, not to a global that is not there.
  assert.ok(read.length > 0);
  // Nothing stored yet, and reading an empty store must not throw.
  assert.deepEqual(hub.state.sessions, []);
});
