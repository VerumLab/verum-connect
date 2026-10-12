import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets';
import type { Wallet } from '@rainbow-me/rainbowkit';
import { verumWallet } from './verumWallet.js';

/** The IPFS published hub build*/
const HUB_CID = 'bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq';
/** The Arweave published hub build*/
const HUB_TX = 'I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE';

/**
 * The wallet selector calls each entry as (params) => Wallet and hands it a
 * projectId we never asked for. A thin adapter ignores the params, supplies our
 * options and casts where the types diverge (verumWallet's own type is
 * structurally compatible, so it need not import the kit).
 */
function verumRainbowWallet(): Wallet {
  return verumWallet({
    hubCid: HUB_CID,
    hubTx: HUB_TX,
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
    // {sandbox} is the per-transaction subdomain the gateway would redirect to;
    // addressing it directly keeps the pairing fragment out of a 302.
    arweaveGateways: [
      'https://{sandbox}.ar.io/{tx}/',
      'https://{sandbox}.arweave.net/{tx}/',
    ],
    metadata: {
      name: 'RainbowKit demo',
      origin: location.origin,
      description: 'verum-connect inside a RainbowKit wallet selector',
    },
    rpcUrls: {
      '0x1': 'https://ethereum-rpc.publicnode.com',
      '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
    },
  }) as unknown as Wallet;
}

/** projectId dummy */
const connectors = connectorsForWallets(
  [
    {
      groupName: 'Wallets',
      wallets: [injectedWallet, verumRainbowWallet],
    },
  ],
  { appName: 'Verum Connect — RainbowKit demo', projectId: 'n/a' },
);

export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: false,
});
