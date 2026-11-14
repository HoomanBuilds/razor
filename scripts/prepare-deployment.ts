import { parseArgs } from "node:util";
import { prepareDeployment } from "../src/server/setup/deployment";

try {
  const { values } = parseArgs({
    options: {
      network: { type: "string" },
      "upgrade-policy": { type: "string" },
      treasury: { type: "string" },
      clearing: { type: "string" },
      owner: { type: "string" },
      "testnet-token": { type: "string" },
      artifacts: { type: "string" },
      billing: { type: "string" },
      credit: { type: "string" },
      evidence: { type: "string" },
      "issuer-public-key": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: npm run prepare:deployment -- --network mainnet|testnet --treasury ACCOUNT --owner ACCOUNT [--clearing ACCOUNT] [--billing ACCOUNT --issuer-public-key ed25519:PUBLIC_KEY] [--credit ACCOUNT] [--evidence ACCOUNT] [--testnet-token ACCOUNT] [--artifacts DIRECTORY] [--upgrade-policy immutable|owner_controlled]\nPrints reviewed deploy-plus-init commands. Does not connect, sign, send, create accounts or change environment files.\n",
    );
  } else {
    if (values.network !== "mainnet" && values.network !== "testnet")
      throw new Error("Pass --network mainnet or --network testnet");
    if (!values.treasury || !values.owner)
      throw new Error("Pass --treasury and --owner accounts");
    if (values["upgrade-policy"] && values["upgrade-policy"] !== "immutable" && values["upgrade-policy"] !== "owner_controlled")
      throw new Error("Pass --upgrade-policy immutable or owner_controlled");
    const plan = prepareDeployment({
      upgradePolicy: values["upgrade-policy"] as "immutable" | "owner_controlled" | undefined,
      network: values.network,
      treasuryAccount: values.treasury,
      clearingAccount: values.clearing,
      ownerAccount: values.owner,
      testnetToken: values["testnet-token"],
      artifactDirectory: values.artifacts,
      billingAccount: values.billing,
      billingIssuerPublicKey: values["issuer-public-key"],
      creditAccount: values.credit,
      evidenceAccount: values.evidence,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Could not prepare deployment"}\n`,
  );
  process.exitCode = 1;
}
