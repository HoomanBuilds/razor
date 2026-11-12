import { requirePermission, type AccessContext } from "../context";
import { rows } from "../db";
import { decrypt } from "../identity/crypto";
import { formatUnits } from "../../lib/money";
import { reservePositions } from "./accounting";

export function clientReserveExportRows(access: AccessContext): Record<string, unknown>[] {
  requirePermission(access, "reports:read");
  const records: Record<string, unknown>[] = reservePositions(access.organizationId).map(({ reserve, state, outstanding, clientReserved, inFlight }) => ({ record_type: "client_reserve", record_id: reserve.id, client_reserve_id: reserve.id, created_at: reserve.created_at, status: state, payment_id: reserve.payment_id, funding_id: reserve.funding_id,
    description: decrypt(reserve.purpose_ciphertext), client_reference: reserve.client_reference_ciphertext ? decrypt(reserve.client_reference_ciphertext) : "", earmarked_principal_usdc: formatUnits(reserve.amount), earmarked_principal_micro_usdc: reserve.amount,
    client_cash_reserved_usdc: formatUnits(clientReserved.toString()), client_cash_reserved_micro_usdc: clientReserved.toString(), client_principal_in_flight_usdc: formatUnits(inFlight.toString()), client_principal_outstanding_usdc: formatUnits(outstanding.toString()), client_release_reason: reserve.release_reason_ciphertext ? decrypt(reserve.release_reason_ciphertext) : "", verification: "application_bookkeeping_earmark; NEAR_owner_contract_controls_funds" }));
  for (const event of rows<{ id: string; reserve_id: string; action: string; actor_id: string; details_ciphertext: string; created_at: string }>("SELECT * FROM client_reserve_events WHERE organization_id=? ORDER BY created_at,id", access.organizationId)) records.push({ record_type: "client_reserve_event", record_id: event.id, client_reserve_id: event.reserve_id, created_at: event.created_at, status: event.action, description: decrypt(event.details_ciphertext), verification: "audited_bookkeeping_change; not_a_token_transfer_or_income_receipt" });
  return records;
}
