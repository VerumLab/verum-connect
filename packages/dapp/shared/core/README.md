# @verumlab/connect-dapp

Verum Connect for dapps: an EIP-1193 provider that pairs with a wallet over nostr relays. No account, no project id, no server of ours.

```bash
npm install @verumlab/connect-dapp
```

```ts
import { VerumConnectProvider } from '@verumlab/connect-dapp';

const provider = new VerumConnectProvider({ hubCid, metadata: { name: 'My Dapp', origin: location.origin } });
if (!(await provider.restore())) {
  const uri = await provider.pair();   // show as a QR, or use mountPairing from @verumlab/connect-ui
  await provider.waitForSession();
}
await provider.request({ method: 'personal_sign', params: [message, account] });
```

More: [repository](https://github.com/VerumLab/verum-connect) · [protocol](https://github.com/VerumLab/verum-connect/blob/master/PROTOCOL.md)

MIT © 2026 Verum LLC
