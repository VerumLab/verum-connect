import { useState } from 'react';
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage } from 'wagmi';
import { VerumRelaySettings, VerumSessionCode } from '@verumlab/connect-react';

export function App() {
  const { isConnected } = useAccount();
  // Whether a pairing code is on screen: the one fact the components cannot work
  // out, worded differently by every kit.
  const { connectModalOpen } = useConnectModal();

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          padding: '14px 24px',
          borderBottom: '1px solid var(--page-border)',
        }}
      >
        <strong style={{ fontSize: 15 }}>Verum Connect</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <VerumSessionCode />
          <VerumRelaySettings locked={connectModalOpen} hidden={isConnected} />
          <ConnectButton />
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 18, marginBottom: 4 }}>RainbowKit example</h1>
        <p style={{ color: 'var(--page-muted)', fontSize: 14, margin: 0 }}>
          Rainbowkit with Verum Connect included.
        </p>
        <SignMessage />
      </main>
    </div>
  );
}

/**
 * Example signing using verum-connect
 */
function SignMessage() {
  const { isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [result, setResult] = useState<string | null>(null);

  if (!isConnected) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <button
        type="button"
        onClick={async () => {
          setResult('Waiting for the wallet…');
          try {
            setResult(await signMessageAsync({ message: 'Hello from RainbowKit' }));
          } catch (err) {
            setResult(`Rejected or failed: ${(err as Error).message}`);
          }
        }}
        style={{
          font: 'inherit',
          fontWeight: 600,
          fontSize: 14,
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid var(--page-border)',
          background: 'var(--page-panel, transparent)',
          color: 'var(--page-fg)',
          cursor: 'pointer',
        }}
      >
        Sign a message
      </button>
      {result && (
        <p
          style={{
            marginTop: 12,
            fontSize: 13,
            color: 'var(--page-muted)',
            wordBreak: 'break-all',
          }}
        >
          {result}
        </p>
      )}
    </div>
  );
}
