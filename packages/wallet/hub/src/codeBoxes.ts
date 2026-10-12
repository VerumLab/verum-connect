/**
 * The connect code as one box per group, in two rows of three with a dot between them,
 * so each part is checked against what the dapp shows as it is typed. A paste of the
 * whole code is spread across them.
 */

import { CODE_GROUP_SIZES, CODE_SYMBOLS, normalizeCode } from '@verumlab/connect-wallet';

export interface CodeBoxesOptions {
  /** What each box holds, kept by the caller so a redraw does not lose it. */
  parts: string[];
  disabled: boolean;
  /** `complete` is true once every symbol is in. */
  onChange(parts: string[], complete: boolean): void;
}

/** Only characters the alphabet has, upper-cased; the rest is dropped as typed. */
function clean(text: string): string {
  return [...text]
    .map((ch) => {
      try {
        return normalizeCode(ch);
      } catch {
        return '';
      }
    })
    .join('');
}

export function codeBoxes({ parts, disabled, onChange }: CodeBoxesOptions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'code-boxes';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Connect code');

  const boxes = CODE_GROUP_SIZES.map((size, i) => {
    const box = document.createElement('input');
    box.className = 'code-box';
    box.value = parts[i] ?? '';
    box.disabled = disabled;
    box.autocapitalize = 'characters';
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.setAttribute('aria-label', `Connect code, part ${i + 1} of ${CODE_GROUP_SIZES.length}`);
    return box;
  });

  /** Fill the boxes from `at` onward, a part at a time; the last box it reached. */
  const spread = (at: number, text: string): number => {
    let i = at;
    let rest = text;
    while (i < boxes.length && rest.length > 0) {
      boxes[i]!.value = rest.slice(0, CODE_GROUP_SIZES[i]!);
      rest = rest.slice(CODE_GROUP_SIZES[i]!);
      i += 1;
    }
    return Math.min(i, boxes.length - 1);
  };

  const changed = (): void => {
    const now = boxes.map((box) => box.value);
    onChange(now, now.join('').length === CODE_SYMBOLS);
  };

  boxes.forEach((box, i) => {
    const size = CODE_GROUP_SIZES[i]!;
    box.oninput = () => {
      const typed = clean(box.value);
      box.value = typed.slice(0, size);
      let focus = i;
      if (typed.length > size) focus = spread(i + 1, typed.slice(size));
      else if (typed.length === size && i < boxes.length - 1) focus = i + 1;
      changed();
      if (focus !== i) {
        boxes[focus]!.focus();
        boxes[focus]!.select();
      }
    };
    box.onpaste = (event) => {
      const text = clean(event.clipboardData?.getData('text') ?? '');
      // A whole code starts at the first box wherever it was pasted; a fragment goes
      // into this one as it would be typed.
      if (text.length <= size) return;
      event.preventDefault();
      const last = spread(0, text.slice(0, CODE_SYMBOLS));
      changed();
      boxes[last]!.focus();
    };
    box.onkeydown = (event) => {
      if (event.key === 'Backspace' && box.value === '' && i > 0) {
        event.preventDefault();
        boxes[i - 1]!.focus();
      }
    };
  });

  // Three to a row: boxes wide enough to read and tap, with the dot saying one code.
  const PER_ROW = 3;
  for (let at = 0; at < boxes.length; at += PER_ROW) {
    const line = document.createElement('div');
    line.className = 'code-boxes-row';
    boxes.slice(at, at + PER_ROW).forEach((box, i) => {
      if (i > 0) {
        const dot = document.createElement('span');
        dot.className = 'code-sep';
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = '\u00b7';
        line.append(dot);
      }
      line.append(box);
    });
    row.append(line);
  }
  return row;
}
