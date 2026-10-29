/**
 * Aztec's dapp ↔ wallet extension protocol on either side of a session, as two channels
 * of its own: on the dapp's device the extension is the wallet the dapp found, and on
 * the wallet's device the hub is the dapp the wallet found. Each channel has its own key
 * and its own emojis, shown on its own side. Between them each call crosses the session
 * decrypted, as `aztec_call` {type, args, chainInfo, appId}.
 *
 * A call can carry a contract's artifact, hundreds of kilobytes to megabytes. Every value
 * in it past a few kilobytes crosses once, by its hash: `aztec_blob_has` [hashes] says
 * which the hub lacks, `aztec_blob_put` {hash, value} sends one, and the call itself
 * carries `{ $blob: hash }` in its place.
 *
 * Discovery, the key exchange (ECDH P-256, HKDF-SHA-256 with both public keys as salt)
 * and the AES-GCM messages are Aztec's own.
 */

export const AZTEC_CALL = 'aztec_call';
export const AZTEC_BLOB_HAS = 'aztec_blob_has';
export const AZTEC_BLOB_PUT = 'aztec_blob_put';

const DISCOVERY = 'aztec-wallet-discovery';
const DISCOVERY_RESPONSE = 'aztec-wallet-discovery-response';
const KEY_EXCHANGE_REQUEST = 'aztec-wallet-key-exchange-request';
const KEY_EXCHANGE_RESPONSE = 'aztec-wallet-key-exchange-response';
const DISCONNECT = 'aztec-wallet-disconnect';
const PING = 'aztec-wallet-ping';
const PONG = 'aztec-wallet-pong';

const HKDF_INFO = new TextEncoder().encode('Aztec Wallet DAPP Key derivation');
const FINGERPRINT = new TextEncoder().encode('aztec-wallet-verification-verificationHash');

/** Values in a call larger than this, as JSON, cross once by their hash. */
const BLOB_MIN = 32_000;

/** Field elements as Aztec serialises them: hex strings. */
export interface AztecChainInfo {
  chainId: string;
  version: string;
}

export interface AztecWalletInfo {
  id: string;
  name: string;
  version: string;
  icon?: string;
}

/** A wallet call as the dapp sent it, without the envelope fields its channel owns. */
export interface AztecCall {
  type: string;
  args: unknown;
  chainInfo: AztecChainInfo;
  appId: string;
}

/** A network by its L1 chain and rollup version, as the dapp's discovery names it. */
export function aztecNetworkName(chainInfo: AztecChainInfo): string {
  const l1 = Number(BigInt(chainInfo.chainId));
  const rollup = Number(BigInt(chainInfo.version));
  if (l1 === 1 && rollup === 2070860440) return 'Aztec';
  if (l1 === 11155111 && rollup === 679261766) return 'Aztec testnet';
  return `Aztec, rollup ${rollup} on chain ${l1}`;
}

/** A message the window posts as JSON text, parsed; null for anything else. */
function parse(event: MessageEvent): Record<string, any> | null {
  if (event.source !== window || typeof event.data !== 'string') return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- crypto

interface Jwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

interface Encrypted {
  iv: string;
  ciphertext: string;
}

interface Session {
  key: CryptoKey;
  verificationHash: string;
}

function keyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

async function exportKey(key: CryptoKey): Promise<Jwk> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key);
  return { kty: kty!, crv: crv!, x: x!, y: y! };
}

function importKey({ kty, crv, x, y }: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

function fromBase64Url(text: string, size: number): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
}

/** The app's key first in the salt, whichever end derives. */
async function deriveSession(own: CryptoKeyPair, peer: Jwk, isApp: boolean): Promise<Session> {
  const peerKey = await importKey(peer);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, own.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const ownJwk = await exportKey(own.publicKey);
  const [app, wallet] = isApp ? [ownJwk, peer] : [peer, ownJwk];
  const salt = new Uint8Array(128);
  [app.x, app.y, wallet.x, wallet.y].forEach((c, i) => salt.set(fromBase64Url(c, 32), i * 32));
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO }, hkdf, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const hmac = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { key, verificationHash: hex(await crypto.subtle.sign('HMAC', hmac, FINGERPRINT)) };
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function encrypt(key: CryptoKey, message: unknown): Promise<Encrypted> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(message));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))) };
}

async function decrypt(key: CryptoKey, { iv, ciphertext }: Encrypted): Promise<any> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

const EMOJI = [...'😀😎🤖👻💀👽🤡🎃😺😈👾🗿🤠🥸🧐😵🐶🐱🐸🐵🦊🐻🦁🐯🐮🐷🐔🐧🦉🦇🐺🦄🐘🦒🐊🦈🐙🦋🐢🦀🐍🦅🦆🐳🦭🦩🦚🐉🌵🌴🌲🌳🍄🌍🌕🌙🌟🌈🔥💧🌨💢🌞🌤🍎🍌🍇🍉🍓🍍🥑🌽🥕🍔🍕🌮🍣🍪🎂🍩🍺🍷🍸🫗🧃🥛🍵🧁🍫🍬🍭🥨🥯🥞🧇🍿💯💔💥💫🌀🫨🚧🛑🔴🔵🟢🟡🟣⬛⬜🟤💜💙💚🧡🖤🤍💘💍💎👑🎩🧢🪭🎗🎟🏷🕐📱💻🖥📷🎥📺📻🔋💡🔑🔨🛠🧲🧪🔬🔧🪛🔩🪚🪓🧹🪣🧴🛁🚽🪜🔔🕯🪤🧯🪝🚗🚌🚓🚑🚒🚜🚲🏍🛩🚀🛸🚁🚢🚤🚂🚠🥅🏀🏈🏐🏓🎱🎯🎳🎲🎮🕹🧩🎴🎰🃏🀄🎸🎹🎺🎻🥁🎷🎤🎧🎨🖌🎭🎪🎬🎼🪕🪗🏠🏰🗼🗽🏛🕌🛕🏯🎢🎡🛖🏕🗻🏝🌋🏜📦🧳🕰🔦🪫📡🔭🔮🧿📿🫙💉🩺🩹🧬🦠🏆🎁🎈🎀🪅🧧📨📜🗃📎🪡🖋📌🔐🧸🪆'];

/** The emojis both ends of a channel show, from its verification hash, as Aztec draws them. */
export function aztecEmojis(verificationHash: string, count = 9): string {
  let out = '';
  for (let i = 0; i < count * 2 && i < verificationHash.length; i += 2) out += EMOJI[parseInt(verificationHash.slice(i, i + 2), 16)];
  return out;
}

// ---------------------------------------------------------------------- large values

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The call with each large value replaced by `{ $blob: hash }`, and those values by hash. */
async function externalize(value: unknown, blobs: Map<string, string>): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const json = JSON.stringify(value);
  if (json.length < BLOB_MIN) return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => externalize(item, blobs)));
  // A large object whose parts are each small (an artifact is one) goes whole.
  const entries = Object.entries(value);
  if (entries.every(([, item]) => JSON.stringify(item ?? null).length < BLOB_MIN)) {
    const hash = await sha256(json);
    blobs.set(hash, json);
    return { $blob: hash };
  }
  return Object.fromEntries(await Promise.all(entries.map(async ([key, item]) => [key, await externalize(item, blobs)])));
}

async function internalize(value: unknown, lookup: (hash: string) => Promise<unknown>): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => internalize(item, lookup)));
  const blob = (value as { $blob?: unknown }).$blob;
  if (typeof blob === 'string' && Object.keys(value).length === 1) return lookup(blob);
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await internalize(item, lookup)])));
}

/**
 * A call over the session: its large values first, those the hub lacks, then the call
 * with their hashes in their place.
 */
export function aztecCallOverSession(forward: (method: string, params: unknown[]) => Promise<unknown>) {
  return async (call: AztecCall): Promise<unknown> => {
    const blobs = new Map<string, string>();
    const args = await externalize(call.args, blobs);
    if (blobs.size > 0) {
      const missing = (await forward(AZTEC_BLOB_HAS, [[...blobs.keys()]])) as string[];
      for (const hash of missing) await forward(AZTEC_BLOB_PUT, [{ hash, value: blobs.get(hash) }]);
    }
    return forward(AZTEC_CALL, [{ ...call, args }]);
  };
}

// ---------------------------------------------------------------------- wallet end, the dapp's device

/**
 * Answers every Aztec dapp's discovery in this window as `info`, and hands each
 * decrypted call to `answer`. `onSession` gets the emojis the dapp now shows. Returns a
 * function that stops answering and closes every channel.
 */
export function serveAztecWallet(
  info: AztecWalletInfo,
  answer: (call: AztecCall) => Promise<unknown>,
  onSession?: (emojis: string) => void,
): () => void {
  const ports: MessagePort[] = [];

  const onDiscovery = (event: MessageEvent) => {
    const request = parse(event);
    if (request?.type !== DISCOVERY || typeof request.requestId !== 'string') return;
    const requestId: string = request.requestId;
    const channel = new MessageChannel();
    const port = channel.port1;
    ports.push(port);
    let session: Session | null = null;

    port.onmessage = async ({ data }) => {
      if (data?.type === KEY_EXCHANGE_REQUEST && data.requestId === requestId && !session) {
        const own = await keyPair();
        session = await deriveSession(own, data.publicKey, false);
        port.postMessage({ type: KEY_EXCHANGE_RESPONSE, requestId, publicKey: await exportKey(own.publicKey) });
        onSession?.(aztecEmojis(session.verificationHash));
      } else if (data?.type === PING) {
        port.postMessage({ type: PONG });
      } else if (data?.type === DISCONNECT) {
        port.close();
      } else if (session && data?.iv && data?.ciphertext) {
        const { key } = session;
        const call = await decrypt(key, data);
        const reply = (body: { result?: unknown; error?: unknown }) =>
          encrypt(key, { messageId: call.messageId, walletId: info.id, ...body }).then((e) => port.postMessage(e));
        answer({ type: call.type, args: call.args, chainInfo: call.chainInfo, appId: call.appId }).then(
          (result) => reply({ result }),
          (err: { message?: string }) => reply({ error: err?.message ?? String(err) }),
        );
      }
    };
    port.start();
    window.postMessage(JSON.stringify({ type: DISCOVERY_RESPONSE, requestId, walletInfo: info }), '*', [channel.port2]);
  };

  window.addEventListener('message', onDiscovery);
  return () => {
    window.removeEventListener('message', onDiscovery);
    for (const port of ports.splice(0)) {
      port.postMessage({ type: DISCONNECT });
      port.close();
    }
  };
}

// ---------------------------------------------------------------------- app end, the wallet's device

interface AztecWalletChannel {
  info: AztecWalletInfo;
  emojis: string;
  call(type: string, args: unknown): Promise<unknown>;
}

/**
 * The first Aztec wallet in this window to accept the discovery, with a channel open to
 * it. The wallet asks its user first, so `timeoutMs` is generous.
 */
function connectAztecWallet(chainInfo: AztecChainInfo, appId: string, timeoutMs = 120_000): Promise<AztecWalletChannel> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onResponse);
      reject(Object.assign(new Error('hub: no Aztec wallet answered; approve the request in it'), { code: 4900 }));
    }, timeoutMs);
    const onResponse = async (event: MessageEvent) => {
      const response = parse(event);
      const port = event.ports?.[0];
      if (response?.type !== DISCOVERY_RESPONSE || response.requestId !== requestId || !port || !response.walletInfo) return;
      clearTimeout(timer);
      window.removeEventListener('message', onResponse);
      try {
        resolve(await openChannel(port, requestId, response.walletInfo, chainInfo, appId));
      } catch (err) {
        reject(err);
      }
    };
    window.addEventListener('message', onResponse);
    window.postMessage(JSON.stringify({ type: DISCOVERY, requestId, appId, chainInfo }), '*');
  });
}

async function openChannel(
  port: MessagePort,
  requestId: string,
  info: AztecWalletInfo,
  chainInfo: AztecChainInfo,
  appId: string,
): Promise<AztecWalletChannel> {
  const own = await keyPair();
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const session = await new Promise<Session>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hub: the Aztec wallet did not finish the key exchange')), 10_000);
    port.onmessage = async ({ data }) => {
      if (data?.type !== KEY_EXCHANGE_RESPONSE || data.requestId !== requestId) return;
      clearTimeout(timer);
      resolve(await deriveSession(own, data.publicKey, true));
    };
    port.start();
    exportKey(own.publicKey).then((publicKey) => port.postMessage({ type: KEY_EXCHANGE_REQUEST, requestId, publicKey }));
  });

  port.onmessage = async ({ data }) => {
    if (data?.type === DISCONNECT) {
      for (const { reject } of waiting.values()) reject(new Error('hub: the Aztec wallet disconnected'));
      waiting.clear();
      return;
    }
    if (!data?.iv || !data?.ciphertext) return;
    const response = await decrypt(session.key, data).catch(() => null);
    const pending = response && response.walletId === info.id ? waiting.get(response.messageId) : undefined;
    if (!pending) return;
    waiting.delete(response.messageId);
    if (response.error) pending.reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)));
    else pending.resolve(response.result);
  };

  return {
    info,
    emojis: aztecEmojis(session.verificationHash),
    call: async (type, args) => {
      const messageId = crypto.randomUUID();
      const answered = new Promise((resolve, reject) => waiting.set(messageId, { resolve, reject }));
      port.postMessage(await encrypt(session.key, { type, args, messageId, chainInfo, appId, walletId: info.id }));
      return answered;
    },
  };
}

type Listener = (data: unknown) => void;

/**
 * The wallet side as a provider the hub attaches beside its Ethereum wallet: each
 * `aztec_call` goes to the first Aztec wallet in this window that accepts that dapp's
 * discovery, over a channel per dapp and network. `aztec_emojis` is emitted with the
 * emojis that wallet shows, for the hub to show beside them. Large values are kept in the
 * browser's cache, by hash, across visits.
 */
export function aztecWalletProvider() {
  const channels = new Map<string, Promise<AztecWalletChannel>>();
  const listeners: Listener[] = [];
  const blobs = new Map<string, unknown>();
  const cache = () => caches.open('verum-connect/aztec-blobs');
  const blobUrl = (hash: string) => `https://blobs.verum.invalid/${hash}`;

  const lookup = async (hash: string): Promise<unknown> => {
    if (blobs.has(hash)) return blobs.get(hash);
    const stored = await (await cache()).match(blobUrl(hash));
    if (!stored) throw Object.assign(new Error(`hub: no value for ${hash}`), { code: -32602 });
    const value = await stored.json();
    blobs.set(hash, value);
    return value;
  };

  const channel = (chainInfo: AztecChainInfo, appId: string) => {
    const key = `${appId}|${BigInt(chainInfo.chainId)}|${BigInt(chainInfo.version)}`;
    let open = channels.get(key);
    if (!open) {
      open = connectAztecWallet(chainInfo, appId);
      channels.set(key, open);
      open.then(
        (found) => listeners.forEach((listener) => listener({ appId, wallet: found.info.name, emojis: found.emojis })),
        () => channels.delete(key),
      );
    }
    return open;
  };

  return {
    isAztec: true,
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case AZTEC_BLOB_HAS: {
          const hashes = (params[0] ?? []) as string[];
          const store = await cache();
          const missing: string[] = [];
          for (const hash of hashes) if (!blobs.has(hash) && !(await store.match(blobUrl(hash)))) missing.push(hash);
          return missing;
        }
        case AZTEC_BLOB_PUT: {
          const { hash, value } = (params[0] ?? {}) as { hash: string; value: string };
          // Kept only under its own hash: a value cannot be slipped in under another's.
          if (typeof value !== 'string' || (await sha256(value)) !== hash) throw Object.assign(new Error('hub: value does not match its hash'), { code: -32602 });
          await (await cache()).put(blobUrl(hash), new Response(value, { headers: { 'content-type': 'application/json' } }));
          blobs.set(hash, JSON.parse(value));
          return null;
        }
        case AZTEC_CALL: {
          const call = (params[0] ?? {}) as AztecCall;
          const open = await channel(call.chainInfo, call.appId);
          return open.call(call.type, await internalize(call.args, lookup));
        }
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [];
        case 'eth_chainId':
          return '0x0';
        default:
          throw Object.assign(new Error(`hub: ${method} is not an Aztec method`), { code: 4200 });
      }
    },
    on(event: string, listener: Listener) {
      if (event === 'aztec_emojis') listeners.push(listener);
    },
  };
}
