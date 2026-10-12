# @verumlab/connect-react

React components and hooks for Verum Connect.

```bash
npm install @verumlab/connect-react
```

```tsx
import { VerumRelaySettings, VerumSessionCode } from '@verumlab/connect-react';

export function Header() {
  return (
    <>
      <VerumSessionCode />
      <VerumRelaySettings />
    </>
  );
}
```

Hooks: `useVerumProvider`, `useVerumSessionCode`, `useVerumRelays`, `useVerumNetwork`.

More: [repository](https://github.com/VerumLab/verum-connect) · [protocol](https://github.com/VerumLab/verum-connect/blob/master/PROTOCOL.md)

MIT © 2026 Verum LLC
