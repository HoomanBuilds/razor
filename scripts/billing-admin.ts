import {
  listServiceCostObservations,
  recordServiceCostObservation,
  requireCommercialOperator,
  prepareCapabilityPolicy,
} from "../src/server/billing/capability-policy";
import { costObservationInput } from "../src/server/billing/capability-model";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { atomic, parseUnits } from "../src/lib/money";
import { ApiError } from "../src/server/context";
import {
  listPlanVersions,
  publishPlanVersion,
  retirePlanVersion,
  validatePlanPublication,
} from "../src/server/billing/catalog";
import {
  billingSettings,
  verifyBillingContract,
} from "../src/server/billing/chain";
import {
  operatorBillingInvoices,
  prepareRefundForOperator,
  reconcileInvoiceForOperator,
  reconcileRefundForOperator,
} from "../src/server/billing/payments";
import { getSubscriptionState } from "../src/server/billing/subscriptions";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "operator-user": { type: "string" },
    input: { type: "string" },
    id: { type: "string" },
    company: { type: "string" },
    output: { type: "string" },
    amount: { type: "string" },
    page: { type: "string" },
    "page-size": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const required = (key: "input" | "id" | "company" | "output" | "amount") => {
  const value = values[key];
  if (!value?.trim()) throw new Error(`Provide --${key}`);
  return value.trim();
};
const apply = () => {
  if (!values.apply)
    throw new Error(
      "This command records billing state. Review its identifiers and rerun with --apply.",
    );
};

async function readCommercialInput(path: string) {
  const file = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > 65536
    )
      throw new Error(
        "Choose a regular local JSON file up to 64 KB without links",
      );
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > 65536) throw new Error("The commercial JSON exceeds 64 KB");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    await file.close();
  }
}

async function run() {
  if (positionals.length !== 1)
    throw new Error("Provide exactly one billing command");
  switch (positionals[0]) {
    case "catalog":
      return { plans: listPlanVersions() };
    case "cost-observations":
      return listServiceCostObservations(
        values["operator-user"] ?? "",
        Number(values.page ?? 1),
      );
    case "record-service-cost": {
      const actor = values["operator-user"] ?? "";
      requireCommercialOperator(actor);
      const input = costObservationInput.parse(
        await readCommercialInput(required("input")),
      );
      if (!values.apply)
        return {
          applied: false,
          preview: input,
          nextStep:
            "Review actual service expense source, period, sample, units and any explicit conversion. Rerun with --apply to retain this immutable observation.",
        };
      return {
        applied: true,
        observation: recordServiceCostObservation(actor, input),
      };
    }
    case "publish-plan": {
      requireCommercialOperator(values["operator-user"] ?? "");
      const input = validatePlanPublication(
        await readCommercialInput(required("input")),
      );
      return values.apply
        ? {
            applied: true,
            plan: publishPlanVersion(input, values["operator-user"] ?? ""),
          }
        : {
            applied: false,
            preview: input,
            derivedCapabilityPolicy: prepareCapabilityPolicy(
              input.capabilityPolicy,
              input.monthlyAmount,
            ),
            nextStep:
              "Review this version and rerun with --apply to publish. Existing purchase terms stay fixed.",
          };
    }
    case "retire-plan": {
      const actor = values["operator-user"] ?? "";
      requireCommercialOperator(actor);
      const id = required("id");
      if (!values.apply)
        return {
          applied: false,
          id,
          nextStep:
            "Publish a replacement before retiring a plan. Rerun with --apply to retire this version for new purchases.",
        };
      return { applied: true, plan: retirePlanVersion(id, actor) };
    }
    case "status":
      return getSubscriptionState(required("company"));
    case "invoices":
      return operatorBillingInvoices(
        values.company,
        Number(values.page ?? 1),
        Number(values["page-size"] ?? 25),
      );
    case "prepare-refund":
      apply();
      return prepareRefundForOperator(required("id"));
    case "reconcile-invoice":
      apply();
      return reconcileInvoiceForOperator(required("company"), required("id"));
    case "reconcile-refund":
      apply();
      return reconcileRefundForOperator(required("id"));
    case "prepare-withdrawal": {
      const amount = parseUnits(required("amount"), 6);
      atomic(amount);
      const target = billingSettings(),
        verified = await verifyBillingContract(target);
      if (
        verified.config.withdrawal_pending ||
        BigInt(verified.config.available) < BigInt(amount)
      )
        throw new Error(
          "The billing reserve is insufficient or an earlier withdrawal is pending. Reconcile the original action first.",
        );
      return {
        signed: false,
        amount,
        currency: "USDC",
        network: target.network,
        signerAccount: verified.config.owner_id,
        receiver: verified.config.owner_id,
        blockHash: verified.blockHash,
        walletActions: [
          {
            receiverId: target.billingContract,
            actions: [
              {
                type: "FunctionCall",
                params: {
                  methodName: "withdraw",
                  args: { amount },
                  deposit: "1",
                  gas: "60000000000000",
                },
              },
            ],
          },
        ],
        note: "Review the refund reserve before signing. This command does not broadcast or hold the owner's signing key.",
      };
    }
    case "issuer-key": {
      const path = resolve(required("output")),
        seed = randomBytes(32),
        publicBytes = ed25519.getPublicKey(seed);
      const publicKey = `ed25519:${base58.encode(publicBytes)}`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        `RAZOR_BILLING_ISSUER_PRIVATE_KEY=ed25519:${base58.encode(Buffer.concat([seed, publicBytes]))}\n`,
        { mode: 0o600, flag: "wx" },
      );
      seed.fill(0);
      return {
        publicKey,
        secretFile: path,
        note: "Load this private file into the server environment. Keep it ignored and backed up securely. Only the public key belongs in the contract deployment.",
      };
    }
    default:
      throw new Error(
        "Commands: catalog, cost-observations, record-service-cost, publish-plan, retire-plan, status, invoices, prepare-refund, reconcile-invoice, reconcile-refund, prepare-withdrawal, issuer-key",
      );
  }
}

try {
  process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
} catch (error) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error &&
          !["ZodError", "SyntaxError"].includes(error.name)
        ? error.message
        : "Invalid billing input. Check the documented plan schema and command arguments.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
