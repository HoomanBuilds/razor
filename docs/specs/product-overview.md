# Razor product overview

Status: product specification. Updated 12 November 2026.

## Product

Razor helps a company manage what it owes, approve how it is paid and know what actually settled.

A company can fund its workspace with one or several supported assets, maintain employee and contractor payment obligations, pay suppliers, and reconcile the results. Recipients choose a preferred payout asset and network, plus an authorized USDC backup destination. Company financial records remain restricted to the people entitled to see them.

Any new user can start through familiar social or email sign-in, or supported wallet authentication. A payer can create a company and prepare work before funding it, connect an existing wallet when needed, and choose either to top up the treasury or fund a specific approved payment.

## Customer and problem

The initial customer is a crypto-paid business, agency or international team that pays employees, freelancers, contractors and vendors.

Its operating problems are fragmented treasury balances, repeated manual transfers, recipient preferences across networks, uncertain payment status, duplicate-payment risk and reconciliation across invoices, salaries and receipts.

One company can use Razor with its existing recipients. Participation in a business clearing network is optional.

The adoption hypothesis is that one approved payment workflow with reliable receipts, private records and recipient preferences is worth replacing part of the customer's spreadsheets and wallet operations. This remains a hypothesis to test with actual company records and a pilot.

## Product principles

1. Fund with supported assets; settle obligations in an explicit unit; deliver to an approved recipient preference.
2. Keep confirmed cash, client reserves, commitments, payment reservations and available operating money distinct.
3. Bind every payment to an obligation, approval, recipient profile version and permitted cost.
4. Use a recipient's authorized USDC backup when the primary route cannot safely complete.
5. Track each funding leg and payout independently through confirmation or recovery.
6. Give agents constrained financial jobs and enforce their limits outside model output.
7. Keep private documents and salaries out of public transaction data and application logs.
8. Show the actual route and receipt used, including backup usage and unresolved outcomes.

## NEAR infrastructure boundary

| Service | Product responsibility |
| --- | --- |
| NEAR accounts and smart contracts | Company ownership, approved obligations, reservations, payment authorization, policy enforcement and optional clearing rules |
| NEAR Intents and 1Click | Supported funding conversions, payout quotes, cross-chain execution and route-status integration |
| NEAR AI Cloud | Private invoice and expense extraction, anomaly explanations and preparation of financial actions under verified inference policies |
| NEAR meta transactions | Sponsored, restricted recipient actions on NEAR, such as approved onboarding or claim operations where required |
| NEAR ecosystem attested execution, where used | Constrained agent custody or private computation with explicit, verified trust boundaries |

Application financial authority stays in NEAR infrastructure. External networks are used only as funding or receiving endpoints through NEAR Intents. The product does not depend on deploying its own payroll contracts on other chains or introducing a second blockchain payment stack.

Private application storage and the web interface support the product; they must not become an unrestricted money-moving authority. Exact custody and approval-to-execution bindings need technical validation before real funds are handled.

An authentication provider may simplify identity and wallet access without replacing NEAR as the financial infrastructure. Provider choice must support the required NEAR account ownership, signing and recovery behavior, not just a successful Google login.

## Roles

| Role | Intended authority |
| --- | --- |
| Company owner | Manage workspace, treasury policy, authorized approvers, agent permissions and emergency pause |
| Finance preparer | Import recipients, enter bills, prepare pay runs and reconcile records within assigned access |
| Approver | Accept or reject the exact obligations, payout terms and cost limits assigned to that role |
| Employee | Manage personal payout preferences, confirm backup consent and view personal payment records |
| Contractor or freelancer | Submit invoices or milestone payment requests and view personal approvals and receipts |
| Supplier contact | Maintain its authorized invoice and receiving details |
| Accountant | Read explicitly shared financial records and export reconciled activity |
| Agent | Prepare or execute only the actions authorized by its mandate; identify itself in the activity record |

A small company may assign several roles to the same person. The owner's policy determines when separate approval is required. An internal role name alone does not grant control over onchain money.

## Core journeys

### Arrive, sign in and create a company

The public entry point offers Google or email sign-in and a supported wallet-first path. A new payer needs no invitation or manual operator approval to create a workspace. Ask only for the company details needed to start, apply editable USDC and time-zone defaults, and show a resumable setup guide.

The payer can add recipients, invite finance staff and draft an obligation before funding. Connect a wallet or establish the social user's NEAR-capable signer when a financial action requires it. The interface distinguishes a ready draft from an authorized, funded payment.

The same user may belong to several companies. Account linking requires verified control, and switching companies never carries another company's approval or funds into the active workspace.

### Connect an existing wallet or use social onboarding

Crypto users can connect a supported NEAR wallet and supported external funding wallets. Show the account, network and purpose of each wallet. Let the payer choose the source for each top-up or payment rather than silently spending from the last connected account.

Social users need a supported NEAR signing and recovery path, with sponsored setup where configured. A social identity, an external source wallet and the company treasury are separate roles. An organization member still needs the applicable approval authority before moving company funds.

Wallet rejection, a wrong network or a disconnect leaves a recoverable draft and a clear next action. Connecting a wallet does not require sharing a seed phrase or granting blanket access.

### Fund the company

The owner selects an amount and supported source asset. Razor displays the conversion, fees, expiry and refund destination. A multi-asset top-up contains separately tracked funding legs. Only confirmed destination credits increase the funded settlement balance.

The default top-up converts to USDC under terms the owner approves. Original-asset holdings can be offered separately, with their indicative value distinguished from USDC reserved for payment obligations.

### Pay from a connected wallet

The payer chooses an approved bill or pay run and selects a source wallet and asset. Razor quotes funding for that obligation, obtains the required source-wallet authorization, confirms the resulting company funds and executes the approved payout through the NEAR payment workflow.

The interface presents one guided task with separately tracked funding and payout legs. A completed top-up followed by an unavailable payout leaves funds attributed to the original obligation for recovery or permitted backup; it does not prompt another full payment. Costs and any returned excess remain visible.

### Set up recipients

The company invites an employee, contractor or supplier. The recipient confirms the primary asset, network and receiving address, then sets up a distinct USDC backup and authorizes when it may be used. Recurring automated payouts require a valid backup. A manual profile without one remains visible as incomplete for automatic recovery.

Defaults are suggestions until confirmed. Razor must not infer a network from an EVM address or copy an address to another chain without confirmation.

### Run payroll

Finance creates a pay period, imports or enters approved amounts, reviews exceptions, reserves funds and submits the run for approval. The approver sees recipients, profile versions, total obligations, maximum fees and permitted fallback behavior. The scheduler executes due payments and reports each result independently.

### Pay contractors and suppliers

A recipient submits an invoice or agreed milestone request. Private AI produces a draft extraction for review. Finance confirms the obligation, checks duplicates and acceptance conditions, approves payment and follows the same execution and reconciliation workflow as payroll.

### Recover an unavailable payout

Razor prefers the approved primary route. If it is unavailable before execution, or a prior attempt is conclusively closed without delivery and the necessary funds are available again, Razor may use the authorized USDC backup within the approved cost ceiling. An uncertain or still-processing transfer remains held for reconciliation.

### Clear mutual business invoices

Participating companies may agree to offset compatible, accepted obligations. Each approves the exact clearing changes before they take effect. Razor settles and reconciles the remaining payments. Employee wages and contractor compensation are not silently included in business netting.

## Product defaults

| Decision | Default |
| --- | --- |
| Settlement amounts and payroll reserves | USDC |
| Recipient primary asset | USDC, with the recipient explicitly choosing a supported network |
| Backup asset | Native, Circle-issued USDC |
| Suggested backup network | Base, if distinct from the primary; suggest another enabled network when necessary |
| Backup authority | Recipient consent plus company approval and fee limits |
| Route and execution costs | Paid by the company; target the agreed net recipient amount |
| Unsupported or ambiguous payout | Hold the obligation and explain the next required action |
| Business netting | Optional participation and per-round consent |
| Financing | Separate later extension |

See [payouts and fallback](payouts-and-fallback.md) for the complete rules.

## Main product surfaces

Sign-in and Onboarding, Overview, Treasury and Connected Wallets, People and Payees, Payroll, Bills and Invoices, Approvals, Payments, Business Netting, Reports, Agent Activity and Settings.

Each surface should lead to an operating decision: what needs funding, who needs approval, which payment needs attention, what was delivered or what money is available. Technical identifiers belong in receipt details when they help investigation.

## Onboarding integration choice

The required outcome is familiar login plus functional NEAR signing, connected source wallets and recoverable ownership. Privy or a similar provider is a candidate; the brand is not a requirement. Privy's documentation describes Google and other OAuth login methods. [Privy OAuth](https://docs.privy.io/authentication/user-authentication/login-methods/oauth).

NEAR Auth is another candidate: its documentation describes social login, NEAR signing and gas sponsorship. It currently requires approved production credentials for mainnet, so availability must be established before selecting it for public production onboarding. [NEAR Auth documentation](https://docs.auth.near.org/).

Before committing to a provider, demonstrate a new user login, a real NEAR-authorized action, a linked external-wallet funding flow, return login and access recovery. A provider's login screenshot or general chain-support claim is insufficient integration evidence.

## Scope boundaries

Payroll means payroll payment operations and payment records. Tax calculation, statutory filing, employer-of-record services and fiat bank payouts require separate products or integrations.

Confidential application data does not imply every blockchain transfer is hidden. Confidential settlement is claimed only for verified supported routes. Reserved company payment funds are not allocated to speculative trading or yield strategies.

The product's optional netting does not require a lending marketplace. Financing would need enforceable claims, capital providers, loss allocation and repayment handling before inclusion.

## Success measures

Measure completed and reconciled obligations, on-time payout completion, confirmed backup recovery, unresolved payment age, duplicate-payment prevention, manual exception work and company cost per completed payout. For netting, report eligible invoice value discharged and actual residual transfers separately.

An attractive interface or a large indicative multi-asset balance is not evidence that payroll completed.
