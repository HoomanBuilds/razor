export function paymentLabel(payment: { reference: string; kind: string; metadata?: string }): string {
  let metadata: { displayReference?: string; periodStart?: string } = {};
  try { metadata = JSON.parse(payment.metadata ?? "{}"); } catch {}
  if (typeof metadata.displayReference === "string" && metadata.displayReference) return metadata.displayReference;
  if (payment.kind === "payroll" && metadata.periodStart) return `Payroll - ${metadata.periodStart}`;
  if (payment.reference.startsWith("bill:")) return "Invoice payment";
  return payment.reference;
}
