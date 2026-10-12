/** Shared harness for tests that touch the provider.
 *
 *  Every one of these needs a localStorage: the provider reads a stored gateway,
 *  network and relay choice on construction and writes them back on every
 *  setter. Node has none, so without a stub the constructor throws and nothing
 *  below it can be reached.
 *
 *  Fresh per test rather than module-level, so a persisted choice from one test
 *  cannot decide the outcome of the next — which is precisely the state these
 *  are checking.
 */

export function withStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

export const CID = 'bafybeiasl7zsji7x72kiukv2pp56d4pkp2ls45yl73ngx32ndfeajr4oce';
export const TX = '60BQVxxTYI688pFQPCYzqHv_jCWZqJq1HvOTVDUakWI';
/** base32 of TX's bytes — the sandbox subdomain a gateway derives for it. */
export const TX_SANDBOX = '5nafavy4knqi5phssfidyjrtvb577dbftgujvni66ojvini2sfra';

export const METADATA = {
  name: 'test dapp',
  origin: 'https://dapp.example',
  description: 'test',
};

/** Options a dapp would pass, with whichever identifiers the test needs. */
export function options(extra = {}) {
  return { metadata: METADATA, ...extra };
}
