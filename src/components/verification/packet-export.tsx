"use client";

import { EvidenceShareControl } from "@/components/evidence-sharing/controls";
import { useState } from "react";
import { control } from "@/components/workspace/shared";

export function PortableEvidenceExport({ endpoint }: { endpoint: string }) {
  const [disclosure, setDisclosure] = useState("encrypted_wire");
  const source =
    /^\/organizations\/([A-Za-z0-9_-]{1,128})\/assistant\/(drafts|finance\/plans)\/([A-Za-z0-9_-]{1,128})$/.exec(
      endpoint,
    );
  return (
    <div className="mt-4 grid gap-4 text-sm">
      <label className="grid gap-2 text-[13px] font-medium">
        Export format
        <select
          className={control}
          value={disclosure}
          onChange={(event) => setDisclosure(event.target.value)}
        >
          <option value="encrypted_wire">
            Encrypted responses and verification reports
          </option>
          <option value="metadata">Metadata only</option>
        </select>
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        {disclosure === "metadata" ? "Metadata cannot verify response signatures." : "Excludes document text and decryption keys. Older records may lack signed responses."} Downloads cannot be revoked.
      </p>
      <div className="flex flex-wrap gap-4">
        <a
          className="text-primary"
          href={`/api${endpoint}/packet?disclosure=${disclosure}`}
          download
        >
          Download packet
        </a>
        <a
          className="text-primary"
          href="/verify"
          target="_blank"
          rel="noreferrer"
        >
          Open verifier
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
