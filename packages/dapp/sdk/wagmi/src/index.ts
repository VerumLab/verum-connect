/**
 * wagmi connector. It emits `display_uri` with the pairing link, so a selector that
 * already renders a QR for a scan-this wallet draws it; one that does not can listen
 * for the event and draw its own (`mountPairing` in `@verumlab/connect-ui`).
 */

import { createConnector } from '@wagmi/core';
import {
  VERUM_ICON,
  VerumConnectProvider,
  type VerumConnectOptions,
} from '@verumlab/connect-dapp';
import { RpcError, ERROR_CODES } from '@verumlab/connect-protocol';
import {
  createCodeController,
  mountConnectPicker,
  type CodeController,
  type ConnectPickerOptions,
} from '@verumlab/connect-ui';

export interface VerumWagmiOptions extends VerumConnectOptions {
  /** Reconnect a stored session on page load without showing the QR again. */
  shimDisconnect?: boolean;
  /**
   * Offer a typed connect code beside the QR and open the overlay for picking the
   * wallet that answered it. Off by default: the connector itself has nowhere to show
   * the code, so turn it on where the selector or the dapp does.
   */
  codeConnect?: boolean;
  /** Theme and attributes for that overlay. */
  picker?: ConnectPickerOptions;
}

verumConnect.type = 'verumConnect' as const;

export function verumConnect(
  options: VerumWagmiOptions,
  /**
   * Called once, when the provider is first built; the wallet definition uses it to
   * reach the live pairing for links it can only describe statically.
   */
  onProvider?: (provider: VerumConnectProvider) => void,
) {
  let provider: VerumConnectProvider | undefined;

  type ConnectResult = { accounts: readonly `0x${string}`[]; chainId: number };
  /**
   * The connect in progress, so a second one joins it instead of re-pairing: a
   * selector calls connect() again on a reopened modal or double click, and
   * re-pairing would mint a new QR and withdraw a code half typed.
   */
  let attempt: { result: Promise<ConnectResult>; codes: CodeController | null } | null = null;

  return createConnector<VerumConnectProvider>((config) => {
    // A closure, not `this.getProvider()`: wagmi types that through a generic that
    // erases the provider type.
    const ensureProvider = (): VerumConnectProvider => {
      if (!provider) {
        provider = new VerumConnectProvider(options);
        onProvider?.(provider);

        provider.on('accountsChanged', (accounts: string[]) => {
          if (accounts.length === 0) config.emitter.emit('disconnect');
          else config.emitter.emit('change', { accounts: accounts as readonly `0x${string}`[] });
        });

        provider.on('chainChanged', (chainId: string) => {
          config.emitter.emit('change', { chainId: Number.parseInt(chainId, 16) });
        });

        provider.on('disconnect', () => {
          config.emitter.emit('disconnect');
        });

        // A session can arrive after connect() gave up: a resumed pairing settles whenever
        // the hub gets to it. Without this the provider is connected and wagmi still
        // believes it is not.
        provider.on('connect', () => {
          config.emitter.emit('connect', {
            accounts: provider!.currentAccounts as readonly `0x${string}`[],
            chainId: Number.parseInt(provider!.currentChainId, 16),
          });
        });
      }
      return provider;
    };

    return {
    id: 'verumConnect',
    name: 'Verum Connect',
    type: verumConnect.type,

    async setup() {
      // Nothing to do until connect(): the session key is minted per pairing.
    },

    async getProvider() {
      return ensureProvider();
    },

    async connect({ chainId, isReconnecting } = {}): Promise<any> {
      const p = ensureProvider();

      // On a reload, restore rather than re-pair; failing that, a fresh QR unless only a
      // silent reconnect was wanted.
      if (isReconnecting || options.shimDisconnect) {
        if (await p.restore()) {
          return {
            accounts: p.currentAccounts as readonly `0x${string}`[],
            chainId: Number.parseInt(p.currentChainId, 16),
          };
        }
        if (isReconnecting) {
          throw new RpcError(ERROR_CODES.disconnected, 'verum: no session to restore');
        }
      }

      if (attempt) {
        const joined = attempt;
        // The one moment a selector is about to show the code again, so replace one with
        // little time left.
        void joined.codes?.refreshIfStale();
        // After a tick: the selector subscribes to display_uri only after awaiting
        // getProvider().
        setTimeout(() => p.reannounceUri(), 0);
        return joined.result;
      }

      // The selector listens for this and renders the QR itself.
      const off = p.on('display_uri', (uri: string) => {
        config.emitter.emit('message', { type: 'display_uri', data: uri });
      });

      const codes = options.codeConnect ? createCodeController(p) : null;
      const picker =
        codes && typeof document !== 'undefined' ? mountConnectPicker(codes, options.picker) : null;

      const result = (async (): Promise<ConnectResult> => {
        // A pairing minted before the tab was discarded (ordinary on the mobile handoff):
        // resume it, since pairing over it would strand whoever holds the old key.
        const resumed = await p.resumePairing();
        if (!resumed) await p.pair();
        // Once the relay pool exists, which the code is parked on. Not awaited: the QR is
        // already usable.
        void codes?.offer();
        const session = await p.waitForSession();

        if (chainId && Number.parseInt(session.chainId, 16) !== chainId) {
          try {
            await switchToChain(chainId);
          } catch {
            // The wallet refused or does not know the chain; the session still works on its
            // own.
          }
        }

        return {
          accounts: p.currentAccounts as readonly `0x${string}`[],
          chainId: Number.parseInt(p.currentChainId, 16),
        };
      })();

      attempt = { result, codes };
      try {
        return await result;
      } finally {
        attempt = null;
        off();
        codes?.destroy();
        picker?.destroy();
      }
    },

    async disconnect() {
      // The provider is kept, not replaced: its disconnect resets it, and a dapp's UI
      // holds the instance (session code included); replacing it left the UI watching a
      // dead provider.
      await provider?.disconnect();
    },

    async getAccounts() {
      return ensureProvider().currentAccounts as readonly `0x${string}`[];
    },

    async getChainId() {
      return Number.parseInt(ensureProvider().currentChainId, 16);
    },

    async isAuthorized() {
      const p = ensureProvider();
      if (p.isConnected) return true;
      return p.restore();
    },

    async switchChain({ chainId }) {
      return switchToChain(chainId);
    },

    onAccountsChanged(accounts) {
      if (accounts.length === 0) config.emitter.emit('disconnect');
      else config.emitter.emit('change', { accounts: accounts as readonly `0x${string}`[] });
    },

    onChainChanged(chainId) {
      config.emitter.emit('change', { chainId: Number(chainId) });
    },

    onDisconnect() {
      config.emitter.emit('disconnect');
    },
    };

    async function switchToChain(chainId: number) {
      const p = ensureProvider();
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain) throw new RpcError(ERROR_CODES.invalidParams, 'verum: unknown chain');

      const hexId = `0x${chainId.toString(16)}`;
      try {
        await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
      } catch (err) {
        // 4902: the wallet has never heard of this chain, so offer to add it.
        if ((err as { code?: number }).code === 4902) {
          await p.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: hexId,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls.default.http,
                blockExplorerUrls: chain.blockExplorers?.default
                  ? [chain.blockExplorers.default.url]
                  : undefined,
              },
            ],
          });
        } else {
          throw err;
        }
      }

      config.emitter.emit('change', { chainId });
      return chain;
    }
  });
}

export { VERUM_ICON };

export { VerumConnectProvider, type VerumConnectOptions } from '@verumlab/connect-dapp';
