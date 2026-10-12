/** The bookmarklet, as the thing a browser actually stores.
 *
 *  Its whole delivery is a URL, so the failure mode is encoding rather than
 *  logic: a stray character truncates the program in the address bar and the
 *  bookmark silently does nothing, or does half of it. That cannot be caught by
 *  type checking — the source is fine, the URL is not — so it is checked here on
 *  the built artifact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { POPUP_URL_TOKEN as TOKEN } from '../packages/dapp/bookmarklet/popup-token.mjs';

const read = (name) =>
  readFileSync(new URL(`../packages/dapp/bookmarklet/${name}`, import.meta.url), 'utf8');

const url = read('dist/bookmarklet.txt');

/** What the browser does with a javascript: bookmark: strip the scheme, decode
 *  the percent-encoding, run what is left. */
function program() {
  assert.ok(url.startsWith('javascript:'), 'a bookmarklet is a javascript: URL');
  return decodeURIComponent(url.slice('javascript:'.length));
}

test('the encoded bookmarklet is still a valid program', () => {
  // Compiled, not run: there is no DOM here, and a syntax error is the failure
  // this is looking for.
  assert.doesNotThrow(() => new Function(program()));
});

test('it survives the address bar', () => {
  // A raw # ends the URL as far as a bookmark is concerned, taking the rest of
  // the program with it; a raw % starts an escape that eats the next two
  // characters. Both have to be encoded before the browser sees them.
  const encoded = url.slice('javascript:'.length);
  assert.ok(!/#/.test(encoded), 'an unencoded # truncates the bookmark');
  assert.ok(!/%(?![0-9a-f]{2})/i.test(encoded), 'every % must introduce an escape');
  assert.ok(!/\n/.test(url), 'a newline ends the URL');
});

test('it evaluates to nothing, so the page is not replaced', () => {
  // A javascript: URL that yields a value navigates the tab to that value,
  // wiping the dapp the user is standing on.
  assert.match(program(), /^void\(/);
});

test('it fetches nothing but the panel', () => {
  // The program is stored in the bookmark and never updates itself, and the one
  // address it carries is the panel's. A second address appearing here would be
  // a call home that a bookmark has no business making.
  const code = program();
  const urls = [...code.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]);
  const external = [...new Set(urls)]
    .filter((u) => !u.startsWith('http://www.w3.org/'))
    // A scheme followed by an expression is a URL being built at runtime from
    // something the user typed — not an address this bundle carries.
    .filter((u) => /^https?:\/\/[a-z0-9]/i.test(u));

  assert.equal(external.length, 1, `expected one address, got ${external.join(', ')}`);
  // Unresolved by default: the install page substitutes its own location as the
  // link is dragged, so the shipped bundle names a host that cannot resolve
  // rather than one that could quietly become someone else's.
  assert.match(external[0], /^https:\/\/verum\.invalid\/|\/popup\.html$/);
});

test('the install page can still find the placeholder to replace', () => {
  // A minifier rewriting the string, or a token drifting between the two files,
  // leaves a bookmark pointing at a host that does not exist — and only at click
  // time, long after the build passed.
  const page = read('dist/install.html');
  assert.ok(page.includes(TOKEN), 'the bundle in the install page carries the token');
  assert.ok(page.includes(`var TOKEN = ${JSON.stringify(TOKEN)}`), 'and the page knows it');
});

test('the install page script is a valid program', () => {
  // It is written inside a template literal in the build script, so a stray
  // backtick or apostrophe ends a string early and the page ships a syntax
  // error. Nothing about that is visible in the build: it succeeds, the page
  // renders, and every control is simply inert — both sets of instructions
  // showing at once, with the placeholders they fill in left empty.
  const page = read('dist/install.html');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  assert.ok(scripts.length > 0, 'the page carries its script inline');
  for (const code of scripts) {
    assert.doesNotThrow(() => new Function(code));
  }
});
