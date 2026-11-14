import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PacketVerifier } from "../src/components/verification/packet-verifier";
import { PortableEvidenceExport } from "../src/components/verification/packet-export";

test("public verifier starts in offline local-file mode with visible independent trust and hardware limits", () => {
  const html = renderToStaticMarkup(createElement(PacketVerifier));
  assert.equal((html.match(/type="file"/g) || []).length, 2);
  assert.match(html, /No workspace sign-in, AI key or file upload is required/);
  assert.match(html, /Offline checks make no network requests/);
  assert.match(html, /independently reviewed trust input/);
  assert.match(html, /does not replace Intel\/NVIDIA hardware verification/);
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
