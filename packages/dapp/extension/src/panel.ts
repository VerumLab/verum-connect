/**
 * The panel of one dapp tab: the bookmarklet's, reached through the background instead
 * of a window. Its page is the tab, its origin the one the browser gave the tab's port.
 */

import type { PanelTransport } from '../../bookmarklet/src/popup.js';
import { OVERRIDE_KEY, PANEL_PORT, overriddenSites } from './channel.js';

const tab = Number(new URLSearchParams(location.search).get('tab'));
const listeners: ((data: unknown, origin: string, from: unknown) => void)[] = [];
const outbox: object[] = [];
let port: chrome.runtime.Port | null = null;

// The background sleeps when idle and drops its ports; this reconnects at once.
function connect(): void {
  const next = chrome.runtime.connect({ name: `${PANEL_PORT}:${tab}` });
  next.onMessage.addListener(({ data, origin }: { data: unknown; origin: string }) =>
    listeners.forEach((listener) => listener(data, origin, tab)),
  );
  next.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 100);
  });
  port = next;
  for (const message of outbox.splice(0)) next.postMessage({ message });
}
if (tab) connect();

const transport: PanelTransport = {
  host: tab,
  name: 'Extension',
  send: (_to, message) => {
    if (port) port.postMessage({ message });
    else outbox.push(message);
  },
  listen: (listener) => listeners.push(listener),
};
(globalThis as { verumPanelTransport?: PanelTransport }).verumPanelTransport = transport;

// No tab in the address: the tab was loaded before the extension, and has no content
// script to reach.
if (tab) await import('../../bookmarklet/src/popup.js');
else document.body.textContent = 'Reload the dapp’s tab, then open Verum Connect again.';

/**
 * The site's override, once the page has said who it is: with it on, the dapp lists
 * the hub's Aztec wallet and not this browser's own.
 */
let site = '';
listeners.push((_data, origin) => {
  if (site || !origin) return;
  site = origin;
  void mountOverride(origin);
});

async function mountOverride(origin: string): Promise<void> {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:16px;font-size:13px;line-height:1.4';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = (await overriddenSites())[origin] === true;
  box.onchange = async () => {
    const sites = await overriddenSites();
    if (box.checked) sites[origin] = true;
    else delete sites[origin];
    await chrome.storage.local.set({ [OVERRIDE_KEY]: sites });
  };
  const text = document.createElement('span');
  text.textContent = `Use the hub’s Aztec wallet on ${new URL(origin).host}, even when this browser has one of its own. Reload the dapp after changing this.`;
  row.append(box, text);
  document.body.append(row);
}
