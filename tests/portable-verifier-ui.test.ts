import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PacketVerifier } from "../src/components/verification/packet-verifier";
import { PortableEvidenceExport } from "../src/components/verification/packet-export";

test("public verifier starts in offline local-file mode with visible independent trust and hardware limits", () => {
  const html = renderToStaticMarkup(createElement(PacketVerifier));
  for (const label of ["Evidence packet", "Separately reviewed signer, deployment and financial expectations", "Final challenge and response-commitment evidence", "Independently reviewed anchor trust", "Destination evidence", "Independent exact destination and token behavior expectations", "Settlement-link evidence", "Independent source, payment/route/version, reporter and destination trust"]) {
    assert.ok(html.includes(label));
  }
  assert.equal((html.match(/type="file"/g) || []).length, 8);
  assert.match(html, /No sign-in, AI credential, file\s*upload or wallet action is required/);
  assert.match(html, /Authorize bounded archival NEAR lookups/);
  assert.match(html, /Separately reviewed signer/);
  assert.match(html, /Intel\/NVIDIA collateral/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /disabled=""/);
});

test("private export control defaults to encrypted wire with clear redaction and non-revocation limits", () => {
  const html = renderToStaticMarkup(createElement(PortableEvidenceExport, { endpoint: "/organizations/fixture/assistant/drafts/fixture" }));
  assert.match(html, /packet\?disclosure=encrypted_wire/);
  assert.match(html, /href="\/verify"/);
  assert.match(html, /Metadata-only exports cannot verify wire signatures/);
  assert.match(html, /cannot be revoked or expired remotely/);
  assert.doesNotMatch(html, /includeKeys|includePlaintext/);
});
