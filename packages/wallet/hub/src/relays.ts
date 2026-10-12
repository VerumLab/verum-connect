/**
 * The hub's own relay set, distinct from a session's relays (which arrive in the
 * pairing link and belong to the dapp). Used only to find the fragment a typed code
 * names: a wallet holding only a code has nowhere to read a list from, so it
 * searches one it knows. The set is thus a compatibility surface: relays the dapp
 * does not publish to stop codes resolving, while QR and link carry their own.
 *
 * No defaults, deliberately: the hub is a pinned CID, so a baked-in list that rots
 * cannot be corrected without moving every user. An empty set is legitimate: it
 * disables one pairing path.
 */

import { MAX_RELAYS, isOriginIsolated, lowerRelayScheme } from '@verumlab/connect-protocol';

const RELAYS_KEY = 'verum-connect/relays/v1';

function isWsUrl(url: string): boolean {
  return url.startsWith('wss://') || url.startsWith('ws://');
}

/**
 * Relays named in the page's query string
 * (`?relays=wss://one.example,wss://two.example`). Query, not fragment: the
 * fragment is stripped on arrival, and this is configuration meant to survive a
 * reload.
 */
export function urlRelays(search: string = location.search): string[] {
  return capped(namedInUrl(search));
}

/** Everything the address named, before the cap, for saying how many were dropped. */
export function namedInUrl(search: string = location.search): string[] {
  const raw = new URLSearchParams(search).get('relays');
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((url) => lowerRelayScheme(url.trim()))
        .filter((url) => isWsUrl(url)),
    ),
  ];
}

/**
 * The ceiling, applied wherever a list comes from: an address is handed over by
 * someone else, and each entry is a socket and one more party seeing which codes
 * are looked up. Eight, as for a pairing link. Truncated, not refused: far likelier
 * enthusiasm than attack.
 */
function capped(urls: string[]): string[] {
  return urls.slice(0, MAX_RELAYS);
}

/** The manual list, as set in settings; survives a URL override untouched. */
export function storedRelays(): string[] {
  return stored();
}

function stored(): string[] {
  // Not secret, but on a shared path gateway a neighbouring build can write this key
  // and steer the lookup relays, so stored relays are ignored there. Costs a
  // preference; QR is unaffected.
  if (!isOriginIsolated()) return [];
  try {
    const raw = localStorage.getItem(RELAYS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((url): url is string => typeof url === 'string' && isWsUrl(url));
  } catch {
    return [];
  }
}

/**
 * The set in use: a URL parameter overrides the manual list without replacing it,
 * so a link carrying `?relays=` can be followed without losing your own. Not
 * written through: that made one visit destructive.
 */
export function activeRelays(): string[] {
  const fromUrl = urlRelays();
  // Capped on the way out too, so an older stored list cannot open more sockets.
  return capped(fromUrl.length > 0 ? fromUrl : stored());
}

/**
 * Whether the set in force came from the URL, shown in settings so an unexpected
 * list has a visible cause.
 */
export function relaysFromUrl(): boolean {
  return urlRelays().length > 0;
}

export function saveRelays(urls: string[]): void {
  // Empty is allowed: removing the last relay turns the code path off.
  const cleaned = [...new Set(urls.map((u) => lowerRelayScheme(u.trim())).filter(isWsUrl))];
  // Refused, not truncated: this one is being typed, and silently dropping an
  // addition would leave a list without it.
  if (cleaned.length > MAX_RELAYS) {
    throw new Error(`At most ${MAX_RELAYS} relays — remove one first.`);
  }
  try {
    localStorage.setItem(RELAYS_KEY, JSON.stringify(cleaned));
  } catch {
    // Private mode or a shared origin: the choice holds for this page load.
  }
}

