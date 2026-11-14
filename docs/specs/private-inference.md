# Private invoice extraction

Razor sends invoice text to NEAR AI Cloud through `@nearai/inference-sdk/node`. The assistant extracts a draft. It has no treasury key, payment tool, recipient mutation or approval permission.

The server verifies fresh Gateway and model attestations before sending invoice text. Verification checks Intel collateral, report nonces, measurement binding, approved deployment configuration, NVIDIA GPU evidence and the Gateway TLS key. The invoice fields are encrypted to the verified model key. Razor accepts output only after the SDK verifies the `provider_tee` signature against the exact request and response bytes. Gateway-only receipts and model fallback are rejected.

Razor's application server receives the original text and decrypted output. This feature protects inference transport and processing; it does not conceal invoices from the organization or its application operator. A valid attestation proves the checked execution identity and byte binding. It does not establish that an invoice is truthful or the model's extraction is correct.

## Invoice file intake

The Bills workspace accepts PDF, PNG and JPEG originals up to 3 MB. Files, filenames, extracted text and retained review data are encrypted in company-scoped storage. Uploading does not approve payment, select a new receiving address or require an AI credential. A preparer can inspect the source, correct text and agree a USDC obligation manually before creating the ordinary approval draft.

PDFs support up to eight pages. Text PDFs use isolated extraction; scans and mixed text/image PDFs use bounded page rasterization before verified NEAR AI image processing. Image content uses the same SDK field encryption, model identity and signed-response requirements as text. The chosen model must support image input. Missing credentials, tools or unsupported model input leave an explicit manual-review path, without another inference provider.

PDF processing requires Linux `prlimit`, `pdfinfo`, `pdftotext` and `pdftoppm` in the standard system binary directories. Readiness reports missing tools. One native parser job runs at a time with 256 MB address-space and bounded CPU, runtime, page count, image dimensions, output and temporary files. Images are limited to 4,000 pixels per side and 12 megapixels. Upload requests are separately authenticated and bounded; the ordinary API request limit stays 1 MB.

`DOCUMENT_RETENTION_DAYS` is an integer from 1 to 30, default 7. It controls the retained file/source record separately from inference-draft retention. Expiry or explicit deletion removes the original and associated retained analysis without deleting a previously created bill, its approval or payment history. Cleanup runs on document access and through the existing operations retention job. Backups follow the operator's storage policy. [Connected invoice intake](connected-intake-and-integrations.md) adds separately authorized folder, Telegram and WhatsApp adapters; real provider delivery requires their configured credentials and callbacks.

## Optional payroll column suggestions

Payroll import can request header-only suggestions through the same verified NEAR AI client with a dedicated column-mapping prompt. The user sees exactly which headers will be sent. CSV rows, filenames, recipients, addresses and pay values are excluded; header names themselves can contain sensitive data. The endpoint requires current payroll preparation, payment read and document management permissions and reserves one existing company private-AI attempt. Duplicate request identities and concurrent company suggestions are rejected.

Responses use opaque IDs for actual headers and an allowlist of payroll fields. Invented/reused columns, unsupported fields, malformed JSON and oversized output fail closed. The user reviews model confidence and warnings before applying suggestions, then separately confirms formats, payees and deterministic amounts. Model output cannot calculate salaries, invent FX, modify recipients or approve payments. Suggestions are held in the page and not retained as a new private artifact. Applying a mapping uses the existing encrypted import draft and retention. Missing configuration or verification failure leaves manual mapping available, without a provider fallback.

## Configuration

Use Node.js 24.22.1 or newer. Configure these server variables:

| Variable | Purpose |
| --- | --- |
| `NEAR_AI_API_KEY` | NEAR AI Cloud credential |
| `NEAR_AI_MODEL` | Explicit attestation-capable model ID; no automatic fallback |
| `NEAR_AI_MODEL_COMPOSE_SHA256` | Comma-separated SHA256 hashes of approved model `appCompose` UTF-8 strings |
| `NEAR_AI_GATEWAY_COMPOSE_SHA256` | Equivalent approved Gateway deployment hashes |
| `NEAR_AI_MAX_ATTESTATION_AGE_MS` | Maximum verified session age, default 120000, allowed 10000-300000 |
| `NEAR_AI_RETENTION_DAYS` | Encrypted draft/input/evidence retention, default 7, allowed 0-30; 0 returns an ephemeral draft |
| `DATA_ENCRYPTION_KEY` | Existing 32-byte application encryption key, required in production when retention is enabled |

Deployment pins must be approved from independently reviewed release configuration. Do not automatically trust or pin the next report returned by the endpoint. A changed deployment requires an intentional pin update. Intel TCB status must be `UpToDate` or `SWHardeningNeeded`; model GPU evidence is required.

## API and retention

All endpoints require an authenticated organization membership with `documents:manage`.

- `GET /organizations/:orgId/assistant/config` reports readiness and missing settings without exposing credentials.
- `POST /organizations/:orgId/assistant/analyze` accepts `{text}`, at most 20000 characters, and returns `{id,draft,verification,retained,expiresAt,requiresReview:true}`.
- `GET /organizations/:orgId/assistant/drafts` lists unexpired, authorized drafts.
- `GET /organizations/:orgId/assistant/drafts/:id/evidence` returns encrypted-at-rest evidence after authorized decryption.
- `DELETE /organizations/:orgId/assistant/drafts/:id` deletes retained input, output and evidence. The audit log retains opaque IDs and action names.

Expired rows are removed when the assistant is used. The exported `purgeAssistantRetention()` can also run from the server's scheduled worker. Deletion removes database records; backups and SQLite page retention follow the operator's storage policy. No invoice text is written to application logs. SDK response buffers are cleared after each analysis.

Retained evidence includes attestation reports, the signed receipt, input/output digests and the actual encrypted request/response wire bodies when captured. Historical records without those bodies remain incomplete. The ordinary hosted and company-local modes discard ephemeral decryption keys; encrypted wire verification is not a complete decrypted replay bundle. Only the separately acknowledged company-local replay option below deliberately retains per-request secrets.

The public packet verifier and standalone `scripts/verify-evidence.ts` CLI work offline for byte hashes and completion signatures. Hardware revalidation is an explicit network option (`--hardware` in the CLI). It uses the installed official NEAR AI SDK to revalidate Intel quote/signing-key and deployment measurements, require NVIDIA GPU evidence by default, and bind the completion signature to the authenticated model signer. Network mode can disclose public quote/GPU evidence to collateral and attestation services through SDK endpoints. Nothing is uploaded to the Razor application.

Independently reviewed trust inputs can specify approved compose hashes, accepted TCB statuses, original challenge nonces and an independently observed original gateway TLS SPKI fingerprint. The default accepted TCB is `UpToDate`; stale, revoked or unknown TCB values are never silently accepted. Packet-provided nonces and TLS fingerprints do not establish their own freshness or observation. Current collateral validation does not prove historical freshness at execution, source-build provenance, decrypted invoice content, model correctness or destination settlement. Each claim retains its own passed, failed, unavailable or not-checked result.

The review screen must show extracted currency, warnings and recipient observations. Foreign currency amounts require an explicit USDC-denominated obligation entered by the payer. Invoice payment instructions never replace a receiver-confirmed payout profile.

Verification follows the official [SDK guide](https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md) and [API reference](https://github.com/nearai/inference-sdk/blob/main/js/docs/api-reference.md).

## Settlement evidence

Manually entered settlement and refund references are encrypted in private storage for 30 days. Financial authorization sends only their SHA-256 commitments to the NEAR treasury. The company can inspect retained evidence, while expiration removes its plaintext recovery path and preserves the commitment and accounting history. Public transaction identifiers remain visible where needed for transfer reconciliation.


## Company-local replay and conditional timing evidence

The own-key invoice command supports explicit replay export with `--replay-keys`, `--replay-digests`, `--acknowledge-replay-key-disclosure`, `--packet` and `--packet-mode encrypted_wire`. It preserves exact signed encrypted wire data, uses the pinned SDK 0.3.0 Ed25519 E2EE v3 codec, and writes separate new local mode-0600 files. Only nonstream JSON-object Chat Completions using the current two-message string/image invoice format are supported. Tools, streams and unsupported transports fail closed.

The secret file contains this request's field-level ephemeral X25519 secrets and client reply secret, never a model or API private key. Possession of the reply secret unlocks all supported reply fields. It must stay outside repositories, synchronized folders and public shares. The separate digest file is a local observation; a verifier must independently decide which source/model/content hashes they trust. Local verification exposes only claim results and coverage, with incomplete or undisclosed fields marked accordingly. Hardware identity, invoice facts and payment settlement are not inferred from successful replay. Clearing mutable buffers cannot erase JavaScript strings, copied files or backups.

Optional timing uses `scripts/inference-anchors.ts`: prepare a fresh blinded challenge, explicitly sign it in the recorder wallet, collect its FINAL execution, run own-key inference, prepare the exact response/report commitment, explicitly sign that second action, and collect the completed evidence within the independently accepted interval. The invoice command accepts the collected challenge using `--anchor-trust`, `--anchor-challenge`, `--anchor-rpc-url` and `--anchor-observation`, alongside an encrypted-wire packet. Replay-secret export remains optional. Actual Gateway/model quotes bind the chain challenge, transport pins the original verified Gateway TLS key, and the independent local observation retains that public fingerprint for later review.

The optional stateless `razor-evidence` contract emits commitments only, holds no company funds and requires no per-company storage. It must already be deployed with all access keys retired, followed by a later finalized block. The two recorder transactions still cost native gas. A prepared action, unsigned descriptor or session record is not a completed timing proof. Accepted validator-randomness assumptions, current Intel/NVIDIA collateral and verifier-selected archival RPC observations remain explicit. The observer is not a NEAR light client. Independently reviewed trust must supply the recorder, context, model, contract/code hash, measured deployments, timing interval and accepted assumptions. No packet self-authorizes those expectations.

## Payment evidence classes

Separate strict destination evidence observes actual native NEP141, finalized ERC20 or finalized legacy SPL transfers. Fee/rebase ambiguity, unsupported Token-2022 extensions, missing historical balances and unsupported finality stay unavailable. Each observer requires the verifier's chosen RPC and independently reviewed exact destination expectations.

Settlement-link evidence separately binds one unbatched shared-treasury full-delivery attempt. The native class requires its actual canonical token call/event and successful payment callback in the same complete FINAL transaction graph, plus historical code and immutable terms. The cross-chain class verifies that an authorized NEAR reporter committed the exact structured statement for the same payment/attempt and actual output. That is a reporter attestation, not trustless bridge causality. Destination observation remains an additional independent claim. Legacy free-text or expired receipts are never reconstructed as structured proof.

Payment history exposes local proof export, and Reconciliation connects structured report preparation to the ordinary explicit NEAR authorization review. Preparing or exporting a report never signs automatically or updates recipient balances.
