import { createHash } from "node:crypto";
import { maximumCirculation } from "./circulation";

export interface ClearingEdge { id: string; debtor: string; creditor: string; amount: string }
export interface ClearingObligation { id: string; debtor: string; creditor: string; original: string; reduction: string; residual: string }
export interface ClearingOptimization {
  algorithm: "maximum_weight_circulation_v1" | "legacy";
  objective: "cancelled_invoice_face_value";
  status: "optimal" | "bounded" | "unknown";
  optimal: boolean | null;
  iterations: number | null;
  iterationLimit: number | null;
  arcScans: number | null;
  arcScanLimit: number | null;
  baselineDischargedInvoiceValue: string | null;
}
const maximum = (1n << 128n) - 1n;
export const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function normalize(input: ClearingEdge[]) {
  if (input.length < 2 || input.length > 32 || new Set(input.map(edge => edge.id)).size !== input.length) throw new Error("Choose 2 to 32 distinct accepted business obligations");
  const edges = [...input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(edge => {
    if (!/^[1-9]\d{0,38}$/.test(edge.amount) || BigInt(edge.amount) > maximum || !edge.id || !edge.debtor || !edge.creditor || edge.debtor === edge.creditor) throw new Error("Use positive USDC obligations between different companies");
    return { ...edge, original: BigInt(edge.amount), remaining: BigInt(edge.amount) };
  });
  const companies = [...new Set(edges.flatMap(edge => [edge.debtor, edge.creditor]))].sort();
  if (companies.length > 8) throw new Error("A clearing round supports at most eight companies");
  return { edges, companies };
}

function summarize(edges: ReturnType<typeof normalize>["edges"], companies: string[], optimization: ClearingOptimization) {
  const obligations = edges.map(edge => ({ id: edge.id, debtor: edge.debtor, creditor: edge.creditor, original: edge.original.toString(), reduction: (edge.original - edge.remaining).toString(), residual: edge.remaining.toString() }));
  const positions = companies.map(companyId => {
    let before = 0n, after = 0n, outgoingDischarge = 0n, incomingDischarge = 0n;
    for (const edge of edges) {
      if (edge.remaining < 0n || edge.remaining > edge.original) throw new Error("The clearing calculation exceeded an obligation capacity");
      const sign = edge.debtor === companyId ? 1n : edge.creditor === companyId ? -1n : 0n;
      before += sign * edge.original; after += sign * edge.remaining;
      if (edge.debtor === companyId) outgoingDischarge += edge.original - edge.remaining;
      if (edge.creditor === companyId) incomingDischarge += edge.original - edge.remaining;
    }
    if (outgoingDischarge > maximum || incomingDischarge > maximum) throw new Error("The company debt discharge exceeds the contract's u128 range");
    if (before !== after) throw new Error("The clearing calculation changed a company net position");
    return { companyId, before: before.toString(), after: after.toString() };
  });
  const original = edges.reduce((sum, edge) => sum + edge.original, 0n), residual = edges.reduce((sum, edge) => sum + edge.remaining, 0n);
  if (optimization.baselineDischargedInvoiceValue !== null && BigInt(optimization.baselineDischargedInvoiceValue) > original - residual) throw new Error("The clearing calculation fell below its accepted baseline");
  return { obligations, positions, optimization, originalInvoiceValue: original.toString(), dischargedInvoiceValue: (original - residual).toString(), residualTransferVolume: residual.toString(), minimumStartingLiquidity: positions.reduce((sum, position) => sum + (BigInt(position.before) > 0n ? BigInt(position.before) : 0n), 0n).toString(), liquidityAssumption: "Mathematical lower bound assuming timely reuse of incoming USDC. Payout destinations, timing and fees can require more funding.", actualFeesPaid: null, feeEvidence: "Actual wallet gas and settlement fees are not measured by clearing. Residual payment source costs are reported separately." };
}

export function computeClearing(input: ClearingEdge[], options: { iterationLimit?: number } = {}) {
  const { edges, companies } = normalize(input);
  function cycle() {
    const finished = new Set<string>(), visiting = new Map<string, number>(), path: typeof edges = [];
    function visit(company: string): typeof edges | undefined {
      visiting.set(company, path.length);
      for (const edge of edges.filter(edge => edge.debtor === company && edge.remaining > 0n)) {
        const position = visiting.get(edge.creditor);
        if (position !== undefined) return [...path.slice(position), edge];
        if (!finished.has(edge.creditor)) { path.push(edge); const found = visit(edge.creditor); if (found) return found; path.pop(); }
      }
      visiting.delete(company); finished.add(company);
    }
    for (const company of companies) { const found = visit(company); if (found) return found; }
  }
  for (let found = cycle(); found; found = cycle()) {
    const reduction = found.reduce((value, edge) => value < edge.remaining ? value : edge.remaining, found[0].remaining);
    for (const edge of found) edge.remaining -= reduction;
  }
  const baseline = edges.map(edge => edge.original - edge.remaining);
  const result = maximumCirculation(edges.map(edge => ({ debtor: edge.debtor, creditor: edge.creditor, capacity: edge.original })), baseline, options.iterationLimit);
  for (let index = 0; index < edges.length; index++) edges[index].remaining = edges[index].original - result.flow[index];
  return summarize(edges, companies, { algorithm: "maximum_weight_circulation_v1", objective: "cancelled_invoice_face_value", status: result.optimal ? "optimal" : "bounded", optimal: result.optimal, iterations: result.iterations, iterationLimit: result.iterationLimit, arcScans: result.arcScans, arcScanLimit: result.arcScanLimit, baselineDischargedInvoiceValue: baseline.reduce((sum, amount) => sum + amount, 0n).toString() });
}

export function describeCommittedClearing(input: ClearingObligation[], optimization?: ClearingOptimization | null) {
  const { edges, companies } = normalize(input.map(edge => ({ ...edge, amount: edge.original })));
  const committed = new Map(input.map(edge => [edge.id, edge]));
  for (const edge of edges) {
    const value = committed.get(edge.id)!;
    if (!/^(0|[1-9]\d{0,38})$/.test(value.reduction) || !/^(0|[1-9]\d{0,38})$/.test(value.residual) || BigInt(value.reduction) + BigInt(value.residual) !== edge.original) throw new Error("The committed clearing amounts do not match their original obligation");
    edge.remaining = BigInt(value.residual);
  }
  return summarize(edges, companies, optimization ?? { algorithm: "legacy", objective: "cancelled_invoice_face_value", status: "unknown", optimal: null, iterations: null, iterationLimit: null, arcScans: null, arcScanLimit: null, baselineDischargedInvoiceValue: null });
}
