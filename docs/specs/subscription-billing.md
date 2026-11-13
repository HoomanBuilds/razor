# Subscription billing

Status: implementation specification. Company subscriptions pay for operating software. Razor's payment-principal markup stays zero.

## Plans and rollout

Store immutable plan versions in SQLite with an operator workflow to publish or retire versions. Initial pilot defaults are Free at 0 USDC, Pro at 29 USDC and Business at 99 USDC per calendar month and company workspace. These are versioned pilot offers, not a claim that the prices have been validated commercially.

All plans preserve manual payments, financial authorization, recipient access, existing records, exports, monitoring, pause, recovery and withdrawal. Paid features are new batch payroll, recurring automation, private AI and business clearing proposals. Reading and completing existing obligations and recovering an existing round stay available after a plan ends.

Initial bounded allowances are Free with 3 finance seats and no private AI, Pro with 10 finance seats and 50 private-AI attempts per usage period, and Business with 50 finance seats and 500 attempts. Operator-published versions can revise future offers. Existing members are never revoked automatically on downgrade; only new capacity is restricted.

Use an explicit pilot/enforced rollout setting. Pilot mode preserves the existing operating workflows with the bounded Pro allowance and visibly identifies its complimentary access. Enforced mode uses the company's verified paid period or Free. A rollout setting does not manufacture paid invoices or revenue.

## NEAR collection

Collect subscription USDC in a dedicated NEAR billing contract, separate from company treasuries. Mainnet accepts only canonical native USDC. Testnet uses a separately configured test token and remains labeled as test evidence. Checkout requires a verified linked payer wallet, actual contract/code/config verification and explicit review of price, period, network, recipient and gas.

The server signs a short-lived invoice offer using a dedicated quote issuer key that has no authority over customer wallets. The contract accepts that signed offer through ft_transfer_call, binds the exact invoice, payer, amount, network and contract, records one payment per invoice and returns duplicate or excess funds. It never pulls funds or debits payroll. Failed or expired offers return funds through the token resolver.

Grant paid access only from final verified NEAR invoice state and the matching code/terms. A wallet transaction hash, optimistic interface state or generic token transfer is insufficient. Preserve pending/unknown attempts durably and resume the same invoice. Lost callbacks and stale quotes must remain recoverable without duplicate collection.

## Subscription lifecycle

Freeze plan version, price, scope and terms on every invoice. Use explicit manual renewal; never silently sign recurring charges. A new paid period starts at confirmed activation, while early renewals extend paid access without resetting the current usage allowance. Upgrades use a disclosed prorated incremental price and preserve the current usage window. Downgrades take effect after prepaid access ends. Cancellation preserves already paid access and existing financial work.

Concurrent or stale purchases must record the actual received funds and provide a recoverable credit/refund outcome instead of discarding payment or granting conflicting periods. Refund requests are company-owner scoped. An operator prepares an owner-signed billing-contract refund to the original payer. Only final onchain refund state completes a refund; no server owner key or optimistic refund status is accepted.

## Authorization and metering

The actual company owner manages subscriptions, invoices and cancellation. Other company users can inspect their own applicable capabilities without seeing private billing records. Enforce paid operations and limits in service methods and workers, not just the UI. Require the existing financial permissions as well as commercial entitlement.

Reserve private-AI capacity atomically before dispatch, after validating input and provider setup. Include failed dispatched attempts in the disclosed attempt limit; setup failures do not consume allowance. Count invoice analysis and finance planning together. Track usage by a stable period identity so retries, upgrades and parallel workers cannot reset or exceed limits. Keep retention, deletion and access to earlier evidence available independently of plan state.

## Company interface and operations

Provide company-owner billing controls with plan comparisons, explicit pilot/setup state, current period, scheduled changes, usage, invoices, exact checkout review, linked signer choice, resume/status actions, cancellation, refund requests and downloadable receipts. Other finance screens explain an unavailable commercial action and direct the user to the owner without hiding existing financial records.

Provide a local operator CLI for versioned catalog administration, billing status, refund preparation and reconciliation. Validate configuration through the existing setup checker. Never print private issuer keys or sign/send as the operator by default.

Verification includes company/owner isolation, immutable invoice terms, double-payment protection, finality, refunds, period boundaries, proration, downgrade safety, atomic quotas, worker enforcement, browser flows and unchanged access to financial recovery. Local fixtures and testnet results remain separate from live subscription revenue.
