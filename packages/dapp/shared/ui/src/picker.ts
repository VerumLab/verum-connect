/**
 * The typed-code decision as an overlay that opens itself when a wallet answers the
 * code: the user is then looking at their phone, so there is no dismiss-by-backdrop
 * (a wallet would be left waiting). Styled inline because it is mounted by an
 * integration a dapp never touches; colours come from CSS variables so it follows
 * the selector it sits over.
 */

import type { CodeController, CodeState } from './code.js';
import type { Mounted } from './mount.js';

/**
 * CSS values for the overlay; variables with fallbacks make it follow a selector's
 * theme.
 */
export interface PickerTheme {
  backdrop: string;
  background: string;
  text: string;
  textSecondary: string;
  border: string;
  accent: string;
  danger: string;
  radius: string;
  font: string;
}

const DEFAULT_THEME: PickerTheme = {
  backdrop: 'rgba(0,0,0,0.45)',
  background: '#fff',
  text: '#1a1b1f',
  textSecondary: 'rgba(60,66,66,0.6)',
  border: 'rgba(0,0,0,0.08)',
  accent: '#0e76fd',
  danger: '#d93025',
  radius: '24px',
  font: 'system-ui, sans-serif',
};

export interface ConnectPickerOptions {
  theme?: Partial<PickerTheme>;
  /**
   * Attributes on the overlay's root: a selector that scopes its theme variables to an
   * attribute is matched by carrying the same one.
   */
  attributes?: Record<string, string>;
}

export function mountConnectPicker(
  controller: CodeController,
  { theme: overrides, attributes = {} }: ConnectPickerOptions = {},
): Mounted {
  const theme = { ...DEFAULT_THEME, ...overrides };

  const el = document.createElement('div');
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  el.hidden = true;
  el.style.cssText =
    // One above the selector's modal, which takes the value below the maximum.
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    `justify-content:center;padding:16px;background:${theme.backdrop};font-family:${theme.font}`;
  document.body.append(el);

  let busy = false;
  let wasOpen = false;

  function draw(state: CodeState): void {
    const open = state.pending.length > 0 || state.failure !== null;
    // To the front on opening. At the same z-index the later element wins, and
    // the pairing overlay this answers is usually added after the picker was.
    if (open && !wasOpen) document.body.append(el);
    wasOpen = open;
    el.hidden = !open;
    // `hidden` alone loses to the inline display:flex above.
    el.style.display = open ? 'flex' : 'none';
    if (!open) {
      el.replaceChildren();
      return;
    }

    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Confirm the connecting wallet');
    sheet.style.cssText =
      `background:${theme.background};color:${theme.text};border-radius:${theme.radius};` +
      `border:1px solid ${theme.border};box-shadow:0 8px 32px rgba(0,0,0,0.24);` +
      'padding:24px;width:100%;max-width:360px;box-sizing:border-box;' +
      'display:flex;flex-direction:column;gap:12px';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0;font-size:18px;font-weight:700';
    title.textContent =
      state.pending.length > 1
        ? `${state.pending.length} wallets are asking to connect`
        : 'A wallet is asking to connect';
    sheet.append(title);

    const note = document.createElement('p');
    note.style.cssText = `margin:0;font-size:14px;line-height:1.4;color:${
      state.failure ? theme.danger : theme.textSecondary
    }`;

    if (state.failure) {
      note.textContent = `${state.failure} Get a new code and try again.`;
      sheet.append(note, dismiss('Get a new code'));
      el.replaceChildren(sheet);
      return;
    }

    note.textContent = busy
      ? 'Connecting…'
      : state.pending.length > 1
        ? 'Someone else may be trying to reach your session. Pick the one matching the code in your wallet — if none match, do not continue.'
        : 'Check this matches the session code in your wallet before continuing.';
    sheet.append(note);

    for (const entry of state.pending) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.textContent = entry.codeString;
      choice.disabled = busy;
      choice.style.cssText =
        `font:inherit;font-size:16px;font-weight:600;padding:12px 16px;cursor:pointer;` +
        `border-radius:12px;border:1px solid ${theme.border};background:transparent;` +
        `color:${theme.text};text-align:center`;
      choice.onmouseenter = () => (choice.style.borderColor = theme.accent);
      choice.onmouseleave = () => (choice.style.borderColor = theme.border);
      choice.onclick = async () => {
        // The selection is the commit point: an attacker's connect arrives before
        // the user has finished typing, so no timer can stand in for this.
        busy = true;
        draw(controller.getState());
        try {
          await controller.select(entry.codeString);
        } finally {
          busy = false;
          draw(controller.getState());
        }
      };
      sheet.append(choice);
    }

    sheet.append(dismiss('None of these match'));
    el.replaceChildren(sheet);
  }

  function dismiss(label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = busy;
    button.style.cssText =
      `font:inherit;font-size:14px;font-weight:600;padding:8px;margin-top:4px;cursor:pointer;` +
      `border:none;background:transparent;color:${theme.accent}`;
    button.onclick = () => controller.withdraw();
    return button;
  }

  const off = controller.subscribe(draw);

  return {
    el,
    destroy() {
      off();
      el.remove();
    },
  };
}
