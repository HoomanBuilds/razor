import { createHash } from "node:crypto";

export interface ClearingEdge { id: string; debtor: string; creditor: string; amount: string }
const maximum = (1n << 128n) - 1n;
export const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

export function computeClearing(input: ClearingEdge[]) {
  if (input.length < 2 || input.length > 32 || new Set(input.map(edge => edge.id)).size !== input.length) throw new Error("Choose 2 to 32 distinct accepted business obligations");
  const edges = [...input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(edge => {
    if (!/^[1-9]\d*$/.test(edge.amount) || BigInt(edge.amount) > maximum || edge.debtor === edge.creditor) throw new Error("Use positive USDC obligations between different companies");
    return { ...edge, original: BigInt(edge.amount), remaining: BigInt(edge.amount) };
  });
  const companies = [...new Set(edges.flatMap(edge => [edge.debtor, edge.creditor]))].sort();
  if (companies.length > 8) throw new Error("A clearing round supports at most eight companies");
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
  const obligations = edges.map(edge => ({ id: edge.id, debtor: edge.debtor, creditor: edge.creditor, original: edge.original.toString(), reduction: (edge.original - edge.remaining).toString(), residual: edge.remaining.toString() }));
  const positions = companies.map(companyId => {
    let before = 0n, after = 0n, outgoingDischarge = 0n, incomingDischarge = 0n;
    for (const edge of edges) { const sign = edge.debtor === companyId ? 1n : edge.creditor === companyId ? -1n : 0n; before += sign * edge.original; after += sign * edge.remaining; }
    for (const edge of edges) { if (edge.debtor === companyId) outgoingDischarge += edge.original - edge.remaining; if (edge.creditor === companyId) incomingDischarge += edge.original - edge.remaining; }
    if (outgoingDischarge > maximum || incomingDischarge > maximum) throw new Error("The company debt discharge exceeds the contract's u128 range");
    if (before !== after) throw new Error("The clearing calculation changed a company net position");
    return { companyId, before: before.toString(), after: after.toString() };
  });
  const original = edges.reduce((sum, edge) => sum + edge.original, 0n), residual = edges.reduce((sum, edge) => sum + edge.remaining, 0n);
  return { obligations, positions, originalInvoiceValue: original.toString(), dischargedInvoiceValue: (original - residual).toString(), residualTransferVolume: residual.toString(), minimumStartingLiquidity: positions.reduce((sum, position) => sum + (BigInt(position.before) > 0n ? BigInt(position.before) : 0n), 0n).toString(), liquidityAssumption: "Mathematical lower bound assuming timely reuse of incoming USDC. Payout destinations, timing and fees can require more funding." };
}
