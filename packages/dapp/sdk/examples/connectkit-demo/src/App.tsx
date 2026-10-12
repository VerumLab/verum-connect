import { useEffect, useRef, useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useConnectors, useSignMessage } from 'wagmi';
import type { VerumConnectProvider } from '@verumlab/connect-wagmi';
import { VerumRelaySettings, VerumSessionCode } from '@verumlab/connect-react';
import { mountPairing } from '@verumlab/connect-ui';

/** The pairing overlay, dressed from the kit's variables; page variables are fallbacks. */
const PAIRING_THEME = {
  background: 'var(--ck-body-background, var(--page-bg))',
  panel: 'var(--ck-body-background-secondary, var(--page-panel))',
  text: 'var(--ck-body-color, var(--page-fg))',
  textSecondary: 'var(--ck-body-color-muted, var(--page-muted))',
  border: 'var(--ck-body-divider, var(--page-border))',
  accent: 'var(--ck-accent-color, #1a88f8)',
  radius: 'var(--ck-border-radius, 1rem)',
  font: 'var(--ck-font-family, sans-serif)',
};

export function App() {
  const { isConnected } = useAccount();
  // Use own paring overlay (outside of connectkit modal)
  const [pairingOpen, setPairingOpen] = useState(false);

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
          {/*Session code used to identify the active verum connect session*/}
          <VerumSessionCode />
          <VerumRelaySettings locked={pairingOpen} hidden={isConnected} />
          <ConnectKitButton />
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 18, marginBottom: 4 }}>ConnectKit example</h1>
        <p style={{ color: 'var(--page-muted)', fontSize: 14, margin: 0 }}>
          Connectkit with Verum Connect included.
        </p>
        <SignMessage />
      </main>

      <PairingOverlay onOpenChange={setPairingOpen} />
    </div>
  );
}

/**
 * Puts the pairing code over the kit's connecting screen: its own QR screen cannot
 * show a custom wallet's code, so the overlay listens for `display_uri` and appears
 * in front of whatever it is showing.
 */
function PairingOverlay({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const connectors = useConnectors();
  const { isConnected } = useAccount();
  const verum = connectors.find((c) => c.id === 'verumConnect');
  const open = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    if (!verum) return;

    const onMessage = (message: { type: string; data?: unknown }) => {
      if (message.type !== 'display_uri') return;
      // A re-emitted code (a resumed pairing, a transport setting) replaces the one on
      // screen.
      open.current?.destroy();
      open.current = null;
      onOpenChange(false);

      void verum.getProvider().then(async (candidate) => {
        const provider = candidate as VerumConnectProvider;
        const overlay = await mountPairing(provider, message.data as string, { theme: PAIRING_THEME });
        open.current = overlay;
        onOpenChange(true);
        // Dismissal abandons the attempt: disconnect() rejects the pending waitForSession
        // with 4001, so the kit shows "request cancelled" instead of spinning for five
        // minutes.
        overlay.dismissed.catch(() => {
          void provider.disconnect().catch(() => {});
          overlay.destroy();
          open.current = null;
          onOpenChange(false);
        });
      });
    };

    verum.emitter.on('message', onMessage);
    return () => verum.emitter.off('message', onMessage);
  }, [verum, onOpenChange]);

  useEffect(() => {
    if (!isConnected) return;
    open.current?.destroy();
    open.current = null;
    onOpenChange(false);
  }, [isConnected, onOpenChange]);

  return null;
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
            setResult(await signMessageAsync({ message: 'Hello from ConnectKit' }));
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
          background: 'var(--page-panel)',
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
