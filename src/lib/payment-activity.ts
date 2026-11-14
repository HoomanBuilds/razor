export interface ActivityRecord { created_at: string; status: string; kind: string }
export interface PaymentActivity {
  total: number;
  states: { settled: number; open: number; review: number; closed: number };
  kinds: { payroll: number; invoices: number; other: number };
  statuses: Record<string, number>;
  window: { from: string; to: string; days: number; timezone: "UTC" };
  series: { date: string; settled: number; open: number; review: number; closed: number }[];
}

export function paymentActivity(records: readonly ActivityRecord[], now = new Date()): PaymentActivity {
  const days = 21, dayMs = 86_400_000;
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - (days - 1) * dayMs;
  const states = { settled: 0, open: 0, review: 0, closed: 0 };
  const kinds = { payroll: 0, invoices: 0, other: 0 };
  const statuses: Record<string, number> = Object.create(null);
  const series = Array.from({ length: days }, (_, index) => ({ date: new Date(start + index * dayMs).toISOString().slice(0, 10), settled: 0, open: 0, review: 0, closed: 0 }));
  for (const record of records) {
    const state = record.status === "paid" ? "settled" : record.status === "cancelled" ? "closed" : ["held", "approved_unfunded", "partially_paid"].includes(record.status) ? "review" : "open";
    states[state]++;
    statuses[record.status] = (statuses[record.status] ?? 0) + 1;
    kinds[record.kind === "payroll" ? "payroll" : ["bill", "invoice"].includes(record.kind) ? "invoices" : "other"]++;
    const time = Date.parse(record.created_at);
    if (!Number.isFinite(time) || time < start || time >= end + dayMs) continue;
    series[Math.floor((time - start) / dayMs)][state]++;
  }
  return { total: records.length, states, kinds, statuses, window: { from: series[0].date, to: series.at(-1)!.date, days, timezone: "UTC" }, series };
}

export function proportion(numerator: number | string | bigint, denominator: number | string | bigint): number {
  try {
    const total = BigInt(denominator), value = BigInt(numerator);
    if (total <= 0n || value <= 0n) return 0;
    return Number((value >= total ? total : value) * 10_000n / total) / 10_000;
  } catch { return 0; }
}
