/** EIP-1193 provider for the dapp side. */

import {
  ARWEAVE_GATEWAYS,
  Channel,
  DEFAULT_GATEWAYS,
  WEBVIEW_SAFE_GATEWAYS,
  DEFAULT_RELAYS,
  ERROR_CODES,
  gatewayLabel,
  resolveArweaveGateway,
  resolveGateway,
  typedRelayUrl,
  KIND_HANDSHAKE,
  KIND_SESSION,
  RelayPool,
  RpcError,
  buildEvent,
  LOOKUP_TTL_SECONDS,
  buildLookupEvent,
  lookupFilter,
  buildLookupRetraction,
  buildPairingUri,
  classifyMethod,
  codeForPubkey,
  DEFAULT_CAP,
  encrypt,
  fingerprint,
  formatCode,
  generateKeypair,
  isChainRead,
  isFresh,
  selectByCode,
  summarizeConnects,
  type PendingConnect,
  conversationKey as makeConversationKey,
  newRequestId,
  nowSeconds,
  parseEnvelope,
  decrypt,
  tagValue,
  type DappMetadata,
  type Envelope,
  type KeyValueStorage,
  type NostrEvent,
  type RelayStatus,
} from '@verumlab/connect-protocol';
import { dappStorage, type DappStorage } from './storage.js';
import { Eip1193Surface, localAnswer } from './surface.js';

const REQUEST_TIMEOUT_MS = 180_000;
const HANDSHAKE_SUB = 'verum-handshake';
const CODE_HANDSHAKE_SUB = 'verum-code-handshake';
const SESSION_SUB = 'verum-session';

/**
 * One relay carrying the parked fragment is enough to show the code, the same bar
 * as the QR path (the code fingerprints the key).
 */
const CODE_VERIFY_MS = 3000;

/**
 * A connect on the typed-code pairing, held rather than accepted. Nonce and relay
 * are kept for the ack, sent once the user selects.
 */
interface HeldConnect {
  publicKey: string;
  nonce: string;
  relay: string;
}

export type PairingCodeStatus = 'none' | 'publishing' | 'ready' | 'failed' | 'flooded';

interface CodePairing {
  keypair: { secretKey: string; publicKey: string };
  code: string;
  /** The relays that accepted the parked event and served it back. */
  relays: string[];
  /** Said OK, then had nothing when asked: green dot, no refusal, no code. */
  dropped: string[];
  eventId: string | null;
  /** When parked, in ms. Nothing else tells a UI that a displayed code has expired. */
  parkedAt: number;
  held: HeldConnect[];
  /**
   * Events accepted for decryption on this code. Bounded apart from `held`, which an
   * unparseable sender never reaches.
   */
  attempts: number;
  unsub: (() => void) | null;
}

/**
 * Decryption attempts allowed per code before it is burnt: each is an ECDH against
 * a published pubkey, so only this stops them being unlimited.
 */
const CODE_ATTEMPT_BUDGET = DEFAULT_CAP * 10;

export interface VerumConnectOptions {
  /**
   * The hub's CID. Preferred over `hubUrl`: it pins what the hub is and leaves where
   * to fetch it to the user.
   */
  hubCid?: string;
  /**
   * The hub's Arweave transaction id for the same build. Preferred when present: its
   * gateways give a per-build origin without a service worker. The CID stays as the
   * independent second route.
   */
  hubTx?: string;
  arweaveGateways?: string[];
  gateways?: string[];
  /**
   * Gateways for the hub URL a phone opens, `{cid}` substituted; default
   * WEBVIEW_SAFE_GATEWAYS. Separate because a WebView has no service worker, so every
   * entry must serve bytes directly. Travels in the pairing link, so a release can
   * change it with no hub redeploy.
   */
  webviewGateways?: string[];
  /**
   * Fixed hub URL: locks every user onto one gateway with no recovery. Prefer
   * `hubCid`.
   */
  hubUrl?: string;
  metadata: DappMetadata;
  /**
   * Relays this dapp pairs on; default DEFAULT_RELAYS. Travels in the pairing link,
   * so a release changes every new pairing. A user's `setRelays()` choice outranks it
   * and persists.
   */
  relays?: string[];
  /**
   * Chain reads answered here, keyed by chain id ("0x1"). Without an entry the method
   * is refused, not sent through the wallet.
   */
  rpcUrls?: Record<string, string>;
  chains?: string[];
  /**
   * Where the session key and the user's choices are kept: localStorage by default,
   * `null` keeps nothing. Reads before `ready` see the defaults.
   */
  storage?: KeyValueStorage | null;
}

type ProviderEvent =
  | 'connect'
  | 'disconnect'
  | 'accountsChanged'
  | 'chainChanged'
  | 'display_uri'
  | 'session_changed'
  | 'code_changed'
  | 'pending_connects_changed'
  | 'azguard_event';

interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

export type HubNetwork = 'arweave' | 'ipfs';

/**
 * Arweave when the dapp published a transaction and the user has not chosen
 * otherwise (a per-build origin WebViews can load); IPFS otherwise.
 */
export function resolveNetwork(
  options: VerumConnectOptions,
  stored: string | null = dappStorage(options.storage).loadNetwork(),
): HubNetwork {
  if (!options.hubTx) return 'ipfs';
  if (!options.hubCid) return 'arweave';
  return stored === 'ipfs' ? 'ipfs' : 'arweave';
}

/**
 * The hub URL for a real browser (the pairing link's gateway). Standalone: wallet
 * definitions are built before any provider exists.
 */
export function resolveHub(
  options: VerumConnectOptions,
  gateway: string | null = dappStorage(options.storage).loadGateway() ?? options.gateways?.[0] ?? null,
  network: HubNetwork = resolveNetwork(options),
  arweaveGateway: string | null = null,
): string {
  if (options.hubUrl) return options.hubUrl;
  if (network === 'arweave') {
    const chosen =
      arweaveGateway ??
      dappStorage(options.storage).loadArweaveGateway() ??
      options.arweaveGateways?.[0] ??
      ARWEAVE_GATEWAYS[0]!;
    return resolveArweaveGateway(chosen, options.hubTx!);
  }
  return resolveGateway(gateway ?? DEFAULT_GATEWAYS[0]!, options.hubCid!);
}

/**
 * The hub URL for a wallet's in-app browser. Not the pairing gateway: a verifying
 * one needs a service worker WebViews lack. Standalone for the same reason as above.
 */
export function resolveWebviewHub(
  options: VerumConnectOptions,
  webviewGateway: string | null = dappStorage(options.storage).loadWebviewGateway(),
  gateway: string | null = dappStorage(options.storage).loadGateway() ?? options.gateways?.[0] ?? null,
  network: HubNetwork = resolveNetwork(options),
  arweaveWebviewGateway: string | null = null,
): string {
  if (options.hubUrl) return options.hubUrl;
  // On Arweave one gateway is both isolated and WebView-loadable, so there is no
  // split.
  if (network === 'arweave') {
    const stored = dappStorage(options.storage);
    const chosen =
      arweaveWebviewGateway ??
      stored.loadArweaveWebviewGateway() ??
      stored.loadArweaveGateway() ??
      options.arweaveGateways?.[0] ??
      ARWEAVE_GATEWAYS[0]!;
    return resolveArweaveGateway(chosen, options.hubTx!);
  }
  const cid = options.hubCid!;
  if (webviewGateway) return resolveGateway(webviewGateway, cid);
  // A user who supplied their own gateway meant it everywhere, including here.
  if (gateway && !DEFAULT_GATEWAYS.includes(gateway)) return resolveGateway(gateway, cid);
  return resolveGateway(options.webviewGateways?.[0] ?? WEBVIEW_SAFE_GATEWAYS[0]!, cid);
}

export class VerumConnectProvider extends Eip1193Surface<ProviderEvent> {
  private readonly options: VerumConnectOptions;
  private relays: string[];
  private readonly defaultRelays: string[];
  /** The last refusal each relay gave, by relay. */
  private notices: Record<string, string> = {};
  private noticeCounts: Record<string, number> = {};
  private readonly pending = new Map<string, PendingRequest>();

  private pool: RelayPool | null = null;
  private channel: Channel | null = null;
  private keypair: { secretKey: string; publicKey: string } | null = null;
  /**
   * Locked once a hub has paired: a second `connect` on the same QR is dropped, or a
   * photographed QR could pair alongside the real hub.
   */
  private peerPublicKey: string | null = null;
  private handshakeUnsub: (() => void) | null = null;
  /**
   * The typed-code pairing's own keypair: its pubkey is published, so anyone can
   * connect to it to deny the pairing, which must not reach the QR.
   */
  private codePairing: CodePairing | null = null;
  private codeStatus: PairingCodeStatus = 'none';

  private accounts: string[] = [];
  private chainId = '0x1';
  private connected = false;
  private pairingUri: string | null = null;
  private gatewayList: string[];
  /** The dapp defaults in force when the user last overrode the relay set, or null. */
  private storedPreset: string[] | null = null;
  /** Whether the gateway probe has already run for this page load. */
  private gatewayProbed = false;
  private selectedNetwork: HubNetwork;
  private selectedArweaveGateway: string | null;
  private selectedArweaveWebviewGateway: string | null;
  /** Whether the gateway was chosen by the user rather than defaulted to. */
  private userChoseGateway: boolean;
  private selectedGateway: string | null;
  /**
   * Where the phone is sent, apart from selectedGateway: a WebView needs a plain path
   * gateway.
   */
  private selectedWebviewGateway: string | null;

  private readonly store: DappStorage;

  /**
   * Resolves once stored choices and any saved session are read; until then the
   * dapp's defaults apply.
   */
  readonly ready: Promise<void>;

  constructor(options: VerumConnectOptions) {
    super();
    if (!options.hubCid && !options.hubTx && !options.hubUrl) {
      throw new Error('verum: one of hubCid, hubTx or hubUrl is required');
    }
    this.options = options;
    this.defaultRelays = options.relays ?? DEFAULT_RELAYS;
    this.gatewayList = options.gateways ?? DEFAULT_GATEWAYS;
    this.store = dappStorage(options.storage);

    this.relays = this.defaultRelays;
    this.userChoseGateway = false;
    this.selectedGateway = null;
    this.selectedNetwork = resolveNetwork(options, null);
    this.selectedArweaveGateway = null;
    this.selectedArweaveWebviewGateway = null;
    this.selectedWebviewGateway = null;
    this.applyStored();
    this.ready = this.store.ready.then(() => {
      if (this.applyStored()) this.emit('session_changed', undefined);
    });
  }

  private applyStored(): boolean {
    const before = this.preferenceSignature();

    const storedRelays = this.store.loadRelays();
    this.relays = storedRelays?.urls ?? this.defaultRelays;
    this.storedPreset = storedRelays?.preset ?? null;
    const storedGateway = this.store.loadGateway();
    this.userChoseGateway = storedGateway !== null;
    this.selectedGateway = storedGateway ?? this.gatewayList[0] ?? null;
    this.selectedNetwork = resolveNetwork(this.options, this.store.loadNetwork());
    this.selectedArweaveGateway = this.store.loadArweaveGateway();
    this.selectedArweaveWebviewGateway = this.store.loadArweaveWebviewGateway();
    this.selectedWebviewGateway = this.store.loadWebviewGateway();

    return this.preferenceSignature() !== before;
  }

  private preferenceSignature(): string {
    return JSON.stringify([
      this.relays,
      this.selectedGateway,
      this.selectedNetwork,
      this.selectedArweaveGateway,
      this.selectedArweaveWebviewGateway,
      this.selectedWebviewGateway,
    ]);
  }

  // ------------------------------------------------------------------ gateways

  // -------------------------------------------------------------------- relays

  /** The relays this dapp will pair on. */
  get relayUrls(): string[] {
    return [...this.relays];
  }

  /** The build's own defaults, for a "reset" affordance. */
  get defaultRelayUrls(): string[] {
    return [...this.defaultRelays];
  }

  /**
   * Choose the relays to pair on. This is the routing: both sides must share one, so
   * the set travels in the pairing URI. Invalidates any code on screen; call pair()
   * after.
   */
  setRelays(urls: string[]): void {
    const cleaned = urls.map((u) => u.trim()).filter(Boolean).map(typedRelayUrl);
    if (cleaned.length === 0) throw new Error('verum: at least one relay required');
    for (const url of cleaned) {
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        throw new Error(`verum: relay must be a websocket url: ${url}`);
      }
    }
    this.relays = cleaned;
    this.storedPreset = [...this.defaultRelays];
    this.store.saveRelays(cleaned, this.storedPreset);
  }

  get relayPresetChanged(): boolean {
    if (!this.storedPreset) return false;
    const before = new Set(this.storedPreset);
    const now = new Set(this.defaultRelays);
    if (before.size !== now.size) return true;
    for (const url of now) if (!before.has(url)) return true;
    return false;
  }

  resetRelays(): string[] {
    const preset = new Set(this.storedPreset ?? []);
    const added = this.relays.filter((u) => !preset.has(u) && !this.defaultRelays.includes(u));
    const next = [...this.defaultRelays, ...added];
    this.setRelays(next);
    return next;
  }

  // ------------------------------------------------------------------ network

  /** Whether the hub is fetched over Arweave or IPFS. */
  get network(): HubNetwork {
    return this.selectedNetwork;
  }

  /** True when the dapp published both, so switching is meaningful. */
  get canSwitchNetwork(): boolean {
    return Boolean(this.options.hubTx && this.options.hubCid && !this.options.hubUrl);
  }

  setNetwork(network: HubNetwork): void {
    if (network === 'arweave' && !this.options.hubTx) {
      throw new Error('verum: no arweave transaction was published for this hub');
    }
    if (network === 'ipfs' && !this.options.hubCid) {
      throw new Error('verum: no cid was published for this hub');
    }
    this.selectedNetwork = network;
    this.store.saveNetwork(network);
    this.refreshPairingUri();
    this.emit('session_changed', undefined);
  }

  /** Arweave gateways on offer. Empty unless the dapp published a transaction. */
  get arweaveGateways(): string[] {
    if (!this.options.hubTx) return [];
    const list = [...(this.options.arweaveGateways ?? ARWEAVE_GATEWAYS)];
    for (const chosen of [this.selectedArweaveGateway, this.selectedArweaveWebviewGateway]) {
      if (chosen && !list.includes(chosen)) list.push(chosen);
    }
    return list;
  }

  get arweaveGateway(): string | null {
    if (!this.options.hubTx) return null;
    return this.selectedArweaveGateway ?? this.options.arweaveGateways?.[0] ?? ARWEAVE_GATEWAYS[0]!;
  }

  setArweaveGateway(template: string): void {
    this.selectedArweaveGateway = template;
    this.store.saveArweaveGateway(template);
    this.refreshPairingUri();
    this.emit('session_changed', undefined);
  }

  get arweaveWebviewGateway(): string | null {
    if (!this.options.hubTx) return null;
    return this.selectedArweaveWebviewGateway ?? this.arweaveGateway;
  }

  setArweaveWebviewGateway(template: string): void {
    this.selectedArweaveWebviewGateway = template;
    this.store.saveArweaveWebviewGateway(template);
    this.refreshPairingUri();
    this.emit('session_changed', undefined);
  }

  /** Gateway templates on offer. Empty when a fixed `hubUrl` was given. */
  get gateways(): string[] {
    return this.options.hubCid ? [...this.gatewayList] : [];
  }

  /** The gateway template currently in use. */
  get gateway(): string | null {
    return this.options.hubCid ? this.selectedGateway : null;
  }

  /**
   * Point at a different gateway, e.g. a local node. Persisted; applies on the next
   * pair().
   */
  setGateway(template: string): void {
    if (!this.options.hubCid) {
      throw new Error('verum: gateway selection needs hubCid, not a fixed hubUrl');
    }
    this.selectedGateway = template;
    this.userChoseGateway = true;
    if (!this.gatewayList.includes(template)) this.gatewayList = [...this.gatewayList, template];
    this.store.saveGateway(template);
    this.emit('session_changed', undefined);
  }

  /**
   * For a wallet's in-app browser; not `resolvedHubUrl`, which may need a service
   * worker.
   */
  get webviewHubUrl(): string {
    return resolveWebviewHub(
      this.options,
      this.selectedWebviewGateway,
      this.selectedGateway,
      this.selectedNetwork,
      this.selectedArweaveWebviewGateway ?? this.selectedArweaveGateway,
    );
  }

  get webviewGateways(): string[] {
    if (!this.options.hubCid) return [];
    const list = [...(this.options.webviewGateways ?? WEBVIEW_SAFE_GATEWAYS)];
    const chosen = this.selectedWebviewGateway;
    if (chosen && !list.includes(chosen)) list.push(chosen);
    return list;
  }

  /** The gateway template the phone is currently sent to. */
  get webviewGateway(): string | null {
    if (!this.options.hubCid) return null;
    return (
      this.selectedWebviewGateway ??
      this.options.webviewGateways?.[0] ??
      WEBVIEW_SAFE_GATEWAYS[0]!
    );
  }

  setWebviewGateway(template: string): void {
    if (!this.options.hubCid) {
      throw new Error('verum: gateway selection needs hubCid, not a fixed hubUrl');
    }
    this.selectedWebviewGateway = template;
    this.store.saveWebviewGateway(template);
    this.refreshPairingUri();
    this.emit('session_changed', undefined);
  }

  /**
   * Rebuild the link in place. Not pair(): a new keypair would invalidate a code that
   * may already be scanned.
   */
  private refreshPairingUri(): void {
    if (!this.keypair || !this.pairingUri) return;

    this.pairingUri = this.buildUri(this.keypair.publicKey);
    this.emit('display_uri', this.pairingUri);
    // No re-park: the parked event names only the key; the rest reaches the hub in
    // `connect_ack`.
  }

  /** The pairing link for a key, from the current relay set and config. */
  private buildUri(publicKey: string): string {
    return buildPairingUri({
      hubUrl: this.resolvedHubUrl,
      publicKey,
      relays: this.relays,
      cid: this.options.hubCid,
      tx: this.options.hubTx,
      // The dapp tells the hub where to send a phone; the hub's own copy would be frozen
      // in an immutable build.
      webviewUrl: this.webviewHubUrl,
    });
  }

  // ------------------------------------------------------- typed pairing code

  /**
   * Offer a typed pairing code alongside the QR; call after `pair()`. Parks an empty
   * signed event under a code fingerprinting its own keypair and holds connects for
   * the user to choose between. Throws rather than show a code the wallet may not
   * find.
   */
  async offerPairingCode(): Promise<string> {
    if (!this.pool) throw new Error('verum: call pair() before offerPairingCode()');
    await this.retractPairingCode();
    this.clearCodePairing();
    this.codeStatus = 'publishing';
    this.emit('code_changed', null);

    const keypair = generateKeypair();
    const parked = buildLookupEvent(keypair.secretKey);
    let accepted: string[];
    try {
      accepted = await this.pool.publishToAll(parked);
    } catch (err) {
      this.codeStatus = 'failed';
      this.emit('code_changed', null);
      throw err;
    }
    if (accepted.length === 0) {
      this.codeStatus = 'failed';
      this.emit('code_changed', null);
      throw new Error('verum: no relay accepted the pairing code. Use the QR instead.');
    }

    const code = codeForPubkey(keypair.publicKey);
    this.codePairing = {
      keypair,
      code,
      // Where it demonstrably is. Starts as the relays that said yes and narrows to those
      // that serve it back: accepting and keeping are separate promises. See verifyParked.
      relays: accepted,
      dropped: [],
      eventId: parked.id,
      parkedAt: Date.now(),
      held: [],
      attempts: 0,
      unsub: null,
    };
    this.codeStatus = 'ready';
    this.listenForCodeConnects();
    this.emit('code_changed', formatCode(code));
    void this.verifyParked(code);
    return formatCode(code);
  }

  private async verifyParked(code: string): Promise<void> {
    const pairing = this.codePairing;
    if (!pairing || !this.pool) return;

    const unsub = this.pool.subscribe('verum-code-verify', [lookupFilter(code)], () => {
    });

    await new Promise((resolve) => setTimeout(resolve, CODE_VERIFY_MS));
    unsub();

    const served = new Set(pairing.eventId ? this.pool.relaysWith(pairing.eventId) : []);

    // Still the same pairing? A refresh during the wait owns the field now.
    if (this.codePairing !== pairing) return;

    const kept = pairing.relays.filter((url) => served.has(url));
    if (kept.length === pairing.relays.length) return;

    if (kept.length === 0) {
      console.warn(
        '[verum-connect] no relay served the parked code back; a typed code will not resolve',
        pairing.relays,
      );
    } else {
      console.warn(
        '[verum-connect] some relays accepted the code without keeping it:',
        pairing.relays.filter((url) => !served.has(url)),
      );
    }
    pairing.dropped = pairing.relays.filter((url) => !served.has(url));
    pairing.relays = kept;
    this.emit('code_changed', formatCode(pairing.code));
  }

  /** The code currently on offer, grouped for display, or null. */
  get pairingCode(): string | null {
    return this.codePairing ? formatCode(this.codePairing.code) : null;
  }

  get pairingCodeStatus(): PairingCodeStatus {
    return this.codeStatus;
  }

  /**
   * When the code stops resolving, in ms, or null. Exposed because nothing else shows
   * that a displayed code is dead.
   */
  get pairingCodeExpiresAt(): number | null {
    if (!this.codePairing) return null;
    return this.codePairing.parkedAt + LOOKUP_TTL_SECONDS * 1_000;
  }

  /** When the current code was parked, in ms, or null if none is offered. */
  get pairingCodeRelays(): string[] {
    return [...(this.codePairing?.relays ?? [])];
  }

  /** Accepted the code, then did not have it: silent, and looks like a working relay. */
  get pairingCodeDropped(): string[] {
    return [...(this.codePairing?.dropped ?? [])];
  }

  get pairingCodeParkedAt(): number | null {
    return this.codePairing?.parkedAt ?? null;
  }

  /**
   * Wallets asking to connect on the code pairing, each with its session code. Throws
   * `ConnectAmbiguityError` on two identical codes: drop the code and route to the QR.
   */
  get pendingConnects(): PendingConnect[] {
    if (!this.codePairing) return [];
    return summarizeConnects(
      this.codePairing.keypair.secretKey,
      this.codePairing.held.map((h) => h.publicKey),
    );
  }

  /**
   * Commit to the wallet showing this session code. The selection is the commit
   * point; no timer can stand in. False when nothing matches yet.
   */
  async selectPendingConnect(walletCode: string): Promise<boolean> {
    if (this.peerPublicKey) return false;

    const pairing = this.codePairing;
    if (!pairing) return false;

    const chosen = selectByCode(this.pendingConnects, walletCode);
    if (!chosen) return false;

    const held = pairing.held.find((h) => h.publicKey === chosen);
    if (!held) return false;

    // Ask relays to drop the parked code before the pairing is cleared: only this
    // keypair can sign the retraction. Signed and sent now but not waited for: it is
    // advisory (the expiry still applies), and waiting held the choice for seconds.
    void this.retractPairingCode();

    // The winning path's keypair becomes the session keypair; every other pairing is
    // dropped.
    this.keypair = pairing.keypair;
    this.peerPublicKey = chosen;
    this.handshakeUnsub?.();
    this.handshakeUnsub = null;
    pairing.unsub?.();
    pairing.unsub = null;
    this.codePairing = null;

    const convKey = makeConversationKey(pairing.keypair.secretKey, chosen);
    this.openSessionChannel();
    await this.sendConnectAck(pairing.keypair.secretKey, chosen, convKey, held.nonce, held.relay);

    this.emit('code_changed', null);
    this.emit('session_changed', { code: fingerprint(convKey) });
    return true;
  }

  /**
   * Ask relays to drop what was parked. Needs the pairing keypair, so run before
   * teardown. Short timeout: a courtesy, since the expiry bounds a stale code.
   */
  private async retractPairingCode(): Promise<void> {
    const pairing = this.codePairing;
    if (!pairing || !this.pool || !pairing.eventId) return;
    const id = pairing.eventId;
    pairing.eventId = null;
    try {
      await this.pool.publishToAll(buildLookupRetraction(pairing.keypair.secretKey, id), {
        timeoutMs: 2_000,
        gatherMs: 0,
      });
    } catch {
      // Advisory anyway, and the expiry still applies.
    }
  }

  /** Withdraw the code without touching the QR pairing. */
  clearCodePairing(): void {
    if (!this.codePairing) return;
    void this.retractPairingCode();
    this.codePairing.unsub?.();
    this.codePairing = null;
    this.codeStatus = 'none';
    this.emit('code_changed', null);
  }

  /**
   * Drop a code flooded past what the user could select from. Terminal, not
   * throttled: unsubscribing makes the cost finite. Distinct from `failed`: the code
   * is spent, so the user should take the QR.
   */
  private burnFloodedCode(): void {
    const pairing = this.codePairing;
    if (!pairing) return;
    void this.retractPairingCode();
    pairing.unsub?.();
    this.codePairing = null;
    this.codeStatus = 'flooded';
    this.emit('code_changed', null);
  }

  /**
   * Hold connects instead of locking to the first: the pubkey is published, so an
   * attacker connects before a human reads the code.
   */
  private listenForCodeConnects(): void {
    const pairing = this.codePairing;
    if (!this.pool || !pairing) return;

    pairing.unsub = this.pool.subscribe(
      CODE_HANDSHAKE_SUB,
      [{ kinds: [KIND_HANDSHAKE], '#p': [pairing.keypair.publicKey], since: nowSeconds() - 60 }],
      (event, relay) => {
        if (tagValue(event, 'p') !== pairing.keypair.publicKey) return;
        if (!isFresh(event)) return;

        // Repeats are ordinary (reconnects, fan-out). Keep the first; check before
        // decrypting, as each repeat would cost an ECDH.
        if (pairing.held.some((h) => h.publicKey === event.pubkey)) return;

        if (pairing.held.length >= DEFAULT_CAP || pairing.attempts >= CODE_ATTEMPT_BUDGET) {
          this.burnFloodedCode();
          return;
        }
        pairing.attempts += 1;

        let envelope: Envelope;
        try {
          const convKey = makeConversationKey(pairing.keypair.secretKey, event.pubkey);
          envelope = parseEnvelope(decrypt(event.content, convKey));
        } catch {
          return;
        }
        if (envelope.type !== 'connect') return;

        pairing.held.push({ publicKey: event.pubkey, nonce: envelope.nonce, relay });
        this.emit('pending_connects_changed', pairing.held.length);
      },
    );
  }

  /** The hub URL the QR will point at, given the current gateway choice. */
  get resolvedHubUrl(): string {
    return resolveHub(
      this.options,
      this.selectedGateway,
      this.selectedNetwork,
      this.selectedArweaveGateway,
    );
  }

  /**
   * The same link on every other gateway, so a user can switch without a rebuild;
   * only the host differs.
   */
  alternateUris(): { gateway: string; label: string; uri: string }[] {
    if (!this.options.hubCid) return [];
    const hash = this.pairingUri?.indexOf('#') ?? -1;
    const fragment = hash === -1 ? '' : this.pairingUri!.slice(hash);
    return this.gatewayList.map((template) => ({
      gateway: template,
      label: gatewayLabel(template),
      uri: resolveGateway(template, this.options.hubCid!).split('#')[0]! + fragment,
    }));
  }

  /**
   * Best-effort liveness check, never a hard gate: gateways often omit CORS, and a
   * cold cache can answer 504 for seconds. A failed probe demotes a gateway, never
   * the set.
   */
  private async probeGateway(url: string, timeoutMs = 8000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      // A gateway that bounces elsewhere is not the one asked for. Compared by host, not
      // name.
      const asked = new URL(url).host;
      const landed = new URL(response.url || url).host;
      if (asked !== landed) return false;
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pick a gateway that answers, preferring the user's. Once per page load, as the
   * probe costs up to its timeout.
   */
  private async chooseGateway(): Promise<void> {
    const cid = this.options.hubCid;
    if (!cid || this.gatewayProbed) return;
    this.gatewayProbed = true;

    // An explicit choice is not second-guessed: probing is a guess, and overriding with
    // it made the setting look unsaved.
    if (this.userChoseGateway) return;

    const ordered = this.selectedGateway
      ? [this.selectedGateway, ...this.gatewayList.filter((g) => g !== this.selectedGateway)]
      : [...this.gatewayList];

    const results = await Promise.all(
      ordered.map(async (template) => ({
        template,
        alive: await this.probeGateway(resolveGateway(template, cid)),
      })),
    );

    const firstAlive = results.find((r) => r.alive);
    if (firstAlive) {
      this.selectedGateway = firstAlive.template;
    } else {
      console.warn('[verum-connect] no gateway answered a probe; using', this.selectedGateway);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async restore(): Promise<boolean> {
    await this.ready;
    const stored = this.store.loadSession();
    if (!stored) return false;

    this.keypair = { secretKey: stored.secretKey, publicKey: stored.publicKey };
    this.peerPublicKey = stored.peerPublicKey;
    this.accounts = stored.accounts;
    this.chainId = stored.chainId;

    this.openPool(stored.relays);
    this.openSessionChannel();
    this.connected = true;
    this.emit('connect', { chainId: this.chainId });
    return true;
  }

  /**
   * Mint a fresh pairing and return the URI for the QR. A new keypair each call, so
   * regenerating really invalidates the old QR.
   */
  async pair(): Promise<string> {
    await this.ready;
    // Before teardown, which discards the keypair the retraction needs.
    await this.retractPairingCode();
    this.teardown();
    this.store.clearSession();
    this.store.clearPending();
    this.accounts = [];
    this.connected = false;

    this.keypair = generateKeypair();
    this.openPool(this.relays);

    await this.chooseGateway();

    this.pairingUri = this.buildUri(this.keypair.publicKey);

    this.store.savePending({
      secretKey: this.keypair.secretKey,
      publicKey: this.keypair.publicKey,
      relays: this.relays,
      createdAt: Date.now(),
    });

    this.listenForHandshake();
    this.emit('display_uri', this.pairingUri);
    return this.pairingUri;
  }

  /**
   * Pick a minted-but-unanswered pairing back up after a reload; the live URI, or
   * null. Key and relays are the stored ones, but the hub address and build are
   * rebuilt from current config. Try restore() first.
   */
  async resumePairing(): Promise<string | null> {
    await this.ready;
    if (this.connected) return null;
    const pending = this.store.loadPending();
    if (!pending) return null;

    this.teardown();
    this.keypair = { secretKey: pending.secretKey, publicKey: pending.publicKey };
    this.relays = pending.relays;
    this.pairingUri = this.buildUri(pending.publicKey);

    this.openPool(this.relays);
    // From when it was minted: the handshake may have arrived while the tab was
    // discarded.
    this.listenForHandshake(Math.floor(pending.createdAt / 1000) - 60);
    this.emit('display_uri', this.pairingUri);
    return this.pairingUri;
  }

  /**
   * Resolves once a hub has paired and handed over accounts. Rejects on timeout and
   * on disconnect() while waiting, with 4001 (user rejected) rather than a spinner.
   */
  waitForSession(timeoutMs = 300_000): Promise<{ accounts: string[]; chainId: string }> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve({ accounts: this.accounts, chainId: this.chainId });
        return;
      }
      const stop = () => {
        clearTimeout(timer);
        offConnect();
        offDisconnect();
      };

      const timer = setTimeout(() => {
        stop();
        reject(new RpcError(ERROR_CODES.timeout, 'verum: pairing timed out'));
      }, timeoutMs);

      const offConnect = this.on('connect', () => {
        stop();
        resolve({ accounts: this.accounts, chainId: this.chainId });
      });

      const offDisconnect = this.on('disconnect', () => {
        stop();
        reject(new RpcError(ERROR_CODES.userRejected, 'verum: pairing cancelled'));
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.send({ type: 'disconnect', reason: 'dapp disconnected' } as Envelope);
      } catch {
        // Best effort: the hub will time the session out regardless.
      }
    }
    await this.retractPairingCode();
    this.teardown();
    this.store.clearSession();
    this.store.clearPending();
    this.accounts = [];
    this.connected = false;
    this.emit('disconnect', new RpcError(ERROR_CODES.disconnected, 'disconnected'));
    this.emit('accountsChanged', []);
  }

  // ------------------------------------------------------------------ EIP-1193

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const method = args.method;
    const params = args.params ?? [];

    // Answered from session state. Never leaves the page.
    const local = localAnswer(method, this.chainId, this.accounts);
    if (local) return local.value;
    if (method === 'eth_requestAccounts' && this.connected) return this.accounts;

    if (isChainRead(method)) {
      return this.chainRead(method, params);
    }

    if (!this.channel || !this.peerPublicKey) {
      throw new RpcError(ERROR_CODES.disconnected, 'verum: no session');
    }
    if (classifyMethod(method) === 'local') {
      throw new RpcError(ERROR_CODES.methodNotFound, `verum: ${method} unsupported`);
    }

    return this.dispatch(method, params);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentAccounts(): string[] {
    return [...this.accounts];
  }

  get currentChainId(): string {
    return this.chainId;
  }

  get uri(): string | null {
    return this.pairingUri;
  }

  /**
   * Emit `display_uri` again for the pairing on offer, for selectors that wait on
   * `once('display_uri')` each time: re-pairing would instead kill the code being
   * read.
   */
  reannounceUri(): void {
    if (this.pairingUri) this.emit('display_uri', this.pairingUri);
  }

  /** Session code to display beside the QR, once a hub has paired. */
  get sessionCode(): string[] | null {
    return this.channel ? this.channel.fingerprint : null;
  }

  get isPaired(): boolean {
    return this.peerPublicKey !== null;
  }

  /**
   * The last refusal each relay gave, so a UI need not show a green dot beside a
   * relay dropping everything.
   */
  get relayNotices(): Record<string, string> {
    return { ...this.notices };
  }

  get relayStatuses(): Record<string, RelayStatus> {
    return this.pool?.statuses ?? {};
  }

  /** Force reconnect of every relay, ignoring backoff. */
  reconnect(): void {
    this.pool?.reconnectNow();
  }

  // ------------------------------------------------------------------ internals

  private openPool(relays: string[]): void {
    this.pool?.close();
    this.pool = new RelayPool(relays, {
      onStatusChange: () => this.emit('session_changed', undefined),
      onNotice: (relay, message, kind) => {
        // The one place a relay explains itself; without it every refusal looked like a
        // timeout.
        console.warn(`[verum-connect] ${relay}: ${message}`);

        if (kind !== 'refusal') return;

        const seen = (this.noticeCounts[relay] ?? 0) + 1;
        this.noticeCounts = { ...this.noticeCounts, [relay]: seen };
        this.notices = {
          ...this.notices,
          [relay]:
            seen > 1 && message.startsWith('refused:')
              ? `refuses everything we send (${seen}×) — ${message.slice('refused:'.length).trim()}`
              : message,
        };
        this.emit('session_changed', undefined);
      },
    });
    this.pool.connect();
  }

  /** Listen on the handshake kind for the first hub that scans the QR. */
  /**
   * @param since Unix seconds to replay from; default a minute back, a resumed
   * pairing passes its own age.
   */
  private listenForHandshake(since = nowSeconds() - 60): void {
    if (!this.pool || !this.keypair) return;
    const { secretKey, publicKey } = this.keypair;

    this.handshakeUnsub = this.pool.subscribe(
      HANDSHAKE_SUB,
      [{ kinds: [KIND_HANDSHAKE], '#p': [publicKey], since }],
      (event, relay) => this.handleHandshake(event, secretKey, publicKey, relay),
    );
  }

  private handleHandshake(
    event: NostrEvent,
    secretKey: string,
    publicKey: string,
    relay: string,
  ): void {
    // The lock: a later scanner is ignored, and logged because it explains a fresh
    // attempt hanging. Call pair() for a new code.
    if (this.peerPublicKey) {
      if (event.pubkey !== this.peerPublicKey) {
        console.warn(
          `[verum-connect] ignoring a connect from ${event.pubkey.slice(0, 12)}… — ` +
            `already paired with ${this.peerPublicKey.slice(0, 12)}…. ` +
            `Call pair() for a new code if that hub is gone.`,
        );
      }
      return;
    }
    if (tagValue(event, 'p') !== publicKey) return;
    if (!isFresh(event)) return;

    let envelope: Envelope;
    let convKey: Uint8Array;
    try {
      convKey = makeConversationKey(secretKey, event.pubkey);
      envelope = parseEnvelope(decrypt(event.content, convKey));
    } catch {
      return;
    }
    if (envelope.type !== 'connect') return;

    this.peerPublicKey = event.pubkey;
    this.handshakeUnsub?.();
    this.handshakeUnsub = null;
    this.clearCodePairing();

    this.openSessionChannel();

    void this.sendConnectAck(secretKey, event.pubkey, convKey, envelope.nonce, relay);

    this.emit('session_changed', { code: fingerprint(convKey) });
  }

  /**
   * Answer a `connect` and nominate the relay it came over, which is proven both
   * ways. Shared by both paths, which differ in when it is called.
   */
  private async sendConnectAck(
    secretKey: string,
    peerPublicKey: string,
    convKey: Uint8Array,
    nonce: string,
    relay: string,
  ): Promise<void> {
    const ack = JSON.stringify({
      type: 'connect_ack',
      v: 1,
      nonce,
      metadata: this.options.metadata,
      chains: this.options.chains,
      relay,
      // Built now, not when the code was minted, so a gateway switched to meanwhile
      // travels.
      pairing: {
        relays: this.relays,
        cid: this.options.hubCid,
        tx: this.options.hubTx,
        webviewUrl: this.webviewHubUrl,
      },
    });
    const ackEvent = buildEvent(KIND_HANDSHAKE, encrypt(ack, convKey), peerPublicKey, secretKey);
    try {
      await this.pool?.publish(ackEvent);
      this.pool?.pin(relay);
    } catch (err) {
      console.error('[verum-connect] failed to publish connect_ack', err);
    }
  }

  private openSessionChannel(): void {
    if (!this.pool || !this.keypair || !this.peerPublicKey) return;

    this.channel?.close();
    this.channel = new Channel({
      pool: this.pool,
      secretKey: this.keypair.secretKey,
      publicKey: this.keypair.publicKey,
      peerPublicKey: this.peerPublicKey,
      kind: KIND_SESSION,
    });
    this.channel.onEnvelope((envelope) => this.handleEnvelope(envelope));
    this.channel.open(SESSION_SUB);
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.type) {
      case 'session_ready': {
        this.applySessionState(envelope.accounts, envelope.chainId);
        this.persist();
        if (!this.connected) {
          this.connected = true;
          this.emit('connect', { chainId: this.chainId });
        }
        return;
      }
      case 'hello': {
        // Re-send anything that never reached the wire or went out while the hub was
        // closed: no request is parked on a relay.
        this.applySessionState(envelope.accounts, envelope.chainId);
        if (!this.connected) {
          this.connected = true;
          this.emit('connect', { chainId: this.chainId });
        }
        this.flushPending();
        return;
      }
      case 'rpc_response': {
        const pending = this.pending.get(envelope.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(envelope.id);
        if (envelope.error) {
          pending.reject(new RpcError(envelope.error.code, envelope.error.message));
        } else {
          pending.resolve(envelope.result);
        }
        return;
      }
      case 'event': {
        if (envelope.event === 'accountsChanged') {
          this.accounts = (envelope.data as string[]) ?? [];
          this.persist();
          this.emit('accountsChanged', this.accounts);
        } else if (envelope.event === 'chainChanged') {
          this.chainId = String(envelope.data);
          this.persist();
          this.emit('chainChanged', this.chainId);
        } else if (envelope.event === 'disconnect') {
          void this.disconnect();
        } else if (envelope.event === 'azguard_event') {
          this.emit(envelope.event, envelope.data);
        }
        return;
      }
      case 'disconnect': {
        this.teardown();
        this.store.clearSession();
        this.store.clearPending();
        this.connected = false;
        this.accounts = [];
        this.emit('disconnect', new RpcError(ERROR_CODES.disconnected, envelope.reason ?? 'hub disconnected'));
        this.emit('accountsChanged', []);
        return;
      }
      default:
        return;
    }
  }

  private applySessionState(accounts: string[], chainId: string): void {
    const accountsChanged =
      accounts.length !== this.accounts.length ||
      accounts.some((a, i) => a.toLowerCase() !== (this.accounts[i] ?? '').toLowerCase());
    const chainChanged = chainId !== this.chainId;

    this.accounts = accounts;
    this.chainId = chainId;

    if (accountsChanged) this.emit('accountsChanged', this.accounts);
    if (chainChanged) this.emit('chainChanged', this.chainId);
  }

  private dispatch(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = newRequestId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ERROR_CODES.timeout, `verum: ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

      const entry: PendingRequest = { id, method, params, resolve, reject, timer, sent: false };
      this.pending.set(id, entry);
      void this.send(entry);
    });
  }

  private async send(entry: PendingRequest): Promise<void> {
    if (!this.channel) return;
    try {
      await this.channel.send({
        type: 'rpc_request',
        id: entry.id,
        method: entry.method,
        params: entry.params,
      } as Envelope);
      entry.sent = true;
    } catch {
      // No relay took it. Leave it queued: the next `hello` replays it, and the
      // request's own timeout is what eventually gives up.
      entry.sent = false;
    }
  }

  private flushPending(): void {
    for (const entry of this.pending.values()) {
      void this.send(entry);
    }
  }

  private async chainRead(method: string, params: unknown[]): Promise<unknown> {
    const url = this.options.rpcUrls?.[this.chainId];
    if (!url) {
      throw new RpcError(
        ERROR_CODES.internal,
        `verum: no rpcUrl configured for chain ${this.chainId}; ` +
          `chain reads are served by the dapp, not the wallet`,
      );
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) {
      throw new RpcError(ERROR_CODES.internal, `verum: rpc http ${response.status}`);
    }
    const json = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (json.error) throw new RpcError(json.error.code, json.error.message);
    return json.result;
  }

  private persist(): void {
    if (!this.keypair || !this.peerPublicKey) return;
    this.store.clearPending();
    this.store.saveSession({
      secretKey: this.keypair.secretKey,
      publicKey: this.keypair.publicKey,
      peerPublicKey: this.peerPublicKey,
      relays: this.relays,
      accounts: this.accounts,
      chainId: this.chainId,
      metadata: this.options.metadata,
      createdAt: Date.now(),
    });
  }

  private teardown(): void {
    this.handshakeUnsub?.();
    this.handshakeUnsub = null;
    // Silent: teardown runs inside pair() and disconnect(), which announce it.
    // Resetting the status makes every re-pair offer a fresh code.
    this.codePairing?.unsub?.();
    this.codePairing = null;
    this.codeStatus = 'none';
    this.channel?.close();
    this.channel = null;
    this.pool?.close();
    this.pool = null;
    this.peerPublicKey = null;
    this.pairingUri = null;

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError(ERROR_CODES.disconnected, 'verum: session closed'));
    }
    this.pending.clear();
  }

}
