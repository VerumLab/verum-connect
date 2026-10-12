/**
 * The hub: many dapp sessions, one wallet, exactly one session active. A wallet sheet
 * shows the hub's origin, not the dapp's, so only the session displayed front and
 * centre may raise a prompt: prompting methods dispatch only for it (others queue
 * and show a badge), silent methods answer for every session, switching is
 * user-initiated only (a request never promotes itself), and responses route over
 * the originating session's own channel.
 */

import {
  Channel,
  ERROR_CODES,
  KIND_HANDSHAKE,
  KIND_SESSION,
  RelayPool,
  StorageSnapshot,
  browserStorage,
  buildEvent,
  classifyMethod,
  encrypt,
  decrypt,
  fingerprint,
  generateKeypair,
  isFresh,
  isOriginIsolated,
  conversationKey as makeConversationKey,
  newRequestId,
  parseEnvelope,
  type DappMetadata,
  type Envelope,
  type PairingNomination,
  type NostrEvent,
  type KeyValueStorage,
  type PairingParams,
  type RelayStatus,
  type RpcRequestMessage,
} from '@verumlab/connect-protocol';
import type { Eip1193Provider } from './types.js';

const STORAGE_KEY = 'verum-connect/hub/v1';
/**
 * How long to wait for the dapp to answer a `connect`: well under a second when it
 * is coming, so this tells a dead pairing from a slow one. A dapp already paired
 * elsewhere never replies, so this ends that state.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * How often `connect` is resent: the handshake kind is ephemeral and a
 * backgrounded dapp has no sockets, so repeating makes "be there within twenty
 * seconds" enough.
 */
const CONNECT_RETRY_MS = 2_500;

/**
 * How long to wait for wallet_requestPermissions before assuming it is
 * unimplemented: one that supports it answers as the user does.
 */
const PERMISSION_TIMEOUT_MS = 3_000;

/**
 * How many prompting requests one background session may have waiting: eight
 * covers a legitimate burst while bounding its memory and the backlog of sheets
 * drainPending fires when the user switches to it.
 */
const MAX_PENDING_PER_SESSION = 8;

export type SessionStatus = 'pairing' | 'connected' | 'error';

export interface HubSession {
  /** The dapp's pubkey, stable for the life of the pairing. */
  id: string;
  secretKey: string;
  publicKey: string;
  relays: string[];
  /**
   * How many relays the link named, more than `relays` holds when it named more than
   * a wallet opens: the only visible explanation if a dapp's live relays all sit past
   * the cap.
   */
  relaysNamed: number;
  /**
   * The relay this session narrowed to, kept for display and so a rebuilt pool can
   * re-pin.
   */
  relay?: string;
  metadata: DappMetadata | null;
  /**
   * Where to reach the dapp and which hub build it expects, from `connect_ack`: the
   * code path has no other source, and the mobile handoff needs it.
   */
  nomination: PairingNomination | null;
  code: string[];
  status: SessionStatus;
  error?: string;
  /** Prompting requests received while this session was not active. */
  pending: RpcRequestMessage[];
  connectedAt: number;
  lastActivity: number;
}

interface PersistedSession {
  id: string;
  secretKey: string;
  publicKey: string;
  relays: string[];
  metadata: DappMetadata | null;
  connectedAt: number;
}

export interface HubState {
  sessions: HubSession[];
  activeId: string | null;
  accounts: string[];
  chainId: string;
  walletName: string | null;
  relayStatuses: Record<string, RelayStatus>;
}

export interface HubOptions {
  /**
   * Where paired sessions are kept: localStorage in a browser and nothing elsewhere,
   * so a host with nowhere durable for a secret key does not pretend to resume.
   */
  storage?: KeyValueStorage | null;
}

export class Hub {
  private readonly store: StorageSnapshot;

  private readonly sessions = new Map<string, HubSession>();
  private readonly channels = new Map<string, Channel>();
  /**
   * One relay pool per session; sessions are islands. A shared pool let one dapp's
   * nomination narrow every other session (a hostile dapp could black-hole the rest)
   * and a new session rebuilt it, dropping live sockets.
   */
  private readonly pools = new Map<string, RelayPool>();
  private activeId: string | null = null;

  private wallet: Eip1193Provider | null = null;
  private walletName: string | null = null;
  private accounts: string[] = [];
  private chainId = '0x1';

  private listeners = new Set<(state: HubState) => void>();

  // ------------------------------------------------------------------- wallet

  constructor({ storage = browserStorage() }: HubOptions = {}) {
    this.store = new StorageSnapshot(storage, [STORAGE_KEY]);
  }

  async attachWallet(provider: Eip1193Provider, name: string): Promise<void> {
    // Ask for the permission, not just the accounts: eth_requestAccounts resolves
    // silently when an earlier grant stands, while wallet_requestPermissions reopens
    // the sheet. Bounded, as a wallet without EIP-2255 may neither resolve nor reject;
    // giving up early only loses the guarantee of a fresh prompt.
    const permission = provider
      .request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
      .then(() => null)
      .catch((err: unknown) => err);

    const outcome = await Promise.race([
      permission,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS)),
    ]);

    // A decline ends the attempt; anything else means the method is unsupported.
    if ((outcome as { code?: number } | null)?.code === 4001) throw outcome;

    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const chainId = (await provider.request({ method: 'eth_chainId' })) as string;

    // Committed only once the wallet answered, so a declined prompt never looks like a
    // live connection.
    this.wallet = provider;
    this.walletName = name;
    this.accounts = accounts;
    this.chainId = chainId;

    provider.on?.('accountsChanged', (next: string[]) => {
      if (next.length === 0) {
        this.forgetWallet();
        return;
      }
      this.accounts = next;
      // One wallet behind every session, so every session hears about it.
      this.broadcast({ type: 'event', event: 'accountsChanged', data: next } as Envelope);
      this.notify();
    });

    provider.on?.('chainChanged', (next: string) => {
      // Wallets emit this outside a request (the user switching networks), so it needs
      // the same fan-out as a switch requested by a dapp.
      this.applyChainChange(next);
    });

    this.notify();
  }

  get hasWallet(): boolean {
    return this.wallet !== null;
  }

  /**
   * Open the wallet's own account picker. EIP-1193 has no "set active account", and a
   * hub-local override would claim an account the wallet's sheet does not show.
   */
  async switchAccount(): Promise<void> {
    if (!this.wallet) return;

    try {
      await this.wallet.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      // 4001 is the user closing the picker, not an error.
      if (code === 4001) return;
      if (code === 4200 || code === -32601) {
        await this.wallet.request({ method: 'eth_requestAccounts' });
      } else {
        throw err;
      }
    }

    await this.resyncAccounts();
  }

  /**
   * Forget the wallet and revoke its permission where supported. Sessions stay paired
   * but idle: requests get a clear "no wallet" error and reconnecting revives them.
   */
  async disconnectWallet(): Promise<boolean> {
    if (!this.wallet) return true;

    // Reported, not swallowed: where revoking is unimplemented the wallet keeps the
    // grant, so the user must be told.
    let revoked = true;
    try {
      await this.wallet.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch {
      revoked = false;
    }

    this.forgetWallet();
    return revoked;
  }

  /**
   * Forget the wallet on THIS side with no revoke: for when the wallet reports the
   * disconnect itself (an empty eth_accounts or accountsChanged).
   */
  private forgetWallet(): void {
    this.wallet = null;
    this.walletName = null;
    this.accounts = [];
    // An empty account list is the EIP-1193 disconnect signal, so every paired dapp
    // updates.
    this.broadcast({ type: 'event', event: 'accountsChanged', data: [] } as Envelope);
    this.notify();
  }

  /** Re-read accounts and chain from the wallet and tell every session. */
  private async resyncAccounts(): Promise<void> {
    if (!this.wallet) return;
    const accounts = (await this.wallet.request({ method: 'eth_accounts' })) as string[];

    if (accounts.length === 0) {
      this.forgetWallet();
      return;
    }

    const chainId = (await this.wallet.request({ method: 'eth_chainId' })) as string;

    const changed =
      accounts.length !== this.accounts.length ||
      accounts.some((a, i) => a.toLowerCase() !== (this.accounts[i] ?? '').toLowerCase());

    const chainChanged = chainId !== this.chainId;
    this.accounts = accounts;
    this.chainId = chainId;

    // One wallet sits behind every session, so an account change is global.
    if (changed) {
      this.broadcast({ type: 'event', event: 'accountsChanged', data: accounts } as Envelope);
    }
    if (chainChanged) this.broadcast({ type: 'event', event: 'chainChanged', data: chainId } as Envelope);
    this.notify();
  }

  /**
   * Ask the wallet whether it still has us connected (eth_accounts never prompts),
   * for wallets whose in-app disconnect fires no event; run when the page regains
   * visibility.
   */
  async refreshWallet(): Promise<void> {
    await this.resyncAccounts();
  }

  // ------------------------------------------------------------------ sessions

  /** Pair with a dapp from a scanned QR fragment. */
  async pair(params: PairingParams): Promise<HubSession> {
    const existing = this.sessions.get(params.publicKey);
    if (existing) {
      this.setActive(existing.id);
      return existing;
    }

    const keypair = generateKeypair();
    const convKey = makeConversationKey(keypair.secretKey, params.publicKey);

    const session: HubSession = {
      id: params.publicKey,
      secretKey: keypair.secretKey,
      publicKey: keypair.publicKey,
      relays: params.relays,
      relaysNamed: params.relaysNamed,
      metadata: null,
      nomination: null,
      code: fingerprint(convKey),
      status: 'pairing',
      pending: [],
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(session.id, session);
    // A brand new pairing takes the spotlight: the user just scanned it, so this is
    // user-initiated.
    this.activeId = session.id;
    this.openPool(session);
    this.notify();

    try {
      await this.handshake(session, convKey);
    } catch (err) {
      // A pairing never answered never became a session: drop it so the pair card
      // returns; the thrown error becomes the notice.
      this.sessions.delete(session.id);
      this.channels.get(session.id)?.close();
      this.channels.delete(session.id);
      if (this.activeId === session.id) {
        this.activeId = this.sessions.keys().next().value ?? null;
      }
      this.closePool(session.id);
      this.notify();
      throw err;
    }
    return session;
  }

  /** Send `connect` on the handshake kind and wait for the dapp's ack. */
  private async handshake(session: HubSession, convKey: Uint8Array): Promise<void> {
    const pool = this.pools.get(session.id);
    if (!pool) throw new Error('hub: no relay pool');

    const nonce = newRequestId();
    const subId = `handshake-${session.id.slice(0, 8)}`;

    const acked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('No answer from the dapp. It may have closed or regenerated its code.'));
      }, HANDSHAKE_TIMEOUT_MS);

      const unsub = pool.subscribe(
        subId,
        [{ kinds: [KIND_HANDSHAKE], authors: [session.id], '#p': [session.publicKey] }],
        (event: NostrEvent) => {
          if (!isFresh(event)) return;
          let envelope: Envelope;
          try {
            envelope = parseEnvelope(decrypt(event.content, convKey));
          } catch {
            return;
          }
          if (envelope.type !== 'connect_ack' || envelope.nonce !== nonce) return;

          clearTimeout(timer);
          unsub();
          session.metadata = envelope.metadata;
          session.nomination = envelope.pairing ?? null;

          // Adopt the dapp's nomination: both sides must land on the same host, so it is
          // declared, not inferred. Absent from an older dapp: stay on fan-out.
          if (envelope.relay) {
            session.relay = envelope.relay;
            pool.pin(envelope.relay);
          }

          resolve();
        },
      );
    });

    const connectPayload = JSON.stringify({ type: 'connect', v: 1, nonce });
    const sendConnect = (): Promise<string> =>
      pool.publish(
        // A new event each time: a relay may drop an id it has seen, making every repeat a
        // no-op.
        buildEvent(KIND_HANDSHAKE, encrypt(connectPayload, convKey), session.id, session.secretKey),
      );

    let retry: ReturnType<typeof setInterval> | null = null;
    try {
      await sendConnect();
      retry = setInterval(() => {
        void sendConnect().catch(() => {
          // A relay that will not take it now may take the next; the handshake timeout ends
          // this, not one refusal.
        });
      }, CONNECT_RETRY_MS);
    } catch (err) {
      // The `connect` never left the device, so nothing will answer. Rethrown for pair()
      // to roll back.
      throw new Error(
        err instanceof Error
          ? `Could not reach any relay: ${err.message}`
          : 'Could not reach any relay',
      );
    }

    try {
      await acked;
    } finally {
      if (retry) clearInterval(retry);
    }

    this.openChannel(session);
    session.status = 'connected';
    this.persist();
    this.notify();

    await this.channels.get(session.id)?.send({
      type: 'session_ready',
      accounts: this.accounts,
      chainId: this.chainId,
      wallet: this.walletName ?? undefined,
    } as Envelope);
  }

  /** User-initiated switch. This is the only path that changes the spotlight. */
  setActive(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    this.notify();
    // What the dapp asked for in the background can go to the wallet now it is in
    // front.
    void this.drainPending(id);
  }

  async removeSession(id: string): Promise<void> {
    const channel = this.channels.get(id);
    if (channel) {
      try {
        await channel.send({ type: 'disconnect', reason: 'user disconnected' } as Envelope);
      } catch {
        // The dapp will notice the silence regardless.
      }
      channel.close();
    }
    this.channels.delete(id);
    this.sessions.delete(id);
    this.closePool(id);
    if (this.activeId === id) {
      this.activeId = this.sessions.keys().next().value ?? null;
    }
    this.persist();
    this.notify();
  }

  /**
   * Restore sessions from a previous visit and re-announce presence. Only from an
   * isolated origin: on a path gateway any other CID served there can write the
   * record and hand us a session that arrives already connected, so it is wiped.
   * Await it before pairing: every pairing rewrites the whole list.
   */
  async restore(): Promise<void> {
    await this.store.ready;

    if (!isOriginIsolated()) {
      this.store.remove(STORAGE_KEY);
      return;
    }

    let stored: PersistedSession[];
    try {
      stored = JSON.parse(this.store.get(STORAGE_KEY) ?? '[]') as PersistedSession[];
    } catch {
      return;
    }

    for (const entry of stored) {
      if (!entry.secretKey || !entry.id) continue;
      const convKey = makeConversationKey(entry.secretKey, entry.id);
      this.sessions.set(entry.id, {
        id: entry.id,
        secretKey: entry.secretKey,
        publicKey: entry.publicKey,
        relays: entry.relays,
        // What was persisted is what the session settled on.
        relaysNamed: entry.relays.length,
        metadata: entry.metadata,
        // Not persisted: it exists for the handoff at pairing time.
        nomination: null,
        code: fingerprint(convKey),
        status: 'connected',
        pending: [],
        connectedAt: entry.connectedAt,
        lastActivity: entry.connectedAt,
      });
    }

    if (this.sessions.size > 0) {
      this.activeId = this.sessions.keys().next().value ?? null;
      for (const session of this.sessions.values()) {
        this.openPool(session);
        this.openChannel(session);
      }
      this.notify();
    }
  }

  /**
   * Announce presence on every session. This is the whole reconnect story: the dapp
   * replays its unanswered requests on a `hello`, so nothing is parked on a relay.
   */
  async sayHello(): Promise<void> {
    await Promise.allSettled(
      [...this.channels.values()].map((channel) =>
        channel.send({
          type: 'hello',
          accounts: this.accounts,
          chainId: this.chainId,
        } as Envelope),
      ),
    );
  }

  /** Wired to the reconnect button: drop backoff, reconnect, re-announce. */
  reconnect(): void {
    for (const pool of this.pools.values()) pool.reconnectNow();
    setTimeout(() => void this.sayHello(), 750);
  }

  // ------------------------------------------------------------------ requests

  private openChannel(session: HubSession): void {
    const pool = this.pools.get(session.id);
    if (!pool) return;
    this.channels.get(session.id)?.close();

    const channel = new Channel({
      pool,
      secretKey: session.secretKey,
      publicKey: session.publicKey,
      peerPublicKey: session.id,
      kind: KIND_SESSION,
    });
    channel.onEnvelope((envelope) => void this.handleEnvelope(session.id, envelope));
    channel.open(`session-${session.id.slice(0, 8)}`);
    this.channels.set(session.id, channel);
  }

  private async handleEnvelope(sessionId: string, envelope: Envelope): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivity = Date.now();

    if (envelope.type === 'disconnect') {
      this.channels.get(sessionId)?.close();
      this.channels.delete(sessionId);
      this.sessions.delete(sessionId);
      // As removeSession: otherwise every session a dapp ended left sockets reconnecting
      // for the page's life.
      this.closePool(sessionId);
      if (this.activeId === sessionId) {
        this.activeId = this.sessions.keys().next().value ?? null;
      }
      this.persist();
      this.notify();
      return;
    }

    if (envelope.type !== 'rpc_request') return;

    // The gate: a prompting method from a background session queues, so the sheet the
    // user sees belongs to the session they are looking at.
    if (classifyMethod(envelope.method) === 'prompting' && sessionId !== this.activeId) {
      if (session.pending.length >= MAX_PENDING_PER_SESSION) {
        // Refused, not dropped: an unbounded queue lets a background dapp stack wallet
        // sheets for when the user switches, and answering tells an honest dapp to stop
        // resending.
        await this.respondError(
          sessionId,
          envelope.id,
          ERROR_CODES.internal,
          `hub: too many requests waiting for this session (limit ${MAX_PENDING_PER_SESSION})`,
        );
        return;
      }
      session.pending.push(envelope);
      this.notify();
      return;
    }

    await this.forward(sessionId, envelope);
  }

  /** Answer a request with an error, without involving the wallet. */
  private async respondError(
    sessionId: string,
    id: string,
    code: number,
    message: string,
  ): Promise<void> {
    await this.channels.get(sessionId)?.send({
      type: 'rpc_response',
      id,
      error: { code, message },
    } as Envelope);
  }

  private async forward(sessionId: string, request: RpcRequestMessage): Promise<void> {
    // Routed by the request's own session, never the active one: a switch mid-flight
    // must not redirect a signature.
    const channel = this.channels.get(sessionId);
    if (!channel) return;

    if (!this.wallet) {
      await channel.send({
        type: 'rpc_response',
        id: request.id,
        error: { code: ERROR_CODES.disconnected, message: 'hub: no wallet connected' },
      } as Envelope);
      return;
    }

    try {
      const result = await this.wallet.request({
        method: request.method,
        params: request.params,
      });
      await channel.send({ type: 'rpc_response', id: request.id, result } as Envelope);

      // Chain switches change state for every session, so resync afterwards.
      if (request.method === 'wallet_switchEthereumChain') {
        const chainId = (await this.wallet.request({ method: 'eth_chainId' })) as string;
        this.applyChainChange(chainId);
      }
    } catch (err) {
      const e = err as { code?: number; message?: string };
      await channel.send({
        type: 'rpc_response',
        id: request.id,
        error: {
          code: typeof e.code === 'number' ? e.code : ERROR_CODES.internal,
          message: e.message ?? 'wallet request failed',
        },
      } as Envelope);
    }
  }

  private async drainPending(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.pending.length === 0) return;

    const queued = session.pending.splice(0, session.pending.length);
    this.notify();
    // Sequentially: wallets serialise prompts anyway, and several at once make a stack
    // of sheets nobody can attribute.
    for (const request of queued) {
      await this.forward(sessionId, request);
    }
  }

  /** Apply a wallet network change and announce it to every paired dapp. */
  private applyChainChange(chainId: string): void {
    this.chainId = chainId;
    this.broadcast({ type: 'event', event: 'chainChanged', data: chainId } as Envelope);
    // A hello is a state snapshot, making the change recoverable if a relay reconnects
    // between send and receive.
    void this.sayHello();
    this.notify();
  }

  private broadcast(envelope: Envelope): void {
    for (const channel of this.channels.values()) {
      void channel.send(envelope).catch(() => {
        /* a dead session is reaped by its own disconnect path */
      });
    }
  }

  // ------------------------------------------------------------------- plumbing

  /** Give a session its own pool, replacing any it had; touches no other session. */
  private openPool(session: HubSession): void {
    this.pools.get(session.id)?.close();
    const pool = new RelayPool(session.relays, {
      onStatusChange: () => this.notify(),
      onNotice: (relay, message, kind) =>
        console.warn(`[verum-hub] ${relay} (${kind}): ${message}`),
    });
    this.pools.set(session.id, pool);
    pool.connect();
  }

  private closePool(sessionId: string): void {
    this.pools.get(sessionId)?.close();
    this.pools.delete(sessionId);
  }

  /**
   * Relay status for one session alone: the merged view cannot say which relay a
   * session reaches. Empty for an unknown session.
   */
  relayStatusesFor(sessionId: string): Record<string, RelayStatus> {
    return this.pools.get(sessionId)?.statuses ?? {};
  }

  /**
   * One flat map for the UI, merged across sessions: a relay counts as up if any
   * session has it up.
   */
  private mergedRelayStatuses(): Record<string, RelayStatus> {
    const rank: Record<RelayStatus, number> = { closed: 0, connecting: 1, open: 2 };
    const merged: Record<string, RelayStatus> = {};
    for (const pool of this.pools.values()) {
      for (const [url, status] of Object.entries(pool.statuses)) {
        const seen = merged[url];
        if (!seen || rank[status] > rank[seen]) merged[url] = status;
      }
    }
    return merged;
  }

  private persist(): void {
    // See restore(): on a shared origin these keys are readable by other builds, so
    // they are never written.
    if (!isOriginIsolated()) return;

    const payload: PersistedSession[] = [...this.sessions.values()]
      .filter((s) => s.status === 'connected')
      .map((s) => ({
        id: s.id,
        secretKey: s.secretKey,
        publicKey: s.publicKey,
        relays: s.relays,
        metadata: s.metadata,
        connectedAt: s.connectedAt,
      }));
    // A failed write (quota, private mode) leaves sessions living for this run.
    this.store.set(STORAGE_KEY, JSON.stringify(payload));
  }

  // --------------------------------------------------------------------- state

  subscribe(listener: (state: HubState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get state(): HubState {
    return {
      sessions: [...this.sessions.values()],
      activeId: this.activeId,
      accounts: this.accounts,
      chainId: this.chainId,
      walletName: this.walletName,
      relayStatuses: this.mergedRelayStatuses(),
    };
  }

  private notify(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}
