/**
 * A connect code as read-only boxes, three to a row with a dot between them, so each
 * part can be compared with the box the wallet asks for. The dots are left out of a
 * selection, so a copied code pastes clean.
 */

import { h } from './dom.js';

export interface CodeDisplayTheme {
  border: string;
  background: string;
  text: string;
  textSecondary: string;
}

/** `code` is grouped with dashes, as the provider formats it. */
export function renderCodeBoxes(code: string, theme: CodeDisplayTheme): HTMLElement {
  const groups = code.split('-').filter(Boolean);
  const wrap = h('div', 'display:flex;flex-direction:column;gap:8px;user-select:all');
  for (let at = 0; at < groups.length; at += 3) {
    const row = h('div', 'display:flex;align-items:center;gap:6px');
    groups.slice(at, at + 3).forEach((group, i) => {
      if (i > 0) {
        row.append(
          h('span', `color:${theme.textSecondary};user-select:none`, {
            'aria-hidden': 'true',
            textContent: '\u00b7',
          }),
        );
      }
      row.append(
        h(
          'span',
          'flex:1 1 0;min-width:0;padding:12px 0;text-align:center;border-radius:8px;' +
            `border:1px solid ${theme.border};background:${theme.background};color:${theme.text};` +
            'font:600 16px ui-monospace,monospace;letter-spacing:0.5px',
          { textContent: group },
        ),
      );
    });
    wrap.append(row);
  }
  return wrap;
}
