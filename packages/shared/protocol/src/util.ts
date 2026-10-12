/** Shared byte/encoding helpers. Kept dependency-free so both the dapp SDK and
 *  the single-file hub bundle can pull them in without dragging in polyfills. */

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex string');
    out[i] = byte;
  }
  return out;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Constant-time comparison. Used for the NIP-44 MAC check, where an early
 *  return would leak how much of the tag matched. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function base64Encode(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin);
}

export function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isHex(s: string, byteLength?: number): boolean {
  if (!/^[0-9a-f]*$/i.test(s)) return false;
  if (s.length % 2 !== 0) return false;
  if (byteLength !== undefined && s.length !== byteLength * 2) return false;
  return true;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The scheme of a relay URL in lower case: only that, since the rest is as written. */
export function lowerRelayScheme(url: string): string {
  return url.replace(/^wss?:\/\//i, (scheme) => scheme.toLowerCase());
}

/** A relay as typed: `wss://` when no scheme was given, the scheme lowered otherwise. */
export function typedRelayUrl(input: string): string {
  const url = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? lowerRelayScheme(url) : `wss://${url}`;
}
