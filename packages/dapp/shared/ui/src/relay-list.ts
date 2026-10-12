/**
 * The relay list, drawn: a component, not state, because separate renderings
 * drifted. `describeRelay` gives the same decisions with no DOM for a
 * dapp that wants its own look. Colours come from custom properties with
 * fallbacks, so it suits any page or selector modal.
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';
import {
  createRelayController,
  describeRelay,
  type RelayController,
  type RelayTone,
} from './controller.js';

export interface RelayListOptions {
  /**
   * An existing controller to read; otherwise one is created and destroyed with the
   * list.
   */
  controller?: RelayController;
  /** Show the remove buttons. */
  editable?: boolean;
  /**
   * Render the inline "add a relay" field. Off inside a selector's settings panel:
   * those modals trap focus, so the panel uses a prompt() instead.
   */
  adder?: boolean;
}

export interface MountedRelayList {
  el: HTMLElement;
  destroy(): void;
}

const TONE: Record<RelayTone, string> = {
  ok: 'var(--verum-ok, var(--ok, #1a9e6c))',
  warn: 'var(--verum-warn, var(--warn, #c98a00))',
  danger: 'var(--verum-danger, var(--danger, #c1443c))',
  muted: 'var(--verum-muted, var(--muted, #8a857c))',
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function mountRelayList(
  provider: VerumConnectProvider,
  { controller, editable = true, adder = true }: RelayListOptions = {},
): MountedRelayList {
  const relays = controller ?? createRelayController(provider);
  const owned = controller === undefined;

  const el = document.createElement('div');
  el.className = 'verum-relay-list';
  el.style.width = '100%';

  /**
   * Relays whose refusal is expanded, kept across redraws (this repaints on every
   * poll).
   */
  const open = new Set<string>();

  const field = document.createElement('input');
  field.placeholder = 'wss://relay.example';
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Add a relay');
  field.style.cssText =
    `flex:1;min-width:0;padding:7px;border-radius:8px;font:12px ${MONO};` +
    'border:1px solid var(--verum-border, var(--border, #8883));background:transparent;color:inherit';

  function draw(): void {
    const state = relays.getState();
    el.replaceChildren();

    for (const url of state.relays) {
      const said = describeRelay(state, url);

      const row = document.createElement('div');
      row.style.cssText =
        'display:grid;grid-template-columns:7px minmax(0,1fr) auto 24px;align-items:center;' +
        'column-gap:8px;padding:0;width:100%;min-width:0';

      const dot = document.createElement('span');
      dot.setAttribute('aria-hidden', 'true');
      dot.title = said.status;
      dot.style.cssText =
        `grid-column:1;width:7px;height:7px;border-radius:50%;background:${TONE[said.tone]}`;

      const name = document.createElement('span');
      name.textContent = url.replace(/^wss?:\/\//, '');
      // Let the host truncate before the badge and remove button: min-width zero is
      // essential in narrow cards.
      name.style.cssText =
        `grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ${MONO}`;

      // Click, not hover: a tooltip never arrives on a touch screen, and this explains a
      // failed pairing.
      if (said.refused) {
        name.title = 'What this relay said';
        name.style.color = TONE.danger;
        name.style.cursor = 'pointer';
        name.style.textDecoration = 'underline dotted';
        name.onclick = () => {
          if (open.has(url)) open.delete(url);
          else open.add(url);
          draw();
        };
      } else {
        name.title = `${url} — ${said.status}`;
      }

      row.append(dot, name);

      if (said.code) {
        const code = document.createElement('span');
        code.textContent = said.code.text;
        code.title = said.code.title;
        code.style.cssText =
          `grid-column:3;font-size:10px;cursor:help;color:${TONE[said.code.tone]}`;
        row.append(code);
      }

      if (editable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '✕';
        remove.title = `Remove ${url}`;
        remove.setAttribute('aria-label', remove.title);
        // One has to remain: with no relays there is no transport at all.
        remove.disabled = state.locked || !state.idle || state.relays.length <= 1;
        remove.style.cssText =
          'grid-column:4;display:flex;align-items:center;justify-content:center;width:24px;height:18px;' +
          'min-height:0;margin:0 0 0 0;padding:0;border:none;background:none;' +
          'font:inherit;font-size:13px;line-height:1;' +
          `color:${TONE.muted};` +
          (remove.disabled ? 'opacity:0.3;cursor:default' : 'cursor:pointer');
        remove.onclick = () => relays.remove(url);
        row.append(remove);
      }

      el.append(row);

      if (said.refused && open.has(url)) {
        const why = document.createElement('p');
        why.textContent = `${said.refused} — refuses QR, URL and code connect.`;
        why.style.cssText =
          `margin:0 0 6px 15px;font-size:11px;line-height:1.45;color:${TONE.danger};` +
          'overflow-wrap:anywhere';
        el.append(why);
      }
    }

    if (state.error) {
      const problem = document.createElement('p');
      problem.textContent = state.error;
      problem.style.cssText = `margin:6px 0 0;font-size:11.5px;color:${TONE.danger}`;
      el.append(problem);
    }

    if (!editable || !adder) return;

    const add = document.createElement('div');
    add.style.cssText = 'display:flex;gap:6px;margin-top:8px';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = 'Add';
    plus.disabled = state.locked || !state.idle;
    plus.style.cssText =
      'flex:none;font:inherit;font-size:12px;padding:7px 10px;border-radius:8px;' +
      'border:1px solid var(--verum-border, var(--border, #8883));background:transparent;' +
      'color:inherit;cursor:pointer';

    const submit = (): void => {
      const raw = field.value.trim();
      if (!raw) return;
      // A bare host is what people type; the provider adds the scheme.
      relays.add(raw);
      field.value = '';
    };
    plus.onclick = submit;
    field.onkeydown = (event) => {
      if (event.key === 'Enter') submit();
    };

    add.append(field, plus);
    el.append(add);
  }

  const unsubscribe = relays.subscribe(draw);
  draw();

  return {
    el,
    destroy() {
      unsubscribe();
      if (owned) relays.destroy();
    },
  };
}
