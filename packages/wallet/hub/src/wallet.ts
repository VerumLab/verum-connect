/**
 * Wallet discovery: inside a wallet's in-app browser the hub is just another dapp,
 * so no wallet-side integration is needed. EIP-6963 first, then window.ethereum,
 * which is what mobile in-app browsers provide.
 */

// Defined by @verumlab/connect-wallet; re-exported so the hub's UI reaches for it
// from one place.
import type { Eip1193Provider } from '@verumlab/connect-wallet';
import {
  azguardProvider,
  aztecWalletProvider,
  findAzguard,
  type AzguardWalletInfo,
} from '@verumlab/connect-protocol';

export type { Eip1193Provider };

export interface DiscoveredWallet {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/**
 * Collect announced providers: EIP-6963 is push-based, so request an announcement
 * and give wallets a moment to answer.
 */
/**
 * The listener is never removed: extensions announce when their content script is
 * ready, which moves with main-thread load, so any fixed window loses the slowest.
 * The promise resolves once for first paint and `onUpdate` fires for later
 * arrivals; the re-request at 1.5s is for wallets that announce only when asked.
 */
export function discoverWallets(
  onUpdate?: (wallets: DiscoveredWallet[]) => void,
  timeoutMs = 400,
): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    let settled = false;

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.info || !detail.provider) return;
      // Verum Connect's own extension, which this hub would otherwise connect to itself.
      if (detail.info.rdns === 'me.verum.connect') return;
      const key = detail.info.uuid;
      if (found.has(key)) return;
      found.set(key, {
        id: detail.info.rdns || detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        provider: detail.provider,
      });
      if (settled) onUpdate?.([...found.values()]);
    };

    const request = () => window.dispatchEvent(new Event('eip6963:requestProvider'));

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    request();
    setTimeout(request, 1500);

    setTimeout(() => {
      settled = true;

      // Only when 6963 produced nothing: a late announcer would otherwise be shadowed by
      // this entry.
      if (found.size === 0) {
        const injected = (globalThis as any).ethereum as Eip1193Provider | undefined;
        if (injected && !(injected as { isVerumConnect?: boolean }).isVerumConnect) {
          found.set('injected', {
            id: 'injected',
            name: detectInjectedName(injected),
            provider: injected,
          });
        }
      }

      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/**
 * Aztec wallets, only where browser extensions run: Azguard, found as an injected
 * object, its info read without a prompt. It answers both ways a dapp reaches it, its
 * own API and Aztec's extension discovery, so its provider serves both.
 */
export async function aztecWallets(): Promise<DiscoveredWallet[]> {
  if (isMobileLike()) return [];
  const found: DiscoveredWallet[] = [];
  // Azguard's script can arrive late, behind a locked or starting wallet.
  const azguard = await findAzguard(10_000);
  if (azguard) {
    const info = (await azguard.createClient().request('get_wallet_info').catch(() => null)) as AzguardWalletInfo | null;
    const own = azguardProvider(azguard);
    const sdk = aztecWalletProvider();
    const provider = {
      isAztec: true,
      request: (args: { method: string; params?: unknown[] }) =>
        (args.method.startsWith('aztec_') ? sdk : own).request(args),
      on: (event: string, listener: (data: unknown) => void) =>
        (event === 'aztec_emojis' ? sdk : own).on(event, listener),
    };
    found.push({ id: 'azguard', name: info?.name ?? 'Azguard', icon: info?.logo, provider });
  }
  return found;
}

function detectInjectedName(provider: unknown): string {
  const p = provider as Record<string, unknown>;
  if (p.isRainbow) return 'Rainbow';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isFrame) return 'Frame';
  if (p.isMetaMask) return 'MetaMask';
  return 'Injected wallet';
}

/**
 * Is this page inside a wallet's in-app browser? Only decides whether to show the
 * deep-link handoff; trivially spoofable, so never security-relevant.
 */
export function hasInjectedWallet(): boolean {
  const injected = (globalThis as any).ethereum;
  return typeof injected !== 'undefined' && !injected.isVerumConnect;
}

/**
 * Rough guess at a phone or tablet, only to choose which advicent when  to prino
 * wallet is injected; being wrong costs a sentence. Asked as an input question (a
 * coarse primary pointer) because identity lies both ways: tablets send desktop
 * user agents. Deliberately not an engine check, as wallet extensions are not
 * engine-specific.
 */
export function isMobileLike(): boolean {
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.maxTouchPoints > 0) return true;
  // Kept as the fallback, so nothing this used to catch stops being caught.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Deep links that reopen the current URL inside a wallet's own browser. The two
 * shapes trade delivery against disclosure. A target as a percent-encoded query
 * parameter arrives whole but goes to the link service, which then sees the pairing
 * pubkey and relays (enough to race the real hub, which the session code catches).
 * A target inlined in the path keeps a literal `#`, so the pairing is the outer
 * link's fragment, never sent anywhere but lost by anything resolving server-side.
 * Only offered where an app can answer (isMobileLike): with the app installed the
 * OS hands the URL over directly, fragment included; otherwise the web fallback
 * arrives without the pairing.
 */
export function deepLinks(currentUrl: string): { name: string; url: string }[] {
  // These schemes accept only http(s) targets: a hub on ipfs:// or a local node has no
  // public URL to hand over, so offer nothing.
  if (!/^https?:\/\//.test(currentUrl)) return [];

  const target = encodeURIComponent(currentUrl);
  // One wallet requires a referrer: the hub stripped of its fragment, since repeating
  // the pubkey and relays there would disclose them twice.
  const ref = encodeURIComponent(currentUrl.split('#')[0]!);
  return [
    // One wallet forces https on everything it opens, so an http hub (a LAN address in
    // development) dies in the TLS handshake. Nothing to fix in the URL.
    { name: 'MetaMask', url: `https://link.metamask.io/dapp/${currentUrl.replace(/^https?:\/\//, '')}` },
    // Two wallets read the target from a query parameter (`url` or `cb_url`) and ignore
    // a path-form link.
    { name: 'Rainbow', url: `https://rnbwapp.com/dapp?url=${target}` },
    // The label follows the icon on the user's phone, the only name they can match; the
    // host and bundle id keep an older name.
    { name: 'Base', url: `https://go.cb-w.com/dapp?cb_url=${target}` },
    // coin_id is SLIP44 60, documented as required with url.
    { name: 'Trust Wallet', url: `https://link.trustwallet.com/open_url?coin_id=60&url=${target}` },
    // Known not to arrive with the pairing: one wallet's in-app browser does not
    // deliver URL parameters to the page (tested with fragment and query, several link
    // forms). Left in the documented form; those users paste into the hub's own field.
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${target}?ref=${ref}` },
    // `_cmd` is load-bearing: the target and home parsers bail only because the value
    // is neither absent nor `open-home`. The segment after /mobile/ is not a route (the
    // target is a query parameter), so it stays empty.
    { name: 'Rabby', url: `https://go.rabby.io/mobile/?_cmd=open-dapp&dapp=${target}` },
  ];
}
