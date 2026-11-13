# Payout preferences and USDC backup

Status: product requirements. Updated 12 November 2026.

## Purpose

A recipient can prefer a supported payout token and network while authorizing a practical USDC backup. Razor uses that backup when the primary route cannot safely complete under the approved terms. Backup payments remain routed through NEAR Intents.

This is destination fallback within the NEAR payment workflow. It is not a guarantee that another provider will be available during an Intents outage.

## Recipient profile

| Field | Meaning |
| --- | --- |
| Primary token | The recipient's preferred payout asset; default USDC |
| Primary network | The explicitly selected destination network |
| Primary address | The recipient-confirmed destination on that network |
| Primary metadata | Any destination details required and supported by the route |
| Backup token | Native, Circle-issued USDC |
| Backup network | One recipient-selected network from Razor's enabled curated choices |
| Backup address | A separately confirmed compatible USDC receiving destination |
| Fallback consent | Whether the recipient permits automatic backup use under the displayed conditions |
| Profile version | The exact receiving preferences and consent accepted for a payment |

The primary and backup must differ by token or network. A duplicate destination is not presented as a working backup. If the primary is already USDC on Base, suggest another enabled network, such as Arbitrum, and obtain confirmation.

Recurring automated payment profiles require a valid distinct backup and fallback consent. A recipient may retain a manual-only profile without one; unavailable payments on that profile require resolution rather than automatic substitution.

Confirm that the recipient can receive the exact token on the selected chain, including any supported custodial deposit restrictions. Address syntax alone does not establish ownership, chain support or exchange deposit acceptance. Do not copy an EVM address across chains without the recipient confirming the destination on each chain.

## Backup network policy

Suggest USDC on Base as the starting backup choice. Offer a small reviewed set rather than every network in the routing catalog.

Candidate choices are Base, Arbitrum, Polygon PoS, Solana, Ethereum and NEAR. These are product choices to validate at integration, not a frozen runtime catalog or a guarantee that all routes will be enabled at launch. Ethereum remains subject to the company's quoted cost limit.

An enabled backup must satisfy all of the following:

1. The chain and exact asset are supported by the current Intents integration.
2. The asset matches Circle-issued native USDC on that network, rather than relying on a token symbol or substituting a bridged representation.
3. A live executable quote supports the amount and receiving destination within the mandate.
4. The network is operational under Razor's current availability policy.
5. The recipient has confirmed the network and address, and the company has approved its use.

Circle publishes native USDC identities for these chains. Razor must match current routing assets to those identities. [Circle USDC reference](https://developers.circle.com/stablecoins/usdc-contract-addresses). NEAR Intents publishes chain support and uses an asset catalog and quotes to establish route availability. [Supported chains](https://docs.near-intents.org/resources/chain-support).

Saved destinations do not silently migrate when the enabled choices change. A disabled backup becomes unavailable and prompts an authorized update.

## Payment terms and recipient amount

Default obligations are denominated in USDC. A 1,000 USDC obligation may be delivered as 1,000 USDC, or converted into the recipient's approved preferred asset under agreed quote terms. A backup delivers the same 1,000 USDC entitlement, with quoted costs covered by the company within its approved ceiling.

If an obligation is denominated in another token, such as a fixed BTC quantity, automatic USDC fallback requires an explicit conversion rule and valuation time accepted by the parties. Without that agreement, hold the payment and request revised terms. Token preference and contractual entitlement are separate fields.

The company approval binds the obligation, net entitlement, primary and backup profile versions, fallback permission, expiry and maximum total cost. Costs already incurred by a failed attempt count toward that ceiling. A backup cannot silently reduce pay or expand the company's approved debit.

## Decision rules

| Condition | Required action |
| --- | --- |
| Primary has a valid permitted route | Execute the primary |
| Primary quote expired before commitment | Refresh the primary within its mandate; use backup only if the allowed unavailability condition is established |
| Primary token or network unsupported before commitment | Use the confirmed backup if all consent, funding and cost conditions pass |
| No executable primary route within the permitted cost or execution window | Use the confirmed backup when the mandate explicitly permits this condition |
| Primary already signed, submitted, processing or otherwise capable of execution | Continue monitoring and prevent a second payout |
| Primary result unknown, status endpoint unavailable or evidence contradictory | Hold for reconciliation; elapsed time alone cannot trigger backup |
| Primary successfully delivered | Close the obligation; never execute backup for the same entitlement |
| Primary conclusively closed without delivery | Establish that its authorization cannot execute, reconcile actual costs and confirm available funds before considering backup |
| Provider reports a refund | Verify the actual recovery and remaining reservation before considering backup |
| Any partial delivery | Reconcile the actual entitlement satisfied; require explicit resolution before another payment for the remainder |
| Company funds insufficient | Request funding; do not reduce the obligation or treat another asset as free money |
| Backup unavailable, invalid or over budget | Hold and request a confirmed destination, additional funds or appropriate approval |
| Recipient profile changed after approval | Revalidate the unexecuted payment and obtain any required reapproval |
| Company pause or relevant mandate revoked | Stop new attempts and continue reconciling existing ones |

The system must establish that no earlier attempt can still deliver before starting a new payable attempt. A provider failure label or an application timeout does not by itself prove that funds have returned or that a signed action cannot execute later.

If neither destination is available, the obligation stays unpaid and visible. Razor does not choose a third chain, invent a wallet or pay a different token without authorization.

## Execution and recovery model

Every invoice installment or pay-period item has one logical payment identity. Each primary or backup execution has its own attempt identity, quote, source reservation and delivery evidence.

| Product state | Meaning |
| --- | --- |
| Draft | Obligation or receiving details still need preparation |
| Awaiting approval | Exact terms have not yet been authorized |
| Ready | Terms and available funds permit evaluation for execution |
| Quoting | A primary or permitted backup route is being checked |
| In flight | A committed attempt may still deliver |
| Recovery pending | A failed, uncertain or refundable attempt needs reconciliation |
| Held | Funding, destination, consent, cost or policy prevents a new attempt |
| Paid | Confirmed delivery satisfies the entitlement; record whether primary or backup was used |
| Cancelled | The unexecuted obligation was cancelled under its terms; no active attempt can still deliver |

These are product concepts, not a finalized database enum. Provider statuses must be mapped into them using execution and receipt evidence rather than a name-only mapping.

Concurrent workers, duplicate callbacks, schedule retries and service restarts must not produce overlapping payable attempts. A partly completed pay run resumes only its unresolved items.

The provider refund address is company-controlled recovery information. It is distinct from the recipient's USDC backup address: an input-asset refund does not itself satisfy the employee's or supplier's payment entitlement.

The Intents status API exposes execution, destination transaction and refund details. Those are integration inputs for reconciliation, not permission to issue an immediate replacement payment. [Execution status reference](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status).

## User experience

During onboarding, explain that the backup receives USDC, identify the network and ask the recipient to confirm the destination and consent. Keep the primary and backup clearly distinguishable.

During pay-run approval, show which recipients are primary-ready, likely to require backup, missing consent or blocked. The approver sees the maximum permitted cost and recipients' confirmed profile versions.

When backup is used, notify the recipient and company of the reason, actual USDC amount, network, destination and receipt. A hold message identifies the action needed, such as confirming a backup or waiting for refund reconciliation.

Use neutral descriptions of availability. Do not promise that a popular network or stablecoin will always be reachable. Internal details such as provider status codes belong in expandable receipt or support details.

## Example

A contractor is owed 1,000 USDC and prefers an equivalent amount of a supported token. The contractor has authorized USDC on Base as backup. The company approved a maximum total debit of 1,008 USDC.

The primary route is unavailable before any executable authorization or funds are committed. A permitted backup quote delivers 1,000 USDC for a total company cost of 1,002.40 USDC. Razor executes it, confirms receipt, records 2.40 USDC of costs and releases the remaining 5.60 USDC of the reserved ceiling.

These costs are illustrative rather than market quotes. If the primary were already processing, this example would stop at monitoring rather than immediately sending the backup.

## Acceptance scenarios

1. An unsupported primary asset before execution results in one authorized USDC backup payout.
2. A valid primary route is preferred over backup even when backup would be cheaper, unless the recipient's mandate explicitly allows cost-based selection.
3. A pending primary and a delayed status response produce no backup transfer.
4. A completed primary followed by a duplicate failure notification produces no second payout.
5. A refunded attempt with unreconciled funds stays in recovery; confirmed recovery can enable a permitted backup.
6. A receiving-address change after approval cannot redirect an already approved payment silently.
7. An over-budget backup or insufficient balance results in a visible hold without reducing recipient pay.
8. A primary already using USDC requires a different approved network to establish a distinct backup.
9. A service restart resumes an existing attempt instead of creating another one.
10. A partial receipt is reconciled before any payment for the remaining entitlement.
11. An unavailable Intents service cannot trigger an unapproved direct-chain or alternate-provider transfer.
12. A recipient without a verified backup cannot enter an automatic recurring payment mandate; manual payment remains possible with explicit exception handling.
