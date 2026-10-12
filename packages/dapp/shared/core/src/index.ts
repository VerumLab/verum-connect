export {
  VerumConnectProvider,
  resolveHub,
  resolveNetwork,
  resolveWebviewHub,
  type HubNetwork,
  type PairingCodeStatus,
  type VerumConnectOptions,
} from './provider.js';
export { Eip1193Surface, VERUM_ICON, VERUM_RDNS, localAnswer } from './surface.js';
export {
  DEFAULT_RELAYS,
  browserStorage,
  type KeyValueStorage,
  RpcError,
  ERROR_CODES,
  fingerprint,
  fingerprintString,
  type DappMetadata,
} from '@verumlab/connect-protocol';
// The typed-code path. A dapp needs the two error types to tell an interfered
// code apart from a stale one, since only the first means "stop offering it".
export {
  ConnectAmbiguityError,
  ConnectFloodError,
  DEFAULT_CAP,
  formatCode,
  KIND_DELETE,
  type PendingConnect,
} from '@verumlab/connect-protocol';
