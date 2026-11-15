export function sortInvoices<T extends { remainingLiability: string; due_date: string | null }>(invoices: readonly T[]): T[] {
  const due = (value: string | null) => {
    const timestamp = value ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? timestamp : Infinity;
  };
  return [...invoices].sort((left, right) => {
    const leftOpen = BigInt(left.remainingLiability) > 0n, rightOpen = BigInt(right.remainingLiability) > 0n;
    if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
    if (!leftOpen) return 0;
    const leftDue = due(left.due_date), rightDue = due(right.due_date);
    return leftDue === rightDue ? 0 : leftDue < rightDue ? -1 : 1;
  });
}

export function invoiceSourceAmount(value: string): string {
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return value;
  const [whole, fraction] = text.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}
