/** Tags on the window messages between the page script and the content script. */
export const FROM_PAGE = 'verumConnectFromPage';
export const TO_PAGE = 'verumConnectToPage';

/** The port each side opens to the background: a tab's content script, or its panel. */
export const PAGE_PORT = 'page';
export const PANEL_PORT = 'panel';

/** Per site, from the extension's storage: the hub's Aztec wallet over this browser's own. */
export interface Control {
  override: boolean;
}

export const OVERRIDE_KEY = 'override';

export async function overriddenSites(): Promise<Record<string, boolean>> {
  return ((await chrome.storage.local.get(OVERRIDE_KEY))[OVERRIDE_KEY] as Record<string, boolean>) ?? {};
}
