import { ApiError } from "../context";
import type { CashAccount, CashPosition, CashState, CashTerms, Manifest } from "./types";

export const fundedMode = "cash_backed_native_v1" as const;
const maximum = (1n << 128n) - 1n;
export function cashAmount(value: string, zero = true): bigint {
  if (!/^(0|[1-9]\d{0,38})$/.test(value) || BigInt(value) > maximum || !zero && value === "0") throw new ApiError(409, "Cash clearing requires exact bounded native-USDC amounts", "FUNDED_CLEARING_AMOUNT_INVALID");
  return BigInt(value);
}
export function cashTerms(manifest: Pick<Manifest, "participants" | "obligations">, network: CashTerms["network"], token: string): CashTerms {
  const positions: CashPosition[] = manifest.participants.map(party => {
    const outgoing = manifest.obligations.reduce((sum, edge) => sum + (edge.debtor === party.company_id ? cashAmount(edge.original, false) : 0n), 0n), incoming = manifest.obligations.reduce((sum, edge) => sum + (edge.creditor === party.company_id ? cashAmount(edge.original, false) : 0n), 0n);
    const net = cashAmount(outgoing.toString()) - cashAmount(incoming.toString());
    const deposit = net > 0n ? net : 0n, credit = net < 0n ? -net : 0n;
    return { company_id: party.company_id, deposit_due: cashAmount(deposit.toString()).toString(), credit_due: cashAmount(credit.toString()).toString(), destination: party.owner_id };
  });
  const due = positions.reduce((sum, party) => sum + BigInt(party.deposit_due), 0n), credits = positions.reduce((sum, party) => sum + BigInt(party.credit_due), 0n);
  if (!due || due !== credits || due > maximum) throw new ApiError(422, "Cash-backed clearing needs equal positive original net debits and credits. Use debt-only clearing for a fully balanced cycle", "FUNDED_CLEARING_NO_CASH_POSITION");
  return { mode: fundedMode, network, token_contract: token, refund_policy: "return_accepted_deposits_to_fixed_owner_on_cancel", positions };
}
export function assertCashTerms(manifest: Manifest, network: CashTerms["network"], token: string): CashTerms {
  const expected = cashTerms(manifest, network, token), actual = manifest.cash;
  if (!actual || actual.mode !== fundedMode || actual.network !== network || actual.token_contract !== token || actual.refund_policy !== expected.refund_policy || actual.positions.length !== expected.positions.length
    || actual.positions.some((party, index) => (["company_id", "deposit_due", "credit_due", "destination"] as const).some(key => party[key] !== expected.positions[index][key]))) throw new ApiError(409, "Original company net positions or fixed escrow destinations changed", "FUNDED_CLEARING_TERMS_CHANGED");
  return expected;
}
export function assertCashState(manifest: Manifest, state: CashState | null | undefined): CashState {
  if (!state || !["funding", "credits", "refunds"].includes(state.stage) || state.accounts.length !== manifest.cash!.positions.length || state.deposits.length > manifest.participants.length * 8) throw new ApiError(409, "The reviewed clearing contract did not return bounded cash custody evidence", "FUNDED_CLEARING_STATE_INVALID");
  const seen = new Set<string>();
  for (const [index, account] of state.accounts.entries()) {
    const expected = manifest.cash!.positions[index];
    if ((["company_id", "deposit_due", "credit_due", "destination"] as const).some(key => account[key] !== expected[key])) throw new ApiError(409, "The observed company custody account differs from the exact consent", "FUNDED_CLEARING_STATE_INVALID");
    for (const value of [account.deposit_due, account.credit_due, account.deposited, account.credit_available, account.credit_paid, account.refund_available, account.refund_paid, account.nonce]) cashAmount(value);
    const pending = account.pending ? cashAmount(account.pending.amount, false) : 0n;
    if (account.pending && (account.pending.receiver !== account.destination || account.pending.nonce !== account.nonce || account.pending.kind !== (state.stage === "credits" ? "credit" : "refund"))) throw new ApiError(409, "An escrow withdrawal has inconsistent fixed-destination evidence", "FUNDED_CLEARING_STATE_INVALID");
    if (BigInt(account.deposited) > BigInt(account.deposit_due) || state.stage === "funding" && (pending || account.credit_available !== "0" || account.credit_paid !== "0" || account.refund_available !== "0" || account.refund_paid !== "0")
      || state.stage === "credits" && (account.deposited !== account.deposit_due || BigInt(account.credit_available) + BigInt(account.credit_paid) + pending !== BigInt(account.credit_due) || account.refund_available !== "0" || account.refund_paid !== "0")
      || state.stage === "refunds" && (BigInt(account.refund_available) + BigInt(account.refund_paid) + pending !== BigInt(account.deposited) || account.credit_available !== "0" || account.credit_paid !== "0")) throw new ApiError(409, "The escrow accounts do not conserve their separately classified principal", "FUNDED_CLEARING_CONSERVATION_FAILED");
    if (account.last_transfer && (!["credit", "refund"].includes(account.last_transfer.kind) || !["paid", "failed"].includes(account.last_transfer.status) || cashAmount(account.last_transfer.nonce) > BigInt(account.nonce) || !cashAmount(account.last_transfer.amount, false))) throw new ApiError(409, "The escrow callback evidence is invalid", "FUNDED_CLEARING_STATE_INVALID");
    if (account.nonce !== "0" && !account.pending && account.last_transfer?.nonce !== account.nonce) throw new ApiError(409, "A resolved escrow nonce needs its exact final callback record", "FUNDED_CLEARING_STATE_INVALID");
    const deposits = state.deposits.filter(deposit => deposit.company_id === account.company_id);
    if (deposits.length > 8 || deposits.reduce((sum, deposit) => sum + cashAmount(deposit.accepted, false), 0n) !== BigInt(account.deposited)) throw new ApiError(409, "Accepted deposits do not match company escrow backing", "FUNDED_CLEARING_CONSERVATION_FAILED");
    for (const deposit of deposits) {
      const key = `${deposit.company_id}:${deposit.deposit_id}`;
      if (seen.has(key) || !deposit.deposit_id || deposit.deposit_id.length > 128 || deposit.sender_id !== account.destination || cashAmount(deposit.submitted, false) !== cashAmount(deposit.accepted, false) + cashAmount(deposit.unused) || !/^[1-9]\d*$/.test(deposit.accepted_height) || !/^[1-9]\d*$/.test(deposit.accepted_at_ms) || BigInt(deposit.accepted_at_ms) >= BigInt(manifest.expires_at_ms)) throw new ApiError(409, "The accepted native-USDC deposit identity is invalid", "FUNDED_CLEARING_DEPOSIT_INVALID");
      seen.add(key);
    }
  }
  if (seen.size !== state.deposits.length) throw new ApiError(409, "The escrow includes an unknown company deposit", "FUNDED_CLEARING_DEPOSIT_INVALID");
  return state;
}

export interface StoredCashAccount { destination: string; deposit_due: string; credit_due: string; deposited: string; credit_available: string; credit_paid: string; refund_available: string; refund_paid: string; nonce: string; pending_json: string | null; last_transfer_json: string | null; observed_height: string; stage: string }
export function assertCashProgress(previous: StoredCashAccount, account: CashAccount, stage: CashState["stage"], height: string) {
  const last = previous.last_transfer_json ? JSON.parse(previous.last_transfer_json) as CashAccount["last_transfer"] : null;
  if (BigInt(height) < BigInt(previous.observed_height) || previous.stage !== "funding" && stage !== previous.stage || BigInt(account.nonce) < BigInt(previous.nonce)
    || BigInt(account.deposited) < BigInt(previous.deposited) || BigInt(account.credit_paid) < BigInt(previous.credit_paid) || BigInt(account.refund_paid) < BigInt(previous.refund_paid)
    || account.nonce === previous.nonce && last?.nonce === account.nonce && (account.pending || !account.last_transfer || (["kind", "nonce", "amount", "status"] as const).some(key => account.last_transfer![key] !== last[key]))) throw new ApiError(409, "A newer escrow observation is already recorded. Existing principal and unknown wallet fences remain held", "FUNDED_CLEARING_OBSERVATION_STALE");
}
