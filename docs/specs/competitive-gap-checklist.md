# Razor competitive feature checklist

Created 14 November 2026. Status: approved scope to track and implement, not a shipped-feature claim. Initial review baseline: `8cdcca1`.

This is the durable checklist for the competitive improvements requested after the feature comparison. It preserves the original G01-G16 gap identifiers and expands six previously adjacent areas into G17-G22 so they cannot disappear during implementation. Every item starts unchecked. Ordering changes delivery sequence, not whether an item stays tracked.

The [baseline feature catalog](features.md) and [build checklist](../build-checklist.md) remain applicable. Their 97 feature requirements and existing evidence are not replaced or marked complete by this extension. The 22 groups below are workstreams, not 22 individually shipped features.

Tracking: 161 workstream acceptance checks and 6 cross-feature completion checks. All started open; checked items below have recorded evidence. Update these counts if acceptance scope changes; preserve stable IDs and the evidence history.

## Tracking and completion rules

- Reference the exact acceptance ID, such as `G03-04`, in a change and its review evidence. Check it only when the stated behavior is demonstrated; clear it after a regression.
- Separate implemented source, focused local verification, browser verification, configured integration, testnet evidence and mainnet evidence. Passing one does not establish the others. External settlement checks require real evidence on the stated network.
- Record partial implementation and remaining dependencies in the evidence log. A mock provider, dry quote, unpaid fixture, screenshot or valid signature alone cannot prove payment delivery, private execution, revenue or a partner service.
- Provider-dependent features stay unchecked until the actual integration and applicable operating scope work. Missing credentials or commercial arrangements are dependencies, not completed features or reasons to remove the workstream.
- Reuse reviewed compatible libraries and source with required notices. Recheck revisions, dependency support and financial assumptions before adaptation. Keep source provenance in research records, rather than in product UI or production behavior.
- Maintain at most three feature worktrees. Review, integrate and remove completed worktrees before starting replacements. Serialize heavy builds, use the existing memory caps and prioritize focused verification after meaningful changes.
- Implement the actual workflows and their reachable dashboard controls before marketing pages. Use existing asset/network components and readable identities throughout financial reviews.

The product continues to use NEAR application accounts, contracts and financial authority, NEAR Intents for supported cross-chain endpoints, and NEAR AI Cloud for private inference. All supported funding/primary payout choices remain available; recommended low-cost assets are suggestions. Backup remains recipient-confirmed native USDC on an enabled curated network. New modes must preserve company isolation, exact entitlements, cost caps, durable accounting and unknown-outcome holds.

## Coverage and delivery order

| Group | Workstream | Current implementation/evidence | Sequence and dependencies |
| --- | --- | --- | --- |
| G01 | Document and channel invoice intake | Browser files/manual review verified; channel adapters integrated; real image/provider delivery pending | A; existing bill review and private analysis |
| G02 | Flexible payroll imports | Manual mapped imports verified; optional header-only AI suggestions integrated; live inference pending | A; existing recipient and payroll validation |
| G03 | Managed payroll execution | Console and durable wallet batches integrated; unconfigured browser readiness verified; real wallet evidence pending | A; existing authority, reservations and recovery; integrates G02/G04 |
| G04 | Direct native-USDC funding | Company/public/obligation paths integrated with local proof fixtures; live money evidence pending | A; shared treasury receipt/credit attribution |
| G05 | Integrated NEAR signer onboarding | Social login exists; external owner-wallet setup remains separate | A; reviewed native NEAR provider and recovery |
| G06 | Independent vendor commitments | Purchase budgets and structured receiving/quantity checks verified locally; credit notes pending | B; approval policy and invoice accounting |
| G07 | Standing autopay and supplier cooldown | Native supplier grants, cooldown and restricted worker integrated; local contract checks passed; live authority pending | B; explicit contract authority; G06 for PO-linked use |
| G08 | Portable independent verification | Packets, CLI, browser and scoped exports integrated; hardware/plaintext/settlement checks remain incomplete | A; actual signed bytes and privacy-safe exports |
| G09 | Better clearing optimization | Bounded optimization and historical manifest compatibility verified; actual fees unavailable | B; accepted obligations and existing netting consent |
| G10 | Funded clearing rounds | Native escrow mode integrated with local funding/credit/refund proof; configured wallet/live token evidence pending | C; USDC custody, funding, refunds and existing netting locks |
| G11 | External API, MCP and events | Scoped API/MCP, credentials and durable signed events integrated; customer/provider evidence pending | B; scoped integration identity and existing approval services |
| G12 | Customer-direct private processing | Company-operated tool and selected-field import verified locally; real private inference pending | C; reviewed client/company-operated verification, G08 |
| G13 | Bank funding, cash-out and accounts | Crypto settlement exists; banking integration missing | D; real partner, coverage, credentials and reconciled rails |
| G14 | Payroll and contractor compliance services | Payment records exist; statutory services missing | D; supported partner/jurisdiction and G13 where fiat is required |
| G15 | Inspectable live product evidence | Local/source evidence exists; own live money journey pending | A onward; each demonstrated capability and configured network |
| G16 | Claimable distributions | Native pools, retry fencing and callbacks verified locally; live funding/claims pending | C; new funding, claim and reclaim lifecycle |
| G17 | Accounting, expenses and ERP connectors | Staff expense workflow verified locally; scoped QBO/Xero connectors integrated, provider evidence pending | B/D; G11 integration controls; G01 for document intake |
| G18 | Procurement and inventory | RFQ, supplier awards, receiving and inventory verified locally; full payment journey pending | D; G06 commitments and existing supplier controls |
| G19 | Private tenders and negotiated agreements | Private inference exists; sealed commercial negotiation missing | D; G12/G08 verification and G18 commercial requests |
| G20 | Working-capital financing | No lending or advance lifecycle | D; explicit credit terms, separate NEAR contracts and actual lenders |
| G21 | Company formation and ongoing services | No entity-formation service | D; actual service partner and jurisdiction coverage |
| G22 | Competitive commercial offers and support | Searchable help and sender-private support verified; complete commercial comparisons and staffed tiers remain open | B/D; observed service costs, supported scope and operations |

A covers core intake, first use and execution. B adds business controls and integrations. C adds distinct financial or privacy modes. D expands partner services and adjacent business workflows. Independent slices can run concurrently within the three-worktree limit; shared financial modules must have an assigned owner and be integrated before dependent work starts.

## G01. Invoice documents and practical intake channels

Baseline: invoice records, text analysis, duplicate controls and human review already exist. This group adds the missing input paths.

- [x] `G01-01` A payer or authorized supplier uploads a PDF or supported invoice image and sees a saved, company-scoped intake record with processing status, provenance and the original document subject to access/retention policy.
- [ ] `G01-02` Text PDFs and scanned/image documents use bounded extraction or OCR; file type/content, bytes, page count, decoded image size and processing time are validated. Password-protected, malformed or unsupported documents produce recoverable errors.
- [ ] `G01-03` Extracted supplier, reference, dates, currency, totals and line items show confidence/missing-field warnings and the relevant source excerpt before a human confirms the obligation. Foreign currency never becomes USDC through an invented conversion.
- [ ] `G01-04` Document bytes and a normalized invoice identity feed existing duplicate checks across upload, text and channel ingestion; repeated uploads do not create another payable obligation.
- [ ] `G01-05` An organization can connect, inspect and revoke a Telegram invoice inbox with verified channel-to-company binding; documents/photos enter the same review queue, and webhook/update retries are idempotent.
- [x] `G01-06` An organization can use a watched-folder ingestion connector with explicit file access, bounded scanning, durable deduplication, retry status and revocation. Processing does not mark a file paid.
- [ ] `G01-07` A configured WhatsApp connector supports the same authenticated invoice/expense intake and review rules, with clear third-party visibility, actual provider delivery evidence and a manual-upload alternative.
- [ ] `G01-08` Document processing uses the documented NEAR private-processing boundary; retention/deletion covers originals, extracted text, temporary files and retained outputs. Failures do not silently send documents to another model provider.
- [ ] `G01-09` Malicious document instructions, forged chat senders and document payment addresses cannot modify the confirmed recipient, approve a liability or bypass company permissions. The user can resolve extraction failure manually.
- [x] `G01-10` PDF/image processing uses isolated, memory-capped workers with bounded concurrency, timeouts and output, minimal environment access and temporary-file cleanup. Several uploads cannot exhaust the application or development laptop's memory.

## G02. Import a company's existing payroll sheet

Baseline: row validation, recipient CSV intake and fixed payroll columns already exist.

- [x] `G02-01` A user uploads a CSV, previews its actual headers/rows and manually maps employee identity, amount, supplied bonus/adjustment, currency, note and optional cost ceiling without reshaping the source file.
- [ ] `G02-02` Optional AI suggests a mapping using minimal necessary header/sample information. The user confirms it; unsupported or invented columns are rejected, and manual mapping works without AI credentials.
- [x] `G02-03` Decimal separator, thousands separator, delimiter and encoding handling are explicit. Ambiguous formats, mixed currencies, empty required values, negative net pay, precision loss and overflow block affected rows rather than changing amounts silently.
- [x] `G02-04` Amount normalization uses deterministic exact arithmetic. Source value, normalized amount and any explicit user correction remain inspectable; a model cannot calculate salaries, infer FX or invent payee accounts.
- [x] `G02-05` Existing recipients are matched with company-scoped stable identities; unknown, duplicate and ambiguous identities enter an invitation/resolution flow without creating an automatically payable destination.
- [x] `G02-06` A confirmed mapping can be saved, renamed and versioned per company through persisted controls. Changed source headers require revalidation; another company cannot read its mappings or payroll samples.
- [x] `G02-07` The import preview reports accepted/rejected rows and total principal/cost ceilings, supports correction before commit, and resumes without creating duplicate employees or pay-period obligations.

## G03. Execute payroll as a managed run

Baseline: payroll drafts, previews, application approvals, exact-route approvals and a restricted executor already exist. This group connects them into one operational journey.

- [ ] `G03-01` A run execution view shows the exact approved version, pay period, total entitlements, available/reserved funds, maximum costs and each employee's next required action.
- [ ] `G03-02` Run readiness distinguishes missing recipient confirmation, unsupported route, stale quote, missing authority, insufficient cash, policy changes and scheduling constraints. One unavailable line does not hide ready lines.
- [ ] `G03-03` Before execution, aggregate principal and permitted costs are reserved without double counting existing per-payment reservations, client reserves or another run. An interrupted reservation cannot leave spendable duplicate cash.
- [ ] `G03-04` The owner reviews bounded groups of necessary wallet actions with per-line recipient/asset/network/amount/fee/expiry bindings. Batch size respects real NEAR transaction/gas limits and wallet capabilities; unsupported batching has an honest resumable fallback.
- [ ] `G03-05` A worker continues only the routes actually authorized by the owner or a separately valid standing mandate. Grouping actions never approves a changed destination, salary, cost or expired route implicitly.
- [ ] `G03-06` Each line shows prepared, awaiting signature, submitted, in-flight, delivered, held or recovering state from its actual attempts. Cross-chain outcomes remain independent; the run is complete only when all required entitlements are satisfied or explicitly resolved.
- [ ] `G03-07` Restart, wallet rejection, partial batch submission and concurrent workers resume unresolved actions without repeating delivered or uncertain payments. Signed-but-unknown actions remain fenced for reconciliation.
- [ ] `G03-08` A mixed run of direct native-USDC and supported Intents destinations demonstrates progress, one held line and safe resume. The product never describes heterogeneous cross-chain delivery as one atomic transaction.

## G04. Direct native-USDC cash funding

Baseline: direct native NEAR USDC payouts and tagged shared-treasury credits exist. The missing path is direct incoming company cash.

- [ ] `G04-01` Selecting the verified native NEAR USDC asset offers a direct deposit into the reviewed shared treasury; other source assets retain their supported Intents funding choices.
- [ ] `G04-02` The wallet preview includes source signer, token contract/network, amount, company, deposit identity, treasury destination, token registration and actual required native deposits/gas. It never sends a bare transfer as attributed company funding.
- [ ] `G04-03` A tagged token callback and immutable credit record bind each accepted transfer to the intended company and funding purpose. Final token receipts are verified before increasing available cash.
- [ ] `G04-04` Company top-up, public funding request and approved-obligation funding use the direct path where applicable, with the same history, excess allocation and remaining-need accounting as routed funding.
- [ ] `G04-05` Duplicate receipts, copied tags, wrong token/network, another company's credits and aggregate pool balance changes cannot create or steal company funding. Rejected callbacks and returned transfers are shown accurately.
- [ ] `G04-06` Rejection, insufficient native gas, missing token storage, interrupted signing and unknown submission preserve the deposit identity and allow reconciliation without requesting a second transfer automatically.
- [ ] `G04-07` Direct funding remains usable during a routing-provider outage, produces a final credit receipt and shows actual costs. Dry quote maximum input or slippage headroom is never presented as measured routing fees or guaranteed savings.

## G05. Integrated social-to-NEAR onboarding

Baseline: Google/email/passkey sign-in and external NEAR owner-wallet linking exist. Social identity alone does not hold treasury authority.

- [ ] `G05-01` A reviewed native NEAR-compatible signing integration has documented ownership, custody, account/network creation, recovery and browser/device support. An embedded EVM wallet is never presented as NEAR contract authority.
- [ ] `G05-02` A fresh social user can prepare work first, provision or connect the NEAR signer, verify ownership and return to the same company and unfinished action without importing a seed into Razor.
- [ ] `G05-03` Provisioning retries, provider return, existing-wallet reuse, network changes and cancelled setup are resumable and cannot create ambiguous owners or duplicate companies.
- [ ] `G05-04` Signer recovery and revocation are demonstrated, including an unavailable provider/device and a lost Razor sign-in method. Fresh authentication protects linking, recovery and ownership changes; OAuth/email alone cannot authorize transfers.
- [ ] `G05-05` Creation/storage/native-gas costs and any sponsor budget, limits and funding source are shown before commitment. Exhausted sponsorship has an actionable funding path; there is no unsupported zero-cost account promise.
- [ ] `G05-06` The company owner's first real NEAR authorization, returning login and existing-wallet alternative work with the chosen provider. Linking a source wallet still does not grant it owner, approver or recipient authority.

## G06. Approved purchase orders and vendor commitments

Baseline: invoice amounts, installments and milestone acceptance exist. This group adds approval before an invoice establishes the liability.

- [x] `G06-01` Authorized staff create a vendor commitment or PO with counterparty, reference, settlement unit, scope, total/period allowance, dates and approving policy independently of any submitted invoice.
- [x] `G06-02` Approved commitments are versioned and reviewable; amendments, suspension and cancellation preserve history and require the applicable approval. Draft commitments do not authorize payment.
- [x] `G06-03` A bill matches an explicit commitment and shows agreed value, previously committed/invoiced/paid value, remaining allowance and any currency, supplier, period or quantity mismatch before approval.
- [x] `G06-04` An exhausted, expired or mismatched named PO holds the bill; it cannot silently fall back to another standing order. Overrides require explicit authorized amendment or exception with a recorded reason.
- [ ] `G06-05` Concurrent invoices, duplicates, installments, credit notes, disputes, cancellation and netting cannot consume or restore the same allowance twice. A route failure does not reopen an already consumed purchasing commitment. Purchase commitments do not become cash deposits or delivered payments.
- [x] `G06-06` Period limits use explicit reset/rollover rules and a documented time basis. Contract-enforced limits are enforced by the actual spending authority; a database review gate is labelled as such.
- [x] `G06-07` A user can create, approve, search, inspect and amend a commitment, match an invoice and resolve an overrun through normal workspace screens and a traceable accounting export.

## G07. Optional standing autopay and supplier-change cooldown

Baseline: scheduled drafts and execution of owner-approved exact routes exist. Standing authority is a new opt-in mode; ordinary exact review stays available.

- [ ] `G07-01` An owner explicitly authorizes a mandate with agent identity, permitted vendor/destination/asset, allowed actions, per-payment and aggregate period limits, maximum input cost, validity period and required invoice/commitment conditions.
- [ ] `G07-02` The real NEAR authority enforces mandate scope, period usage, worst-case input/fee reservations and pause/revocation atomically. Pending or unclosed recovery cannot reopen an allowance. A model, worker or repeated proposal cannot bypass limits through concurrent transactions or split payments.
- [ ] `G07-03` A verified eligible native-USDC vendor bill can execute without another per-bill owner signature only inside its active mandate. Out-of-policy bills enter an exception queue explaining the necessary approval.
- [ ] `G07-04` New or changed supplier receiving details start a documented activation/cooldown rule, notify authorized users and invalidate affected automation. Cancelled/replaced changes and clock boundaries cannot bypass the delay; any emergency override has explicit authority and evidence.
- [ ] `G07-05` Cross-chain standing authority constrains the recipient, exact asset/network, minimum output entitlement, maximum input cost, route lifetime and allowed provider path at the contract boundary. It is enabled only after that enforcement is demonstrated.
- [ ] `G07-06` Uncertain or partially delivered transfers retain their original liability and reservations until reconciled. A mandate never turns a timeout into a new payout or bypasses existing USDC-backup consent and recovery rules.
- [ ] `G07-07` Owners can inspect usage, next reset, pending commitments and agent decisions and pause/revoke a mandate immediately without stopping monitoring or stranding funds already in flight.

## G08. Portable proof packets and independent verification

Baseline: private inference verification and encrypted evidence downloads exist. Existing retained evidence is not automatically a complete replay bundle.

- [ ] `G08-01` An explicit portable packet format identifies schema/version, network, deployment/code identity, signed request/response bytes, hashes, signer/attestation metadata, applicable policy/recipient versions, financial references and evidence limitations.
- [ ] `G08-02` Evidence collection retains the actual bytes and metadata needed for independent verification under the chosen disclosure/retention policy. Missing historical material is reported as unavailable rather than reconstructed or silently treated as verified.
- [ ] `G08-03` A standalone local verifier checks hashes, signatures, request/response binding, attestation identities/freshness at execution and relevant final chain references without requiring a Razor workspace or AI credential.
- [x] `G08-04` A browser verification view accepts a packet or an explicitly shared reference and reports passed, failed, unavailable and not-checked claims separately. Network lookup requirements and offline limitations are visible.
- [ ] `G08-05` Company-authorized selective exports and share expiry/revocation protect payroll and invoice contents. Redaction changes what can be verified and is disclosed; unverifiable redacted bytes do not retain a false signature-success label.
- [ ] `G08-06` Tampered bytes, wrong chain/deployment, another payment's receipt, untrusted measurement, stale execution evidence and substituted recipient/amount are rejected or clearly classified as unverified.
- [x] `G08-07` The verifier distinguishes byte integrity, attested execution identity, provider-reported delivery, operator attestation and independently observed settlement. None is presented as proof that an invoice or model conclusion is factually correct.
- [ ] `G08-08` Historical evidence binds the deployment/code and approved policy/recipient versions at the relevant finalized block. Later upgrades or profile changes do not retroactively fail a valid old proof; an unavailable historical lookup is reported separately from invalid evidence.

## G09. Improve debt-clearing optimization

Baseline: current cycle cancellation is conserved and deterministic but does not always maximize cancellable invoice value.

- [x] `G09-01` A bounded exact-integer optimizer maximizes the defined cancelled face-value objective over accepted eligible obligations and respects all current company/edge/amount bounds.
- [x] `G09-02` Input ordering and equal-score ties have deterministic rules. Proposals bind exact obligation versions and original/reduced/residual amounts so later consent cannot authorize another result.
- [x] `G09-03` Every result preserves each company's net position, nonnegative residuals and per-edge capacities. No unrelated obligation, employee salary, disputed amount or already reserved payment enters the calculation.
- [x] `G09-04` Runtime/iteration limits and inability to prove optimality are explicit. A bounded fallback remains conserved, labelled and no worse than the accepted baseline on the chosen objective.
- [x] `G09-05` The four-obligation regression with D-to-C 3, C-to-D 3, D-to-B 3 and B-to-C 1 reduces residual gross transfer volume from the current 4 to 3 while preserving net positions. Both cases' starting-liquidity lower bound remains 3.
- [ ] `G09-06` Exact consent, concurrent-round exclusion and existing finality/revocation controls remain enforced. Reports separate cancelled invoice face value, residual volume, required starting liquidity and actual fees paid.

## G10. Cash-backed clearing rounds

Baseline: existing clearing records consented debt discharge and creates ordinary residual payments. This additional mode must remain visibly distinct.

- [x] `G10-01` A round specifies the cash-backed mode, canonical native NEAR USDC, reviewed NEAR custody boundary, net debtor requirements, creditor credits, funding deadline and complete cancellation/refund terms before consent.
- [ ] `G10-02` Every required company approves the exact version and its funding/credit terms. Conflicting invoice payments, bookkeeping clearing and another funded round cannot reuse the same liability.
- [ ] `G10-03` Tagged debtor funding is attributed from final canonical receipts to the correct round/company. Underpayment, excess, duplicate/foreign credits and interrupted callbacks are accounted for without creating unfunded creditor credit.
- [ ] `G10-04` Finalization requires all consents and exact required funding before the deadline. Atomic creditor entitlements reconcile to scoped funded liabilities; the same backing cannot remain spendable treasury cash and round escrow/credit simultaneously. One missing debtor prevents a false fully settled round.
- [ ] `G10-05` Credit withdrawal or an approved outbound payment is nonce/idempotency bound. Failed callbacks restore only the matching credit; unknown submissions cannot produce another payout. Cross-chain delivery retains ordinary route and backup constraints.
- [ ] `G10-06` Rejected, revoked or expired unfunded rounds release locks; funded but unfinalized rounds create correct depositor refund rights without spending another company's funds. Withdrawal/refund recovery is available through the workspace.
- [ ] `G10-07` Statements distinguish net cash deposited, debt discharged, creditor claim funded, wallet delivery and remaining refunds. Existing bookkeeping rounds keep their original meaning and cannot be relabelled as cash-funded settlements.

## G11. External APIs, agent tools and events

Baseline: internal session-authenticated HTTP services exist. This group adds customer-controlled external access.

- [x] `G11-01` Owners create, inspect, expire, rotate and revoke organization-scoped integration credentials with explicit read, draft and optional execution permissions. Secrets are protected and cannot be read back through ordinary list/log responses.
- [x] `G11-02` Documented versioned APIs support scoped recipient/invoice/payment drafts, status and authorized evidence reads, with validated schemas, pagination and stable error meanings. Existing company/role/recipient privacy checks still apply.
- [x] `G11-03` Creation and financial requests use idempotency keys bound to tenant, caller and immutable terms. Reusing a key with different terms fails; retries cannot create another liability or transfer.
- [ ] `G11-04` An MCP adapter exposes narrow draft/request/status tools against those APIs with a working client setup, explicit permissions and revocation. It contains no blanket owner key or alternate payment rail.
- [ ] `G11-05` Execution-capable integrations, if enabled, use existing exact-route or G07 standing authority at the real NEAR boundary. Draft permission cannot approve its own request or mutate confirmed receiving details.
- [ ] `G11-06` Company-configured outbound webhooks carry signed, versioned, minimally disclosed events with durable delivery, replay protection, retry/backoff and observable failure/replay controls. Validated destinations, DNS/address checks, redirect policy and bounded requests prevent access to private networks, metadata services or server credentials. Event ordering never overwrites newer financial state.
- [x] `G11-07` Rate/concurrency limits, credential rotation, unavailable clients and transport failures preserve request status and avoid duplicate work. External integration records can be audited by the company's authorized staff.

## G12. Customer-direct or company-operated private inference

Baseline: Razor currently receives plaintext and verifies encrypted inference through NEAR AI. This mode reduces the application operator's access instead of weakening verification.

- [x] `G12-01` A reviewed architecture identifies which client/company service sees plaintext, how it reaches verified NEAR AI computation, the remaining hosted-code/metadata exposure, and the difference from the existing hosted mode.
- [ ] `G12-02` A customer can use an explicitly selected own-key or company-operated mode without exposing that credential in URLs, logs, exports, analytics or ordinary server storage. Persistence, revocation and any local storage are explicit.
- [ ] `G12-03` Required gateway/model measurements, session freshness, encryption and signed response/request binding are verified by a capable client or company-operated verifier. Browser incompatibility or failed verification cannot silently downgrade to an unverified API call.
- [x] `G12-04` Raw documents and decrypted results follow the chosen data boundary; server receipt of optional reviewed fields or evidence is disclosed. A no-plaintext-to-Razor mode is demonstrated through its actual transport and logging path.
- [ ] `G12-05` The user can review draft fields and generate a G08-compatible proof packet. Selective disclosure cannot change approved financial terms, and AI output cannot establish treasury authority.
- [x] `G12-06` Credential/model/provider failure offers an explicit manual or separately selected processing path. It does not silently move a private document into hosted mode or another inference provider.

## G13. Bank rails, fiat funding and cash-out

This is a tracked partner-backed extension. Crypto delivery alone does not satisfy these checks.

- [ ] `G13-01` A real partner integration defines supported businesses, jurisdictions, currencies, banking rails, onboarding requirements, custody/funds ownership, limits, provider fees and required operating responsibilities before being advertised.
- [ ] `G13-02` Eligible companies can complete required verified onboarding and obtain usable partner business-account/virtual-account details for supported ACH, wire or local rails. Unsupported applicants receive an accurate status and alternative.
- [ ] `G13-03` Supported fiat deposits are matched to the correct company from authenticated provider events and reconciliation. Pending bank funds never increase spendable USDC; FX/conversion creates separately traceable confirmed settlement.
- [ ] `G13-04` A recipient can explicitly choose a supported bank cash-out destination, including INR where actually enabled. Verified banking details, identity controls, consent and changed-destination protections are enforced without exposing them onchain.
- [ ] `G13-05` Before acceptance, the payer/recipient sees agreed delivery currency/net amount, quote validity, FX, all provider/network costs, limits and expected timing. A bank payout is never described as instant crypto delivery or guaranteed cheapest.
- [ ] `G13-06` Provider acceptance, bank processing, actual credit, rejection, return, recall and unknown outcome remain distinct. A transfer to a cash-out provider proves only the crypto leg; final bank-delivery evidence has its own provider reference. Signed webhook delivery alone cannot establish final bank receipt; duplicate/late events cannot trigger another payment.
- [ ] `G13-07` Expiry, short payment, intermediary deductions, partner outage and returned funds have explicit liability and recovery handling with exact ledger reconciliation and an authorized operations queue.
- [ ] `G13-08` A real supported funding and bank-delivery journey demonstrates the complete money path and receipt. External bank services remain partner endpoints; application contracts and policy authority remain on NEAR.

## G14. Contractor and statutory payroll services

Baseline: Razor provides payment operations and company-supplied amounts. Compliance, tax filings and employer services need separately demonstrated provider scope.

- [ ] `G14-01` Supported jurisdictions and an actual payroll/contractor service arrangement define responsible parties, data handling, service charges, exceptions and the exact services offered.
- [ ] `G14-02` Eligible contractors complete provider-backed identity/compliance checks and contract signing; pending or rejected onboarding blocks only the service requiring it and does not masquerade as a completed check.
- [ ] `G14-03` Provider-calculated gross pay, taxes, deductions, benefits and net pay are distinguishable from company-supplied adjustments, with authoritative calculation versions, pay periods, correction handling and required approvals.
- [ ] `G14-04` Supported filings, remittances, annual reporting and employee/contractor forms are delivered and retained through the responsible service. A Razor payment record cannot be labelled a statutory filing or tax payment without that evidence.
- [ ] `G14-05` Payroll funding, employee net entitlement, government/provider liabilities and service charges reconcile separately; retries or retroactive corrections cannot reduce an employee's paid entitlement silently or charge twice.
- [ ] `G14-06` An agent-of-record/employer-of-record option, where actually offered, identifies the contracting/employing party, supported coverage, benefits/insurance and service obligations. It is optional and never implied by ordinary contractor payments.
- [ ] `G14-07` Authorized users can resolve onboarding holds, rejected calculations, missed deadlines, terminated workers and corrections through a real provider-backed workflow with appropriate privacy and support access.

## G15. Live evidence and inspectable demonstrations

This group verifies implementation outcomes. It does not authorize an automatic deployment, signature or spend merely because a checklist exists.

- [ ] `G15-01` A reproducible read-only product scenario uses fictional business data and sanitised evidence, identifies the exact app/contract build and is accessible without a company administrator account.
- [ ] `G15-02` A fresh user completes sign-in, company setup, NEAR authority, recipient confirmation and first funding/payment without a pre-seeded finance workspace or developer-console mutation.
- [ ] `G15-03` At least one actual mainnet NEAR funding-and-payout journey and a supported mainnet cross-chain example show exact final source/destination evidence bound to the same Razor funding/payment attempt, fees, company credit and recipient entitlement. Direct native-USDC behavior is included. Testnet/dry results cannot close this mainnet evidence gap; unexercised routes remain labelled accordingly.
- [ ] `G15-04` A managed payroll run demonstrates multiple recipients and a recoverable held line without repeating completed payments. Reviewers can follow the run to individual evidence and accounting outcomes.
- [ ] `G15-05` An allowed USDC-backup scenario and an actual available recovery case demonstrate consent and no-double-payment rules. Artificial faults remain labelled simulations and do not pass a real refund/delivery check.
- [ ] `G15-06` Private invoice processing demonstrates required attestation/receipt verification and a failed-verification path using fictional input. A G08 packet can be independently checked within its disclosed limits.
- [ ] `G15-07` Public evidence distinguishes dry quotes, local fixtures, testnet execution, mainnet transfers, provider-reported states and operator assertions. Final deployment identity and public references can be independently inspected without exposing private records.
- [ ] `G15-08` The live capability matrix and existing build checklist are updated only for the exact supported behavior demonstrated. An extension stays unavailable or explicitly pending while its provider, contract or real settlement evidence is missing.

## G16. Optional claimable distributions

Baseline: ordinary push payroll is already available and receiving it requires no recipient gas. Claims are an additional choice for grants, pools or distributions.

- [x] `G16-01` The company selects push or claimable distribution explicitly. A claimable run fixes recipients, exact native-USDC entitlements, commitment/version, funding requirement, deadline and unused-fund policy before authorization.
- [ ] `G16-02` A funded commitment activates only after exact eligible funding and a validated entitlement construction binding its recipients, amounts and total. A declared total alone is not proof of funded committed entitlements. Merkle/other proofs bind the run, token, account, amount and unique claim identity; private proof access does not disclose other recipients' rows.
- [ ] `G16-03` The recipient proves entitlement and receives funds only at the permitted destination. A sponsored claim relayer cannot redirect the claim, increase its amount or use the authority for another transfer.
- [x] `G16-04` Duplicate claims, copied proofs, another run/network, race conditions and failed/unknown transfers cannot spend an entitlement twice. Failed claim recovery restores only the matching unconsumed liability.
- [ ] `G16-05` Verified funding conserves claimed amounts, pending transfers, unclaimed entitlements, returns and reclaim rights without double counting. Unclaimed entitlements remain reserved until a final claim or valid reclaim. At deadline, only genuinely unclaimed eligible funds become reclaimable; pending claims and disputed amounts remain protected under the agreed policy.
- [ ] `G16-06` Recipients see claim readiness, expiry, successful receipt and any supported recovery; companies see funded, claimed and reclaimable totals. Native relayer subsidy and any recipient costs are explicit.
- [x] `G16-07` Cross-chain claims, if enabled, obey the existing routing, exact entitlement and USDC-backup recovery rules. Commitment privacy is not advertised as hiding public transfer amounts or destination addresses.

## G17. Accounting, expenses and ERP integration

This expands the accounting part of G11. Baseline ledger, project reports and CSV export already exist.

- [ ] `G17-01` Authorized users connect and revoke QuickBooks Online and Xero integrations with scoped provider access, a selected legal entity, visible sync state and explicit chart-of-accounts/tax-code mapping.
- [ ] `G17-02` Invoice, supplier, payment, fee, FX and credit records sync through durable external identifiers and idempotency. Round-trip edits, duplicates, closed periods and conflicting source records enter a review queue.
- [ ] `G17-03` Automatic matching links imported bank/accounting activity to actual funding and payout evidence. Unmatched records remain unresolved; a partner or accounting status never creates company cash or proves delivery by itself.
- [ ] `G17-04` Accounting exports/sync preserve client reserves, commitments, token quantities, USDC liabilities, debt discharge, bank settlement and realised costs as separate concepts. A deposit or netting reduction is not automatically revenue.
- [x] `G17-05` Staff can submit private expense receipts, choose a purpose/cost centre and track review, approval, rejection and reimbursement. Policy limits and duplicate receipt checks feed the existing payment authority rather than auto-paying OCR output.
- [ ] `G17-06` Corrections, reimbursement reversals and partially paid expenses retain original document/approval lineage. Unauthorized staff cannot inspect other employees' private expenses or salaries through a connector.
- [ ] `G17-07` A NetSuite/enterprise connector uses the same scoped/idempotent model with explicit supported entities, field mapping and demonstrated sync. Unsupported ERP coverage is not implied by generic CSV export.
- [ ] `G17-08` Provider expiry, throttling, downtime, revoked credentials and reconciliation conflicts are visible and resumable without losing the financial ledger or duplicating a payable.

## G18. Procurement, suppliers and inventory

This is an optional business workflow extending G06. A company can continue using payroll and bills without a supplier marketplace.

- [x] `G18-01` Staff create a purchase request or RFQ with specifications, quantity, delivery window, eligible suppliers, budget, required evidence and approving company role.
- [ ] `G18-02` Suppliers submit authenticated, versioned quotes and revisions. Comparison shows complete terms, supported payment asset/network, shipping/service conditions and separately quoted conversion costs without treating indicative prices as executable funding.
- [x] `G18-03` An authorized buyer awards a quote and creates the approved commitment/PO. A model recommendation cannot award a contract, exceed budget or replace supplier receiving details by itself.
- [x] `G18-04` Delivery/receiving records support partial quantities, service acceptance, rejection, returns and discrepancies. Invoice/PO/receipt matching gates payment and distinguishes attested evidence from an assertion or unverifiable upload.
- [x] `G18-05` Optional inventory records track items, stock changes and low-stock triggers. Triggers create bounded purchase requests rather than unrestricted spending; updates have durable company-owned management workflows.
- [x] `G18-06` Supplier onboarding, quote access, change protection and commercial history remain scoped to the authorized parties. A registered supplier has no access to unrelated company finances.
- [ ] `G18-07` A complete RFQ, comparison, award, receipt, matched invoice and payment journey preserves cancellations, disputes, commitment use and actual cash outcomes. Unverified delivery cannot release money automatically.

## G19. Private tenders and negotiated company agreements

This adds private coordination to procurement and business agreements, with explicit tender-to-agreement binding.

- [ ] `G19-01` A tender fixes eligibility, specification, budget, deadline, award rules and permitted disclosures before accepting offers. Participants can inspect those terms and identify the organization/agent authorized to act.
- [ ] `G19-02` Offers remain sealed under the documented confidentiality boundary until the agreed reveal/processing condition. Commitments bind bidder identity, terms and version; rejected or late updates cannot replace accepted offers.
- [ ] `G19-03` Authorized agents negotiate within separate company mandates for price, assets, quantities, dates and maximum commitments. Negotiation never obtains treasury-wide signing authority or invents consent.
- [ ] `G19-04` Private computation uses the required NEAR verification path, and a G08-compatible record states what was verified. A public tender board, hidden UI or hardware report alone is not labelled a fully private auction.
- [ ] `G19-05` Awarded tender, chosen offer, final agreement and resulting PO/payment obligations bind the same exact parties, terms and hashes. Parties explicitly approve the final version before financial commitment.
- [ ] `G19-06` No valid bid, participant withdrawal, failed verification, disputed delivery and expired negotiations have explicit cancellation/refund paths. Reopening a tender cannot duplicate the awarded obligation.
- [ ] `G19-07` Participants can inspect their agreement and permitted evidence; unauthorized competitors cannot read bids or negotiation transcripts. Public metadata and unavoidable financial-chain visibility are documented accurately.

## G20. Working-capital credit and lender offers

This is a separate opt-in financial mode. A credit offer is never treated as payroll cash before funds are actually available.

- [ ] `G20-01` A financing request identifies eligible company receivables/use, principal, settlement asset, duration, maximum financing cost, repayment source, default terms and any required collateral/bond before lender bidding.
- [ ] `G20-02` Actual lenders submit authenticated offers with comparable total cost and conditions. Acceptance binds the exact offer, lender, borrower, expiry and authorizing parties; an indicative offer cannot be shown as funded credit.
- [ ] `G20-03` Reviewed NEAR contracts separately account for lender principal, borrower advance, collateral/bonds, fees and repayment claims, with final receipt attribution and no access to unrelated company/payroll funds. Loan principal and bonds are liabilities/backing, not company revenue.
- [ ] `G20-04` Advance disbursement increases usable company cash only after verified funding and enforceable accepted terms. The normal payroll approval, recipient consent and cost protections still govern spending.
- [ ] `G20-05` Repayments follow an explicit contractual waterfall and reconcile principal, interest/fees, partial repayments and remaining claims without double counting company income, released reserves or lender returns.
- [ ] `G20-06` Late/default/dispute handling, collateral or bond use, recovery authority and lender shortfalls are deterministic and inspectable. No UI or AI claim guarantees repayment or substitutes for an enforceable rule.
- [ ] `G20-07` Quote expiry, lender withdrawal, partial funding and failed/unknown disbursement have bounded cancellation/refund paths. Company, lender and administrator views expose the actual lifecycle and relevant evidence.
- [ ] `G20-08` Supported financing operations, service responsibilities and customer eligibility are established before public availability. A testnet loan or simulated lender does not establish a working production credit offer.
- [ ] `G20-09` Receivable-backed advances bind the eligible claim, accepted assignment/repayment authority and enforcement terms; the same claim cannot back competing Razor advances. Off-platform liens and priority limitations are disclosed rather than claiming universal double-pledge detection or assuming an ordinary invoice guarantees repayment.

## G21. Company formation and ongoing business services

This captures the broader business-services offer as an optional partner-backed extension, independent of permissionless company workspace creation.

- [ ] `G21-01` A real service arrangement defines supported entity types/jurisdictions, eligibility, one-time charges, recurring obligations, partner responsibilities and service support before accepting an order.
- [ ] `G21-02` Eligible customers submit required formation information and authorized documents securely, track application stages and resolve rejected or incomplete records without exposing them to unrelated finance staff.
- [ ] `G21-03` Formation deliverables, registered-agent service, tax/business identifiers and company documents are recorded only from actual service completion. Creating a Razor organization does not claim to incorporate a legal entity.
- [ ] `G21-04` Ongoing compliance/renewal work shows jurisdiction, required task, responsible provider, due date, quoted price, submission evidence and completion. Reminders or draft forms are not presented as filed obligations.
- [ ] `G21-05` Business-account onboarding connects to G13 after actual eligibility checks. Customers can use an existing legal entity and skip formation services without losing ordinary Razor functionality.
- [ ] `G21-06` Cancellation, renewal, failure, service refunds and access to retained documents have explicit customer controls and evidence. Subscription access and customer funds remain separate from partner service obligations.

## G22. Pricing, commercial offers and support

Baseline: zero Razor percentage markup, recipient access and versioned pilot company subscriptions already exist. This group makes the complete offer comparable and supportable.

- [ ] `G22-01` Every supported flow separates Razor subscription/service charges, source gas/storage, routing spread/fees, destination costs and optional bank/provider fees. The recipient entitlement is preserved; company software charges never reduce wages or client principal.
- [ ] `G22-02` A cost comparison uses the same amount, asset/network, delivered destination/currency, subscription allocation and actual supported scope. Zero processing markup is not advertised as unique or universally cheapest; dry quote buffers are not measured paid fees.
- [ ] `G22-03` Pilot/trial eligibility, duration, allowances, renewal/cancellation, seats and AI/integration usage are clear and enforced. Complimentary access is not revenue; paid checkout remains explicit and versioned.
- [ ] `G22-04` All new optional features have deliberate published plan entitlements and capacity limits derived from observed costs. Existing ownership, approvals, safety controls, recipient records and fund recovery remain usable after expiry/downgrade.
- [ ] `G22-05` Free recipient access and no hidden per-recipient payout markup are preserved. Sponsorship has a named payer and bounded policy; unavoidable network/provider costs remain visible rather than described as free.
- [x] `G22-06` A searchable help centre, product onboarding guides and authenticated support intake cover funding, payroll, invoices, integration setup and recovery without requesting private keys or exposing another company's records.
- [ ] `G22-07` Published support tiers identify real staffed channels, coverage and response commitments. Priority chat or dedicated support is offered only with the operating capacity to provide it, and a transfer issue has a traceable escalation path.
- [ ] `G22-08` Aggregate service costs, successful/failed workflow rates and user-reported friction can be reviewed with privacy-safe telemetry. Pricing and supported claims change through intentional catalog/product updates rather than hardcoded competitor snapshots.

## Cross-feature completion checks

These supplement each workstream's own evidence and the baseline journeys. They are not a second implementation checklist for already completed behavior.

- [ ] `GATE-01` Every original G01-G16 gap and expanded G17-G22 workstream maps to acceptance IDs and an implementation/evidence status; none disappears when delivery order or architecture changes.
- [ ] `GATE-02` Reused modules have reviewed revisions, compatible dependency/API behavior and preserved required notices in the appropriate attribution record. Demo keys, old deployments and upstream fixtures never become production authority or configuration.
- [ ] `GATE-03` New durable business objects have company-scoped persistence, management, migration and audit behavior. Research exports, legacy manifests and source snapshots do not become runtime truth without an actual approved consumer/design.
- [ ] `GATE-04` Changed financial boundaries have focused verification for access, exact arithmetic, concurrency/replay, uncertain outcomes and callback recovery. Existing relevant journeys remain intact; local and live evidence remain separate.
- [ ] `GATE-05` Each advertised new workflow is reachable through the real product with readable amounts/asset identities, accessible controls, mobile layout and loading/empty/error/recovery states, without developer-console edits or seeded administrator data.
- [ ] `GATE-06` Main checklist, feature catalog, affected specifications, support scope and deployed capability labels agree with the demonstrated build. Research findings and unchecked planned features are not advertised as available.

## Evidence log

Use one row per meaningful implementation/review slice. Include exact acceptance IDs, source/build identity, evidence class, result, reproducible artifact/reference and unresolved criteria. Financial proof must identify the actual network and receipt/provider boundary. A later regression clears the affected boxes without erasing history.

| Date | Acceptance IDs | Build/deployment | Evidence class | Result and remaining work | Evidence |
| --- | --- | --- | --- | --- | --- |
| 2026-11-14 | G01-G22 | Baseline `8cdcca1` | Planning only | Scope and acceptance criteria recorded; no extension accepted as implemented by this checklist | Product comparison translated into this specification; implementation evidence pending |
| 2026-11-14 | G01-01, G01-10; G02-01, G02-03 through G02-07; G09-01 through G09-05; partial G04 | Wave-one build `b6dd47f` | Local tests, production build, HTTP and browser | All 290 application checks, full typecheck and memory-capped production build passed. Five fresh signed-session HTTP scenarios and six browser checks passed with no exceptions/failed requests; both mobile screens measured 390 px. Verified browser PDF/manual bill creation, deletion preserving bills, locale mapping, explicit correction and exact payroll creation. Mapping persistence/identity/error paths and clearing bounds/legacy manifests have focused service tests. Direct funding uses local RPC/receipt fixtures, not a live credit. G01 channels, real image inference, G02 AI suggestions and wallet/mainnet journeys remain open. Thirteen acceptance boxes checked, with no change to the baseline's 134 boxes | Ignored `.data/competitive-wave1-tests.log`, `competitive-wave1-typecheck.log`, `competitive-wave1-build.log`, `competitive-wave1-workflow-result.json`, `competitive-wave1-browser-result.json` and mobile screenshots; reproducible tests in `tests/` |
| 2026-11-14 | Partial G03, G06 and G08 | Integrated source `8eb71cf` | Focused source/service verification | Managed payroll groups, independent purchasing budgets and portable verifiers integrated. G03 has 16 focused checks including forged receipt flags; G06 has 15 focused checks plus affected regressions; G08 has 16 packet/export/UI checks plus affected regressions. Combined build/browser review of these later slices is pending, so no further box is checked here. Structured quantity/credit-note handling, standalone historical hardware/plaintext binding and live wallet/settlement evidence remain open | Feature tests and source commits retained in Git; latest full browser/build evidence remains wave one |
| 2026-11-14 | G06-01, G06-04, G06-06; G08-04, G08-07; partial G03 | Wave-two build `e687ffc` | Local suite, production build, HTTP and browser | All 337 application checks, full typecheck and production build passed. Four real browser/HTTP scenarios created a PO before invoices, consumed a reviewed invoice once, held an overrun and checked payroll readiness. Public local-file verification accepted an actual fixture signature, classified missing hardware evidence and rejected tampering without a workspace login. Purchase and verifier screens stayed inside 390 px. No funds or inference requests were sent. Five further acceptance checks verified; quantity matching, credit notes, historical hardware/plaintext proof and live settlement remain open | Ignored `.data/competitive-wave2-tests.log`, `competitive-wave2-typecheck.log`, `competitive-wave2-build.log`, `competitive-wave2-browser-result.json`, signed fixture packets and mobile screenshots |
| 2026-11-14 | G01-06; G06-02, G06-07; G11-01 through G11-03, G11-07; partial G02-02, G03, G07, G11-04/G11-06 | Final wave-three build `2c1ef4e` | Local source, full/focused suites, actual WASM, HTTP/CLI and browser | 380 application checks plus 21 focused mapping checks passed; full typecheck and production builds passed. Fresh optimized artifacts passed 66 native checks and 91 calls through the official local NEAR runtime, including four standing-authority scenarios. Six browser journeys covered mobile payroll readiness, unavailable-AI manual fallback, PO amendment/matching/export, real folder CLI ingestion/deduplication/revocation, scoped API/MCP creation/idempotency/rotation/revocation and native-autopay availability. A 509 px integration-settings overflow was corrected; final new screens measure 390 px. One scoped worker tick completed retention and event publication with zero sends. Provider identity, request bounds, tenant-scoped webhook leases and finite MCP requests have focused regressions. Seven further acceptance checks verified, bringing this companion to 25. Real AI/provider/HTTPS webhook/customer-client/onchain funding and settlement evidence remains open. State-version-2 artifacts require fresh accounts, not a funded-state upgrade | Ignored `.data/competitive-wave3-tests.log`, `competitive-wave3-payroll-mapping-tests.log`, `competitive-wave3-typecheck.log`, `competitive-wave3-build.log`, `competitive-wave3-followup-build.log`, `competitive-wave3-contract-build.log`, `competitive-wave3-contract-check.log`, `competitive-wave3-browser-result.json`, `competitive-wave3-worker.log` and mobile screenshots; earlier four scenarios retain their `10da4f4` identity inside the final browser result |
| 2026-11-14 | G06-03; G12-04/G12-06; G16-01/G16-04/G16-07; G17-05; G18-01/G18-03 through G18-06 | Final wave-four app `d752125`; treasury state version 3 | Local full suite, production build, actual WASM, HTTP/CLI and browser | All 476 application checks, full typecheck and memory-capped production build passed. The optimized contracts passed 72 native checks and 110 actual-WASM calls; an exported Rust commitment exactly matches the TypeScript encoding. Five fresh signed-session HTTP scenarios and six browser journeys covered private PDF expenses/deduplication/access, ordinary-source bypass rejection, scoped supplier awards, independent PO approval, partial human receiving, bounded inventory reorder drafts, unfunded native pool creation/cancellation, selected-field local review import and unavailable accounting setup. All six new screens measured 390 px with no runtime exceptions or unexpected failed API calls. Pager and long-action overflow were corrected. Deferred RPC checks prevent stale reads from releasing signing/cash fences; real concurrent SQLite startup/migration checks preserve business transaction authority. Twelve further acceptance checks verified, bringing this companion to 37. Live wallets, canonical-token funding/claims, real private inference/hardware and provider accounting remain open; paid reimbursement reversals, full ERP and complete RFQ-to-cash evidence remain incomplete. State-version-3 treasury artifacts require fresh accounts, not a funded upgrade | Ignored `.data/competitive-wave4-tests-verified.log`, `competitive-wave4-typecheck-verified.log`, `competitive-wave4-build-final.log`, `competitive-wave4-contract-build.log`, `competitive-wave4-contract-check.log`, `competitive-wave4-distribution-hash.json`, `competitive-wave4-database-concurrency-tests.log`, `competitive-wave4-workflow-result.json`, `competitive-wave4-browser-result.json`, `competitive-wave5-accounting-tests.log`, `competitive-wave5-company-private-tests.log`, unsigned deployment preview and mobile screenshots; reproducible focused tests in `tests/` |
| 2026-11-14 | G10-01; G12-01; G22-06; partial remaining G10 | Final wave-five app `4ebfe3c`; treasury state 3 / clearing state 2 | Local full suite, production build, actual WASM, HTTP/CLI and browser | All 513 application checks, full typecheck and capped production build passed. The contracts passed 82 native checks and 178 actual-WASM calls, including 68 funded-clearing calls with raw manifest/hash binding, exact deposits, credits, refund callbacks, unknown holds and conserved counters. Shared bill, recipient, API/MCP, CSV, project and payment-summary checks distinguish funded discharge from delivered tokens, noncash setoff and treasury cash; cleared liabilities cannot be paid, replaced or rematched again. Six browser journeys verified sender-private support creation/reply, actual allowlisted local operator response, close/reopen/deletion, unauthenticated guide search, separate cash-mode setup and browser/server privacy disclosure. All five screenshots measured 390 px with no exceptions or unexpected failed API calls; one intentional signed-out session request returned 401. A funded-round pager overflow was fixed. One scoped worker tick held an unfunded job, completed retention, published four local events and sent nothing. Three further acceptance checks verified, bringing this companion to 40. Cash terms are verified before consent; real configured wallets, canonical-token funding/resolvers, final creditor/refund delivery, live private inference and partner services remain open. Missing clearing withdrawal callbacks stay held, with no owner/reporter reset path. No onchain deployment or transfer occurred | Ignored `.data/competitive-wave5-tests.log`, `competitive-wave5-typecheck-final.log`, `competitive-wave5-build-final.log`, `competitive-wave5-contract-build.log`, `competitive-wave5-contract-check.log`, `competitive-wave5-contract-bindings.json`, `competitive-wave5-integrated-finance-tests.log`, `competitive-wave5-funded-monitor-tests.log`, `competitive-wave5-browser-result.json`, `competitive-wave5-support-operator-result.json`, `competitive-wave5-worker.log`, unsigned deployment preview and mobile screenshots; reproducible tests and workflow specifications retained in the repository |
