# Deployed

Links open the deployed source through a gateway.

## Hub

The hub links carry the dapp SDK's default relays (`?relays=`), so a typed connect code works on
first open. A pairing link brings its own relays either way.

| Version | Source | IPFS CID | Arweave tx |
|---|---|---|---|
| 0.1.0 | — | [`bafybeidqjp5…odkaeq`](https://bafybeidqjp5yb4zpc3boglxiw6rn7qkrfdqpqaa52o66lzf3oywiodkaeq.ipfs.inbrowser.link/?relays=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://offchain.pub) | [`I6jVLQ7PK3fX…gsd9hE`](https://eounklioz4vxpv4jtq3tzfmzg6vje3ev5t34b2pac4si4cy56yiq.ar.io/I6jVLQ7PK3fXiZw3PJWZN6qSbJXs98Dp4Bckjgsd9hE/?relays=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://offchain.pub) |

## Bookmarklet

| Version | Source | IPFS CID | Arweave tx |
|---|---|---|---|
| 0.1.0 | — | [`bafybeiesasz…273lt54u`](https://bafybeiesaszldgbe7fdhidndrc46lmwnqrv4fgea2dyco6vqzp273lt54u.ipfs.inbrowser.link/) | [`DkLpVdDe8BnM…nFA7o`](https://bzbosvoq33ybttfgxtrt2zlpp6kimablbwi57dx6msmvogofao5a.ar.io/DkLpVdDe8BnMprzjPWVvf5SGACsNkd-O_mSZVxnFA7o/) |

## Versions

- **Protocol:** the `v=1` in the pairing link, and in every envelope. It changes only
  on a breaking wire change, and every part has to speak the same one. The typed
  connect code carries no version of its own, so a mismatch there shows at the first
  envelope. Its derivation has a second marker, `verum-connect/pairing-code/v2`, which
  moves with any change to the alphabet, length or hash.
- **SDK packages:** one version, published together. They depend on each other at
  exact versions and are tested as a set.
- **Hub and bookmarklet:** a version of their own (their `package.json`), bumped
  when published. They are not on npm: the CID and the transaction are the
  identity, and never change. A new hub needs a new bookmarklet build, since the
  panel carries the hub's CID and transaction.

## Adding a deployment

1. Bump the version in the artifact's `package.json`, commit, and tag the commit
   `hub-v<version>` or `bookmarklet-v<version>`.
2. Stage it with `node scripts/prepare-deploy.mjs <hub|bookmarklet>`, upload the deploy folder to
   IPFS and Arweave, then add a row with the source tag and both addresses, and update the
   version in the README.
3. Check it against the tag:

```bash
node scripts/verify-deploy.mjs <cid-or-tx> --source <owner/repo> --ref <tag>
```
