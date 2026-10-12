/**
 * Verum Connect as a RainbowKit wallet: the whole integration. RainbowKit renders the
 * QR in its own connect modal from the `qrCode` handler, so there is no UI of ours;
 * the connector emits `display_uri` and RainbowKit draws it. Declared structurally, so
 * nothing here imports RainbowKit's types.
 */

import { VERUM_ICON, resolveHub, resolveWebviewHub, type VerumConnectProvider } from '@verumlab/connect-dapp';
import type { ConnectPickerOptions } from '@verumlab/connect-ui';
import { verumConnect, type VerumWagmiOptions } from '@verumlab/connect-wagmi';

/** The shape RainbowKit expects of a wallet. */
export interface VerumWalletDefinition {
  id: string;
  name: string;
  iconBackground: string;
  iconUrl: () => Promise<string>;
  downloadUrls: { qrCode: string };
  mobile: { getUri: (uri: string) => string };
  qrCode: {
    getUri: (uri: string) => string;
    instructions: {
      learnMoreUrl: string;
      steps: {
        description: string;
        step: 'install' | 'scan' | 'create' | 'refresh' | 'connect';
        title: string;
      }[];
    };
  };
  createConnector: (walletDetails: Record<string, unknown>) => unknown;
}

/**
 * Wallet definition for the selector's `connectorsForWallets`, with its QR modal
 * driven by our `display_uri`. The selector owns its modal and a custom wallet
 * cannot add interactive controls, so gateway and relay settings cannot live there,
 * and the pairing link exists only as pixels in its QR. So ship a generous relay
 * list (four independent relays make a bad default survivable) and expect the
 * gateway to matter more here.
 *
 * A dapp that wants to hand users the controls renders its own settings outside the
 * selector and reaches the provider via `connector.getProvider()` (cast to
 * VerumConnectProvider), calling `setRelays` while disconnected: mid-session it
 * strands the connection.
 */
export function verumWallet(options: VerumWagmiOptions): VerumWalletDefinition {
  // Populated when the connector first builds its provider, after this definition is
  // returned.
  let live: VerumConnectProvider | null = null;

  // Read when the definition is built, before any provider exists, hence the
  // standalone helpers; they read the same storage, so a chosen gateway is honoured.
  // Two destinations: a phone camera opens a real browser (the verifying gateway), a
  // WebView runs no service worker (bytes directly). Resolved on read, since the
  // definition is built at config time, long before the user picks, and a captured
  // value would be the default forever.

  return {
    id: 'verum',
    name: 'Verum Connect',
    iconBackground: 'transparent',
    iconUrl: async () => VERUM_ICON,
    // The selector puts a GET button on every wallet with a QR screen, so the only
    // choice is where it lands: the hub itself, since a first-time user is missing a
    // page, not an app. The verifying gateway and no pairing: a phone camera opens a
    // real browser, so the CID can be checked; the downgrade happens only when the hub
    // hands off into a WebView.
    get downloadUrls() {
      return { qrCode: resolveHub(options) };
    },
    // On a phone the selector resolves this and opens it: the same fragment on a
    // gateway a WebView can load.
    mobile: { getUri: (uri: string) => resolveWebviewHub(options) + fragmentOf(uri) },
    // The presence of this key is what makes the selector render the QR screen.
    qrCode: {
      getUri: (uri: string) => uri,
      instructions: {
        // The one slot that holds a full string: steps render as plain text in a narrow
        // column where a long CID runs off, but an href fits and a long-press copies it.
        // The verifying gateway, matching the QR, opening in a real browser. The live
        // pairing when there is one, so the hub pairs on arrival; the bare hub before one
        // exists.
        get learnMoreUrl() {
          return live?.uri ?? resolveHub(options);
        },
        // Shown on the "Get started" screen, the one place a custom wallet can put text,
        // so the connect code lives here. A getter, read each time it renders: the
        // selector does not redraw it when the code changes, so the code controller keeps
        // the code young.
        get steps() {
          return [
            {
              description:
                'Scan the QR code or click "Learn More" to open the hub. The hub needs to be open in your browser wallet.',
              step: 'install' as const,
              title: 'Visit the hub',
            },
            {
              // The code as the whole description, so it sits on its own line: this text renders
              // without line breaks.
              description: codeLine(live),
              step: 'connect' as const,
              title: 'Type the connect code',
            },
            {
              description:
                'Verify that the session code shown by the hub matched the session code shown by the dapp.',
              step: 'refresh' as const,
              title: 'Check the session code',
            },
          ];
        },
      },
    },
    createConnector: (walletDetails: Record<string, unknown>) => {
      const base = verumConnect({ codeConnect: true, picker: rainbowKitPicker(), ...options }, (p) => {
        live = p;
      });
      return (config: Parameters<ReturnType<typeof verumConnect>>[0]) => ({
        ...base(config),
        ...walletDetails,
      });
    },
  };
}

/** The connect code step's text, for whatever state the code is in. */
function codeLine(provider: VerumConnectProvider | null): string {
  switch (provider?.pairingCodeStatus) {
    case 'ready':
      return provider.pairingCode ?? 'Preparing a code…';
    case 'failed':
      return 'No code available right now — scan the QR code instead.';
    case 'flooded':
      return 'Too many attempts on this code — scan the QR code instead.';
    default:
      return 'Preparing a code… go back and open this screen again in a moment.';
  }
}

/**
 * The picker dressed as part of the selector's modal: it scopes theme variables to
 * `data-rk` elements, so the overlay carries the attribute and follows whatever
 * theme the dapp configured. Read at mount, as the provider element may use an id.
 */
function rainbowKitPicker(): ConnectPickerOptions {
  return {
    theme: {
      backdrop: 'var(--rk-colors-modalBackdrop, rgba(0,0,0,0.3))',
      background: 'var(--rk-colors-modalBackground, #fff)',
      text: 'var(--rk-colors-modalText, #1a1b1f)',
      textSecondary: 'var(--rk-colors-modalTextSecondary, rgba(60,66,66,0.6))',
      border: 'var(--rk-colors-generalBorder, rgba(0,0,0,0.06))',
      accent: 'var(--rk-colors-accentColor, #0e76fd)',
      danger: 'var(--rk-colors-error, #ff494a)',
      radius: 'var(--rk-radii-modal, 24px)',
      font: 'var(--rk-fonts-body, system-ui, sans-serif)',
    },
    get attributes() {
      const root = typeof document !== 'undefined' ? document.querySelector('[data-rk]') : null;
      return { 'data-rk': root?.getAttribute('data-rk') ?? '' };
    },
  };
}

/**
 * A pairing link is its fragment; the host is only transport, so the same fragment
 * can move to a gateway that suits the device.
 */
function fragmentOf(uri: string): string {
  const hash = uri.indexOf('#');
  return hash === -1 ? '' : uri.slice(hash);
}
