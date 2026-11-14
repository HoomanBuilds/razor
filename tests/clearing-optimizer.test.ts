import assert from "node:assert/strict";
import { test } from "node:test";
import { computeClearing, describeCommittedClearing, type ClearingEdge } from "../src/server/clearing/algorithm";
import { maximumCirculation, maximumCirculationIterations } from "../src/server/clearing/circulation";

const regression: ClearingEdge[] = [
  { id: "01", debtor: "D", creditor: "C", amount: "3" },
  { id: "03", debtor: "C", creditor: "D", amount: "3" },
  { id: "04", debtor: "D", creditor: "B", amount: "3" },
  { id: "05", debtor: "B", creditor: "C", amount: "1" },
];
function assertConserved(input: ClearingEdge[], result: ReturnType<typeof computeClearing>) {
  const balances = new Map<string, bigint>();
  let reduced = 0n, residual = 0n;
  for (const edge of result.obligations) {
    assert.equal(edge.original, input.find(value => value.id === edge.id)!.amount);
    const reduction = BigInt(edge.reduction), remaining = BigInt(edge.residual);
    assert.ok(reduction >= 0n && remaining >= 0n);
    assert.equal(reduction + remaining, BigInt(edge.original));
    balances.set(edge.debtor, (balances.get(edge.debtor) ?? 0n) + reduction);
    balances.set(edge.creditor, (balances.get(edge.creditor) ?? 0n) - reduction);
    reduced += reduction; residual += remaining;
  }
  assert.ok([...balances.values()].every(value => value === 0n));
  assert.ok(result.positions.every(position => position.before === position.after));
  assert.equal(result.dischargedInvoiceValue, reduced.toString());
  assert.equal(result.residualTransferVolume, residual.toString());
  assert.equal(BigInt(result.originalInvoiceValue), reduced + residual);
  assert.ok(result.optimization.arcScans! <= result.optimization.arcScanLimit!);
  assert.ok(result.optimization.iterations! <= result.optimization.iterationLimit!);
}
function exhaustiveObjective(edges: ClearingEdge[]) {
  const parties = [...new Set(edges.flatMap(edge => [edge.debtor, edge.creditor]))], balances = new Array<bigint>(parties.length).fill(0n);
  let best = 0n;
  function visit(index: number, objective: bigint) {
    if (index === edges.length) { if (balances.every(amount => amount === 0n) && objective > best) best = objective; return; }
    const edge = edges[index], from = parties.indexOf(edge.debtor), to = parties.indexOf(edge.creditor);
    for (let amount = 0n; amount <= BigInt(edge.amount); amount++) {
      balances[from] += amount; balances[to] -= amount;
      visit(index + 1, objective + amount);
      balances[from] -= amount; balances[to] += amount;
    }
  }
  visit(0, 0n);
  return best;
}

test("reverse residual arcs improve the four-obligation baseline without reducing starting liquidity", () => {
  const fallback = computeClearing(regression, { iterationLimit: 0 }), improved = computeClearing(regression);
  assert.equal(fallback.dischargedInvoiceValue, "6");
  assert.equal(fallback.residualTransferVolume, "4");
  assert.equal(fallback.optimization.optimal, false);
  assert.equal(fallback.optimization.status, "bounded");
  assert.equal(fallback.optimization.baselineDischargedInvoiceValue, "6");
  assert.equal(improved.dischargedInvoiceValue, "7");
  assert.equal(improved.residualTransferVolume, "3");
  assert.equal(improved.optimization.optimal, true);
  assert.equal(improved.optimization.status, "optimal");
  assert.equal(improved.optimization.iterations, 1);
  assert.equal(fallback.minimumStartingLiquidity, "3");
  assert.equal(improved.minimumStartingLiquidity, "3");
  assertConserved(regression, fallback); assertConserved(regression, improved);
});

test("equal objective choices and input permutations produce identical exact amounts", () => {
  const ties = [
    { id: "a", debtor: "A", creditor: "B", amount: "5" },
    { id: "b", debtor: "A", creditor: "B", amount: "5" },
    { id: "c", debtor: "B", creditor: "A", amount: "5" },
  ];
  const result = computeClearing(ties);
  assert.deepEqual(computeClearing([...ties].reverse()), result);
  assert.deepEqual(result.obligations.map(edge => edge.reduction), ["5", "0", "5"]);
  for (const input of [regression, [...regression].reverse(), [regression[2], regression[0], regression[3], regression[1]]]) assert.deepEqual(computeClearing(input), computeClearing(regression));
});

test("small graphs match exhaustive integer optima and bounded proposals never lose baseline value", () => {
  let seed = 139;
  const random = (bound: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound; };
  for (let sample = 0; sample < 70; sample++) {
    const edges = Array.from({ length: 2 + random(6) }, (_, index) => {
      const debtor = random(4), creditor = (debtor + 1 + random(3)) % 4;
      return { id: String(index), debtor: String(debtor), creditor: String(creditor), amount: String(1 + random(3)) };
    });
    const result = computeClearing(edges), fallback = computeClearing(edges, { iterationLimit: sample % 2 });
    assert.equal(result.optimization.optimal, true);
    assert.equal(BigInt(result.dischargedInvoiceValue), exhaustiveObjective(edges));
    assert.ok(BigInt(fallback.dischargedInvoiceValue) >= BigInt(fallback.optimization.baselineDischargedInvoiceValue!));
    assert.ok(BigInt(result.dischargedInvoiceValue) >= BigInt(fallback.dischargedInvoiceValue));
    assertConserved(edges, result); assertConserved(edges, fallback);
  }
});

test("u128 arithmetic is exact and aggregate discharge overflow still fails", () => {
  const maximum = (1n << 128n) - 1n;
  const edges = [
    { id: "ab", debtor: "A", creditor: "B", amount: maximum.toString() },
    { id: "ba", debtor: "B", creditor: "A", amount: (maximum - 1n).toString() },
  ];
  const result = computeClearing(edges);
  assert.equal(result.residualTransferVolume, "1");
  assert.equal(result.dischargedInvoiceValue, (2n * (maximum - 1n)).toString());
  assertConserved(edges, result);
  assert.throws(() => computeClearing([...edges, { id: "ab2", debtor: "A", creditor: "B", amount: "2" }, { id: "ba2", debtor: "B", creditor: "A", amount: "2" }]), /u128 range/);
  for (const amount of ["", "0", "-1", "01", "1.5", "1e3", (maximum + 1n).toString(), "9".repeat(200)]) assert.throws(() => computeClearing([{ ...edges[0], amount }, edges[1]]), /positive USDC/);
});

test("the full supported graph has a fixed work bound and all capacity limits remain enforced", () => {
  const edges = Array.from({ length: 32 }, (_, index) => ({ id: String(index).padStart(2, "0"), debtor: String(index % 8), creditor: String((index + 1) % 8), amount: String(1 + index) }));
  const result = computeClearing(edges);
  assertConserved(edges, result);
  assert.equal(result.optimization.arcScanLimit, (maximumCirculationIterations + 1) * 8 * 64);
  assert.throws(() => computeClearing(edges.slice(0, 1)), /2 to 32/);
  assert.throws(() => computeClearing([...edges, { ...edges[0], id: "extra" }]), /2 to 32/);
  assert.throws(() => computeClearing([edges[0], { ...edges[1], id: edges[0].id }]), /distinct/);
  assert.throws(() => computeClearing([{ ...edges[0], creditor: edges[0].debtor }, edges[1]]), /different companies/);
  assert.throws(() => computeClearing([...edges.slice(0, 8), { id: "ninth", debtor: "8", creditor: "0", amount: "1" }]), /eight companies/);
  for (const iterationLimit of [-1, 1.5, Infinity, maximumCirculationIterations + 1]) assert.throws(() => computeClearing(regression, { iterationLimit }), /iteration limit/);
  const acyclic = computeClearing([{ id: "ab", debtor: "A", creditor: "B", amount: "7" }, { id: "bc", debtor: "B", creditor: "C", amount: "3" }], { iterationLimit: 0 });
  assert.equal(acyclic.dischargedInvoiceValue, "0"); assert.equal(acyclic.optimization.optimal, true);
});

test("circulation rejects invalid baseline seeds and can report a real bounded result", () => {
  const debts = regression.map(edge => ({ debtor: edge.debtor, creditor: edge.creditor, capacity: BigInt(edge.amount) }));
  assert.throws(() => maximumCirculation(debts, [1n, 0n, 0n, 0n]), /not conserved/);
  assert.throws(() => maximumCirculation(debts, [4n, 4n, 0n, 0n]), /capacity/);
  assert.throws(() => maximumCirculation(debts, []), /bounds/);
  assert.throws(() => maximumCirculation([], []), /bounds/);
  const result = maximumCirculation(debts, [0n, 0n, 0n, 0n], 0);
  assert.equal(result.optimal, false); assert.equal(result.iterations, 0);
  assert.ok(result.arcScans <= result.arcScanLimit);
});

test("historical committed amounts remain conserved and do not inherit a newer optimality claim", () => {
  const baseline = computeClearing(regression, { iterationLimit: 0 });
  const saved = describeCommittedClearing(baseline.obligations);
  assert.deepEqual(saved.obligations, baseline.obligations);
  assert.equal(saved.dischargedInvoiceValue, "6"); assert.equal(saved.residualTransferVolume, "4");
  assert.equal(saved.optimization.status, "unknown"); assert.equal(saved.optimization.optimal, null);
  assert.equal(saved.actualFeesPaid, null);
  const changed = baseline.obligations.map(edge => ({ ...edge }));
  changed[0].residual = "4";
  assert.throws(() => describeCommittedClearing(changed), /original obligation/);
  changed[0].residual = "1"; changed[0].reduction = "2";
  assert.throws(() => describeCommittedClearing(changed), /net position/);
  const current = computeClearing(regression);
  assert.deepEqual(describeCommittedClearing(current.obligations, current.optimization), current);
});
