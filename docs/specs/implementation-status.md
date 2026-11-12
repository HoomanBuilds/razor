# FLOAT implementation status

This review records the build evidence available on 12 November 2026. The [build checklist](../build-checklist.md) remains the completion authority: 82 core requirements, 8 optional requirements and 37 additional scenarios, journeys, usability, integration and track gates. No requirement was removed or narrowed for this review.

**9 of 127 checks are verified: 8 core requirements and one backup-profile scenario.** An unchecked item often has substantial code already. It remains unchecked when the complete requirement, its integration or its real execution has not been demonstrated.

## What has been demonstrated

| Evidence | Result | Limit |
| --- | --- | --- |
| Local HTTP workflow with real EVM challenge signatures | Created a company, confirmed recipient consent, drafted and approved an invoice and payroll into `approved_unfunded`, rejected an exact duplicate and denied an unrelated company with 403 | No source deposit or payout occurred; confirmed treasury balance remained zero |
| Actual supported-asset catalog request | Returned 230 assets across 39 chains | A point-in-time response, not a hardcoded support promise or proof every route can execute |
| CDP browser checks | Overview and payroll rendered; no console exceptions; 390 px viewport had no horizontal overflow | Does not establish all forms, wallet interactions, accessibility or complete mobile journeys |
| Earlier combined JavaScript suite | 18 tests passed before later feature slices | Not the final combined suite |
| Subsequent focused checks | Identity, imports, recipient workspace, business terms, private inference rejection, reconciliation, funding instructions, funding links, onboarding, operations and payment-management checks were reported passing | Several provider and chain responses use fixtures; they cannot establish live integration completion |
| NEAR contract checks | Treasury: 9 VM tests; factory: 4 VM tests; WASM artifacts built | No deployed factory or treasury, live owner signature, worker transfer or final receiving-chain receipt |
| Build checks | One earlier memory-capped Next production build passed; integrator reports TypeScript passing after later integration fixes | Final combined tests, HTTP path checks and production build remain pending |

The local workflow evidence is stored in `.data/workflow-check-result.json` and `.data/workflow-browser-result.json`, with overview and payroll screenshots beside them. These are local review artifacts, excluded from version control; they do not contain a recorded source commit. This source review started at `6f3edfa`. Later integration fixes were reported by the integrator and need final candidate verification.

Verified checklist IDs are `AUTH-02`, `AUTH-03`, `REC-02`, `REC-04`, `REC-07`, `BILL-01`, `ROUTE-06`, `AI-06` and `FALL-08`. Local rejection checks can establish a guard without establishing the financial journey that uses it. For example, rejecting an unresolved attempt as a backup trigger does not demonstrate a completed refund or backup payout.

## Implemented areas and remaining gates

| Area | Present in the reviewed source | Still needed before the full requirements can be checked |
| --- | --- | --- |
| Identity and company access | Signed wallet challenges, sessions, verified social-token handling, company creation, role permissions, invitations, company scoping and wallet links | Real configured social login, NEAR signing, return access, recovery, invitation lifecycle and full role/privacy matrix. `AUTH-01`, `AUTH-05` through `AUTH-10`, `WAL-01` through `WAL-08`, `ORG-01` through `ORG-05` remain open |
| Payees and recipient workspace | Versioned confirmation, primary and consented curated USDC backup, CSV intake, persistent recipient access and private invoice requests | Complete destination validation and required metadata across advertised assets, changed-profile notification and integrated reapproval/cancellation behavior. `REC-01`, `REC-03`, `REC-05`, `REC-06` remain open |
| Payroll | Period liabilities, exact integer amounts, CSV entry, draft net adjustments and supplied notes, review tokens, batch approval and explicit replacement of cancelled unpaid items | Final mounted-route and interface checks; organization time-zone behavior; funded reservation, scheduled execution, partial results and recovery with actual receipts. All `PAY-*` gates remain open |
| Bills | Structured intake, exact-reference and document-fingerprint deduplication, review-bound individual and batch approval, milestone acceptance, disputes and installment accounting | Suspiciously similar request handling, positive private extraction, recurring execution and actual partial/final settlement. Only `BILL-01` is verified; `BILL-02` through `BILL-08` remain open |
| Treasury and source funding | Dynamic Intents assets, independent funding legs, connected-wallet instructions, approved-obligation top-ups, scoped funding links and owner-bound NEAR treasury setup | Real wallet deposit, final canonical token credit, authoritative cash synchronization, refund closure and linked payout failure recovery. Planner and client-reserve changes require their own integration evidence. All `TRE-*` gates remain open |
| Payout authority and recovery | Signed quote preservation, primary-first selection, exact authorized routes, native NEAR USDC direct route, one active attempt, immutable recipient snapshots, final receipt verification, recovery queue and cumulative costs | Deployed contract enforcement and real primary, backup, timeout, refund, partial-delivery and restart journeys. Only the local unknown-outcome guard `ROUTE-06` and profile scenario `FALL-08` are verified |
| Private assistant | NEAR AI Cloud integration using encrypted inference, required deployment and gateway pins, attestation/request checks, encrypted retained drafts, manual review and no alternate-provider fallback | Configured credentials and approved deployment pins, successful verified inference, inspectable real evidence, retention/deletion and injected-document end-to-end checks. Only `AI-06` is verified |
| Worker and operations | Durable job claims, bounded recurring drafts, execution mandates, restricted executor-key checks, prepared transaction journaling, pause checks and in-app notices | Real restricted-key execution, restart/duplicate-broadcast recovery, recipient notices and ownership/credential recovery. In-app notice records do not establish external email delivery. All `OPS-*` gates remain open |
| Accounting and privacy | Scoped ledger and reconciliation views, CSV with formula-injection protection and large-record fixtures, encrypted sensitive documents and settlement notes, hashed onchain evidence | Full privacy/retention matrix, final receipt-to-liability trace, reserve accounting and actual costs/refunds. All `DATA-*` gates remain open, including the optional project view |
| Optional scope and track claims | Optional netting, retained original assets and project attribution retain their catalog entries | No optional requirement or track gate is verified. Ordinary routing is insufficient evidence for a DeFi claim; separate agent coordination and consent are required for a swarms claim |

The successful catalog query does not make a removed asset executable. A saved preference can remain recorded while quoting is unavailable. Native USDC backups remain limited to reviewed enabled networks, and consent does not itself authorize a payout.

## Integration findings from this review

- Payment-management services existed without their organization route being mounted. The integrator added the route and payment panel; final combined HTTP and UI checks are pending.
- A disputed invoice's encrypted reason was also copied into ordinary activity details. The integrator changed the event to status only; verify the final candidate exposes the private reason only through the authorized finance record.
- Resuming a saved unsigned public funding quote skipped frozen treasury-target revalidation. The integrator added revalidation, a deposit-disabled reason and a hidden deposit action while keeping submitted-transfer tracking available. Verify changed-owner, revoked-link and resumed-browser paths against the final candidate.

These findings were corrected in the integration worktree after this review's source snapshot. They are recorded as follow-ups, not as completed end-to-end checks. No deep security audit was performed.

## Next verification pass

1. Record the final source commit and run the existing combined suite and production build serially with the configured Node runtime. Recheck the newly mounted review/approval routes and the planner/reserve integrations.
2. Exercise fresh onboarding, invitations, recipient access and role changes in the browser. Review exact payroll and bill terms, edit them after preview, and confirm stale approval is rejected.
3. With configured NEAR services and an owner-controlled deployed treasury, record a real source deposit and canonical final credit, then an approved primary payout. Keep source-sent, provider-reported completion and verified recipient delivery separate.
4. Record backup, refund, timeout and partial-delivery cases without introducing a second payable attempt. Export the final linked obligation, costs, evidence and remaining liability.
5. With NEAR AI credentials and approved deployment pins, run fictional invoices through successful required verification and failure paths; inspect retention/deletion and confirm no analysis can approve or execute money movement.

Provider credentials can be supplied later. Their absence keeps the corresponding readiness and evidence gates open while product implementation continues. Until these passes succeed, describe FLOAT as an implemented development build with verified local workflows and guards, rather than a completed live payments or private-inference deployment.
