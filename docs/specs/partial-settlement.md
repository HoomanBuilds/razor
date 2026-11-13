# Partial delivery and separately approved remainders

A routing provider reporting success does not establish full delivery. Razor compares exact destination output with the signed route output and the final NEAR treasury attestation. Missing, malformed, zero or short output holds the payment for reconciliation. Observed positive output remains recorded even if a later provider response omits it. A positive delivery blocks a full retry, USDC backup, unsent closure or full-refund recovery.

## Terminal partial agreement

The company owner or appointed settlement reporter reviews the matching destination transaction, actual received token amount, evidence that the route cannot deliver again, and an explicitly agreed USDC entitlement credit. For verified native USDC, the credit must equal the received USDC. Other assets need a recorded valuation agreement; token units and quote proportions never silently become USDC credit.

The review binds payment ID, attempt ID, exact quote hash, destination transaction, actual output, credited microUSDC, valuation basis and closure evidence into a private receipt commitment. The NEAR contract verifies positive output below the quoted amount, a positive credit below the face entitlement, the exact current attempt and quote, reporter authority, terminal closure and receipt replay prevention. It retains actual destination output and credited entitlement separately.

`partially_paid` is terminal for the original payment. Its original amount, fees, recipient snapshot and recorded source spending remain immutable. Its attempt becomes `partially_delivered`; the original cannot be canceled, funded, retried or sent through backup. Source spending includes the full confirmed current source transfer and previous incurred costs even before delivery is finalized. A partial credit does not erase spending or reset a fee budget.

The server recognizes the final NEAR result only when it matches the exact stored review and the reviewed treasury code. One transaction records the credit, actual output, proof and terminal status. External output and its valuation remain an owner or reporter attestation, not an independently verified external-chain proof. A terminal partial reported outside the reviewed application workflow is held for review rather than receiving an invented credit.

## Fresh remainder workflow

After authoritative terminal closure, a preparer may create exactly one remainder of original entitlement minus credited entitlement. The preparer explicitly chooses a new routing cost ceiling. The draft uses the same recipient identity, current confirmed preferences and a new payment ID. A stale profile or review cannot be approved. The original's old signature or approval cannot authorize this remainder.

The remainder receives a fresh exact approval and then uses ordinary funding, quorum approval, source execution and reconciliation. Bills retain their original face amount and all installments. Payroll keeps the original pay-period entitlement while aggregating credited deliveries and source costs over partial and replacement lineage. A canceled remainder may be replaced without restoring the original face liability; the partial review resolves the current replacement. Individual approval of a replacement payroll remainder requires a current item, previously approved original run and verified partial lineage. It leaves other drafts and the run's approval state unchanged.

Client principal stays anchored to its original earmark and terms hash. Actual delivery aggregates over the liability lineage. Reservation and in-flight coverage follow only the active unpaid descendant, exposed as `activePaymentId`, so a child reservation does not also appear as unreserved client principal. Client cash is not reclassified as earned revenue by this process.

## Product and reporting

Payment history and reconciliation show actual destination output, credited USDC, original entitlement, remaining liability, actual source spent, valuation evidence and fresh approval status. An original with no remainder remains an explicit attention item. Once its remainder exists, the remaining payment appears without counting the original face amount again. CSV exports distinguish attested output units, entitlement credit, spent source and remainder ID. Project cash results subtract all reconciled source spending, including incomplete deliveries, while business debt setoff remains separate from cash.

Mount `partialSettlementRoutes` under the authenticated company API at `/partial-settlements`. `PartialSettlementPanel` is used in payment history and reconciliation. Map the `PARTIAL_LIABILITY` database guard to HTTP 409. Migration `027-partial-settlement.sql` stores immutable reviews, terminal settlement records, observed output and unique remainder links.

The shared treasury ABI and company-scoped state require a fresh matching shared treasury deployment. Existing isolated immutable treasuries need an explicit reviewed migration; their balances are never silently promoted into shared company ledgers. Automated fixtures cover amount bounds, final review binding, source cost preservation, fresh recipient approval, payroll and invoice replacements, and client principal conservation. They use simulated provider and NEAR evidence and do not establish live settlement.
