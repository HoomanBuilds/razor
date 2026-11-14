import { ApiError } from "../src/server/context";
import { runCompanyPrivateCommand } from "../src/server/company-private/command";

process.env.NEAR_AI_RETENTION_DAYS = "0";

try {
  const result = await runCompanyPrivateCommand(process.argv.slice(2));
  process.stdout.write(result.help ?? `Saved a private local review file${result.packetWritten ? " and evidence packet" : ""}. No source, key or draft was sent to Razor. Review the selected fields before importing.\n`);
} catch (error) {
  process.stderr.write(error instanceof ApiError ? `${error.message}. No invoice was sent to Razor.\n` : "Company private processing could not complete. Check local file access, new output paths and NEAR AI settings; use --help. No input or result was sent to Razor.\n");
  process.exitCode = 1;
}
