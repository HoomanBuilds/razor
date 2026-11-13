# Production security review

This review covers the current Razor application and its NEAR authorization boundaries. It is a focused source review with local regression checks, not an independent audit, deployment certification or evidence of live settlement.

## Fixes

- SQLite database, WAL and shared-memory files use owner-only `0600` permissions. Newly created database directories use `0700`. Opening an existing database tightens its file permissions without discarding records or migrations.
- API responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, including authentication and error responses.
- Application documents disable referrer disclosure and indexing. Invitation and funding URLs still contain sensitive bearer tokens; access must remain scoped and expiry enforced.
- Wallet dependencies receive compatible security patches and reviewed compatibility checks. Remaining upstream findings are tracked separately; a successful build does not clear a dependency advisory.

## Reviewed boundaries

Wallet authentication verifies a fresh origin-bound challenge, consumes it once and separates app identity from financial authority. Linking and recovery changes require recent verified authentication. Company membership and permissions are checked server-side rather than inferred from visible navigation.

NEAR authority binds exact contract code, owner/approver/executor roles, policy and recipient versions, amount, cost ceiling, quote, destination and deadline. Source callbacks and final receipt identities remain separate from provider status. Refund and partial-delivery recovery preserve the original obligation and cannot issue a second payment while an earlier route might still deliver.

Clearing requires conserved obligations and separate company consent. Existing invoice locks prevent the same liability from participating in ordinary payment concurrently. Restricted workers can execute only an already authorized exact route and retain the same signed bytes when recovering an uncertain broadcast.

Private records and evidence retain their permission and historical-owner boundaries. Read-only setup checks do not open a database, send documents, email recipients, sign transactions or transfer funds. Deployment plans preserve atomic initialization and reviewed artifact identity, but they do not create or verify deployed accounts.

## Limits and live evidence

External-chain settlement is an owner or appointed reporter attestation. Razor does not turn a routing provider response into a cryptographic external-chain delivery proof. The selected NEAR RPC and provider responses remain trusted inputs.

NEAR AI privacy requires successful required deployment and response verification against approved measurements. Missing credentials do not switch private documents to another provider. Public receiving-chain transfers remain public even when invoice analysis is confidential.

Privy recovery, deployed contract ownership, restricted-worker execution, real source credit, payout and recovery, successful private inference and optional email delivery still require configured services and actual observations. Use the [operator runbook](operator-setup.md) and retain the resulting evidence in the [build checklist](build-checklist.md).
