/** Demo dapp: pairs, shows the QR and session code, exercises the signing path. */

import { ConnectAmbiguityError, VerumConnectProvider, type PendingConnect } from '@verumlab/connect-dapp';
import {
  createGatewayController,
  createRelayController,
  gatewayHost,
  mountRelayList,
  renderCodeBoxes,
} from '@verumlab/connect-ui';
import QRCode from 'qrcode';

const app = document.getElementById('app')!;

/** Theme override, kept in memory as well as storage: a private-mode write fails. */
const THEME_KEY = 'verum-connect/theme/v1';
const themeButton = document.getElementById('theme') as HTMLButtonElement;

/** Must match the `launch` duration and `wander` stops in the stylesheet. */
const FLIGHT_SECONDS = 18;
const SKY_LANES = 6;

type Theme = 'light' | 'dark' | 'rainbow';

const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'rainbow', rainbow: 'light' };
const THEME_GLYPH: Record<Theme, string> = { light: '☀', dark: '☾', rainbow: '🌈' };

let themeOverride: Theme | null = (() => {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' || value === 'rainbow' ? value : null;
  } catch {
    return null;
  }
})();

function applyTheme(): void {
  if (themeOverride) document.documentElement.setAttribute('data-theme', themeOverride);
  else document.documentElement.removeAttribute('data-theme');

  const active: Theme =
    themeOverride ??
    (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const target = NEXT_THEME[active];

  // The glyph is the theme you are in; the title carries the destination.
  themeButton.textContent = THEME_GLYPH[active];
  themeButton.title = `Switch to ${target} mode`;
  themeButton.setAttribute('aria-label', themeButton.title);
  themeButton.onclick = () => {
    themeOverride = target;
    try {
      localStorage.setItem(THEME_KEY, target);
    } catch {
    }
    applyTheme();
  };
}

applyTheme();

/**
 * Which lane the rainbow theme's rocket starts in: a negative animation-delay seeds
 * the keyframes, quantised to whole flights so lane changes stay hidden at launch
 * boundaries.
 */
document.documentElement.style.setProperty(
  '--sky-seed',
  `${-FLIGHT_SECONDS * Math.floor(Math.random() * SKY_LANES)}s`,
);

/** The IPFS published hub build*/
const DEFAULT_HUB_CID = 'bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq';
/** The Arweave published hub build*/
const DEFAULT_HUB_TX: string | undefined = 'I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE';
const HUB_TX = (import.meta.env.VITE_HUB_TX as string | undefined) ?? DEFAULT_HUB_TX;

const query = new URLSearchParams(location.search);

/** An arbitrary hub URL (a local dev hub); forgoes gateway choice. */
const HUB_OVERRIDE = query.get('hub');

/** A different hub build, keeping gateway choice. */
const CID_OVERRIDE = query.get('cid');

/** Pinned at build time: VITE_HUB_CID=<cid> npm run build -w @verumlab/standalone-demo */
const BAKED_CID = import.meta.env.VITE_HUB_CID as string | undefined;

/** Legacy fixed-URL form: locks every user onto one gateway; prefer `hubCid`. */
const BUILT_IN_HUB = import.meta.env.VITE_HUB_URL as string | undefined;

const HUB_URL = HUB_OVERRIDE ?? BUILT_IN_HUB ?? '';

/** Precedence, narrowest first: ?hub=, ?cid=, build-time pins, published default. */
const HUB_CID = HUB_OVERRIDE
  ? undefined
  : (CID_OVERRIDE ?? BAKED_CID ?? (BUILT_IN_HUB ? undefined : DEFAULT_HUB_CID));

const provider = new VerumConnectProvider({
  ...(HUB_CID ? { hubCid: HUB_CID, hubTx: HUB_TX } : { hubUrl: HUB_URL }),
  // Path gateways only: a WebView has no service worker. The first is used
  webviewGateways: [
    'https://gateway.pinit.io/ipfs/{cid}/',
    'https://ipfs.orbitor.dev/ipfs/{cid}/',
  ],
  metadata: {
    name: 'Verum Demo',
    origin: location.origin,
    description: 'Demonstration dapp for verum-connect',
  },
  // Chain reads are answered here, never over the relay.
  rpcUrls: {
    '0x1': 'https://ethereum-rpc.publicnode.com',
    '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
  },
});

/**
 * Relay edits go through the shared controller (re-pair on change, keep the last
 * relay). Not subscribed to render(): the controller polls, and re-rendering would
 * replace the paste field mid-typing; errors are the exception.
 */
const relays = createRelayController(provider);
/** Relays whose refusal is expanded; survives the re-render a click causes. */
const openNotices = new Set<string>();
// Which gateway list belongs to which role lives in the controller.
const gateways = createGatewayController(provider);
let lastRelayError: string | null = null;
relays.subscribe((state) => {
  if (state.error && state.error !== lastRelayError) {
    lastRelayError = state.error;
    note(`\u2717 ${state.error}`);
    render();
  } else if (!state.error) {
    lastRelayError = null;
  }
});

let uri: string | null = null;
let log: string[] = [];
let busy = false;
let pairing = false;
let settingsOpen = false;
/**
 * Park the pairing fragment and show the code it fingerprints. The lifecycle lives
 * on the provider: every re-pair path drops the code pairing.
 */
/** Re-render when the code expires, so the stale state appears on time. */
let codeExpiryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCodeExpiry(at: number): void {
  if (codeExpiryTimer) clearTimeout(codeExpiryTimer);
  codeExpiryTimer = setTimeout(() => {
    codeExpiryTimer = null;
    render();
  }, Math.max(250, at - Date.now()));
}

async function offerCode(): Promise<void> {
  render();
  try {
    await provider.offerPairingCode();
  } catch (err) {
    // The card says only that it is unavailable; why goes to the log.
    note(err instanceof Error ? `✗ ${err.message}` : '✗ Could not publish the connect code');
  }
  render();
}

provider.on('connect', () => render());
provider.on('disconnect', () => {
  uri = null;
  render();
});
provider.on('accountsChanged', () => render());
provider.on('chainChanged', (chainId: string) => {
  note(`Chain changed to ${chainId}`);
  render();
});
provider.on('session_changed', () => render());
// Re-render as wallets arrive on the typed-code pairing.
provider.on('pending_connects_changed', () => render());
provider.on('code_changed', () => render());
// The link can change without a new pairing (a transport setting, or a resume after
// a reload), so read it from the provider.
provider.on('display_uri', (next: string) => {
  uri = next;
  render();
});

async function start(): Promise<void> {
  note(`Hub: ${provider.resolvedHubUrl}`);
  if (await provider.restore()) {
    note('Restored a stored session — no re-scan needed.');
    render();
    return;
  }
  uri = await provider.pair();
  render();
}

function note(message: string): void {
  log = [`${new Date().toLocaleTimeString()}  ${message}`, ...log].slice(0, 12);
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  busy = true;
  note(`→ ${label}`);
  render();
  try {
    const result = await fn();
    note(`✓ ${JSON.stringify(result)}`);
  } catch (err) {
    const e = err as { code?: number; message?: string };
    note(`✗ ${e.code ?? ''} ${e.message ?? String(err)}`);
  } finally {
    busy = false;
    render();
  }
}

function render(): void {
  app.replaceChildren();

  // Served from IPFS with no hub baked in: the pairing link would point nowhere.
  if (!HUB_CID && !HUB_URL) {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('strong');
    h.textContent = 'No hub configured';
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13.5px;color:var(--muted);margin:6px 0 0';
    p.textContent =
      'Rebuild with VITE_HUB_CID set to the published hub CID, or append ?hub=https://<gateway>/ipfs/<cid>/ to this URL.';
    card.append(h, p);
    app.append(card);
    return;
  }

  if (!provider.isConnected) {
    const card = document.createElement('div');
    card.className = 'card';

    // No code, no card: collapsed to the only action that applies.
    if (!uri) {
      const create = document.createElement('button');
      create.className = 'primary';
      create.disabled = pairing;
      create.textContent = pairing ? 'Generating\u2026' : 'New pairing code';
      create.onclick = async () => {
        pairing = true;
        render();
        try {
          uri = await provider.pair();
        } finally {
          pairing = false;
          render();
        }
      };
      card.append(create);
      app.append(card);
      // No relay card with no session.
      app.append(logCard());
      return;
    }

    // Title plus a settings gear: the shape a wallet-selector modal has.
    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('h2');
    title.textContent = 'Scan with your wallet';
    const gear = document.createElement('button');
    gear.className = 'icon-button';
    gear.textContent = '\u2699';
    gear.title = 'Connection settings';
    gear.setAttribute('aria-label', 'Connection settings');
    gear.setAttribute('aria-haspopup', 'dialog');
    gear.onclick = () => {
      settingsOpen = true;
      render();
    };
    head.append(title, gear);
    card.append(head);

    const canvas = document.createElement('canvas');
    card.append(canvas);
    void QRCode.toCanvas(canvas, uri, { width: 260, margin: 1, errorCorrectionLevel: 'M' });

    const code = provider.sessionCode;
    if (code) card.append(sessionCodeRow(code, 'Session code \u2014 must match the hub'));

    if (provider.gateways.length === 0) card.append(localHubNotice());

    card.append(
      pairingField(uri, async () => {
        note('Generating a new pairing code — the previous one is now dead.');
        uri = await provider.pair();
        render();
      }),
    );
    card.append(connectCodeBlock());

    // Offered without being asked for. Deferred out of the render so this pass finishes
    // painting; offerCode re-renders when the publish resolves.
    if (provider.pairingCodeStatus === 'none') setTimeout(() => void offerCode(), 0);

    app.append(card);
    app.append(logCard());
    if (settingsOpen) app.append(settingsSheet());
    // Last, so it layers over everything; opens on its own, as the decision arrives
    // while the user is looking at their wallet.
    const asking = pendingConnectsSheet();
    if (asking) app.append(asking);
    return;
  }

  const info = document.createElement('div');
  info.className = 'card';

  // The code stays in the accent row after connecting: it is the one line the user
  // checks against the other screen.
  const code = provider.sessionCode;
  if (code) info.append(sessionCodeRow(code, 'Session code — must match the hub'));

  info.append(
    row('Account', provider.currentAccounts[0] ?? '—'),
    row('Chain', provider.currentChainId),
  );
  app.append(info);

  const actions = document.createElement('div');
  actions.className = 'card';

  actions.append(
    button('personal_sign', true, () =>
      run('personal_sign', () =>
        provider.request({
          method: 'personal_sign',
          params: [utf8ToHex('Hello from verum-connect'), provider.currentAccounts[0]],
        }),
      ),
    ),
    button('eth_getBalance (dapp RPC, no relay)', false, () =>
      run('eth_getBalance', () =>
        provider.request({
          method: 'eth_getBalance',
          params: [provider.currentAccounts[0], 'latest'],
        }),
      ),
    ),
    button('eth_sendTransaction (0 ETH to self)', false, () =>
      run('eth_sendTransaction', () =>
        provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: provider.currentAccounts[0],
              to: provider.currentAccounts[0],
              value: '0x0',
            },
          ],
        }),
      ),
    ),
    // Deliberately does not re-pair: disconnecting is not a request for a new code.
    button('Disconnect', false, async () => {
      await provider.disconnect();
      render();
    }),
  );
  app.append(actions);
  app.append(logCard());
}

function button(label: string, primary: boolean, onClick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.disabled = busy;
  if (primary) el.className = 'primary';
  el.onclick = onClick;
  return el;
}

/**
 * Shown when there is no CID to pick a gateway for (a fixed hub URL). In dev that
 * URL is a guess at this machine's address, so the QR would work only on this LAN.
 */
function localHubNotice(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'code-hint';
  const url = provider.resolvedHubUrl;
  const isLan = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0|192\.168\.|10\.|172\.)/.test(url);
  p.textContent = isLan
    ? `Dev hub: ${url} — reachable only on this network. For a published hub, add ?cid=<hub-cid> to this page's URL.`
    : `Hub: ${url}`;
  if (isLan) p.style.color = 'var(--warn)';
  return p;
}

/**
 * Gateway selector: the dapp pins the CID and the user picks where to fetch it, so a
 * gateway outage does not brick every dapp.
 */
/**
 * Everything about how the connection is carried, behind a gear so it does not
 * compete with the code.
 */
function settingsSheet(): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeSettings();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Connection settings');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h2 = document.createElement('h2');
  h2.textContent = 'Connection settings';
  const close = document.createElement('button');
  close.className = 'icon-button';
  close.textContent = '\u2715';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closeSettings;
  head.append(h2, close);
  sheet.append(head);

  if (gateways.getState().desktopGateways.length > 0) {
    sheet.append(settingLabel('Gateway'));
    if (gateways.getState().canSwitch) sheet.append(networkPicker());
    sheet.append(pickerRow(gatewayPickerFor('desktop'), gatewayPickerFor('mobile')));
  }

  sheet.append(settingLabel('Nostr relays'), relayCard());
  backdrop.append(sheet);
  return backdrop;
}

/**
 * Arweave or IPFS as a two-way toggle: both are always available once published,
 * and which is active is worth seeing at a glance. Arweave first as the better
 * answer on both counts; IPFS stays as the route that does not depend on one
 * operator.
 */
function networkPicker(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Hub network');
  wrap.style.cssText = 'display:inline-flex;margin-bottom:8px';

  const options = [
    ['arweave', 'Arweave'],
    ['ipfs', 'IPFS'],
  ] as const;

  for (const [index, [value, label]] of options.entries()) {
    const first = index === 0;
    const active = value === gateways.getState().network;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    // aria-pressed, not a disabled active button: a disabled control is skipped by a
    // screen reader.
    button.setAttribute('aria-pressed', String(active));
    // Joined into one control: the trailing half is pulled back a pixel so the borders
    // share a line, and the active half is raised.
    button.style.cssText =
      'margin:0;font:inherit;font-size:12px;font-weight:600;padding:5px 0;' +
      // Equal halves, so the midpoint does not shift.
      'min-width:84px;text-align:center;min-height:0;cursor:pointer;position:relative;' +
      `border-radius:${first ? '8px 0 0 8px' : '0 8px 8px 0'};` +
      (first ? '' : 'margin-left:-1px;') +
      (active
        ? 'z-index:1;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent)'
        : 'border:1px solid var(--border);background:var(--surface);color:var(--text)');

    button.onclick = async () => {
      if (active) return;
      provider.setNetwork(value);
      note(`Hub network set to ${label}`);
      render();
    };

    wrap.append(button);
  }

  return wrap;
}

/** One gateway picker for either role; the controller decides which list and setter. */
function gatewayPickerFor(role: 'desktop' | 'mobile'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:8px';

  const state = gateways.getState();
  const options = role === 'desktop' ? state.desktopGateways : state.mobileGateways;
  const active = role === 'desktop' ? state.desktopGateway : state.mobileGateway;

  const select = document.createElement('select');
  select.setAttribute('aria-label', `${role} gateway`);
  select.style.cssText =
    'width:100%;font:inherit;font-size:13px;padding:9px;border-radius:10px;' +
    'border:1px solid var(--border);background:var(--surface);color:var(--text)';

  for (const template of options) {
    const option = document.createElement('option');
    option.value = template;
    option.textContent = gatewayHost(template);
    option.selected = template === active;
    select.append(option);
  }

  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Your own gateway…';
  select.append(custom);

  select.onchange = () => {
    let choice = select.value;
    if (choice === '__custom__') {
      const entered = prompt('Gateway URL:', gateways.customHint());
      if (!entered?.trim()) {
        render();
        return;
      }
      choice = entered.trim();
    }
    if (role === 'desktop') gateways.setDesktopGateway(choice);
    else gateways.setMobileGateway(choice);
    note(`${role === 'desktop' ? 'Desktop' : 'Mobile'} gateway set to ${gatewayHost(choice)}`);
    render();
  };

  wrap.append(select);
  return wrap;
}

/**
 * The desktop and mobile gateways side by side, named by where the link is opened,
 * not by network.
 */
function pickerRow(left: HTMLElement, right: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin:2px 0 8px';

  for (const [caption, picker] of [
    ['Desktop', left],
    ['Mobile', right],
  ] as const) {
    const cell = document.createElement('div');
    cell.style.cssText = 'flex:1;min-width:0';

    const text = document.createElement('div');
    text.textContent = caption;
    text.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:5px';

    picker.style.marginBottom = '0';
    cell.append(text, picker);
    row.append(cell);
  }

  return row;
}

function settingLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'setting-label';
  el.textContent = text;
  return el;
}

function closeSettings(): void {
  settingsOpen = false;
  render();
}

/**
 * The session code, presented exactly as the hub presents it, so the comparison is
 * easy.
 */
/**
 * The connect code and the wallets asking to connect on it. Offered without being
 * asked for: a code the user must reveal is one they will not find when the camera
 * fails. The code path owns its own keypair, so what it exposes cannot reach the QR
 * pairing.
 */
function connectCodeBlock(): HTMLElement {
  const wrap = document.createElement('div');

  const rule = document.createElement('div');
  rule.className = 'or-rule';
  rule.textContent = 'or use the connect code';
  wrap.append(rule);

  const row = document.createElement('div');
  row.className = 'connect-code-row';

  if (provider.pairingCodeStatus === 'publishing') {
    // The box stays, its contents change; showing the code while it is being parked
    // would invite typing one no wallet can resolve yet.
    const loading = document.createElement('div');
    loading.className = 'connect-code';
    const spinner = document.createElement('span');
    spinner.className = 'code-spinner';
    spinner.setAttribute('role', 'progressbar');
    spinner.setAttribute('aria-label', 'Publishing the connect code');
    loading.append(spinner);
    row.append(loading);
    wrap.append(row);
    return wrap;
  }

  const code = provider.pairingCode;
  if (!code) {
    // No relay accepted the parked fragment; retrying is the pairing link's reload
    // button.
    const failed = document.createElement('div');
    failed.className = 'connect-code';
    failed.style.cssText = 'font-size:13px;letter-spacing:0;color:var(--muted)';
    failed.textContent = 'Code connect not available';
    row.append(failed);
    wrap.append(row);
    return wrap;
  }

  const shown = document.createElement('div');
  shown.className = 'connect-code has-boxes';
  shown.append(renderCodeBoxes(code, { border: 'var(--border)', background: 'var(--bg)', text: 'var(--text)', textSecondary: 'var(--muted)' }));
  row.append(shown);

  // Past its expiry the code resolves to nothing; the old value stays visible behind
  // the control that replaces it.
  const expiresAt = provider.pairingCodeExpiresAt;
  if (expiresAt !== null && Date.now() >= expiresAt) {
    shown.classList.add('is-stale');

    const again = document.createElement('button');
    again.className = 'code-reload';
    again.type = 'button';
    again.title = 'Get a new connect code';
    again.setAttribute('aria-label', again.title);
    again.append(reloadIcon(), document.createTextNode('New code'));
    again.onclick = () => void offerCode();
    row.append(again);
  } else if (expiresAt !== null) {
    // Nothing else re-renders at the moment it expires.
    scheduleCodeExpiry(expiresAt);
  }

  wrap.append(row);

  return wrap;
}

/**
 * The connect-code decision, as a modal: it IS the decision, so inline it competed
 * with the QR and could be scrolled past. Opens by itself, since the user is
 * looking at their wallet.
 */
/**
 * Whether the connect decision is on screen, mirroring pendingConnectsSheet so
 * Escape and the sheet agree. A throw counts as open (ambiguity or flood).
 */
function connectDecisionOpen(): boolean {
  try {
    return provider.pendingConnects.length > 0;
  } catch {
    return true;
  }
}

function pendingConnectsSheet(): HTMLElement | null {
  let pending: PendingConnect[];
  let failure: string | null = null;
  try {
    pending = provider.pendingConnects;
  } catch (err) {
    pending = [];
    failure =
      err instanceof ConnectAmbiguityError
        ? 'Two wallets are showing the same session code, so there is no way to tell them apart. Get a new code and try again.'
        : 'Too many connection attempts on this code. Get a new code and try again.';
  }
  if (!failure && pending.length === 0) return null;

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  // No dismiss-by-backdrop: clicking away would leave a wallet waiting.

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Confirm the connecting wallet');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h2 = document.createElement('h2');
  h2.textContent =
    pending.length > 1 ? `${pending.length} wallets are asking to connect` : 'A wallet is asking to connect';
  head.append(h2);
  sheet.append(head);

  if (failure) {
    const bad = document.createElement('p');
    bad.className = 'sheet-note';
    bad.style.color = 'var(--danger)';
    bad.textContent = failure;
    sheet.append(bad, sheetDismiss('Get a new code'));
    backdrop.append(sheet);
    return backdrop;
  }

  const note = document.createElement('p');
  note.className = 'sheet-note';
  note.textContent =
    pending.length > 1
      ? 'Someone else may be trying to reach your session. Pick the row matching the code on your wallet — if none of them match, do not continue.'
      : 'Check this matches the code shown on your wallet before continuing.';
  sheet.append(note);

  for (const entry of pending) {
    const choice = document.createElement('button');
    choice.className = 'connect-choice';
    choice.textContent = entry.codeString;
    choice.onclick = async () => {
      // Selection is the commit point: no timer can stand in.
      const ok = await provider.selectPendingConnect(entry.codeString);
      note(ok ? `Connected to the wallet showing ${entry.codeString}.` : 'That request is gone.');
      render();
    };
    sheet.append(choice);
  }

  sheet.append(sheetDismiss('None of these match'));
  backdrop.append(sheet);
  return backdrop;
}

/**
 * A way out that picks nothing: withdrawing the code is the honest response to
 * "none of these match", as it is being raced.
 */
function sheetDismiss(label: string): HTMLElement {
  const el = document.createElement('button');
  el.className = 'sheet-dismiss';
  el.textContent = label;
  el.style.marginTop = '10px';
  el.onclick = () => {
    provider.clearCodePairing();
    note('Connect code withdrawn.');
    render();
  };
  return el;
}

function sessionCodeRow(code: string[], label: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'code-row';

  const labelEl = document.createElement('div');
  labelEl.className = 'code-label';
  labelEl.textContent = label;

  const words = document.createElement('span');
  words.className = 'code-words';
  words.textContent = code.join(' · ');

  wrap.append(labelEl, words);
  return wrap;
}

/**
 * Shorten a URL so what makes it different stays on screen: drop the middle, since
 * the pairing link and hub link differ only at the end.
 */
function shortenUrl(link: string): string {
  const hash = link.indexOf('#');
  if (hash !== -1) {
    // A pairing link: lead with the fragment.
    const base = link.slice(0, hash);
    const origin = base.slice(0, base.indexOf('/', 8) + 1);
    return `${origin}…${link.slice(hash, hash + 20)}…`;
  }
  // A hub link: keep both ends of the CID.
  return link.length <= 46 ? link : `${link.slice(0, 30)}…${link.slice(-10)}`;
}

/**
 * Copyable pairing link: a readonly input, so select-all works if every
 * programmatic copy fails.
 */
/** Line icons built inline, inheriting `currentColor` so all themes are covered. */
const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(paths: string[], strokeWidth = 1.4): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Two overlapping sheets; the back one is drawn as only the edges the front does
 * not cover.
 */
const copyIcon = (): SVGSVGElement =>
  icon([
    'M6 6h6.5a2 2 0 0 1 2 2v6.5H8a2 2 0 0 1-2-2z',
    'M11 4.2V3.5a2 2 0 0 0-2-2H3.5a2 2 0 0 0-2 2V9a2 2 0 0 0 2 2h.7',
  ]);

const checkIcon = (): SVGSVGElement => icon(['M3 8.5 6.2 11.7 13 4.9'], 1.8);

/** Three quarters of a circle with an arrowhead at the open end. */
const reloadIcon = (): SVGSVGElement =>
  icon(['M2.5 8a5.5 5.5 0 1 0 5.5-5.5', 'M8 0.6 10.9 2.5 8 4.4']);

/**
 * The pairing URI with its two actions inside the field. Regenerate lives here
 * because it acts on this value: the dapp locks to the first hub, so once that hub
 * is gone every later scan is ignored and a fresh one is the way out.
 */
function pairingField(link: string, onRegenerate: () => void): HTMLElement {
  const wrap = document.createElement('div');

  const inner = document.createElement('div');
  inner.className = 'field-wrap';

  const field = document.createElement('input');
  field.readOnly = true;
  field.value = shortenUrl(link);
  field.className = 'uri-field';
  // The shortened form is for reading; a click swaps in the real value.
  field.onclick = () => {
    field.value = link;
    field.select();
  };

  const button = document.createElement('button');
  button.className = 'field-action field-inside';
  button.type = 'button';
  button.title = 'Copy pairing link';
  button.setAttribute('aria-label', 'Copy pairing link');
  button.append(copyIcon());

  // The label says why you would want a new code: the paired hub stopped answering.
  // Covers both renderings, as pair() mints one keypair for both.
  const regenerateLabel = provider.isPaired
    ? 'Hub not responding? Get a new QR and connect code'
    : 'New QR and connect code';
  const regenerate = document.createElement('button');
  regenerate.className = 'field-action field-outside';
  regenerate.type = 'button';
  regenerate.title = regenerateLabel;
  regenerate.setAttribute('aria-label', regenerateLabel);
  regenerate.append(reloadIcon());
  regenerate.onclick = onRegenerate;

  // Only carries the fallback instruction; success is a tick. aria-live so it is
  // announced.
  const hint = document.createElement('p');
  hint.className = 'copy-hint';
  hint.setAttribute('aria-live', 'polite');
  hint.hidden = true;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** Swap the glyph, and say something only when there is something to say. */
  const feedback = (icon: SVGSVGElement, message?: string) => {
    button.replaceChildren(icon);
    hint.textContent = message ?? '';
    hint.hidden = message === undefined;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.replaceChildren(copyIcon());
      hint.hidden = true;
    }, 3000);
  };

  const done = () => feedback(checkIcon());

  /**
   * Clipboard needs a secure context, which a plain-http LAN address lacks;
   * execCommand still works there. Synchronous: an await would spend the user
   * gesture.
   */
  const selectAndCopy = () => {
    field.value = link;
    field.select();
    field.setSelectionRange(0, link.length);
    try {
      if (document.execCommand('copy')) return done();
    } catch {
      // Nothing left to try; the text is selected either way.
    }
    feedback(copyIcon(), 'Press ⌘C / Ctrl+C to copy.');
  };

  button.onclick = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(done, selectAndCopy);
    } else {
      selectAndCopy();
    }
  };

  inner.append(field, button);

  const row = document.createElement('div');
  row.className = 'field-row';
  row.append(inner, regenerate);

  wrap.append(row, hint);
  return wrap;
}

/**
 * Relay visibility on the dapp side: without it "both sides waiting" gave no way to
 * tell which end was offline.
 */
/**
 * Relay status, and where the set is edited, on the list itself: the reason to
 * remove a relay is usually seeing it fail right here. Only while unpaired, the
 * only time editing is safe: relays are routing, and changing them mid-session
 * strands the connection.
 */
/**
 * A relay action styled as a link, still a <button> since it acts rather than
 * navigates; the sheet's 44px button rule is too loud here.
 */
function relayAction(label: string, icon: string, onclick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.onclick = onclick;
  button.style.cssText =
    'display:inline-flex;align-items:center;gap:5px;width:auto;min-height:0;' +
    'margin:0;padding:2px 0;border:none;background:none;border-radius:0;' +
    'font-size:12px;font-weight:600;color:var(--accent);cursor:pointer';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icon);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  const text = document.createElement('span');
  text.textContent = label;

  button.append(svg, text);
  return button;
}

function relayCard(): HTMLElement {
  const card = document.createElement('div');

  // One import, not markup of our own: this list was written out four times and
  // drifted. `adder: false`: the card keeps its own Add through prompt(), the one
  // input that works when a selector's modal traps focus.
  const list = mountRelayList(provider, { controller: relays, adder: false });
  card.append(list.el);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:18px;margin-top:12px';
  actions.append(
    relayAction('Add relay', 'M12 5v14M5 12h14', () => {
      const entered = prompt('Relay websocket URL:', 'wss://');
      if (entered?.trim()) relays.add(entered);
    }),
    relayAction('Reset relays', 'M3 3v6h6M3.5 13a9 9 0 1 0 2.4-6.4L3 9', () => relays.reset()),
  );
  card.append(actions);

  if (provider.relayPresetChanged) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:12px;color:var(--warn);margin:8px 0 0';
    note.textContent =
      'This dapp now suggests different relays. Reset to use them — relays you added are kept.';
    card.append(note);
  }

  return card;
}

/** personal_sign takes hex. No Buffer in the browser, so encode by hand. */
function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function row(key: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'row';
  const k = document.createElement('span');
  k.textContent = key;
  const v = document.createElement('span');
  v.textContent = value;
  el.append(k, v);
  return el;
}

function logCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'log-header';
  const title = document.createElement('span');
  title.textContent = 'Activity log';
  const clear = document.createElement('button');
  clear.className = 'log-clear';
  clear.textContent = 'Clear log';
  clear.disabled = log.length === 0;
  clear.onclick = () => {
    log = [];
    render();
  };
  header.append(title, clear);

  const pre = document.createElement('pre');
  pre.textContent = log.length ? log.join('\n') : 'Waiting…';
  card.append(header, pre);
  return card;
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // The connect decision first, since it layers over the settings sheet. Escape
  // withdraws the code: dismissing while leaving it live would drop the user back to a
  // page that looks fine with a wallet still waiting.
  if (connectDecisionOpen()) {
    provider.clearCodePairing();
    note('Connect code withdrawn.');
    render();
    return;
  }
  if (settingsOpen) closeSettings();
});

void start();
