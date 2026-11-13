# NEAR integration and track alignment

Reviewed against official event materials and linked AI prompts on 12 November 2026. This is a design-to-evidence mapping, not organizer preapproval or a claim that features already work.

## NEAR requirement

The agreed interpretation is NEAR infrastructure throughout Razor, with external-chain funding and receiving endpoints accessed through NEAR Intents.

NEAR accounts and contracts must provide material financial authority, NEAR Intents must execute the supported cross-chain flow, and NEAR AI Cloud must perform the proposed private financial analysis. A wallet connection and branding alone do not satisfy the product's own integration requirements.

## Official eligibility findings

The event's HACKATHON.md permits testnet-only projects, with mainnet used where an integration requires it. Q-011 says there are no mandatory integrations: the listed technologies are hints, and an own NEAR contract fitting the track is sufficient. Multiple tracks can be selected for one project. [Official rules](https://nearhackathon.com/HACKATHON.md).

The linked repository labels the per-track files as starter prompts and allows replacing their example ideas. Those examples inform the quality bar and integration design rather than requiring Razor to become their sample application. [Official prompt repository](https://github.com/nearai/near-hackathon-prompt-examples).

## Target tracks

| Track | Position | Product evidence needed |
| --- | --- | --- |
| Real-World Money (`realworld`) | Primary | A real company obligation, supported-asset funding, approved employee or contractor payout, receipt, refund or hold handling and accountant export |
| Autonomous Business (`business`) | Strong additional target | An agent performs a bounded financial task from preparation through permitted execution; spending policy, owner pause and financial records are enforced |
| Privacy & Private AI (`privacy`) | Additional target when verified | Private financial analysis through NEAR AI Cloud with required attestation actually verified, restricted records and documented retention boundaries |
| AI Security & Defense (`security`) | Conditional | Reproducible attacks against recipient substitution, prompt injection, overspending or duplicate payouts are rejected by the real authorization boundary |
| AI Swarms (`swarms`) | Conditional | Independent company agents coordinate and authorize a clearing round under their own mandates; show real economic consequences and identifiable participants |
| Unstoppable DeFi (`defi`) | Conditional | A substantive onchain clearing or financing mechanism with verifiable financial rules; routing payments through Intents alone is insufficient evidence for our intended claim |
| Agent Economy (`agents`) | Later candidate | Agents actually purchase or sell services and settle counterparties under budgets; ordinary human payroll alone does not establish this feature |

The recommended lead is Real-World Money. Add Business and Privacy only with working evidence of their defining behavior. Do not select conditional tracks solely because the interface contains an agent label, a security setting or an Intents button.

## What the linked AI prompts say

### Real-World Money

The example is a freelancer invoice link accepting clients' existing tokens and chains, with USDC received on NEAR. It emphasizes invoice details, a restricted gas sponsor, honest payment states and an accountant-readable export. Razor expands those operating needs to company payroll and supplier bills. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/08-realworld.md).

Required Razor demonstration: create an invoice or payroll obligation, fund it, approve the payment, deliver to a confirmed recipient preference and export the reconciled record. Include a separate backup case and show where the funds actually went.

### Autonomous Business

The sample runs a report-selling agent with inference spending limits, revenue rules, protected credentials, an owner stop control and records of sales, costs and payouts. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/04-business.md).

Razor should show a company agent preparing and executing an approved pay run or recurring bill within a mandate. It must refuse a changed destination or unauthorized amount and remain revocable. A manually operated payment form alone does not establish this planned automation.

### Privacy & Private AI

The example privately analyzes expenses on NEAR AI Cloud, verifies fresh attestation, exposes the checks and supplies fictional documents. Its zero-retention example is narrower than a business product that needs stored payroll records. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/03-privacy.md).

Razor must define which records are retained with authorization, which temporary inputs are deleted and who can access them. Verify the actual inference evidence and demonstrate a failed-verification path. Do not claim zero storage when financial records are retained or complete monetary privacy when transfers remain public.

### AI Security & Defense

The example checks counterparties and refuses blocked actions, escalates warnings and demonstrates an injected agent being stopped. It also requires explaining scoped-key limits. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md).

Razor's relevant evidence is an injected invoice or forged recipient change failing to redirect an approved obligation, plus rejection of a duplicate payout and an over-budget attempt. Access-key gas allowance is not a token spending limit; enforce payment budgets in the financial authorization logic. [NEAR access-key semantics](https://docs.near.org/protocol/accounts-contracts/access-keys).

### AI Swarms

The starter uses distinct buyer and seller agents, sealed bidding, identifiable subaccounts, explicit round rules and a reproducible scripted simulation. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/05-swarms.md).

Razor may apply the coordination principle to independent businesses accepting or refusing a clearing plan under separate policies. A single optimizer with several animated agent cards is insufficient for this proposed claim. Netting remains useful without presenting it as a swarm.

### Unstoppable DeFi

The example is a scheduled cross-chain vault with quotes, slippage controls, visible custody, recovery states and a dry run. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md).

Razor should claim this track only if the clearing or separately developed financing protocol is substantive and reproducible. Employee payment routing is the Real-World Money feature, not evidence that Razor has built an exchange or lending market.

### Agent Economy

The sample agent decomposes a paid task, procures services, negotiates quotes, verifies output and issues receipts within a budget. [Official prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md).

An eventual service-procurement extension could support this track. It is not needed to complete company payroll and should not expand the present core scope without a specific user outcome.

## Integration evidence and factual corrections

NEAR Intents has no official testnet. Some starter examples request a testnet loop, but that does not create a testnet version of Intents. Separate NEAR contract tests, real dry quotes, simulations and actual mainnet settlements in every demonstration. [Official Intents quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction).

NEAR AI's current verification flow distinguishes fresh gateway evidence, model evidence, request bindings and response signatures where available. Fetching a report is not verification; document the checks required by Razor and their actual result. [NEAR AI verification](https://docs.near.ai/cloud/verification).

Meta transactions can sponsor permitted NEAR actions. They do not make every source-chain funding transaction free or guarantee a recipient never needs gas for future unrelated activity. The company pays its approved execution costs explicitly.

Confidential Intents is an optional verified settlement capability. Ordinary private document processing does not hide public contract state or external-chain transfers. Backup USDC on a public receiving network retains that network's visibility.

## Evidence package

The eventual repository and demo should make the following reproducible:

1. A funded company payment from preparation to confirmed receipt or explicit recovery.
2. A recipient-confirmed USDC backup used exactly once when the primary is unavailable.
3. A pending or ambiguous primary transfer that does not trigger another payout.
4. A bounded agent action, an owner pause and rejected unauthorized execution.
5. A private analysis with verification results and fictional sample inputs.
6. An accounting export that connects entitlement, costs, attempts and final outcome.
7. If optional netting is claimed, preserved net positions, per-party consent and correctly settled residuals.

Track claims should follow demonstrated behavior. Final eligibility and awards remain the organizers' decision. Publication and submission are separate from preparing these product documents.
