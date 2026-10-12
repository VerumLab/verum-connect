/** The verify script against pages served from here, standing in for gateways.
 *
 *  What it must do is tell the built file from a different one, and from the
 *  built file with something added after it — which is what a gateway's CDN
 *  does to a page and is not the same thing as tampering. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { POPUP_URL_TOKEN as TOKEN } from '../packages/dapp/bookmarklet/popup-token.mjs';

const dist = (path) => readFileSync(new URL(`../packages/${path}`, import.meta.url));
const hub = dist('wallet/hub/dist/index.html');
const folder = Object.fromEntries(
  readdirSync(new URL('../packages/dapp/bookmarklet/dist', import.meta.url)).map((f) => [f, dist(`dapp/bookmarklet/dist/${f}`)]),
);

let server;
let origin;

before(async () => {
  const routes = {
    '/hub/': hub,
    '/hub-beacon/': Buffer.concat([hub, Buffer.from('\n<script>beacon()</script>')]),
    '/hub-altered/': Buffer.from(hub.toString('utf8').replace('<html', '<html data-x="1"')),
    '/panel/popup.html': folder['popup.html'],
    ...Object.fromEntries(Object.entries(folder).map(([f, b]) => [f === 'index.html' ? '/bm/' : `/bm/${f}`, b])),
  };
  server = createServer((req, res) => {
    const body = routes[req.url ?? ''];
    res.statusCode = body ? 200 : 404;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function verify(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL('../scripts/verify-deploy.mjs', import.meta.url).pathname, '--no-build', ...args]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** What the install page makes of the bundle, for an address. */
const bookmark = (address, code = folder['inject.js'].toString('utf8').trim()) =>
  `javascript:void((function(){${code.split(TOKEN).join(address)}})())`
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/"/g, '%22')
    .replace(/\n/g, '%0A');

test('a hub page that is the built file passes', async () => {
  const { code, out } = await verify(`${origin}/hub/`);
  assert.equal(code, 0, out);
  assert.match(out, /the hub — byte-identical/);
});

test('bytes added after the file are reported, not failed', async () => {
  const { code, out } = await verify(`${origin}/hub-beacon/`);
  assert.equal(code, 0, out);
  assert.match(out, /bytes added by the host: <script>beacon\(\)<\/script>/);
});

test('a different page fails', async () => {
  const { code, out } = await verify(`${origin}/hub-altered/`);
  assert.equal(code, 1, out);
  assert.match(out, /matches neither/);
});

test('a bookmarklet folder is checked file by file', async () => {
  const { code, out } = await verify(`${origin}/bm/`);
  assert.equal(code, 0, out);
  for (const file of ['popup.html', 'inject.js', 'install.html']) assert.match(out, new RegExp(`✓ ${file} — byte-identical`));
});

test('a bookmark made from this source passes, and its panel is checked too', async () => {
  const address = `${origin}/panel/popup.html`;
  const { code, out } = await verify('--bookmark', bookmark(address));
  assert.equal(code, 0, out);
  assert.match(out, /exactly the one built from this source/);
  assert.match(out, new RegExp(`loads its panel from ${address.replace(/[.]/g, '\\.')}`));
  assert.match(out, /the panel at that address — byte-identical/);
});

test('a bookmark with one character changed fails', async () => {
  const code = folder['inject.js'].toString('utf8').trim();
  const middle = Math.floor(code.length / 2);
  const tampered = code.slice(0, middle) + (code[middle] === 'x' ? 'y' : 'x') + code.slice(middle + 1);
  const { code: exit, out } = await verify('--bookmark', bookmark(`${origin}/panel/popup.html`, tampered));
  assert.equal(exit, 1, out);
  assert.match(out, /is not the bookmark this source builds/);
});

test('a bookmark whose panel address serves something else fails on the panel', async () => {
  const { code, out } = await verify('--bookmark', bookmark(`${origin}/hub/`));
  assert.equal(code, 1, out);
  assert.match(out, /exactly the one built from this source/);
  assert.match(out, /✗ the panel at that address — DIFFERENT/);
});
