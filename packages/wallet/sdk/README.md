# @verumlab/connect-wallet

Verum Connect for wallets: answers dapps' requests over nostr relays, with your wallet as any EIP-1193 provider (one `request({ method, params })` function).

```bash
npm install @verumlab/connect-wallet
```

```ts
import { Hub, parsePairingUri } from '@verumlab/connect-wallet';

const hub = new Hub();
await hub.restore();                               // resume stored sessions
await hub.attachWallet(wallet, 'My Wallet');       // wallet: { request({ method, params }) }
await hub.pair(parsePairingUri(scannedLink));
hub.subscribe((state) => render(state));
```

More: [repository](https://github.com/VerumLab/verum-connect) · [protocol](https://github.com/VerumLab/verum-connect/blob/master/PROTOCOL.md)

MIT © 2026 Verum LLC
