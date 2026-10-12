#!/usr/bin/env node
/** Check what is deployed against the source it says it was built from.
 *
 *  Builds the hub and the bookmarklet from source and compares the result with
 *  whatever is pointed at:
 *
 *    node scripts/verify-deploy.mjs <url>               a hub page or a bookmarklet folder
 *    node scripts/verify-deploy.mjs <cid | arweave-tx>  on the gateways users are sent to
 *    node scripts/verify-deploy.mjs --bookmark <text>   a bookmark (or @file, or - for stdin)
 *    node scripts/verify-deploy.mjs --browser           every Verum bookmark in Chrome and Safari
 *
 *  Source, by default this checkout; otherwise:
 *
 *    --source owner/repo | a github.com link | a directory | a .tar.gz
 *    --ref <tag | commit | branch>               with a GitHub source
 *
 *  Building runs the source's own build scripts, so only point --source at code
 *  you already trust. Dependencies are installed from its lockfile with install
 *  scripts off.
 *
 *  --no-build   compare against what is already built in the checkout.
 *
 *  A gateway is a third party and a browser does not check its bytes against the
 *  CID, so a match here is the check the browser is not doing. Exit status is 0
 *  only if everything asked about matched.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--source', '--ref', '--bookmark', '--gateway']);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const targets = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''));

if (argv.length === 0 || flag('--help')) {
  console.log(
    'Usage: node scripts/verify-deploy.mjs <url | cid | arweave-tx>\n' +
      '       node scripts/verify-deploy.mjs --bookmark <text | @file | ->\n' +
      '       node scripts/verify-deploy.mjs --browser\n' +
      'Options: --source <owner/repo | github url | dir | .tar.gz>  --ref <ref>  --no-build\n' +
      '         --gateway <https://host>   (repeatable, for a cid or tx)',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

// ------------------------------------------------------------------- source

/** In build order, with where each lives. */
const WORKSPACES = {
  '@verumlab/connect-protocol': 'packages/shared/protocol',
  '@verumlab/connect-dapp': 'packages/dapp/shared/core',
  '@verumlab/connect-wallet': 'packages/wallet/sdk',
  '@verumlab/connect-ui': 'packages/dapp/shared/ui',
  '@verumlab/connect-hub': 'packages/wallet/hub',
  '@verumlab/connect-bookmarklet': 'packages/dapp/bookmarklet',
};

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

/** owner/repo[@ref], or a github.com link to the repo, a tag, a commit or a tree. */
function parseGithub(input, refOption) {
  let owner, repo, ref;
  const short = input.match(/^([\w.-]+)\/([\w.-]+?)(?:@(.+))?$/);
  if (short && !input.includes('://')) [, owner, repo, ref] = short;
  else {
    const url = new URL(input);
    if (url.hostname !== 'github.com') throw new Error(`not a GitHub source: ${input}`);
    const [o, r, kind, ...rest] = url.pathname.split('/').filter(Boolean);
    owner = o;
    repo = r?.replace(/\.git$/, '');
    if (['tree', 'commit'].includes(kind)) ref = rest.join('/');
    if (kind === 'releases' && rest[0] === 'tag') ref = rest.slice(1).join('/');
  }
  if (!owner || !repo) throw new Error(`cannot read a repository from: ${input}`);
  return { owner, repo, ref: refOption ?? ref ?? 'HEAD' };
}

async function download({ owner, repo, ref }, into) {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, { headers });
  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} for ${owner}/${repo}@${ref}` +
        (response.status === 404 && !process.env.GITHUB_TOKEN ? ' (a private repo needs GITHUB_TOKEN)' : ''),
    );
  }
  const file = join(into, 'source.tar.gz');
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function prepareSource() {
  const source = option('--source');
  let dir = here;
  let fresh = false;

  if (source && existsSync(source) && statSync(source).isDirectory()) {
    dir = resolve(source);
  } else if (source) {
    dir = mkdtempSync(join(tmpdir(), 'verum-verify-'));
    let archive = source;
    if (!existsSync(source)) {
      const gh = parseGithub(source, option('--ref'));
      console.log(`Source: ${gh.owner}/${gh.repo}@${gh.ref}`);
      archive = await download(gh, dir);
    }
    const unpacked = join(dir, 'src');
    mkdirSync(unpacked);
    run('tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1'], dir);
    dir = unpacked;
    fresh = true;
  } else {
    console.log('Source: this checkout');
  }

  if (flag('--no-build')) return dir;

  if (fresh || !existsSync(join(dir, 'node_modules'))) {
    // Only what the hub and the bookmarklet need. The examples pull in a few
    // hundred packages that cannot affect either.
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...Object.keys(WORKSPACES).flatMap((w) => ['-w', w]), '--include-workspace-root'], dir);
  }
  // Whatever was built before is not evidence. tsc -b skips what its saved state
  // calls up to date, so a stale dist would be compared as if it were fresh.
  for (const where of Object.values(WORKSPACES)) {
    rmSync(join(dir, where, 'dist'), { recursive: true, force: true });
    for (const f of readdirSync(join(dir, where))) if (f.endsWith('.tsbuildinfo')) rmSync(join(dir, where, f));
  }
  for (const workspace of Object.keys(WORKSPACES)) run('npm', ['run', 'build', '-w', workspace], dir);
  return dir;
}

// ----------------------------------------------------------------- comparing

const sameBytes = (a, b) => a.length === b.length && a.equals(b);

/** Whether what was served is the file. A gateway or its CDN will add a beacon to
 *  an HTML page, at the end or just before </body>. Only that is tolerated, and only
 *  if it is nothing but <script> elements, which a hash CSP then refuses to run; the
 *  insertion is shown. Anything else served is a different file. */
const ONLY_SCRIPTS = /^\s*(<script\b[^>]*>[\s\S]*?<\/script>\s*)+$/i;

function compare(served, expected) {
  if (sameBytes(served, expected)) return { ok: true, note: 'byte-identical' };
  if (served.length > expected.length) {
    const extra = served.length - expected.length;
    const body = expected.lastIndexOf(Buffer.from('</body>'));
    // Where a host may add something: the end of the file, or just before </body>.
    for (const at of [expected.length, ...(body >= 0 ? [body] : [])]) {
      const before = expected.subarray(0, at);
      const after = expected.subarray(at);
      if (!served.subarray(0, at).equals(before) || !served.subarray(at + extra).equals(after)) continue;
      const added = served.subarray(at, at + extra).toString('utf8');
      if (!ONLY_SCRIPTS.test(added)) break;
      const text = added.replace(/\s+/g, ' ').trim();
      return { ok: true, note: `identical, with ${extra} bytes added by the host: ${text.slice(0, 110)}` };
    }
  }
  return { ok: false, note: `DIFFERENT (${served.length} bytes served, ${expected.length} built)` };
}

async function get(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Browser-navigation headers. Without Sec-Fetch-*, gateways answer as if to a
 *  programmatic client and skip the redirect a real browser would get, so a check
 *  would pass on a page that is unreachable in practice. */
const NAV_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
};

/** A page as a browser opening it gets it: the bytes, where it ended up, and its type. */
async function navigate(url) {
  const response = await fetch(url, { redirect: 'follow', headers: NAV_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    landed: response.url,
    type: response.headers.get('content-type'),
  };
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const scriptHashes = (html) =>
  [...html.matchAll(INLINE_SCRIPT)]
    .map((m) => m[1] ?? '')
    .filter((text) => text.trim())
    .map((text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`);

/** The scripts a gateway served, against the hash CSP the page declares: an added
 *  script is blocked and harmless, an altered one of ours stops the page running. */
function auditScripts(html) {
  const csp = html.match(/content="(default-src[^"]*)"/)?.[1];
  if (!csp) return { ok: false, note: 'no CSP in the served page, so an injected script would run' };
  const allowed = new Set([...csp.matchAll(/sha256-[A-Za-z0-9+/=]+/g)].map((m) => m[0]));
  if (allowed.size === 0) return { ok: false, note: 'the CSP allows inline scripts, so an injected script would run' };
  const served = scriptHashes(html);
  if ([...allowed].some((h) => !served.includes(h))) {
    return { ok: false, note: 'one of its own scripts was altered, so the CSP blocks it and the page will not run here' };
  }
  const added = served.filter((h) => !allowed.has(h)).length;
  return { ok: true, note: added > 0 ? `${added} script(s) added by the host, blocked by the CSP` : 'no scripts added' };
}

let failures = 0;
let checks = 0;
const line = (ok, text) => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${text}`);
};

// ------------------------------------------------------------------- targets

/** A CID or a transaction, on the gateways the source itself sends a wallet's
 *  browser to (its protocol package), plus any given with --gateway. The
 *  service-worker gateway of the desktop link is left out: it answers with a loader
 *  page, not the build. */
function expand(target, protocol) {
  const extra = argv.flatMap((a, i) => (a === '--gateway' ? [argv[i + 1].replace(/\/+$/, '')] : []));
  if (/^(baf[a-z2-7]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(target)) {
    const listed = (protocol.WEBVIEW_SAFE_GATEWAYS ?? []).map((t) => protocol.resolveGateway(t, target));
    return [...extra.map((g) => `${g}/ipfs/${target}/`), ...listed];
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(target)) {
    const listed = (protocol.ARWEAVE_GATEWAYS ?? []).map((t) => protocol.resolveArweaveGateway(t, target));
    return [...extra.map((g) => `${g}/${target}/`), ...listed];
  }
  return [target];
}

/** The IPFS CID this build would have, when kubo is installed. A CID is a hash
 *  of the content, so if it matches, no gateway has to be believed. */
function localCid(files) {
  try {
    const staged = mkdtempSync(join(tmpdir(), 'verum-cid-'));
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(staged, name), bytes);
    return execFileSync('ipfs', ['add', '-r', '--only-hash', '--cid-version', '1', '-Q', staged], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const CID_IN = /(baf[a-z2-7]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/;

async function checkUrl(url, built) {
  console.log(`\n${url}`);
  const base = new URL(/\.[a-z0-9]+$/i.test(new URL(url).pathname) ? './' : url, url);
  if (!base.pathname.endsWith('/')) base.pathname += '/';

  let page;
  try {
    page = await navigate(base);
  } catch (err) {
    return line(false, `could not fetch it (${err.message})`);
  }
  if (/inbrowser\.link/.test(page.landed)) {
    return line(false, 'a browser is redirected to a service-worker gateway, which a wallet browser cannot run');
  }
  // No type at all is sniffed as HTML by a browser; a different one is not.
  if (page.type && !page.type.includes('text/html')) {
    line(false, `served as "${page.type}", so a browser downloads it instead of showing it`);
  }
  const root = page.body;

  const asHub = compare(root, built.hub['index.html']);
  const asBookmarklet = compare(root, built.bookmarklet['index.html']);
  const asDemo = built.demo ? compare(root, built.demo['index.html']) : { ok: false };

  if (asHub.ok) {
    line(true, `the hub — ${asHub.note}`);
    const audit = auditScripts(root.toString('utf8'));
    line(audit.ok, `scripts — ${audit.note}`);
  } else if (asDemo.ok) {
    line(true, `the demo dapp — ${asDemo.note}`);
  } else if (asBookmarklet.ok) {
    line(true, `the bookmarklet install page — ${asBookmarklet.note}`);
    const installAudit = auditScripts(root.toString('utf8'));
    line(installAudit.ok, `scripts — ${installAudit.note}`);
    for (const [file, expected] of Object.entries(built.bookmarklet)) {
      if (file === 'index.html') continue;
      try {
        const served = file.endsWith('.html') ? (await navigate(new URL(file, base))).body : await get(new URL(file, base));
        const result = compare(served, expected);
        line(result.ok, `${file} — ${result.note}`);
        // The panel runs on every click; what a host adds to it matters most.
        if (file === 'popup.html' && result.ok) {
          const audit = auditScripts(served.toString('utf8'));
          line(audit.ok, `${file} scripts — ${audit.note}`);
        }
      } catch (err) {
        line(false, `${file} — could not fetch it (${err.message})`);
      }
    }
  } else {
    return line(false, `matches neither the hub nor the bookmarklet built from this source — ${asHub.note}`);
  }

  const cid = url.match(CID_IN)?.[1];
  if (cid) {
    const files = asHub.ok ? { 'index.html': built.hub['index.html'] } : built.bookmarklet;
    const ours = localCid(files);
    if (ours === null) console.log('    (install kubo to also compare the CID itself)');
    else if (ours === cid) line(true, `the CID itself matches this build: ${cid}`);
    else console.log(`    the CID differs from this build's (${ours}); other import settings can do that`);
  }
}

// ---------------------------------------------------------------- bookmarks

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The four characters the install page encodes so a bookmark survives being
 *  parsed as a URL, undone in the reverse order. */
const decodeBookmark = (text) =>
  text.replace(/%0A/g, '\n').replace(/%22/g, '"').replace(/%23/g, '#').replace(/%25/g, '%');

async function checkBookmark(text, label, built, token) {
  console.log(`\nbookmark ${label}`);
  const actual = decodeBookmark(text.trim());
  const expected = `javascript:void((function(){${built.bookmarklet['inject.js'].toString('utf8').trim()}})())`;
  const parts = expected.split(token);

  // The one thing a bookmark is allowed to differ in: the address of the panel,
  // which the install page filled in. Every occurrence has to be the same one.
  const pattern = parts
    .map((part, i) => escapeRegex(part) + (i < parts.length - 1 ? (i === 0 ? '(\\S+?)' : '\\1') : ''))
    .join('');
  const match = actual.match(new RegExp(`^${pattern}$`, 's'));

  if (!match) {
    let at = 0;
    while (at < actual.length && actual[at] === expected[at]) at++;
    return line(false, `is not the bookmark this source builds (${actual.length} chars, ${expected.length} expected; first difference at ${at})`);
  }
  const address = match[1];
  line(true, 'the program in it is exactly the one built from this source');
  console.log(`    it loads its panel from ${address}`);

  try {
    const result = compare(await get(address), built.bookmarklet['popup.html']);
    line(result.ok, `the panel at that address — ${result.note}`);
  } catch (err) {
    line(false, `the panel at that address could not be fetched (${err.message})`);
  }
}

function walkChrome(node, found, trail = []) {
  if (node.type === 'url' && node.url?.startsWith('javascript:')) found.push({ name: node.name, url: node.url, where: trail.join(' / ') });
  for (const child of node.children ?? []) walkChrome(child, found, [...trail, node.name]);
}

function walkSafari(node, found, trail = []) {
  const url = node.URLString;
  if (url?.startsWith('javascript:')) found.push({ name: node.URIDictionary?.title ?? '', url, where: trail.join(' / ') });
  for (const child of node.Children ?? []) walkSafari(child, found, [...trail, node.Title ?? '']);
}

function browserBookmarks() {
  const found = [];
  const home = homedir();
  const chromeBases = [
    join(home, 'Library/Application Support/Google/Chrome'),
    join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
    join(home, 'Library/Application Support/Microsoft Edge'),
    join(home, '.config/google-chrome'),
    join(home, '.config/chromium'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data') : '',
  ];
  for (const base of chromeBases.filter((b) => b && existsSync(b))) {
    for (const profile of readdirSync(base)) {
      const file = join(base, profile, 'Bookmarks');
      if (!existsSync(file)) continue;
      const list = [];
      const roots = JSON.parse(readFileSync(file, 'utf8')).roots ?? {};
      for (const root of Object.values(roots)) if (root && typeof root === 'object') walkChrome(root, list);
      found.push(...list.map((b) => ({ ...b, browser: `${base.split('/').pop()} (${profile})` })));
    }
  }

  const plist = join(home, 'Library/Safari/Bookmarks.plist');
  if (existsSync(plist)) {
    const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
    if (converted.status === 0) {
      const list = [];
      walkSafari(JSON.parse(converted.stdout), list);
      found.push(...list.map((b) => ({ ...b, browser: 'Safari' })));
    } else {
      console.log('Could not read Safari bookmarks (the terminal needs Full Disk Access). Use --bookmark instead.');
    }
  }
  return found.filter((b) => b.url.includes('__verumConnect'));
}

// --------------------------------------------------------------------- main

const dir = await prepareSource();
const { POPUP_URL_TOKEN: token } = await import(
  pathToFileURL(join(dir, 'packages/dapp/bookmarklet/popup-token.mjs')).href
);

// The source's own gateway lists, so a check covers where that version sends users.
const protocol = await import(pathToFileURL(join(dir, 'packages/shared/protocol/dist/index.js')).href);

const read = (path) => readFileSync(join(dir, path));
const bookmarkletDist = join(dir, 'packages/dapp/bookmarklet/dist');
const demoPage = join(dir, 'packages/dapp/sdk/examples/standalone-demo/dist/index.html');
const built = {
  hub: { 'index.html': read('packages/wallet/hub/dist/index.html') },
  bookmarklet: Object.fromEntries(readdirSync(bookmarkletDist).map((f) => [f, readFileSync(join(bookmarkletDist, f))])),
  // Only when built: the default build does not include the demo.
  demo: existsSync(demoPage) ? { 'index.html': readFileSync(demoPage) } : null,
};

for (const target of targets) {
  for (const url of expand(target, protocol)) await checkUrl(url, built);
}

const bookmark = option('--bookmark');
if (bookmark !== undefined) {
  const text = bookmark === '-' ? readFileSync(0, 'utf8') : bookmark.startsWith('@') ? readFileSync(bookmark.slice(1), 'utf8') : bookmark;
  await checkBookmark(text, '(given)', built, token);
}

if (flag('--browser')) {
  const found = browserBookmarks();
  if (found.length === 0) console.log('\nNo Verum bookmark found in Chrome or Safari.');
  for (const b of found) await checkBookmark(b.url, `"${b.name}" in ${b.browser}`, built, token);
}

// Nothing checked is not a pass: --browser can find no bookmark at all.
if (checks === 0) console.log('\nNothing was checked.');
else console.log(failures === 0 ? '\n✓ Everything checked matches this source.' : `\n✗ ${failures} check(s) did not match.`);
process.exit(checks > 0 && failures === 0 ? 0 : 1);
