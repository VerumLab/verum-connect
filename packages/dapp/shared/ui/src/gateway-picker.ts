/**
 * Where the hub link points: the two gateway pickers and the network toggle,
 * shared by every renderer. Empty until the dapp has published a hub.
 */

import type { VerumConnectProvider } from '@verumlab/connect-dapp';
import { createGatewayController, gatewayHost, type GatewayController } from './gateway.js';

export interface GatewayPickerOptions {
  /** An existing controller to read; one is created, and destroyed with the
   *  picker, when omitted. */
  controller?: GatewayController;
}

export interface MountedGatewayPicker {
  el: HTMLElement;
  /** Disables every control, for as long as a change would strand something on
   *  screen. */
  setLocked(locked: boolean): void;
  destroy(): void;
}

export function mountGatewayPicker(
  provider: VerumConnectProvider,
  { controller }: GatewayPickerOptions = {},
): MountedGatewayPicker {
  const gateways = controller ?? createGatewayController(provider);
  const el = document.createElement('div');
  el.className = 'verum-gateway-settings';
  let locked = false;

  // Rebuilt whole: switching network replaces both lists and both selections.
  const draw = (): void => el.replaceChildren(...rows(gateways, locked, draw));
  const unsubscribe = gateways.subscribe(draw);
  draw();

  return {
    el,
    setLocked(next) {
      locked = next;
      draw();
    },
    destroy() {
      unsubscribe();
      if (!controller) gateways.destroy();
      el.remove();
    },
  };
}

function rows(gateways: GatewayController, locked: boolean, redraw: () => void): HTMLElement[] {
  const { network, canSwitch, desktopGateways, mobileGateways, desktopGateway, mobileGateway } =
    gateways.getState();
  if (desktopGateways.length === 0) return [];

  const row = document.createElement('div');
  row.className = 'verum-gateways';

  const pick = (
    caption: string,
    options: string[],
    active: string | null,
    apply: (template: string) => void,
  ): HTMLElement => {
    const cell = document.createElement('div');
    cell.className = 'verum-gateway';

    const label = document.createElement('div');
    label.className = 'verum-gateway-label';
    label.textContent = caption;

    const select = document.createElement('select');
    select.setAttribute('aria-label', `${caption} gateway`);
    select.disabled = locked;
    for (const template of options) {
      const option = document.createElement('option');
      option.value = template;
      option.textContent = gatewayHost(template);
      option.selected = template === active;
      select.append(option);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = 'Your own gateway…';
    select.append(custom);

    select.onchange = () => {
      let choice = select.value;
      if (choice === '__custom__') {
        // The placeholder is the substitution the template needs, which is what
        // a URL copied from a gateway's own docs will be missing.
        const entered = prompt(`Gateway URL for ${caption.toLowerCase()}:`, gateways.customHint());
        if (!entered?.trim()) {
          redraw();
          return;
        }
        choice = entered.trim();
      }
      apply(choice);
      redraw();
    };

    cell.append(label, select);
    return cell;
  };

  row.append(
    pick('Desktop', desktopGateways, desktopGateway, (t) => gateways.setDesktopGateway(t)),
    pick('Mobile', mobileGateways, mobileGateway, (t) => gateways.setMobileGateway(t)),
  );

  const out: HTMLElement[] = [row];

  if (canSwitch) {
    const toggle = document.createElement('div');
    toggle.className = 'verum-network';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Hub network');
    for (const [value, label] of [
      ['arweave', 'Arweave'],
      ['ipfs', 'IPFS'],
    ] as const) {
      const on = network === value;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = on ? 'is-on' : '';
      button.setAttribute('aria-pressed', String(on));
      button.disabled = locked;
      button.onclick = () => {
        if (on) return;
        gateways.setNetwork(value);
        redraw();
      };
      toggle.append(button);
    }
    out.push(toggle);
  }

  return out;
}
