# Connected invoice intake and company integrations

This specification records the implemented G01 and G11 integration surfaces. Configured provider delivery remains distinct from local adapter checks. See the [competitive checklist](competitive-gap-checklist.md) for acceptance status.

## Invoice channels

Bills contains Invoice intake connections. The company owner authorizes an exact Telegram inbox, WhatsApp sender or company-operated folder connector. Administrators with company and document management access can inspect, retry and revoke connections. Each operation rechecks current membership and permissions. Intake never approves an obligation, changes a confirmed payee or sends money.

Telegram checks its webhook secret, configured chat and sender. WhatsApp checks Meta's challenge, raw-body HMAC, configured business account, phone number and sender. Missing or malformed signatures are rejected before occupying upload slots. A pending setup cannot reserve another company's inbox: an exclusive binding is acquired only after bounded provider identity verification. Proven reservations survive credential rotation until explicit revocation.

Telegram verifies bot identity using `getMe`. Meta requires app ID, app secret, access token and both `whatsapp_business_management` and `whatsapp_business_messaging` permissions. The adapter authenticates the app/token pair with `debug_token` before checking the configured WABA's phone membership. Phone discovery intentionally accepts only the first 100 returned entries; a larger account needs a supported configured number or manual upload. These checks run before each provider download, without cached provider authority. Old Meta setups missing app ID return to pending configuration.

Documents join the existing encrypted file inbox for human review. Repeated provider events and file hashes retain their original status instead of creating another liability. Originals, extracted text and event details follow the document retention policy; minimal deduplication records expire after 90 days. Revocation disables future intake and processing.

Provider visibility is explicit: Telegram and Meta can read documents sent through their services. Razor's application server receives plaintext and stores encrypted originals. Optional verified analysis uses NEAR AI Cloud. Saving a connection or completing a Meta challenge does not establish successful invoice delivery.

Browser uploads, channel intake and queued downloads share two process-local ingress slots. Each request checks its applicable authority before bounded reading, validates actual bytes even with a forged content length, and has a deadline and cancellation. Download addresses use a provider hostname allowlist, public-address resolution and pinned DNS; redirects are rejected. Native PDF extraction retains its separate single-parser resource limits.

For a folder connector, save the one-time intake-only credential in the company computer's secret environment, not in a repository. The variable below belongs to that computer, not the web service:

```sh
RAZOR_INVOICE_FOLDER_TOKEN=YOUR_INTAKE_ONLY_SECRET \
node --max-old-space-size=384 --import tsx scripts/watch-invoices.ts \
  --endpoint=https://YOUR_RAZOR_ORIGIN/api/invoice-ingress/CONNECTION_ID/upload \
  --folder=/absolute/invoices \
  --allow-read-folder=/absolute/invoices \
  --once
```

Omit `--once` for bounded repeated scans. The Linux connector limits scans to 100 top-level entries, skips links and oversized/unsupported files, and uses descriptor-anchored reads. Server event status controls retries. The issued credential cannot read company financial records, approve bills or pay recipients. Browser upload remains available when a provider or connector fails.

## Customer API and MCP

Company settings contains Customer API and MCP controls. The owner creates a named, expiring credential with selected read or draft scopes. Its secret appears once; only its hash is retained. Rotation immediately invalidates the previous secret while preserving request history. Revocation, owner changes and loss of the creator's membership or underlying permissions block subsequent requests.

API base: `/api/integrations/v1`. Authenticated `GET /schema` publishes exact inputs, outputs, scopes, paging, limits and error codes. Draft POSTs require an `Idempotency-Key`. The same key with identical normalized terms returns the existing record; changed terms conflict. Drafts enter the normal company review and recipient-confirmation workflows. There are no integration approval or execution scopes, routes or tools.

The stateless Streamable HTTP MCP endpoint is `/api/integrations/mcp`. Clients send a bearer header from their secret store. A fresh official SDK server binds each request to one current company principal. Its tool catalog covers scoped draft creation, record/status reads, attempt lookup and retained settlement evidence. The static catalog has no event subscriptions or SSE GET streams. API concurrency/rate leases apply to each request.

## Signed events

The owner can register public HTTPS webhook endpoints and inspect delivery attempts, disable endpoints, rotate signing secrets or replay resolved deliveries. Credentials, private addresses and document/payroll contents do not enter events. Durable database transitions publish payment, funding, invoice and payroll state changes with minimal resource IDs, status and applicable recorded amounts. A status event never proves recipient delivery beyond its underlying evidence.

Delivery uses a durable lease, up to eight attempts per replay cycle, bounded exponential backoff, DNS revalidation/pinning, HTTPS certificate validation, response limits and a five-second timeout. Private, metadata, non-global and ambiguous network destinations are rejected. Redirects are not followed. Current endpoint ownership is checked again before sending. Already transmitted requests can still arrive after disable or rotation.

Receivers verify `Razor-Signature` with constant-time comparison against `v1=hex(HMAC-SHA256(secret, Razor-Timestamp + "." + rawBody))`, reject timestamps outside five minutes, deduplicate payload `id` and track the largest sequence per resource. Retries/replays can arrive out of order. The payload version is `2026-11-01`. A successful HTTP response records receiver acceptance, not business settlement.

The regular worker CLI processes one pending channel event and up to five webhook deliveries serially per tick. `--organization` also scopes event publication, lease recovery and claims. A failed connected service does not prevent the other services from running during that tick. Continuous delivery requires the worker process; a workspace page does not schedule it.


## Supported accounting extensions

QuickBooks Online and Xero plans cover reviewed bills, terminal full or partial settlements, unapplied supplier credits, independently receipt-backed native-NEAR fee journals and explicitly approved FX differences. Source and provider revisions are hashed separately. Unknown writes remain held for read-only reconciliation under the original external identity. Partial postings use only the terminal delivered entitlement; the original face value and unpaid remainder remain separate. Provider records do not create cash or prove delivery.

The NetSuite connector supports per-company confidential PKCE OAuth, account-derived HTTPS endpoints, inspected metadata/subsidiary/currency/account mappings, and non-tax two-line base-currency journals for verified mainnet NEAR fee groups. It does not imply NetSuite bills, supplier credits, payroll, tax filing or bank settlement. Required fields or unsupported account/schema configurations hold the plan. Review expires after thirty minutes; one write uses the original durable external ID, and unknown results permit only read-only reconciliation. A changed provider revision needs explicit inspected-hash acknowledgment. The serial worker dispatches at most one NetSuite job per tick.

No banking import is offered in this release. Existing read-only QBO/Xero accounting-activity matching uses exact durable Razor markers and source terms; unmatched records remain unresolved.
