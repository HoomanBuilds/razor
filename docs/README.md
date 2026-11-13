# Razor product documentation

Razor is a company payments and payroll platform built on NEAR. Companies fund it with supported assets, manage employee and contractor obligations, approve spending, and pay recipients in their preferred supported asset and network. USDC is the default settlement and backup payout asset.

New users can sign in through familiar social or email methods, create a company without an invitation and connect their existing wallets to fund the treasury or pay an approved obligation. NEAR financial authority remains explicit throughout onboarding.

NEAR provides the application contracts, accounts and financial controls. Cross-chain funding and payouts use NEAR Intents. Private financial document analysis uses NEAR AI Cloud. External networks are payment endpoints, not separate application deployments.

| Document | Contents |
| --- | --- |
| [Build checklist](build-checklist.md) | Reusable verification checklist for onboarding, wallets, every feature ID, recovery scenarios and selected track evidence |
| [Product overview](specs/product-overview.md) | Customer, product promise, roles, workflows, scope, NEAR services and product defaults |
| [Feature catalog](specs/features.md) | Required behavior and acceptance criteria for each product area |
| [Payout preferences and USDC backup](specs/payouts-and-fallback.md) | Recipient choices, supported backup networks, consent, fallback decisions and recovery |
| [Receiving metadata](specs/recipient-destinations.md) | Validated address families, XRP tags and unsupported destination metadata |
| [Account notifications](specs/notifications.md) | Personal/company updates, optional email preferences and honest provider acceptance |
| [Project reporting](specs/project-reporting.md) | Classified receipts, client-fund protection, costs, commitments and cost-center views |
| [Company operations](specs/operations.md) | Recurring drafts, bounded execution, worker setup and recovery |
| [Private inference](specs/private-inference.md) | NEAR AI Cloud verification, privacy boundaries and retained draft handling |
| [NEAR track alignment](specs/near-track-alignment.md) | Official prompt findings, target tracks and evidence needed to support each track |

These documents describe the intended product. They do not claim the features have been implemented or integrations tested. The features are organized by product responsibility, without using the hackathon deadline to reduce their depth.

The core product works for one company. Business invoice netting is an optional feature. Receivable financing is a later extension with separate credit and collateral requirements.
