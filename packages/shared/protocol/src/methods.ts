/**
 * Method classification.
 *
 * LOCAL: answered by the dapp from cached state, never on the wire.
 * SILENT: on the wire but raises no wallet UI; answered for every connected
 *   session, so background dapps do not read as disconnected.
 * PROMPTING: raises a wallet sheet; dispatched only for the session the user has
 *   in front, which is what makes "who asked for this signature" unambiguous.
 *
 * Unlisted methods are PROMPTING: they may raise UI, so this fails closed.
 */

export type MethodClass = 'local' | 'silent' | 'prompting';

const LOCAL = new Set([
  'eth_chainId',
  'eth_accounts',
  'net_version',
  'wallet_getPermissions',
]);

const SILENT = new Set([
  'eth_coinbase',
  'wallet_getCapabilities',
]);

const PROMPTING = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_decrypt',
  'eth_getEncryptionPublicKey',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_watchAsset',
  'wallet_requestPermissions',
  'wallet_sendCalls',
  'wallet_grantPermissions',
]);

export function classifyMethod(method: string): MethodClass {
  if (LOCAL.has(method)) return 'local';
  if (SILENT.has(method)) return 'silent';
  if (PROMPTING.has(method)) return 'prompting';
  return 'prompting';
}

/**
 * Read-only queries the dapp should serve from its own RPC: they need no key, and
 * sending them over a relay only adds latency and metadata leakage.
 */
export function isChainRead(method: string): boolean {
  return (
    method.startsWith('eth_get') ||
    method === 'eth_call' ||
    method === 'eth_blockNumber' ||
    method === 'eth_estimateGas' ||
    method === 'eth_gasPrice' ||
    method === 'eth_maxPriorityFeePerGas' ||
    method === 'eth_feeHistory' ||
    method === 'eth_syncing' ||
    method.startsWith('eth_newFilter') ||
    method.startsWith('eth_uninstallFilter')
  );
}
