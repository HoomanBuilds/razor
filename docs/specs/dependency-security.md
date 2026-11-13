# Dependency security review

Reviewed on 13 November 2026. Run `npm audit --omit=dev` again before release because advisory data and package releases change. An audit count includes affected parent packages as well as the underlying vulnerable dependency; it does not count distinct exploitable attacks.

## Applied remediation

- Update Privy React Auth from 3.51.3 to 3.51.4 within the supported major version. Install its declared optional Farcaster Solana peer so the application's social-login bundle resolves its imports. Razor still exposes Google, email and passkey login; installing the peer does not enable Farcaster login.
- Resolve transitive viem versions to the application's current supported viem 2 release, and replace affected WebSocket 8 releases with 8.23.0. WebSocket 7 consumers retain their supported major.
- Use UUID 11.1.1 for the reviewed MetaMask consumers. They use named `v4`, `validate` and filesystem temporary-name calls. Version 11 retains CommonJS and browser exports for those APIs. This avoids imposing UUID 14's ESM-only module boundary on those callers.
- Use Jayson 5 for Solana Web3's browser JSON-RPC client. Solana imports `jayson/lib/client/browser`, whose constructor, request IDs and callback result/error contracts remain available. Jayson 5 removes its vulnerable `stream-json` and old UUID dependencies and uses Web Crypto for request IDs. Razor requires Node 24 and secure browser wallet contexts.
- Update the unused query-string dependency declared by older WalletConnect utilities to version 10, removing its vulnerable decode-uri-component dependency. Published utils 2.21.0 source maps show that its URI parser/formatter already uses URLSearchParams; neither query-string nor the vulnerable decoder is bundled there. This is dependency hygiene rather than a fix for a demonstrated runtime decoder exposure. Version 10 requires Node 22 or later, within Razor's Node 24 requirement, and its ESM default API remains loadable from Node 24 CommonJS. Checks exercise the actual WalletConnect URI APIs and the resolved query module separately.
- Enable Next.js package-import optimization for `viem/chains` so unused chain definitions do not pull Tempo's dynamic dependency loader into the payment bundle. This preserves the library's chain definitions instead of copying them into application configuration or suppressing compiler warnings.

The narrow overrides are recorded in `package.json` and the lockfile. `tests/dependency-compatibility.test.ts` exercises Solana RPC success/error callbacks, each overridden WalletConnect URI boundary, and the MetaMask UUID APIs. All three compatibility checks passed against the installed resulting graph. Production build and browser verification remain separate integration checks owned by the final combined review.

## Remaining upstream advisories

The remediated lockfile reports **25 production package findings: 22 high and 3 low**, compared with 40 before remediation. They arise from three underlying advisory families. No forced SDK downgrade, signature-verification bypass or cross-major Zod substitution was applied.

| Dependency and advisory | Reviewed use and boundary | Remaining action |
| --- | --- | --- |
| Zod 3, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Razor's own server schemas use patched Zod 4.6.7. Privy, x402, Reown and Farcaster packages still depend on Zod 3. The advisory concerns resource exhaustion when validating oversized collections. Razor does not call x402 paid APIs, expose Farcaster sign-in or use AppKit's wallet UI, but these remain upstream wallet graph dependencies. | A supported update of those SDKs to patched Zod is needed to clear the audit. Forcing their Zod 3 dependency to Zod 4 changes parsing APIs and error shapes and has not been treated as a safe fix. Complete configured provider journeys before release. |
| bigint-buffer, [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | Solana SPL Token pulls this package through buffer-layout-utils. Razor imports SPL Token inside the browser funding adapter. Its browser package mapping uses a JavaScript implementation rather than the native C++ conversion implicated by the advisory. Razor's server does not import SPL Token or pass untrusted buffers to the native converter. | Upstream has no patched release. Keep its use confined to the browser adapter; review any future server import. Do not substitute an archived native fork solely to make the audit count disappear. |
| elliptic, [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) | NEAR AI's DCAP verifier pulls elliptic for its browser compatibility implementation. Razor uses the SDK's Node entrypoint; the verifier uses Node's crypto implementation when X509Certificate is available. The advisory concerns ECDSA signing, while DCAP use is verification. Razor does not sign with elliptic or give it treasury keys. | Upstream has no patched release. Retain required DCAP verification and the Node runtime boundary; recheck when NEAR AI or DCAP releases a supported replacement. |

These are explicit residual findings rather than a claim of zero vulnerabilities or a third-party security certification. Import-path review narrows exposure but does not replace live provider verification or ongoing dependency maintenance.

## Primary references

- [Privy package metadata](https://www.npmjs.com/package/@privy-io/react-auth) and [Farcaster Solana peer](https://www.npmjs.com/package/@farcaster/mini-app-solana).
- [Jayson browser client source](https://github.com/tedeh/jayson/blob/master/lib/client/browser/index.js) and [UUID change log](https://github.com/uuidjs/uuid/blob/main/CHANGELOG.md).
- [Next.js package import optimization](https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports).
- Fixed advisory families: [WebSocket memory disclosure](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [WebSocket memory exhaustion](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), [UUID buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [URI decoder exhaustion](https://github.com/advisories/GHSA-qr28-fpjm-wq7f), [stream-json prototype pollution](https://github.com/advisories/GHSA-mjw6-4jj6-33hc).
