import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { publishFinancingScope } from "../src/server/financing/operator";

async function main() {
  const { values } = parseArgs({ options: { operator: { type: "string" }, file: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("Usage: node --max-old-space-size=512 --import tsx scripts/financing-scope.ts --operator EXISTING_USER_ID --file reviewed-scope.json\nPublishes the exact reviewed eligibility, allowlists and deployment identity in the local configured database. Requires an existing RAZOR_FINANCING_OPERATOR_USER_IDS allowlisted operator. No wallet signing, deployment, token transfer or lender guarantee.\n");
    return;
  }
  if (!values.operator || !values.file) throw new Error("Pass --operator and --file, or --help");
  if ((await stat(values.file)).size > 256_000) throw new Error("Financing scope exceeds 256 KB");
  const result = publishFinancingScope(values.operator, JSON.parse(await readFile(values.file, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Scope publication failed"}\n`); process.exitCode = 1; });
