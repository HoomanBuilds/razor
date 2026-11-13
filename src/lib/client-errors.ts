const contractMessages: Record<string, string> = {
  ONLY_OWNER: "Connect the NEAR wallet that owns this treasury before continuing.",
  ONLY_APPROVER: "Connect an authorized NEAR approver wallet before continuing.",
  ONLY_EXECUTOR: "Connect a permitted NEAR execution wallet before continuing.",
  ONLY_SETTLEMENT_REPORTER: "The NEAR owner or appointed reporter must confirm this settlement.",
  PAUSED: "Payments are paused. Ask the company owner to review and resume execution.",
  POLICY_CHANGED: "The treasury policy changed. Refresh the payment and collect the required approvals again.",
  RECIPIENT_CHANGED: "The receiving details changed. Review the current payment before signing again.",
  QUOTE_EXPIRED: "This route quote expired. Refresh its terms before starting a new transfer.",
  PAYMENT_EXPIRED: "The payment authorization expired. Review a new authorization before continuing.",
  PAYMENT_NOT_DUE: "The scheduled payment time has not arrived yet.",
  PAYMENT_APPROVAL_REQUIRED: "Collect the required NEAR wallet approvals before executing this payment.",
  PAYMENT_NOT_READY: "Refresh the payment's approvals and current treasury state before execution.",
  PRIOR_ATTEMPT_NOT_CLOSED: "The earlier route may still deliver. Reconcile it before preparing another payout.",
  SOURCE_MAY_STILL_DELIVER: "The source transfer may still complete. Check its saved receipt before sending again.",
  SOURCE_CALLBACK_PENDING: "The source transfer is still unresolved. Reconcile its saved receipt before continuing.",
  SOURCE_NOT_CONFIRMED: "Confirm the original source transfer before reporting delivery or recovery.",
  INSUFFICIENT_RETAINED_BALANCE: "The retained token balance is too low. Refresh it and review the withdrawal amount.",
  RETAINED_BALANCE_CHANGED: "The retained token balance changed. Refresh it and prepare a new withdrawal review.",
  RETAINED_WITHDRAWAL_PENDING: "A retained-token withdrawal is unresolved. Check its original receipt before withdrawing again.",
};

export function walletFailureMessage(error: unknown, fallback = "The connection was interrupted. Check the saved status before trying again.") {
  const messages: string[] = [], visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8 && !visited.has(current); depth++) {
    visited.add(current);
    const candidate = current as { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    if (candidate.code === 4001 || candidate.code === "ACTION_REJECTED" || candidate.name === "UserRejectedRequestError") return "Wallet request cancelled. Check the current transfer status before trying again.";
    for (const value of [candidate.shortMessage, candidate.message]) if (typeof value === "string") messages.push(value);
    current = candidate.cause;
  }
  const text = messages.join(" ");
  if (/user (rejected|denied)|rejected by (the )?user|request (cancelled|canceled)/i.test(text)) return "Wallet request cancelled. Check the current transfer status before trying again.";
  for (const [code, message] of Object.entries(contractMessages)) if (new RegExp(`\\b${code}\\b`).test(text)) return message;
  if (/not enough.*gas|insufficient.*(gas|native)|gas.*balance/i.test(text)) return "The signing wallet needs more native tokens for network fees. Add gas on the selected network and try again.";
  if (/insufficient funds/i.test(text)) return "The signing wallet cannot cover this transfer and its network fee. Check its balance on the selected network.";
  if (/nonce too low|already known|already pending|replacement transaction underpriced/i.test(text)) return "A wallet transaction may already be pending. Check its original receipt before sending again.";
  if (/chain mismatch|wrong (chain|network)|chain.*not (configured|supported)|network.*(changed|mismatch)/i.test(text)) return "The wallet is on another network. Switch to the network shown in the payment review and reconnect.";
  if (/failed to fetch|fetch failed|network request failed|timeout|timed out|connection (closed|refused)/i.test(text)) return "The network could not confirm this request. Check the saved transfer status before trying again.";
  if (/execution reverted|smart contract panicked|FunctionCallError|ContractFunctionRevertedError/i.test(text)) return "The contract rejected this action. Refresh its current state and review the payment before signing again.";
  const plain = messages.find(message => message.length <= 240 && !/[\r\n{}]|0x[0-9a-f]{16}/i.test(message));
  return plain || fallback;
}
