/** The user agreement, shared by everything this project publishes.
 *
 *  Plain JS so a build script can read it as easily as a bundler can. It is
 *  shipped inside each build rather than hosted: every published artifact is an
 *  immutable CID or transaction, so whoever loads one gets the agreement that
 *  build was published under, and nobody can change it
 *  afterwards.
 *
 */

/** The agreement itself. Paragraphs, in order. */
export const TERMS_LINES = [
  'Provided as is under the MIT licence, without warranty, and not audited.',
  'The relays it uses and the gateway that served it are run by unrelated third parties. Relays and gateways can stop working without notice.',
  'This page holds no keys, signs nothing, and moves no funds — every request is approved by you, in your wallet, and that is what to verify before approving. Approvals cannot be undone.',
  'There is no operator, no support and no account: nobody can recover a key, reverse an approval or answer for a relay or gateway.',
  'Using this page means accepting this; if you do not, close it.',
];
