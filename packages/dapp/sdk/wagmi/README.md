# @verumlab/connect-wagmi

A wagmi connector for Verum Connect. It announces the pairing link as `display_uri`, so a wallet selector that draws a QR for a scan-this wallet shows it.

```bash
npm install @verumlab/connect-wagmi
```

```ts
import { createConfig, http } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { verumConnect } from '@verumlab/connect-wagmi';

export const config = createConfig({
  chains: [mainnet],
  connectors: [verumConnect({ hubCid, metadata: { name: 'My Dapp', origin: location.origin } })],
  transports: { [mainnet.id]: http() },
});
```

More: [repository](https://github.com/VerumLab/verum-connect) · [protocol](https://github.com/VerumLab/verum-connect/blob/master/PROTOCOL.md)

MIT © 2026 Verum LLC
