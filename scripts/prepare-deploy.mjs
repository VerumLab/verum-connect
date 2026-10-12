/** Stage the hub or demo for upload, and verify what a gateway serves back.
 *
 *    node scripts/prepare-deploy.mjs hub          build + stage the hub
 *    node scripts/prepare-deploy.mjs demo            build + stage the demo dapp
 *    node scripts/verify-deploy.mjs <cid | tx> --no-build    check what the gateways serve
 *
 *  Deploy the hub FIRST. The demo needs the hub's CID ot TX baked in, since a dapp
 *  cannot guess where the hub lives. IPFS example:
 *
 *    VITE_HUB_URL=https://<hub-cid>.ipfs.dweb.link/ \
 *      node scripts/prepare-deploy.mjs demo
 *
 *  Staging produces a DIRECTORY containing index.html rather than a bare file.
 *  A file CID carries no filename, so gateways fall back to sniffing and often
 *  answer application/octet-stream — which downloads instead of rendering. A
 *  directory gives the gateway "index.html" to infer text/html from.
 *
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, cpSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  hub: {
    workspace: '@verumlab/connect-hub',
    dir: 'packages/wallet/hub',
    label: 'hub',
  },
  demo: {
    workspace: '@verumlab/standalone-demo',
    dir: 'packages/dapp/sdk/examples/standalone-demo',
    label: 'demo dapp',
  },
  /** The bookmarklet, which unlike the others is a folder and not a page: the
   *  install page hands out the bookmark, and the panel beside it is what a
   *  dapp frames. It has to be published to be usable at all from a phone — an
   *  https dapp will not frame an http panel, so a panel on a dev server can
   *  only ever open in a separate tab there. */
  bookmarklet: {
    workspace: '@verumlab/connect-bookmarklet',
    dir: 'packages/dapp/bookmarklet',
    label: 'bookmarklet',
    folder: true,
  },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

stage();

/** Build the target named on the command line and copy it into its deploy folder. */
function stage() {
  const name = process.argv[2];
  const target = TARGETS[name];
  if (!target) {
    console.error(`Usage: node scripts/prepare-deploy.mjs <${Object.keys(TARGETS).join('|')}>`);
    process.exit(1);
  }

  const stageDir = join(root, target.dir, 'deploy');
  const staged = join(stageDir, 'index.html');

  if (name === 'demo' && !process.env.VITE_HUB_CID && !process.env.VITE_HUB_URL) {
    console.error(
      'Refusing to publish the demo against its source default hub.\n\n' +
        'The default in main.ts exists so `npm run dev` works out of the box; it\n' +
        'goes stale the moment the hub is rebuilt. A published dapp must pin the\n' +
        'hub deliberately. Deploy the hub first, then:\n\n' +
        '  VITE_HUB_CID=<hub-cid> node scripts/prepare-deploy.mjs demo\n\n' +
        'Prefer the CID: it pins WHAT the hub is and leaves WHERE to the user, so a\n' +
        'gateway going away costs them a dropdown, not a rebuild of this dapp.\n' +
        'VITE_HUB_URL still works and hard-codes one gateway for everyone.\n',
    );
    process.exit(1);
  }

  console.log(`Building the ${target.label}…`);
  execFileSync('npm', ['run', 'build', '-w', target.workspace], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  if (target.folder) {
    // Everything, because the install page and the panel are published
    // together: the bookmark is built from wherever the install page is served,
    // and it points at popup.html beside it.
    cpSync(join(root, target.dir, 'dist'), stageDir, { recursive: true });
  } else {
    copyFileSync(join(root, target.dir, 'dist/index.html'), staged);
  }

  const digest = sha256(readFileSync(staged));
  const stagedRel = `${target.dir}/deploy`;

  console.log(`
Staged for upload — ${target.label}
────────────────────────────────────
  folder    ${stagedRel}/
  file      index.html
  size      ${(statSync(staged).size / 1024).toFixed(1)} kB
  sha256    ${digest}${
    name === 'demo'
      ? `\n  hub       ${process.env.VITE_HUB_CID ?? process.env.VITE_HUB_URL}${
          process.env.VITE_HUB_CID ? ' (CID — gateway is the user’s choice)' : ' (fixed gateway)'
        }`
      : ''
  }

Upload the FOLDER (not the file) to IPFS (Pinata: "Add files" → "Folder") and/or Arweave.

Then confirm the gateways serve exactly these bytes:

  node scripts/verify-deploy.mjs <cid or tx> --no-build
${
  name === 'hub'
    ? `
Then point the demo at this hub — BOTH places, or you will keep testing the old
hub without noticing:

  1. published demo:
       VITE_HUB_CID=<cid> node scripts/prepare-deploy.mjs demo

  2. dev server (npm run dev:demo), which has no build-time env:
       DEFAULT_HUB_CID in packages/dapp/sdk/examples/standalone-demo/src/main.ts
`
    : ''
}
GATEWAY CHOICE MATTERS. dweb.link and ipfs.io 302 real browser navigations to
inbrowser.link, which verifies CIDs in a service worker — and wallet in-app
browsers (WKWebView / Android WebView) have no service workers, so the hub dies
there with a redirect loop. Use a gateway that serves navigations directly:

  https://eu.orbitor.dev/ipfs/<cid>/        (also ipfs. / apac. / latam.)
  http://localhost:8080/ipfs/<cid>/         (your own node — verifies for real)

Both are PATH gateways, so every CID they serve shares one origin — wallet
permissions and stored sessions are shared with it. A subdomain gateway would
scope them per build, but none of the surviving ones offer it for arbitrary CIDs.
`);
}
