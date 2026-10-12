# Verum Connect

Ethereum wallet connection protocol. Connects any dapp to any wallet on any device with nostr relays. Support for dapp and wallet integration through SDK. Design: [PROTOCOL.md](PROTOCOL.md).

Try the dapp demo here: [IPFS](https://bafybeiahh755bqmug2fmjswe2xkuslzcjuonmeovim6nbmziccqmdqmjam.ipfs.inbrowser.link/).

## Bookmarklet

Add Verum Connect to any dapp through a browser bookmark, no dapp integration required. Deployed: [version 0.1.0](DEPLOYED.md#bookmarklet).

```bash
node scripts/prepare-deploy.mjs bookmarklet         # after build upload the deploy folder to IPFS or Arweave
node scripts/verify-deploy.mjs <cid> --no-build     # verify gateway serves the deployed bytes   
```

## Hub

Use any injected wallet with Verum Connect, no wallet integration required. Deployed: [version 0.1.0](DEPLOYED.md#hub).

```bash
node scripts/prepare-deploy.mjs hub                 # after build upload the deploy folder to IPFS or Arweave
node scripts/verify-deploy.mjs <cid> --no-build     # verify gateway serves the deployed bytes   
```

## SDK

Integrate Verum Connect in a dapp directly. Demos for different wallet selector, run locally:

```bash
npm install && npm run build
npm run dev:<demo>                                  # demo (no framework) | rainbowkit | connectkit | web3onboard
```

## License

MIT © 2026 Verum LLC — see [LICENSE](LICENSE).

---

Built with [Claude Code](https://claude.ai/code)
