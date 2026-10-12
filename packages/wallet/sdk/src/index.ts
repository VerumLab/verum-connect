export { Hub, type HubOptions, type HubSession, type HubState, type SessionStatus } from './hub.js';
export { type Eip1193Provider } from './types.js';
// Where sessions persist is the host's to supply — see HubOptions.storage.
export { browserStorage, type KeyValueStorage } from '@verumlab/connect-protocol';
export { resolvePairingCode, CODE_LOOKUP_RELAYS, type ResolveCodeOptions } from './code.js';
// Re-exported so a wallet can tell an interfered code apart from a stale one
// without reaching past this package for the type.
export {
  LookupConflictError,
  CODE_GROUP_SIZES,
  CODE_SYMBOLS,
  formatCode,
  normalizeCode,
} from '@verumlab/connect-protocol';
