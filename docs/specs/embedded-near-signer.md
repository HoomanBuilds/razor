# Social sign-in and native NEAR signing

Google/email/passkey sign-in can lead into an embedded native NEAR signing setup, with an existing external NEAR wallet as an alternative. Social identity alone grants no financial authority.

The configured Privy integration supplies a nonimported, nondelegated Ed25519 wallet capable of signing arbitrary bytes. Razor uses that public key to derive a native NEAR implicit account and verifies every returned signature against the exact NEAR bytes. No Solana transaction is made. No private key or seed is imported, exported or stored by Razor. The provider's confirmation and key-custody/recovery behavior remain part of the wallet trust boundary.

Binding requires a recent authenticated Razor session, the matching verified provider identity and authoritative provider wallet/profile data. The account must receive native NEAR funding before an existing fresh NEP-413 ownership proof can establish its finalized FullAccess key. There is no automatic sponsor, free account/gas claim or silent transfer. Setup shows account, network, available NEAR, storage/gas information and an explicit funding path.

Before signing, the owner reviews the exact NEAR receiver, actions, deposits and gas. The adapter pins provider identity, public key, account, network and binding generation; changes invalidate the review. It validates the provider's raw Ed25519 signature, broadcasts once and requires an authoritative final outcome before resolving its pending transaction journal. Rejection or an unknown result does not automatically generate another signature or payment. Metadata recovery keeps a bounded journal of hashes and receivers without keys or signed transaction bytes.

Returning users restore the original provider wallet and its own recovery controls. An alternate already verified Razor login or external NEAR wallet remains a separate recovery path. Disabling the Razor adapter does not remove its key from the NEAR account; actual key retirement requires an authorized onchain action. An unavailable provider/device is not bypassed using email alone.

Configuration requires matching Privy app IDs, token verification settings, server profile credentials, enabled supported wallets/login methods and permitted origins. Server and browser NEAR RPCs must use the same network. Credentials were not supplied during this development pass. Live wallet creation, signature compatibility, returning login and recovery remain unverified; source integration and compilation do not close those checklist gates.
