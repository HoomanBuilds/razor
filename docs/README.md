# Razor product documentation

Razor is a company payments and payroll platform built on NEAR. Companies fund it with supported assets, manage employee and contractor obligations, approve spending, and pay recipients in their preferred supported asset and network. USDC is the default settlement and backup payout asset.

New users can sign in through familiar social or email methods, create a company without an invitation and connect their existing wallets to fund the treasury or pay an approved obligation. NEAR financial authority remains explicit throughout onboarding.

NEAR provides the application contracts, accounts and financial controls. Cross-chain funding and payouts use NEAR Intents. Private financial document analysis uses NEAR AI Cloud. External networks are payment endpoints, not separate application deployments.

| Document | Contents |
| --- | --- |
| [Build checklist](build-checklist.md) | Reusable verification checklist for onboarding, wallets, every feature ID, recovery scenarios and selected track evidence |
| [Product overview](specs/product-overview.md) | Customer, product promise, roles, workflows, scope, NEAR services and product defaults |
| [Business model](specs/business-model.md) | Subscription strategy, zero payment markup, versioned pilot prices and billing boundaries |
| [Subscription billing](specs/subscription-billing.md) | Company plans, signed NEAR checkout, subscription periods, safe entitlements and shared usage |
| [Billing operations](billing-operations.md) | Catalog administration, deployment, issuer keys, refunds and reconciliation |
| [Feature catalog](specs/features.md) | Required behavior and acceptance criteria for each product area |
| [Payout preferences and USDC backup](specs/payouts-and-fallback.md) | Recipient choices, supported backup networks, consent, fallback decisions and recovery |
| [Receiving metadata](specs/recipient-destinations.md) | Validated address families, XRP tags and unsupported destination metadata |
| [Account notifications](specs/notifications.md) | Personal/company updates, optional email preferences and honest provider acceptance |
| [Project reporting](specs/project-reporting.md) | Classified receipts, client-fund protection, costs, commitments and cost-center views |
| [Pay from wallet](specs/pay-from-wallet.md) | Resumable obligation funding, linked cash, shortfall quotes and payout recovery |
| [Partial payout recovery](specs/partial-settlement.md) | Explicit partial delivery, original liability retirement and separately approved remainders |
| [Source funding refunds](specs/funding-refunds.md) | Exact original-asset recovery, final receipts and explicitly distinguished human attestations |
| [Retained assets](specs/retained-assets.md) | Separate NEAR token holdings, owner controls and indicative valuations |
| [Business clearing](specs/business-clearing.md) | Exact company consents, conserved setoff and residual payments |
| [Implementation status](specs/implementation-status.md) | Integrated features, local evidence and remaining live gates |
| [Company operations](specs/operations.md) | Recurring drafts, bounded execution, worker setup and recovery |
| [Private inference](specs/private-inference.md) | NEAR AI Cloud verification, privacy boundaries and retained draft handling |
| [NEAR track alignment](specs/near-track-alignment.md) | Official prompt findings, target tracks and evidence needed to support each track |

These documents describe the intended product. They do not claim the features have been implemented or integrations tested. The features are organized by product responsibility, without using the hackathon deadline to reduce their depth.

The core product works for one company. Business invoice netting is an optional feature. Receivable financing is a later extension with separate credit and collateral requirements.

