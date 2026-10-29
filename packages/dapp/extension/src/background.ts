/**
 * Routes each dapp tab to its panel: the side panel where the browser has one, an
 * extension window where it does not. A tab's messages carry the origin the browser
 * gave its port, never one the page stated.
 */

import { PROTOCOL } from '../../bookmarklet/src/messages.js';
import { PAGE_PORT, PANEL_PORT } from './channel.js';

interface Tab {
  page: chrome.runtime.Port | null;
  panel: chrome.runtime.Port | null;
  origin: string;
  /** What the page sent before its panel was there. */
  waiting: unknown[];
  /** The panel's own window, where there is no side panel. */
  window?: number;
}

const tabs = new Map<number, Tab>();
const tab = (id: number): Tab => {
  let found = tabs.get(id);
  if (!found) tabs.set(id, (found = { page: null, panel: null, origin: '', waiting: [] }));
  return found;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PAGE_PORT) return attachPage(port);
  if (port.name.startsWith(`${PANEL_PORT}:`)) return attachPanel(port, Number(port.name.slice(PANEL_PORT.length + 1)));
});

function attachPage(port: chrome.runtime.Port): void {
  const id = port.sender?.tab?.id;
  const origin = port.sender?.origin ?? (port.sender?.url ? new URL(port.sender.url).origin : '');
  if (id === undefined || !origin) return port.disconnect();
  const entry = tab(id);
  entry.page = port;
  entry.origin = origin;
  // The toolbar opens the side panel at this tab's own address, so the panel knows its tab.
  void chrome.sidePanel?.setOptions({ tabId: id, path: `panel.html?tab=${id}`, enabled: true }).catch(() => {});
  port.onMessage.addListener((message: { type?: string }) => {
    if (message.type === 'open') return void open(id);
    if (entry.panel) entry.panel.postMessage({ data: message, origin: entry.origin });
    else entry.waiting.push(message);
  });
  port.onDisconnect.addListener(() => {
    if (entry.page === port) entry.page = null;
  });
  // A panel in its own window is not beside the dapp: the page shows the session code.
  if (!chrome.sidePanel) port.postMessage({ showCode: true });
  // A page reloaded under a panel still carrying its session: let it introduce itself.
  if (entry.panel) port.postMessage({ v: PROTOCOL, type: 'ready' });
}

function attachPanel(port: chrome.runtime.Port, id: number): void {
  const entry = tab(id);
  entry.panel = port;
  port.onMessage.addListener(({ message }: { message: unknown }) => entry.page?.postMessage(message));
  // A panel closed ends its session; the page hears it as a wallet's disconnect.
  port.onDisconnect.addListener(() => {
    if (entry.panel !== port) return;
    entry.panel = null;
    entry.page?.postMessage({ v: PROTOCOL, type: 'event', event: 'disconnect', data: null });
  });
  for (const message of entry.waiting.splice(0)) port.postMessage({ data: message, origin: entry.origin });
}

/** Shows the tab's panel, or a page reloaded under one gets its ready again. */
async function open(id: number): Promise<void> {
  const entry = tab(id);
  if (entry.panel) {
    entry.page?.postMessage({ v: PROTOCOL, type: 'ready' });
    if (entry.window !== undefined) void chrome.windows.update(entry.window, { focused: true });
    else void chrome.sidePanel?.open({ tabId: id }).catch(() => {});
    return;
  }
  const path = `panel.html?tab=${id}`;
  if (chrome.sidePanel) {
    await chrome.sidePanel.setOptions({ tabId: id, path, enabled: true });
    // Opening needs a user action; when the dapp's click does not count as one, the
    // toolbar button says so and opens it.
    try {
      await chrome.sidePanel.open({ tabId: id });
    } catch {
      void chrome.action.setBadgeText({ tabId: id, text: '1' });
    }
    return;
  }
  const created = await chrome.windows.create({ url: chrome.runtime.getURL(path), type: 'popup', width: 420, height: 680 });
  entry.window = created.id;
}

// The toolbar button opens this tab's panel; with a side panel the browser does it.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.action.onClicked.addListener((clicked) => {
  if (clicked.id === undefined) return;
  void chrome.action.setBadgeText({ tabId: clicked.id, text: '' });
  if (!chrome.sidePanel) void open(clicked.id);
});

chrome.tabs.onRemoved.addListener((id) => {
  const entry = tabs.get(id);
  if (entry?.window !== undefined) void chrome.windows.remove(entry.window).catch(() => {});
  tabs.delete(id);
});
chrome.windows.onRemoved.addListener((closed) => {
  for (const entry of tabs.values()) if (entry.window === closed) entry.window = undefined;
});
