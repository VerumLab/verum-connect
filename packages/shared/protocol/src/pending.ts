/**
 * Pending connects on the dapp side. Only the user can tell which connect is
 * theirs, by comparing codes with the wallet's screen, so the dapp holds what
 * arrives and commits on the user's selection.
 *
 * First-connect-wins fails: on the typed-code path the pairing key is published,
 * so an attacker connects within a round trip, and no timer can tell a lone
 * connect from the first of two. Selection is safe because an attacker can show
 * any code on their own entry but cannot compute the user's, so each connect is
 * a blind 2^-32 guess; DEFAULT_CAP bounds how many.
 */

import { conversationKey } from './keys.js';
import { fingerprint } from './fingerprint.js';

export interface PendingConnect {
  publicKey: string;
  code: string[];
  codeString: string;
}

/**
 * Each entry is an independent 2^-32 guess at the user's code, so the cap bounds
 * an attacker's chances (negligible at 10). Flooding beyond it is refused.
 */
export const DEFAULT_CAP = 10;

/**
 * Two distinct wallets showing the SAME session code. The user cannot tell them
 * apart, so the pairing aborts rather than guess.
 */
export class ConnectAmbiguityError extends Error {
  readonly code: string;
  readonly pubkeys: string[];
  constructor(code: string, pubkeys: string[]) {
    super(`connect: two wallets are showing the session code "${code}". Pairing aborted.`);
    this.name = 'ConnectAmbiguityError';
    this.code = code;
    this.pubkeys = pubkeys;
  }
}

export class ConnectFloodError extends Error {
  readonly seen: number;
  constructor(seen: number, cap: number) {
    super(`connect: ${seen} pending requests exceeds the limit of ${cap}. Regenerate the pairing.`);
    this.name = 'ConnectFloodError';
    this.seen = seen;
  }
}

/**
 * Display list for a set of connect senders. Duplicates collapse first: a wallet
 * re-sends connect on every relay reconnect and relays fan out copies, so repeats
 * are normal.
 */
export function summarizeConnects(
  ourSecretKey: string,
  peerPublicKeys: string[],
  { cap = DEFAULT_CAP }: { cap?: number } = {},
): PendingConnect[] {
  const distinct = [...new Set(peerPublicKeys)];
  if (distinct.length > cap) throw new ConnectFloodError(distinct.length, cap);

  const byCode = new Map<string, string[]>();
  const out: PendingConnect[] = [];

  for (const publicKey of distinct) {
    const code = fingerprint(conversationKey(ourSecretKey, publicKey));
    const codeString = code.join(' · ');
    out.push({ publicKey, code, codeString });

    const sharing = byCode.get(codeString);
    if (sharing) {
      sharing.push(publicKey);
      throw new ConnectAmbiguityError(codeString, sharing);
    }
    byCode.set(codeString, [publicKey]);
  }

  return out;
}

/**
 * Resolve the user's choice to a pubkey. Takes the displayed code, not an index,
 * so a reordered or late list cannot commit to something they did not look at.
 * Null when nothing matches yet, which is not an error.
 */
export function selectByCode(pending: PendingConnect[], walletCode: string): string | null {
  const wanted = normalizeCodeInput(walletCode);
  const matches = pending.filter((p) => normalizeCodeInput(p.codeString) === wanted);
  if (matches.length === 0) return null;
  // Refused upstream already; checked anyway so this never returns an arbitrary pick
  // if that invariant breaks.
  if (matches.length > 1) throw new ConnectAmbiguityError(wanted, matches.map((m) => m.publicKey));
  return matches[0]!.publicKey;
}

/** Compare by words, ignoring spacing and joining. */
function normalizeCodeInput(code: string): string {
  return code
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .join(' ');
}
