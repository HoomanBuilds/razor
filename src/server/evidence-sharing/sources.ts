import { portablePacketSchema } from "../../lib/verification/packet";
import { ApiError, type AccessContext } from "../context";
import {
  assertDraftPacketSource,
  exportDraftPacket,
} from "../assistant/service";
import {
  assertFinancePacketSource,
  exportFinancePacket,
} from "../assistant/finance/service";
import type { ShareSourceKind } from "./model";

export function evidenceShareSource(
  access: AccessContext,
  kind: ShareSourceKind,
  id: string,
) {
  switch (kind) {
    case "invoice_analysis":
      return assertDraftPacketSource(access, id);
    case "finance_proposal":
      return assertFinancePacketSource(access, id);
    default:
      throw new ApiError(
        409,
        "No supported server portable-packet exporter is configured for this source. Use its existing company evidence controls; uploaded packets cannot become company proof",
        "EVIDENCE_SHARE_SOURCE_UNAVAILABLE",
      );
  }
}
export function exportShareSource(
  access: AccessContext,
  kind: ShareSourceKind,
  id: string,
  disclosure: "encrypted_wire" | "metadata",
) {
  evidenceShareSource(access, kind, id);
  const packet = portablePacketSchema.parse(
    kind === "invoice_analysis"
      ? exportDraftPacket(access, id, disclosure)
      : exportFinancePacket(access, id, disclosure),
  );
  if (
    packet.subject.kind !== kind ||
    packet.subject.id !== id ||
    packet.disclosure.mode !== disclosure ||
    packet.disclosure.plaintextIncluded !== false ||
    packet.disclosure.decryptionKeysIncluded !== false
  )
    throw new ApiError(
      409,
      "The server packet does not match this reviewed source and disclosure scope",
      "EVIDENCE_SHARE_PACKET_INVALID",
    );
  return packet;
}
