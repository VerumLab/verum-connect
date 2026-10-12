/**
 * Pairing URI: everything the hub needs is in the URL fragment,
 * `https://<host>/…/#v=1&p=<dapp-pubkey>&r=<relay>,<relay>`. A fragment is never
 * sent to the server, so the gateway learns only that someone fetched a CID, not
 * which dapp or session. Prefer a subdomain gateway (<cid>.ipfs.<host>) to a path
 * gateway: each CID then gets its own origin, so permissions and storage are per
 * build.
 */

import { isValidPublicKey } from './keys.js';
import { PROTOCOL_VERSION } from './envelope.js';
import { lowerRelayScheme } from './util.js';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
];

/**
 * How many relays a link may ask a wallet to connect to. The list is
 * attacker-controlled (it arrives in a scanned QR) and each entry costs the phone
 * a socket and one more party that sees both ends, so it is capped. 
 */
export const MAX_RELAYS = 8;

/**
 * Gateway templates; `{cid}` is substituted, so one string describes path
 * gateways, subdomain gateways and a local node. The dapp pins the CID and the
 * user picks the gateway: content addressing makes the gateway only transport,
 * and someone running their own node gets real verification. Subdomain form only
 * here, since this link is followed on a desktop and a path gateway shares one
 * origin across every CID it serves; see WEBVIEW_SAFE_GATEWAYS for those.
 */
export const DEFAULT_GATEWAYS = [
  // Verifies the CID in a service worker, so the browser checks the hash instead of
  // trusting the operator's bytes. Listed alone on purpose: the others either
  // redirect real browsers here anyway or failed to serve this build. The host
  // matters least on this link, as the fragment carries everything and a user whose
  // gateway is down can open any hub and paste it in.
  'https://{cid}.ipfs.inbrowser.link/',
];

/**
 * Gateways for the hub URL a phone opens, in path form: wallet WebViews have no
 * service worker, and the subdomain gateways we tried either redirect browsers to
 * one that needs it, refuse to render user HTML, or could not fetch this build.
 * The cost is a shared origin; see isOriginIsolated. The first entry is what a
 * phone gets when nobody chose otherwise; the order reflects measured reliability.
 */
export const WEBVIEW_SAFE_GATEWAYS = [
  'https://gateway.pinit.io/ipfs/{cid}/',
  'https://ipfs.orbitor.dev/ipfs/{cid}/',
];

/**
 * Arweave gateways, `{tx}` substituted. One list for both roles: a gateway
 * redirects a transaction to base32(txid).<host>, a per-build origin served
 * straight to the browser with no service worker, which gives isolation and
 * WebView compatibility together. Still a choice, since any gateway lands on the
 * same sandbox origin.
 */
export const ARWEAVE_GATEWAYS = [
  // The trailing slash is load-bearing: most gateways answer 301 without it, and a
  // redirect is what addressing {sandbox} directly avoids, since the pairing rides
  // in the fragment and survives a 30x only by browser convention. Each gateway
  // listed was confirmed serving this build byte for byte; arweave.net also answers
  // without the slash.
  'https://{sandbox}.ar.io/{tx}/',
  'https://{sandbox}.arweave.net/{tx}/',
  'https://{sandbox}.permagate.io/{tx}/',
];

/**
 * Expand an Arweave gateway template for a transaction id. `{sandbox}` resolves to
 * the per-transaction subdomain the gateway would have redirected to. Addressing
 * it directly matters because the pairing rides in the fragment, which a redirect
 * keeps only by browser convention and this link opens in WebViews we cannot
 * check; it also lands on the isolated origin at once.
 */
export function resolveArweaveGateway(template: string, tx: string): string {
  if (template.includes('{sandbox}')) {
    template = template.replaceAll('{sandbox}', arweaveSandboxLabel(tx));
  }
  if (template.includes('{tx}')) return template.replaceAll('{tx}', tx);
  const existing = detectServedTx(template);
  if (existing) return template.replace(existing, tx);
  return `${template.replace(/\/+$/, '')}/${tx}`;
}

export function arweaveGatewayLabel(template: string): string {
  try {
    return new URL(resolveArweaveGateway(template, 'tx')).host;
  } catch {
    return template;
  }
}

/** Expand a gateway template for a CID.
 *  A template without `{cid}` is treated as a base URL and gets `/ipfs/<cid>/`. */
export function resolveGateway(template: string, cid: string): string {
  if (template.includes('{cid}')) return template.replaceAll('{cid}', cid);
  // An already-resolved URL, pasted rather than templated: swap its CID instead of
  // appending.
  const existing = detectServedCid(template);
  if (existing) return template.replace(existing, cid);
  return `${template.replace(/\/+$/, '')}/ipfs/${cid}/`;
}

export function gatewayLabel(template: string): string {
  try {
    return new URL(resolveGateway(template, 'cid')).host.replace('cid.ipfs.', '');
  } catch {
    return template;
  }
}

export interface PairingParams {
  publicKey: string;
  relays: string[];
  /**
   * How many relays the link named, before the cap. Reported, not acted on: it is the
   * only explanation for the one way truncation can bite, a dapp whose live relays
   * are all past the cap, which otherwise shows as a pairing that times out for no
   * visible reason.
   */
  relaysNamed: number;
  /**
   * CID of the hub build this link expects. Carried so the link survives its
   * gateway: if the host is dead the fragment still names everything needed, and the
   * user opens any hub they can reach and pastes the link. It also lets a hub warn
   * when it is not the build the dapp expected.
   */
  cid?: string;
  /**
   * Arweave transaction of the same hub build. Carried beside `cid`: they address
   * identical bytes by different means, so a user whose route is dead has a second.
   * Arweave is the better mobile route (per-transaction origin, no service worker)
   * but it is one network, so the CID stays as the independent path.
   */
  tx?: string;
  /**
   * Where a phone should open the hub, for the mobile handoff. Sent rather than
   * worked out at the far end: the hub is an immutable build, so anything it decides
   * is frozen at publish time, while the dapp is redeployable and is where the
   * user's gateway choice is made. Optional; a hub that receives none derives one,
   * as links from older dapps require.
   */
  webviewUrl?: string;
}

/**
 * A link's contents without `relaysNamed`, which describes what a parser found and
 * is not something a builder has.
 */
export type PairingLink = Omit<PairingParams, 'relaysNamed'>;

export interface BuildUriOptions extends PairingLink {
  hubUrl: string;
}

/**
 * Everything after the `#`, for the code path, which has no hub URL to build: the
 * hub is already open and needs the fragment a scan would have carried, for the
 * mobile handoff.
 */
export function buildPairingFragment(opts: PairingLink): string {
  if (!isValidPublicKey(opts.publicKey)) throw new Error('uri: invalid public key');
  if (opts.relays.length === 0) throw new Error('uri: at least one relay required');

  const params = new URLSearchParams();
  params.set('v', String(PROTOCOL_VERSION));
  params.set('p', opts.publicKey);
  params.set('r', opts.relays.join(','));
  if (opts.cid) params.set('c', opts.cid);
  if (opts.tx) params.set('t', opts.tx);
  if (opts.webviewUrl) params.set('w', opts.webviewUrl);

  return params.toString();
}

export function buildPairingUri(opts: BuildUriOptions): string {
  const base = opts.hubUrl.split('#')[0]!;
  return `${base}#${buildPairingFragment(opts)}`;
}

/**
 * The CID this page was served as, read from its own URL (path or subdomain
 * gateway).
 */
export function detectServedCid(url: string = globalThis.location?.href ?? ''): string | null {
  const path = url.match(/\/ipfs\/(ba[a-z2-7]{57,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/i);
  if (path?.[1]) return path[1];
  const sub = url.match(/\/\/(ba[a-z2-7]{57,}|Qm[1-9A-HJ-NP-Za-km-z]{44})\.ipfs\./i);
  return sub?.[1] ?? null;
}

/** The Arweave transaction this page was served as (43 base64url characters). */
export function detectServedTx(url: string = globalThis.location?.href ?? ''): string | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (!/(^|\.)arweave\.net$|(^|\.)permagate\.io$|(^|\.)ar-io\.dev$/i.test(hostname)) return null;
    return pathname.match(/^\/([A-Za-z0-9_-]{43})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The sandbox subdomain an Arweave gateway derives for a transaction: base32 of its
 * 32 bytes.
 */
export function arweaveSandboxLabel(tx: string): string {
  const raw = Uint8Array.from(
    atob(tx.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(tx.length / 4) * 4, '=')),
    (c) => c.charCodeAt(0),
  );
  let bits = 0;
  let value = 0;
  let label = '';
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      label += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) label += B32[(value << (5 - bits)) & 31];
  return label;
}

/**
 * Whether `host` is the sandbox subdomain for `tx`. Recomputed, not pattern-matched:
 * a 52-base32-characters test would accept any sandbox on the gateway, the opposite
 * of what this establishes.
 */
function isArweaveSandboxOf(host: string, tx: string): boolean {
  return host.toLowerCase().startsWith(`${arweaveSandboxLabel(tx)}.`);
}

/**
 * Whether this page's origin belongs to this build alone. False on a path gateway,
 * where every CID shares one origin and so one localStorage that a neighbour can
 * write: nothing secret may be kept or trusted there. A subdomain gateway, a
 * DNSLink domain and a plain https host return true, since the question is whether
 * the origin is shared, not whether this is IPFS. Arweave is checked explicitly:
 * its bare host serves every transaction from one origin, which would otherwise
 * return true just because no CID was found.
 */
export function isOriginIsolated(url: string = globalThis.location?.href ?? ''): boolean {
  const tx = detectServedTx(url);
  if (tx) {
    try {
      return isArweaveSandboxOf(new URL(url).hostname, tx);
    } catch {
      return false;
    }
  }

  const cid = detectServedCid(url);
  if (!cid) return true;
  try {
    return new URL(url).hostname.toLowerCase().startsWith(`${cid.toLowerCase()}.`);
  } catch {
    return false;
  }
}

export function parsePairingUri(uri: string): PairingParams {
  const hashIndex = uri.indexOf('#');
  if (hashIndex === -1) throw new Error('uri: no fragment');
  return parsePairingFragment(uri.slice(hashIndex + 1));
}

export function parsePairingFragment(fragment: string): PairingParams {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));

  const version = params.get('v');
  if (version !== String(PROTOCOL_VERSION)) {
    throw new Error(`uri: unsupported protocol version ${version ?? 'missing'}`);
  }

  const publicKey = params.get('p');
  if (!publicKey || !isValidPublicKey(publicKey)) throw new Error('uri: invalid or missing pubkey');

  const named = (params.get('r') ?? '')
    .split(',')
    .map((r) => lowerRelayScheme(r.trim()))
    .filter(Boolean);
  if (named.length === 0) throw new Error('uri: no relays');
  for (const relay of named) {
    if (!relay.startsWith('wss://') && !relay.startsWith('ws://')) {
      throw new Error(`uri: relay must be a websocket url: ${relay}`);
    }
  }
  // Truncated, not refused: a long list is far more likely enthusiasm than attack,
  // but it must not open every socket it is told to, as it arrives in a scanned QR
  // before the wallet has agreed to anything.
  const relays = named.slice(0, MAX_RELAYS);
  if (named.length > relays.length) {
    console.warn(`uri: ${named.length} relays named, using the first ${MAX_RELAYS}`);
  }

  // Only http(s): this becomes a link the hub hands to another app, so any other
  // scheme would be passed on unexamined.
  const webviewUrl = params.get('w') ?? undefined;
  if (webviewUrl && !/^https?:\/\//.test(webviewUrl)) {
    throw new Error('uri: webview url must be http(s)');
  }

  // Shape-checked: this becomes part of a URL the hub may offer.
  const tx = params.get('t') ?? undefined;
  if (tx && !/^[A-Za-z0-9_-]{43}$/.test(tx)) throw new Error('uri: invalid arweave tx');

  return {
    publicKey,
    relays,
    relaysNamed: named.length,
    cid: params.get('c') ?? undefined,
    tx,
    webviewUrl,
  };
}
