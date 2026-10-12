/**
 * Session code: four words derived from the conversation key, shown on both
 * screens for the user to compare.
 *
 * both sides compute it from the shared secret between them (the ECDH conversation key).
 * It is four words from a list of 256, so 4 × 8 = 32 bits.
 * 256 so each digest byte indexes one directly with no modulo bias.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8Encode } from './util.js';

/**
 * 256 short English words. The order is the index and is reproduced in
 * PROTOCOL.md: do not reorder.
 */
const WORDLIST = [
  'acid', 'acorn', 'actor', 'adapt', 'admit', 'agent', 'album', 'alert',
  'alien', 'alley', 'alpha', 'amber', 'ankle', 'apple', 'apron', 'arena',
  'armor', 'arrow', 'asset', 'atlas', 'audio', 'audit', 'avoid', 'awake',
  'award', 'bacon', 'badge', 'bagel', 'baker', 'banjo', 'barge', 'basil',
  'basin', 'batch', 'beach', 'beard', 'beast', 'bench', 'berry', 'bison',
  'blade', 'blaze', 'blend', 'block', 'bloom', 'board', 'bonus', 'boost',
  'booth', 'brave', 'bread', 'brick', 'brisk', 'broom', 'brush', 'bugle',
  'cabin', 'cable', 'cacao', 'cadet', 'camel', 'candy', 'canoe', 'cargo',
  'carol', 'carve', 'cedar', 'cello', 'chalk', 'charm', 'chess', 'chief',
  'chime', 'choir', 'chord', 'cider', 'cliff', 'cloak', 'clock', 'cloud',
  'clove', 'coach', 'cobra', 'cocoa', 'comet', 'coral', 'couch', 'cover',
  'crane', 'crate', 'crisp', 'crown', 'crumb', 'curve', 'cyber', 'daisy',
  'dance', 'dealt', 'debug', 'decoy', 'delta', 'dense', 'depot', 'diner',
  'dizzy', 'dodge', 'donor', 'draft', 'drain', 'drama', 'dream', 'drift',
  'drums', 'eagle', 'early', 'earth', 'easel', 'ebony', 'edict', 'eight',
  'elbow', 'elder', 'elite', 'ember', 'empty', 'enact', 'enjoy', 'entry',
  'equal', 'erupt', 'essay', 'ether', 'ethic', 'event', 'exact', 'exile',
  'extra', 'fable', 'facet', 'faint', 'fancy', 'feast', 'fence', 'fiber',
  'field', 'fifty', 'final', 'flame', 'flask', 'fleet', 'flint', 'float',
  'flock', 'flour', 'flute', 'focus', 'forge', 'forum', 'fossil', 'found',
  'frame', 'fresh', 'frost', 'fruit', 'fudge', 'gauge', 'ghost', 'giant',
  'glide', 'globe', 'glove', 'grain', 'grape', 'grasp', 'green', 'grill',
  'group', 'grove', 'guard', 'guest', 'guide', 'habit', 'harbor', 'hasty',
  'haven', 'hazel', 'heart', 'hedge', 'hertz', 'hinge', 'hobby', 'honey',
  'horse', 'hotel', 'house', 'human', 'humid', 'ideal', 'index', 'inlet',
  'input', 'ivory', 'jelly', 'jewel', 'joker', 'jolly', 'judge', 'juice',
  'kayak', 'kneel', 'knife', 'koala', 'label', 'lager', 'lamp', 'lance',
  'large', 'laser', 'latch', 'layer', 'ledge', 'lemon', 'lever', 'light',
  'lilac', 'linen', 'liver', 'lobby', 'local', 'lodge', 'logic', 'lotus',
  'lucky', 'lunar', 'lyric', 'magic', 'major', 'mango', 'maple', 'march',
  'marsh', 'medal', 'melon', 'mercy', 'metal', 'meter', 'micro', 'midst',
  'miner', 'minor', 'mixer', 'model', 'moist', 'motor', 'mound', 'mouse',
];

export const FINGERPRINT_LENGTH = 4;

/** Domain-separated from every other use of the conversation key. */
export function fingerprint(conversationKey: Uint8Array): string[] {
  const digest = sha256(concatBytes(utf8Encode('verum-connect/fingerprint/v1'), conversationKey));
  const out: string[] = [];
  for (let i = 0; i < FINGERPRINT_LENGTH; i++) {
    out.push(WORDLIST[digest[i]! % WORDLIST.length]!);
  }
  return out;
}

export function fingerprintString(conversationKey: Uint8Array): string {
  return fingerprint(conversationKey).join(' · ');
}
