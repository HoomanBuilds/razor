import { setupPreflight } from "../src/server/setup/preflight";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.info("Usage: npm run check:setup -- [--remote] [--json]\nChecks configuration without writing a database or signing transactions. --remote additionally reads Privy login settings and public NEAR contract and key state. Neither mode performs login, inference, email delivery or payment workflows.");
} else if (args.some(arg => !["--remote", "--json"].includes(arg))) {
  console.error("Unknown option. Use --help for supported options.");
  process.exitCode = 2;
} else {
  const report = await setupPreflight({ remote: args.includes("--remote") });
  if (args.includes("--json")) console.info(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.info(`[${check.status}] ${check.stage}/${check.id}: ${check.message}`);
    console.info("Configuration and read-only deployment checks do not establish completed live workflows.");
  }
  if (report.checks.some(check => check.status === "blocked")) process.exitCode = 1;
}
