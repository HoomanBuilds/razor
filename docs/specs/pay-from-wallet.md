# Pay an approved obligation from a wallet

Razor keeps source funding and recipient delivery attached to the same approved payment. Approved bills and individual obligations from approved pay runs use this task through the payment queue. General treasury top-ups remain separate.

The task shows recipient entitlement, approved routing allowance, incurred costs, existing reservation, company cash, verified incoming USDC, linked cash holds and remaining funding need. It quotes exact output for that remaining need into the company's configured native-USDC NEAR mainnet treasury. Source-network gas is separate.

## Funding and reservation

- Source assets come from the live NEAR Intents catalog. A successful signed quote is still required for actual liquidity.
- A verified connected wallet can fund the quote. Other source networks can use a personal recovery address and the exact manual deposit instructions, including a required memo.
- Existing company cash is committed atomically before requesting a quote. Final linked receipts and that commitment are excluded from unrelated payment approvals, client earmarks and withdrawals.
- A preparer may exchange these holds and an existing matching client earmark for the exact previously human-approved reservation. This does not approve a new liability or change approved terms.
- The task keeps one active funding quote per obligation. A stable request identifier resumes its persisted quote; changed source or liability terms cannot reuse that identifier.
- Frozen source token metadata allows existing routes and source refund evidence to remain understandable if an asset later leaves the catalog.

## Resume and settlement

The task reopens from server-persisted funding claims, source legs, receipts and payout attempts. It checks the receiving profile version and the approved underlying invoice or pay run before authorizing new source funding.

A source signing claim is saved immediately before invoking a wallet transfer. The source hash is recorded after broadcast. Unknown outcomes retain that claim and block another deposit. A hash recovered from a wallet or exchange can be recorded on the same leg.

Provider success, a final NEAR token receipt, the shared treasury's exact company credit and recipient delivery are distinct stages. Provider success alone creates no linked credit. A final receipt can precede the contract's refreshed token balance. In that case the task offers an explicit wallet call to `refresh_balance` and reconciliation instead of another deposit. This refresh is blocked while a treasury source callback remains unresolved.

Once reserved, the same task uses the staged NEAR preparation, approval quorum and execution flow. It can review the recipient's consented USDC backup, subject to the existing route failure and network rules. Failed payout recovery retains the same approved budget; source costs already incurred reduce the remaining allowance.

## Source closure and excess

Only an expired, never-claimed source quote with no source hash can be closed as unsent. The user must confirm that no transfer was submitted and the current signed provider response must still report `PENDING_DEPOSIT`. Replacement requires a separate deliberate quote request.

Closed unsent legs remain in history. An explicit reconciliation may discover authoritative late source activity and reopen tracking. A known late source hash also blocks another funding claim. Manual transfers made outside Razor may require this explicit reconciliation because closed quotes are not polled indefinitely.

`refunded_verified` records verified source-chain refund evidence. `refunded_attested` records a distinct authorized human attestation. Neither creates company USDC credit, and neither is silently overwritten by ordinary receipt reconciliation. The Treasury refund workflow retains their evidence.

Only the remaining approved liability is held. Excess and released allowance stay company cash, while their original source history remains attached to the obligation. Cancellation closes the liability and releases its linked cash hold while retaining transfer history.

## Evidence and operational limits

Focused local checks cover exact remaining funding, failed quote signatures, reservation conservation, preparer permissions, stale balances, saved unknown source claims, idempotency, client earmarks, changed recipient terms, payout refunds, excess and late source activity guards. They use read-only RPC fixtures and do not demonstrate live money settlement.

If a wallet rejects or crashes after the persisted signing claim without returning a hash, the task conservatively keeps the source outcome unknown. It cannot use the never-sent quote shortcut. Recover the wallet's transaction evidence or use an explicit reviewed recovery process; the task does not silently clear that claim. Live wallet, Intents, NEAR receipt and approval behavior still require configured infrastructure and live transaction evidence.
