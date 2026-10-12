/** The hub's own relay set, which is the one a typed code is searched on.
 *
 *  It is also the one list here that an address can fill in, so it is the one
 *  place where a stranger's link chooses what this page connects to. The rules
 *  below are what keeps that bounded: a ceiling on how many, adoption only into
 *  an empty list, and never a silent edit of a list that already exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_RELAYS } from '../packages/shared/protocol/dist/index.js';

/** The module reads localStorage and location; both are given to it here. */
async function load(stored = null) {
  const store = new Map();
  if (stored) store.set('verum-connect/relays/v1', JSON.stringify(stored));

  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  // Origin isolation is what stored relays are gated on; a subdomain gateway.
  globalThis.location = { search: '', hostname: 'bafy.ipfs.example.com', href: 'https://bafy.ipfs.example.com/' };

  const mod = await import(`../packages/wallet/hub/src/relays.ts?${Math.random()}`);
  return { mod, store };
}

const many = Array.from({ length: 50 }, (_, i) => `wss://relay${i}.example`);

test('an address cannot put more relays in use than the cap', async () => {
  const { mod } = await load();
  assert.equal(mod.urlRelays(`?relays=${many.join(',')}`).length, MAX_RELAYS);
});

test('what it named is still reported, so the gap is visible', async () => {
  const { mod } = await load();
  assert.equal(mod.namedInUrl(`?relays=${many.join(',')}`).length, many.length);
});

test('a list typed here is refused past the cap rather than trimmed', async () => {
  // Trimming would leave someone looking at a list missing what they just
  // added, with nothing saying why.
  const { mod } = await load();
  assert.throws(() => mod.saveRelays(many), /At most/);
});

test('duplicates in an address count once', async () => {
  const { mod } = await load();
  const dupes = ['wss://a.example', 'wss://a.example', 'wss://b.example'];
  assert.deepEqual(mod.urlRelays(`?relays=${dupes.join(',')}`), ['wss://a.example', 'wss://b.example']);
});

test('anything that is not a websocket url is dropped', async () => {
  const { mod } = await load();
  assert.deepEqual(mod.urlRelays('?relays=https://a.example,wss://b.example'), ['wss://b.example']);
});

test('an address overrides the stored list without replacing it', async () => {
  const mine = ['wss://mine.example'];
  const { mod } = await load(mine);
  globalThis.location.search = '?relays=wss://theirs.example';

  assert.deepEqual(mod.activeRelays(), ['wss://theirs.example']);
  assert.deepEqual(mod.storedRelays(), mine);
});
