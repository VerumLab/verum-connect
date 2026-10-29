/**
 * Azguard's dapp API carried over a session. Its extension injects `window.azguard`, and
 * a dapp talks to the client it creates: requests by name, and session events. The hub
 * holds the real one; the bookmarklet puts a stand-in on the dapp's page that forwards
 * every request and replays every event. The calls are plain requests, so the session
 * code is the only check; Azguard's own approval is the wallet's.
 *
 * On the wire, dapp → hub: `azguard_request` {method, params}; hub → dapp: the
 * `azguard_event` event {event, data}.
 */

export const AZGUARD_REQUEST = 'azguard_request';
export const AZGUARD_EVENT = 'azguard_event';

const EVENTS = ['session_updated', 'session_closed'] as const;

type Handler = (data: unknown) => void;

interface AzguardClient {
  request(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: Handler): void;
  off(event: string, handler: Handler): void;
}

/** `window.azguard`, as the extension injects it. */
export interface AzguardObject {
  version: string;
  createClient(): AzguardClient;
  /** Set on the stand-in, so a hub in a browser with the extension waits for the real one. */
  verumStandIn?: true;
}

export interface AzguardWalletInfo {
  name: string;
  logo: string;
  version: string;
}

// ---------------------------------------------------------------------- wallet's device

/** The extension's object once its content script has run, or undefined after `timeoutMs`. */
export function findAzguard(timeoutMs = 2000): Promise<AzguardObject | undefined> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const azguard = (globalThis as { azguard?: AzguardObject }).azguard;
      if (azguard?.createClient && !azguard.verumStandIn) return resolve(azguard);
      if (Date.now() - started >= timeoutMs) return resolve(undefined);
      setTimeout(look, 50);
    };
    look();
  });
}

/**
 * The wallet side as a provider the hub attaches like any wallet: `azguard_request` goes
 * to Azguard's client, its events come out as `azguard_event`. No Ethereum accounts.
 */
export function azguardProvider(azguard: AzguardObject) {
  const client = azguard.createClient();
  const listeners: Handler[] = [];
  for (const event of EVENTS) {
    client.on(event, (data) => listeners.forEach((listener) => listener({ event, data })));
  }
  return {
    isAztec: true,
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case AZGUARD_REQUEST: {
          const call = (params[0] ?? {}) as { method: string; params?: unknown };
          return client.request(call.method, call.params);
        }
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [];
        case 'eth_chainId':
          return '0x0';
        default:
          throw Object.assign(new Error(`hub: ${method} is not an Azguard method`), { code: 4200 });
      }
    },
    on(event: string, listener: Handler) {
      if (event === AZGUARD_EVENT) listeners.push(listener);
    },
  };
}

// ---------------------------------------------------------------------- dapp's device

/**
 * A stand-in `window.azguard` on the dapp's page, holding the property from the start:
 * the real one, injected later, lands in its setter, and a dapp reading it gets the real
 * one unless `preferred` says the user chose this one, or there is none.
 * `forward` sends a request over the session, pairing first; `paired` says whether one
 * is live, so a dapp looking for its stored session on load does not open a pairing.
 * `deliver` registers for the wallet's events. Returns whether a real one was injected.
 */
export function standInAzguard(
  forward: (method: string, params: unknown[]) => Promise<unknown>,
  paired: () => boolean,
  deliver: (listener: (message: { event: string; data: unknown }) => void) => void,
  preferred: () => boolean,
): () => boolean {
  const handlers = new Map<string, Set<Handler>>();
  deliver(({ event, data }) => handlers.get(event)?.forEach((handler) => handler(data)));

  const standIn: AzguardObject = {
    verumStandIn: true,
    // The client it was published with; a dapp's client only warns on another.
    version: '0.9.0',
    createClient: () => ({
      async request(method, params) {
        if (method === 'get_session' && !paired()) return null;
        return forward(AZGUARD_REQUEST, [{ method, params }]);
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off(event, handler) {
        handlers.get(event)?.delete(handler);
      },
    }),
  };

  let real: AzguardObject | undefined = (globalThis as { azguard?: AzguardObject }).azguard;
  try {
    // Not configurable: Azguard deletes and redefines the property, and would otherwise
    // take it for good; its plain assignment then comes here.
    Object.defineProperty(globalThis, 'azguard', {
      get: () => (real && !preferred() ? real : standIn),
      set: (value: AzguardObject) => {
        real = value;
      },
      configurable: false,
    });
  } catch {
    // Already held for good by the real one: it stays.
  }
  return () => real !== undefined;
}
