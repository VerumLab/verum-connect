/**
 * Between the page and the extension: the page's window messages to the background
 * over a port, and the background's to the page. Reads none of them; the background
 * gets this tab's origin from the browser, not from here.
 */

import { FROM_PAGE, OVERRIDE_KEY, PAGE_PORT, TO_PAGE, overriddenSites } from './channel.js';

let port: chrome.runtime.Port | null = null;

function connect(): chrome.runtime.Port {
  const next = chrome.runtime.connect({ name: PAGE_PORT });
  next.onMessage.addListener((message) => window.postMessage({ [TO_PAGE]: true, message }, window.location.origin));
  // The background sleeps when idle and drops its ports: back at once, so what the
  // panel sends still arrives.
  next.onDisconnect.addListener(() => {
    if (port === next) port = connect();
  });
  return next;
}

// At once, not on the page's first message: a panel opened first must reach the page.
port = connect();

// This site's override, read now and again when the panel changes it.
const tellOverride = async () =>
  window.postMessage({ [TO_PAGE]: true, control: { override: (await overriddenSites())[location.origin] === true } }, location.origin);
void tellOverride();
chrome.storage.onChanged.addListener((changes) => {
  if (OVERRIDE_KEY in changes) void tellOverride();
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.[FROM_PAGE] !== true) return;
  port ??= connect();
  port.postMessage(event.data.message);
});
