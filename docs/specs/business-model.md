# Razor business model

Status: subscription billing is implemented in source with versioned pilot offers. The 29 and 99 USDC prices require commercial validation. Live collection requires a configured and verified NEAR billing deployment.

## Customer and revenue

Razor serves crypto-funded businesses that pay employees, contractors and suppliers across supported networks. Companies pay for the finance workflow: preparing payroll, recurring operations, reviewing invoices privately, reconciling outcomes and coordinating finance staff.

The primary revenue source is an optional company software subscription. Razor's platform percentage markup on payment principal is zero. Personal recipient accounts, receiving records and basic occasional company payments remain free of Razor platform charges. Network, routing and any separately chosen cash-out costs still apply.

## Pilot plans

| Plan | Working monthly price | Commercial purpose |
| --- | --- | --- |
| Free | 0 USDC | Recipient access, invoice submission, manual company payments and 3 finance seats |
| Pro | 29 USDC per company workspace | Batch payroll, recurring workflows, new clearing proposals, 10 finance seats and 50 private-AI attempts per period |
| Business | 99 USDC per company workspace | The same commercial features, 50 finance seats and 500 private-AI attempts per period |
| Enterprise, later | Agreed subscription and metered services | High-volume operations, integrations and support priced from observed costs |

Paid tiers monetize automation and operating capacity. Core ownership, permissions, required payment approvals, cost ceilings, pause, recovery, withdrawal and access to existing receipts remain available regardless of subscription state. A recipient never needs a paid company plan to receive the agreed payment or inspect their own records.

Validate allowances against measured compute, storage, authentication, verification and support costs. These prices do not promise unlimited AI, unlimited support or free cross-chain execution. Default pilot mode grants bounded complimentary Pro access. Enforced mode applies the paid period or Free plan. Changing mode does not charge a wallet or prove revenue. Existing financial records and reconciliation stay available on every plan.

## Fee policy

- Show the agreed net recipient entitlement, quoted funding/payout costs and any subscription charge separately.
- The company pays approved execution costs. Never collect a software subscription by reducing employee or contractor entitlements.
- Keep subscription billing separate from treasury deposits, client reserves, payment reservations and recipient funds.
- Preserve the zero Razor percentage markup across funding and payout; a salary's two transfer legs do not create two Razor commissions.
- Compare actual quoted outcomes. A compatibility suggestion is not a guarantee of the lowest fee.
- Use authenticated NEAR Intents access and evaluate partner terms against the customer's complete quote. Revenue sharing is not assumed income and must not silently increase customer costs.
- When beneficial, use existing direct native NEAR USDC delivery and explicitly consented business invoice netting. Discharged debt is not delivered cash or a basis for a payment-volume commission.

The existing Max cost field is a routing/execution budget. It is not a Razor service fee. Razor does not add an Intents appFees percentage. Subscription checkout uses a dedicated NEAR contract and an explicit USDC wallet payment; it never takes money from payroll principal or client reserves.

## Cost and claims

The complete customer cost includes allocated subscription charges, source funding, conversion, payout, gas, recovery costs and any required recipient off-ramp. Compare the same source, destination asset or bank currency, delivered amount, geography and service scope.

The product promise is zero Razor payment markup and transparent execution costs. A universal cheapest-payment claim is unsupported. Crypto delivered to a wallet does not establish a lower price for bank-delivered INR. Bank settlement, entity formation and statutory payroll services require separately defined integrations and pricing before they can be offered.

## Pilot and implementation boundary

Measure per-company operating cost, usage and willingness to pay before publishing final prices or allowances. Collect matched live quotes for representative funding/payout routes and track realized costs separately from estimates. Price optional AI usage from observed inference and verification costs.

Billing implementation must preserve company isolation, versioned commercial terms, explicit payer consent, idempotent charges, invoices and cancellation behavior. A failed or expired subscription must not prevent reconciliation of an existing transfer or recovery of customer money. Plan and price records should have a real persistence/admin consumer; this document is not a runtime pricing manifest.

See the [subscription specification](subscription-billing.md) for frozen invoice terms, manual renewal, proration, cancellation, paid-period safety and shared quotas. The [billing operator guide](../billing-operations.md) covers catalog changes, deployment, refunds and receipt reconciliation. Local tests and compiled contracts do not establish paid customers or mainnet revenue.

Reference pricing and economics are documented in the [NEAR Intents fee guide](https://docs.agentsonintents.com/resources/fees). Final customer execution costs come from the actual quote rather than a copied fee snapshot.
