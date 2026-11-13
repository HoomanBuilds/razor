# Razor implementation status

The planned development slices are integrated. The latest full feature review fixed additional gaps in payroll imports, funding credit verification, original-route recovery, recurring operation recovery, historical records, private evidence access and financial reports. Live-provider, deployment and production-readiness gates remain open.

The catalog contains **90 requirements: 82 core and 8 optional**. Source coverage and verified behavior are different. The [build checklist](../build-checklist.md) currently verifies **15 of 127 checks: 14 core requirements and one additional scenario**. Its other boxes remain unchecked where complete acceptance evidence is missing. No mocked receipt establishes a live payment.

On 13 November the user clarified that payers may fund with any supported asset and recipients may choose any supported primary payout asset. Both see optional compatibility suggestions; backup always uses native USDC on a curated supported network. Company amounts are recorded in USDC. `AUTH-03` was clarified accordingly, and its historical correction remains in the checklist.

## Integrated product scope

| Feature family | Integrated behavior |
| --- | --- |
| `AUTH-01` through `AUTH-10` | Wallet and optional Privy sign-in, verified linking, self-serve company creation, email or verified-wallet invitations, archived roles, company switching, resumable setup and fresh-authentication recovery |
| `WAL-01` through `WAL-08` | Separate app identity, source wallets and NEAR treasury authority; connected NEAR/EVM/Solana source flows; branded token/network identities and searchable asset controls; explicit deposit instructions for other supported sources; source gas and wallet error handling |
| `ORG-01` through `ORG-05` | Company roles, exact policy/profile versions, total-cost quorum tiers, distinct obligation/route approvals, pause and bounded financial authority |
| `TRE-01` through `TRE-09` | Live Intents catalog, independent funding legs, canonical final USDC credits, protected reserves, funding links, source refund closure, separate retained NEAR token holdings and resumable obligation funding |
| `REC-01` through `REC-07` | Relationship profiles, paginated permanent personal workspace, authorized payment links, historical-owner isolation, confirmed primary/backup choices, address checks, version notices and row-level CSV validation |
| `PAY-01` through `PAY-08` | Exact pay-period liabilities, CSV base/bonus/signed adjustment terms, route/funding previews, approvals, company-zone calendar recurrence, scheduled NEAR authority and per-recipient lineage |
| `BILL-01` through `BILL-08` | Structured/private extraction intake, human-agreed USDC liability, duplicate warnings at approval, milestones, batches, private project references, recurring drafts, installments and disputes |
| `ROUTE-01` through `ROUTE-09` | Signed exact route terms, primary preference, curated consented backup, one active attempt, unknown-outcome holds, source recovery, partial delivery and separately approved remainders |
| `AI-01` through `AI-07` | NEAR AI Cloud inference and required verification, private retained proposals, opaque planner recipients, human draft review, scoped executor keys, limits, pause and revocation |
| `DATA-01` through `DATA-08` | Scoped encrypted records, retention, minimal public commitments, accounting/reconciliation exports, source-unit refund provenance and project/cost-center cash reports |
| `NET-01` through `NET-06` | Accepted business-only obligations, conserved cycle reductions, exact owner consents, finality/code verification, atomic setoff, ordinary residual payments and noncash debt-discharge reports |
| `OPS-01` through `OPS-05` | Current catalog checks, curated network controls, durable leases/journals, transaction monitoring, personal/company notices, optional email outbox and account/executor recovery |

This table records integrated source, not 90 successful live demonstrations. Retained original assets currently mean approved NEAR NEP-141 holdings; they never increase spendable USDC. Fiat bank payouts, tax engines, receivable financing and full ERP synchronization remain outside the catalog.

Recurring templates create reviewable draft obligations. The restricted executor can execute an exact route only after its required NEAR authorizations, within its mandate and before the route expires. It cannot create a new approved quote or approve a changed salary or destination by itself. Held occurrences require explicit recovery; pausing and resuming a template cannot bypass them.

## Local evidence

| Evidence | Result and boundary |
| --- | --- |
| Application suite | All **168 checks passed** on combined feature-review candidate `6507496`. The final recovery-control cleanup passed 12 focused recovery, wallet and client checks on `e7b334e`. Earlier 135-check and 104-check reviews remain recorded in the checklist |
| TypeScript and production build | Passed on combined candidate `6507496` and final recovery-control cleanup `e7b334e`, including full TypeScript and generated Next.js route validation. Compiler commands share a 1.5 GB Node heap cap, one-at-a-time lock and available-memory monitor. Next.js uses one worker |
| Treasury contract | **23 VM checks passed**, including quorum, earliest execution, retained assets and partial settlement |
| Clearing contract | **6 VM checks passed** for bounded conserved reductions, consent, expiry/revocation and authority callbacks |
| Factory contract | **4 VM checks passed** against the newly compiled treasury artifact |
| Contract artifacts | Treasury, factory and clearing WASMs compiled; `.tools/wasm/manifest.json` records public code hashes. The factory embeds that exact treasury. Artifacts remain ignored |
| Built-app HTTP workflow | Fresh real EVM challenge signatures created owners, recipients and role-bound team members. Company creation, confirmed recipient consent, wallet invitations, role enforcement, stale-review rejection and unfunded approvals passed. Cross-company payment, bill and approval-review IDs returned 404 even for the shared owner |
| Built-app recovery routes | Account, retained holdings, clearing, source refunds, partial review and pay-from-wallet routes responded. A company without a treasury received an actionable setup stage. No balance was seeded |
| Browser review | On `6507496`, Owner, Viewer, Approver, Operator and company-only screens rendered without runtime exceptions or automatic 403s. Browser back, company switching, payment bookmarks, unsaved-form refresh, role changes, session expiry and clipboard fallback passed. Six additional scenarios verified real CSV file import through saved component review, supplier/activity page controls, recipient payment/profile links, personal update links and mobile preferences. Treasury and receiving pages each stayed exactly 390 px wide |

The workflow reviewed 204 USDC of payroll with a 1 USDC ceiling and displayed the 205 USDC shortfall. A milestone invoice required acceptance before a 10 USDC installment could be approved against its 25 USDC face amount. A contractor's EUR request became a USDC draft only after explicit human agreement. Missing private-inference configuration returned unavailable and did not send the document to another provider.

The follow-up zero-cash workflow showed **242 USDC total debt**, including the entire 25 USDC invoice, **15 USDC awaiting future installments**, and **230 USDC current payment funding need** after its active installment and other obligations. The previous installment-only overview understated the full invoice debt.

Current feature-review evidence is local and ignored: `.data/feature-audit-tests.log`, `.data/feature-audit-typecheck.log`, `.data/feature-audit-build.log`, `.data/feature-audit-workflow-result.json`, `.data/feature-audit-browser-result.json`, `.data/feature-audit-features-browser-result.json` and the overview screenshot. The recovery-control cleanup has `.data/feature-audit-recovery-followup-tests.log` and `.data/feature-audit-followup-build.log`. Production builds include the combined TypeScript check. The browser's single expected 401 was deliberately generated while testing session expiry; the additional feature scenarios had no failed requests.

Previous journey evidence remains in `.data/experience-review-*`. All evidence files contain local fixture identities and stay outside git. The review server and owned headless browsers are stopped; no feature worktrees remain.

Earlier evidence files are local and ignored: `.data/razor-final-tests.log`, `.data/razor-final-typecheck.log`, `.data/razor-final-build.log`, `.data/razor-final-workflow-result.json`, `.data/razor-final-browser-result.json` and associated screenshots. The older `26ced9d` workflow files remain historical evidence. The asset follow-up passed eight focused checks and five browser scenarios on `6c26570`: actual library SVGs, exact catalog selection, search and keyboard behavior, backup form values and successful recipient preference saving. Its receiving page measured exactly 390 px with a 358 px dialog after correcting grid/table minimum widths. Logs, result JSON and screenshots use the ignored `.data/asset-icons-*` prefix. The review server is stopped and no feature worktrees remain.

## Recovery and accounting fixes verified locally

- Payroll file imports now preserve base pay, bonuses, signed corrections, notes and per-row fee ceilings through saving and recurring copies. The earlier CSV path silently retained only net amounts. A real browser upload verified 200 base plus 5 bonus minus 1 correction, with a 1 USDC ceiling, in the saved review. Mismatched totals, duplicate recipients, unjustified corrections and overflow are rejected.
- Generic top-ups and funding links expose final NEAR credit verification from Treasury. Original payout history exposes source-receipt recovery, reporter attestations, recovered-USDC confirmation and unused-route closure through an explicit signer-bound review. Provider delivery alone cannot credit cash, and unavailable status cannot authorize refund closure.
- Pending generic funding remains pending until source activity is observed. Concurrent status refreshes cannot overwrite a newer uncertain source claim. Never-started expired routes can be closed deliberately; observed activity prevents a fresh deposit request.
- Personal payment history authorizes the exact historical owner before pagination and supports direct detail lookup outside the current page. Supplier requests, activity, funding/refunds, recurring templates, jobs, retained AI proposals and personal/company notices also expose older records. Personal notices link to the exact authorized payment or profile and retain accurate unread counts.
- Private AI draft inputs and verification evidence, plus private settlement evidence, can be inspected and downloaded with their existing permissions and no-store responses. Recipient receipts distinguish quoted output, provider reports and final recorded output, preserving the saved token decimals when a catalog entry disappears.
- Finance and project views include every reservation category and distinguish full invoice face debt from current installment funding. Invoice/payroll exports follow partial and replacement lineages without duplicating remaining debt, and preserve historical payee names.
- Existing database triggers already blocked competing invoice payments during active clearing. Typed conflicts and visible clearing links now explain those locks instead of exposing raw database failures or unusable payment controls. Installment drafts retain the original due date; already satisfied payroll members do not block unrelated unpaid members.
- Recurring recovery cannot bypass a held occurrence through pause/resume. Owner-only mandate controls expose actual limits and expiry. A worker rejects the wrong treasury binding and verifies the reviewed contract code before parsing its signing key or broadcasting.
- Payee confirmation binds personal payments and notices to the exact confirmed historical owner. Reassigning a profile cannot expose old salaries or invoice requests, reclaim a claimed invitation, or redirect an existing liability through refresh, replacement or a new installment.
- Payment queues paginate with exact historical payee names. Company totals cover all records, group partial/replacement lineages once and include full invoice debt separately from currently planned installment costs.
- Generic, linked and public funding paths record a source claim before wallet submission and save broadcast hashes immediately. Provider `PENDING_DEPOSIT` cannot reset an uncertain submission into permission to resend. An expired never-started public quote can be deliberately closed after status checks; late source activity blocks a new active quote.
- Wallet-bound team invitations verify actual linked ownership. Role dependencies, archival and restoration preserve access and audit history. Navigation and all payment screens expose permitted actions, and company links retain their context.

- Short or missing destination output cannot become full payment from provider `SUCCESS`. A final partial attestation preserves actual source spending and the original face liability, retires the original route and permits one separately approved remainder.
- Payroll and bill remainders retain their lineage through cancellation/replacement. A fresh individual approval cannot approve unrelated payroll drafts.
- A client earmark of 100 USDC with 40 credited and 60 reserved by its child remains conserved. Active-child reservations and in-flight coverage are not also counted as free client principal.
- Source refunds require the exact original quote, recovery address, source units and terminal provider evidence. Final chain receipts produce `refunded_verified`; explicit authorized attestations produce `refunded_attested`. Neither creates company USDC.
- Default Approvers can review source recovery without gaining preparer or spending authority. Closing a source leg changes its review identity so a fresh funding quote does not silently reuse the closed one.
- Closed funding jobs finish rather than poll forever. Public links stop accepting new deposits for closed linked obligations while existing transfers remain trackable.
- Reports distinguish actual treasury spending, client deposits, earned receipts and noncash setoff. Debt discharge does not become delivered tokens, cash income or profit.

## Remaining live and production gates

1. Configure Privy and demonstrate Google/email signup, linked NEAR owner setup, return access and provider recovery. The external wallet-provider guide is implemented; successful provider recovery has not been demonstrated.
2. Deploy fresh reviewed NEAR factory/treasury/clearing contracts and configure their IDs/code pins. The current storage layout has no legacy treasury migration. Compiling artifacts is not deployment.
3. Record real source funding, final canonical token credit, treasury balance refresh and a primary payout. Then demonstrate backup, timeout, refund and partial-delivery recovery without duplicate transfers. Automatic NEAR receipt lookup is best effort; advanced signer lookup remains available when the RPC needs it.
4. Configure a restricted executor and demonstrate scheduled execution, interruption and rebroadcast recovery under real onchain approvals. Short-lived Intents quotes must still be prepared near the permitted execution window; a calendar date does not extend quote validity.
5. Configure NEAR AI credentials and approved measurements, then demonstrate successful required verification with fictional documents, failure handling and retention/deletion behavior.
6. Configure optional email transport and verify actual delivery. Provider acceptance is not proof of arrival. The local role/company browser matrix passed; complete configured social-login, live wallet and private-inference privacy journeys before a public production claim.
7. Complete production dependency remediation and security review. An earlier scan reported 40 wallet-graph advisories; no forced SDK downgrade was applied. The successful build still reports the optional Privy Farcaster module and unused viem Tempo dependency warnings.

External payout settlement and unsupported-chain refund closures retain their explicit owner/funder/reporter trust boundaries. Private inference does not hide transfers on public payment chains. None of the local checks establishes a live track demonstration or organizer approval.
