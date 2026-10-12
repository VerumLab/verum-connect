/** Turn the built inject bundle into a bookmarklet, and a page to install it.
 *
 *  A bookmarklet is a bookmark whose address is the program itself, so this is
 *  the whole delivery mechanism: no store, no review, no registration, and
 *  nothing installed. The cost is that the program has to survive being a URL —
 *  hence the minified IIFE this wraps, and the encoding below.
 *
 *  WHERE THE POPUP ADDRESS COMES FROM
 *  The injected code runs inside a dapp's page, where nothing points back at us,
 *  so it has to carry the popup's address. But that address is not decided here:
 *  the bundle ships with a token, and the install page swaps in its own location
 *  as the user drags the link. Publish this folder anywhere and the bookmarklet
 *  made from it opens the popup from the same place — the gateway the user
 *  chose, their own IPFS node, or a dev server on whatever port it landed on.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCsp } from '../packages/dapp/bookmarklet/csp.mjs';
import { POPUP_URL_TOKEN } from '../packages/dapp/bookmarklet/popup-token.mjs';
// The same agreement the hub publishes, from the same file — two copies would
// eventually be two agreements.
import { TERMS_LINES } from '../packages/shared/terms.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages/dapp/bookmarklet/dist');

const bundle = readFileSync(join(dist, 'inject.js'), 'utf8').trim();

if (!bundle.includes(POPUP_URL_TOKEN)) {
  throw new Error(`build-bookmarklet: the token ${POPUP_URL_TOKEN} is not in the bundle`);
}

/** Wrapped in a void expression: a `javascript:` URL that evaluates to a string
 *  replaces the document with it, so the last statement must yield nothing. */
const source = (code) => `javascript:void((function(){${code}})())`;

/** Percent-encoded, because a bookmark URL is parsed as one. Only the
 *  characters that actually break it — Firefox and Safari both mangle a raw %,
 *  and a # would truncate everything after it. */
const encode = (text) =>
  text.replace(/%/g, '%25').replace(/#/g, '%23').replace(/"/g, '%22').replace(/\n/g, '%0A');

/** A copy with the token resolved, for pinning a build at one address — a
 *  published bookmarklet in a README, or a test. The install page ignores it. */
const pinned = process.env.VERUM_POPUP_URL ?? POPUP_URL_TOKEN;

writeFileSync(join(dist, 'bookmarklet.txt'), encode(source(bundle.replaceAll(POPUP_URL_TOKEN, pinned))));

/** Embedded as a JSON string with `<` escaped, so no `</script>` inside the
 *  minified bundle can end the element early. */
const embedded = JSON.stringify(bundle).replace(/</g, '\\u003c');

const installPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Verum Connect — Bookmarklet</title>
    <style>
      /* The hub's palette, because the two are halves of one thing and are
         often open side by side while pairing. */
      :root {
        color-scheme: light dark;
        --bg: #f6f6f4; --surface: #ffffff; --border: #dedbd4;
        --text: #1a1917; --muted: #6b6862; --accent: #b5451b;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #16150f; --surface: #1f1e18; --border: #35332b;
          --text: #f2f0e9; --muted: #9c988d; --accent: #e8703f;
        }
      }
      * { box-sizing: border-box; }
      body {
        /* A column because the agreement is a second child: as a row it sat
           beside the card and pushed it off centre. The card keeps centring
           itself through its own auto margins. */
        margin: 0; min-height: 100dvh; display: flex; flex-direction: column;
        background: var(--bg); color: var(--text);
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      /* Centred by its own auto margins, which collapse to zero once the cards
         are taller than the viewport — so a short page is centred and a long
         one simply scrolls. Padding is symmetric because auto margins centre
         the padding box, and 72px also clears the fixed header. */
      main { width: 100%; max-width: 460px; margin: auto; padding: 72px 16px; }

      /* Pinned to the viewport rather than to the centred column, so the title
         sits in the top-left corner as it does on the hub. Fixed positioning
         ignores body padding, hence the safe-area inset here. */
      .page-head {
        position: fixed; top: 0; left: 0; right: 0; z-index: 40;
        padding: 14px 16px; padding-top: calc(14px + env(safe-area-inset-top));
      }
      header h1 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
      header h1 span { color: var(--accent); }
      header h1 em { font-style: normal; font-weight: 500; color: var(--muted); }
      header h1 em::before { content: " · "; }

      .card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: 14px; padding: 18px; margin-bottom: 14px;
      }
      /* Centred with the button under it: left-aligned over a centred control,
         the two read as unrelated. */
      h2 { font-size: 19px; margin: 0 0 18px; letter-spacing: -0.01em; text-align: center; }
      /* The two halves of one card: what to do once, and what to do every time
         after. */
      h3 { font-size: 15px; font-weight: 650; margin: 20px 0 8px; }
      h2 + h3 { margin-top: 0; }
      p { margin: 0 0 12px; }
      p:last-child { margin-bottom: 0; }
      .muted { color: var(--muted); font-size: 13px; }

      .drag {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 11px 16px; border: 1px solid var(--border); border-radius: 10px;
        background: var(--bg); font-weight: 650; text-decoration: none;
        cursor: grab; color: inherit;
      }
      /* Inline, not a data URI: a bookmark's own icon is the browser's to
         choose and cannot be set from here, so this one is for recognising the
         thing before it is dragged. */
      .drag svg { width: 18px; height: 18px; flex: none; }
      .row {
        display: flex; align-items: center; justify-content: center;
        gap: 10px; flex-wrap: wrap; margin: 0 0 20px;
      }
      #note { margin: -8px 0 20px; text-align: center; }
      #note:empty { display: none; }
      .copy {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        font: inherit; font-size: 14px; font-weight: 550; padding: 11px 14px;
        border: 1px solid var(--border); border-radius: 10px;
        background: var(--bg); color: inherit; cursor: pointer;
      }
      .verum-mark { width: 17px; height: 17px; flex: none; }
      ol { padding-left: 18px; margin: 0; }
      li { margin-bottom: 8px; }
      li:last-child { margin-bottom: 0; }
      label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
      input {
        width: 100%; padding: 9px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: inherit; font-family: var(--mono); font-size: 12px;
      }
      /* One set of instructions, chosen by what the device can actually do:
         a fine pointer that hovers is a mouse, and dragging a link onto a
         bookmarks bar is only possible there. Tapping the link on a touch
         screen would run the bookmarklet on this page instead of saving it,
         so it is hidden rather than left to disappoint. */
      .demo {
        position: relative; height: 118px; margin-top: 14px; overflow: hidden;
        border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
      }
      .demo-bar {
        display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px;
        border-bottom: 1px dashed var(--border);
      }
      .demo-chip {
        font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 6px;
        background: var(--surface); border: 1px solid var(--border);
        opacity: 0; animation: demo-land 5s ease-in-out infinite;
      }
      .demo-pill {
        position: absolute; left: 14px; top: 58px;
        font-size: 11px; font-weight: 650; padding: 6px 11px; border-radius: 8px;
        background: var(--surface); border: 1px solid var(--border);
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        animation: demo-drag 5s ease-in-out infinite;
      }
      .demo-hand {
        position: absolute; left: 109px; top: 82px; width: 25px; height: 32px;
        filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35));
        animation: demo-drag 5s ease-in-out infinite;
      }
      @keyframes demo-drag {
        0%, 12% { transform: translate(0, 0); opacity: 1; }
        44%, 50% { transform: translate(-2px, -44px); opacity: 1; }
        56% { transform: translate(-2px, -44px); opacity: 0; }
        57%, 88% { transform: translate(0, 0); opacity: 0; }
        94%, 100% { transform: translate(0, 0); opacity: 1; }
      }
      @keyframes demo-land {
        0%, 52% { opacity: 0; }
        58%, 88% { opacity: 1; }
        94%, 100% { opacity: 0; }
      }
      /* Someone who has asked for less motion is shown the outcome instead of
         the journey: the bookmark already on the bar. */
      @media (prefers-reduced-motion: reduce) {
        .demo-pill, .demo-hand { animation: none; opacity: 0; }
        .demo-chip { animation: none; opacity: 1; }
      }
      kbd {
        font-family: inherit; font-size: 12.5px; font-weight: 600;
        padding: 2px 7px; border: 1px solid var(--border); border-radius: 6px;
        background: var(--bg); white-space: nowrap;
      }
      .touch #install-drag, .touch .drag, .touch .demo { display: none; }
      .mobile-demo { display: none; }
      .mobile-screen {
        width: 100%; display: flex; flex-direction: column; justify-content: center;
        gap: 5px; padding: 8px; overflow: hidden; border: 1px solid var(--border);
        border-radius: 7px; background: var(--bg); font-size: 9px;
      }
      .mobile-demo { display: none; margin-top: 8px; }
      .mobile-screen-field { display: flex; align-items: center; gap: 5px; }
      .mobile-screen-label { width: 64px; flex: none; color: var(--muted); }
      .mobile-screen-value {
        min-width: 0; flex: 1; padding: 4px 5px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px;
      }
      .mobile-screen-top { display: flex; align-items: center; gap: 4px; color: var(--muted); }
      .mobile-screen-line { height: 4px; border-radius: 3px; background: var(--border); }
      .mobile-screen-action {
        align-self: flex-end; padding: 3px 6px; border: 1px solid var(--border);
        border-radius: 5px; color: var(--accent); font-size: 9px; font-weight: 650;
      }
      .mobile-url { font: 8px/1.25 var(--mono); }
      .touch li > .mobile-demo { display: block; }
      .pointer .verum-mark { display: none; }
      .pointer #install-copy { display: none; }
      /* Wider than the card, as the hub's is: the agreement is one sentence and
         reads as one row, which it cannot do if it is boxed to the card. */
      footer { width: 100%; max-width: 600px; box-sizing: border-box; margin: 0 auto 24px; padding: 0 16px; }
      footer p { margin: 0; text-align: center; font-size: 11px; line-height: 1.6; color: var(--muted); text-wrap: pretty; }
      #terms-link {
        font: inherit; padding: 0; border: 0; background: none; cursor: pointer;
        color: inherit; text-decoration: underline;
      }
      .sheet-backdrop {
        position: fixed; inset: 0; z-index: 50; display: flex; align-items: center;
        justify-content: center; padding: 16px; background: rgba(0, 0, 0, 0.45);
      }
      .sheet {
        width: 100%; max-width: 460px; max-height: calc(100dvh - 100px); overflow-y: auto;
        background: var(--surface); border: 1px solid var(--border);
        border-radius: 14px; padding: 18px;
      }
      .sheet-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .sheet-head h3 { font-size: 15px; margin: 0 0 4px; }
      .sheet-close { font: inherit; border: 0; background: none; cursor: pointer; color: var(--muted); }
      .terms-body { font-size: 13px; line-height: 1.55; color: var(--muted); }
      .warn { color: #c2410c; }
      @media (prefers-color-scheme: dark) { .warn { color: #f08a5d; } }
    </style>
  </head>
  <body>
    <div class="page-head">
      <header>
        <h1>Verum <span>Connect</span><em>Bookmarklet</em></h1>
      </header>
    </div>

    <main>
      <div class="card">
        <h2>A wallet for a dapp that never asked</h2>

        <div class="row">
          <a class="drag" id="drag" href="#"><svg viewBox="0 0 140 104" aria-hidden="true"><path d="M69.9988 45.206L140 0.454L69.9988 103.096L0 0.454L69.9988 45.206Z" fill="#8cc2ff"/><path d="M69.9988 45.206L140 0.454L69.9988 103.096Z" fill="#3d7fd1"/></svg><span>Verum Connect</span></a>
          <button class="copy" id="copy" type="button"><svg class="verum-mark" viewBox="0 0 140 104" aria-hidden="true"><path d="M69.9988 45.206L140 0.454L69.9988 103.096L0 0.454L69.9988 45.206Z" fill="#8cc2ff"/><path d="M69.9988 45.206L140 0.454L69.9988 103.096Z" fill="#3d7fd1"/></svg><span>Copy</span></button>
        </div>
        <p class="muted" id="note"></p>

        <h3>Install</h3>
        <ol class="muted" id="install-drag">
          <li>If the bar is hidden, press <kbd id="shortcut"></kbd> to show it.</li>
          <li>Drag the <strong>Verum Connect</strong> button to the bar.</li>
        </ol>

        <!-- Drawn rather than filmed: the bookmarks bar is the Favourites bar
             in Safari and the Bookmarks toolbar in Firefox, in a different
             place with a different drop indicator, so a recording of one
             browser is wrong for everyone using another. -->
        <div class="demo" id="demo" aria-hidden="true">
          <div class="demo-bar"><span class="demo-chip">Verum Connect</span></div>
          <div class="demo-pill">Verum Connect</div>
          <svg class="demo-hand" viewBox="0 0 28 36" aria-hidden="true">
            <path d="M12 2.5c-1.6 0-2.7 1.2-2.7 2.8v12.2l-2-2a2.6 2.6 0 0 0-3.8 3.5l6.1 8a6.2 6.2 0 0 0 5 2.5h3a6 6 0 0 0 6-6v-7.2a2.4 2.4 0 0 0-4.2-1.6 2.4 2.4 0 0 0-4.2-1.1V5.3c0-1.6-1.2-2.8-3.2-2.8Z" fill="#fff" stroke="#25231f" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M17 18v-3" fill="none" stroke="#777" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </div>

        <div id="install-copy">
          <ol class="muted">
            <li>
              Press <strong>Copy</strong> above.
              <div class="mobile-demo" aria-hidden="true">
                <div class="mobile-screen">
                  <div class="mobile-screen-top">This page</div>
                  <div class="mobile-screen-action" style="align-self:stretch">Copy ✓</div>
                </div>
              </div>
            </li>
            <li>
              <span id="how-add"></span>
              <div class="mobile-demo" aria-hidden="true">
                <div class="mobile-screen">
                  <div class="mobile-screen-top">Save bookmark</div>
                  <div class="mobile-screen-action" style="align-self:stretch">☆ &nbsp; Bookmark this page</div>
                </div>
              </div>
            </li>
            <li>
              <span id="how-edit"></span>
              <div class="mobile-demo" aria-hidden="true">
                <div class="mobile-screen">
                  <div class="mobile-screen-top">Edit bookmark</div>
                  <div class="mobile-screen-field"><span class="mobile-screen-label">Name</span><span class="mobile-screen-value">verum-connection</span></div>
                  <div class="mobile-screen-field"><span class="mobile-screen-label">Address / URL</span><span class="mobile-screen-value mobile-url">Paste here</span></div>
                </div>
              </div>
            </li>
          </ol>
        </div>

        <h3>Usage</h3>
        <ol class="muted">
          <li>Open a dapp in this browser.</li>
          <li>Click the bookmark to connect using Verum Connect.</li>
          <li>Follow the Verum Connect flow.</li>
          <li>Sign using any device.</li>
        </ol>
      </div>

    </main>

    <footer>
      <p>
        Provided as is, without warranty. Using this accepts the
        <button type="button" id="terms-link">user agreement</button>.
      </p>
    </footer>

    <script>
      var BUNDLE = ${embedded};
      var TOKEN = ${JSON.stringify(POPUP_URL_TOKEN)};

      document.body.className =
        window.matchMedia('(hover: hover) and (pointer: fine)').matches ? 'pointer' : 'touch';

      document.getElementById('how-add').innerHTML =
        'Bookmark this page as <strong>verum-connection</strong>.';
      document.getElementById('how-edit').innerHTML =
        'Open Bookmarks, edit the <strong>verum-connection</strong> bookmark, and paste the code into the <strong>address/URL</strong> field.';

      /* Every major browser toggles the bookmarks bar with the same chord, on
         the modifier the platform uses for everything else. */
      /* The agreement, in the page rather than behind a link to somewhere:
         this file is published as an immutable artifact, so the text someone
         reads here is the one this build shipped under. */
      var TERMS = ${JSON.stringify(TERMS_LINES)};
      var sheet = null;

      function closeTerms() {
        if (sheet) { sheet.remove(); sheet = null; }
      }

      document.getElementById('terms-link').onclick = function () {
        if (sheet) return;
        sheet = document.createElement('div');
        sheet.className = 'sheet-backdrop';
        sheet.onclick = function (event) { if (event.target === sheet) closeTerms(); };

        var box = document.createElement('div');
        box.className = 'sheet';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', 'User agreement');

        var head = document.createElement('div');
        head.className = 'sheet-head';
        var title = document.createElement('h3');
        title.textContent = 'User agreement';
        var shut = document.createElement('button');
        shut.className = 'sheet-close';
        shut.type = 'button';
        shut.textContent = '\u2715';
        shut.setAttribute('aria-label', 'Close');
        shut.onclick = closeTerms;
        head.appendChild(title);
        head.appendChild(shut);
        box.appendChild(head);

        TERMS.forEach(function (line) {
          var p = document.createElement('p');
          p.className = 'terms-body';
          p.textContent = line;
          box.appendChild(p);
        });

        sheet.appendChild(box);
        document.body.appendChild(sheet);
      };

      window.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeTerms();
      });

      var mac = /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
      document.getElementById('shortcut').textContent = mac ? '\u2318 \u21E7 B' : 'Ctrl + Shift + B';

      /* One address: the panel beside this page, wherever this page came from.
         Publishing the folder to a gateway therefore needs no rebuild — whoever
         serves the install page serves the panel.

         Deliberately not a list of other gateways derived from the CID. Those
         are guesses at hosts the user never chose, they leak the same usage to
         a party they did not pick, and each dead one costs an eight-second
         timeout before the bookmarklet offers its own address field. One
         address fails fast and hands the choice back. */
      var links = [{ bundle: BUNDLE, drag: 'drag', copy: 'copy', note: 'note' }];

      function bookmarkletHref(link) {
        var address = new URL('popup.html', location.href).href;
        var code = 'javascript:void((function(){' + link.bundle.split(TOKEN).join(address) + '})())';
        return code
          .replace(/%/g, '%25')
          .replace(/#/g, '%23')
          .replace(/"/g, '%22')
          .replace(/\\n/g, '%0A');
      }

      function build() {
        var local = location.protocol === 'file:';

        links.forEach(function (link) {
          var drag = document.getElementById(link.drag);
          var note = document.getElementById(link.note);
          drag.href = bookmarkletHref(link);

          /* Only the case that is actually wrong. How large the bookmark is
             and how many addresses it carries are true and uninteresting; a
             bookmark built from a file:// page silently points at a file
             nobody else has, and that is worth interrupting for. */
          note.textContent = local
            ? 'Opened from a file, so the bookmark would point at a file nobody else has — serve this folder over http instead.'
            : '';
          note.className = local ? 'warn' : 'muted';
        });
      }

      build();

      /* The same program the link carries, as text — the only way to install it
         on a phone, where a bookmarks bar does not exist. execCommand as well as
         the clipboard API: the latter needs a secure context, and this page is
         often served over plain http on a LAN address while testing. */
      links.forEach(function (link) {
        var copy = document.getElementById(link.copy);
        copy.onclick = function () {
          // A gateway URL may have changed since page load; bind the copied
          // bookmark to the popup beside the page as it is right now.
          document.getElementById(link.drag).href = bookmarkletHref(link);
          var text = document.getElementById(link.drag).href;
          var label = copy.querySelector('span') || copy;
          var done = function () {
            label.textContent = 'Copied';
            setTimeout(function () { label.textContent = 'Copy'; }, 1600);
          };
          var byHand = function () {
            var box = document.createElement('textarea');
            box.value = text;
            box.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(box);
            box.select();
            box.setSelectionRange(0, text.length);
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            box.remove();
            if (ok) done();
            return ok;
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, byHand);
          } else {
            byHand();
          }
        };
      });
    </script>
  </body>
</html>
`;

// Only its own script may run, and it needs no network at all: it builds the bookmark
// in place. A script a host inserts is refused.
const shipped = withCsp(installPage, [
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
]);
writeFileSync(join(dist, 'install.html'), shipped);
writeFileSync(join(dist, 'index.html'), shipped);

console.log(`bookmarklet: ${encode(source(bundle)).length} bytes`);
console.log('  packages/dapp/bookmarklet/dist/index.html     the install page, also as install.html');
console.log(`  packages/dapp/bookmarklet/dist/bookmarklet.txt pinned at ${pinned}`);
