/** Minimal in-memory nostr relay, enough of NIP-01 to exercise the pool.
 *
 *  Ephemeral kinds (20000..29999) are never stored, matching real relay
 *  behaviour — which is exactly the property the protocol depends on, so the
 *  test transport must reproduce it rather than helpfully buffer.
 *
 *  Everything else IS stored and replayed to later subscribers, for the same
 *  reason: the typed-code path parks a regular kind precisely so a wallet that
 *  subscribes after the fact still finds it. A relay that forgot it would make
 *  that path untestable and, worse, make it look like it worked.
 */

import { WebSocketServer } from 'ws';

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const tagName = key.slice(1);
    const present = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
    if (!values.some((v) => present.includes(v))) return false;
  }
  return true;
}

/** @param {{ store?: boolean }} [options] `store: false` accepts events and
 *  keeps none of them — a relay that says OK and serves nothing back, which is
 *  a real and otherwise invisible failure for the typed-code path. */
export function startRelay({ store = true } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    /** socket -> Map<subId, filters[]> */
    const subs = new Map();
    /** Stored events, oldest first. Ephemeral kinds never land here. */
    const stored = [];
    let published = 0;

    const isEphemeral = (kind) => kind >= 20000 && kind < 30000 || !store;

    wss.on('connection', (socket) => {
      subs.set(socket, new Map());

      socket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;

        if (msg[0] === 'REQ') {
          const [, subId, ...filters] = msg;
          subs.get(socket).set(subId, filters);
          // Stored matches first, then EOSE — a wallet looking up a typed code
          // subscribes long after the dapp parked it.
          for (const event of stored) {
            if (filters.some((f) => matches(f, event))) {
              socket.send(JSON.stringify(['EVENT', subId, event]));
            }
          }
          socket.send(JSON.stringify(['EOSE', subId]));
          return;
        }

        if (msg[0] === 'CLOSE') {
          subs.get(socket)?.delete(msg[1]);
          return;
        }

        if (msg[0] === 'EVENT') {
          const event = msg[1];
          published++;
          socket.send(JSON.stringify(['OK', event.id, true, '']));

          if (!isEphemeral(event.kind) && !stored.some((e) => e.id === event.id)) {
            stored.push(event);
          }

          // Fan out to current subscribers.
          for (const [client, clientSubs] of subs) {
            if (client.readyState !== client.OPEN) continue;
            for (const [subId, filters] of clientSubs) {
              if (filters.some((f) => matches(f, event))) {
                client.send(JSON.stringify(['EVENT', subId, event]));
                break;
              }
            }
          }
        }
      });

      socket.on('close', () => subs.delete(socket));
    });

    wss.on('listening', () => {
      const { port } = wss.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise((done) => wss.close(done)),
        get published() {
          return published;
        },
        dropAllConnections() {
          for (const client of wss.clients) client.terminate();
        },
      });
    });
  });
}
