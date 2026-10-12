/** The panel, run rather than read.
 *
 *  It shipped broken three times with a green build: two syntax errors in the
 *  install page, then a `let` assigned during startup before its declaration —
 *  valid code that only fails when executed. Each time the symptom was a dapp
 *  saying the gateway was unreachable, because a panel that dies on load never
 *  answers anyone. So the built bundle is executed here against a minimal page,
 *  and anything it throws on the way up fails this test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Just enough of a DOM for the panel to build its first screen. */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  append(...kids) { this.children.push(...kids); }
  prepend(...kids) { this.children.unshift(...kids); }
  after() {}
  replaceChildren(...kids) { this.children = kids; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
}

function stubPage() {
  const body = new El('body');
  const store = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const listeners = [];
  Object.assign(globalThis, {
    window: globalThis,
    document: {
      body,
      documentElement: new El('html'),
      title: '',
      getElementById: () => new El('div'),
      createElement: (t) => new El(t),
      createElementNS: (_, t) => new El(t),
      createTextNode: (t) => ({ textContent: t }),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      head: new El('head'),
      visibilityState: 'visible',
    },
    location: { href: 'https://gateway.example/ipfs/bafy/popup.html', origin: 'https://gateway.example', protocol: 'https:', host: 'gateway.example' },
    localStorage: store(),
    sessionStorage: store(),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener() {},
    postMessage() {},
    opener: null,
    // Vite's module preload shim looks for these; the panel itself does not.
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLElement: El,
    innerWidth: 1024,
    innerHeight: 768,
  });
  globalThis.parent = globalThis;
  return { listeners };
}

test('the built panel starts without throwing', async () => {
  const html = readFileSync(new URL('../packages/dapp/bookmarklet/dist/popup.html', import.meta.url), 'utf8');
  const code = [...html.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.ok(code.length > 1000, 'the page carries its script inline');

  stubPage();

  // A module, so it runs the way a browser runs it — including `let` being
  // in its temporal dead zone until its line is reached.
  const dir = mkdtempSync(join(tmpdir(), 'verum-panel-'));
  const file = join(dir, 'panel.mjs');
  writeFileSync(file, code);

  await assert.doesNotReject(() => import(pathToFileURL(file).href));
});
