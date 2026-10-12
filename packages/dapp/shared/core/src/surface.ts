/** What every Verum provider shares: the listener bookkeeping a dapp expects of
 *  an EIP-1193 provider, the answers that need no wallet, and the mark.
 *
 *  No dependencies, so the bookmark can import it without the transport. */

/** Transparent, so the mark sits on whatever the modal is and stays right in
 *  light and dark themes. */
export const VERUM_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
      '<g transform="translate(6 -88) scale(0.83)">' +
      '<path d="M69.9988 181.206L140 136.454L69.9988 239.096L0 136.454L69.9988 181.206Z" fill="#8cc2ff"/>' +
      '<path d="M69.9988 181.206L140 136.454L69.9988 239.096Z" fill="#3d7fd1"/>' +
      '</g></svg>',
  );

/** The EIP-6963 reverse-DNS identifier. */
export const VERUM_RDNS = 'me.verum.connect';

type Listener = (payload: any) => void;

export class Eip1193Surface<Event extends string = string> {
  private readonly listeners = new Map<Event, Set<Listener>>();

  on(event: Event, handler: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Part of the surface a provider is expected to carry: wallet selectors read
   *  the pairing URI with `provider.once('display_uri', …)`, and a missing method
   *  leaves the promise waiting on it unsettled. */
  once(event: Event, handler: Listener): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  removeListener(event: Event, handler: Listener): void {
    this.listeners.get(event)?.delete(handler);
  }

  protected emit(event: Event, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[verum] listener for ${event} threw`, err);
      }
    }
  }
}

/** The answers that need no wallet and no round trip, or undefined. */
export function localAnswer(
  method: string,
  chainId: string,
  accounts: string[],
): { value: unknown } | undefined {
  switch (method) {
    case 'eth_chainId':
      return { value: chainId };
    case 'net_version':
      return { value: String(Number.parseInt(chainId, 16)) };
    case 'eth_accounts':
      return { value: accounts };
    default:
      return undefined;
  }
}
