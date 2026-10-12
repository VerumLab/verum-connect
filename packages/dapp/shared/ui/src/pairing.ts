/**
 * The pairing screen as an overlay: the QR, the same link as text, the connect code
 * and the session code. For a dapp whose selector has no place to draw them. Styled
 * inline from a theme of CSS values, so variables with fallbacks make it follow the
 * selector it sits over.
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';
import { renderCodeBoxes } from './code-display.js';
import { h } from './dom.js';
import type { Mounted } from './mount.js';
import type { PickerTheme } from './picker.js';

export interface PairingTheme extends PickerTheme {
  /** Behind the link and the connect code. */
  panel: string;
}

const DEFAULT_THEME: PairingTheme = {
  backdrop: 'rgba(0,0,0,0.45)',
  background: '#fff',
  panel: '#f5f5f7',
  text: '#1a1b1f',
  textSecondary: 'rgba(60,66,66,0.6)',
  border: 'rgba(0,0,0,0.08)',
  accent: '#0e76fd',
  danger: '#d93025',
  radius: '1rem',
  font: 'system-ui, sans-serif',
};

export interface PairingOptions {
  theme?: Partial<PairingTheme>;
  title?: string;
}

export interface MountedPairing extends Mounted {
  /**
   * Rejects when the user closes the overlay (button, backdrop or Escape): a modal
   * whose only exit is success is a trap. The message is written for the person who
   * clicked away, since a selector shows it as is.
   */
  dismissed: Promise<never>;
}

/** Loaded only when a QR is drawn, so a dapp that never pairs here never ships it. */
async function qrImage(uri: string): Promise<string | null> {
  try {
    const loaded = await import('qrcode');
    const QRCode = loaded.default ?? loaded;
    return await QRCode.toDataURL(uri, { width: 560, margin: 1 });
  } catch {
    // The link and the code still work.
    return null;
  }
}

export async function mountPairing(
  provider: VerumConnectProvider,
  uri: string,
  { theme: overrides, title = 'Scan with your phone' }: PairingOptions = {},
): Promise<MountedPairing> {
  const theme = { ...DEFAULT_THEME, ...overrides };
  const png = await qrImage(uri);

  let reject!: (reason: Error) => void;
  const dismissed = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  // Handled here so an overlay nobody races stays quiet; callers still see it.
  dismissed.catch(() => {});
  const dismiss = (): void => reject(new Error('Pairing cancelled'));

  const outline = `1px solid ${theme.border}`;
  const mono = 'ui-monospace,monospace';

  const backdrop = h(
    'div',
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      `justify-content:center;padding:24px;background:${theme.backdrop};font-family:${theme.font}`,
    {
      // Only the backdrop itself, so a click inside the card does not close it.
      onclick: (event: Event) => {
        if (event.target === backdrop) dismiss();
      },
    },
  );
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss();
  };
  window.addEventListener('keydown', onKey);

  const field = h(
    'input',
    `flex:1;min-width:0;font-family:${mono};font-size:11.5px;border:0;background:none;` +
      `outline:none;color:${theme.text}`,
    { value: uri, spellcheck: false },
  );

  const flash = (): void => {
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1600);
  };
  // execCommand: the clipboard API needs a secure context, and this is synchronous so
  // it keeps the user gesture.
  const selectAndCopy = (): boolean => {
    field.select();
    field.setSelectionRange(0, field.value.length);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  };
  const copy = h(
    'button',
    'flex:none;font:inherit;font-size:0.75rem;font-weight:600;padding:0.35rem 0.6rem;' +
      `border-radius:${theme.radius};border:${outline};background:transparent;` +
      `color:${theme.accent};cursor:pointer`,
    {
      type: 'button',
      textContent: 'Copy',
      onclick: () => {
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(field.value).then(flash, () => {
            if (selectAndCopy()) flash();
          });
        } else if (selectAndCopy()) flash();
      },
    },
  );

  // One box whose contents change, so the card holds its height.
  const boxed =
    'line-height:23px;padding:15px 8px;border-radius:9px;text-align:center;' +
    `background:${theme.panel};border:${outline};color:${theme.text}`;
  const connectCode = h('div', boxed);
  const paintConnectCode = (): void => {
    const status = provider.pairingCodeStatus;
    const shown = status === 'ready' ? provider.pairingCode : null;

    connectCode.replaceChildren();
    connectCode.style.cssText = boxed;
    if (shown) {
      connectCode.style.cssText = '';
      connectCode.append(
        renderCodeBoxes(shown, {
          border: theme.border,
          background: theme.panel,
          text: theme.text,
          textSecondary: theme.textSecondary,
        }),
      );
      return;
    }

    if (status === 'failed' || status === 'flooded') {
      connectCode.style.fontSize = '13px';
      connectCode.textContent =
        status === 'flooded'
          ? 'Too many attempts on this code — scan the QR instead'
          : 'Code connect not available';
      return;
    }

    // Still being parked: showing a code before a relay holds it invites typing one no
    // wallet can resolve.
    const spinner = h(
      'span',
      'display:inline-block;width:17px;height:17px;vertical-align:-3px;border-radius:50%;' +
        `border:2px solid ${theme.border};border-top-color:${theme.textSecondary}`,
      { role: 'progressbar', 'aria-label': 'Publishing the connect code' },
    );
    // Slowed rather than stopped under reduced motion: a still ring reads as broken.
    const slow = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: slow ? 2400 : 700,
      iterations: Infinity,
    });
    connectCode.append(spinner);
  };
  const offConnectCode = provider.on('code_changed', paintConnectCode);
  paintConnectCode();

  // The session code exists only once a hub has answered, so it appears mid-flow.
  const session = h(
    'div',
    `font-size:0.8125rem;font-weight:600;margin-top:0.75rem;color:${theme.textSecondary}`,
  );
  const paintSession = (): void => {
    const words = provider.sessionCode;
    session.textContent = words ? `Session ${words.join(' · ')}` : '';
  };
  const offSession = provider.on('session_changed', paintSession);
  paintSession();

  const rule = h(
    'div',
    `display:flex;align-items:center;gap:10px;margin:22px 0 16px;font-size:11.5px;color:${theme.textSecondary}`,
    {},
    h('span', `flex:1;height:1px;background:${theme.border}`),
    'or use the connect code',
    h('span', `flex:1;height:1px;background:${theme.border}`),
  );

  const card = h(
    'div',
    `background:${theme.background};color:${theme.text};border-radius:${theme.radius};` +
      'box-shadow:0 4px 16px rgba(0,0,0,0.2);padding:1.5rem;max-width:22rem;width:100%;' +
      'text-align:center',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:1rem',
      {},
      h('strong', 'font-size:1.125rem;font-weight:600', { textContent: title }),
      h(
        'button',
        'font:inherit;font-size:1.25rem;line-height:1;width:1.75rem;height:1.75rem;' +
          'display:flex;align-items:center;justify-content:center;border-radius:50%;' +
          `border:${outline};background:transparent;color:inherit;cursor:pointer`,
        { type: 'button', textContent: '×', 'aria-label': 'Cancel', onclick: dismiss },
      ),
    ),
    // White behind it whatever the theme: an inverted QR is unreliable to scan.
    ...(png
      ? [
          h('img', `width:100%;border-radius:${theme.radius};background:#fff`, {
            src: png,
            alt: 'Verum Connect pairing code',
          }),
        ]
      : []),
    // The same link the QR encodes, for a phone that cannot scan: paste it into a
    // wallet's browser.
    h(
      'div',
      'display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;padding:0.5rem;' +
        `border:${outline};border-radius:${theme.radius};background:${theme.panel}`,
      {},
      field,
      copy,
    ),
    rule,
    connectCode,
    session,
  );

  backdrop.append(card);
  document.body.append(backdrop);

  return {
    el: backdrop,
    dismissed,
    destroy() {
      offSession();
      offConnectCode();
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
    },
  };
}
