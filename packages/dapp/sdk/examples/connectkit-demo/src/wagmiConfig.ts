import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { VERUM_ICON, verumConnect } from '@verumlab/connect-wagmi';

/** The IPFS published hub build*/
const HUB_CID = 'bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq';
/** The Arweave published hub build*/
const HUB_TX = 'I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE';

/**
 * Declared as an injected connector, which is what makes the kit's modal row call
 * connect(): it decides a wallet is present from the connector type alone. 
 */
const verumConnectAsInjected = (options: Parameters<typeof verumConnect>[0]) => {
  const base = verumConnect(options);
  return (config: Parameters<ReturnType<typeof verumConnect>>[0]) => ({
    ...base(config),
    type: 'injected' as const,
    // The kit renders `connector.icon` for any wallet outside its registry, so set
    // one.
    icon: VERUM_ICON,
  });
};

export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    verumConnectAsInjected({
      hubCid: HUB_CID,
      hubTx: HUB_TX,
      // Parks a connect code with every pairing, keeps it fresh, and opens the overlay
      // asking which wallet answered; the code itself is shown by mountPairing in App.tsx.
      codeConnect: true,
      picker: {
        theme: {
          background: 'var(--ck-body-background, var(--page-bg))',
          text: 'var(--ck-body-color, var(--page-fg))',
          textSecondary: 'var(--ck-body-color-muted, var(--page-muted))',
          border: 'var(--ck-body-divider, var(--page-border))',
          accent: 'var(--ck-accent-color, #1a88f8)',
          radius: 'var(--ck-border-radius, 1rem)',
          font: 'var(--ck-font-family, sans-serif)',
        },
      },
      // Gateways travel in the pairing link, so the hub uses exactly these.
      relays: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://offchain.pub',
      ],
      // Path gateways only: a WebView has no service worker. The first is used.
      webviewGateways: [
        'https://gateway.pinit.io/ipfs/{cid}/',
        'https://ipfs.orbitor.dev/ipfs/{cid}/',
      ],
      // The trailing slash matters: most gateways answer 301 without it, and `{sandbox}`
      // exists to avoid a redirect.
      arweaveGateways: [
        'https://{sandbox}.ar.io/{tx}/',
        'https://{sandbox}.arweave.net/{tx}/',
      ],
      metadata: {
        name: 'ConnectKit demo',
        origin: location.origin,
        description: 'verum-connect inside a ConnectKit wallet selector',
      },
      rpcUrls: {
        '0x1': 'https://ethereum-rpc.publicnode.com',
        '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
      },
    }),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: false,
});
