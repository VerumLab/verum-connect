/** Which hub URL a dapp hands out, per network and role.
 *
 *  Every assertion here stands for a bug that shipped. The pair of URLs this
 *  produces is the whole of the dapp's side of pairing — get one wrong and the
 *  failure is two screens both saying "waiting", with nothing to explain it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withStorage, options, CID, TX, TX_SANDBOX } from './helpers.mjs';
import {
  VerumConnectProvider,
  resolveHub,
  resolveNetwork,
  resolveWebviewHub,
} from '../packages/dapp/shared/core/dist/index.js';
import { ARWEAVE_GATEWAYS } from '../packages/shared/protocol/dist/uri.js';

test('a dapp may publish either identifier alone, or both', () => {
  withStorage();
  assert.equal(resolveNetwork(options({ hubCid: CID }), null), 'ipfs');
  assert.equal(resolveNetwork(options({ hubTx: TX }), null), 'arweave');
  // Arweave leads when both exist: it is the only route giving a per-build
  // origin that a wallet's in-app browser can load.
  assert.equal(resolveNetwork(options({ hubCid: CID, hubTx: TX }), null), 'arweave');
  // ...unless the user said otherwise.
  assert.equal(resolveNetwork(options({ hubCid: CID, hubTx: TX }), 'ipfs'), 'ipfs');
});

test('desktop and mobile urls never mix identifiers', () => {
  withStorage();
  const opts = options({ hubCid: CID, hubTx: TX });

  for (const network of ['arweave', 'ipfs']) {
    const desktop = resolveHub(opts, null, network);
    const mobile = resolveWebviewHub(opts, null, null, network);

    for (const [role, url] of [['desktop', desktop], ['mobile', mobile]]) {
      if (network === 'arweave') {
        assert.ok(url.includes(TX), `${role} on arweave should carry the tx`);
        // The bug this stands for: an Arweave template reached resolveGateway,
        // which treats a template without {cid} as a base url and appended
        // /ipfs/<cid>/ to it — producing arweave.net/<tx>/ipfs/<cid>/.
        assert.ok(!url.includes(CID), `${role} on arweave must not carry the cid`);
      } else {
        assert.ok(url.includes(CID), `${role} on ipfs should carry the cid`);
        assert.ok(!url.includes(TX), `${role} on ipfs must not carry the tx`);
      }
    }
  }
});

test('switching network moves both urls, and back again', () => {
  withStorage();
  const provider = new VerumConnectProvider(options({ hubCid: CID, hubTx: TX }));

  assert.ok(provider.resolvedHubUrl.includes(TX));
  assert.ok(provider.webviewHubUrl.includes(TX));

  provider.setNetwork('ipfs');
  assert.ok(provider.resolvedHubUrl.includes(CID));
  assert.ok(provider.webviewHubUrl.includes(CID));

  provider.setNetwork('arweave');
  assert.ok(provider.resolvedHubUrl.includes(TX));
});

test('each network keeps its own gateway choice', () => {
  withStorage();
  const provider = new VerumConnectProvider(
    options({
      hubCid: CID,
      hubTx: TX,
      webviewGateways: ['https://a.example/ipfs/{cid}/', 'https://b.example/ipfs/{cid}/'],
      arweaveGateways: ['https://{sandbox}.one.example/{tx}/', 'https://{sandbox}.two.example/{tx}/'],
    }),
  );

  provider.setArweaveWebviewGateway('https://{sandbox}.two.example/{tx}/');
  assert.ok(provider.webviewHubUrl.includes('two.example'));

  provider.setNetwork('ipfs');
  provider.setWebviewGateway('https://b.example/ipfs/{cid}/');
  assert.ok(provider.webviewHubUrl.includes('b.example'));
  // Switching back must not have to be re-picked, and must not inherit the
  // other network's choice.
  provider.setNetwork('arweave');
  assert.ok(provider.webviewHubUrl.includes('two.example'));
});

test('a fixed hubUrl overrides every gateway choice', () => {
  withStorage();
  const opts = options({ hubUrl: 'https://hub.example/', hubCid: CID, hubTx: TX });
  assert.equal(resolveHub(opts), 'https://hub.example/');
  assert.equal(resolveWebviewHub(opts), 'https://hub.example/');
});

test('arweave gateway templates address the sandbox and end in a slash', () => {
  for (const template of ARWEAVE_GATEWAYS) {
    // {sandbox} is what avoids the redirect: reaching the bare host means a 30x
    // to the sandbox, and the pairing rides in the fragment, which survives a
    // redirect only by browser convention.
    assert.ok(template.includes('{sandbox}'), `${template} should address the sandbox`);
    // Every gateway but arweave.net answers 301 without the trailing slash,
    // reintroducing exactly that redirect.
    assert.ok(template.endsWith('/'), `${template} should end with a slash`);
  }
});

test('the resolved arweave url is the sandbox origin for that transaction', () => {
  withStorage();
  const url = resolveHub(options({ hubTx: TX }), null, 'arweave');
  assert.ok(new URL(url).hostname.startsWith(`${TX_SANDBOX}.`));
});
