import { parseArgs } from "node:util";
import { ApiError } from "../src/server/context";
import { runOperatorRecovery } from "../src/server/reconciliation/operator";

const {values}=parseArgs({options:{
  company:{type:"string"},"operator-user":{type:"string"},account:{type:"string"},network:{type:"string"},kind:{type:"string"},
  attempt:{type:"string"},hash:{type:"string"},sender:{type:"string"},token:{type:"string"},"refund-amount":{type:"string"},
  send:{type:"boolean",default:false},"retry-final":{type:"boolean",default:false},help:{type:"boolean",default:false},
}});
const usage="recovery:admin -- --company COMPANY_ID --operator-user USER_ID --account REPORTER.near --network mainnet --kind refund|source|retained --hash ORIGINAL_NEAR_TX --sender ORIGINAL_SIGNER.near [--attempt ATTEMPT_ID] [--token TOKEN.near] [--refund-amount MICRO_USDC] [--send] [--retry-final]";
try{
  if(values.help)process.stdout.write(`${usage}\nDefault: verify and print one unsigned recovery call. --send requires the configured restricted signer. Unknown outcomes reuse the saved signature. --retry-final is accepted only after conclusive failure.\n`);
  else{
    const result=await runOperatorRecovery({company:values.company,operatorUser:values["operator-user"],accountId:values.account??process.env.RAZOR_RECOVERY_ACCOUNT_ID,network:values.network??process.env.RAZOR_RECOVERY_NETWORK,kind:values.kind,transactionHash:values.hash,senderAccountId:values.sender,attemptId:values.attempt,tokenContract:values.token,refundAmount:values["refund-amount"],send:values.send,retryFinal:values["retry-final"]});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
    if(result.held||result.status==="failed")process.exitCode=1;
  }
}catch(error){
  process.stderr.write(`${error instanceof ApiError?`${error.code}: ${error.message}`:"Recovery could not be prepared. Check the documented flags, public deployment settings and original receipts."}\n`);
  process.exitCode=1;
}
