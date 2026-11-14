interface Debt { debtor: string; creditor: string; capacity: bigint }
interface Arc { from: number; to: number; debt: number; forward: boolean }
export const maximumCirculationIterations = 1024;

export function maximumCirculation(debts: readonly Debt[], initialFlow: readonly bigint[], iterationLimit = maximumCirculationIterations) {
  if (!Number.isSafeInteger(iterationLimit) || iterationLimit < 0 || iterationLimit > maximumCirculationIterations) throw new Error("Invalid clearing optimization iteration limit");
  const parties = [...new Set(debts.flatMap(debt => [debt.debtor, debt.creditor]))].sort();
  if (parties.length < 2 || parties.length > 8 || debts.length < 2 || debts.length > 32 || initialFlow.length !== debts.length) throw new Error("Invalid clearing optimization bounds");
  const flow = [...initialFlow], balance = new Array<bigint>(parties.length).fill(0n);
  const arcs: Arc[] = debts.flatMap((debt, index) => {
    if (debt.capacity < 0n || flow[index] < 0n || flow[index] > debt.capacity) throw new Error("Invalid clearing optimization capacity");
    const from = parties.indexOf(debt.debtor), to = parties.indexOf(debt.creditor);
    balance[from] += flow[index]; balance[to] -= flow[index];
    return [{ from, to, debt: index, forward: true }, { from: to, to: from, debt: index, forward: false }];
  });
  if (balance.some(amount => amount !== 0n)) throw new Error("The initial clearing flow is not conserved");
  const capacity = (arc: Arc) => arc.forward ? debts[arc.debt].capacity - flow[arc.debt] : flow[arc.debt];
  let arcScans = 0;
  function negativeCycle() {
    const distance = new Array<number>(parties.length).fill(0), via = new Array<Arc | undefined>(parties.length).fill(undefined);
    let updated = -1;
    for (let pass = 0; pass < parties.length; pass++) {
      updated = -1;
      for (const arc of arcs) {
        arcScans++;
        if (capacity(arc) <= 0n) continue;
        const candidate = distance[arc.from] + (arc.forward ? -1 : 1);
        if (candidate < distance[arc.to]) { distance[arc.to] = candidate; via[arc.to] = arc; updated = arc.to; }
      }
      if (updated === -1) return;
    }
    let node = updated;
    for (let step = 0; step < parties.length; step++) node = via[node]!.from;
    const cycle: Arc[] = [];
    let current = node;
    do {
      const arc = via[current]!;
      cycle.push(arc); current = arc.from;
      if (cycle.length > parties.length) throw new Error("Invalid clearing optimization cycle");
    } while (current !== node);
    if (cycle.reduce((cost, arc) => cost + (arc.forward ? -1 : 1), 0) >= 0) throw new Error("The clearing optimization did not improve its objective");
    return cycle.reverse();
  }
  for (let iterations = 0; ; iterations++) {
    const cycle = negativeCycle();
    const result = { flow, iterations, iterationLimit, arcScans, arcScanLimit: (iterationLimit + 1) * parties.length * arcs.length };
    if (!cycle) return { ...result, optimal: true };
    if (iterations === iterationLimit) return { ...result, optimal: false };
    const amount = cycle.reduce((minimum, arc) => capacity(arc) < minimum ? capacity(arc) : minimum, capacity(cycle[0]));
    for (const arc of cycle) flow[arc.debt] += arc.forward ? amount : -amount;
  }
}
