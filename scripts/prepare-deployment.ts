import { parseArgs } from "node:util";
import { prepareDeployment } from "../src/server/setup/deployment";

try {
  const { values } = parseArgs({ options: { network: { type: "string" }, factory: { type: "string" }, clearing: { type: "string" }, owner: { type: "string" }, "testnet-token": { type: "string" }, artifacts: { type: "string" }, billing: { type: "string" }, "issuer-public-key": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("Usage: npm run prepare:deployment -- --network mainnet|testnet --factory ACCOUNT --clearing ACCOUNT --owner ACCOUNT [--billing ACCOUNT --issuer-public-key ed25519:PUBLIC_KEY] [--testnet-token ACCOUNT] [--artifacts DIRECTORY]\nPrints reviewed deploy-plus-init commands. Does not connect, sign, send, create accounts or change environment files.\n");
  } else {
    if (values.network !== "mainnet" && values.network !== "testnet") throw new Error("Pass --network mainnet or --network testnet");
    if (!values.factory || !values.clearing || !values.owner) throw new Error("Pass --factory, --clearing and --owner accounts");
    const plan = prepareDeployment({ network: values.network, factoryAccount: values.factory, clearingAccount: values.clearing, ownerAccount: values.owner, testnetToken: values["testnet-token"], artifactDirectory: values.artifacts, billingAccount: values.billing, billingIssuerPublicKey: values["issuer-public-key"] });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Could not prepare deployment"}\n`);
  process.exitCode = 1;
}
