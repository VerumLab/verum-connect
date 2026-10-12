/**
 * Vanilla DOM renderings of the dapp-side pieces. Default styles are injected once
 * at low specificity, so a dapp's own stylesheet overrides them; every element
 * carries a class (see the list at the bottom).
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';
import { createRelayController, type RelayController, type RelayState } from './controller.js';
import { mountRelayList } from './relay-list.js';
import { mountGatewayPicker } from './gateway-picker.js';
import { injectStyles } from './styles.js';

export interface Mounted {
  el: HTMLElement;
  destroy(): void;
}

export interface RelaySettingsHandle extends Mounted {
  /** True while a pairing code is on screen. */
  setLocked(locked: boolean): void;
  controller: RelayController;
}

export interface RelaySettingsOptions {
  /**
   * How a relay url is asked for: a prompt() by default, since selector modals trap
   * focus and an inline field cannot be typed into there, while a browser dialog
   * still works.
   */
  promptForUrl?: () => string | null;
  title?: string;
}

export function mountRelaySettings(
  provider: VerumConnectProvider,
  { title = 'Verum Connect relays', promptForUrl }: RelaySettingsOptions = {},
): RelaySettingsHandle {
  injectStyles();
  const controller = createRelayController(provider);

  const el = document.createElement('div');
  el.className = 'verum-relays';
  // The gear too: a button behind the modal cannot be pressed.
  el.style.zIndex = '2147483646';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'verum-relays-toggle';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7L5.4 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  const panel = document.createElement('div');
  panel.className = 'verum-relays-panel';
  // Above a wallet selector's modal: reading relay state must not mean closing it,
  // which would end the pairing and grey every dot.
  panel.style.zIndex = '2147483647';
  panel.hidden = true;

  let open = false;
  // Built once and reused: it keeps which refusals are expanded, and this panel
  // repaints on every poll.
  const rows = mountRelayList(provider, { controller, adder: false });
  const gateways = mountGatewayPicker(provider);

  function draw(state: RelayState): void {
    if (!open) return;
    panel.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'verum-relays-title';
    heading.textContent = title;
    panel.append(heading);

    gateways.setLocked(state.locked);
    panel.append(gateways.el);

    if (state.locked) {
      const note = document.createElement('p');
      note.className = 'verum-relays-note';
      note.textContent = 'Close the pairing code first. It cannot be reissued.';
      panel.append(note);
    }

    // The list itself is mountRelayList; this panel is the chrome around it.
    panel.append(rows.el);

    if (state.error) {
      const err = document.createElement('p');
      err.className = 'verum-relays-error';
      err.textContent = state.error;
      panel.append(err);
    }

    const actions = document.createElement('div');
    actions.className = 'verum-relays-actions';

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add';
    add.disabled = state.locked || !state.idle;
    add.onclick = () => {
      const entered = promptForUrl ? promptForUrl() : prompt('Relay websocket URL:', 'wss://');
      if (entered?.trim()) controller.add(entered);
    };

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.disabled = state.locked || !state.idle;
    reset.onclick = () => controller.reset();

    actions.append(add, reset);
    panel.append(actions);
  }

  const unsubscribe = controller.subscribe(draw);

  const toggle = (next: boolean) => {
    open = next;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) draw(controller.getState());
  };

  button.onclick = () => toggle(!open);

  const onDocDown = (e: MouseEvent) => {
    if (open && !el.contains(e.target as Node)) toggle(false);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open && toggle(false);
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);

  el.append(button, panel);

  return {
    el,
    controller,
    setLocked: (locked) => controller.setLocked(locked),
    destroy() {
      unsubscribe();
      controller.destroy();
      gateways.destroy();
      rows.destroy();
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}

/** The session code, kept in step with the channel; hidden until a channel exists. */
export function mountSessionCode(
  provider: VerumConnectProvider,
  { label = 'Session' }: { label?: string } = {},
): Mounted {
  injectStyles();
  const el = document.createElement('div');
  el.className = 'verum-session-code';

  const labelEl = document.createElement('span');
  labelEl.className = 'verum-session-code-label';
  labelEl.textContent = label;

  const value = document.createElement('span');
  value.className = 'verum-session-code-value';

  el.append(labelEl, value);

  const sync = () => {
    const code = provider.sessionCode;
    el.hidden = !code;
    value.textContent = code ? code.join(' · ') : '';
  };
  sync();

  const off = provider.on('session_changed', sync);

  return {
    el,
    destroy() {
      off();
      el.remove();
    },
  };
}

/*
 * Classes to style: .verum-relays (wrapper), -toggle (gear), -panel (dropdown,
 * [hidden] when closed), -title, -note (while locked), -error, -actions;
 * .verum-session-code (+ -label, -value; [hidden] until a channel exists);
 * .verum-gateways, .verum-gateway (+ -label), .verum-network (.is-on). The relay
 * list styles itself.
 */
