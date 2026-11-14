import { ApiError } from "../src/server/context";
import { runSupportAdmin } from "../src/server/support/command";

try {
 const result=await runSupportAdmin(process.argv.slice(2));
 process.stdout.write(`${"help" in result?result.help:JSON.stringify(result,null,2)}\n`);
} catch(error) {
 process.stderr.write(`${error instanceof ApiError?`${error.code}: ${error.message}`:"Support administration could not complete. Check the command, explicit operator allowlist and local database access; use --help."}\n`);
 process.exitCode=1;
}
