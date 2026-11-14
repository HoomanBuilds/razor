import { tickOperations } from "../src/server/operations/worker";
import { tickBilling } from "../src/server/billing/worker";
import { processPendingInvoiceEvents } from "../src/server/invoice-channels/service";
import { dispatchIntegrationWebhooks } from "../src/server/integrations";
import { monitorDistributions } from "../src/server/distributions/service";
import { dispatchAccountingJobs } from "../src/server/accounting";
import { dispatchNetSuiteJobs } from "../src/server/netsuite/service";
import { expireSupportCases } from "../src/server/support";
import { purgeEvidenceShares } from "../src/server/evidence-sharing";
import { monitorFundedRounds } from "../src/server/clearing/funded";

const args = process.argv.slice(2);
const organizationId = args.find((arg) => arg.startsWith("--organization="))?.slice("--organization=".length);
const once = args.includes("--once");
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });

do {
  const result: Record<string, unknown> = { at: new Date().toISOString() };
  const tasks = [
    ["operations", () => tickOperations({ organizationId, maxJobs: 20 })],
    ["billing", () => tickBilling(organizationId)],
    ["invoiceIntake", () => processPendingInvoiceEvents({ organizationId, maxEvents: 1 })],
    ["distributions", () => monitorDistributions({ organizationId, maxPools: 1 })],
    ["fundedClearing", () => monitorFundedRounds(2, organizationId)],
    ["accounting", () => dispatchAccountingJobs({ organizationId, maxJobs: 1 })],
    ["netsuite", () => dispatchNetSuiteJobs({ organizationId, maxJobs: 1 })],
    ["evidenceShareRetention", () => organizationId ? { skipped: true, scope: "global_housekeeping" } : purgeEvidenceShares()],
    ["supportRetention", () => organizationId ? { skipped: true, scope: "global_housekeeping" } : expireSupportCases()],
    ["webhooks", () => dispatchIntegrationWebhooks({ organizationId, limit: 5 })],
  ] as const;
  for (const [name, tick] of tasks) {
    try { result[name] = await tick(); }
    catch { result[name] = { error: "Tick failed. Check database availability and worker configuration." }; if (once) process.exitCode = 1; }
  }
  console.info(JSON.stringify(result));
  if (once || stopped) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
} while (!stopped);
