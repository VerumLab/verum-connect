/**
 * In the dapp's page: the wallets a dapp looks for, each forwarding to the side panel
 * through the content script. EIP-1193 by EIP-6963, and `window.ethereum` where no
 * wallet set one; Aztec's extension discovery; Azguard's `window.azguard` where Azguard
 * is not installed. The page states nothing about itself the panel relies on: the
 * origin comes from the browser.
 */

import { Eip1193Surface, VERUM_ICON, VERUM_RDNS, localAnswer } from '@verumlab/connect-dapp/surface';
import { aztecCallOverSession, serveAztecWallet, standInAzguard } from '@verumlab/connect-protocol';
import { PROTOCOL, isVerumMessage, type ToPage } from '../../bookmarklet/src/messages.js';
import { FROM_PAGE, TO_PAGE, type Control } from './channel.js';

class VerumExtensionProvider extends Eip1193Surface {
  readonly isVerumConnect = true;
  private accounts: string[] = [];
  private chainId = '0x1';
  /** Paired, whether or not the wallet gave Ethereum accounts. */
  private live = false;
  /** Introduced to the panel since it last said it was ready. */
  private greeted = false;
  /** The panel is in its own window, not beside the dapp. */
  private showsCode = false;
  private chip: HTMLElement | null = null;
  private emojiChip: HTMLElement | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private queue: { id: number; method: string; params: unknown[] }[] = [];

  constructor() {
    super();
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.[TO_PAGE] !== true) return;
      if (event.data.control) control(event.data.control as Control);
      else if (event.data.message?.showCode === true) this.showsCode = true;
      else if (isVerumMessage(event.data.message)) this.receive(event.data.message as ToPage);
    });
  }

  get paired(): boolean {
    return this.live;
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const { method } = args;
    const params = args.params ?? [];
    const local = localAnswer(method, this.chainId, this.accounts);
    if (local) return local.value;
    if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
      await this.connect();
      return method === 'eth_requestAccounts' ? this.accounts : this.permissions();
    }
    if (method === 'wallet_getPermissions') return this.accounts.length > 0 ? this.permissions() : [];
    return this.forward(method, params);
  }

  /** A call that needs the session, pairing first: an Aztec session has no Ethereum accounts. */
  async withSession(method: string, params: unknown[]): Promise<unknown> {
    await this.connect();
    return this.forward(method, params);
  }

  private connect(): Promise<void> {
    if (this.live) return Promise.resolve();
    post({ type: 'open' });
    return new Promise((resolve, reject) => {
      const off = this.on('connect', () => {
        off();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        reject({ code: 4001, message: 'verum: pairing was not completed' });
      }, 300_000);
    });
  }

  private forward(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.greeted) post({ v: PROTOCOL, type: 'request', id, method, params });
      else this.queue.push({ id, method, params });
    });
  }

  private receive(message: ToPage): void {
    switch (message.type) {
      case 'ready':
        // Every ready would otherwise be answered, and each hello makes the panel say ready.
        if (this.greeted) return;
        this.greeted = true;
        post({ v: PROTOCOL, type: 'hello', title: document.title, ...(icon() ? { icon: icon() } : {}) });
        for (const call of this.queue.splice(0)) post({ v: PROTOCOL, type: 'request', ...call });
        return;
      case 'session': {
        const was = this.live;
        this.live = true;
        this.accounts = message.accounts;
        this.chainId = message.chainId;
        if (this.showsCode && message.code) this.showCode(message.code);
        if (!was) this.emit('connect', { chainId: this.chainId });
        this.emit('accountsChanged', this.accounts);
        this.emit('chainChanged', this.chainId);
        return;
      }
      case 'result':
        this.pending.get(message.id)?.resolve(message.result);
        this.pending.delete(message.id);
        return;
      case 'error':
        this.pending.get(message.id)?.reject(message.error);
        this.pending.delete(message.id);
        return;
      case 'event':
        if (message.event === 'accountsChanged') this.accounts = message.data as string[];
        if (message.event === 'chainChanged') this.chainId = message.data as string;
        if (message.event === 'disconnect') {
          this.chip?.remove();
          this.emojiChip?.remove();
          this.chip = this.emojiChip = null;
          this.live = false;
          this.greeted = false;
          this.accounts = [];
        }
        this.emit(message.event, message.data);
        return;
    }
  }

  /**
   * The session's four words beside the dapp, as the bookmarklet shows them; in a shadow
   * root, out of the dapp's styles. Shown, not trusted: the page could draw its own, so
   * the words to compare are the panel's and the hub's. A tap hides it.
   */
  private showCode(words: string[]): void {
    this.chip?.remove();
    this.chip = chip(words.join(' · '), 16, 'Verum Connect: this must match the code on your hub. Tap to hide.');
  }

  /** The emojis of the dapp's channel, which ends here: the dapp shows the same. */
  showEmojis(emojis: string): void {
    this.emojiChip?.remove();
    this.emojiChip = chip(emojis, 60, 'Verum Connect: these must match the emojis the dapp shows. Tap to hide.');
  }

  private permissions(): unknown[] {
    return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictedMethods', value: this.accounts }] }];
  }
}

/** A small badge beside the dapp, in a shadow root out of the dapp's styles; a tap hides it. */
function chip(text: string, bottom: number, title: string): HTMLElement {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.title = title;
  button.style.cssText =
    `position:fixed;z-index:2147483646;right:16px;bottom:${bottom}px;display:flex;gap:8px;align-items:center;` +
    'padding:8px 12px;border-radius:999px;border:1px solid #35332b;background:#1f1e18;color:#f2f0e9;' +
    'cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.3);' +
    'font:600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const dot = document.createElement('span');
  dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#63b587';
  const label = document.createElement('span');
  label.textContent = text;
  button.append(dot, label);
  button.onclick = () => host.remove();
  root.append(button);
  document.documentElement.append(host);
  return host;
}

function post(message: object): void {
  window.postMessage({ [FROM_PAGE]: true, message }, window.location.origin);
}

function icon(): string | undefined {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return link?.href || undefined;
}

const provider = new VerumExtensionProvider();

const info = { uuid: crypto.randomUUID(), name: 'Verum Connect', icon: VERUM_ICON, rdns: VERUM_RDNS };
const announce = () =>
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
window.addEventListener('eip6963:requestProvider', announce);
announce();
if (!(window as { ethereum?: unknown }).ethereum) (window as { ethereum?: unknown }).ethereum = provider;

/** Set in the panel, per site: the hub's Azguard in place of one in this browser. */
let override = false;

function control(next: Control): void {
  override = next.override;
}

standInAzguard(
  (method, params) => provider.withSession(method, params),
  () => provider.paired,
  (listener) => provider.on('azguard_event', listener),
  () => override,
);

// Aztec's discovery lists this beside any wallet of the browser's own: the dapp's channel
// ends here, and each call goes on to the hub's Aztec wallet.
serveAztecWallet(
  { id: 'verum-connect', name: 'Verum Connect', version: '0.1.0', icon: VERUM_ICON },
  aztecCallOverSession((method, params) => provider.withSession(method, params)),
  (emojis) => provider.showEmojis(emojis),
);
