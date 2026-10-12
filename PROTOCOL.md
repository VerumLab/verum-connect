# Verum Connect — protocol

Wallet ↔ dapp connections over nostr relays. No account, no subscription, no centralized server. 
The TypeScript in `packages/shared/protocol` is the reference; this document
is the specification.

---

## The idea

Decentralized connection between a wallet and dapp. No integration in the dapp or wallet
required. To remove the need for integration Verum Connect uses two pages,
both published on IPFS and Arweave:

- **Hub** (wallet side). An ordinary web page opened in a wallet's in-app browser. It
  receives `window.ethereum` like any site, so to the wallet it *is* a dapp: no SDK,
  no awareness of nostr. A wallet that wants a native flow implements the wallet side
  of this protocol (`@verumlab/connect-wallet`) and needs no hub.
- **Bookmarklet** (dapp side). A bookmark that injects an EIP-1193 provider into any
  dapp. The page script only forwards calls by `postMessage` to a panel on our own
  origin, which runs the dapp side of this protocol, so the dapp's CSP cannot block
  the relay sockets and the dapp's origin comes from the browser. A dapp that wants a
  native flow uses the dapp SDK (`@verumlab/connect-dapp` and its bindings).

Anyone can run the relays and the IPFS or Arweave nodes that serve the pages.

```
 dapp                                                       wallet device
┌──────────────────────────┐                              ┌───────────────────────┐
│ dapp SDK provider        │                              │ hub page              │
│   or bookmarklet → panel │◄── nostr relays (NIP-44) ───►│   or wallet SDK       │
│                          │    kinds 24140 / 24141       │        │ EIP-1193     │
│ chain reads → dapp's RPC │                              │        ▼              │
│ (never relayed)          │                              │ wallet (unmodified)   │
└──────────────────────────┘                              └───────────────────────┘
```

---

## Roles

| | **Dapp side** | **Wallet side** |
|---|---|---|
| Reference | `@verumlab/connect-dapp` | `@verumlab/connect-wallet` |
| Mints | the pairing keypair and URI | one keypair per pairing |
| Speaks first | no — subscribes and waits | yes — `connect` |
| Sends | `connect_ack`, `rpc_request` | `connect`, `session_ready`, `hello`, `rpc_response`, `event` |
| Shows | the QR and the session code | the claimed origin and the session code |
| Holds | unanswered requests, in memory | the wallet, and one active session |
| Nominates | the relay for the session | — |

---

## Events

Every message is a nostr event (NIP-01).

| Field | Value |
|---|---|
| `kind` | `24141` handshake, `24140` session — ephemeral, never stored by relays |
| `content` | the envelope, JSON, NIP-44 v2 encrypted |
| `tags` | exactly `[["p", <recipient pubkey hex>]]` |
| `created_at` | unix seconds |
| `pubkey`, `id`, `sig` | x-only pubkey; `id` = sha256 of `[0,pubkey,created_at,kind,tags,content]` (no whitespace); BIP-340 schnorr over the id |

A receiver MUST, before anything else: recompute the id and reject a mismatch, and
verify the signature. Then, in order:

1. drop if `created_at` is more than **120 s** from local time;
2. drop if the `id` was already accepted (keep ~2000);
3. per peer, drop if `created_at` is **strictly below** the greatest accepted (equal
   MUST pass — one-second granularity).

---

## Session keys

secp256k1. A secret is 32 CSPRNG bytes; the public key is its 32-byte x-only form.
Keys, ids, signatures and pubkeys are lowercase hex; reject a pubkey that is not 64
hex characters. Session keypairs are ephemeral and per pairing.

```
point     = ecdh(our_secret, 0x02 || their_xonly_pubkey)   # assume even Y
shared_x  = point[1..33]                                   # X only
conv_key  = hkdf_extract(salt: "nip44-v2", ikm: shared_x)  # SHA-256
```

Hash the 32 X bytes and nothing else: when the peer's Y is odd the two sides compute
negated points, which agree only on X. Feeding the whole point into HKDF fails for
about half of all keypairs.

---

## Encryption

NIP-44 v2, unmodified (see the NIP for the algorithm and its vectors). Per message:
32 fresh random nonce bytes; `hkdf_expand(conv_key, nonce, 76)` → ChaCha20 key (32),
ChaCha20 nonce (12), HMAC key (32); payload = base64(`0x02 || nonce || ciphertext ||
mac`), mac = HMAC-SHA256 over `nonce || ciphertext`.

Padded buffer: `uint16be(len) || plaintext || zeros`, total `2 + padded_len(len)`:

```
padded_len(len):
  if len ≤ 32: return 32
  nextpow2 = 1 << (⌊log2(len − 1)⌋ + 1)
  chunk    = 32 if nextpow2 ≤ 256 else nextpow2 / 8
  return chunk × (⌊(len − 1) / chunk⌋ + 1)
```

Decrypt in order: reject version ≠ 2 (and a payload starting `#`); verify the MAC in
**constant time**; decrypt; check the length is 1..65535 and the buffer is exactly
`2 + padded_len(length)`. Plaintext is 1..65535 bytes.

---

## Relay transport

NIP-01 over WebSocket. Client sends `REQ`, `EVENT`, `CLOSE`; relay sends `EVENT`,
`OK`, `EOSE`, `CLOSED`, `NOTICE`. Ignore anything else.

**Filters.** With a known peer: `{"kinds":[k],"authors":[peer],"#p":[us]}`. The dapp
awaiting a `connect`: `{"kinds":[24141],"#p":[us],"since":<now − 60 s>}`.

**Fan-out.** Open every relay in the set; publish to all; the first `OK` is success;
dedupe received events by id. A session needs one reachable relay. Use at most **8**
relays from a pairing link.

**Nomination.** The dapp names one relay in `connect_ack` (the one `connect` arrived
on) and both sides narrow to it once the ack is on the wire. The ack itself goes to
every relay. If the nominated relay dies, both widen back to the full set. No `relay`
in the ack means stay on fan-out.

**Reconnect.** Exponential backoff 1 s → 30 s, × random 0.5–1.0; a socket that was
open retries fast. Replay all live subscriptions on every reconnect. Reference
timeouts: 12 s for a first socket before publishing, 10 s for a publish `OK`.

---

## Pairing URI

```
<hub-url>#v=1&p=<dapp-pubkey>&r=<relay,relay>&c=<cid>&t=<tx>&w=<webview-url>
```

All parameters are in the fragment, never sent to the gateway. A hub opened with no
fragment works on its own (scan, typed code, existing sessions); a pairing fragment
requires `v`, `p`, `r`, and `c` (IPFS CID), `t` (Arweave tx) and `w` (address for a
wallet's in-app browser) are optional. Values are percent-encoded; split `r` on `,` after decoding.
Prefer a subdomain gateway (`<cid>.ipfs.<host>`) so each build has its own origin.

A parser MUST reject, not repair:

| Field | Rule |
|---|---|
| `v` | absent or not `1` |
| `p` | absent or not 64 hex characters |
| `r` | empty, or an entry not starting `ws://` / `wss://` |
| `w` | present and not starting `http://` / `https://` |
| `t` | present and not exactly 43 base64url characters |

The hub removes the fragment from the address bar after reading it.

---

## Envelopes

JSON in `content`. Every envelope has `type` and `v` (`1`).

```jsonc
{ "type": "connect",       "v": 1, "nonce": "<hex>" }                     // hub → dapp, 24141
{ "type": "connect_ack",   "v": 1, "nonce": "<echoed>",                   // dapp → hub, 24141
  "metadata": { "name": "…", "origin": "…", "description": "…", "icon": "…" },
  "chains": ["eip155:1"],                    // optional, advisory
  "relay": "wss://…",                        // optional: the nominated relay
  "pairing": { "relays": ["wss://…"], "cid": "…", "tx": "…", "webviewUrl": "https://…" } }
                                             // optional: what a QR fragment carries
{ "type": "session_ready", "v": 1, "accounts": ["0x…"], "chainId": "0x1", "wallet": "…" }
{ "type": "hello",         "v": 1, "accounts": ["0x…"], "chainId": "0x1" }
{ "type": "rpc_request",   "v": 1, "id": "<unique>", "method": "…", "params": [] }
{ "type": "rpc_response",  "v": 1, "id": "<echoed>", "result": <any> }
{ "type": "rpc_response",  "v": 1, "id": "<echoed>", "error": { "code": -32603, "message": "…" } }
{ "type": "event",         "v": 1, "event": "accountsChanged" | "chainChanged" | "disconnect", "data": <any> }
{ "type": "disconnect",    "v": 1, "reason": "…" }
```

- `description`, `icon`, `wallet`, `reason` are optional. `chainId` is a hex quantity;
  compare accounts case-insensitively.
- Ids and nonces are opaque, unique per session (reference: 8 random bytes, hex). A
  hub MUST ignore an ack whose nonce is not the one it sent; a response with an
  unknown id is dropped.
- `error` wins over `result` if both are present.
- `v` ≠ 1: reject before reading `type`. Unknown `type` or field within `v: 1`: ignore.

---

## Sequence

```
hub → dapp   connect        24141
dapp → hub   connect_ack    24141   echoes nonce, locks the pairing
hub → dapp   session_ready  24140   once the wallet gave accounts
hub → dapp   hello          24140   on every wake; dapp re-sends pending requests
dapp → hub   rpc_request    24140
hub → dapp   rpc_response   24140
```

**Dapp.** Mint a keypair; subscribe on 24141; show the URI as a QR and as copyable
text. On the first decryptable `connect`: derive the conversation key from the event's
pubkey, **lock**, show the session code, publish `connect_ack` to every relay, narrow
to the nominated relay, subscribe on 24140.

**Lock.** A dapp MUST bind to the first hub whose `connect` it decrypts and MUST
ignore every later `connect` on that pairing. A new pairing mints a new keypair.

**Wallet.** Parse the fragment; mint a keypair; derive the conversation key; show the
session code; publish `connect` and wait **20 s** for the ack, else discard the
pairing. On a valid ack: open 24140, get accounts, send `session_ready`. If the wallet
refuses, create and persist nothing. Ask with `wallet_requestPermissions` first
(bounded to a few seconds), then `eth_requestAccounts`.

A request waits **180 s** for its response before the dapp fails it (`-32000`).

---

## Session code

Four words from the conversation key only; never transmitted, never typed.

```
digest  = sha256("verum-connect/fingerprint/v1" || conversation_key)
word[i] = WORDLIST[digest[i]]   for i in 0..3
```

Display joined by ` · `. `WORDLIST`, index 0 `acid` to 255 `mouse`, left to right:

```
acid   acorn  actor  adapt  admit  agent  album  alert
alien  alley  alpha  amber  ankle  apple  apron  arena
armor  arrow  asset  atlas  audio  audit  avoid  awake
award  bacon  badge  bagel  baker  banjo  barge  basil
basin  batch  beach  beard  beast  bench  berry  bison
blade  blaze  blend  block  bloom  board  bonus  boost
booth  brave  bread  brick  brisk  broom  brush  bugle
cabin  cable  cacao  cadet  camel  candy  canoe  cargo
carol  carve  cedar  cello  chalk  charm  chess  chief
chime  choir  chord  cider  cliff  cloak  clock  cloud
clove  coach  cobra  cocoa  comet  coral  couch  cover
crane  crate  crisp  crown  crumb  curve  cyber  daisy
dance  dealt  debug  decoy  delta  dense  depot  diner
dizzy  dodge  donor  draft  drain  drama  dream  drift
drums  eagle  early  earth  easel  ebony  edict  eight
elbow  elder  elite  ember  empty  enact  enjoy  entry
equal  erupt  essay  ether  ethic  event  exact  exile
extra  fable  facet  faint  fancy  feast  fence  fiber
field  fifty  final  flame  flask  fleet  flint  float
flock  flour  flute  focus  forge  forum  fossil found
frame  fresh  frost  fruit  fudge  gauge  ghost  giant
glide  globe  glove  grain  grape  grasp  green  grill
group  grove  guard  guest  guide  habit  harbor hasty
haven  hazel  heart  hedge  hertz  hinge  hobby  honey
horse  hotel  house  human  humid  ideal  index  inlet
input  ivory  jelly  jewel  joker  jolly  judge  juice
kayak  kneel  knife  koala  label  lager  lamp   lance
large  laser  latch  layer  ledge  lemon  lever  light
lilac  linen  liver  lobby  local  lodge  logic  lotus
lucky  lunar  lyric  magic  major  mango  maple  march
marsh  medal  melon  mercy  metal  meter  micro  midst
miner  minor  mixer  model  moist  motor  mound  mouse
```

It lets the user identify and verify a connection by eye: the same four words on both
screens mean both sides hold the same key, and the words tell sessions apart when
several are open.

---

## Method dispatch

| Class | Crosses the relay | Methods |
|---|---|---|
| **local** | no | `eth_chainId` `eth_accounts` `net_version` `wallet_getPermissions`; `eth_requestAccounts` once connected |
| **silent** | yes, for every session | `eth_coinbase` `wallet_getCapabilities` |
| **prompting** | yes, active session only | `eth_requestAccounts` `eth_sendTransaction` `eth_signTransaction` `eth_sign` `personal_sign` `eth_signTypedData` `eth_signTypedData_v1` `eth_signTypedData_v3` `eth_signTypedData_v4` `eth_decrypt` `eth_getEncryptionPublicKey` `wallet_addEthereumChain` `wallet_switchEthereumChain` `wallet_watchAsset` `wallet_requestPermissions` `wallet_sendCalls` `wallet_grantPermissions` |

Unlisted methods are **prompting**. Chain reads never cross the relay — `eth_call`
`eth_blockNumber` `eth_estimateGas` `eth_gasPrice` `eth_maxPriorityFeePerGas`
`eth_feeHistory` `eth_syncing` `eth_get*` `eth_newFilter*` `eth_uninstallFilter*` —
the dapp serves them from its own RPC, or fails them if it has none.

The hub relays requests unchanged; the wallet's own sheet is the approval.

---

## Errors

| Code | Meaning |
|---|---|
| `4001` | user rejected |
| `4100` | unauthorized |
| `4200` | unsupported method |
| `4900` | disconnected — no wallet at the hub, or no session at the dapp |
| `4901` | chain disconnected |
| `-32600` | invalid request |
| `-32601` | method not found — a local method reached dispatch |
| `-32602` | invalid params |
| `-32603` | internal error — a wallet throw without a code |
| `-32000` | timeout |

Forward a wallet error's own numeric `code` verbatim.

---

## Reconnection

Nothing is stored on relays. The dapp keeps unanswered requests in memory by id. The
wallet sends `hello` (a state snapshot) on every wake — page load, relay reconnect,
Reconnect button — and after any state change. On `hello` the dapp adopts its accounts
and chain and re-sends every outstanding request with the same id. A stored session
is re-opened and waits for `hello`; it is never assumed alive.

---

## Many sessions, one active

For a wallet side holding several pairings:

- Prompting requests dispatch only for the active session; others queue and badge.
- Silent requests answer for every session.
- Only the user switches the active session; a request never promotes itself.
- Responses route by originating session.
- A queue drains sequentially when its session becomes active.
- After `wallet_switchEthereumChain`, re-read `eth_chainId` and send `chainChanged`
  and `hello` to every session.

A single-session implementation treats its one session as always active.

---

## Typed pairing codes

A third way to deliver the pairing key, for when there is no camera or shared
clipboard. It uses its **own keypair**, never the QR's: its pubkey is published, so
anyone can connect to it.

**Parked event.** Kind `4140` (regular, stored), signed by the code keypair:

```
tags     [["d", <code>], ["expiration", <now + 300>]]     # NIP-40
content  ""                                               # MUST be empty
```

**Code.** 26 Crockford base32 symbols (130 bits):

```
digest = sha256("verum-connect/pairing-code/v2" || pairing_pubkey_raw_32_bytes)
code   = first 130 bits of digest, 5 bits per symbol, most significant first,
         alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

Displayed in groups of 5-5-4-4-4-4; the dashes are never part of the code.
Normalise input: strip spaces and dashes, uppercase, map `O`→`0` and `I`,`L`→`1`,
**reject `U`**.

**Resolution** (wallet). Subscribe `{"kinds":[4140],"#d":[code]}` on its own relay
list and collect for a window (reference 2.5 s after the first relay connects;
give up if none connects in 8 s). Keep events whose id and signature verify **and**
whose pubkey hashes to the typed code; ignore the rest. Distinct pubkeys: 0 → not
found; 1 → pair with it, sending `connect` on the relays searched; 2+ → halt.
Relays, CID, tx and WebView address come later in `connect_ack.pairing`.

**Commit** (dapp). Hold every `connect` on the code keypair, deduplicated by sender
pubkey, each shown with its session code; cap at **10**, and stop after a budget of
**100** attempts. The user selects by session code — never by position, never by a
timer. Abort if two pending senders show the same code. After a selection, drop the
others and accept no more on that key. Retract the parked event (NIP-09) once used.

Security: a substituted key needs a 2¹³⁰ fingerprint preimage; anyone can deny the
path (flood, or relays dropping the event), so present it as a fallback to the QR.

---

## Test vectors

```
dapp_sk           0101…01 (32 × 0x01)
dapp_pk           1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f
hub_sk            0202…02 (32 × 0x02)
hub_pk            4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766
conversation_key  59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5
session code      hedge · apple · adapt · elbow
```

Derive the conversation key from both sides and check they agree.

**Padding** `padded_len(n)`:

```
1 → 32       32 → 32      33 → 64      64 → 64
100 → 128    128 → 128    256 → 256    257 → 320
320 → 320    1000 → 1024  1024 → 1024  65535 → 65536
```

**Encryption**, `nonce = 0303…03` (32 × 0x03), conversation key above (each payload
is one string):

```
{"type":"hello","v":1}
AgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDR6UA/ZeBM7UC0UYx4Sh
/7XCaAdBDeP1mte5IGbWrDnGGRpX52iCBKSqFbqqv9vcz9gHZNIo4tGkSr2XhIJ7
UlkG8

{"type":"connect","v":1,"nonce":"0f1e2d3c4b5a6978"}
AgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDR4AA/ZeBM7UC0UY66yp9
5zHCAYpDNO4hhMJqd9rFbRSkfL/CUnE7oaqgYTsEtUyGcqgq1hg2fLBclC/Yt2PH
Kg+5m4kkbUDInLxCHl1P2qgNZiCD6oY/ePWRrSfB+YSBRRg=
```

**Event id**, the dapp signing the `hello` payload:

```
pubkey      1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f
created_at  1767225600
kind        24140
tags        [["p","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"]]
content     <the hello payload above>
id          98f3510d4700e2dbe44ba3e2c2f23605475f05307922ec50d3c62a32e7b9e66e
```

No signature vector: BIP-340 uses fresh auxiliary randomness. Verify your own output.

**Pairing URI**:

```
https://bafyhub.ipfs.dweb.link/#v=1&p=1b84c5567b126440995d3ed5aaba0565d71e18
34604819ff9c17f5e9d5dd078f&r=wss%3A%2F%2Frelay.damus.io%2Cwss%3A%2F%2Fnos.lol
&c=bafyhub
→ publicKey 1b84…078f, relays ["wss://relay.damus.io","wss://nos.lol"], cid bafyhub
```

**Typed code**, for `dapp_pk`:

```
1XWDR1BAKHZ0MVJX0FRJDKHPXR   (displayed 1XWDR-1BAKH-Z0MV-JX0F-RJDK-HPXR)
```

---

## Security notes

Verum Connect is a connection protocol: it carries requests between dapp and wallet
unchanged. The wallet's own confirmation, where the user
checks what is about to be signed, is and stays the ultimate control, and the
backstop for everything below.

- Relays see pubkeys, timing and padded sizes, and an operator sees IPs; content is
  NIP-44. Per-session keys break linkage across sessions.
- The gateway serving the hub sees the wallet's IP but not the session (fragment).
- The hub or a gateway serving a tampered build can alter what the wallet is asked
  to sign; the wallet displays what it signs. 
- Dapp metadata is self-asserted; the hub labels it so.
- A compromised wallet or device is out of scope.
