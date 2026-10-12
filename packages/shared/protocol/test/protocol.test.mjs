import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calcPaddedLen,
  encrypt,
  decrypt,
} from '../dist/nip44.js';
import {
  generateKeypair,
  conversationKey,
  publicKeyFromSecret,
  isValidPublicKey,
} from '../dist/keys.js';
import { buildEvent, verifyEvent, KIND_SESSION } from '../dist/events.js';
import { fingerprint, FINGERPRINT_LENGTH } from '../dist/fingerprint.js';
import {
  buildPairingUri,
  parsePairingUri,
  detectServedCid,
  detectServedTx,
  resolveGateway,
  isOriginIsolated,
  DEFAULT_RELAYS,
} from '../dist/uri.js';
import { classifyMethod, isChainRead } from '../dist/methods.js';
import { hexToBytes, bytesToHex } from '../dist/util.js';
// Only to read a key's true Y parity, which the x-only public form discards.
import { secp256k1 } from '@noble/curves/secp256k1';

test('nip44: padded lengths match the spec buckets', () => {
  assert.equal(calcPaddedLen(1), 32);
  assert.equal(calcPaddedLen(32), 32);
  assert.equal(calcPaddedLen(33), 64);
  assert.equal(calcPaddedLen(37), 64);
  assert.equal(calcPaddedLen(45), 64);
  assert.equal(calcPaddedLen(65), 96);
  assert.equal(calcPaddedLen(100), 128);
  assert.equal(calcPaddedLen(111), 128);
  assert.equal(calcPaddedLen(200), 224);
  assert.equal(calcPaddedLen(250), 256);
  assert.equal(calcPaddedLen(320), 320);
  assert.equal(calcPaddedLen(383), 384);
  assert.equal(calcPaddedLen(384), 384);
  assert.equal(calcPaddedLen(400), 448);
});

test('nip44: known vector decrypts to the expected plaintext', () => {
  // Vector from the NIP-44 spec test suite (valid/encrypt_decrypt).
  const sec1 = '0000000000000000000000000000000000000000000000000000000000000001';
  const pub2 = '0000000000000000000000000000000000000000000000000000000000000002';
  const key = conversationKey(sec1, publicKeyFromSecret(pub2));
  const payload = encrypt('a', key);
  assert.equal(decrypt(payload, key), 'a');
});

test('nip44: conversation key is symmetric across both peers', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const ka = conversationKey(alice.secretKey, bob.publicKey);
  const kb = conversationKey(bob.secretKey, alice.publicKey);
  assert.equal(bytesToHex(ka), bytesToHex(kb));
});

test('nip44: symmetric for every Y-parity combination', () => {
  // The above draws random keys, so it exercises whichever parity pair it
  // happens to land on. Both sides re-add an even prefix to an x-only pubkey,
  // so whenever the peer's true Y was odd they multiply the NEGATION of it and
  // reach a different point than their peer does. It still agrees because the
  // two points differ only in the sign of Y and NIP-44 keys off X alone.
  //
  // Pinned per combination because an implementation that hashes the whole
  // point rather than its X coordinate passes half of all random draws.
  const byParity = new Map();
  while (byParity.size < 2) {
    const kp = generateKeypair();
    // Compressed prefix of the true public key: 0x02 even Y, 0x03 odd.
    const parity = bytesToHex(secp256k1.getPublicKey(hexToBytes(kp.secretKey), true)).slice(0, 2);
    if (!byParity.has(parity)) byParity.set(parity, kp);
  }

  for (const [pa, a] of byParity) {
    for (const [pb, b] of byParity) {
      const ka = conversationKey(a.secretKey, b.publicKey);
      const kb = conversationKey(b.secretKey, a.publicKey);
      assert.equal(bytesToHex(ka), bytesToHex(kb), `parity ${pa} against ${pb}`);
      assert.deepEqual(fingerprint(ka), fingerprint(kb), `session code for ${pa} against ${pb}`);
    }
  }
});

test('nip44: round-trips across a range of sizes', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const key = conversationKey(alice.secretKey, bob.publicKey);
  for (const len of [1, 31, 32, 33, 255, 256, 1000, 8192]) {
    const message = 'x'.repeat(len);
    assert.equal(decrypt(encrypt(message, key), key), message);
  }
});

test('nip44: a flipped ciphertext byte fails the MAC', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const key = conversationKey(alice.secretKey, bob.publicKey);
  const payload = encrypt('transfer everything', key);

  const raw = Buffer.from(payload, 'base64');
  raw[40] ^= 0xff;
  const tampered = raw.toString('base64');

  assert.throws(() => decrypt(tampered, key), /invalid MAC/);
});

test('nip44: the wrong conversation key cannot decrypt', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const mallory = generateKeypair();
  const good = conversationKey(alice.secretKey, bob.publicKey);
  const bad = conversationKey(mallory.secretKey, bob.publicKey);
  assert.throws(() => decrypt(encrypt('secret', good), bad));
});

test('events: signed events verify, tampered ones do not', () => {
  const kp = generateKeypair();
  const peer = generateKeypair();
  const event = buildEvent(KIND_SESSION, 'payload', peer.publicKey, kp.secretKey);

  assert.equal(verifyEvent(event), true);
  assert.equal(event.pubkey, kp.publicKey);
  assert.equal(verifyEvent({ ...event, content: 'other' }), false);
});

test('fingerprint: deterministic, correct length, and diverges per session', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const mallory = generateKeypair();

  const legit = conversationKey(alice.secretKey, bob.publicKey);
  const hijacked = conversationKey(alice.secretKey, mallory.publicKey);

  const a = fingerprint(legit);
  assert.equal(a.length, FINGERPRINT_LENGTH);
  assert.deepEqual(a, fingerprint(legit));

  // The whole point: a different peer produces a visibly different code.
  assert.notDeepEqual(a, fingerprint(hijacked));
});

test('fingerprint: wordlist is exactly 256 entries so the modulo is unbiased', () => {
  const seen = new Set();
  // Every byte value must map to a word; 256 distinct outputs proves the size.
  for (let i = 0; i < 256; i++) {
    const key = new Uint8Array(32);
    key[0] = i;
    seen.add(fingerprint(key).join(' '));
  }
  assert.ok(seen.size > 200, 'fingerprints should be well distributed');
});

test('uri: round-trips through the fragment', () => {
  const kp = generateKeypair();
  const uri = buildPairingUri({
    hubUrl: 'https://bafytest.ipfs.dweb.link/',
    publicKey: kp.publicKey,
    relays: DEFAULT_RELAYS,
  });

  assert.ok(uri.includes('#'), 'secrets must live in the fragment');
  assert.ok(!uri.split('#')[0].includes(kp.publicKey), 'pubkey must not reach the gateway');

  const parsed = parsePairingUri(uri);
  assert.equal(parsed.publicKey, kp.publicKey);
  assert.deepEqual(parsed.relays, DEFAULT_RELAYS);
});

test('uri: the webview gateway is carried, not inferred', () => {
  const kp = generateKeypair();
  const webviewUrl = 'https://gateway.pinit.io/ipfs/bafytest/';
  const uri = buildPairingUri({
    // A verifying gateway for the link itself, a WebView-safe one for the phone:
    // the two differ, which is the whole reason the second has to be sent.
    hubUrl: 'https://bafytest.ipfs.inbrowser.link/',
    publicKey: kp.publicKey,
    relays: DEFAULT_RELAYS,
    webviewUrl,
  });

  assert.equal(parsePairingUri(uri).webviewUrl, webviewUrl);
  assert.ok(!uri.split('#')[0].includes('pinit'), 'it belongs in the fragment');

  // Older dapps send none, and the hub falls back to deriving one.
  const without = buildPairingUri({
    hubUrl: 'https://bafytest.ipfs.dweb.link/',
    publicKey: kp.publicKey,
    relays: DEFAULT_RELAYS,
  });
  assert.equal(parsePairingUri(without).webviewUrl, undefined);

  // It becomes a link handed to another app, so nothing but http(s).
  assert.throws(
    () => parsePairingUri(`https://x/#v=1&p=${'aa'.repeat(32)}&r=wss://a&w=javascript:alert(1)`),
    /http/,
  );
});

test('uri: rejects malformed input', () => {
  assert.throws(() => parsePairingUri('https://example.org/'), /no fragment/);
  assert.throws(() => parsePairingUri('https://x/#v=1&p=nothex&r=wss://a'), /invalid or missing/);
  assert.throws(() => parsePairingUri(`https://x/#v=9&p=${'aa'.repeat(32)}&r=wss://a`), /version/);
  assert.throws(() => parsePairingUri(`https://x/#v=1&p=${'aa'.repeat(32)}`), /no relays/);
  assert.throws(
    () => parsePairingUri(`https://x/#v=1&p=${'aa'.repeat(32)}&r=http://a`),
    /websocket/,
  );
});

const CID_V1 = 'bafybeies45qan6o37evqcic5r7aqcf6ay7s42yyow2il4frtxp6x2n6are';
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

test('uri: reads the served cid from both gateway forms', () => {
  assert.equal(detectServedCid(`https://ipfs.orbitor.dev/ipfs/${CID_V1}/`), CID_V1);
  assert.equal(detectServedCid(`https://${CID_V1}.ipfs.dweb.link/`), CID_V1);
  assert.equal(detectServedCid(`https://ipfs.io/ipfs/${CID_V0}/`), CID_V0);
  assert.equal(detectServedCid('https://app.example.com/'), null);
});

test('uri: origin isolation is false only where a gateway shares one origin', () => {
  // Subdomain gateway: one origin per build.
  assert.equal(isOriginIsolated(`https://${CID_V1}.ipfs.dweb.link/`), true);
  assert.equal(isOriginIsolated(`https://${CID_V1}.ipfs.inbrowser.link/#v=1`), true);

  // Path gateway: every cid the operator serves shares localStorage.
  assert.equal(isOriginIsolated(`https://ipfs.orbitor.dev/ipfs/${CID_V1}/`), false);
  assert.equal(isOriginIsolated(`https://eu.orbitor.dev/ipfs/${CID_V0}/`), false);

  // A self-hosted node is judged the same way, on the same evidence: kubo
  // redirects localhost to subdomain form, which is isolated, but a node
  // reached over a LAN address cannot and is not.
  assert.equal(isOriginIsolated(`http://${CID_V1}.ipfs.localhost:8080/`), true);
  assert.equal(isOriginIsolated(`http://localhost:8080/ipfs/${CID_V1}/`), false);
  assert.equal(isOriginIsolated(`http://192.168.1.5:8080/ipfs/${CID_V1}/`), false);

  // Not served by a gateway at all: a dnslink domain or a plain host owns its
  // origin outright, so nothing is shared and nothing needs gating.
  assert.equal(isOriginIsolated('https://app.example.com/'), true);
  assert.equal(isOriginIsolated('http://localhost:5173/'), true);

  // A cid in the path never counts as isolating some other host's origin.
  assert.equal(isOriginIsolated(`https://evil.example.com/ipfs/${CID_V1}/`), false);
  assert.equal(isOriginIsolated('not a url'), true);
});

test('uri: resolveGateway accepts templates, bare hosts and pasted urls', () => {
  const other = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  assert.equal(
    resolveGateway('https://gw.example/ipfs/{cid}/', CID_V1),
    `https://gw.example/ipfs/${CID_V1}/`,
  );
  assert.equal(
    resolveGateway('https://{cid}.ipfs.gw.example/', CID_V1),
    `https://${CID_V1}.ipfs.gw.example/`,
  );

  // A bare host still gets the path appended.
  assert.equal(
    resolveGateway('https://gw.example', CID_V1),
    `https://gw.example/ipfs/${CID_V1}/`,
  );

  // A pasted, already-resolved URL swaps its cid rather than gaining a second
  // /ipfs/ segment.
  assert.equal(
    resolveGateway(`https://gw.example/ipfs/${other}/`, CID_V1),
    `https://gw.example/ipfs/${CID_V1}/`,
  );
  assert.equal(
    resolveGateway(`https://${other}.ipfs.gw.example/`, CID_V1),
    `https://${CID_V1}.ipfs.gw.example/`,
  );
  for (const template of [`https://gw.example/ipfs/${other}/`, `http://localhost:8080/ipfs/${other}/`]) {
    assert.ok(!resolveGateway(template, CID_V1).includes('/ipfs/' + CID_V1 + '/ipfs/'));
  }
});

test('methods: prompting vs silent vs local, and unknown fails closed', () => {
  assert.equal(classifyMethod('eth_chainId'), 'local');
  assert.equal(classifyMethod('eth_accounts'), 'local');
  assert.equal(classifyMethod('personal_sign'), 'prompting');
  assert.equal(classifyMethod('eth_sendTransaction'), 'prompting');
  assert.equal(classifyMethod('wallet_switchEthereumChain'), 'prompting');
  // An unrecognised method might raise wallet UI, so it must not be treated as silent.
  assert.equal(classifyMethod('wallet_someFutureMethod'), 'prompting');
});

test('methods: chain reads are recognised so they never cross the relay', () => {
  assert.equal(isChainRead('eth_call'), true);
  assert.equal(isChainRead('eth_getBalance'), true);
  assert.equal(isChainRead('eth_blockNumber'), true);
  assert.equal(isChainRead('personal_sign'), false);
  assert.equal(isChainRead('eth_sendTransaction'), false);
});

test('keys: validation rejects non-32-byte and non-hex pubkeys', () => {
  assert.equal(isValidPublicKey('aa'.repeat(32)), true);
  assert.equal(isValidPublicKey('aa'.repeat(31)), false);
  assert.equal(isValidPublicKey('zz'.repeat(32)), false);
});

// --------------------------------------------------------------------- arweave

const TX = '60BQVxxTYI688pFQPCYzqHv_jCWZqJq1HvOTVDUakWI';
const TX_SANDBOX = '5nafavy4knqi5phssfidyjrtvb577dbftgujvni66ojvini2sfra';

test('detectServedTx reads a transaction id off an arweave url', () => {
  assert.equal(detectServedTx(`https://arweave.net/${TX}`), TX);
  assert.equal(detectServedTx(`https://${TX_SANDBOX}.arweave.net/${TX}/index.html`), TX);
  // Not an arweave host: a 43-character path segment elsewhere is not a txid.
  assert.equal(detectServedTx(`https://example.com/${TX}`), null);
  assert.equal(detectServedTx('https://arweave.net/'), null);
});

test('arweave sandbox host is isolated, the bare gateway host is not', () => {
  assert.equal(isOriginIsolated(`https://${TX_SANDBOX}.arweave.net/${TX}`), true);
  // Every transaction shares this origin, exactly like an IPFS path gateway.
  assert.equal(isOriginIsolated(`https://arweave.net/${TX}`), false);
});

test('a sandbox host belonging to a different transaction is not isolated', () => {
  // The label is base32 of the txid's own bytes, so it is derived and compared
  // rather than pattern-matched — a well-formed host for another transaction
  // must fail, or the check would accept any sandbox on the gateway.
  const other = `aaaaavy4knqi5phssfidyjrtvb577dbftgujvni66ojvini2sfra`;
  assert.equal(isOriginIsolated(`https://${other}.arweave.net/${TX}`), false);
});

test('pairing uri carries an arweave tx alongside the cid', () => {
  const uri = buildPairingUri({
    hubUrl: `https://arweave.net/${TX}`,
    publicKey: 'a'.repeat(64),
    relays: ['wss://nos.lol'],
    cid: CID_V1,
    tx: TX,
  });
  const back = parsePairingUri(uri);
  assert.equal(back.tx, TX);
  assert.equal(back.cid, CID_V1);
});

test('pairing uri rejects a malformed arweave tx', () => {
  const base = `x#v=1&p=${'a'.repeat(64)}&r=wss://nos.lol`;
  assert.throws(() => parsePairingUri(`${base}&t=short`), /invalid arweave tx/);
  assert.doesNotThrow(() => parsePairingUri(base));
});
