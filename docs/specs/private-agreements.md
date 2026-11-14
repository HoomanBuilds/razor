# Sealed business agreements

Purchasing includes an optional sealed-tender workflow, with supplier participation in the personal payments workspace. This adds commercial negotiation before a purchase order; it does not grant an agent or model treasury authority.

A versioned tender fixes specification, eligibility, invited supplier identities, USDC budget, quantities, deadlines, award criteria and permitted disclosures. Invited identities are captured at invitation time. Reassigning a later supplier profile does not transfer historical bid or transcript access. Offer and negotiation versions are immutable; late, withdrawn or rejected updates cannot replace accepted evidence.

The buyer generates and retains a local RSA-OAEP key pair. Offers use fresh AES-GCM encryption and identity/version commitments; hosted storage receives the public key and ciphertext. The buyer's private key is downloaded locally, not submitted to Razor. Reveal is an explicit recorded transition after the agreed deadline, not a cryptographic time lock. The buyer holding the private key can decrypt earlier outside the application.

Razor serves browser JavaScript, so the hosted browser can access keys and decrypted content while they are in use. The company-operated `scripts/private-agreements.ts` tool provides a separate local key/open/suggest workflow for a stronger processing boundary. Its optional price suggestion uses the required verified NEAR AI path with the company's own credentials and approved measurements. It does not silently switch model providers, sign an offer, accept model output or spend money. Independently verified hardware identity, historical freshness and decrypted-content proof remain distinct evidence claims.

Negotiation requires its own bounded company mandate for price, assets, quantities, dates and maximum commitment. A separate authorized company reviewer approves the mandate. Suggestions remain proposals that humans inspect and reseal. Supplier receiving details continue to come from the confirmed receiving profile, not from document instructions or a model answer.

Only the explicitly selected final terms are disclosed to Razor. Both exact parties accept the same immutable agreement version and hash before it can produce one ordinary draft purchase commitment. Existing purchasing approval still applies. Reopening, withdrawal, expiry, failed verification and no-valid-offer cases do not duplicate the purchase obligation. A tender dispute after purchase creation does not revoke a PO or payment; use their normal amendment, dispute and recovery controls.

Authorized parties can inspect only permitted metadata, their own offers and transcripts, key-retention controls and agreement history. Deleting hosted encrypted content cannot revoke copies or a downloaded private key. Selected final terms, metadata and later financial-chain visibility remain explicit disclosures.

This workflow has been integrated and compiled in source. No live private inference, browser key handling, deployed settlement or end-to-end agreement journey was exercised in this development pass. Those evidence gates remain open in the competitive checklist.
