import { formatUnits } from "../../lib/money";
import { requirePermission, type AccessContext } from "../context";
import { recordedRecipientName } from "../payments/recipient-names";
import { liabilityPayments } from "../partial-settlement/model";
import { liabilityTotals } from "./liability";
import { rows, transaction } from "../db";
import { decrypt } from "../identity/crypto";
import type {
  ChainPayment,
  FundingLeg,
  Payment,
  PayoutAttempt,
} from "../payments/types";
import { isDirectExecution } from "./direct";
import { clientReserveExportRows } from "../client-reserves";
import { fundingRefundExportRows } from "../funding-refunds/export";
import { creditExportRows } from "../invoice-credits/accounting";
import { clearingExportRows } from "../clearing/accounting";
import { financingExportRows } from "../financing/accounting";
import { expenseReturnAccounting } from "../expenses/accounting";

export function csvCell(value: unknown): string {
  let text = String(value ?? "").replaceAll("\u0000", "");
  if (
    !/^-?\d+(?:\.\d+)?$/.test(text) &&
    /^[\s\u0000-\u001f\u007f\uFEFF]*[=+\-@]/.test(text)
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function json<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function usdc(value: string | undefined | null): string {
  if (!value) return "";
  return value.startsWith("-")
    ? `-${formatUnits(value.slice(1))}`
    : formatUnits(value);
}

function tokenQuantity(value:string|undefined|null,decimals:number|undefined|null) {
  if(!value||decimals===null||decimals===undefined||!Number.isInteger(decimals)||decimals<0||decimals>38)return "";
  try{return formatUnits(value,decimals);}catch{return "";}
}

type RecordRow = Record<string, unknown>;

export function accountingExport(access: AccessContext): string {
  requirePermission(access, "reports:read");
  return transaction(()=>accountingSnapshot(access));
}

function accountingSnapshot(access:AccessContext):string {
  const payments = rows<Payment>(
    "SELECT * FROM payments WHERE organization_id=? ORDER BY created_at,id",
    access.organizationId,
  );
  const attempts = rows<PayoutAttempt>(
    "SELECT * FROM payout_attempts WHERE organization_id=? ORDER BY created_at,id",
    access.organizationId,
  );
  const funding = rows<FundingLeg>(
    "SELECT * FROM funding_legs WHERE organization_id=? ORDER BY created_at,id",
    access.organizationId,
  );
  const bills = rows<{
    id: string;
    payment_id: string | null;
    recipient_id: string;
    reference: string;
    title: string;
    amount: string;
    max_fee: string;
    status: string;
    created_at: string;
    project_reference: string | null;
    cost_center_reference: string | null;
    setoff_amount: string;
    funded_clearing_amount: string;
    accepted_credit_amount:string;
  }>(
    "SELECT * FROM bills WHERE organization_id=? ORDER BY created_at,id",
    access.organizationId,
  );
  const payroll = rows<{
    id: string;
    run_id: string;
    payment_id: string;
    recipient_id: string;
    reference: string;
    period_start: string;
    period_end: string;
    amount: string;
    max_fee: string;
    status: string;
    created_at: string;
  }>(
    "SELECT i.*,r.reference,r.period_start,r.period_end,r.status,r.created_at FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE r.organization_id=? ORDER BY r.created_at,i.id",
    access.organizationId,
  );
  const names = new Map(
    rows<{ id: string; name: string }>(
      "SELECT id,name FROM recipients WHERE organization_id=?",
      access.organizationId,
    ).map((recipient) => [recipient.id, decrypt(recipient.name)]),
  );
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const billByPayment = new Map(
    bills
      .filter((bill) => bill.payment_id)
      .map((bill) => [bill.payment_id!, bill]),
  );
  const payrollByPayment = new Map(
    payroll
      .filter((item) => item.payment_id)
      .map((item) => [item.payment_id, item]),
  );
  const billById = new Map(bills.map((bill) => [bill.id, bill]));
  const installments=rows<{bill_id:string;payment_id:string}>("SELECT i.bill_id,i.payment_id FROM bill_installments i JOIN bills b ON b.id=i.bill_id JOIN payments p ON p.id=i.payment_id WHERE b.organization_id=? AND p.organization_id=? AND p.recipient_id=b.recipient_id ORDER BY p.created_at,p.id",access.organizationId,access.organizationId);
  for(const installment of installments){const bill=billById.get(installment.bill_id);if(bill)billByPayment.set(installment.payment_id,bill);}
  const successors=new Map(rows<{old_payment_id:string;new_payment_id:string}>("SELECT original_payment_id AS old_payment_id,remainder_payment_id AS new_payment_id FROM partial_remainders WHERE organization_id=? UNION ALL SELECT old_payment_id,new_payment_id FROM payment_replacements WHERE organization_id=?",access.organizationId,access.organizationId).map(value=>[value.old_payment_id,value.new_payment_id]));
  const historicalNames=new Map(payments.map(payment=>[payment.id,recordedRecipientName(access.organizationId,payment)]));
  const runs = new Map(
    rows<{
      id: string;
      reference: string;
      period_start: string;
      period_end: string;
    }>(
      "SELECT id,reference,period_start,period_end FROM payroll_runs WHERE organization_id=?",
      access.organizationId,
    ).map((run) => [run.id, run]),
  );
  const sourceProofs = new Map(
    rows<{ attempt_id: string; receipt_id: string }>(
      "SELECT attempt_id,receipt_id FROM payment_source_receipts WHERE organization_id=?",
      access.organizationId,
    ).map((proof) => [proof.attempt_id, proof.receipt_id]),
  );
  const common = (payment: Payment | undefined): RecordRow => {
    if (!payment) return {};
    const metadata = json<{ billId?: string; runId?: string }>(
      payment.metadata,
      {},
    );
    const bill =
      billByPayment.get(payment.id) ??
      (metadata.billId ? billById.get(metadata.billId) : undefined);
    const item = payrollByPayment.get(payment.id);
    const run = metadata.runId ? runs.get(metadata.runId) : undefined;
    return {
      payment_id: payment.id,
      recipient_id: payment.recipient_id,
      recipient_name: historicalNames.get(payment.id),
      payment_kind: payment.kind,
      payment_reference: payment.reference,
      bill_id: bill?.id,
      bill_reference: bill?.reference,
      project_reference: bill?.project_reference ? decrypt(bill.project_reference) : undefined,
      cost_center_reference: bill?.cost_center_reference ? decrypt(bill.cost_center_reference) : undefined,
      payroll_run_id: item?.run_id ?? run?.id,
      payroll_reference: item?.reference ?? run?.reference,
      period_start: item?.period_start ?? run?.period_start,
      period_end: item?.period_end ?? run?.period_end,
    };
  };
  const creditRetirements=new Map(rows<{payment_id:string;note_id:string;original_amount:string}>("SELECT payment_id,note_id,original_amount FROM invoice_credit_retirements WHERE organization_id=?",access.organizationId).map(item=>[item.payment_id,item]));
  const records: RecordRow[] = [];
  for (const payment of payments) {
    const netCost =
      BigInt(payment.total_spent) -
      BigInt(payment.delivered_amount);
    const unpaid=BigInt(payment.amount)-BigInt(payment.delivered_amount),successor=successors.get(payment.id);
    records.push({
      ...common(payment),
      record_type: "obligation",
      record_id: payment.id,
      created_at: payment.created_at,
      status: payment.status,
      entitlement_usdc: usdc(payment.amount),
      entitlement_micro_usdc: payment.amount,
      delivered_entitlement_usdc: usdc(payment.delivered_amount),
      remaining_entitlement_usdc: usdc((payment.status==="cancelled"||successor?0n:unpaid).toString()),
      unpaid_recorded_entitlement_usdc:usdc(unpaid.toString()),
      credit_retirement_note_id:creditRetirements.get(payment.id)?.note_id,
      retired_draft_micro_usdc:creditRetirements.get(payment.id)?.original_amount,
      successor_payment_id:successor,
      transferred_entitlement_usdc:successor?usdc(unpaid.toString()):"0",
      max_cost_usdc: usdc(payment.max_fee),
      max_cost_micro_usdc: payment.max_fee,
      recorded_source_spent_usdc: usdc(payment.total_spent),
      recorded_source_spent_micro_usdc: payment.total_spent,
      recorded_net_cost_usdc: usdc(netCost.toString()),
      recorded_net_cost_micro_usdc: netCost.toString(),
      verification:
        creditRetirements.has(payment.id)?"unsigned_draft_retired_by_accepted_supplier_credit; original_face_history_only; see_invoice_residual; not_cash_or_refund":payment.status === "paid"
          ? "closed_by_NEAR_treasury_state; see_attempt_provenance"
          : payment.status === "cancelled"?"retired_payment; see_invoice_or_payroll_liability_and_successor":payment.status === "partially_paid" ? successor?"terminal_partial_NEAR_reporter_attestation; remaining_entitlement_transferred_to_successor":"terminal_partial_NEAR_reporter_attestation; remainder_requires_new_approval" : "unresolved_obligation",
    });
  }
  for (const attempt of attempts) {
    const payment = paymentById.get(attempt.payment_id);
    const execution = json<unknown>(attempt.quote, null);
    const evidence = json<{
      chain?: ChainPayment;
      provider?: {
        swapDetails?: {
          amountIn?: string;
          amountOut?: string;
          refundedAmount?: string;
        };
      };
    }>(attempt.reconciliation, {});
    const chainAttempt = evidence.chain?.attempts.find(
      (item) => item.id === attempt.id,
    );
    const sent =
      !!chainAttempt &&
      [
        "source_sent",
        "uncertain",
        "refund_pending",
        "refund_verifying",
        "refunded",
        "delivered",
        "partially_delivered",
      ].includes(chainAttempt.status);
    const recovered =
      chainAttempt?.status === "refunded" ? chainAttempt.refund_amount : "";
    const provider = evidence.provider?.swapDetails;
    const decimals = attempt.destination_decimals;
    records.push({
      ...common(payment),
      record_type: "attempt",
      record_id: attempt.id,
      created_at: attempt.created_at,
      status: attempt.state,
      route: attempt.route,
      origin_asset: "USDC",
      origin_network: "near",
      destination_asset:
        attempt.destination_symbol ?? attempt.destination_asset,
      destination_asset_id: attempt.destination_asset,
      destination_network: attempt.destination_network,
      destination_address: attempt.destination_address,
      quoted_output_base_units: attempt.expected_output,
      quoted_output:tokenQuantity(attempt.expected_output,decimals),
      destination_decimals:decimals,
      authorized_source_usdc: usdc(attempt.amount_in),
      authorized_source_micro_usdc: attempt.amount_in,
      source_debited_usdc: sent ? usdc(attempt.amount_in) : "",
      source_debited_micro_usdc: sent ? attempt.amount_in : "",
      provider_consumed_source_usdc: usdc(provider?.amountIn),
      provider_reported_output_base_units: provider?.amountOut,
      provider_reported_output:tokenQuantity(provider?.amountOut,decimals),
      observed_output_base_units: attempt.observed_output,
      observed_output:tokenQuantity(attempt.observed_output,decimals),
      attested_output_base_units: chainAttempt?.actual_output,
      attested_output:tokenQuantity(chainAttempt?.actual_output,decimals),
      attested_entitlement_credit_usdc: usdc(chainAttempt?.credited_amount),
      provider_reported_refund_usdc: usdc(provider?.refundedAmount),
      verified_recovery_usdc: usdc(recovered),
      verified_recovery_micro_usdc: recovered,
      source_tx_hash: attempt.source_tx_hash,
      destination_tx_hash: attempt.destination_tx_hash,
      refund_tx_hash: attempt.refund_tx_hash,
      settlement_receipt: chainAttempt?.receipt,
      verification: isDirectExecution(execution)
        ? attempt.state === "delivered"
          ? "NEAR_native_token_transfer_callback"
          : "NEAR_native_transfer_unresolved"
        : attempt.state === "partially_delivered" ? "terminal_partial_route_closed_by_NEAR_reporter; explicit_USDC_valuation" : attempt.state === "delivered"
          ? "owner_or_reporter_attested_external_delivery"
          : "provider_report_not_delivery_proof",
    });
  }
  for (const record of records)
    if (
      record.record_type === "attempt" &&
      sourceProofs.has(String(record.record_id))
    ) {
      record.receipt_id = sourceProofs.get(String(record.record_id));
      record.verification = `${record.verification}; source_linked_to_final_NEAR_receipt`;
    }
  for (const leg of funding) {
    records.push({
      ...common(leg.payment_id ? paymentById.get(leg.payment_id) : undefined),
      record_type: "funding",
      record_id: leg.id,
      funding_id: leg.id,
      created_at: leg.created_at,
      status: leg.status,
      payment_reference: leg.reference,
      origin_asset: leg.origin_symbol ?? leg.origin_asset,
      origin_asset_id: leg.origin_asset,
      origin_network: leg.origin_network,
      origin_amount_base_units: leg.amount_in,
      origin_amount:
        leg.origin_decimals !== null && leg.origin_decimals !== undefined
          ? formatUnits(leg.amount_in, leg.origin_decimals)
          : "",
      destination_asset: "USDC",
      destination_network: "near",
      destination_address: leg.recipient_address,
      quoted_output: usdc(leg.expected_output),
      quoted_output_base_units: leg.expected_output,
      verified_credit_usdc: usdc(leg.credited_amount),
      verified_credit_micro_usdc: leg.credited_amount,
      source_tx_hash: leg.source_tx_hash,
      destination_tx_hash: leg.destination_tx_hash,
      verification:
        leg.status === "confirmed"
          ? "final_NEAR_token_receipt_linked_by_provider_destination_hash"
          : "provider_report_not_verified_credit",
    });
  }
  for (const receipt of rows<RecordRow>(
    "SELECT * FROM funding_credit_receipts WHERE organization_id=? ORDER BY verified_at,id",
    access.organizationId,
  ))
    records.push({
      record_type: "funding_receipt",
      record_id: receipt.id,
      funding_id: receipt.funding_id,
      created_at: receipt.verified_at,
      status: "confirmed",
      destination_asset: "USDC",
      destination_network: "near",
      verified_credit_usdc: usdc(String(receipt.amount)),
      verified_credit_micro_usdc: receipt.amount,
      destination_tx_hash: receipt.transaction_hash,
      receipt_id: receipt.receipt_id,
      receipt_log_index: receipt.log_index,
      receipt_data_index: receipt.data_index,
      verification: "FINAL_successful_canonical_NEP141_transfer",
    });
  for (const entry of rows<RecordRow>(
    "SELECT * FROM treasury_ledger WHERE organization_id=? ORDER BY created_at,id",
    access.organizationId,
  )) {
    const metadata = json<{ paymentId?: string }>(
      String(entry.metadata ?? "{}"),
      {},
    );
    records.push({
      ...common(
        metadata.paymentId ? paymentById.get(metadata.paymentId) : undefined,
      ),
      record_type: "treasury_ledger",
      record_id: entry.id,
      created_at: entry.created_at,
      payment_reference: entry.reference,
      status: entry.entry_type,
      ledger_amount_usdc: usdc(String(entry.amount)),
      ledger_amount_micro_usdc: entry.amount,
      balance_after_usdc: usdc(String(entry.balance_after)),
      reserved_after_usdc: usdc(String(entry.reserved_after)),
      verification:
        "ledger_state_change; reservation_entries_are_not_transfers",
    });
  }
  for (const bill of bills){
    const related=installments.filter(item=>item.bill_id===bill.id).flatMap(item=>{const payment=paymentById.get(item.payment_id);return payment?[payment]:[];}),totals=liabilityTotals(bill.amount,related,bill.setoff_amount,bill.funded_clearing_amount,bill.accepted_credit_amount);
    records.push({
      ...common(bill.payment_id ? paymentById.get(bill.payment_id) : undefined),
      record_type: "invoice",
      record_id: bill.id,
      created_at: bill.created_at,
      recipient_id: bill.recipient_id,
      recipient_name:related[0]?historicalNames.get(related[0].id):names.get(bill.recipient_id),
      status: bill.status,
      bill_id: bill.id,
      bill_reference: bill.reference,
      description: decrypt(bill.title),
      project_reference: bill.project_reference ? decrypt(bill.project_reference) : undefined,
      cost_center_reference: bill.cost_center_reference ? decrypt(bill.cost_center_reference) : undefined,
      entitlement_usdc: usdc(bill.amount),
      entitlement_micro_usdc: bill.amount,
      setoff_usdc: usdc(bill.setoff_amount),
      setoff_micro_usdc: bill.setoff_amount,
      funded_discharge_usdc: usdc(bill.funded_clearing_amount),
      funded_discharge_micro_usdc: bill.funded_clearing_amount,
      accepted_credit_usdc:usdc(bill.accepted_credit_amount),
      accepted_credit_micro_usdc:bill.accepted_credit_amount,
      max_cost_usdc: usdc(bill.max_fee),
      max_cost_micro_usdc: bill.max_fee,
      delivered_entitlement_usdc:usdc(totals.delivered.toString()),
      remaining_entitlement_usdc:usdc(totals.remaining.toString()),
      unprepared_liability_usdc:usdc(totals.unprepared.toString()),
      recorded_source_spent_usdc:usdc(totals.sourceSpent.toString()),
      recorded_net_cost_usdc:usdc(totals.netCost.toString()),
      verification: "invoice_liability_summary; installment_obligations_are_linked_records_not_additional_invoice_debt",
    });
  }
  for (const item of payroll){
    const related=liabilityPayments(access.organizationId,item.payment_id),totals=liabilityTotals(item.amount,related);
    records.push({
      ...common(paymentById.get(item.payment_id)),
      record_type: "payroll_item",
      record_id: item.id,
      created_at: item.created_at,
      recipient_id: item.recipient_id,
      recipient_name:related[0]?historicalNames.get(related[0].id):names.get(item.recipient_id),
      status: item.status,
      payroll_run_id: item.run_id,
      payroll_reference: item.reference,
      period_start: item.period_start,
      period_end: item.period_end,
      entitlement_usdc: usdc(item.amount),
      entitlement_micro_usdc: item.amount,
      max_cost_usdc: usdc(item.max_fee),
      max_cost_micro_usdc: item.max_fee,
      delivered_entitlement_usdc:usdc(totals.delivered.toString()),
      remaining_entitlement_usdc:usdc(totals.remaining.toString()),
      unprepared_liability_usdc:usdc(totals.unprepared.toString()),
      recorded_source_spent_usdc:usdc(totals.sourceSpent.toString()),
      recorded_net_cost_usdc:usdc(totals.netCost.toString()),
      verification: "payroll_item_liability_summary; partial_and_replacement_obligations_are_linked_records",
    });
  }
  for (const entry of clientReserveExportRows(access))
    records.push({
      ...common(
        entry.payment_id
          ? paymentById.get(String(entry.payment_id))
          : undefined,
      ),
      ...entry,
    });
  records.push(...clearingExportRows(access.organizationId));
  records.push(...creditExportRows(access.organizationId));
  records.push(...financingExportRows(access.organizationId));
  records.push(...expenseReturnAccounting(access.organizationId).map(value => ({
    record_type: "expense_cash_return", record_id: value.correctionId, expense_id: value.expenseId, payment_id: value.paymentId,
    status: value.status, created_at: value.createdAt, original_expense_gross_micro_usdc: value.originalGross,
    original_delivered_micro_usdc: value.deliveredPrincipal, original_source_spend_micro_usdc: value.originalSourceSpend,
    accepted_corrected_expense_micro_usdc: value.acceptedCorrectedAmount, proposed_return_micro_usdc: value.proposedReturnAmount,
    agreed_return_micro_usdc: value.agreedReturnAmount, actual_returned_micro_usdc: value.actualReturnedUSDC,
    unresolved_return_micro_usdc: value.unresolvedReturnAmount, unpaid_liability_adjustment_micro_usdc: value.liabilityAdjustment,
    verification: value.provenance,
  })));
  records.push(...fundingRefundExportRows(access).map(record => ({ record_type: "source_funding_refund", ...record })));
  for (const value of rows<{payment_id:string;attempt_id:string;actual_output:string;credited_usdc:string;source_spent_usdc:string;receipt_commitment:string;confirmed_at:string;remainder_payment_id:string|null}>("SELECT s.*,r.remainder_payment_id FROM partial_settlements s LEFT JOIN partial_remainders r ON r.original_payment_id=s.payment_id WHERE s.organization_id=? ORDER BY s.confirmed_at",access.organizationId)) records.push({...common(paymentById.get(value.payment_id)),record_type:"terminal_partial_settlement",record_id:value.payment_id,created_at:value.confirmed_at,attested_output_base_units:value.actual_output,attested_entitlement_credit_usdc:usdc(value.credited_usdc),recorded_source_spent_usdc:usdc(value.source_spent_usdc),settlement_receipt:value.receipt_commitment,residual_payment_id:value.remainder_payment_id,verification:"terminal_NEAR_reporter_attestation; explicit_entitlement_credit; no_automatic_cross_asset_conversion"});
  const headers = [
    "record_type",
    "record_id",
    "project_reference",
    "cost_center_reference",
    "created_at",
    "status",
    "payment_id",
    "recipient_id",
    "recipient_name",
    "payment_kind",
    "payment_reference",
    "bill_id",
    "bill_reference",
    "description",
    "payroll_run_id",
    "payroll_reference",
    "period_start",
    "period_end",
    "funding_id",
    "route",
    "entitlement_usdc",
    "entitlement_micro_usdc",
    "max_cost_usdc",
    "max_cost_micro_usdc",
    "origin_asset",
    "origin_asset_id",
    "origin_network",
    "origin_amount",
    "origin_amount_base_units",
    "destination_asset",
    "destination_asset_id",
    "destination_network",
    "destination_address",
    "destination_decimals",
    "quoted_output",
    "quoted_output_base_units",
    "authorized_source_usdc",
    "authorized_source_micro_usdc",
    "source_debited_usdc",
    "source_debited_micro_usdc",
    "provider_consumed_source_usdc",
    "provider_reported_output_base_units",
    "provider_reported_output",
    "provider_reported_refund_usdc",
    "recorded_source_spent_usdc",
    "recorded_source_spent_micro_usdc",
    "recorded_net_cost_usdc",
    "recorded_net_cost_micro_usdc",
    "verified_recovery_usdc",
    "verified_recovery_micro_usdc",
    "verified_credit_usdc",
    "verified_credit_micro_usdc",
    "ledger_amount_usdc",
    "ledger_amount_micro_usdc",
    "balance_after_usdc",
    "reserved_after_usdc",
    "source_tx_hash",
    "destination_tx_hash",
    "refund_tx_hash",
    "receipt_id",
    "receipt_log_index",
    "receipt_data_index",
    "settlement_receipt",
    "client_reserve_id",
    "client_reference",
    "earmarked_principal_usdc",
    "earmarked_principal_micro_usdc",
    "client_cash_reserved_usdc",
    "client_cash_reserved_micro_usdc",
    "client_principal_in_flight_usdc",
    "client_principal_outstanding_usdc",
    "client_release_reason",
    "verification",
    "delivered_entitlement_usdc",
    "remaining_entitlement_usdc",
    "unpaid_recorded_entitlement_usdc",
    "transferred_entitlement_usdc",
    "successor_payment_id",
    "unprepared_liability_usdc",
    "observed_output_base_units",
    "observed_output",
    "attested_output_base_units",
    "attested_output",
    "attested_entitlement_credit_usdc",
    "setoff_usdc",
    "setoff_micro_usdc",
    "clearing_round_id",
    "residual_payment_id",
    "discharged_invoice_value_usdc",
    "planned_residual_transfer_volume_usdc",
    "residual_transfer_volume_usdc",
    "minimum_starting_liquidity_usdc",
    "source_asset_id",
    "source_symbol",
    "source_network",
    "source_decimals",
    "refund_address",
    "refunded_source_base_units",
    "refunded_source_quantity",
    "provider_reported_deposit_base_units",
    "unclassified_source_difference_base_units",
    "source_transaction_hash",
    "refund_transaction_hash",
    "refund_provenance",
    "provider_status",
    "company_usdc_credit",
    "confirmed_by",
    "confirmed_at",
    "funded_discharge_usdc",
    "funded_discharge_micro_usdc",
    "mode",
    "stage",
    "fixed_owner_destination",
    "original_net_debit_micro_usdc",
    "original_net_credit_micro_usdc",
    "accepted_deposits_micro_usdc",
    "creditor_credit_available_micro_usdc",
    "creditor_credit_withdrawn_micro_usdc",
    "cancellation_refund_available_micro_usdc",
    "cancellation_refund_withdrawn_micro_usdc",
    "pending_transfer",
    "withdrawal_nonce",
    "observed_block_height",
    "observed_block_hash",
    "accepted_credit_usdc",
    "accepted_credit_micro_usdc",
    "credit_note_reference",
    "credit_note_version",
    "accepted_by",
    "credit_retirement_note_id",
    "retired_draft_micro_usdc",
    "loan_id",
    "agreement_hash",
    "advanced_micro_usdc",
    "loan_principal_outstanding_micro_usdc",
    "loan_interest_outstanding_micro_usdc",
    "loan_fee_outstanding_micro_usdc",
    "loan_cash_repaid_micro_usdc",
    "loan_collateral_applied_micro_usdc",
    "expense_id",
    "original_expense_gross_micro_usdc",
    "original_delivered_micro_usdc",
    "original_source_spend_micro_usdc",
    "accepted_corrected_expense_micro_usdc",
    "proposed_return_micro_usdc",
    "agreed_return_micro_usdc",
    "actual_returned_micro_usdc",
    "unresolved_return_micro_usdc",
    "unpaid_liability_adjustment_micro_usdc",
  ];
  return [
    headers.map(csvCell).join(","),
    ...records.map((record) =>
      headers.map((header) => csvCell(record[header])).join(","),
    ),
  ].join("\r\n");
}
