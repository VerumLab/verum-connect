/**
 * Verum Connect as a wallet module: the whole integration. The kit asks a wallet
 * for a label, an icon and a function returning an EIP-1193 provider;
 * `VerumConnectProvider` already is one, so the module is mostly the pairing UI,
 * which it owns.
 */

import { VERUM_ICON, VerumConnectProvider, type VerumConnectOptions } from '@verumlab/connect-dapp';
import { createCodeController, mountConnectPicker, mountPairing } from '@verumlab/connect-ui';
import type { EIP1193Provider } from '@web3-onboard/common';

/** The pairing overlay and the code picker, dressed from the kit's variables. */
const THEME = {
  background: 'var(--onboard-modal-background, var(--w3o-background-color, var(--page-bg)))',
  panel: 'var(--w3o-foreground-color, var(--page-panel))',
  text: 'var(--onboard-modal-color, var(--w3o-text-color, var(--page-fg)))',
  textSecondary: 'var(--onboard-gray-300, var(--page-muted))',
  border: 'var(--w3o-border-color, var(--onboard-gray-200, var(--page-border)))',
  accent: 'var(--w3o-action-color, var(--onboard-primary-500, #6370e5))',
  radius: 'var(--onboard-modal-border-radius, var(--w3o-border-radius, 1rem))',
  font: 'var(--w3o-font-family, var(--onboard-font-family-normal, sans-serif))',
};

/**
 * Kept so the page can read the session code after connecting: the kit hands back
 * only the provider.
 */
export let activeProvider: VerumConnectProvider | null = null;

export interface VerumModuleOptions extends VerumConnectOptions {
  /**
   * Called as the pairing overlay opens and closes, so the dapp can refuse relay
   * edits behind a code it cannot reissue.
   */
  onPairingOpen?: (open: boolean) => void;
}

export function verumWallet({ onPairingOpen, ...options }: VerumModuleOptions) {
  // Constructed at page load; pairing still happens lazily.
  const provider = new VerumConnectProvider(options);
  activeProvider = provider;

  return () => ({
    label: 'Verum Connect',
    getIcon: async () => VERUM_ICON,
    getInterface: async () => {

      // A stored session skips the code entirely, exactly as it does elsewhere.
      if (!(await provider.restore())) {
        const uri = (await provider.resumePairing()) ?? (await provider.pair());
        // Code connect beside the QR: parked, kept fresh, and a picker that opens when a
        // wallet answers.
        const codes = createCodeController(provider);
        const picker = mountConnectPicker(codes, { theme: THEME });
        void codes.offer();
        const pairing = await mountPairing(provider, uri, { theme: THEME });
        onPairingOpen?.(true);
        try {
          // Whichever happens first: without the dismissal arm, closing the overlay would
          // leave this awaiting a session for five minutes.
          await Promise.race([provider.waitForSession(), pairing.dismissed]);
        } catch (err) {
          // Abandoning means abandoning: drop the relay connections and the stored pending
          // pairing, so the next attempt mints a fresh code.
          await provider.disconnect().catch(() => {});
          throw err;
        } finally {
          pairing.destroy();
          picker.destroy();
          codes.destroy();
          onPairingOpen?.(false);
        }
      }

      // The kit drives everything through the provider. The cast is a type mismatch, not
      // behaviour: `on` returns an unsubscribe in ours and we emit no "message" event;
      // both are harmless at runtime.
      return { provider: provider as unknown as EIP1193Provider };
    },
  });
}
