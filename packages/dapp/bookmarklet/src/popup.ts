/**
 * The panel: dapp-side integration for a dapp that never asked. The provider
 * pairs with the hub as for any SDK dapp, but acts for a page that does not know
 * it is talking to nostr.
 * The relay sockets live here, so closing this window ends the session.
 */

import './popup.css';
import QRCode from 'qrcode';
import { VerumConnectProvider } from '@verumlab/connect-dapp';
import {
  createCodeController,
  createRelayController,
  mountConnectPicker,
  renderCodeBoxes,
  mountGatewayPicker,
  mountRelayList,
  type MountedGatewayPicker,
  type MountedRelayList,
  type RelayController,
} from '@verumlab/connect-ui';
import { PROTOCOL, isVerumMessage, type ToPopup } from './messages.js';
// @ts-expect-error - plain JS, the same agreement the hub publishes
import { TERMS_LINES } from '../../../shared/terms.mjs';

/**
 * The published hub build used. CID for IPFS and TX for arweave.
 */
const HUB_CID = 'bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq';
const HUB_TX = 'I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE';

/**
 * Fallback RPC for direct rpc request before connection.
 */
const RPC_URLS: Record<string, string> = {
  '0x1': 'https://ethereum-rpc.publicnode.com',
  '0x2105': 'https://base-rpc.publicnode.com',
  '0xa4b1': 'https://arbitrum-one-rpc.publicnode.com',
  '0xa': 'https://optimism-rpc.publicnode.com',
  '0x89': 'https://polygon-bor-rpc.publicnode.com',
  '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
};

const app = document.getElementById('app')!;

/**
 * The connection this window carries: one dapp, named by the browser-stamped
 * origin. One per window, bound to the window not the tab: a reload replaces the
 * tab and the bookmark knocks again, and rebinding hands it the session it had.
 */
interface Session {
  origin: string;
  win: unknown;
  provider: VerumConnectProvider;
  /**
   * One per session, not per repaint: the controller polls, and this card is redrawn
   * on every new pairing URI.
   */
  relays: RelayController;
  relayList: MountedRelayList;
  /**
   * Made once for the same reason: a picker built per repaint would leave listeners
   * behind.
   */
  gateways: MountedGatewayPicker;
  /** Paints the pairing card again as it last was, for the gear. */
  repaint: (() => void) | null;
  card: HTMLElement;
  /**
   * Which pairing attempt is current: a replaced one still inside `waitForSession`
   * would otherwise paint over the new code.
   */
  gen: number;
  post(message: object): void;
}
let session: Session | null = null;

/** Set when the page says it is about to reload this window. */
let reloading = false;
/** "Side panel next time", once the header has drawn it. */
let routeButton: HTMLButtonElement | null = null;
let termsSheet: HTMLElement | null = null;
/**
 * Told by the page: this panel came from a gateway chosen on the site, not the
 * bookmark's own address.
 */
let elsewhere = false;
/**
 * Whether settings are showing in place of the pairing; held here so a repaint does
 * not close it.
 */
let settingsOpen = false;

/**
 * How this panel reaches its page. Here, the window that framed or opened it, its
 * messages attested by the browser's origin on them; the extension sets its own on
 * `globalThis.verumPanelTransport` before loading this, with the tab in place of a
 * window and the origin the browser gave the extension.
 */
export interface PanelTransport {
  /** Whoever showed this first, if anyone. */
  host: unknown;
  /** What carries this panel, under the wordmark. */
  name?: string;
  send(to: unknown, message: object, origin: string): void;
  listen(handler: (data: unknown, origin: string, from: unknown) => void): void;
}

const transport: PanelTransport = (globalThis as { verumPanelTransport?: PanelTransport }).verumPanelTransport ?? {
  host: window.opener ?? (window.parent !== window ? window.parent : null),
  send: (to, message, origin) => (to as Window).postMessage(message, origin),
  listen: (handler) => window.addEventListener('message', (event) => handler(event.data, event.origin, event.source)),
};
const host = transport.host;

mountHeader();
mountTerms();

if (!host) {
  paintEmpty('Waiting for the page', 'Go back to the dapp tab if this does not move.');
  setTimeout(() => {
    if (session) return;
    showStandalone();
  }, 2000);
} else {
  paintEmpty('Waiting for the page', 'Go back to the dapp tab if this does not move.');
  // Broadcast, as the host's origin is unknown until it answers; this says only that
  // a window is listening.
  transport.send(host, { v: PROTOCOL, type: 'ready' }, '*');
}

/**
 * Reached directly, usually to check the gateway serves it. That it loads is the
 * answer; the rest points at the install page published beside it.
 */
function showStandalone(): void {
  paintEmpty(
    'This is the Verum Connect panel',
    'It opens from the bookmark, on a dapp. This gateway is serving it, so a bookmark pointed here will work.',
  );
  const install = document.createElement('a');
  install.href = new URL('./', location.href).href;
  install.textContent = 'Get the bookmark';
  install.className = 'install-link';
  app.querySelector('.card')?.append(install);
}

transport.listen((data, origin, from) => {
  if (!isVerumMessage(data)) return;
  const message = data as ToPopup;
  const known = session && session.origin === origin ? session : null;

  if (message.type === 'use-panel-done') {
    if (known && routeButton) routeButton.textContent = 'Side panel next time ✓';
    return;
  }

  if (message.type === 'raise') {
    // Not a closing tab: the page is about to navigate this window to raise it. Said
    // before, so pagehide stays quiet instead of telling the hub the session is over.
    if (known) reloading = true;
    return;
  }

  if (message.type === 'hello') {
    // A hello from an origin already here is that dapp knocking again: rebind and
    // answer with the session instead of starting another.
    if (known) {
      console.info('[verum panel] reattached', origin);
      known.win = from;
      known.post({ v: PROTOCOL, type: 'ready' });
      if (known.provider.currentAccounts.length > 0) {
        known.post({
          v: PROTOCOL,
          type: 'session',
          accounts: known.provider.currentAccounts,
          chainId: known.provider.currentChainId,
          ...(known.provider.sessionCode ? { code: known.provider.sessionCode } : {}),
        });
      }
      return;
    }
    // This window belongs to whoever spoke first; a second dapp opens its own.
    if (session) {
      console.warn('[verum panel] already carrying', session.origin, '— ignoring', origin);
      return;
    }
    elsewhere = message.elsewhere === true;
    const opened = openSession(origin, from, message.title, message.icon);
    // The page may have spoken first (when this window could not see its opener) and
    // waits on `ready`.
    opened.post({ v: PROTOCOL, type: 'ready' });
    return;
  }

  // Both checks: the origin is the browser's word for who is asking, and the window
  // is the one bound to it.
  if (!known || from !== known.win) return;

  if (message.type === 'request') {
    console.debug('[verum panel] \u2192', known.origin, message.id, message.method);

    // The dapp is finished with the session: end it here instead of sending a method
    // the wallet cannot answer.
    if (message.method === 'wallet_revokePermissions') {
      void known.provider
        .disconnect()
        .finally(() => {
          known.post({ v: PROTOCOL, type: 'result', id: message.id, result: null });
          retire(known, 'The dapp ended this session.');
        });
      return;
    }

    void known.provider.request({ method: message.method, params: message.params }).then(
      (result) => {
        console.debug('[verum panel] \u2190', known.origin, message.id, result);
        known.post({ v: PROTOCOL, type: 'result', id: message.id, result });
      },
      (error: { code?: number; message?: string }) => {
        console.warn('[verum panel] \u2717', known.origin, message.id, error);
        known.post({
          v: PROTOCOL,
          type: 'error',
          id: message.id,
          error: {
            code: typeof error?.code === 'number' ? error.code : -32603,
            message: error?.message ?? 'verum: request failed',
          },
        });
      },
    );
  }
});

/** Start a connection for a dapp that has just introduced itself. */
/**
 * Which dapp the session in this storage belongs to: the store is keyed by this
 * page's origin, so without it one dapp's session would go to the next that opens
 * this panel.
 */
const OWNER_KEY = 'verum-bookmarklet/session-origin';

function storedOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

function rememberOwner(origin: string | null): void {
  try {
    if (origin) localStorage.setItem(OWNER_KEY, origin);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    // Storage refused; it only costs a resume.
  }
}

function openSession(origin: string, win: unknown, title: string, icon: string | undefined): Session {
  const provider = new VerumConnectProvider({
    hubCid: HUB_CID,
    hubTx: HUB_TX,
    metadata: {
      // The name is the page's own title, shown as self-reported; the origin beside it is
      // the browser's.
      name: title || origin,
      origin,
      ...(icon ? { icon } : {}),
    },
    rpcUrls: RPC_URLS,
  });

  const card = document.createElement('div');
  card.className = 'card';
  app.replaceChildren(card);

  const relays = createRelayController(provider);
  const live: Session = {
    origin,
    win,
    provider,
    relays,
    relayList: mountRelayList(provider, { controller: relays }),
    gateways: mountGatewayPicker(provider),
    repaint: null,
    card,
    gen: 0,
    post(message: object): void {
      transport.send(this.win, message, this.origin);
    },
  };
  session = live;

  // Azguard's session events, for the extension's page.
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect', 'azguard_event'] as const) {
    provider.on(event, (data: unknown) => {
      console.debug('[verum panel] event', origin, event, data);
      live.post({ v: PROTOCOL, type: 'event', event, data });
      if (event === 'disconnect') retire(live, 'The wallet ended this session.');
    });
  }

  void resume(live);
  return live;
}

/** Continue the session this panel already had, or pair if there is none. */
async function resume(live: Session): Promise<void> {
  if (storedOwner() === live.origin) {
    try {
      if (await live.provider.restore()) {
        console.info('[verum panel] resumed the session for', live.origin);
        live.post({
          v: PROTOCOL,
          type: 'session',
          accounts: live.provider.currentAccounts,
          chainId: live.provider.currentChainId,
          ...(live.provider.sessionCode ? { code: live.provider.sessionCode } : {}),
        });
        paintConnected(live);
        return;
      }
    } catch (err) {
      console.warn('[verum panel] could not resume — pairing instead', err);
    }
  }
  void pair(live);
}

/**
 * A session that is over. The card stays a moment: it is where the session code
 * was.
 */
function retire(ended: Session, note: string): void {
  if (session === ended) session = null;
  ended.relayList.destroy();
  ended.relays.destroy();
  ended.gateways.destroy();
  rememberOwner(null);
  paintCard(ended, 'Disconnected', note);
  setTimeout(() => {
    if (!session) paintEmpty('Disconnected', 'Click the bookmarklet again to reconnect.');
  }, 6000);
}

/**
 * @param fresh Skip the pending pairing and mint a new one: resuming restores the
 * relays it was minted on, which would overwrite a set the user just changed.
 */
async function pair(session: Session, fresh = false): Promise<void> {
  const { provider } = session;
  const run = ++session.gen;
  const codes = createCodeController(provider);
  // The panel's own palette, so the picker follows its light or dark theme.
  const picker = mountConnectPicker(codes, {
    theme: {
      background: 'var(--surface)',
      text: 'var(--text)',
      textSecondary: 'var(--muted)',
      border: 'var(--border)',
      accent: 'var(--accent)',
      danger: 'var(--danger)',
      font: 'var(--font)',
    },
  });
  // Once per pairing, not per paint.
  const offUri = provider.on('display_uri', (next: string) => {
    if (session.gen === run) void paintPairing(session, codes, next);
  });

  try {
    const uri = fresh ? await provider.pair() : ((await provider.resumePairing()) ?? (await provider.pair()));
    if (session.gen !== run) return;
    void codes.offer();
    void paintPairing(session, codes, uri);

    const live = await provider.waitForSession();
    if (session.gen !== run) return;
    rememberOwner(session.origin);
    session.post({
      v: PROTOCOL,
      type: 'session',
      accounts: live.accounts,
      chainId: live.chainId,
      ...(provider.sessionCode ? { code: provider.sessionCode } : {}),
    });
    // The session code is what to read now, not settings left open.
    settingsOpen = false;
    paintConnected(session);
  } catch (err) {
    if (session.gen !== run) return;
    paintCard(session, 'Pairing failed', err instanceof Error ? err.message : 'Could not reach the hub.');
  } finally {
    offUri();
    picker.destroy();
    codes.destroy();
  }
}

// ------------------------------------------------------------------ rendering

function paintEmpty(title: string, note: string): void {
  const card = document.createElement('div');
  card.className = 'card';
  card.append(heading(title), paragraph(note));
  app.replaceChildren(card);
}

function paintCard(which: Session, title: string, note: string): void {
  which.card.replaceChildren(heading(title), originRow(which.origin), paragraph(note));
}

async function paintPairing(
  session: Session,
  codes: ReturnType<typeof createCodeController>,
  uri: string,
): Promise<void> {
  const { card } = session;
  session.repaint = () => void paintPairing(session, codes, uri);

  if (settingsOpen) {
    card.replaceChildren(
      gearButton(session),
      heading('Settings'),
      hubSection(session),
      relaySection(session),
      ...routeSection(),
      ...(elsewhere ? [installNote()] : []),
    );
    return;
  }

  const image = document.createElement('img');
  image.className = 'qr';
  image.alt = 'Pairing code';
  image.src = await QRCode.toDataURL(uri, { width: 560, margin: 1 });

  // Read again after the wait: the gear may have been pressed meanwhile.
  if (settingsOpen) return;
  card.replaceChildren(
    gearButton(session),
    heading('Scan with your wallet'),
    originRow(session.origin),
    image,
    linkRow(uri),
    rule('or use the connect code'),
    codeField(codes),
  );
}

/**
 * The gear in the card's corner, opening and closing the settings. Once connected
 * it opens only what is left: relays and the hub link would end the pairing.
 */
function gearButton(session: Session): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = settingsOpen ? 'gear is-on' : 'gear';
  button.title = settingsOpen ? 'Back to the pairing' : 'Settings';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(settingsOpen));
  button.innerHTML =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7L5.4 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  button.onclick = () => {
    settingsOpen = !settingsOpen;
    session.repaint?.();
  };
  return button;
}

/**
 * Just the host, for a line about switching tabs; the full origin is at the top of
 * the card.
 */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function paintConnected(session: Session): void {
  const { provider, card } = session;
  const settings = window.parent === window || elsewhere;
  session.repaint = settings ? () => paintConnected(session) : null;

  if (settingsOpen && settings) {
    card.replaceChildren(
      gearButton(session),
      heading('Settings'),
      ...routeSection(),
      ...(elsewhere ? [installNote()] : []),
    );
    return;
  }
  settingsOpen = false;
  card.replaceChildren(
    ...(settings ? [gearButton(session)] : []),
    heading('Connected'),
    originRow(session.origin),
  );

  const code = provider.sessionCode;
  if (code) {
    const row = document.createElement('div');
    row.className = 'code-row';
    const label = document.createElement('span');
    label.className = 'code-label';
    label.textContent = 'Session code — must match your hub';
    const words = document.createElement('span');
    words.className = 'code-words';
    words.textContent = code.join(' · ');
    row.append(label, words);
    card.append(row);
  }

  card.append(
    paragraph(
      window.opener
        ? `Connected. Switch back to ${hostOf(session.origin)} — leave this tab open, it carries the connection.`
        : 'Leave this open. It carries the connection — closing it disconnects the dapp.',
    ),
  );

  // The only way to end a session properly from this side: an injected wallet has no
  // disconnect for a dapp to call, so this tells the hub.
  const end = document.createElement('button');
  end.textContent = 'Disconnect';
  end.onclick = () => {
    end.disabled = true;
    end.textContent = 'Disconnecting…';
    void provider.disconnect().finally(() => retire(session, 'The session has been ended.'));
  };
  card.append(end);
}

/**
 * The last thing this document does when closed another way: nostr has no
 * presence, so the hub is told synchronously (with a relay open, the EVENT frame is
 * written before this returns). `pagehide`, not `visibilitychange`, which also
 * fires when switching tabs.
 */

window.addEventListener('pagehide', () => {
  if (reloading) return;
  if (session) void session.provider.disconnect();
});

/** Only in a window: framed, this already is the side panel. */
function routeSection(): HTMLElement[] {
  if (window.parent !== window) return [];
  const wrap = document.createElement('div');
  wrap.className = 'route-section';
  wrap.append(rule('this site'), routeSwitch());
  return [wrap];
}

function routeSwitch(): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'route-switch';
  button.textContent = 'Side panel next time';
  button.title = 'Open the side panel on this site from now on, instead of a window';
  button.onclick = () => {
    if (!session) return;
    button.disabled = true;
    button.textContent = 'Asking…';
    session.post({ v: PROTOCOL, type: 'use-panel' });
    setTimeout(() => {
      if (button.textContent === 'Asking…') {
        button.textContent = 'Update the bookmark first';
        button.title = 'This bookmark predates this option — install it again from its page';
      }
    }, 1500);
  };
  routeButton = button;
  return button;
}

/**
 * The agreement, on the page that carries the connection: a line under the card
 * with the text behind it, published in the same immutable artifact.
 */
function mountTerms(): void {
  const foot = document.createElement('footer');
  foot.className = 'page-foot';

  const line = document.createElement('p');
  line.append('Provided as is, without warranty. Using this means accepting the ');

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'terms-link';
  link.textContent = 'user agreement';
  link.onclick = openTerms;
  line.append(link, '.');

  foot.append(line);
  app.after(foot);
}

function openTerms(): void {
  if (termsSheet) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeTerms();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'User agreement');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const title = document.createElement('h3');
  title.textContent = 'User agreement';
  const shut = document.createElement('button');
  shut.type = 'button';
  shut.className = 'sheet-close';
  shut.textContent = '\u2715';
  shut.setAttribute('aria-label', 'Close');
  shut.onclick = closeTerms;
  head.append(title, shut);
  sheet.append(head);

  for (const paragraph of TERMS_LINES as string[]) {
    const p = document.createElement('p');
    p.className = 'terms-body';
    p.textContent = paragraph;
    sheet.append(p);
  }

  backdrop.append(sheet);
  document.body.append(backdrop);
  termsSheet = backdrop;
}

function closeTerms(): void {
  termsSheet?.remove();
  termsSheet = null;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTerms();
});

/**
 * The tab this window was opened from, watched: closing it would leave this one
 * holding a session for a page that no longer exists. `closed` is readable on a
 * cross-origin window.
 */
function watchOpener(): void {
  const timer = setInterval(() => {
    let gone = false;
    try {
      gone = !window.opener || window.opener.closed;
    } catch {
      gone = true;
    }
    if (!gone) return;

    clearInterval(timer);
    console.info('[verum panel] the dapp tab is gone — ending the session');
    const done = (): void => window.close();
    if (session) void session.provider.disconnect().then(done, done);
    else done();
    setTimeout(done, 1200);
  }, 1000);
}

/**
 * The wordmark.
 */
function mountHeader(): void {
  const head = document.createElement('div');
  head.className = 'page-head';

  const h1 = document.createElement('h1');
  h1.append('Verum ');
  const span = document.createElement('span');
  span.textContent = 'Connect';
  const section = document.createElement('em');
  section.textContent = transport.name ?? 'Bookmarklet';
  h1.append(span, section);
  head.append(h1);
  if (window.opener) watchOpener();
  document.body.prepend(head);
}

/**
 * How a gateway chosen on one site becomes the bookmark's own everywhere: it is
 * remembered for that site only, while a bookmark installed from this gateway
 * carries it into every dapp.
 */
function installNote(): HTMLElement {
  const note = document.createElement('p');
  note.className = 'install-note';
  note.append(
    'Loaded from a gateway set for this site. To use it everywhere, ',
    Object.assign(document.createElement('a'), {
      href: new URL('install.html', location.href).href,
      target: '_blank',
      rel: 'noopener',
      textContent: 'install the bookmark from here',
    }),
    '.',
  );
  return note;
}

/** Where the link and QR above point, with the same picker the dapp examples carry. */
function hubSection(session: Session): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hub-link';
  wrap.append(rule('hub link'), session.gateways.el);
  return wrap;
}

/** The relay list is one shared widget. */
function relaySection(session: Session): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'relays';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'relay-reset';
  reset.textContent = 'Reset to defaults';
  reset.onclick = () => session.relays.reset();

  wrap.append(rule('relays'), session.relayList.el, reset);
  return wrap;
}

function codeField(codes: ReturnType<typeof createCodeController>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'code';

  const draw = (): void => {
    const state = codes.getState();
    if (state.status === 'ready' && state.code) {
      box.classList.remove('code-note');
      box.classList.add('code-shown');
      box.replaceChildren(renderCodeBoxes(state.code, { border: 'var(--border)', background: 'var(--bg)', text: 'var(--text)', textSecondary: 'var(--muted)' }));
      return;
    }
    box.classList.remove('code-shown');
    box.classList.add('code-note');
    box.textContent =
      state.status === 'flooded'
        ? 'Too many attempts on this code — scan the QR instead'
        : state.status === 'failed'
          ? 'Code connect not available'
          : 'Preparing a code…';
  };

  codes.subscribe(draw);
  return box;
}

function linkRow(uri: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'link-row';

  const field = document.createElement('input');
  field.value = uri;
  field.readOnly = true;
  field.spellcheck = false;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.onclick = () => {
    field.select();
    field.setSelectionRange(0, field.value.length);
    // execCommand because clipboard access needs a secure context, and a plain-http
    // LAN address is how this gets tested.
    const ok = navigator.clipboard?.writeText
      ? (void navigator.clipboard.writeText(field.value), true)
      : document.execCommand('copy');
    if (ok) {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1600);
    }
  };

  row.append(field, copy);
  return row;
}

function originRow(origin: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'origin';
  row.textContent = origin;
  row.title = 'Reported by your browser, not by the page';
  return row;
}

function rule(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rule';
  el.textContent = text;
  return el;
}

function heading(text: string): HTMLElement {
  const el = document.createElement('h1');
  el.textContent = text;
  return el;
}

function paragraph(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'muted';
  el.textContent = text;
  return el;
}
