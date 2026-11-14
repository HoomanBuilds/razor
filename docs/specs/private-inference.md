# Private invoice extraction

Razor sends invoice text to NEAR AI Cloud through `@nearai/inference-sdk/node`. The assistant extracts a draft. It has no treasury key, payment tool, recipient mutation or approval permission.

The server verifies fresh Gateway and model attestations before sending invoice text. Verification checks Intel collateral, report nonces, measurement binding, approved deployment configuration, NVIDIA GPU evidence and the Gateway TLS key. The invoice fields are encrypted to the verified model key. Razor accepts output only after the SDK verifies the `provider_tee` signature against the exact request and response bytes. Gateway-only receipts and model fallback are rejected.

Razor's application server receives the original text and decrypted output. This feature protects inference transport and processing; it does not conceal invoices from the organization or its application operator. A valid attestation proves the checked execution identity and byte binding. It does not establish that an invoice is truthful or the model's extraction is correct.

## Invoice file intake

The Bills workspace accepts PDF, PNG and JPEG originals up to 3 MB. Files, filenames, extracted text and retained review data are encrypted in company-scoped storage. Uploading does not approve payment, select a new receiving address or require an AI credential. A preparer can inspect the source, correct text and agree a USDC obligation manually before creating the ordinary approval draft.

PDFs support up to eight pages. Text PDFs use isolated extraction; scans and mixed text/image PDFs use bounded page rasterization before verified NEAR AI image processing. Image content uses the same SDK field encryption, model identity and signed-response requirements as text. The chosen model must support image input. Missing credentials, tools or unsupported model input leave an explicit manual-review path, without another inference provider.

PDF processing requires Linux `prlimit`, `pdfinfo`, `pdftotext` and `pdftoppm` in the standard system binary directories. Readiness reports missing tools. One native parser job runs at a time with 256 MB address-space and bounded CPU, runtime, page count, image dimensions, output and temporary files. Images are limited to 4,000 pixels per side and 12 megapixels. Upload requests are separately authenticated and bounded; the ordinary API request limit stays 1 MB.

`DOCUMENT_RETENTION_DAYS` is an integer from 1 to 30, default 7. It controls the retained file/source record separately from inference-draft retention. Expiry or explicit deletion removes the original and associated retained analysis without deleting a previously created bill, its approval or payment history. Cleanup runs on document access and through the existing operations retention job. Backups follow the operator's storage policy. Telegram, watched-folder and WhatsApp intake are separately tracked workstreams, not enabled by browser upload.

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

Retained evidence includes verified attestation reports, the signed receipt and input/output digests. SDK internal encrypted wire buffers and ephemeral decryption keys are discarded, so this is a verification record rather than a complete independent offline replay bundle.

The review screen must show extracted currency, warnings and recipient observations. Foreign currency amounts require an explicit USDC-denominated obligation entered by the payer. Invoice payment instructions never replace a receiver-confirmed payout profile.

Verification follows the official [SDK guide](https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md) and [API reference](https://github.com/nearai/inference-sdk/blob/main/js/docs/api-reference.md).

## Settlement evidence

Manually entered settlement and refund references are encrypted in private storage for 30 days. Financial authorization sends only their SHA-256 commitments to the NEAR treasury. The company can inspect retained evidence, while expiration removes its plaintext recovery path and preserves the commitment and accounting history. Public transaction identifiers remain visible where needed for transfer reconciliation.
