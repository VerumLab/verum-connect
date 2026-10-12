/** A hash-based Content-Security-Policy for a built page whose scripts are all inline.
 *
 *  Only the scripts in the page as built may run, so a host that inserts one of its
 *  own (a CDN in front of a gateway does) is refused. It does not stop a gateway that
 *  serves a different page altogether; checking the bytes against the CID does that.
 *
 *  Plain JavaScript so both a Vite config and a node script can use it.
 */

import { createHash } from 'node:crypto';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

/** `html` with a CSP allowing its own inline scripts by hash, plus `directives`.
 *  Placed straight after the charset declaration, so it covers everything below it. */
export function withCsp(html, directives) {
  const hashes = [...html.matchAll(INLINE_SCRIPT)]
    .map((match) => match[1] ?? '')
    .filter((body) => body.trim().length > 0)
    .map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  if (hashes.length === 0) throw new Error('csp: no inline scripts found, so the policy would block the page');

  const charset = /<meta charset="utf-8"\s*\/?>/i;
  if (!charset.test(html)) throw new Error('csp: no charset declaration to place the policy after');

  const policy = ["default-src 'none'", `script-src ${hashes.join(' ')}`, ...directives].join('; ');
  return html.replace(charset, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
}
