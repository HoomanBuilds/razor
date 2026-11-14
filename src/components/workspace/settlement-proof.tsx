"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { StructuredSettlementReport } from "./settlement-links";

const SettlementLinkPanel = dynamic(
  () =>
    import("./settlement-links").then((module) => module.SettlementLinkPanel),
  {
    loading: () => (
      <p role="status" className="text-sm text-muted-foreground">
        Loading payment proof controls...
      </p>
    ),
  },
);

export function SettlementProof({
  attemptId,
  onReportPrepared,
}: {
  attemptId: string;
  onReportPrepared?: (plan: StructuredSettlementReport) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Portable payment proof{onReportPrepared ? " and structured report" : ""}
      </summary>
      {open && (
        <div className="mt-3">
          <SettlementLinkPanel
            attemptId={attemptId}
            onReportPrepared={onReportPrepared}
          />
        </div>
      )}
    </details>
  );
}
