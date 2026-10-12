/**
 * Hub entry point and UI. The active session is the largest thing on screen: a
 * wallet sheet shows this page's origin, so this card is where the user learns who
 * asked.
 */

import './styles.css';
import {
  MAX_RELAYS,
  WEBVIEW_SAFE_GATEWAYS,
  buildPairingFragment,
  detectServedCid,
  detectServedTx,
  isOriginIsolated,
  parsePairingFragment,
  resolveGateway,
  typedRelayUrl,
  type PairingParams,
  type RelayStatus,
} from '@verumlab/connect-protocol';
import {
  Hub,
  LookupConflictError,
  resolvePairingCode,
  type HubSession,
  type HubState,
} from '@verumlab/connect-wallet';
import {
  deepLinks,
  discoverWallets,
  hasInjectedWallet,
  isMobileLike,
  type DiscoveredWallet,
} from './wallet.js';
import { codeBoxes } from './codeBoxes.js';
import { WALLET_ICONS } from './wallet-icons.js';
import { startScanning, type ScanHandle } from './scanner.js';
import {
  activeRelays,
  namedInUrl,
  relaysFromUrl,
  saveRelays,
  storedRelays,
} from './relays.js';
import { termsFooter, termsOpen } from './terms.js';

// Never run inside another page's frame. 
// A meta CSP cannot carry frame-ancestors and a gateway's headers are not ours, so the
// page refuses here, before anything is drawn or connected.
if (window.top !== window.self) {
  document.body.replaceChildren('This page opens in its own tab, not inside another site.');
  throw new Error('verum hub: refusing to run in a frame');
}

const app = document.getElementById('app')!;

/**
 * The header is outside #app (vertically centred), fixed to the viewport corners:
 * title and page-level controls belong to the page, not the card.
 */
const headerHost = document.createElement('div');
headerHost.className = 'page-head';
document.body.append(headerHost);

/**
 * Outside #app and appended once: the terms belong to the page and show on every
 * screen.
 */
document.body.append(termsFooter());

const hub = new Hub();

/**
 * Theme override: absent until the user picks, so the page follows the system. Not
 * gated on origin isolation: at worst a neighbour changes the colours.
 */
const THEME_KEY = 'verum-connect/theme/v1';

/** Must match the `launch` duration and `wander` stops in styles.css. */
const FLIGHT_SECONDS = 18;
const SKY_LANES = 6;

type Theme = 'light' | 'dark' | 'rainbow';

const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'rainbow', rainbow: 'light' };
const THEME_GLYPH: Record<Theme, string> = { light: '☀', dark: '☾', rainbow: '🌈' };

function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' || value === 'rainbow' ? value : null;
  } catch {
    return null;
  }
}

// In memory: in private mode the write fails and the choice must still hold.
let themeOverride: Theme | null = readStoredTheme();

function activeTheme(): Theme {
  if (themeOverride) return themeOverride;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(): void {
  if (themeOverride) document.documentElement.setAttribute('data-theme', themeOverride);
  else document.documentElement.removeAttribute('data-theme');
}

// At import time, so the first frame is not the system theme.
applyTheme();

/**
 * Which lane the rainbow theme's rocket starts in: a negative animation-delay
 * seeds it, quantised to whole flights so lane changes stay hidden.
 */
document.documentElement.style.setProperty(
  '--sky-seed',
  `${-FLIGHT_SECONDS * Math.floor(Math.random() * SKY_LANES)}s`,
);

function themeToggle(): HTMLButtonElement {
  const active = activeTheme();
  const target = NEXT_THEME[active];
  const button = document.createElement('button');
  button.className = 'theme-toggle';
  // The glyph is the theme you are in, not the destination: with three stops a
  // destination glyph reads as a mislabel. The title carries the destination.
  button.textContent = THEME_GLYPH[active];
  button.title = `Switch to ${target} mode`;
  button.setAttribute('aria-label', button.title);
  button.onclick = () => {
    themeOverride = target;
    try {
      localStorage.setItem(THEME_KEY, target);
    } catch {
    }
    applyTheme();
    render(hub.state);
  };
  return button;
}

let wallets: DiscoveredWallet[] = [];
let pairing: PairingParams | null = null;
let pairError: string | null = null;
let busy = false;

/**
 * The fragment as it arrived: boot() strips it from the address bar, but the
 * deep-link handoff still needs it.
 */
let arrivedFragment = '';

/**
 * A gateway typed into the copy row, held at module level because render()
 * rebuilds on any state change and would discard an edit in the element.
 */
let hubUrlEdit: string | null = null;

let connectingWalletId: string | null = null;

let pendingWallet: DiscoveredWallet | null = null;

/**
 * Set when a disconnect could not revoke the wallet's grant, so the UI says the
 * wallet still lists this origin.
 */
let revokeUnsupported = false;

let accountSheetOpen = false;

let pairSheetOpen = false;

/**
 * Camera scanner state; the node is cached so a re-render does not restart the
 * camera.
 */
/**
 * Whether the pairing-link field is disclosed: the fallback when scanning cannot
 * work, so collapsed.
 */
let urlPairOpen = false;

let scannerOpen = false;
let scannerNode: HTMLElement | null = null;
let scanHandle: ScanHandle | null = null;

/**
 * Relay status for a code lookup in flight: its pool is transient and never
 * reaches hub.state.
 */
let lookupRelays: Record<string, RelayStatus> | null = null;
/** What the code lookup proved, shown until the session's own sockets are up. */
let lookupSeen: Record<string, RelayStatus> | null = null;
let lookupNotices: Record<string, string> = {};
/** Which is expanded: click, not hover, since a tooltip never arrives on a phone. */
let openNotice: string | null = null;

let settingsOpen = false;
let relayError: string | null = null;

// ---------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  try {
    if (location.hash.length > 1) {
      arrivedFragment = location.hash.replace(/^#/, '');
      pairing = parsePairingFragment(location.hash);
    }
  } catch (err) {
    pairError = err instanceof Error ? err.message : 'Invalid pairing link';
  }

  // Drop the fragment from the address bar once read: it holds the session pubkey,
  // and this keeps it out of screenshots and shared URLs.
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The agreement sits over everything and closes itself, so one Escape does not
    // also close what it covers.
    if (termsOpen()) return;
    if (pendingWallet) cancelTrust();
    else if (pairError) dismissError();
    else if (revokeUnsupported) dismissRevokeNotice();
    else if (scannerOpen) closeScanner();
    else if (settingsOpen) closeSettings();
    else if (accountSheetOpen) closeAccountSheet();
    else if (pairSheetOpen) closePairSheet();
  });

  // For a wallet whose in-app disconnect fires no accountsChanged: the user leaves to
  // remove the site, and this is when they return. eth_accounts never prompts.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hub.hasWallet) void hub.refreshWallet();
  });

  hub.subscribe(render);
  // Awaited before anything can pair: a pairing rewrites the stored session list and
  // would drop sessions not yet read.
  await hub.restore();

  wallets = await discoverWallets((late) => {
    wallets = late;
    render(hub.state);
  });
  render(hub.state);

  if (hub.hasWallet) void hub.sayHello();
}

/**
 * What the trust decision is scoped to: the CID, not the origin (a path gateway
 * serves every CID from one origin), so a new hub build asks again.
 */
function trustKey(): string {
  return `verum-connect/trusted/${detectServedCid() ?? location.origin}`;
}

function isHubTrusted(): boolean {
  try {
    return localStorage.getItem(trustKey()) !== null;
  } catch {
    return false;
  }
}

function rememberHubTrust(): void {
  try {
    localStorage.setItem(trustKey(), String(Date.now()));
  } catch {
  }
}

/** Disconnecting withdraws the consent too, so a reconnect asks again. */
function forgetHubTrust(): void {
  try {
    localStorage.removeItem(trustKey());
  } catch {
  }
}

/**
 * Gate the first wallet connection on an explicit trust decision: connecting hands
 * this page a provider that can put requests before the wallet, each still gated by
 * the wallet's approval.
 */
function requestWalletConnect(wallet: DiscoveredWallet): void {
  if (isHubTrusted()) {
    void connectWallet(wallet);
    return;
  }
  pendingWallet = wallet;
  render(hub.state);
}

async function connectWallet(wallet: DiscoveredWallet): Promise<void> {
  busy = true;
  connectingWalletId = wallet.id;
  render(hub.state);
  try {
    await hub.attachWallet(wallet.provider, wallet.name);
    revokeUnsupported = false;
    await hub.sayHello();
    if (pairing) await startPairing();
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4001) {
      pairError = err instanceof Error ? err.message : 'Could not connect to the wallet';
    }
  } finally {
    busy = false;
    connectingWalletId = null;
    render(hub.state);
  }
}

async function startPairing(): Promise<void> {
  if (!pairing) return;
  const params = pairing;
  pairing = null;
  busy = true;
  render(hub.state);
  try {
    const session = await hub.pair(params);
    pairError = null;
    // A code pairing has no fragment of its own, so take the one the dapp nominated in
    // its ack, unless a scan or pasted link already brought one.
    if (!arrivedFragment && session.nomination) {
      arrivedFragment = buildPairingFragment({
        publicKey: session.id,
        ...session.nomination,
      });
    }
  } catch (err) {
    pairError = err instanceof Error ? err.message : 'Pairing failed';
  } finally {
    busy = false;
    render(hub.state);
  }
}

// -------------------------------------------------------------------- render

function render(state: HubState): void {
  const active = state.sessions.find((s) => s.id === state.activeId) ?? null;
  const others = state.sessions.filter((s) => s.id !== state.activeId);

  // Decided before the header: with no wallet reachable nothing here can complete a
  // pairing, so relay settings would open onto a choice that cannot be acted on.
  const canPair = hasInjectedWallet() || wallets.length > 0;
  if (!canPair) settingsOpen = false;

  headerHost.replaceChildren(header(state, canPair));
  app.replaceChildren();
  if (pairError) app.append(errorNotice(pairError));

  // The link names the hub build the dapp expects; compare against whichever this
  // page was served as. Advisory: it catches an old bookmark, not a substitution (the
  // session code does that).
  const servedCid = detectServedCid();
  const servedTx = detectServedTx();
  const expected = servedTx ? pairing?.tx : pairing?.cid;
  const served = servedTx ?? servedCid;
  if (expected && served && expected !== served) {
    app.append(cidMismatchNotice(expected, served));
  }

  if (!hasInjectedWallet() && wallets.length === 0) {
    app.append(noWalletNotice());
    return;
  }

  if (!state.walletName) {
    if (revokeUnsupported) app.append(revokeNotice());
    app.append(walletPicker());

    // Sessions survive a wallet disconnect (paired, nothing to sign with);
    if (active) app.append(activeCard(active, state));
    if (others.length > 0) app.append(sessionList(others));
    app.append(relayStrip(state.relayStatuses));

    if (settingsOpen) app.append(settingsSheet());
    if (pendingWallet) app.append(trustSheet(pendingWallet));
    return;
  }

  // A link waiting to be confirmed is the page's business, so it stays inline.
  if (pairing) app.append(pendingPairNotice());
  // Nothing connected: pairing IS the page, so it gets the card; once a session is
  // live pairing moves to the header.
  else if (!active) app.append(pairCard());

  // Only when something is connected: an empty placeholder is furniture explaining
  // there is no furniture.
  if (active) app.append(activeCard(active, state));
  if (others.length > 0) app.append(sessionList(others));
  app.append(relayStrip(state.relayStatuses));

  if (accountSheetOpen && state.walletName) app.append(accountSheet(state));
  else accountSheetOpen = false;

  if (settingsOpen) app.append(settingsSheet());
  if (pairSheetOpen) app.append(pairSheet());

  if (scannerOpen) app.append(scannerSheet());
  else stopScanner();
}

/**
 * @param canPair false on the no-wallet screen, where controls that act on a
 * pairing are inert and so omitted.
 */
function header(state: HubState, canPair: boolean): HTMLElement {
  const el = document.createElement('header');

  const h1 = document.createElement('h1');
  h1.append('Verum ');
  const span = document.createElement('span');
  span.textContent = 'Connect';
  h1.append(span);
  // Which half of Verum Connect this is; the install page carries the same wordmark
  // with its own name.
  const section = document.createElement('em');
  section.className = 'section';
  section.textContent = 'Hub';
  h1.append(section);
  el.append(h1);

  // Built unconditionally: the theme control belongs to the page and must survive
  // the nothing-connected state.
  const actions = document.createElement('div');
  actions.className = 'header-actions';
  el.append(actions);

  if (state.walletName) {
    // Only once a session owns the page; with nothing connected pairing is the
    // subject, in a card.
    let pair: HTMLButtonElement | null = null;
    if (state.activeId) {
      pair = document.createElement('button');
      pair.className = 'chip-action';
      pair.textContent = 'Pair';
      pair.title = 'Pair with another dapp';
      pair.setAttribute('aria-haspopup', 'dialog');
      pair.setAttribute('aria-expanded', String(pairSheetOpen));
      pair.onclick = () => {
        pairSheetOpen = !pairSheetOpen;
        render(hub.state);
      };
    }

    // A button, not a div: reachable by keyboard and announcing itself as actionable.
    const chip = document.createElement('button');
    chip.className = 'wallet-chip';
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', String(accountSheetOpen));
    chip.title = 'Account options';

    const strong = document.createElement('strong');
    strong.textContent = state.walletName;
    chip.append(strong);
    if (state.accounts[0]) chip.append(` · ${shortAddress(state.accounts[0])}`);

    chip.onclick = () => {
      accountSheetOpen = !accountSheetOpen;
      render(hub.state);
    };

    if (pair) actions.append(pair);
    actions.append(chip);
  }

  // Built unconditionally: the relay set belongs to the page, and is most likely to
  // need changing when nothing has connected and a code lookup is failing.
  if (canPair) {
    const settings = document.createElement('button');
    settings.className = 'theme-toggle';
    settings.textContent = '\u2699';
    settings.title = 'Manual relays';
    settings.setAttribute('aria-label', settings.title);
    settings.setAttribute('aria-haspopup', 'dialog');
    settings.setAttribute('aria-expanded', String(settingsOpen));
    settings.onclick = () => {
      settingsOpen = !settingsOpen;
      relayError = null;
      render(hub.state);
    };
    actions.append(settings);
  }
  actions.append(themeToggle());
  return el;
}

function activeCard(session: HubSession, state: HubState): HTMLElement {
  const card = document.createElement('div');
  card.className = 'active-card';

  // Honest about what the session can do: without a wallet every prompting request
  // comes back 4900, so calling it live would be a lie.
  card.append(eyebrow(state.walletName ? 'Live connection' : 'Paired — no wallet connected'));
  card.append(identityBlock(session, 44));

  const codeRow = document.createElement('div');
  codeRow.className = 'code-row';
  const label = document.createElement('span');
  label.className = 'code-label';
  label.textContent = 'Session code — must match the dapp';
  const words = document.createElement('span');
  words.className = 'code-words';
  words.textContent = session.code.join(' · ');
  codeRow.append(label, words);
  card.append(codeRow);

  const grid = document.createElement('div');
  grid.className = 'meta-grid';
  grid.append(
    metaItem('Account', state.accounts[0] ? shortAddress(state.accounts[0]) : '—'),
    metaItem('Chain', chainName(state.chainId)),
  );
  card.append(grid);

  // Said only when it happened: a dapp whose only live relays sit past the cap would
  // otherwise time out illegibly.
  if (session.relaysNamed > session.relays.length) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 12px';
    p.textContent = `Using ${session.relays.length} of the ${session.relaysNamed} relays this link named.`;
    card.append(p);
  }

  if (session.status === 'pairing') {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:var(--muted);margin:0 0 12px';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    p.append(spinner, ' Waiting for the dapp to answer…');
    card.append(p);
  }
  if (session.status === 'error' && session.error) {
    const p = document.createElement('p');
    p.className = 'error-text';
    p.textContent = session.error;
    card.append(p);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const reconnect = document.createElement('button');
  reconnect.className = 'primary';
  reconnect.textContent = 'Reconnect';
  reconnect.onclick = () => {
    hub.reconnect();
    render(hub.state);
  };

  const disconnect = document.createElement('button');
  disconnect.className = 'danger';
  disconnect.textContent = 'Disconnect';
  disconnect.onclick = () => void hub.removeSession(session.id);

  actions.append(reconnect, disconnect);
  card.append(actions);
  return card;
}

function sessionList(sessions: HubSession[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'session-list';

  const h2 = document.createElement('h2');
  h2.textContent = `Other connections (${sessions.length})`;
  wrap.append(h2);

  for (const session of sessions) {
    const row = document.createElement('button');
    row.className = 'session-row';
    // Switching is user-initiated only: this click is the sole path that moves the
    // spotlight; nothing arriving over a relay can call setActive.
    row.onclick = () => hub.setActive(session.id);

    row.append(identityIcon(session, 32));

    const text = document.createElement('div');
    text.className = 'session-row-text';
    const name = document.createElement('div');
    name.className = 'session-row-name';
    name.textContent = session.metadata?.name ?? 'Unknown dapp';
    const origin = document.createElement('div');
    origin.className = 'session-row-origin';
    origin.textContent = session.metadata?.origin ?? session.id.slice(0, 16);
    text.append(name, origin);
    row.append(text);

    if (session.pending.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${session.pending.length} waiting`;
      row.append(badge);
    }

    wrap.append(row);
  }
  return wrap;
}

function identityBlock(session: HubSession, size: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dapp-identity';
  wrap.append(identityIcon(session, size));

  const text = document.createElement('div');
  text.className = 'dapp-text';
  const name = document.createElement('div');
  name.className = 'dapp-name';
  name.textContent = session.metadata?.name ?? 'Unknown dapp';
  const origin = document.createElement('div');
  origin.className = 'dapp-origin';
  origin.textContent = session.metadata?.origin ?? 'origin not reported';
  text.append(name, origin);
  wrap.append(text);
  return wrap;
}

function identityIcon(session: HubSession, size: number): HTMLElement {
  const icon = document.createElement('div');
  icon.className = 'dapp-icon';
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;

  const src = session.metadata?.icon;
  // Only data: URIs: a remote icon would let any paired dapp use this page as a
  // beacon reporting when the hub is open.
  if (src && src.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    icon.append(img);
  } else {
    icon.textContent = (session.metadata?.name ?? '?').charAt(0).toUpperCase();
  }
  return icon;
}

function walletPicker(): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'notice';

  const h3 = document.createElement('h3');
  h3.textContent = 'Connect your wallet';
  notice.append(h3);

  const list = document.createElement('div');
  list.className = 'deep-links';
  for (const wallet of wallets) {
    const button = document.createElement('button');
    // Only the wallet actually being opened says so: the user needs to know which
    // wallet is about to raise a prompt.
    button.textContent = connectingWalletId === wallet.id ? 'Connecting…' : wallet.name;
    button.disabled = busy;
    button.onclick = () => requestWalletConnect(wallet);
    list.append(button);
  }
  notice.append(list);
  return notice;
}

/**
 * One-time trust prompt for this hub build: the wallet stays the authority on every
 * signature and this page can only propose.
 */
function trustSheet(wallet: DiscoveredWallet): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) cancelTrust();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Trust this hub');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Trust this hub?';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.onclick = cancelTrust;
  head.append(h3, close);

  const body = document.createElement('p');
  body.style.cssText = 'font-size:13px;color:var(--muted);margin:0 0 10px';
  body.textContent = 'Only continue if you trust this hub.';

  const alert = document.createElement('div');
  alert.className = 'poc-banner';
  const alertText = document.createElement('strong');
  alertText.textContent = 'Important: manually verify every transaction in your wallet.';
  alert.append(alertText);

  const served = detectServedCid();
  const source = document.createElement('div');
  source.className = 'meta-item';
  source.style.marginBottom = '4px';
  const sourceKey = document.createElement('div');
  sourceKey.className = 'meta-key';
  sourceKey.textContent = served ? 'Build (CID)' : 'Served from';
  const sourceVal = document.createElement('div');
  sourceVal.className = 'meta-val';
  sourceVal.textContent = served ?? location.origin;
  source.append(sourceKey, sourceVal);

  // Only when a CID is on show; otherwise there is nothing to scope the decision to.
  const scope = document.createElement('p');
  scope.style.cssText = 'font-size:12px;color:var(--muted);margin:8px 0 0';
  scope.textContent = 'Remembered for this build only. A different build asks again.';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const approve = document.createElement('button');
  approve.className = 'primary';
  approve.textContent = `Trust and connect ${wallet.name}`;
  approve.onclick = () => {
    rememberHubTrust();
    pendingWallet = null;
    // Straight into connect, inside this click: the wallet's prompt needs its user
    // activation.
    void connectWallet(wallet);
  };

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = cancelTrust;

  actions.append(approve, cancel);
  sheet.append(head, alert, body, source);
  if (served) sheet.append(scope);
  sheet.append(actions);
  backdrop.append(sheet);
  return backdrop;
}

function cancelTrust(): void {
  pendingWallet = null;
  render(hub.state);
}

/**
 * Account controls, opened from the header chip: "which account am I connected
 * as" is a question about the chip, so the controls sit under it.
 */
function accountSheet(state: HubState): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeAccountSheet();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Account options');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = state.walletName ?? 'Connected wallet';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closeAccountSheet;
  head.append(h3, close);

  const grid = document.createElement('div');
  grid.className = 'meta-grid';
  grid.append(
    metaItem('Account', state.accounts[0] ? shortAddress(state.accounts[0]) : 'None selected'),
    metaItem('Chain', chainName(state.chainId)),
  );

  const actions = document.createElement('div');
  actions.className = 'actions';

  const switchAccount = document.createElement('button');
  switchAccount.textContent = busy ? 'Opening wallet…' : 'Switch account';
  switchAccount.disabled = busy;
  switchAccount.onclick = () => void runWalletAction(() => hub.switchAccount());

  const disconnect = document.createElement('button');
  disconnect.className = 'danger';
  disconnect.textContent = busy ? 'Disconnecting…' : 'Disconnect wallet';
  disconnect.disabled = busy;
  disconnect.onclick = () =>
    void runWalletAction(async () => {
      revokeUnsupported = !(await hub.disconnectWallet());
      forgetHubTrust();
    });

  actions.append(switchAccount, disconnect);
  sheet.append(head, grid, actions);
  backdrop.append(sheet);
  return backdrop;
}

function closeAccountSheet(): void {
  accountSheetOpen = false;
  render(hub.state);
}

async function runWalletAction(action: () => Promise<void>): Promise<void> {
  busy = true;
  render(hub.state);
  try {
    await action();
    pairError = null;
  } catch (err) {
    pairError = err instanceof Error ? err.message : 'Could not update the wallet';
  } finally {
    busy = false;
    render(hub.state);
  }
}

/**
 * URL to hand a wallet's in-app browser, with the pairing fragment restored (boot()
 * strips it). Not location.href: this page may be somewhere a WebView cannot follow.
 * The destination comes from the dapp in the fragment as `w`, since this immutable
 * build cannot decide it; deriving one is the fallback for a link without it, and
 * VITE_HUB_URL outranks both.
 */
function handoffUrl(): string {
  const explicit = import.meta.env.VITE_HUB_URL as string | undefined;
  return withPairing(explicit ?? pairing?.webviewUrl ?? webviewSafeSelf());
}

/**
 * This page's own URL, for pasting into a desktop browser that has a wallet: not
 * handoffUrl(), which aims at a WebView and gives up the verifying gateway.
 */
function selfUrl(): string {
  return withPairing(`${location.origin}${location.pathname}`);
}

function withPairing(base: string): string {
  const stripped = base.replace(/#.*$/, '');
  return arrivedFragment ? `${stripped}#${arrivedFragment}` : stripped;
}

/**
 * This page, moved onto a gateway a WebView can load: only the subdomain form (it
 * needs a service worker); path gateways already serve bytes.
 */
function webviewSafeSelf(): string {
  const here = `${location.origin}${location.pathname}`;

  // Arweave needs no downgrade: a sandboxed transaction is an isolated origin a
  // WebView can load. Stated, not reached by falling through the CID branch.
  if (detectServedTx()) return here;

  const cid = detectServedCid();
  if (!cid || !isOriginIsolated()) return here;
  // An isolated IPFS origin means a subdomain gateway, which a WebView cannot load:
  // the one case that trades isolation for reachability.
  return resolveGateway(WEBVIEW_SAFE_GATEWAYS[0]!, cid);
}

/**
 * A hub address, editable, with a copy button (the address bar loses the fragment).
 * The gateway is the user's to change: the CID pins what the hub is, the host only
 * who serves it.
 */
function hubUrlRow(url: string, onEdit?: (next: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'url-row';

  const field = document.createElement('input');
  field.className = 'url-text';
  field.spellcheck = false;
  field.autocapitalize = 'off';
  field.autocomplete = 'off';
  field.value = hubUrlEdit ? withPairing(hubUrlEdit) : url;
  field.oninput = () => {
    // Only the gateway is stored; the pairing is re-attached on render, so an edit
    // outlives a new pairing and cannot strand a stale fragment.
    hubUrlEdit = field.value.replace(/#.*$/, '').trim() || null;
    onEdit?.(field.value);
  };

  const button = document.createElement('button');
  button.className = 'url-copy';
  button.textContent = 'Copy';

  const flash = () => {
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  };

  /**
   * Copy without navigator.clipboard (needs a secure context): execCommand,
   * synchronous so it keeps the user gesture.
   */
  const selectAndCopy = (): boolean => {
    field.select();
    field.setSelectionRange(0, field.value.length);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  };

  button.onclick = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(field.value).then(flash, () => {
        if (selectAndCopy()) flash();
      });
      return;
    }
    if (selectAndCopy()) flash();
  };

  row.append(field, button);
  return row;
}

/**
 * Shown when no wallet is injected; advice differs by device (app links on a phone,
 * an extension on a desktop).
 */
function noWalletNotice(): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'notice';

  const h3 = document.createElement('h3');
  const p = document.createElement('p');

  if (!isMobileLike()) {
    h3.textContent = 'No wallet in this browser';
    p.textContent = 'Paste the link in a wallet supported browser';
    notice.append(h3, p, hubUrlRow(selfUrl()));
    return notice;
  }

  h3.textContent = 'No wallet found';
  p.textContent = 'Open hub with wallets built in browser.';
  notice.append(h3, p);

  const handoff = hubUrlEdit ? withPairing(hubUrlEdit) : handoffUrl();

  const list = document.createElement('div');
  list.className = 'deep-links';

  // Rebuilt, not patched: a target the schemes cannot carry (an ipfs:// hub, a
  // half-typed address) means no buttons, not stale ones.
  const paintLinks = (target: string) => {
    list.replaceChildren();
    for (const link of deepLinks(target)) {
      const a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', `Open in ${link.name}`);

      const icon = WALLET_ICONS[link.name];
      if (icon) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        a.append(img);
      }

      const name = document.createElement('span');
      name.textContent = link.name;
      a.append(name);
      list.append(a);
    }
  };
  paintLinks(handoff);
  notice.append(list);

  // The same destination as the buttons, for a wallet with no deep link: paste it
  // into that wallet's browser by hand.
  const or = document.createElement('div');
  or.className = 'or-rule';
  or.textContent = 'or paste this link in your wallet browser';

  notice.append(or, hubUrlRow(handoff, paintLinks));
  return notice;
}

/**
 * Pair from a pasted link: only the fragment carries the pairing, so a hub run from
 * your own node accepts a link whatever gateway the dapp chose.
 */
/** Accept a scanned or pasted pairing link and begin pairing.
 *  Returns an error message, or null on success. */
function pairFromText(raw: string): string | null {
  try {
    const hash = raw.indexOf('#');
    const carried = hash === -1 ? raw.trim() : raw.slice(hash + 1);
    pairing = parsePairingFragment(carried);
    // Also kept for the handoff: without it a pairing made by scan or paste leaves
    // every deep link bare.
    arrivedFragment = carried;
    pairSheetOpen = false;
    scannerOpen = false;
    void startPairing();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Not a valid pairing link';
  }
}

function cameraIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(NS, 'rect');
  body.setAttribute('x', '2');
  body.setAttribute('y', '6');
  body.setAttribute('width', '20');
  body.setAttribute('height', '14');
  body.setAttribute('rx', '3');

  const lens = document.createElementNS(NS, 'circle');
  lens.setAttribute('cx', '12');
  lens.setAttribute('cy', '13');
  lens.setAttribute('r', '4');

  const flash = document.createElementNS(NS, 'circle');
  flash.setAttribute('cx', '18');
  flash.setAttribute('cy', '9.6');
  flash.setAttribute('r', '0.9');
  flash.setAttribute('fill', 'currentColor');
  flash.setAttribute('stroke', 'none');

  svg.append(body, lens, flash);
  return svg;
}

function pairForm(): HTMLElement {
  const wrap = document.createElement('div');

  // First, as the path that works: scanning reads the fragment off the other screen.
  // Always offered, with the reason in the sheet it opens.
  const scan = document.createElement('button');
  scan.className = 'primary scan-big';
  const scanLabel = document.createElement('span');
  scanLabel.textContent = 'Scan QR code';
  scan.append(cameraIcon(), scanLabel);
  scan.onclick = () => {
    scannerOpen = true;
    render(hub.state);
  };

  wrap.append(scan);

  // Behind a native <details>, so opening costs no re-render that would discard
  // half-typed text.
  const disclosure = document.createElement('details');
  disclosure.className = 'pair-disclosure';
  disclosure.open = urlPairOpen;
  disclosure.ontoggle = () => {
    urlPairOpen = disclosure.open;
  };

  const summary = document.createElement('summary');
  summary.textContent = 'use link';
  disclosure.append(summary);
  wrap.append(disclosure);

  {
    const field = document.createElement('input');
    field.placeholder = 'https://\u2026#v=1&p=\u2026&r=\u2026';
    field.setAttribute('aria-label', 'Pairing link');
    field.className = 'relay-add-field';

    const error = document.createElement('p');
    error.className = 'error-text';
    error.hidden = true;

    const submit = document.createElement('button');
    submit.className = 'primary';
    submit.textContent = 'Connect';
    const go = (): void => {
      error.hidden = true;
      const message = pairFromText(field.value.trim());
      if (message) {
        error.textContent = message;
        error.hidden = false;
      }
    };
    submit.onclick = go;
    field.onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      go();
    };

    const row = document.createElement('div');
    row.className = 'field-action-row';
    row.append(field, submit);
    disclosure.append(row, error);
  }

  wrap.append(codeForm());
  return wrap;
}

/**
 * Enter a typed pairing code. Last, as the weakest: the dapp must publish its
 * pairing pubkey, so anyone can deny the pairing. Offered because scan and paste
 * both fail when the dapp is on someone else's screen.
 */
/**
 * How long a complete code sits untouched before it is looked up: long enough to
 * fix a transposed character, short enough not to read as ignored.
 */
const CODE_SUBMIT_DELAY_MS = 1_000;

/** What is typed into each of the code's boxes. */
let codeParts: string[] = [];
let codeTimer: ReturnType<typeof setTimeout> | null = null;
let codeLooking = false;
let codeLookupError: string | null = null;

async function runCodeLookup(): Promise<void> {
  codeTimer = null;
  codeLooking = true;
  codeLookupError = null;
  lookupSeen = null;
  render(hub.state);
  // The best each relay did, and whether the search is still running: its sockets
  // report closing after it returns, and that must not overwrite what it showed.
  const seen: Record<string, RelayStatus> = {};
  let searching = true;
  try {
    const resolved = await resolvePairingCode(codeParts.join(''), {
      relays: activeRelays(),
      onStatusChange: (statuses) => {
        if (!searching) return;
        for (const [url, status] of Object.entries(statuses)) {
          if (status === 'open' || !seen[url]) seen[url] = status;
        }
        lookupRelays = statuses;
        render(hub.state);
      },
      // Kept for the strip: a relay that refuses to answer and one that answers with
      // nothing both end as "no payload found", and only the relay can say which.
      onNotice: (relay, message) => {
        lookupNotices = { ...lookupNotices, [relay]: message };
        render(hub.state);
      },
    });
    searching = false;
    pairing = resolved;
    lookupSeen = seen;
    pairSheetOpen = false;
    scannerOpen = false;
    codeParts = [];
    void startPairing();
  } catch (err) {
    codeLookupError =
      err instanceof LookupConflictError
        ? 'This code points at two different dapps. Someone is interfering — ask for a QR code instead.'
        : err instanceof Error
          ? err.message
          : 'Could not find that code';
  } finally {
    searching = false;
    codeLooking = false;
    lookupRelays = null;
    render(hub.state);
  }
}

function codeForm(): HTMLElement {
  const wrap = document.createElement('div');

  const or = document.createElement('div');
  or.className = 'or-rule';
  or.textContent = 'or use the connect code';

  const ready = activeRelays().length > 0;

  wrap.append(
    or,
    codeBoxes({
      parts: codeParts,
      disabled: !ready || codeLooking,
      // No submit button: a complete code fires once the boxes stop changing, debounced
      // so fixing the last character does not race a doomed lookup.
      onChange: (parts, complete) => {
        codeParts = parts;
        codeLookupError = null;
        if (codeTimer) clearTimeout(codeTimer);
        codeTimer = null;
        if (complete) codeTimer = setTimeout(() => void runCodeLookup(), CODE_SUBMIT_DELAY_MS);
      },
    }),
  );

  if (codeLooking) {
    const status = document.createElement('p');
    status.className = 'sheet-note';
    status.style.textAlign = 'center';
    status.textContent = 'Looking up…';
    wrap.append(status);
  }

  if (codeLookupError) {
    const error = document.createElement('p');
    error.className = 'error-text';
    error.textContent = codeLookupError;
    wrap.append(error);
  }

  if (!ready) {
    const setRelays = document.createElement('button');
    setRelays.className = 'primary';
    setRelays.style.width = '100%';
    setRelays.textContent = 'Set relays';
    setRelays.onclick = () => {
      settingsOpen = true;
      relayError = null;
      render(hub.state);
    };
    wrap.append(setRelays);
  }

  return wrap;
}

/**
 * Pairing as the page's subject when nothing is connected, since an empty hub
 * whose only affordance is a corner button reads as a dead end.
 */
function pairCard(): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'notice';
  // No heading: here the card IS the page. The sheet keeps its heading to
  // distinguish itself from a live session.
  notice.append(pairForm());
  return notice;
}

function pairSheet(): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closePairSheet();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Pair with a dapp');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Pair with a dapp';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '\u2715';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closePairSheet;
  head.append(h3, close);

  sheet.append(head, pairForm());
  backdrop.append(sheet);
  return backdrop;
}

function closePairSheet(): void {
  pairSheetOpen = false;
  render(hub.state);
}

/**
 * Live camera view that pairs on the first QR it can read. Built once and cached:
 * re-creating the <video> restarts the camera.
 */
function scannerSheet(): HTMLElement {
  if (scannerNode) return scannerNode;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeScanner();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Scan a pairing code');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Scan the dapp’s code';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closeScanner;
  head.append(h3, close);

  const frame = document.createElement('div');
  frame.className = 'scan-frame';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  frame.append(video);

  const error = document.createElement('p');
  error.className = 'error-text';
  error.hidden = true;

  const hint = document.createElement('p');
  hint.style.cssText = 'font-size:12.5px;color:var(--muted);margin:10px 0 0';
  hint.textContent = 'Point the camera at the code shown by the dapp.';

  sheet.append(head, frame, error, hint);
  backdrop.append(sheet);
  scannerNode = backdrop;

  void startScanning({
    video,
    onResult: (text) => {
      const message = pairFromText(text.trim());
      if (!message) {
        stopScanner();
        render(hub.state);
        return;
      }
      // A QR that is not ours: say so and keep scanning.
      error.textContent = `${message} Keep the camera on the dapp’s code.`;
      error.hidden = false;
    },
    onError: (message) => {
      error.textContent = message;
      error.hidden = false;
      hint.hidden = true;
    },
  }).then((handle) => {
    if (scannerOpen) scanHandle = handle;
    else handle.stop();
  });

  return backdrop;
}

function stopScanner(): void {
  scanHandle?.stop();
  scanHandle = null;
  scannerNode = null;
}

function closeScanner(): void {
  scannerOpen = false;
  stopScanner();
  render(hub.state);
}

function pendingPairNotice(): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'notice';
  const h3 = document.createElement('h3');
  h3.textContent = 'New pairing ready';
  const p = document.createElement('p');
  p.textContent = 'A dapp is waiting to connect. Check the session code matches once it appears.';
  const button = document.createElement('button');
  button.className = 'primary';
  button.textContent = busy ? 'Pairing…' : 'Pair now';
  button.disabled = busy;
  button.onclick = () => void startPairing();
  notice.append(h3, p, button);
  return notice;
}

/**
 * Shown when this hub build is not the one the link named: not fatal, but they may
 * have been sent to a hub the dapp never published against.
 */
function cidMismatchNotice(expected: string, served: string): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'notice';

  const h3 = document.createElement('h3');
  h3.textContent = 'Different hub build';
  const p = document.createElement('p');
  p.textContent = 'This dapp published against a different build of this page.';

  const detail = document.createElement('p');
  detail.style.cssText = 'font-family:var(--mono);font-size:11px;word-break:break-all';
  detail.textContent = `expected ${expected}\nrunning  ${served}`;
  detail.style.whiteSpace = 'pre-wrap';

  notice.append(h3, p, detail);
  return notice;
}

function dismissRevokeNotice(): void {
  revokeUnsupported = false;
  render(hub.state);
}

function revokeNotice(): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) dismissRevokeNotice();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'alertdialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Still listed in your wallet');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Still listed in your wallet';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = dismissRevokeNotice;
  head.append(h3, close);

  const p = document.createElement('p');
  p.style.cssText = 'font-size:13.5px;color:var(--muted);margin:0';
  p.textContent = 'Disconnect from within the wallet.';

  sheet.append(head, p);
  backdrop.append(sheet);
  return backdrop;
}

function dismissError(): void {
  pairError = null;
  render(hub.state);
}

function errorNotice(message: string): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) dismissError();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'alertdialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Something went wrong');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Something went wrong';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = dismissError;
  head.append(h3, close);

  const p = document.createElement('p');
  p.className = 'error-text';
  p.style.margin = '0';
  p.textContent = message;

  sheet.append(head, p);
  backdrop.append(sheet);
  return backdrop;
}

/**
 * @param statuses the session pools' merged view, empty before the first pairing;
 * a code lookup in flight takes precedence.
 */
function closeSettings(): void {
  settingsOpen = false;
  relayError = null;
  render(hub.state);
}

/**
 * Relay settings. Only the hub's own set is editable: a session's relays belong to
 * the dapp, and changing them would break a live session.
 */
function settingsSheet(): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeSettings();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet sheet-scroll';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Manual relays');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Manual relays';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '\u2715';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closeSettings;
  head.append(h3, close);
  sheet.append(head);

  const note = document.createElement('p');
  note.className = 'sheet-note';
  // Relays do not federate, so a code parked on the dapp's relays is invisible here
  // unless this list overlaps; QR and pasted links carry their own.
  note.textContent =
    `Used for code based connections. Minimum of 1 relay must match dapp(s) used relays. Max ${MAX_RELAYS} relays.`;
  sheet.append(note);

  // The editor works on the MANUAL list, never a URL override, which belongs to the
  // address and would save someone else's relays as yours.
  const current = storedRelays();

  if (relaysFromUrl()) {
    const override = document.createElement('p');
    override.className = 'sheet-note';
    override.style.color = 'var(--warn)';
    override.textContent =
      '?relays= in this page\u2019s address is overriding the list below, for this ' +
      'address only. Your own list is kept and comes back without it.';
    sheet.append(override);

    const named = namedInUrl();
    if (named.length > activeRelays().length) {
      const trimmed = document.createElement('p');
      trimmed.className = 'sheet-note';
      trimmed.textContent =
        `The address named ${named.length} relays; the first ${MAX_RELAYS} are in use. ` +
        'Each one is a connection this page opens and one more party that sees ' +
        'which codes are looked up.';
      sheet.append(trimmed);
    }

    const inUse = document.createElement('div');
    inUse.className = 'relay-inuse';
    for (const url of activeRelays()) {
      const line = document.createElement('div');
      line.className = 'relay-edit-url';
      line.textContent = url;
      inUse.append(line);
    }
    sheet.append(eyebrow('In use from the address'), inUse);

    // The only way a list from an address becomes yours is being asked for; adopting
    // it silently would let a link choose where this hub looks.
    const adopt = document.createElement('button');
    adopt.className = 'chip-action';
    adopt.textContent = 'Use these as my list';
    adopt.onclick = () => {
      relayError = null;
      try {
        saveRelays(activeRelays());
      } catch (err) {
        relayError = err instanceof Error ? err.message : 'Could not save';
      }
      render(hub.state);
    };
    sheet.append(adopt);

    sheet.append(eyebrow('Your list'));
  }

  if (current.length === 0) {
    const none = document.createElement('p');
    none.className = 'sheet-note';
    none.style.color = 'var(--warn)';
    none.textContent = relaysFromUrl() ? 'None of your own set.' : 'None set.';
    sheet.append(none);
  }

  for (const url of current) {
    const row = document.createElement('div');
    row.className = 'relay-edit-row';

    const text = document.createElement('span');
    text.className = 'relay-edit-url';
    text.textContent = url;

    const remove = document.createElement('button');
    remove.className = 'relay-remove';
    remove.textContent = '\u2715';
    remove.title = `Remove ${url}`;
    remove.setAttribute('aria-label', remove.title);
    remove.onclick = () => {
      relayError = null;
      try {
        saveRelays(current.filter((u) => u !== url));
      } catch (err) {
        relayError = err instanceof Error ? err.message : 'Could not save';
      }
      render(hub.state);
    };

    row.append(text, remove);
    sheet.append(row);
  }

  const field = document.createElement('input');
  field.placeholder = 'wss://relay.example';
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Add a relay');
  field.className = 'relay-add-field';

  const submitRelay = (): void => {
    relayError = null;
    const value = field.value.trim();
    if (!value) return;
    try {
      saveRelays([...current, typedRelayUrl(value)]);
      field.value = '';
    } catch (err) {
      relayError = err instanceof Error ? err.message : 'Could not save';
    }
    render(hub.state);
  };

  field.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitRelay();
  };

  const add = document.createElement('button');
  add.textContent = 'Add';
  add.title = 'Add relay';
  add.setAttribute('aria-label', add.title);
  add.onclick = submitRelay;

  const addRow = document.createElement('div');
  addRow.className = 'field-action-row relay-add-row';
  addRow.append(field, add);
  sheet.append(addRow);

  if (relayError) {
    const err = document.createElement('p');
    err.className = 'error-text';
    err.textContent = relayError;
    sheet.append(err);
  }

  backdrop.append(sheet);
  return backdrop;
}

function relayStrip(statuses: Record<string, RelayStatus>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'relay-strip';

  // Idle with no session: name the set a typed code would search, which is fixed and
  // so known before it is opened.
  const idle = Object.keys(statuses).length === 0 && !lookupRelays;
  // The session's sockets are still opening after a code lookup: the lookup already
  // showed relays answering, and one is enough, so do not reset the strip to 0.
  const liveOpen = Object.values(statuses).filter((s) => s === 'open').length;
  if (liveOpen > 0) lookupSeen = null;
  const shown: Record<string, RelayStatus> = lookupRelays ?? (liveOpen === 0 ? lookupSeen : null) ??
    (idle
      ? Object.fromEntries(activeRelays().map((url) => [url, 'closed' as RelayStatus]))
      : statuses);

  const entries = Object.entries(shown);
  const open = entries.filter(([, s]) => s === 'open').length;

  const summary = document.createElement('div');
  summary.style.marginBottom = '7px';
  summary.textContent = idle
    ? entries.length === 0
      ? 'No relays set. Needed only for connect codes.'
      : 'Relays used:'
    : `${open} of ${entries.length} relays answered. One is enough.`;
  wrap.append(summary);

  for (const [url, status] of entries) {
    const line = document.createElement('div');
    line.className = 'relay-line';
    const said = lookupNotices[url];
    if (said) {
      line.classList.add('relay-refused');
      line.title = 'What this relay said';
      line.onclick = () => {
        openNotice = openNotice === url ? null : url;
        render(hub.state);
      };
    }
    const dot = document.createElement('span');
    dot.className = `dot ${status}`;
    line.append(dot, url.replace(/^wss:\/\//, ''));
    wrap.append(line);

    if (said && openNotice === url) {
      const why = document.createElement('div');
      why.className = 'relay-said';
      // A refusal is not partial: the same policy rejects both the ephemeral QR events
      // and the stored code.
      why.textContent = `${said} — refuses QR, URL and code connect.`;
      wrap.append(why);
    }
  }
  return wrap;
}

// ------------------------------------------------------------------- helpers

function eyebrow(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'eyebrow';
  el.textContent = text;
  return el;
}

function metaItem(key: string, value: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'meta-item';
  const k = document.createElement('div');
  k.className = 'meta-key';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'meta-val';
  v.textContent = value;
  item.append(k, v);
  return item;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const CHAIN_NAMES: Record<string, string> = {
  '0x1': 'Ethereum',
  '0xa': 'Optimism',
  '0x38': 'BNB Chain',
  '0x89': 'Polygon',
  '0x2105': 'Base',
  '0xa4b1': 'Arbitrum',
  '0xaa36a7': 'Sepolia',
};

function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${Number.parseInt(chainId, 16) || chainId}`;
}

void boot();
