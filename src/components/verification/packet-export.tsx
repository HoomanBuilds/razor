"use client";

import { EvidenceShareControl } from "@/components/evidence-sharing/controls";
import { useState } from "react";

export function PortableEvidenceExport({ endpoint }: { endpoint: string }) {
  const [disclosure, setDisclosure] = useState("encrypted_wire");
  const source =
    /^\/organizations\/([A-Za-z0-9_-]{1,128})\/assistant\/(drafts|finance\/plans)\/([A-Za-z0-9_-]{1,128})$/.exec(
      endpoint,
    );
  return (
    <div className="mt-4 space-y-3 rounded-lg border p-4 text-sm">
      <p className="font-medium">Portable independent verification</p>
      <label className="flex flex-wrap items-center gap-3">
        Export disclosure
        <select
          className="rounded-md border bg-background p-2 text-xs"
          value={disclosure}
          onChange={(event) => setDisclosure(event.target.value)}
        >
          <option value="encrypted_wire">
            Encrypted signed wire bytes and reports
          </option>
          <option value="metadata">Metadata only, wire bytes redacted</option>
        </select>
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        Excludes invoice/payroll plaintext and decryption keys. Metadata-only
        exports cannot verify wire signatures. Old records may lack signed
        bytes. Local downloads cannot be revoked or expired remotely. A public
        link requires the separate explicit sharing action below.
      </p>
      <div className="flex flex-wrap gap-4">
        <a
          className="text-primary"
          href={`/api${endpoint}/packet?disclosure=${disclosure}`}
          download
        >
          Download portable packet
        </a>
        <a
          className="text-primary"
          href="/verify"
          target="_blank"
          rel="noreferrer"
        >
          Open local verifier
        </a>
      </div>
      {source ? (
        <EvidenceShareControl
          key={endpoint}
          organizationId={source[1]}
          sourceKind={
            source[2] === "drafts" ? "invoice_analysis" : "finance_proposal"
          }
          sourceId={source[3]}
          disclosure={disclosure === "metadata" ? "metadata" : "encrypted_wire"}
        />
      ) : null}
    </div>
  );
}
