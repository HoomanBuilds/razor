import { tickOperations } from "../src/server/operations/worker";
import { tickBilling } from "../src/server/billing/worker";

const args = process.argv.slice(2);
const organizationId = args.find((arg) => arg.startsWith("--organization="))?.slice("--organization=".length);
const once = args.includes("--once");
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });

do {
  try { console.info(JSON.stringify({ at: new Date().toISOString(), ...await tickOperations({ organizationId, maxJobs: 20 }), billing: await tickBilling(organizationId) })); }
  catch { console.error("Operations tick failed. Check database availability and worker configuration."); if (once) process.exitCode = 1; }
  if (once || stopped) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
} while (!stopped);
