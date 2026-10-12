/** Relay reachability probe.
 *
 *  The whole design rests on public relays being willing to carry ephemeral
 *  kind-24140 events from new pubkeys. Check relay for support.
 *
 *  Publishes one encrypted, ephemeral event between two throwaway keypairs per
 *  relay and times the round trip. Nothing is stored by the relay and no
 *  personal data is involved.
 *
 *    node scripts/relay-check.mjs [wss://relay ...]
 */

import { RelayPool } from '../packages/shared/protocol/dist/relay.js';
import { Channel } from '../packages/shared/protocol/dist/channel.js';
import { generateKeypair } from '../packages/shared/protocol/dist/keys.js';
import {
  buildLookupEvent,
  codeForPubkey,
  lookupFilter,
} from '../packages/shared/protocol/dist/lookup.js';
import { DEFAULT_RELAYS } from '../packages/shared/protocol/dist/uri.js';

const relays = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RELAYS;

// A relay that answers a publish late — after the probe that asked has given up
// and moved on — used to take the whole run down with it. The rejection is the
// finding, not a crash: note it and carry on to the next relay.
process.on('unhandledRejection', (err) => {
  console.log(`      late failure: ${err instanceof Error ? err.message : String(err)}`);
});
const CONNECT_TIMEOUT_MS = 8_000;
const ROUNDTRIP_TIMEOUT_MS = 10_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(50);
  }
  return false;
}

async function probe(url) {
  const dapp = generateKeypair();
  const hub = generateKeypair();

  const notices = [];
  // One connection carrying both ends, not two.
  //
  // Two sockets from one address is what a relay with a per-IP connection limit
  // refuses — nos.lol and relay.primal.net both did, and this probe then called
  // them unreachable while every browser on the same machine had them open. A
  // reachability check that is stricter than the thing it checks is worse than
  // no check: it sends people away from relays that work.
  const pool = new RelayPool([url], { onNotice: (_, m, kind) => notices.push(`${kind}: ${m}`) });
  const dappPool = pool;
  const hubPool = pool;

  const started = Date.now();
  pool.connect();

  let connected = await waitFor(() => pool.connectedCount === 1, CONNECT_TIMEOUT_MS);
  if (!connected) {
    // Once more, slowly. A relay behind a rate limiter refuses the upgrade
    // outright when probed repeatedly from one address — which is what this
    // script does to itself when run a few times in a row, and it then reports
    // relays as unreachable that every browser on the same machine has open.
    pool.close();
    await wait(3000);
    const second = new RelayPool([url], { onNotice: (_, m, kind) => notices.push(`${kind}: ${m}`) });
    second.connect();
    connected = await waitFor(() => second.connectedCount === 1, CONNECT_TIMEOUT_MS);
    second.close();
    if (!connected) {
      return {
        url,
        ok: false,
        reason: 'refused the connection twice — an outage, or this address is rate limited',
      };
    }
    return { url, ok: false, reason: 'refused at first, connected on retry — rate limited here' };
  }
  const connectMs = Date.now() - started;

  const dappChannel = new Channel({
    pool: dappPool,
    secretKey: dapp.secretKey,
    publicKey: dapp.publicKey,
    peerPublicKey: hub.publicKey,
  });
  const hubChannel = new Channel({
    pool: hubPool,
    secretKey: hub.secretKey,
    publicKey: hub.publicKey,
    peerPublicKey: dapp.publicKey,
  });

  const received = [];
  dappChannel.onEnvelope((e) => received.push(e));
  hubChannel.onEnvelope(async (envelope) => {
    if (envelope.type === 'rpc_request') {
      await hubChannel.send({ type: 'rpc_response', id: envelope.id, result: '0xok' });
    }
  });

  dappChannel.open('probe-dapp');
  hubChannel.open('probe-hub');
  await wait(500);

  const sent = Date.now();
  let publishError = null;
  try {
    await dappChannel.send({
      type: 'rpc_request',
      id: 'probe',
      method: 'personal_sign',
      params: ['0x00', '0x00'],
    });
  } catch (err) {
    publishError = err.message;
  }

  const roundTripped = publishError
    ? false
    : await waitFor(() => received.some((e) => e.type === 'rpc_response'), ROUNDTRIP_TIMEOUT_MS);
  const roundTripMs = Date.now() - sent;

  const stores = await probeStorage(pool);

  pool.close();

  return {
    url,
    ok: roundTripped,
    connectMs,
    roundTripMs: roundTripped ? roundTripMs : null,
    reason: publishError ?? (roundTripped ? null : 'no round trip within timeout'),
    stores,
    notices,
  };
}

/** Does this relay keep a parked connect code, or only say that it will?
 *
 *  The two pairing paths ask different things of a relay. A QR session is
 *  ephemeral kinds — fanned out to whoever is subscribed and never stored — so a
 *  relay that keeps nothing still carries it. A typed code is kind 4140, a
 *  stored event with a NIP-40 expiry, and it is found by querying for it later.
 *
 *  Accepting and keeping are separate promises, and a relay that makes the first
 *  and not the second is the worst case for this design: the dapp is told the
 *  code is parked, the hub searches the same relay, finds nothing, and neither
 *  screen can tell that from an expired or mistyped code.
 *
 *  So it is published and then read back on the same connection. */
async function probeStorage(pool) {
  const keys = generateKeypair();
  try {
    await pool.publish(buildLookupEvent(keys.secretKey));
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const found = [];
  const unsub = pool.subscribe(
    'probe-lookup',
    [lookupFilter(codeForPubkey(keys.publicKey))],
    (event) => found.push(event),
  );
  const kept = await waitFor(() => found.length > 0, ROUNDTRIP_TIMEOUT_MS);
  unsub();

  return kept ? { ok: true } : { ok: false, reason: 'accepted it, then served nothing back' };
}

console.log(`Probing ${relays.length} relays with ephemeral kind-24140 events\n`);

const results = [];
for (const url of relays) {
  process.stdout.write(`  ${url.padEnd(34)} `);
  try {
    const result = await probe(url);
    results.push(result);
    if (result.ok) {
      // Two verdicts, because the two pairing paths need different things: a QR
      // needs fan-out, a typed code needs storage.
      const codes = result.stores?.ok ? 'codes ok' : `codes NO — ${result.stores?.reason}`;
      console.log(
        `ok    connect ${result.connectMs}ms   round trip ${result.roundTripMs}ms   ${codes}`,
      );
    } else {
      console.log(`FAIL  ${result.reason}`);
    }
    for (const notice of result.notices ?? []) console.log(`      notice: ${notice}`);
  } catch (err) {
    results.push({ url, ok: false, reason: err.message });
    console.log(`ERROR ${err.message}`);
  }
}

const working = results.filter((r) => r.ok);
console.log(`\n${working.length}/${results.length} relays carried the round trip.`);
if (working.length < results.length) {
  console.log(
    'A relay that refuses here while a browser has it open is rate limiting this\n' +
      'address rather than being down — this script probes hard. Leave a minute\n' +
      'between runs, and trust a failure more when it repeats.',
  );
}
if (working.length === 0) {
  console.log('No relay worked. Sessions cannot be established with this relay set.');
  process.exit(1);
}
const keeps = working.filter((r) => r.stores?.ok);
console.log(
  keeps.length > 0
    ? `${keeps.length} of them also keep a parked connect code, which is what a typed\n` +
        'code is found on. A QR pairs fine without it — it is ephemeral and never stored.'
    : 'None of them kept a parked connect code: typed codes will not resolve on this\n' +
        'set, though QR pairing still works.',
);
console.log('A session needs only one, so this set is usable.');
