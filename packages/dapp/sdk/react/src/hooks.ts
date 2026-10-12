/**
 * React bindings for what a wallet selector cannot show: the session code and the
 * relay set belong to the dapp, so they are packaged here instead of reimplemented
 * per integration. Free of any selector dependency: the one selector-specific fact
 * needed (whether a pairing code is on screen) is passed in, since only the
 * selector knows it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConfig } from 'wagmi';
import {
  createGatewayController,
  createRelayController,
  type GatewayState,
  type RelayState,
} from '@verumlab/connect-ui';
import type { VerumConnectProvider } from '@verumlab/connect-wagmi';

/**
 * The provider behind whichever connector is ours, found by probing its own shape,
 * not its id: selectors rewrite ids when they wrap a connector, so matching one
 * breaks silently.
 */
export function useVerumProvider(): VerumConnectProvider | null {
  const config = useConfig();
  const [provider, setProvider] = useState<VerumConnectProvider | null>(null);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      for (const connector of config.connectors) {
        try {
          const candidate = (await connector.getProvider()) as VerumConnectProvider;
          if (typeof candidate?.setRelays === 'function') {
            if (!dropped) setProvider(candidate);
            return;
          }
        } catch {
          // A connector that cannot produce a provider is simply not ours.
        }
      }
    })();
    return () => {
      dropped = true;
    };
  }, [config]);

  return provider;
}

/**
 * The session code, or null when there is no channel. A wallet's approval sheet
 * shows the hub's origin, never the dapp's, so the code is what establishes that
 * the hub answering is the one in front of the user; it only means something when
 * compared with the hub's screen, so it must be visible.
 */
export function useVerumSessionCode(): string[] | null {
  const provider = useVerumProvider();
  const { isConnected } = useAccount();
  const [code, setCode] = useState<string[] | null>(null);

  useEffect(() => {
    if (!provider) return;
    // Driven by the provider's own events, with wagmi's flag only as a backstop: the
    // code appears when the channel opens, not always before wagmi reports the account;
    // a restored session opens one without session_changed; and a connection must never
    // be on screen without its code.
    const sync = () => setCode(provider.sessionCode);
    sync();
    const offs = [
      provider.on('session_changed', sync),
      provider.on('connect', sync),
      provider.on('disconnect', sync),
    ];
    return () => offs.forEach((off) => off());
  }, [provider, isConnected]);

  return code;
}

export interface VerumRelays extends RelayState {
  /** False until the provider has been found. */
  ready: boolean;
  add(url: string): void;
  remove(url: string): void;
  /** Restores the dapp's defaults, keeping anything added by hand. */
  reset(): void;
}

/**
 * Relay set and the actions that change it safely: a thin binding over
 * createRelayController, where the re-pairing, last-relay and locking rules live.
 * `locked` should be true whenever a pairing code is on screen; only the selector
 * knows that, so it is passed in.
 */
export function useVerumRelays({ locked = false }: { locked?: boolean } = {}): VerumRelays {
  const provider = useVerumProvider();
  const controller = useMemo(() => (provider ? createRelayController(provider) : null), [provider]);
  const [state, setState] = useState<RelayState>(() => ({
    relays: [],
    statuses: {},
    notices: {},
    codeParked: false,
    codeKept: [],
    codeDropped: [],
    error: null,
    locked,
    idle: true,
    stale: false,
  }));

  useEffect(() => {
    if (!controller) return;
    setState(controller.getState());
    const off = controller.subscribe(setState);
    return () => {
      off();
      controller.destroy();
    };
  }, [controller]);

  useEffect(() => controller?.setLocked(locked), [controller, locked]);

  return {
    ...state,
    locked,
    ready: controller !== null,
    add: (url) => controller?.add(url),
    remove: (url) => controller?.remove(url),
    reset: () => controller?.reset(),
  };
}

export interface VerumNetwork extends GatewayState {
  ready: boolean;
  setNetwork(network: 'arweave' | 'ipfs'): void;
  setDesktopGateway(template: string): void;
  setMobileGateway(template: string): void;
  /** Placeholder for a custom-gateway prompt, matching the active network. */
  customHint(): string;
}

/**
 * Network and gateway choice, a binding over createGatewayController so which list
 * belongs to which role is decided there. Unlike relays these need no re-pair: they
 * only change the link's base URL and `w=`, which the provider rebuilds in place.
 */
export function useVerumNetwork(): VerumNetwork {
  const provider = useVerumProvider();
  const controller = useMemo(
    () => (provider ? createGatewayController(provider) : null),
    [provider],
  );
  const [state, setState] = useState<GatewayState>(() => ({
    network: 'ipfs',
    canSwitch: false,
    desktopGateways: [],
    mobileGateways: [],
    desktopGateway: null,
    mobileGateway: null,
  }));

  useEffect(() => {
    if (!controller) return;
    setState(controller.getState());
    const off = controller.subscribe(setState);
    return () => {
      off();
      controller.destroy();
    };
  }, [controller]);

  return {
    ...state,
    ready: controller !== null,
    setNetwork: (n) => controller?.setNetwork(n),
    setDesktopGateway: (t) => controller?.setDesktopGateway(t),
    setMobileGateway: (t) => controller?.setMobileGateway(t),
    customHint: () => controller?.customHint() ?? '',
  };
}
