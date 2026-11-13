import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { atomic, parseUnits } from "../src/lib/money";
import { ApiError } from "../src/server/context";
import { listPlanVersions, publishPlanVersion, retirePlanVersion, validatePlanPublication } from "../src/server/billing/catalog";
import { billingSettings, verifyBillingContract } from "../src/server/billing/chain";
import { operatorBillingInvoices, prepareRefundForOperator, reconcileInvoiceForOperator, reconcileRefundForOperator } from "../src/server/billing/payments";
import { getSubscriptionState } from "../src/server/billing/subscriptions";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  input: { type: "string" }, id: { type: "string" }, company: { type: "string" }, output: { type: "string" },
  amount: { type: "string" }, page: { type: "string" }, "page-size": { type: "string" }, apply: { type: "boolean", default: false },
} });
const required = (key: "input" | "id" | "company" | "output" | "amount") => {
  const value = values[key];
  if (!value?.trim()) throw new Error(`Provide --${key}`);
  return value.trim();
};
const apply = () => {
  if (!values.apply) throw new Error("This command records billing state. Review its identifiers and rerun with --apply.");
};

async function run() {
  if (positionals.length !== 1) throw new Error("Provide exactly one billing command");
  switch (positionals[0]) {
    case "catalog": return { plans: listPlanVersions() };
    case "publish-plan": {
      const input = validatePlanPublication(JSON.parse(readFileSync(resolve(required("input")), "utf8")));
      return values.apply ? { applied: true, plan: publishPlanVersion(input) } : { applied: false, preview: input, nextStep: "Review this version and rerun with --apply to publish. Existing purchase terms stay fixed." };
    }
    case "retire-plan": {
      const id = required("id");
      if (!values.apply) return { applied: false, id, nextStep: "Publish a replacement before retiring a plan. Rerun with --apply to retire this version for new purchases." };
      return { applied: true, plan: retirePlanVersion(id) };
    }
    case "status": return getSubscriptionState(required("company"));
    case "invoices": return operatorBillingInvoices(values.company, Number(values.page ?? 1), Number(values["page-size"] ?? 25));
    case "prepare-refund": apply(); return prepareRefundForOperator(required("id"));
    case "reconcile-invoice": apply(); return reconcileInvoiceForOperator(required("company"), required("id"));
    case "reconcile-refund": apply(); return reconcileRefundForOperator(required("id"));
    case "prepare-withdrawal": {
      const amount = parseUnits(required("amount"), 6);
      atomic(amount);
      const target = billingSettings(), verified = await verifyBillingContract(target);
      if (verified.config.withdrawal_pending || BigInt(verified.config.available) < BigInt(amount)) throw new Error("The billing reserve is insufficient or an earlier withdrawal is pending. Reconcile the original action first.");
      return { signed: false, amount, currency: "USDC", network: target.network, signerAccount: verified.config.owner_id, receiver: verified.config.owner_id, blockHash: verified.blockHash,
        walletActions: [{ receiverId: target.billingContract, actions: [{ type: "FunctionCall", params: { methodName: "withdraw", args: { amount }, deposit: "1", gas: "60000000000000" } }] }],
        note: "Review the refund reserve before signing. This command does not broadcast or hold the owner's signing key." };
    }
    case "issuer-key": {
      const path = resolve(required("output")), seed = randomBytes(32), publicBytes = ed25519.getPublicKey(seed);
      const publicKey = `ed25519:${base58.encode(publicBytes)}`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `RAZOR_BILLING_ISSUER_PRIVATE_KEY=ed25519:${base58.encode(Buffer.concat([seed, publicBytes]))}\n`, { mode: 0o600, flag: "wx" });
      seed.fill(0);
      return { publicKey, secretFile: path, note: "Load this private file into the server environment. Keep it ignored and backed up securely. Only the public key belongs in the contract deployment." };
    }
    default: throw new Error("Commands: catalog, publish-plan, retire-plan, status, invoices, prepare-refund, reconcile-invoice, reconcile-refund, prepare-withdrawal, issuer-key");
  }
}

try { process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`); }
catch (error) {
  const message = error instanceof ApiError ? error.message : error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "Invalid billing input. Check the documented plan schema and command arguments.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
