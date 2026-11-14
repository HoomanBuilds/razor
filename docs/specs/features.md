# Razor feature catalog

Status: intended product behavior, not a shipped-feature list. Updated 14 November 2026.

Core features form the company payments product. Optional features can be enabled when a company needs them. Later extensions are outside the initial product definition, independent of the hackathon deadline.

Use the [build checklist](../build-checklist.md) for recurring verification. Every feature ID below has a matching check there; an unchecked item is unverified rather than a claim that implementation is absent.

The separately authorized [competitive feature checklist](competitive-gap-checklist.md) extends this baseline with 22 workstreams and granular acceptance IDs. It covers missing intake and execution workflows, new opt-in authority/privacy/settlement modes, and partner-backed business services. These planned requirements do not change the 97 baseline feature count or establish implementation evidence.

## 0. Self-serve onboarding and wallets

### Sign-in and first use

| ID | Feature | Required behavior |
| --- | --- | --- |
| AUTH-01 | Familiar sign-in | A new payer can sign up and return through Google or a simple email option using a supported provider; no company invitation or existing crypto wallet is required to start |
| AUTH-02 | Wallet-first sign-in | Existing wallet users can authenticate through a supported signed challenge, with domain, nonce, expiry and identity binding; merely connecting an address does not authenticate its owner |
| AUTH-03 | Self-serve company creation | A signed-in user can create a company with minimal details, become its initial owner and review the USDC accounting unit and choose its time zone without manual operator setup; funding and primary payout assets remain selectable in their own workflows |
| AUTH-04 | Prepare before funding | A new company can add payees, draft bills or payroll and preview required funds before connecting or funding a wallet; execution remains gated by actual authority and money |
| AUTH-05 | Account and wallet linking | Link a social identity and one or more wallets through verified control, preserving one user's workspace access without email-only account merging |
| AUTH-06 | Team invitations | Invite by verified email or wallet ownership, accept, expire and revoke organization memberships with explicit roles and access enforced on server and financial actions; archive unused roles while preserving their history |
| AUTH-07 | Organization switching | A user with several companies can switch deliberately; private records, drafts, approvals and funding attribution remain scoped to the active company |
| AUTH-08 | Sessions and return visits | Restore the correct account and company on return; handle logout and expired sessions without losing saved drafts or permitting unauthenticated interactive actions |
| AUTH-09 | Access recovery | Provide a documented identity and signer recovery path, with appropriate fresh authentication for sensitive ownership or credential changes |
| AUTH-10 | Guided onboarding | Persist a setup checklist for company details, treasury authority, payees, funding and the first payment; explain blocked steps and resume after interruption |

Acceptance: a new user can arrive without an invitation or preinstalled wallet, sign in, create a company and prepare a payment. Returning with a linked wallet reaches the same verified identity and authorized workspaces. An invite to one company does not grant access to another.

### Connected wallets and payment authority

| ID | Feature | Required behavior |
| --- | --- | --- |
| WAL-01 | Existing NEAR wallets | Connect a supported NEAR wallet, display its account and network and request only the permissions needed for authorized company actions |
| WAL-02 | External source wallets | Connect supported EVM and Solana source wallets for Intents funding; show the selected account, chain and applicable assets, with explicit deposit instructions for routes without an integrated connector |
| WAL-03 | Multiple linked wallets | Let a payer link, inspect and select multiple wallets without treating their indicative balances as money already held by the company |
| WAL-04 | Social-user NEAR setup | Let a social-login user establish a NEAR-capable signer and owner-controlled company treasury without manually importing a seed phrase; make custody, recovery and any sponsored setup explicit |
| WAL-05 | Signing and transaction preview | Before a wallet action, show its purpose, source account, asset, amount, network, destination and costs; request the required signature or approval without importing the user's private key |
| WAL-06 | Connection and signing errors | Handle unsupported wallets, wrong networks, rejected signatures, insufficient native gas and interrupted connections with actionable messages and preserved drafts |
| WAL-07 | Account changes and disconnect | Revalidate previews and selections after an account or network change; disconnecting does not delete the company or stop monitoring an existing transfer |
| WAL-08 | Separate wallet roles | Distinguish app identity, funding wallets, NEAR company treasury authority, agent permissions and recipient destinations; linking a wallet does not grant it every role |

Acceptance: an organization owner can use an existing wallet for a supported funding or payment flow. A social-login user can reach an authorized NEAR financial action through the chosen integration. Neither route gives the application blanket access to unrelated wallet assets.

## 1. Company workspace and permissions

| ID | Feature | Required behavior |
| --- | --- | --- |
| ORG-01 | Company workspace | Create a company profile, configure its NEAR treasury ownership and display the settlement asset and financial policies |
| ORG-02 | Team roles | Assign preparer, approver and accountant access without exposing salaries or private documents to unrelated staff |
| ORG-03 | Approval policy | Define amount thresholds, approver requirements, recurring mandates and permitted fee limits |
| ORG-04 | Emergency pause | Stop new payment authorizations and agent execution; keep monitoring transfers already in flight |
| ORG-05 | Versioned changes | Preserve the accepted policy and recipient versions attached to each approved payment; changed terms require appropriate revalidation |

Acceptance: a preparer can draft a run but cannot bypass a required approval. Revoking an agent stops new spending and leaves existing transfer monitoring available.

## 2. Treasury and funding

| ID | Feature | Required behavior |
| --- | --- | --- |
| TRE-01 | Supported-asset funding | Allow any live catalog-supported source asset and network; suggest canonical native USDC options for compatibility and possible lower costs without hiding other assets; obtain an executable quote for actual costs. Token and network logos accompany readable names and exact asset identities in selection and review |
| TRE-02 | Multi-asset top-ups | Track several deposits into one company workspace, with separate amounts, quotes, statuses and receipts |
| TRE-03 | USDC settlement balance | Default approved funding conversions to USDC and credit only confirmed net receipts |
| TRE-04 | Financial availability | Separate confirmed holdings, client reserves, commitments, payment reservations, fees in reserve and available operating money |
| TRE-05 | Funding requests | Create a client or internal top-up request with amount, purpose, expiry and settlement tracking |
| TRE-06 | Refund recovery | Record failed or refunded funding attempts and return confirmed recoveries to company-controlled destinations |
| TRE-07 | Cash coverage | Compare upcoming approved obligations and permitted costs with spendable funds; show the shortfall before execution |
| TRE-08 | Original-asset holdings | Optional: retain approved assets and show quantities and indicative values separately from funded USDC obligations |
| TRE-09 | Pay from a connected wallet | Let a payer select an approved obligation and fund its required amount from a connected source wallet through Intents, then execute the NEAR-authorized payout after confirmed funding; link both legs to the same obligation and reconcile excess or refunds |

Acceptance: a pending deposit cannot fund payroll. A company with several assets can complete separately quoted top-ups without treating them as one atomic transfer. Money reserved for one obligation cannot silently fund another. The pay-from-wallet flow handles funding success followed by payout failure without demanding another deposit or paying twice.

Funding choice, primary payout preference and internal USDC accounting are separate. The payer may fund in any supported asset, while the recipient may independently receive any supported primary asset. Asset suggestions must match reviewed native USDC identities against the live catalog and must not guarantee the cheapest route. Backup payouts always remain native USDC on the curated enabled popular networks, with explicit recipient consent.

## 3. Recipients and payout preferences

| ID | Feature | Required behavior |
| --- | --- | --- |
| REC-01 | Recipient directory | Maintain employee, contractor, freelancer and supplier profiles with relationship and payment status |
| REC-02 | Recipient portal | Allow authenticated recipients to confirm their own receiving details and see their own records |
| REC-03 | Primary destination | Store the preferred token, network, compatible address and supported destination metadata |
| REC-04 | USDC backup | Store a distinct confirmed USDC destination on an enabled curated network, with explicit fallback consent |
| REC-05 | Preference validation | Check token identity, network, address format and route availability; distinguish invalid, unavailable and ready profiles |
| REC-06 | Change protection | Version receiving changes, notify relevant parties and revalidate affected unexecuted payments before redirecting funds |
| REC-07 | Import and onboarding | Import recipients by CSV, validate rows, invite recipients and resolve missing data before automated payment activation |

Acceptance: unsupported primary preferences cannot produce an unrestricted transfer. An EVM address does not imply a network. Company staff cannot secretly substitute an unconfirmed backup recipient.

## 4. Employee payroll

| ID | Feature | Required behavior |
| --- | --- | --- |
| PAY-01 | Pay schedules | Configure recurring periods, execution dates and time zones; preserve the employee entitlement for each period |
| PAY-02 | Pay-run preparation | Enter or import amounts, bonuses and explicitly supplied adjustments with references and validation |
| PAY-03 | Preview and exceptions | Show payees, net entitlements, primary and backup destinations, unavailable routes, required funds and maximum costs |
| PAY-04 | Approval and reservation | Approve a specific version of the run and reserve obligations and allowed costs before execution |
| PAY-05 | Scheduled execution | A durable scheduler initiates approved payments when due and records missed or blocked execution |
| PAY-06 | Per-recipient results | Report completed, in-flight, held and recoverable items without marking an entire run paid early |
| PAY-07 | Payroll payment records | Provide each employee's period, entitlement, actual asset and network, delivery receipt and any backup usage |
| PAY-08 | Safe reruns | Resume only unresolved obligations; completed pay-period items cannot be paid again through a run retry |

Acceptance: one unavailable employee route does not cause successful employee payouts to repeat. The scheduler cannot change the approved salary, cost ceiling or receiving profile.

## 5. Contractor, freelancer and supplier payments

| ID | Feature | Required behavior |
| --- | --- | --- |
| BILL-01 | Invoice intake | Accept an invoice or structured payment request with supplier, reference, amount, settlement unit, line items and due date |
| BILL-02 | Private extraction | Use NEAR AI Cloud to draft invoice fields and flag missing or inconsistent details; require review before creating an approved obligation |
| BILL-03 | Duplicate checks | Detect reused references, document fingerprints and suspiciously similar requests within the company's records |
| BILL-04 | Milestone payments | Link a request to an approved milestone and retain its acceptance evidence before release |
| BILL-05 | Due-date queue | Prepare, approve and schedule bills individually or in a batch, with cost-center and project references |
| BILL-06 | Recurring vendor bills | Create a bounded recurring mandate; changed amounts or destinations follow the policy's approval rules |
| BILL-07 | Partial payments and closure | Track agreed partial payments and outstanding balances; close only the amount actually satisfied |
| BILL-08 | Disputed requests | Hold a disputed obligation until the agreed parties resolve it; AI can organize evidence without deciding entitlement unilaterally |

Acceptance: resubmitting a paid invoice does not pay it again. Model output cannot replace the confirmed payee or increase an approved bill. Duplicate checks are not a claim of worldwide invoice-fraud detection.

## 6. Routing, USDC backup and recovery

| ID | Feature | Required behavior |
| --- | --- | --- |
| ROUTE-01 | Quote and route validation | Check source and destination support, permitted amounts, expiry, fees and expected receipt before authorizing a route |
| ROUTE-02 | Net-amount protection | Target the agreed recipient amount within the company's authorized total cost; never silently deduct fees from pay |
| ROUTE-03 | Primary-first execution | Prefer the approved primary route; refresh expired quotes within the same mandate before treating the route as unavailable |
| ROUTE-04 | Authorized USDC backup | Use the recipient's confirmed backup only for allowed conditions, with available funds and a valid quote inside the approved limits |
| ROUTE-05 | Attempt tracking | Keep one logical obligation with separately identified execution attempts, route evidence and funding reservations |
| ROUTE-06 | Unknown-outcome handling | Reconcile missing or contradictory results; a timeout or ambiguous failure cannot automatically trigger another payout |
| ROUTE-07 | Refund handling | Confirm any recovered funds and account for actual fees before attempting a backup or releasing reservations |
| ROUTE-08 | Exception resolution | Hold unavailable backups, underfunded obligations, partial delivery and terms requiring new approval; show the required action |
| ROUTE-09 | Receipts and notices | Notify company and recipient of delivery, backup usage or a hold; record actual amounts, route and transaction references |

Acceptance: the same obligation cannot have overlapping payable attempts. A previously successful primary transfer prevents backup payment. An unavailable backup never authorizes a third destination.

The complete decision rules are in [payouts and fallback](payouts-and-fallback.md).

## 7. Private finance assistant and constrained agents

| ID | Feature | Required behavior |
| --- | --- | --- |
| AI-01 | Document analysis | Extract invoice and expense information through the configured private NEAR AI Cloud path |
| AI-02 | Verification evidence | Verify required attestation freshness, identity and request bindings; show which checks passed or failed |
| AI-03 | Financial preparation | Draft pay runs, explain coverage gaps and highlight unusual amount or recipient changes without approving them |
| AI-04 | Execution mandates | Identify the agent, permitted actions, recipients, amounts, time window and maximum costs for every automated payment |
| AI-05 | Enforced limits | Money-moving contracts or verified custody policies reject unauthorized amounts, destinations, duplicate obligations and paused execution |
| AI-06 | Failure behavior | An unavailable private model or failed required verification does not send sensitive data to a different inference provider; permitted manual workflows remain available |
| AI-07 | Owner control | Pause or revoke automation and inspect its proposals, approvals and execution results |

Acceptance: an injected invoice instruction cannot authorize an attacker destination. The model cannot grant itself permissions, rewrite payroll or change a backup address. Fetching attestation data without verification does not satisfy AI-02.

## 8. Privacy, audit and accounting

| ID | Feature | Required behavior |
| --- | --- | --- |
| DATA-01 | Restricted records | Limit salary, invoice, contract and recipient data by company and role; recipients see their own records |
| DATA-02 | Data lifecycle | Encrypt stored private records, minimize inference inputs and define retention, deletion and export behavior |
| DATA-03 | Safe processing | Exclude document plaintext, full prompts and unnecessary personal details from ordinary logs, public storage and transaction arguments |
| DATA-04 | Financial ledger | Reconcile confirmed funding, reservations, principal payouts, route costs, refunds and remaining obligations |
| DATA-05 | Approval history | Preserve who approved which terms, profile versions, agent actions and reasons for backup use |
| DATA-06 | Accountant export | Export pay periods, invoice references, settlement amounts, actual assets, exchange terms, fees and receipts in understandable CSV form |
| DATA-07 | Reconciliation queue | Surface unmatched credits, disputed receipts, stale attempts and differences between requested and delivered amounts |
| DATA-08 | Project and cost-center views | Optional: attribute income and approved costs without treating refundable client funds as realized margin |

Acceptance: an accountant can trace one obligation from approval to final receipt or recovery. A recipient cannot access another employee's pay. A backup payout retains the original invoice or pay-period reference.

## 9. Business netting

Optional participation; included in the product feature set rather than required for ordinary payroll.

| ID | Feature | Required behavior |
| --- | --- | --- |
| NET-01 | Accepted mutual obligations | Admit only explicitly accepted business obligations with compatible settlement assets, terms and settlement windows |
| NET-02 | Clearing proposals | Compute permitted reductions and show each firm's original obligations, reductions and residual position |
| NET-03 | Per-round consent | Bind every participating company's authorization to the exact round, obligation versions and fees |
| NET-04 | Conservation and reservations | Preserve each participant's agreed net position and prevent obligations being reused by concurrent payments or rounds |
| NET-05 | Residual payments | Execute and reconcile the remaining obligations through the same approved payment pipeline |
| NET-06 | Savings report | Distinguish invoice value discharged, residual transfer volume and required starting liquidity; do not call cancelled face value profit |

Acceptance: two firms can offset reciprocal obligations; larger compatible cycles can also clear. An employee's salary or disputed contractor bill cannot be silently netted. A stale or refused plan cannot partially rewrite invoices.

## 10. Operational controls

| ID | Feature | Required behavior |
| --- | --- | --- |
| OPS-01 | Support health | Maintain current asset and network availability and prevent execution from stale support assumptions |
| OPS-02 | Network curation | Enable only reviewed USDC backup networks, preserving recipients' saved choices when availability changes |
| OPS-03 | Durable scheduling | Resume work after interruption without creating another logical payment |
| OPS-04 | Notification preferences | Deliver actionable notices through configured channels without exposing payroll data to unauthorized recipients |
| OPS-05 | Recoverable access | Preserve company owner control and a defined recovery path for company and agent credentials |

Acceptance: a service restart resumes monitoring existing attempts. Disabling a network blocks new use and requests a valid alternative; it does not silently rewrite saved addresses.

## 11. Company subscription billing

| ID | Feature | Required behavior |
| --- | --- | --- |
| SUB-01 | Versioned catalog | Store immutable plan versions with validated operator publication/retirement, frozen purchase terms and clearly labelled pilot offers |
| SUB-02 | Exact subscription checkout | Only the actual company owner selects a verified NEAR payer and reviews the exact USDC charge, dates, receiver, network and signer before explicit wallet consent |
| SUB-03 | Canonical collection recovery | Grant paid access only from final reviewed billing-contract state; preserve one logical invoice through retries, signed-offer refresh, duplicate/excess returns and missing callbacks |
| SUB-04 | Subscription lifecycle | Preserve calendar-month anchors, prepaid renewals, prorated upgrades, usage identity, scheduled next-plan preferences, cancellation and stale paid-invoice refund recovery |
| SUB-05 | Bounded commercial capacity | Enforce new batch payroll, recurring work, private AI, clearing proposals and seat capacity in services/workers; reserve shared AI attempts atomically and disclose counted failures |
| SUB-06 | Preserved financial access | Keep existing obligations, permissions, approvals, recipient access, records, exports and fund recovery available after plan expiry or downgrade; never deduct subscription charges from payroll or client funds |
| SUB-07 | Billing operations and evidence | Provide owner-private invoices/receipts, operator-signed original-payer refunds, reserve-aware withdrawals, durable receipt reconciliation and explicit setup/testnet/live states |

Acceptance: the dedicated NEAR billing contract accepts each signed invoice once, records excess/duplicate returns and final original-payer refunds, and never grants direct authority over company funds. A plan change or temporary billing outage cannot strand an existing transfer. Pilot access and local fixtures never count as revenue. See [subscription billing](subscription-billing.md).

## Later extensions

Receivable financing and lender auctions, full ERP synchronization and bounded agent procurement remain active competitive extensions separate from the initial core completion count. Fiat bank funding/payouts and off-ramps, tax engines, statutory payroll, employer services and legal company formation are deferred outside this crypto release. Their requested expansion is now explicitly tracked, together with company services and private tenders, in [competitive extension requirements](competitive-gap-checklist.md). They require their stated contracts, partner/service scope and integration evidence before appearing as supported functionality; inclusion in the checklist alone does not enable them.

See [NEAR track alignment](near-track-alignment.md) for the evidence these product features must provide in a hackathon demonstration.

Competitive software extensions include the [expense, sourcing/receiving and claim-pool workflows](expenses-procurement-and-claims.md), [cash-backed company clearing](funded-business-clearing.md), [sealed company agreements](private-agreements.md), [optional working-capital escrow](working-capital.md), [embedded native NEAR signer](embedded-near-signer.md), company-operated private invoice review and evidence verification, scoped accounting connectors, public product guides and sender-private support. The [software coverage matrix](software-coverage.md) maps implementation separately from actual credentials, published service scope and live evidence. The original 97-requirement baseline remains unchanged. Source does not establish deployed credit, a successful provider posting or a staffed support offer.

Supplier extensions now include exact commercial quote comparison and original-supplier credit notes with explicit company acceptance. Credit reductions preserve face value, delivery history and purchase consumption and require fresh residual preparation. Company operations reports and editable fee scenarios expose exact recorded subtotals and unknown costs separately. Their evidence and supported adjustment boundaries remain in the competitive checklist and [expense/purchasing specification](expenses-procurement-and-claims.md); live fees, external credit-note posting and provider outcomes are not implied.
