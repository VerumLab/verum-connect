/**
 * Multi-relay connection pool. Relays are assumed hostile and unreliable: the pool
 * holds N open, publishes to all, accepts an event the moment any delivers it and
 * dedupes by id, so a session survives while one relay is reachable.
 * Subscriptions are replayed on every reconnect.
 */

import { isWellFormed, verifyEvent, type NostrEvent } from './events.js';

export type RelayStatus = 'connecting' | 'open' | 'closed';

export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  '#p'?: string[];
  '#e'?: string[];
}

export type NoticeKind = 'refusal' | 'notice' | 'closed';

export interface PoolEvents {
  onEvent?: (event: NostrEvent, relay: string) => void;
  onStatusChange?: (statuses: Record<string, RelayStatus>) => void;
  /**
   * Anything a relay says about itself. Only `refusal` means an event was rejected;
   * `notice` is chatter (rate limits, maintenance) and `closed` is a subscription
   * ending. Treating all three alike marked good relays as rejecting everything.
   */
  onNotice?: (relay: string, message: string, kind: NoticeKind) => void;
}

interface Subscription {
  id: string;
  filters: Filter[];
  handler: (event: NostrEvent, relay: string) => void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;
/**
 * How long publishToAll waits for relays that have not opened yet. Distinct from
 * the overall timeout: a relay that refuses is done in milliseconds, one that
 * drops packets sits connecting until the OS gives up (measured 10 s), and waiting
 * that long for a fourth relay when three accepted trades a usable answer for
 * breadth. Healthy relays open well under a second (358-1300 ms measured).
 */
const PUBLISH_GATHER_MS = 2_500;
/**
 * How long publish waits for a first socket. Generous: connect times across the
 * default relay set range up to ~8 s.
 */
const CONNECT_WAIT_MS = 12_000;
/**
 * Cap on remembered event ids; it only has to outlive the window in which two
 * relays might deliver the same event.
 */
const SEEN_LIMIT = 2_000;

interface RelayConnection {
  url: string;
  socket: WebSocket | null;
  status: RelayStatus;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class RelayPool {
  private readonly connections = new Map<string, RelayConnection>();
  private readonly subscriptions = new Map<string, Subscription>();
  /**
   * Event id -> the relays that delivered it. A set because the second copy says
   * another relay holds the same event.
   */
  private readonly seen = new Map<string, Set<string>>();
  private readonly pendingPublishes = new Map<string, (relay: string) => void>();
  private readonly events: PoolEvents;
  private closed = false;
  /** Set once a relay is nominated; the others stay closed while it holds. */
  private pinned: string | null = null;

  constructor(urls: string[], events: PoolEvents = {}) {
    this.events = events;
    for (const url of urls) {
      this.connections.set(url, {
        url,
        socket: null,
        status: 'closed',
        attempts: 0,
        reconnectTimer: null,
      });
    }
  }

  get relayUrls(): string[] {
    return [...this.connections.keys()];
  }

  get statuses(): Record<string, RelayStatus> {
    const out: Record<string, RelayStatus> = {};
    for (const [url, conn] of this.connections) out[url] = conn.status;
    return out;
  }

  get connectedCount(): number {
    let n = 0;
    for (const conn of this.connections.values()) if (conn.status === 'open') n++;
    return n;
  }

  connect(): void {
    this.closed = false;
    for (const conn of this.connections.values()) {
      if (conn.status === 'closed') this.openSocket(conn);
    }
  }

  /**
   * Force an immediate reconnect of every down relay, ignoring backoff (the hub's
   * reconnect button).
   */
  reconnectNow(): void {
    this.closed = false;
    for (const conn of this.connections.values()) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      conn.attempts = 0;
      if (conn.status !== 'open') this.openSocket(conn);
    }
  }

  /**
   * Narrow the pool to one relay for the rest of the session. Fan-out exists to find
   * a relay both sides can reach; once one is proven both ways the other sockets are
   * pure cost (8 per session would strain a public relay long before bandwidth).
   * Reversible: unpin() reopens the full set.
   */
  pin(url: string): void {
    if (!this.connections.has(url)) return;
    this.pinned = url;
    for (const conn of this.connections.values()) {
      if (conn.url === url) continue;
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      conn.socket?.close();
      conn.socket = null;
      conn.status = 'closed';
    }
    this.emitStatus();
  }

  /** Return to fan-out. */
  unpin(): void {
    if (!this.pinned) return;
    this.pinned = null;
    this.connect();
  }

  get pinnedRelay(): string | null {
    return this.pinned;
  }

  close(): void {
    this.closed = true;
    for (const conn of this.connections.values()) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      conn.socket?.close();
      conn.socket = null;
      conn.status = 'closed';
    }
    this.subscriptions.clear();
    this.emitStatus();
  }

  subscribe(
    id: string,
    filters: Filter[],
    handler: (event: NostrEvent, relay: string) => void,
  ): () => void {
    const sub: Subscription = { id, filters, handler };
    this.subscriptions.set(id, sub);
    for (const conn of this.connections.values()) {
      if (conn.status === 'open') this.sendReq(conn, sub);
    }
    return () => this.unsubscribe(id);
  }

  unsubscribe(id: string): void {
    if (!this.subscriptions.delete(id)) return;
    for (const conn of this.connections.values()) {
      if (conn.status === 'open') this.send(conn, ['CLOSE', id]);
    }
  }

  /**
   * Resolve once at least one relay is open, or false on timeout. Sockets take
   * hundreds of milliseconds to open (seconds on a slow relay), so a caller that
   * connects and publishes at once needs this, or the first message of a session is
   * thrown away before a socket exists.
   */
  async waitForConnection(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    if (this.connectedCount > 0) return true;
    if (this.closed) return false;

    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
        if (this.connectedCount > 0) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() >= deadline || this.closed) {
          clearInterval(interval);
          resolve(false);
        }
      }, 50);
    });
  }

  /**
   * Publish to every relay; resolves on the first acceptance, since one relay
   * carrying the event is enough and slow ones should not gate the UI.
   */
  async publish(event: NostrEvent): Promise<string> {
    // Wait rather than fail: a caller that just called connect() is the normal
    // case, not an error.
    if (this.connectedCount === 0 && !(await this.waitForConnection())) {
      throw new Error('relay: no relays connected');
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        reject(new Error('relay: publish timed out'));
      }, PUBLISH_TIMEOUT_MS);

      this.pendingPublishes.set(event.id, (relay) => {
        clearTimeout(timer);
        this.pendingPublishes.delete(event.id);
        resolve(relay);
      });

      let sentToAny = false;
      for (const conn of this.connections.values()) {
        if (conn.status === 'open') {
          this.send(conn, ['EVENT', event]);
          sentToAny = true;
        }
      }

      if (!sentToAny) {
        clearTimeout(timer);
        this.pendingPublishes.delete(event.id);
        reject(new Error('relay: no relays connected'));
      }
    });
  }

  /**
   * Publish to every relay and wait for all to answer, resolving with those that
   * accepted. A typed code's parked event is found by searching a fixed discovery
   * set, so it must be on whichever member the wallet can reach, and breadth lets a
   * dapp refuse to show a code that landed on too few relays. Resolves with an empty
   * array rather than throwing: how many carried it is the answer either way.
   */
  async publishToAll(
    event: NostrEvent,
    { timeoutMs = PUBLISH_TIMEOUT_MS, gatherMs = PUBLISH_GATHER_MS } = {},
  ): Promise<string[]> {
    if (this.connectedCount === 0 && !(await this.waitForConnection())) {
      throw new Error('relay: no relays connected');
    }

    return new Promise<string[]>((resolve) => {
      const accepted: string[] = [];
      const sent = new Set<string>();

      const finish = (): void => {
        clearTimeout(timer);
        clearInterval(pump);
        this.pendingPublishes.delete(event.id);
        resolve(accepted);
      };
      // A relay that refuses the event answers OK-false, which never reaches
      // this handler, so the timer is what ends a partially-answered publish.
      const timer = setTimeout(finish, timeoutMs);

      this.pendingPublishes.set(event.id, (relay) => {
        if (!accepted.includes(relay)) accepted.push(relay);
      });

      /**
       * Send to every open relay that has not had it yet, then decide whether anything
       * is outstanding. Repeated, since relays open at their own pace (up to 8 s on the
       * default set): one pass would report a single acceptance for a four-relay set,
       * and a caller with a minimum would wrongly conclude failure.
       */
      const startedAt = Date.now();
      const tick = (): void => {
        for (const conn of this.connections.values()) {
          if (conn.status === 'open' && !sent.has(conn.url)) {
            sent.add(conn.url);
            this.send(conn, ['EVENT', event]);
          }
        }
        // Two waits: a relay we already sent to owes an answer until the hard timeout; one
        // that has not opened is only worth the gather window, beyond which it is a black
        // hole.
        const gathering = Date.now() - startedAt < gatherMs;
        const outstanding = [...this.connections.values()].some(
          (conn) =>
            (gathering && conn.status === 'connecting') ||
            (sent.has(conn.url) && !accepted.includes(conn.url)),
        );
        if (!outstanding) finish();
      };

      const pump = setInterval(tick, 100);
      tick();
    });
  }

  private openSocket(conn: RelayConnection): void {
    if (this.closed) return;

    conn.status = 'connecting';
    this.emitStatus();

    let socket: WebSocket;
    try {
      socket = new WebSocket(conn.url);
    } catch {
      this.scheduleReconnect(conn);
      return;
    }
    conn.socket = socket;

    socket.onopen = () => {
      conn.status = 'open';
      conn.attempts = 0;
      this.emitStatus();
      // Replay every live subscription onto the fresh socket.
      for (const sub of this.subscriptions.values()) this.sendReq(conn, sub);
    };

    socket.onmessage = (msg) => this.handleMessage(conn, msg.data);

    socket.onerror = () => {
      // onclose always follows; reconnect is handled there so it only runs once.
    };

    socket.onclose = () => {
      conn.socket = null;
      const wasOpen = conn.status === 'open';
      conn.status = 'closed';

      // The pinned relay dying is the one failure a narrowed pool cannot ride out, so it
      // widens back to fan-out; the peer does the same, and both work again once any
      // relay overlaps.
      if (this.pinned === conn.url && !this.closed) {
        this.pinned = null;
        this.connect();
      }

      this.emitStatus();
      if (!this.closed) {
        // A socket that never opened counts as a failed attempt for backoff; one
        // that was open and dropped gets a fast first retry.
        if (wasOpen) conn.attempts = 0;
        this.scheduleReconnect(conn);
      }
    };
  }

  private scheduleReconnect(conn: RelayConnection): void {
    if (this.closed || conn.reconnectTimer) return;
    const base = Math.min(INITIAL_BACKOFF_MS * 2 ** conn.attempts, MAX_BACKOFF_MS);
    // Jitter so N relays that dropped together don't reconnect in lockstep.
    const delay = base * (0.5 + Math.random() * 0.5);
    conn.attempts++;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.openSocket(conn);
    }, delay);
  }

  private handleMessage(conn: RelayConnection, raw: unknown): void {
    if (typeof raw !== 'string') return;

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;

    switch (msg[0]) {
      case 'EVENT': {
        const [, subId, event] = msg as [string, string, unknown];
        if (!isWellFormed(event)) return;
        // A duplicate is still evidence: which relays sent a copy is the only way to tell
        // one that keeps what it accepted from one that quietly drops it. Signature
        // checks, the expensive part, still run once.
        if (this.seen.has(event.id)) {
          this.seen.get(event.id)?.add(conn.url);
          return;
        }
        if (!verifyEvent(event)) return;
        this.markSeen(event.id, conn.url);

        this.subscriptions.get(subId)?.handler(event, conn.url);
        this.events.onEvent?.(event, conn.url);
        return;
      }
      case 'OK': {
        const [, eventId, ok, reason] = msg as [string, string, boolean, string?];
        if (ok) {
          this.pendingPublishes.get(eventId)?.(conn.url);
          return;
        }
        // A refusal says why ("blocked: not on the allow list", "restricted: paid relay");
        // throwing that away made every rejection look like a timeout. It is reported per
        // publish because that is how a relay answers, but the reason is usually a
        // standing policy, so the caller counts repeats before showing them.
        this.events.onNotice?.(conn.url, `refused: ${reason ?? 'no reason given'}`, 'refusal');
        return;
      }
      case 'NOTICE': {
        const [, text] = msg as [string, string];
        this.events.onNotice?.(conn.url, String(text), 'notice');
        return;
      }
      case 'CLOSED': {
        const [, subId, reason] = msg as [string, string, string];
        this.events.onNotice?.(conn.url, `subscription ${subId} closed: ${reason}`, 'closed');
        return;
      }
      default:
        return;
    }
  }

  /**
   * Which relays have delivered this event to us, to check that a parked code is
   * held where it was accepted.
   */
  relaysWith(id: string): string[] {
    return [...(this.seen.get(id) ?? [])];
  }

  private markSeen(id: string, url: string): void {
    this.seen.set(id, new Set([url]));
    if (this.seen.size > SEEN_LIMIT) {
      // Maps iterate in insertion order, so this evicts oldest-first.
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  private sendReq(conn: RelayConnection, sub: Subscription): void {
    this.send(conn, ['REQ', sub.id, ...sub.filters]);
  }

  private send(conn: RelayConnection, payload: unknown[]): void {
    if (conn.socket?.readyState !== WebSocket.OPEN) return;
    try {
      conn.socket.send(JSON.stringify(payload));
    } catch {
      // Socket died between the readyState check and the send; onclose handles it.
    }
  }

  private emitStatus(): void {
    this.events.onStatusChange?.(this.statuses);
  }
}
