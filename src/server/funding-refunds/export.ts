import { formatUnits } from "../../lib/money";
import { requirePermission, type AccessContext } from "../context";
import { rows } from "../db";
import { decrypt } from "../identity/crypto";
import { csvCell } from "../reconciliation/export";
import type { RefundTerms } from "./types";

export function fundingRefundExportRows(access: AccessContext) {
  requirePermission(access, "reports:read");
  const closures = rows<{ funding_id: string; provenance: string; confirmed_by: string; confirmed_at: string; terms_ciphertext: string }>("SELECT c.funding_id,c.provenance,c.confirmed_by,c.confirmed_at,r.terms_ciphertext FROM funding_refund_closures c JOIN funding_refund_reviews r ON r.id=c.review_id WHERE c.organization_id=? ORDER BY c.confirmed_at,c.funding_id", access.organizationId);
  return closures.map(closure => {
    const terms = JSON.parse(decrypt(closure.terms_ciphertext)) as RefundTerms;
    const difference = terms.reportedDepositedAmount === null ? "" : (BigInt(terms.reportedDepositedAmount) - BigInt(terms.refundedAmount)).toString();
    return { funding_id: closure.funding_id, source_asset_id: terms.source.assetId, source_symbol: terms.source.symbol, source_network: terms.source.blockchain, source_decimals: terms.source.decimals, refund_address: terms.refundTo, refunded_source_base_units: terms.refundedAmount, refunded_source_quantity: formatUnits(terms.refundedAmount, terms.source.decimals), provider_reported_deposit_base_units: terms.reportedDepositedAmount, unclassified_source_difference_base_units: difference, source_transaction_hash: terms.sourceTransactionHash, refund_transaction_hash: terms.transactionHash, provider_status: terms.providerStatus, refund_provenance: closure.provenance, company_usdc_credit: "0", confirmed_by: closure.confirmed_by, confirmed_at: closure.confirmed_at };
  });
}

export function fundingRefundExport(access: AccessContext) {
  const records = fundingRefundExportRows(access);
  const headers = ["funding_id", "source_asset_id", "source_symbol", "source_network", "source_decimals", "refund_address", "refunded_source_base_units", "refunded_source_quantity", "provider_reported_deposit_base_units", "unclassified_source_difference_base_units", "source_transaction_hash", "refund_transaction_hash", "provider_status", "refund_provenance", "company_usdc_credit", "confirmed_by", "confirmed_at"];
  const values = records.map(record => headers.map(header => record[header as keyof typeof record]));
  return [headers, ...values].map(record => record.map(csvCell).join(",")).join("\r\n");
}
