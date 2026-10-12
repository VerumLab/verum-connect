# @verumlab/connect-ui

Framework-free widgets for Verum Connect: the pairing overlay (QR, link and connect code), the connect-code picker, and relay, gateway and session-code displays. Styled from CSS values, so they follow the page or wallet selector they sit in.

```bash
npm install @verumlab/connect-ui
```

```ts
import { mountPairing } from '@verumlab/connect-ui';

const uri = await provider.pair();
const pairing = await mountPairing(provider, uri);
try {
  await Promise.race([provider.waitForSession(), pairing.dismissed]);
} finally {
  pairing.destroy();
}
```

More: [repository](https://github.com/VerumLab/verum-connect) · [protocol](https://github.com/VerumLab/verum-connect/blob/master/PROTOCOL.md)

MIT © 2026 Verum LLC
