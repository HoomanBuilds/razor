# Company operations

Razor keeps recurring drafts, due-payment notices and settlement checks in SQLite jobs. Jobs and notices survive process restarts. The worker creates payment drafts and executes only exact routes already approved on NEAR; it never approves a new route, selects a new fallback or marks external delivery from a source transaction alone.

Run one local tick or a persistent worker:

```sh
node --max-old-space-size=512 --import tsx scripts/worker.ts --once
node --max-old-space-size=512 --import tsx scripts/worker.ts
node --max-old-space-size=512 --import tsx scripts/worker.ts --organization=company-id
```

Use the same `DATABASE_PATH` and `DATA_ENCRYPTION_KEY` as the web application. The CLI processes up to 20 jobs serially per tick, then waits 15 seconds. HTTP `POST /organizations/:orgId/operations/tick` processes at most five jobs and requires `company:manage` plus `payments:read`. A separate process or scheduled task is required for continuous work; a web page alone does not run the scheduler.

The daily retention job also deletes expired encrypted invoice-file originals and purges expired payroll-import source/corrections. Document retention follows `DOCUMENT_RETENTION_DAYS` (default 7, range 1-30); payroll-import sources expire after seven days. Completed bills, pay runs and their accounting history remain available. Access-triggered expiry remains active when the background worker is stopped.

## Recurring drafts

Company managers with payment preparation access can capture an approved bill or pay run with an interval of 1 to 365 company-zone calendar days or 1 to 12 calendar months, first due date and maximum total entitlement per cycle. The encrypted snapshot binds approved amounts, fee ceilings, membership access and confirmed recipient versions. Changed source terms, changed receiving preferences, a disputed source or lost creator access hold the cycle. A manager reviews the change and creates a new template.

Each occurrence has one `(rule, due time)` identity, and its bill/payrun and payment drafts are written in the same SQLite transaction. A restarted or duplicate worker observes that occurrence rather than creating another. A late worker creates at most one catch-up cycle per rule per tick, preserving the original interval. Payroll period dates shift by the difference from the source's scheduled date or period end; calendar-month templates preserve their original day or selected month-end anchor, including short months and leap years. Their payroll period boundaries advance by calendar months instead of a fixed number of milliseconds. Initial due time is retained separately from the next occurrence so an idempotent retry cannot silently change the schedule.

Every generated obligation remains `draft` without an approver or signature. Source approval is not transferred to a future payment. Milestone requirements are preserved while acceptance evidence is cleared. Partial-installment invoice sources require a separate approved bill for the intended recurring amount or manual installment preparation; they are rejected rather than silently repeating the original full invoice liability.

## Execution and mandates

Without these optional server settings, due work stays labeled as requiring an owner wallet:

```text
RAZOR_EXECUTOR_ACCOUNT_ID
RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID
RAZOR_EXECUTOR_NETWORK=mainnet|testnet
RAZOR_EXECUTOR_PRIVATE_KEY
```

The key must be installed on a dedicated NEAR executor account and limited to exactly one receiver treasury and exactly `execute_payment`. A full-access key, unrestricted method list, other receiver, owner account or approver account is rejected. Key setup and gas funding remain operator actions; never paste a full-access owner key into the application. The owner's recovery keys stay with the account owner. The [NEAR access-key documentation](https://docs.near.org/protocol/accounts-contracts/access-keys) distinguishes gas allowances from permission to spend treasury assets.

The company owner also enables a local execution mandate with a source-amount ceiling and expiry and grants the executor role through an explicit owner wallet transaction. Either local mandate pause or onchain role revocation stops later worker submissions. The application can prepare that role transaction; saving a database mandate does not claim an onchain role was granted.

Before submission, the worker rechecks company pause, mandate bounds, recipient version, onchain pause, executor role, policy version and approval expiry. The latest attempt must already be owner/approver authorized. Obligation ID, reference, amount, fee ceiling, destination, exact input/output, quote hash and deadline must match persisted terms. It signs only a zero-deposit `execute_payment` call and never signs approval, settlement attestations or refund confirmation.

The signed transaction and hash are journaled before broadcast. After a crash or uncertain RPC response the worker reconciles chain state or replays those same signed bytes, with the same hash and renewed preflight checks. It does not invent a replacement quote or transaction to bypass uncertainty. Expired routes and final source failures require owner review. Signing remains credential-dependent; local checks do not prove live execution or settlement.

## Leases, pause and notices

Jobs use unique company-scoped keys and three-minute leases. Expired leases are reclaimable; acknowledgments require the matching live lease. Only one execution job holds a live lease at a time, limiting shared-key nonce races. Transient failures use bounded exponential backoff and become visible after eight failed runs. A completed business effect remains idempotent if the process stops before acknowledging its job.

Company pause blocks new recurring drafts, due-work execution and broadcasts. Reconciliation and expired-assistant-data purges continue. Source submission is never counted as final recipient delivery. Existing reconciliation services retain the distinction between pending, unknown, reported delivery, verified refund and final onchain closure.

Notices are an in-app outbox, scoped by company, optional user and required role permission. Read receipts are per user. Optional generic email updates use an explicit verified-account opt-in and configured Resend transport. Provider acceptance is recorded separately from inbox delivery. See [notifications](notifications.md). Expired private assistant drafts are purged daily by the worker, or immediately through a document manager's purge action.

## API and UI

Mount `operationsRoutes` at `/organizations/:orgId/operations` behind the existing session and company middleware. `OperationsPanel` uses the existing workspace context. The panel exposes recurring templates, the notice inbox, durable job status, execution bounds and explicit owner wallet role controls.

Routes are `GET /overview`, `GET /jobs`, `POST /jobs/:id/retry`, `POST /tick`, `GET/POST /recurring`, `PATCH /recurring/:id`, `GET /notices`, `POST /notices/:id/read`, `GET/PUT /mandate`, `POST /mandate/pause`, `POST /mandate/role` and `POST /retention/purge`. Financial reads require payment-read access. Template and job management require company management; mandates and role preparation additionally require the company owner. Retention purge requires document management. Notice reads use each notice's own permission scope.
