/** Default styles for the class-only widgets (settings panel, gateway picker,
 *  session code).
 *
 *  Injected once by the mounts. Every rule sits in :where(), so any stylesheet a
 *  dapp writes overrides it without a specificity fight. Colours come from
 *  `--verum-*` variables, with light and dark defaults following the system. */

const STYLE_ID = 'verum-connect-ui-styles';

const WIDGETS = ':where(.verum-relays, .verum-session-code)';

const CSS = `
${WIDGETS} {
  --_surface: var(--verum-surface, #ffffff);
  --_panel: var(--verum-panel, var(--_surface));
  --_fg: var(--verum-fg, #1a1a1a);
  --_panel-fg: var(--verum-panel-fg, var(--_fg));
  --_border: var(--verum-border, rgba(0, 0, 0, 0.12));
  --_shadow: var(--verum-shadow, 0 8px 32px rgba(0, 0, 0, 0.18));
  --_accent: var(--verum-accent, #3b82f6);
  --_accent-fg: var(--verum-accent-fg, #ffffff);
  --_radius: var(--verum-radius, 12px);
  --_panel-radius: var(--verum-panel-radius, 14px);
  --_font: var(--verum-font, inherit);
}
@media (prefers-color-scheme: dark) {
  ${WIDGETS} {
    --_surface: var(--verum-surface, #1c1c1e);
    --_fg: var(--verum-fg, #f2f2f7);
    --_border: var(--verum-border, rgba(255, 255, 255, 0.16));
    --_shadow: var(--verum-shadow, 0 8px 32px rgba(0, 0, 0, 0.5));
  }
}

:where(.verum-relays) { position: relative; }
:where(.verum-relays-toggle) {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0; cursor: pointer; border: 0;
  border-radius: var(--_radius); box-shadow: var(--_shadow);
  background: var(--_surface); color: var(--_fg);
}
:where(.verum-relays-panel) {
  position: absolute; top: calc(100% + 8px); right: 0; width: 300px; padding: 14px;
  border-radius: var(--_panel-radius); box-shadow: var(--_shadow);
  background: var(--_panel); color: var(--_panel-fg);
  font: 13px/1.4 var(--_font); text-align: left;
}
:where(.verum-relays-panel[hidden]) { display: none; }
:where(.verum-relays-title) { font-weight: 700; margin-bottom: 10px; }
:where(.verum-relays-note) { margin: -4px 0 10px; font-size: 12px; opacity: 0.65; line-height: 1.45; }
:where(.verum-relays-error) { margin: 8px 0 0; font-size: 12px; color: #c1443c; }
:where(.verum-relays-actions) { display: flex; gap: 8px; margin-top: 12px; }
:where(.verum-relays-actions button) {
  flex: 1; font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 10px;
  border-radius: 9px; border: 1px solid var(--_border); background: transparent;
  color: inherit; cursor: pointer;
}
:where(.verum-relays-actions button:disabled) { opacity: 0.45; cursor: not-allowed; }

:where(.verum-gateways) { display: flex; gap: 8px; margin-bottom: 10px; }
:where(.verum-gateway) { flex: 1; min-width: 0; }
:where(.verum-gateway-label) { font-size: 11px; opacity: 0.6; margin-bottom: 4px; }
:where(.verum-gateway select) {
  width: 100%; font: inherit; font-size: 12px; padding: 6px 4px; border-radius: 8px;
  border: 1px solid var(--_border); background: transparent; color: inherit;
}
:where(.verum-network) { display: inline-flex; margin-bottom: 12px; }
:where(.verum-network button) {
  margin: 0; padding: 5px 0; min-width: 84px; min-height: 0; text-align: center;
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; position: relative;
  border: 1px solid var(--_border); background: transparent; color: inherit;
}
:where(.verum-network button:first-child) { border-radius: 8px 0 0 8px; }
:where(.verum-network button:last-child) { border-radius: 0 8px 8px 0; margin-left: -1px; }
:where(.verum-network button.is-on) {
  z-index: 1; border-color: var(--_accent); background: var(--_accent); color: var(--_accent-fg);
}
:where(.verum-network button:disabled) { opacity: 0.5; cursor: not-allowed; }

:where(.verum-session-code) {
  display: flex; align-items: center; gap: 6px; padding: 8px 10px;
  border-radius: var(--_radius); box-shadow: var(--_shadow);
  background: var(--_surface); color: var(--_fg); font: 700 14px/1 var(--_font);
}
:where(.verum-session-code[hidden]) { display: none; }
:where(.verum-session-code-label) { opacity: 0.6; font-weight: 500; }
`;

export function injectStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
