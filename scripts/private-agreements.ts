import { ApiError } from "../src/server/context";
import { runPrivateAgreementCommand } from "../src/server/private-agreements/command";

process.env.NEAR_AI_RETENTION_DAYS = "0";
try {
  const result = await runPrivateAgreementCommand(process.argv.slice(2));
  process.stdout.write(
    result.help ??
      "Saved the selected local private file. No key or decrypted result was sent to Razor. Review plaintext locally before any explicit final-term disclosure.\n",
  );
} catch (error) {
  process.stderr.write(
    error instanceof ApiError
      ? `${error.message}. No result was sent to Razor.\n`
      : "Private agreement processing held. Check local files, new output paths and required NEAR AI verification settings. No result was sent to Razor.\n",
  );
  process.exitCode = 1;
}
