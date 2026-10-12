/**
 * web3-onboard with Verum Connect as a wallet module: no wagmi, no framework, no
 * project id or API key. The whole Verum side is verumModule.ts.
 */

import Onboard from '@web3-onboard/core';
import injectedModule from '@web3-onboard/injected-wallets';
import { mountRelaySettings, mountSessionCode } from '@verumlab/connect-ui';
import { VERUM_ICON } from '@verumlab/connect-dapp';
import { verumWallet, activeProvider } from './verumModule.js';

/** The IPFS published hub build*/
const HUB_CID = 'bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq';
/** The Arweave published hub build*/
const HUB_TX = 'I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE';

const onboard = Onboard({
  wallets: [
    injectedModule(),
    verumWallet({
      hubCid: HUB_CID,
      hubTx: HUB_TX,
      // Edits are refused while the code is up; see @verumlab/connect-ui.
      onPairingOpen: (open) => relays?.setLocked(open),
      // Gateways travel in the pairing link, so the hub uses exactly these.
      relays: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://offchain.pub',
      ],
      // Path gateways only: a WebView has no service worker.
      webviewGateways: [
        'https://gateway.pinit.io/ipfs/{cid}/',
        'https://ipfs.orbitor.dev/ipfs/{cid}/',
      ],
      // The trailing slash matters: most gateways answer 301 without it.
      arweaveGateways: [
        'https://{sandbox}.ar.io/{tx}/',
        'https://{sandbox}.arweave.net/{tx}/',
      ],
      metadata: {
        name: 'web3-onboard demo',
        origin: location.origin,
        description: 'verum-connect as a web3-onboard wallet module',
      },
      // Chain reads are answered here, never over the relay.
      rpcUrls: {
        '0x1': 'https://ethereum-rpc.publicnode.com',
        '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
      },
    }),
  ],
  chains: [
    {
      id: '0x1',
      token: 'ETH',
      label: 'Ethereum',
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
    },
    {
      id: '0xaa36a7',
      token: 'ETH',
      label: 'Sepolia',
      rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    },
  ],
  appMetadata: {
    name: 'Verum Connect — web3-onboard demo',
    icon: VERUM_ICON,
    description: 'verum-connect as a web3-onboard wallet module',
  },
  // The kit's modal defaults to white and does not follow the OS unless told; our
  // overlay reads the page theme, so set it to match.
  theme: 'system',
  connect: {
    // Both answer "you have no wallet extension", which does not apply to a wallet
    // reached by scanning.
    removeWhereIsMyWalletWarning: true,
    removeIDontHaveAWalletInfoLink: true,
  },
  // Its own floating account widget is off: this page has a header for that state.
  accountCenter: {
    desktop: { enabled: false },
    mobile: { enabled: false },
  },
});

const cluster = document.getElementById('cluster')!;
const body = document.getElementById('body')!;

/**
 * Mounted once and reparented on each render: the panel holds state a rebuild
 * would drop.
 */
const sessionCode = activeProvider ? mountSessionCode(activeProvider) : null;
const relays = activeProvider ? mountRelaySettings(activeProvider) : null;

onboard.state.select('wallets').subscribe(render);
render(onboard.state.get().wallets);

function render(wallets: ReturnType<typeof onboard.state.get>['wallets']): void {
  cluster.replaceChildren();
  body.replaceChildren();

  const wallet = wallets[0];
  const account = wallet?.accounts[0];

  // Only Verum has a session code; the element hides itself when there is none.
  if (sessionCode) cluster.append(sessionCode.el);
  if (relays) {
    // The set cannot change on a live session without stranding it; the recovery is to
    // disconnect and pair again.
    relays.el.hidden = Boolean(account);
    cluster.append(relays.el);
  }

  if (account) {
    const address = document.createElement('div');
    address.className = 'chip';
    address.textContent = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
    cluster.append(address);

    const disconnect = document.createElement('button');
    disconnect.textContent = 'Disconnect';
    disconnect.onclick = () => void onboard.disconnectWallet({ label: wallet.label });
    cluster.append(disconnect);

    const sign = document.createElement('button');
    sign.textContent = 'Sign a message';
    sign.onclick = async () => {
      const result = document.createElement('p');
      result.style.cssText = 'font-size:13px;color:var(--page-muted);word-break:break-all';
      try {
        const signature = await wallet.provider.request({
          method: 'personal_sign',
          params: ['Hello from web3-onboard', account.address],
        });
        result.textContent = `Signature: ${signature}`;
      } catch (err) {
        result.textContent = `Rejected or failed: ${(err as Error).message}`;
      }
      body.append(result);
    };
    body.append(sign);
    return;
  }

  const connect = document.createElement('button');
  connect.textContent = 'Connect a wallet';
  connect.onclick = () => void onboard.connectWallet();
  cluster.append(connect);
}
