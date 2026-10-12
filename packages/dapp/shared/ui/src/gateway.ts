/**
 * Which gateway list belongs to which role, once. On IPFS the two roles use
 * different lists: the desktop link is followed by a real browser (a verifying
 * gateway works), while a wallet's in-app browser runs no service worker and needs
 * a plain path gateway. For Arweave gateways no service worker is required.
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';

export type HubNetwork = 'arweave' | 'ipfs';

export interface GatewayState {
  network: HubNetwork;
  /**
   * True only when the dapp published both a CID and a transaction; with one there
   * is nothing to switch.
   */
  canSwitch: boolean;
  /** Offered for the link a desktop follows. */
  desktopGateways: string[];
  /** Offered for the URL handed to a wallet's in-app browser. */
  mobileGateways: string[];
  desktopGateway: string | null;
  mobileGateway: string | null;
}

export interface GatewayController {
  getState(): GatewayState;
  /** Returns an unsubscribe. Fires whenever the provider reports a change. */
  subscribe(listener: (state: GatewayState) => void): () => void;
  setNetwork(network: HubNetwork): void;
  setDesktopGateway(template: string): void;
  setMobileGateway(template: string): void;
  /**
   * Placeholder for a "your own gateway" prompt, matching the network: the
   * substitution is what a URL copied from a gateway's docs lacks.
   */
  customHint(): string;
  destroy(): void;
}

function read(provider: VerumConnectProvider): GatewayState {
  const arweave = provider.network === 'arweave';
  return {
    network: provider.network,
    canSwitch: provider.canSwitchNetwork,
    desktopGateways: arweave ? provider.arweaveGateways : provider.gateways,
    mobileGateways: arweave ? provider.arweaveGateways : provider.webviewGateways,
    desktopGateway: arweave ? provider.arweaveGateway : provider.gateway,
    mobileGateway: arweave ? provider.arweaveWebviewGateway : provider.webviewGateway,
  };
}

export function createGatewayController(provider: VerumConnectProvider): GatewayController {
  const listeners = new Set<(s: GatewayState) => void>();
  const emit = () => {
    const state = read(provider);
    listeners.forEach((l) => l(state));
  };

  // Emitted for every change that travels in the pairing link, which is exactly what
  // changes these.
  const off = provider.on('session_changed', emit);

  const arweave = () => provider.network === 'arweave';

  return {
    getState: () => read(provider),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setNetwork(network) {
      provider.setNetwork(network);
      emit();
    },
    setDesktopGateway(template) {
      if (arweave()) provider.setArweaveGateway(template);
      else provider.setGateway(template);
      emit();
    },
    setMobileGateway(template) {
      if (arweave()) provider.setArweaveWebviewGateway(template);
      else provider.setWebviewGateway(template);
      emit();
    },
    customHint: () =>
      arweave() ? 'https://{sandbox}.arweave.net/{tx}/' : 'https://my-gateway.example/ipfs/{cid}/',
    destroy() {
      off();
      listeners.clear();
    },
  };
}

/** Host only, for a picker: the templates carry {cid}, {tx} or {sandbox}, which
 *  is noise beside a hostname. */
export function gatewayHost(template: string): string {
  try {
    return new URL(
      template.replace('{cid}', 'cid').replace('{tx}', 'tx').replace('{sandbox}', 'sb'),
    ).host;
  } catch {
    return template;
  }
}
