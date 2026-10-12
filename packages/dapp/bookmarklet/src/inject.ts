/**
 * The bookmarklet's payload: a wallet injected into a dapp. It announces an EIP-1193
 * provider like an extension and forwards every call to a panel on our origin, which
 * connects to the nostr relays (see messages.ts). Nothing is fetched at run time: it
 * is carried inline, since a strict `script-src` blocks anything else.
 */

import { Eip1193Surface, VERUM_ICON, VERUM_RDNS, localAnswer } from '@verumlab/connect-dapp/surface';
import { PROTOCOL, isVerumMessage, type ToPage } from './messages.js';

/** The panel's address: the install page replaces it with its own location. */
declare const __POPUP_URL__: string;
const BAKED = __POPUP_URL__;

/**
 * A host, a directory or a whole address, all meaning the same panel. A bare host
 * keeps the path the bookmark already carries.
 */
function panelUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('is empty');
  // https unless a scheme says otherwise.
  const full = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const url = new URL(full);
  if (url.pathname === '/' && BAKED) {
    try {
      url.pathname = new URL(BAKED).pathname;
      return url.href;
    } catch {
      // A baked address that will not parse.
    }
  }
  if (/\.html?$/i.test(url.pathname)) return url.href;
  url.pathname = url.pathname.replace(/\/?$/, '/') + 'popup.html';
  return url.href;
}

/**
 * Key for tab to window link.
 */
const WINDOW_KEY = 'verum-connect/window';

function usableWidth(): number {
  const layout = document.documentElement.clientWidth || window.innerWidth;
  const visual = Math.round(window.visualViewport?.width ?? layout);
  return Math.max(240, Math.min(layout, visual));
}

/**
 * Check if the address is served. 
 */
async function reachable(url: string): Promise<'ok' | 'dead' | 'unknown'> {
  // An https page cannot fetch an http address, so there is nothing to learn and would close a working window.
  if (location.protocol === 'https:' && /^http:/i.test(url)) return 'unknown';

  let blocked = false;
  const watch = (event: SecurityPolicyViolationEvent): void => {
    if (event.disposition === 'enforce' && event.effectiveDirective.startsWith('connect-src')) {
      blocked = true;
    }
  };
  window.addEventListener('securitypolicyviolation', watch);

  let slow = false;
  try {
    await Promise.race([
      fetch(url, { mode: 'no-cors', cache: 'no-store' }),
      new Promise((_, reject) =>
        setTimeout(() => {
          slow = true;
          reject(new Error('slow'));
        }, PROBE_MS),
      ),
    ]);
    return 'ok';
  } catch {
    // The violation event is queued apart from the fetch's rejection and can land after
    // it; deciding at once misread the dapp's own policy as a dead host.
    if (!blocked && !slow) await new Promise((resolve) => setTimeout(resolve, 300));
    return blocked || slow ? 'unknown' : 'dead';
  } finally {
    window.removeEventListener('securitypolicyviolation', watch);
  }
}

/** Named per dapp; see openWindow. */
function windowName(): string {
  // The gateway, a window left by a bookmark from another gateway would otherwise
  // be found by name and knocked on, with its answers refused.
  let gateway = '';
  try {
    gateway = new URL(CANDIDATES[0] ?? '', location.href).host;
  } catch {
    // No address to take a name from.
  }
  return ('verum-connect-' + location.host + '-' + gateway).replace(/[^a-z0-9-]/gi, '-');
}

/**
 * Links window this tab has open, in session storage: it survives a reload of the
 * dapp (reattach) and goes with the tab.
 */
const OPEN_WINDOW_KEY = 'verum-connect/open-window';

const openWindowName = (): string | null => guard(() => sessionStorage.getItem(OPEN_WINDOW_KEY), null);
const rememberOpenWindow = (name: string): void =>
  guard(() => sessionStorage.setItem(OPEN_WINDOW_KEY, name), undefined);
const forgetOpenWindow = (): void => guard(() => sessionStorage.removeItem(OPEN_WINDOW_KEY), undefined);

/**
 * Keyed to the dapp only: whether a page can frame us is its policy, not the
 * bookmark's.
 */
const rememberedWindow = (): boolean => guard(() => localStorage.getItem(WINDOW_KEY) === location.host, false);

function rememberWindow(on: boolean): void {
  guard(() => (on ? localStorage.setItem(WINDOW_KEY, location.host) : localStorage.removeItem(WINDOW_KEY)), undefined);
}

const GATEWAY_KEY = 'verum-connect/gateway';

/**
 * The address chosen in the recovery field, once it has answered, keyed by the
 * bookmark too so one bookmark's repair does not redirect the others.
 */
const chosenGateway = (): string | null =>
  guard(() => JSON.parse(localStorage.getItem(GATEWAY_KEY) ?? '{}')[BAKED] ?? null, null);

function chooseGateway(address: string | null): void {
  guard(() => {
    const all = JSON.parse(localStorage.getItem(GATEWAY_KEY) ?? '{}');
    if (address) all[BAKED] = address;
    else delete all[BAKED];
    if (Object.keys(all).length > 0) localStorage.setItem(GATEWAY_KEY, JSON.stringify(all));
    else localStorage.removeItem(GATEWAY_KEY);
  }, undefined);
}

/**
 * The addresses to try: the chosen one, then the bookmark's own, so a chosen host
 * that went away falls back.
 */
const CANDIDATES = ((): string[] => {
  const chosen = chosenGateway();
  return chosen ? [chosen, BAKED] : [BAKED];
})();

/**
 * How long a copy gets to say `ready` before the next is tried. 
 */
const LOAD_TIMEOUT_MS = 8000;

/**
 * How long a window gets, which is less: one that cannot reach its address has
 * already drawn the browser's failure page.
 */
const WINDOW_ANSWER_MS = 2500;

/**
 * How long the address gets to answer a probe before it counts as slow. Short: it
 * races a window already open.
 */
const PROBE_MS = 1200;

/**
 * How long the panel stays up after pairing before tucking itself away: long
 * enough to read the session code.
 */
const MINIMISE_AFTER_MS = 1800;

/** How long "Disconnected" stays before the chip goes. */
const CHIP_LINGER_MS = 5000;

/** How long the fallback window stays up after its session ends, showing why. */
const WINDOW_CLOSE_AFTER_MS = 2000;

/**
 * The panel's own colours for the frame around it, read at mount: the panel follows
 * the system theme on its own, and a mismatch shows as a seam.
 */
function palette(): Record<string, string> {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return dark
    ? { bg: '#16150f', surface: '#1f1e18', border: '#35332b', text: '#f2f0e9', muted: '#9c988d', accent: '#e8703f' }
    : { bg: '#f6f6f4', surface: '#ffffff', border: '#dedbd4', text: '#1a1917', muted: '#6b6862', accent: '#b5451b' };
}

/**
 * What a button drawn in a dapp's page must undo first: dapps style `button`
 * globally (padding, min-height), which stretched the close button into an oval.
 */
const BUTTON_RESET =
  'all:unset;box-sizing:border-box;margin:0;padding:0;min-width:0;min-height:0;' +
  'max-width:none;width:auto;height:auto;line-height:1.2;text-transform:none;' +
  'letter-spacing:normal;appearance:none;-webkit-appearance:none;' +
  // `all: unset` leaves a button inline, where width and height do nothing; each
  // button sets its own display.
  'display:inline-flex;align-items:center;justify-content:center;';

type Child = Node | string;

/**
 * An element with its inline style, properties and children in one call; what the
 * element has no property for (aria-*) becomes an attribute.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css = '',
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  for (const [key, value] of Object.entries(props)) {
    if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...kids);
  return node;
}

const btn = (css: string, props: Record<string, unknown>, ...kids: Child[]): HTMLButtonElement =>
  el('button', BUTTON_RESET + css, props, ...kids);

/** Fade an element out after a delay, then remove it. */
function fadeOut(node: HTMLElement, after: number, done?: () => void): void {
  node.style.transition = 'opacity 400ms';
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => {
      node.remove();
      done?.();
    }, 400);
  }, after);
}

/** Close a window we opened; a browser may refuse, which only leaves it showing. */
function closeQuietly(win: Window | null | undefined): void {
  try {
    win?.close();
  } catch {
    // Refused.
  }
}

/** Storage can be refused (private mode, blocked site data); what was kept then lasts the page load. */
function guard<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

class VerumBookmarkletProvider extends Eip1193Surface {
  readonly isVerum = true;

  /**
   * A well-known wallet's flag, claimed only when nothing else holds window.ethereum:
   * dapps that ignore EIP-6963 identify wallets by such flags.
   */
  isMetaMask = false;
  _metamask?: { isUnlocked: () => Promise<boolean> };

  accounts: string[] = [];
  chainId = '0x1';

  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Whichever half is showing the pairing: a frame's window or a popup. */
  private target: Window | null = null;
  private popup: Window | null = null;
  private overlay: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private card: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private chip: HTMLElement | null = null;
  /** The last note beside the chip, so a second replaces it. */
  private note: HTMLElement | null = null;
  private candidate = 0;
  /** An address just typed, kept until it answers. */
  private typed: string | null = null;
  /** Why the panel was reached at all; see mountPanel. */
  private why: string | null = null;
  private loading: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  /** Whether this page has introduced itself to the current target. */
  private greeted = false;
  /** Whether this dapp has been sent down the window route. */
  private usedWindow = false;
  /** The dapp's own `overflow`, while a full-screen sheet holds it still. */
  private scrolled: string | null = null;
  private queue: { id: number; method: string; params: unknown[] }[] = [];
  /**
   * Whether the dapp asked for accounts itself; if so it is mid-flow and must not be
   * prodded into a second.
   */
  private asked = false;
  /** Rejects the dapp's pending connect request, which would otherwise hold it "connecting". */
  private abandonConnect: (() => void) | null = null;

  constructor() {
    super();
    window.addEventListener('message', (event) => this.onMessage(event));
  }

  /**
   * Show the pairing as an overlay: a cross-origin iframe, so it keeps its own origin
   * and a browser-stamped origin on its messages. Run inside the click, as the
   * fallback opens a window.
   */
  open(): void {
    // A live window comes before any overlay.
    if (this.popup && !this.popup.closed) {
      console.debug('[verum] window already open — raising it');
      this.tearDownPanel();
      this.raiseWindow();
      return;
    }
    if (this.overlay) {
      console.debug('[verum] panel already mounted — showing it');
      this.overlay.style.display = 'flex';
      if (window.innerWidth < 640) this.lockScroll();
      return;
    }
    // Once this dapp has taken the window route, stay on it.
    if (this.usedWindow || rememberedWindow()) {
      console.debug('[verum] this dapp uses a window — going straight there');
      this.openWindow();
      // Allow removing preference.
      this.say('Opened in a separate window, as remembered for this site.', {
        label: 'Use the side panel instead',
        run: () => this.forgetWindow(),
      });
      return;
    }
    console.debug('[verum] opening the panel');
    this.mountPanel();
  }

  /**
   * Keep saying hello to a window until it answers: it can arrive without an opener
   * while we hold a handle, and each side would wait for the other.
   */
  private knockUntilReady(target: Window): void {
    const started = Date.now();
    const timer = setInterval(() => {
      if (this.ready || this.target !== target || target.closed || Date.now() - started > WINDOW_ANSWER_MS) {
        clearInterval(timer);
        return;
      }
      try {
        target.postMessage(this.hello(), this.popupOrigin);
      } catch {
        // Not loaded yet or navigating; the next knock is 300ms away.
      }
    }, 300);
  }

  /**
   * Drop the remembered window route and try the panel. 
   */
  private forgetWindow(): void {
    rememberWindow(false);
    forgetOpenWindow();
    this.usedWindow = false;
    closeQuietly(this.popup);
    this.detachWindow();
    this.mountPanel();
  }

  /**
   * Bring the window forward: open by name inside the click as well as focus(), as a
   * phone will not focus another tab. Empty URL, so the session-holding document is
   * not navigated.
   */
  private raiseWindow(): void {
    // A background window is only raised by navigating it, which reloads it; the panel
    // is warned first, as a navigation looks like a closing tab. Both in one gesture: a
    // timer between them blocks the window.open.
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
      this.send({ v: PROTOCOL, type: 'raise' });
      const found = window.open(CANDIDATES[this.candidate] ?? CANDIDATES[0]!, windowName());
      if (found) {
        this.popup = found;
        this.target = found;
      }
      this.ready = false;
      // The reload announces itself if it can see us; we knock too, until one gets
      // through.
      this.greeted = false;
      this.awaitReady(WINDOW_ANSWER_MS);
      if (found) this.knockUntilReady(found);
      return;
    }

    // A phone raises nothing, so say where the window is.
    this.say('Verum Connect is open in another tab — swipe to it.');
  }

  /** Let go of the fallback window without closing it. */
  private detachWindow(): void {
    this.popup = null;
    this.target = null;
    this.ready = false;
  }

  /**
   * The panel: our origin, framed over the dapp. @param why what brought us here, in
   * the user's words, so the fallback card differs by cause.
   */
  mountPanel(why?: string): void {
    if (this.overlay) return;
    this.why = why ?? null;
    this.ready = false;
    this.greeted = false;
    this.candidate = 0;
    this.mountOverlay(CANDIDATES[0]!);
    this.awaitReady();
  }

  /**
   * The overlay and its card, empty: docked beside the dapp on desktop so it stays
   * visible, the whole screen on a phone; measured once at open.
   */
  private mountShell(): { overlay: HTMLElement; card: HTMLElement; skin: Record<string, string> } {
    const screen = usableWidth();
    const narrow = screen < 640;
    const skin = palette();

    const overlay = el(
      'div',
      // dvh, not %: phone toolbars come and go and would cover a sheet sized to the
      // document.
      `position:fixed;top:0;left:0;width:${screen}px;height:100dvh;z-index:2147483647;display:flex;` +
        `background:rgba(0,0,0,0.45);align-items:stretch;justify-content:${narrow ? 'center' : 'flex-end'}`,
      // Hidden, not destroyed: the frame holds the relay sockets, and clicking the dapp
      // is not saying the wallet is finished.
      {
        onclick: (event: Event) => {
          if (event.target === overlay) this.hide();
        },
      },
    );

    const card = el(
      'div',
      `position:relative;overflow:hidden;background:${skin.surface};box-shadow:0 0 64px rgba(0,0,0,0.4);` +
        (narrow
          ? // The whole screen, minus the parts of it the phone owns: a notch over
            // the top of the QR, or a home indicator across the connect code, is
            // the difference between a sheet and a sheet someone can use.
            `width:${screen}px;height:100%;padding:env(safe-area-inset-top) env(safe-area-inset-right) ` +
            'env(safe-area-inset-bottom) env(safe-area-inset-left);box-sizing:border-box'
          : `width:440px;max-width:${screen}px;height:100%;border-radius:14px 0 0 14px`),
    );

    overlay.append(card);
    document.body.append(overlay);
    this.card = card;
    this.overlay = overlay;
    if (narrow) this.lockScroll();
    return { overlay, card, skin };
  }

  /**
   * The panel as a card with only the reason it is empty, for the window route, whose
   * address failure otherwise leaves this page showing nothing.
   */
  mountFailureCard(why: string): void {
    this.why = why;
    if (!this.overlay) this.mountShell();
    this.offerWindow(undefined, true);
  }

  /** Go round again on whichever route this dapp uses. */
  private retry(): void {
    this.tearDownPanel();
    if (this.usedWindow || rememberedWindow()) this.openWindow();
    else this.mountPanel();
  }

  private mountOverlay(src: string): void {
    const { card, skin } = this.mountShell();

    // Behind the frame, so the card says something while the panel loads or if it
    // never arrives.
    const status = el(
      'div',
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        `padding:24px;text-align:center;color:${skin.muted};background:${skin.bg};` +
        'font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      { textContent: 'Loading Verum Connect…' },
    );
    const frame = el('iframe', 'position:relative;width:100%;height:100%;border:0;display:block', {
      src,
      title: 'Verum Connect',
    });
    const close = this.closeButton();

    card.append(status, frame, close);
    this.frame = frame;
    this.status = status;
    this.target = frame.contentWindow;

    // Said now, not after the timeout: this is when someone is looking at an unfilled
    // card.
    console.info('[verum] panel from', src, '— alternatives:', CANDIDATES.slice(1).join(', ') || 'none');

    // Known impossible, so go straight to the window: a frame is a subresource and an
    // https page will not load an http one, while a navigation is allowed.
    if (location.protocol === 'https:' && src.startsWith('http:')) {
      console.warn('[verum] mixed content: an https page cannot frame', src);
      this.offerWindow(
        'This dapp is https and the panel is http, which a browser will not mix inside a page. A separate window is allowed.',
      );
    }
  }

  /**
   * The dapp forbids framing us, or every copy is unreachable. Offer the window, on a
   * click (the gesture a popup needs). @param retry true when the address failed rather
   * than the frame: offer the same attempt again.
   */
  private offerWindow(reason?: string, retry = false): void {
    if (!this.overlay) return;
    const skin = palette();
    const card = this.overlay.firstElementChild as HTMLElement;
    const screen = usableWidth();
    card.style.height = 'auto';
    card.style.padding = '22px';
    card.style.boxSizing = 'border-box';
    // Auto height means a sheet, centred and kept inside the screen.
    if (screen < 640) {
      this.overlay.style.alignItems = 'center';
      this.overlay.style.padding = '16px';
      this.overlay.style.boxSizing = 'border-box';
      card.style.width = `${Math.min(screen - 32, 420)}px`;
      card.style.borderRadius = '14px';
    }
    card.style.font = '15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    card.replaceChildren();

    // The same wordmark as the hub, install page and panel, so this card drawn in a
    // dapp's page says whose failure it is.
    const title = el(
      'h1',
      `margin:0 0 12px;font:650 17px/1.3 inherit;letter-spacing:-0.01em;color:${skin.text}`,
      {},
      'Verum ',
      el('span', `color:${skin.accent}`, { textContent: 'Connect' }),
      el('em', `font-style:normal;font-weight:500;color:${skin.muted}`, { textContent: ' · Bookmarklet' }),
    );

    const text = el('p', `margin:0 0 16px;font-size:13px;color:${skin.muted}`, {
      textContent: [
        this.why,
        reason ??
          (retry
            ? ''
            : 'This site does not allow Verum Connect to open inside its page. It can open in its own window instead.'),
      ]
        .filter(Boolean)
        .join(' '),
    });

    const button = btn(
      `font:550 14px/1 inherit;padding:10px 14px;border-radius:10px;border:1px solid ${skin.border};` +
        `background:${skin.bg};color:${skin.text};cursor:pointer`,
      {
        textContent: retry ? 'Try again' : 'Open in a window',
        onclick: () => {
          if (retry) {
            this.retry();
            return;
          }
          this.openWindow();
          // The card stays and says what happened: a blocked or severed window looks like
          // nothing happening.
          text.textContent =
            'Opened in a separate window. If nothing appeared, your browser blocked it — allow pop-ups for this site and click the bookmark again.';
          button.remove();
        },
      },
    );

    card.append(title, text, button, this.addressField(), this.closeButton(true));
  }

  /**
   * The ✕ in the corner, a method because offerWindow repaints the card. @param
   * compact true on the short fallback card.
   */
  private closeButton(compact = false): HTMLElement {
    const big = window.innerWidth < 640 && !compact;
    // Once paired this puts the panel away (the chip brings it back); before that it
    // cancels.
    return btn(
      'position:absolute;border:0;cursor:pointer;border-radius:50%;' +
        'background:rgba(0,0,0,0.35);color:#fff;font:600 15px/1 sans-serif;' +
        (big
          ? 'top:calc(10px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));' +
            'width:40px;height:40px;font-size:18px'
          : 'top:8px;right:8px;width:28px;height:28px'),
      {
        textContent: '\u2715',
        'aria-label': 'Close',
        onclick: () => (this.accounts.length > 0 ? this.hide() : this.dismiss()),
      },
    );
  }

  /**
   * A way out when every address is dead, on the dapp's page; a typed address is kept
   * for this site once it answers.
   */
  private addressField(): HTMLElement {
    const skin = palette();
    const mono = 'ui-monospace, Menlo, monospace';
    const chosen = chosenGateway();

    const use = (): void => {
      let url: string;
      try {
        url = panelUrl(field.value);
      } catch (err) {
        problem.textContent = `That address ${(err as Error).message}.`;
        return;
      }
      this.typed = url;
      CANDIDATES.unshift(url);
      console.info('[verum] trying', url);
      // Back the way this dapp was working: a page that refuses framing refuses the new
      // address too, and the click is the gesture a window needs.
      this.retry();
    };

    const field = el(
      'input',
      `flex:1;min-width:0;padding:8px;border-radius:8px;border:1px solid ${skin.border};` +
        `font:12px ${mono};background:${skin.surface};color:${skin.text}`,
      {
        placeholder: 'a-gateway.example',
        spellcheck: false,
        'aria-label': 'Gateway host',
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter') use();
        },
      },
    );
    const problem = el('p', 'margin:8px 0 0;font-size:12px;color:#c2410c');

    // Closed: a way out of a dead address, not a step of retrying it.
    const disclosure = el(
      'details',
      '',
      {},
      el('summary', `cursor:pointer;font-size:12px;color:${skin.muted};margin-bottom:6px`, {
        textContent: 'use other gateway',
      }),
      el(
        'div',
        'display:flex;gap:6px',
        {},
        field,
        btn(
          `font:600 13px/1 inherit;padding:9px 12px;border-radius:8px;border:1px solid ${skin.border};` +
            `background:${skin.bg};color:${skin.text};cursor:pointer`,
          { textContent: 'Load', onclick: use },
        ),
      ),
      problem,
      // Shown so the address can be taken elsewhere, to a node or a gateway checked by
      // hand.
      el('p', `margin:8px 0 0;font:11px ${mono};color:${skin.muted};overflow-wrap:anywhere`, {
        textContent: `current: ${chosen ?? BAKED}`,
      }),
    );

    // Under the field it was set in.
    if (chosen) {
      const link = el('a', 'color:inherit;text-decoration:underline', {
        textContent: 'here',
        target: '_blank',
        rel: 'noopener',
      });
      try {
        link.href = new URL('install.html', chosen).href;
      } catch {
        // A stored address that will not parse has nothing to link to.
      }
      disclosure.append(
        // This site only remembers it; a bookmark made there carries it everywhere.
        el(
          'p',
          `margin:8px 0 0;font-size:12px;color:${skin.muted}`,
          {},
          `Only used here (${location.host}). To use on every site install a new bookmark `,
          link,
          '.',
        ),
        btn(
          `margin-top:8px;font:600 12px/1 inherit;padding:8px 10px;border-radius:8px;border:1px solid ${skin.border};` +
            `background:${skin.bg};color:${skin.text};cursor:pointer`,
          {
            textContent: 'Reset to original',
            onclick: () => {
              chooseGateway(null);
              CANDIDATES.splice(0, CANDIDATES.length, BAKED);
              this.retry();
            },
          },
        ),
      );
    }
    return el('div', `margin-top:20px;border-top:1px solid ${skin.border};padding-top:16px`, {}, disclosure);
  }

  private openWindow(): void {
    this.usedWindow = true;
    rememberWindow(true);
    this.ready = false;
    this.greeted = false;
    this.candidate = 0;
    // The frame stops being the target once a window takes over, or a stale frame on
    // that origin would still be trusted.
    this.frame = null;
    const name = windowName();
    const known = openWindowName() === name;
    const found = known
      ? window.open('', name, 'width=420,height=680')
      : window.open(CANDIDATES[0], name, 'width=420,height=680');
    if (!found) {
      console.error('[verum] the window was blocked — allow pop-ups for this site and click again');
      return;
    }
    rememberOpenWindow(name);

    // A found window is blank if it had gone; a live one is cross-origin and reading its
    // location throws, which is the test.
    let blank = !known;
    if (known) {
      try {
        blank = found.location.href === 'about:blank';
        // Gone: this blank window is sent where it should be. It breaks under an
        // opener policy, but only after a window closed unseen.
        if (blank) found.location.href = CANDIDATES[0]!;
      } catch {
        blank = false;
      }
    }

    this.popup = found;
    this.target = found;

    if (blank) {
      console.info(`[verum] opening a window at ${CANDIDATES[0]}`);
      this.awaitReady(WINDOW_ANSWER_MS);
      this.knockUntilReady(found);
    } else {
      // Already pairing or paired: it will not announce again, so knock and it answers
      // with its session.
      console.info('[verum] reattaching to the window already open for this dapp');
      found.focus();
      this.sendHello();
      this.awaitReady(WINDOW_ANSWER_MS);
    }

    // Nothing else tells the page the user closed it. Watches this window, not whatever
    // `popup` points at later.
    const watched = this.popup;
    const watch = setInterval(() => {
      if (this.popup !== watched) {
        clearInterval(watch);
        return;
      }
      if (watched.closed) {
        clearInterval(watch);
        forgetOpenWindow();
        this.detachWindow();
        this.dropSession('verum: window closed');
      }
    }, 1000);
  }

  /**
   * A line of text beside the chip, for what a page cannot do for you; drawn here, not
   * logged, since the user is looking at the dapp.
   */
  private say(message: string, action?: { label: string; run: () => void }): void {
    this.note?.remove();

    const note = el(
      'div',
      'position:fixed;right:16px;z-index:2147483646;max-width:min(320px,calc(100vw - 32px));' +
        'padding:9px 13px;border-radius:12px;border:1px solid #35332b;background:#1f1e18;' +
        'color:#f2f0e9;box-shadow:0 8px 24px rgba(0,0,0,0.3);' +
        'font:500 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      { textContent: message },
    );

    // Above the chip, or below it when dragged to the top.
    const box = this.chip?.getBoundingClientRect();
    if (box && box.top < window.innerHeight / 2) note.style.top = `${Math.round(box.bottom + 8)}px`;
    else note.style.bottom = `${Math.round(window.innerHeight - (box?.top ?? 0) + 8)}px`;

    if (action) {
      note.append(
        btn(
          'display:block;margin-top:6px;padding:0;border:0;background:none;cursor:pointer;' +
            'font:600 12px/1.45 inherit;color:#e8703f;text-decoration:underline',
          {
            type: 'button',
            textContent: action.label,
            onclick: () => {
              note.remove();
              action.run();
            },
          },
        ),
      );
    }

    document.body.append(note);
    this.note = note;
    // Longer when there is something to press.
    fadeOut(note, action ? 9000 : 4000);
  }

  /** Out of the way, still running. */
  private hide(): void {
    if (this.overlay) this.overlay.style.display = 'none';
    this.unlockScroll();
  }

  /** Stop the dapp scrolling behind a full-screen sheet, remembering what it had. */
  private lockScroll(): void {
    if (this.scrolled !== null) return;
    this.scrolled = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  private unlockScroll(): void {
    if (this.scrolled === null) return;
    document.body.style.overflow = this.scrolled;
    this.scrolled = null;
  }

  /**
   * Stop covering the dapp once there is a session: a dimmed backdrop suits pairing
   * and is wrong once the dapp is usable, since every click would land on us.
   */
  private undim(): void {
    if (!this.overlay || !this.card) return;
    this.overlay.style.background = 'transparent';
    this.overlay.style.pointerEvents = 'none';
    this.card.style.pointerEvents = 'auto';
  }

  /**
   * Close the overlay. The sockets live in the frame, so this ends the session, as
   * closing the window does.
   */
  private dismiss(): void {
    this.tearDownPanel();
    this.dropSession('verum: closed');
  }

  /**
   * The session is over and the wallet said so: the panel goes at once, the chip stays
   * a moment as the notice.
   */
  private retireChip(): void {
    this.tearDownPanel();
    this.closeWindow();

    // The dapp has to ask again for anything to happen; clearing this lets the nudge
    // press its button on the next session.
    this.asked = false;

    for (const [id, waiting] of this.pending) {
      waiting.reject({ code: 4900, message: 'verum: session ended' });
      this.pending.delete(id);
    }

    const chip = this.chip;
    if (!chip) return;
    chip.lastElementChild!.textContent = 'Disconnected';
    (chip.firstElementChild as HTMLElement).style.background = '#9c988d';
    chip.onclick = null;
    chip.onpointerdown = null;
    chip.style.cursor = 'default';
    fadeOut(chip, CHIP_LINGER_MS, () => {
      if (this.chip === chip) this.chip = null;
    });
  }

  /**
   * Close the fallback window once its session is over, delayed so the reason is
   * readable.
   */
  private closeWindow(): void {
    const popup = this.popup;
    if (!popup || popup.closed) return;
    setTimeout(() => {
      forgetOpenWindow();
      closeQuietly(popup);
      if (this.popup === popup) {
        this.popup = null;
        if (this.target === popup) this.target = null;
        this.ready = false;
      }
    }, WINDOW_CLOSE_AFTER_MS);
  }

  /**
   * Drop the panel and everything pointing at it, so the next open() builds a new
   * one.
   */
  private tearDownPanel(): void {
    this.unlockScroll();
    this.overlay?.remove();
    this.overlay = null;
    this.card = null;
    this.frame = null;
    this.status = null;
    const live = this.popup && !this.popup.closed ? this.popup : null;
    this.target = live;
    // Only when nothing is left to talk to: a live window is still the target.
    if (!live) {
      this.ready = false;
      this.greeted = false;
    }
  }

  private dropSession(reason: string): void {
    this.abandonConnect?.();
    this.asked = false;
    this.chip?.remove();
    this.chip = null;
    if (this.accounts.length === 0) return;
    this.accounts = [];
    this.emit('accountsChanged', []);
    this.emit('disconnect', { code: 4900, message: reason });
  }

  /**
   * The session code, parked in the corner while the session lasts, for a dapp with
   * nowhere to put it. 
   */
  private showCode(words: string[]): void {
    this.chip?.remove();

    const chip = btn(
      'position:fixed;z-index:2147483646;display:flex;gap:8px;touch-action:none;' +
        'align-items:center;padding:8px 12px;border-radius:999px;border:1px solid #35332b;' +
        'background:#1f1e18;color:#f2f0e9;cursor:grab;box-shadow:0 8px 24px rgba(0,0,0,0.3);' +
        'font:600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      { title: 'Verum Connect — this must match the code on your wallet. Drag to move it.' },
      el('span', 'width:7px;height:7px;border-radius:50%;background:#63b587'),
      el('span', '', { textContent: words.join(' · ') }),
    );
    place(chip, 'bottom-right');

    // Draggable and snapped to a corner on release: whichever corner is free here
    // covers a control there, and only the user knows which.
    let moved = false;
    chip.onpointerdown = (down: PointerEvent) => {
      moved = false;
      // Check finger tap: a tap wanders further than four pixels, so every tap
      // read as a drag.
      const slack = down.pointerType === 'touch' ? 14 : 4;
      const box = chip.getBoundingClientRect();
      const grabX = down.clientX - box.left;
      const grabY = down.clientY - box.top;
      chip.setPointerCapture(down.pointerId);

      const drag = (at: PointerEvent): void => {
        if (Math.abs(at.clientX - down.clientX) + Math.abs(at.clientY - down.clientY) > slack) {
          moved = true;
        }
        if (!moved) return;
        chip.style.cursor = 'grabbing';
        chip.style.right = 'auto';
        chip.style.bottom = 'auto';
        chip.style.left = `${at.clientX - grabX}px`;
        chip.style.top = `${at.clientY - grabY}px`;
      };

      const drop = (): void => {
        chip.removeEventListener('pointermove', drag);
        chip.removeEventListener('pointerup', drop);
        chip.style.cursor = 'grab';
        if (!moved) return;
        const box2 = chip.getBoundingClientRect();
        place(
          chip,
          `${box2.top + box2.height / 2 < window.innerHeight / 2 ? 'top' : 'bottom'}-` +
            `${box2.left + box2.width / 2 < window.innerWidth / 2 ? 'left' : 'right'}`,
        );
      };

      chip.addEventListener('pointermove', drag);
      chip.addEventListener('pointerup', drop);
    };

    // Reopens the panel; skipped after a drag. Bound to pointerup as well as click (a
    // page may never see a click on touch), so guard against opening twice.
    let lastOpen = 0;
    const reopen = (): void => {
      if (moved || Date.now() - lastOpen < 600) return;
      lastOpen = Date.now();
      console.debug('[verum] chip tapped — opening');
      this.open();
    };
    chip.onclick = reopen;
    chip.addEventListener('pointerup', (up: PointerEvent) => {
      if (up.pointerType === 'touch') reopen();
    });

    document.body.append(chip);
    this.chip = chip;
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const method = args.method;
    const params = args.params ?? [];

    console.debug('[verum] dapp asked', method, '| accounts', this.accounts.length, '| ready', this.ready);

    // Answered here so a dapp polling state does not wake the relay.
    const local = localAnswer(method, this.chainId, this.accounts);
    if (local) return local.value;

    // The connect family: all mean "let this dapp in", and some libraries open with
    // wallet_requestPermissions rather than eth_requestAccounts.
    if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
      this.asked = true;
      const accounts = this.accounts.length > 0 ? this.accounts : await this.connectAccounts();
      return method === 'eth_requestAccounts' ? accounts : this.permissions();
    }

    if (method === 'wallet_getPermissions') {
      return this.accounts.length > 0 ? this.permissions() : [];
    }

    // Libraries call this on disconnect, the only signal a dapp gives that it is
    // finished; passed on so the session leaves the phone.
    if (method === 'wallet_revokePermissions') {
      if (this.accounts.length === 0) return null;
      const result = await this.forward(method, params);
      this.retireChip();
      this.accounts = [];
      this.emit('accountsChanged', []);
      this.emit('disconnect', { code: 4900, message: 'verum: disconnected by the dapp' });
      return result;
    }

    return this.forward(method, params);
  }

  /** Send a request to the panel and wait for its answer. */
  private forward(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    console.debug('[verum] →', id, method, params);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ready) this.send({ v: PROTOCOL, type: 'request', id, method, params });
      // Queued, not refused: the panel takes a moment to load.
      else this.queue.push({ id, method, params });
    });
  }

  /** Open the panel and resolve once a wallet is paired. */
  private connectAccounts(): Promise<string[]> {
    this.open();
    return new Promise((resolve, reject) => {
      const done = (): void => {
        off();
        clearTimeout(timer);
        this.abandonConnect = null;
      };
      const off = this.on('accountsChanged', (accounts) => {
        done();
        resolve(accounts as string[]);
      });
      const timer = setTimeout(() => {
        done();
        reject({ code: 4001, message: 'verum: pairing was not completed' });
      }, 300_000);
      this.abandonConnect = () => {
        done();
        reject({ code: 4001, message: 'verum: closed before pairing' });
      };
    });
  }

  /**
   * EIP-2255's shape for "this dapp may see these accounts", built here since the
   * permission is this page's session.
   */
  private permissions(): unknown[] {
    return [
      {
        parentCapability: 'eth_accounts',
        caveats: [{ type: 'restrictedMethods', value: this.accounts }],
      },
    ];
  }

  /**
   * Move to the next copy when this one does not answer, in the same window or frame.
   * Silence means a copy that is down or a dapp that forbids framing; both end at the
   * same offer.
   */
  private awaitReady(wait = LOAD_TIMEOUT_MS): void {
    if (this.loading) clearTimeout(this.loading);
    this.loading = setTimeout(() => {
      if (this.ready) return;
      if (this.popup?.closed) return;

      const next = CANDIDATES[++this.candidate];
      if (!next) {
        console.warn('[verum] no copy answered:', CANDIDATES.join(', '));

        // A silent frame is usually the dapp refusing to frame us, not the gateway, and the
        // answer is a window. Only the address can say which, so ask before concluding.
        if (this.frame) {
          const last = CANDIDATES[this.candidate - 1] ?? CANDIDATES[0]!;
          void reachable(last).then((verdict) => {
            if (this.ready) return;
            if (verdict === 'dead') this.mountFailureCard('Could not connect to the gateway.');
            else this.offerWindow();
          });
          return;
        }

        // The window shows the browser's own failure page; not ours to leave.
        closeQuietly(this.popup);
        this.detachWindow();
        this.mountFailureCard('Could not connect to the gateway.');
        return;
      }

      console.warn('[verum] no answer from', CANDIDATES[this.candidate - 1], '— trying', next);
      this.greeted = false;
      if (this.frame) {
        this.frame.src = next;
        this.target = this.frame.contentWindow;
      } else if (this.popup) {
        this.popup.location.href = next;
      }
      this.awaitReady(wait);
    }, wait);
  }

  private get popupOrigin(): string {
    return new URL(CANDIDATES[this.candidate]!, location.href).origin;
  }

  private send(message: object): void {
    this.target?.postMessage(message, this.popupOrigin);
  }

  /**
   * Introduce this page once: a second hello would have two windows greeting each
   * other forever.
   */
  private sendHello(): void {
    if (this.greeted) return;
    this.greeted = true;
    this.send(this.hello());
  }

  private hello(): object {
    return {
      v: PROTOCOL,
      type: 'hello',
      title: document.title,
      icon: findIcon(),
      elsewhere: CANDIDATES[this.candidate] !== BAKED,
    };
  }

  private onMessage(event: MessageEvent): void {
    // Both checks matter: the origin is the panel's, and the sender is the window or
    // frame we opened.
    if (event.origin !== this.popupOrigin || event.source !== this.target) return;
    if (!isVerumMessage(event.data)) return;
    const message = event.data as ToPage;

    switch (message.type) {
      case 'ready': {
        this.ready = true;
        // Answered by the typed address, not a fallback behind it: only then is it worth
        // keeping.
        if (this.typed && CANDIDATES[this.candidate] === this.typed) {
          chooseGateway(this.typed === BAKED ? null : this.typed);
          this.typed = null;
        }
        // The panel answered inside a frame, so whatever made us fall back is over: stop
        // preferring the window.
        if (this.frame) rememberWindow(false);
        if (this.loading) clearTimeout(this.loading);
        this.loading = null;
        this.status?.remove();
        this.status = null;
        this.sendHello();
        for (const call of this.queue.splice(0)) {
          this.send({ v: PROTOCOL, type: 'request', ...call });
        }
        return;
      }
      case 'session': {
        const wasConnected = this.accounts.length > 0;
        this.accounts = message.accounts;
        this.chainId = message.chainId;
        if (message.code) this.showCode(message.code);
        this.undim();

        // Pairing connected us but the dapp believes it has no wallet until its own code
        // asks, so announce again and let the nudge press its button; skipped once the dapp
        // has asked.
        setTimeout(() => {
          announce();
          window.dispatchEvent(new Event('ethereum#initialized'));
          console.debug('[verum] session live —', this.asked ? 'dapp asked already, not nudging' : 'nudging the dapp');
          if (!this.asked) nudge();
          // Docked out of the way: the dapp is what the user came for, and the chip brings
          // this back.
          this.hide();
        }, MINIMISE_AFTER_MS);
        if (!wasConnected) this.emit('connect', { chainId: this.chainId });
        this.emit('accountsChanged', this.accounts);
        this.emit('chainChanged', this.chainId);
        announce();
        takeOver();
        return;
      }
      case 'result': {
        console.debug('[verum] ←', message.id, message.result);
        if (!this.pending.has(message.id)) console.warn('[verum] result for an unknown request', message.id);
        this.pending.get(message.id)?.resolve(message.result);
        this.pending.delete(message.id);
        return;
      }
      case 'error': {
        console.debug('[verum] ✗', message.id, message.error);
        this.pending.get(message.id)?.reject(message.error);
        this.pending.delete(message.id);
        return;
      }
      case 'use-panel': {
        // Honoured only from our own panel's window; cleared for the next click, not acted
        // on now, as the window carries the session in progress.
        rememberWindow(false);
        this.usedWindow = false;
        this.send({ v: PROTOCOL, type: 'use-panel-done' });
        return;
      }
      case 'event': {
        console.debug('[verum] event from the wallet:', message.event, message.data);
        if (message.event === 'accountsChanged') this.accounts = message.data as string[];
        if (message.event === 'chainChanged') this.chainId = message.data as string;
        if (message.event === 'disconnect') {
          this.accounts = [];
          this.retireChip();
        }
        this.emit(message.event, message.data);
        return;
      }
    }
  }
}

/**
 * The dapp's icon for the wallet to show: skipped unless it is a data URI the hub
 * can render without a third party.
 */
function findIcon(): string | undefined {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const href = link?.href;
  return href?.startsWith('data:image/') ? href : undefined;
}

const provider = new VerumBookmarkletProvider();

/** Named for the bookmarklet, so it is never mistaken for a dapp's own Verum Connect. */
function providerInfo(): { uuid: string; name: string; icon: string; rdns: string } {
  return {
    uuid: '7c7f1f8e-3a8c-4a5e-9c3f-2b7c2cf0a1d2',
    name: 'Verum Connect (bookmarklet)',
    icon: VERUM_ICON,
    rdns: VERUM_RDNS,
  };
}

/**
 * EIP-6963: how modern dapps find a wallet, and the only way to sit beside an
 * installed extension. Re-announced on request.
 */
function announce(): void {
  console.debug('[verum] announcing the provider');
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: providerInfo(), provider }),
    }),
  );
}

/** Whether we are the page's only wallet, decided once before anything is replaced. */
const alone = !(window as { ethereum?: unknown }).ethereum;

/**
 * window.ethereum, for older dapps: only when nothing is there or what is there can
 * be replaced, so a working extension is never overwritten.
 */
function takeOver(): void {
  if (alone && !provider.isMetaMask) {
    provider.isMetaMask = true;
    provider._metamask = { isUnlocked: () => Promise.resolve(true) };
  }

  try {
    const existing = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (!existing) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return;
    }
    if (existing.configurable || existing.writable) {
      (window as { ethereum?: unknown }).ethereum = provider;
    }
  } catch (err) {
    console.warn('[verum] could not take over window.ethereum', err);
  }
}

/**
 * Make the dapp notice a wallet that appeared after it loaded: announce, press the
 * button the user would have pressed, pick our row. 
 */
function nudge(): void {
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));

  const connect = visibleControls().find((el) =>
    /^connect( a)?( wallet)?$|^sign in$/i.test(label(el)),
  );
  if (!connect) {
    console.debug('[verum] no connect button found on this page');
    return;
  }

  console.debug('[verum] clicking', JSON.stringify(label(connect)));
  connect.click();
  setTimeout(pickOurs, 900);
}

function pickOurs(): boolean {
  const ours = innermost(visibleControls().filter((el) => /verum.*bookmark/i.test(label(el))));
  if (!ours) {
    console.debug('[verum] our row is not on screen');
    return false;
  }

  console.debug('[verum] clicking our row:', JSON.stringify(label(ours)));
  ours.click();
  return true;
}

/**
 * Pin an element to one corner, clearing the opposite edges, or it stretches
 * across the page.
 */
function place(el: HTMLElement, corner: string): void {
  el.style.left = corner.endsWith('left') ? '16px' : 'auto';
  el.style.right = corner.endsWith('right') ? '16px' : 'auto';
  el.style.top = corner.startsWith('top') ? '16px' : 'auto';
  el.style.bottom = corner.startsWith('bottom') ? '16px' : 'auto';
}

/**
 * Every clickable thing on the page, shadow roots included (querySelectorAll stops
 * at them). Used to find the connect button. Fallback is requiring the user to click the button.
 */
function visibleControls(): HTMLElement[] {
  const found: HTMLElement[] = [];

  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      // getClientRects, not offsetParent: a fixed-position control reports no
      // offsetParent while visible.
      if (el.getClientRects().length > 0 && clickable(el)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };

  walk(document);
  return found;
}

function clickable(el: HTMLElement): boolean {
  if (el.matches('button, a, [role="button"], [role="option"], [role="menuitem"], li, [onclick]')) {
    return true;
  }
  if (getComputedStyle(el).cursor !== 'pointer') return false;
  const parent = el.parentElement;
  return !parent || getComputedStyle(parent).cursor !== 'pointer';
}

function innermost(matches: HTMLElement[]): HTMLElement | undefined {
  return matches.find((el) => !matches.some((other) => other !== el && el.contains(other)));
}

/**
 * What the user reads on the control: innerText, as responsive markup holds a short
 * and a long label and textContent joins both.
 */
function label(el: HTMLElement): string {
  return el.innerText.trim().replace(/\s+/g, ' ');
}

/**
 * Where this injection leaves its handle, so a second click finds the wallet already
 * here instead of building another.
 */
declare global {
  interface Window {
    __verumConnect?: { open(): void };
  }
}

const already = window.__verumConnect;
if (already) {
  console.info('[verum] already injected — reopening');
  already.open();
} else {
  window.__verumConnect = { open: () => provider.open() };
  inject();
}

/**
 * Everything a first click does; on a repeat click nothing points at the provider
 * and it stays inert.
 */
function inject(): void {
  window.addEventListener('eip6963:requestProvider', () => {
    console.debug('[verum] the dapp asked who is here');
    announce();
  });
  // Ownership first, before anything that waits: dapps that enumerate wallets once at
  // start list us only if we are in place.
  takeOver();
  announce();
  // The pre-6963 path, on the same clock: detectors wait a few seconds for this event
  // and then conclude there is no wallet.
  window.dispatchEvent(new Event('ethereum#initialized'));
  provider.open();

  // Nudged now as well as after pairing: a dapp that builds its wallet list when it
  // opens must open it after we announced, or we are not in it.
  nudge();

  console.info('[verum] injected');
}
