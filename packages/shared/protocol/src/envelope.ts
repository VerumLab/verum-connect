/**
 * Wire envelopes: JSON-RPC over NIP-44-encrypted events, shaped like NIP-46 with
 * different kind numbers so relays and clients do not confuse the two. Each
 * envelope below is the plaintext, encrypted into the event's `content`.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Dapp identity as claimed by the dapp. Nothing can bind it to the sending pubkey,
 * so the hub shows it as a claim; the session code is what tells the user they
 * paired with the right thing.
 */
export interface DappMetadata {
  name: string;
  /** Origin the dapp claims to be served from. */
  origin: string;
  description?: string;
  icon?: string;
}

/**
 * What a QR fragment carries, sent over the encrypted channel instead. The
 * typed-code path parks an event with only the pairing key, so the rest is the
 * dapp's to declare (the hub is an immutable build; the dapp is the redeployable
 * side). It names a whole relay set because a phone handed off from a desktop
 * arrives cold, as it does from a scan.
 */
export interface PairingNomination {
  relays: string[];
  cid?: string;
  tx?: string;
  webviewUrl?: string;
}

/** Hub -> dapp. First message after the QR is scanned. */
export interface ConnectMessage {
  type: 'connect';
  v: number;
  /** Echoed back by the dapp so a stale hub tab can tell it apart. */
  nonce: string;
}

/** Dapp -> hub. Answers a connect with who the dapp claims to be. */
export interface ConnectAckMessage {
  type: 'connect_ack';
  v: number;
  nonce: string;
  metadata: DappMetadata;
  /** Chains the dapp would like, CAIP-2 style ("eip155:1"). Advisory. */
  chains?: string[];
  /**
   * Relay nominated for the rest of the session, so each side stops holding sockets
   * on the others. The dapp nominates: the relay that delivered `connect` is proven
   * both ways, since the hub published on it. It must be declared, not inferred: the
   * fastest relay differs by direction, so independent choices could leave the two
   * on different hosts in silence. The ack goes on every relay, so nomination never
   * depends on the one nominated. Absent means stay on fan-out.
   */
  relay?: string;
  /**
   * Where to reach this dapp and which hub build it expects. Sent on every pairing,
   * so the hub has one rule for both deliveries.
   */
  pairing?: PairingNomination;
}

/** Hub -> dapp. Sent once the wallet has handed over accounts. */
export interface SessionReadyMessage {
  type: 'session_ready';
  v: number;
  accounts: string[];
  chainId: string;
  /** Wallet name as reported by the injected provider, for display only. */
  wallet?: string;
}

/**
 * Hub -> dapp. Announces the hub is live. This is the whole reconnect story: the
 * dapp keeps unanswered requests and flushes them on hello, so nothing is parked
 * on a relay.
 */
export interface HelloMessage {
  type: 'hello';
  v: number;
  accounts: string[];
  chainId: string;
}

export interface RpcRequestMessage {
  type: 'rpc_request';
  v: number;
  id: string;
  method: string;
  params: unknown[];
}

export interface RpcResponseMessage {
  type: 'rpc_response';
  v: number;
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Hub -> dapp. Mirrors EIP-1193 events so the dapp can react to the user
 *  switching accounts or chains inside the wallet. */
export interface EventMessage {
  type: 'event';
  v: number;
  event: 'accountsChanged' | 'chainChanged' | 'disconnect';
  data: unknown;
}

export interface DisconnectMessage {
  type: 'disconnect';
  v: number;
  reason?: string;
}

export type Envelope =
  | ConnectMessage
  | ConnectAckMessage
  | SessionReadyMessage
  | HelloMessage
  | RpcRequestMessage
  | RpcResponseMessage
  | EventMessage
  | DisconnectMessage;

/** JSON-RPC error codes. 4001/4100/4900/4901 are EIP-1193; -32xxx are JSON-RPC. */
export const ERROR_CODES = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  timeout: -32000,
} as const;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export function parseEnvelope(json: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('envelope: not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('envelope: not an object');
  const env = parsed as Record<string, unknown>;
  if (typeof env.type !== 'string') throw new Error('envelope: missing type');
  if (env.v !== PROTOCOL_VERSION) throw new Error(`envelope: unsupported version ${String(env.v)}`);
  return env as unknown as Envelope;
}

export function newRequestId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
