/** The hub's user agreement. Built into the page, so it cannot change after publication. */

// @ts-expect-error - plain JS, shared with the bookmarklet's build script
import { TERMS_LINES } from '../../../shared/terms.mjs';

export { TERMS_LINES };

/** What the footer says without being opened: the operative half, linking to the rest. */
const SUMMARY_BEFORE = 'Provided as is, without warranty. Using this page means accepting the ';
const SUMMARY_AFTER = '.';
const LINK_LABEL = 'user agreement';

export function termsFooter(): HTMLElement {
  const foot = document.createElement('footer');
  foot.className = 'page-foot';

  const line = document.createElement('p');
  line.append(document.createTextNode(SUMMARY_BEFORE), termsLink(), document.createTextNode(SUMMARY_AFTER));
  foot.append(line);

  return foot;
}

export function termsLink(label = LINK_LABEL): HTMLButtonElement {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'terms-link';
  link.textContent = label;
  link.onclick = openTerms;
  return link;
}

let openSheet: HTMLElement | null = null;

/** Appended to the body so it survives re-renders. */
export function openTerms(): void {
  if (openSheet) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeTerms();
  };

  const sheet = document.createElement('div');
  sheet.className = 'sheet sheet-scroll';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'User agreement');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const title = document.createElement('h3');
  title.textContent = 'User agreement';
  const close = document.createElement('button');
  close.className = 'sheet-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.onclick = closeTerms;
  head.append(title, close);
  sheet.append(head);

  for (const paragraph of TERMS_LINES as string[]) {
    const p = document.createElement('p');
    p.className = 'terms-body';
    p.textContent = paragraph;
    sheet.append(p);
  }

  backdrop.append(sheet);
  document.body.append(backdrop);
  openSheet = backdrop;
  window.addEventListener('keydown', onKey);
}

export function closeTerms(): void {
  openSheet?.remove();
  openSheet = null;
  window.removeEventListener('keydown', onKey);
}

/** True while the agreement is open, so Escape closes it first. */
export function termsOpen(): boolean {
  return openSheet !== null;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeTerms();
}
