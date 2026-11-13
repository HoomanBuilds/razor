import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { base58 } from "@scure/base";
import { z } from "zod";
import { atomic } from "../../lib/money";
import { ApiError, type AccessContext } from "../context";
import { activity } from "../business/service";
import { getDb, row, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { reviewedArtifactHash } from "../near-artifacts";
import { contractCodeHash, isCompanyBinding, nearTransactionStatus, validNearAccount, view, type FinalTransaction } from "../payments/near";
import { prepareRefundConfirmation } from "../payments/service";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { prepareRetainedRecovery } from "../retained-assets/service";
import { prepareSourceRecovery } from "./source";

const methods = { refund: "confirm_refund", source: "recover_source_transfer", retained: "recover_retained_withdrawal" } as const;
const nearAccount = z.string().refine(validNearAccount, "Use a valid NEAR account");
const hash = z.string().refine(value => { try { return base58.decode(value).length === 32; } catch { return false; } }, "Use a base58 NEAR transaction hash");
const amount = z.string().refine(value => { try { atomic(value, true); return true; } catch { return false; } }, "Use an unsigned integer token amount");
export const operatorRecoveryInput = z.object({
  company: z.string().min(1).max(128), operatorUser: z.string().min(1).max(128), accountId: nearAccount,
  network: z.enum(["mainnet", "testnet"]), kind: z.enum(["refund", "source", "retained"]),
  transactionHash: hash, senderAccountId: nearAccount, attemptId: z.string().min(1).max(128).optional(),
  tokenContract: nearAccount.optional(), refundAmount: amount.optional(), send: z.boolean().default(false), retryFinal: z.boolean().default(false),
}).strict().superRefine((input, ctx) => {
  if (input.kind !== "retained" && !input.attemptId) ctx.addIssue({ code: "custom", path: ["attemptId"], message: "Provide the exact payment attempt" });
  if (input.kind === "retained" && !input.tokenContract) ctx.addIssue({ code: "custom", path: ["tokenContract"], message: "Provide the retained token contract" });
  if (input.kind === "refund" && input.refundAmount === undefined) ctx.addIssue({ code: "custom", path: ["refundAmount"], message: "Provide the exact refund in microUSDC" });
  if (input.retryFinal && !input.send) ctx.addIssue({ code: "custom", path: ["retryFinal"], message: "A final-failure retry requires explicit --send" });
});
export type OperatorRecoveryInput = z.infer<typeof operatorRecoveryInput>;
type Call = WalletTransaction;
interface Plan { walletActions: WalletTransaction[]; eligibleSigners?: string[]; signerAccount?: string; proof?: { transactionHash: string; senderAccountId: string; succeeded?: boolean } }
interface Operation { id: string; request_hash: string; organization_id: string; operator_user_id: string; operator_account_id: string; network: "mainnet" | "testnet"; treasury_account_id: string; company_id: string; kind: OperatorRecoveryInput["kind"]; entity_id: string; request_json: string; wallet_call_json: string; payload_hash: string; status: string }
interface Submission { id: string; operation_id: string; public_key: string; tx_hash: string; signed_transaction_ciphertext: string; status: string; outcome_json: string | null }
interface Company { architecture: string; company_id: string; token_contract: string }
interface Platform { architecture: string; token_contract: string; refund_reporter: string | null }
export interface RecoveryTransport {
  publicKey: string;
  permission(): Promise<unknown>;
  gasPrice(): Promise<string>;
  sign(call: Call): Promise<{ encoded: string; hash: string }>;
  validate(encoded: string, hash: string, call: Call): void;
  send(encoded: string): Promise<FinalTransaction>;
}
export interface OperatorRecoveryDependencies {
  network?: (config: TreasuryConfig) => Promise<string>;
  codeHash?: typeof contractCodeHash;
  platform?: (config: TreasuryConfig) => Promise<Platform>;
  company?: (config: TreasuryConfig) => Promise<Company>;
  prepare?: (access: AccessContext, input: OperatorRecoveryInput) => Promise<Plan>;
  transport?: (config: TreasuryConfig, input: OperatorRecoveryInput) => Promise<RecoveryTransport>;
  lookup?: typeof nearTransactionStatus;
  completed?: (config: TreasuryConfig, call: Call) => Promise<boolean>;
}
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const params = (call: Call) => call.actions[0].params;

async function networkId(config: TreasuryConfig) {
  const { JsonRpcProvider } = await import("near-api-js");
  return new JsonRpcProvider({ url: `https://rpc.${config.network}.near.org` }, { retries: 0 }).getNetworkId();
}

export async function authorizeRecoveryOperator(input: OperatorRecoveryInput, dependencies: OperatorRecoveryDependencies = {}) {
  if (!row("SELECT id FROM users WHERE id=?", input.operatorUser)) throw new ApiError(403, "Choose an existing operator user", "RECOVERY_OPERATOR_UNKNOWN");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", input.company);
  if (!config || config.architecture !== "shared_v1" || !isCompanyBinding(input.company, config.company_id) || config.near_account_id !== process.env.NEAR_TREASURY_ID || config.network !== input.network) throw new ApiError(409, "The selected company is not bound to this configured shared treasury and network", "RECOVERY_COMPANY_MISMATCH");
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", input.operatorUser, input.accountId, input.network)) throw new ApiError(403, "The recovery account must be a verified wallet belonging to this operator user", "RECOVERY_OPERATOR_WALLET_REQUIRED");
  const [network, code, platform, company] = await Promise.all([
    (dependencies.network ?? networkId)(config), (dependencies.codeHash ?? contractCodeHash)(config),
    (dependencies.platform ?? ((target) => view<Platform>(target, "get_platform_config")))(config),
    (dependencies.company ?? ((target) => view<Company>(target, "get_config")))(config),
  ]);
  if (network !== config.network || code !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "The shared treasury network or reviewed code hash does not match", "RECOVERY_DEPLOYMENT_MISMATCH");
  if (platform.architecture !== "shared_v1" || platform.token_contract !== config.token_contract || platform.refund_reporter !== input.accountId || company.architecture !== "shared_v1" || company.company_id !== config.company_id || company.token_contract !== config.token_contract) throw new ApiError(403, "This operator is not the configured platform recovery reporter for the selected company", "RECOVERY_REPORTER_REQUIRED");
  const permissions = input.kind === "retained" ? ["company:read", "company:manage"] : ["company:read", "payments:read", "payments:approve"];
  const access: AccessContext = { userId: input.operatorUser, organizationId: input.company, permissions };
  return { config, access };
}

export function assertRecoveryKey(permission: unknown, receiver: string, method: string, gas: string, gasPrice: string) {
  const key = permission && typeof permission === "object" && "FunctionCall" in permission ? (permission as {FunctionCall: unknown}).FunctionCall : null;
  if (!key || typeof key !== "object") throw new ApiError(403, "Use a restricted function-call recovery key; full-access keys are refused", "RECOVERY_KEY_UNSAFE");
  const value = key as {receiver_id?: unknown; method_names?: unknown; allowance?: unknown};
  const names = value.method_names;
  if (value.receiver_id !== receiver || !Array.isArray(names) || !names.length || names.length > 3 || new Set(names).size !== names.length || !names.includes(method) || names.some(name => typeof name !== "string" || !Object.values(methods).includes(name as typeof methods[keyof typeof methods]))) throw new ApiError(403, "Restrict the key to this shared treasury and only the documented recovery methods", "RECOVERY_KEY_UNSAFE");
  let allowance: bigint, minimum: bigint;
  try {
    if (typeof value.allowance !== "string" && typeof value.allowance !== "bigint") throw new Error();
    allowance = BigInt(value.allowance);
    minimum = BigInt(gas) * BigInt(gasPrice);
    if (minimum <= 0n || allowance < minimum) throw new Error();
  } catch { throw new ApiError(403, "The recovery key needs a bounded allowance covering the reviewed gas at the live network gas price", "RECOVERY_KEY_ALLOWANCE"); }
}

async function transport(config: TreasuryConfig, input: OperatorRecoveryInput): Promise<RecoveryTransport> {
  if (process.env.RAZOR_RECOVERY_ACCOUNT_ID !== input.accountId || process.env.RAZOR_RECOVERY_NETWORK !== config.network || !process.env.RAZOR_RECOVERY_PRIVATE_KEY) throw new ApiError(503, "Configure the exact recovery account, network and restricted private key before --send", "RECOVERY_SIGNER_REQUIRED");
  const { Account, JsonRpcProvider, KeyPairSigner, SignedTransaction, actions } = await import("near-api-js");
  let signer: InstanceType<typeof KeyPairSigner>;
  try {
    if (!process.env.RAZOR_RECOVERY_PRIVATE_KEY.startsWith("ed25519:")) throw new Error();
    signer = KeyPairSigner.fromSecretKey(process.env.RAZOR_RECOVERY_PRIVATE_KEY as `ed25519:${string}`);
  }
  catch { throw new ApiError(503, "The configured recovery private key is invalid", "RECOVERY_SIGNER_REQUIRED"); }
  const publicKey = await signer.getPublicKey();
  const provider = new JsonRpcProvider({ url: `https://rpc.${config.network}.near.org` }, { retries: 0 });
  return {
    publicKey: publicKey.toString(),
    permission: async () => (await provider.viewAccessKey({ accountId: input.accountId, publicKey, finalityQuery: {finality:"final"} })).permission,
    gasPrice: async () => String((await provider.viewGasPrice()).gas_price),
    sign: async call => {
      const value = params(call), account = new Account(input.accountId, provider, signer);
      const signed = await account.createSignedTransaction({receiverId: call.receiverId, actions:[actions.functionCall(value.methodName, value.args, BigInt(value.gas), 0n)]});
      return { encoded: Buffer.from(signed.encode()).toString("base64"), hash: base58.encode(createHash("sha256").update(signed.transaction.encode()).digest()) };
    },
    validate: (encoded, expectedHash, call) => {
      const signed = SignedTransaction.decode(Buffer.from(encoded, "base64")), value = signed.transaction.actions.length === 1 ? signed.transaction.actions[0].functionCall : undefined;
      let args: unknown;
      try { args = value && JSON.parse(Buffer.from(value.args).toString()); } catch {}
      if (base58.encode(createHash("sha256").update(signed.transaction.encode()).digest()) !== expectedHash || signed.transaction.signerId !== input.accountId || signed.transaction.receiverId !== config.near_account_id || signed.transaction.publicKey.toString() !== publicKey.toString() || !value || value.methodName !== params(call).methodName || value.deposit !== 0n || value.gas !== BigInt(params(call).gas) || !isDeepStrictEqual(args, params(call).args)) throw new ApiError(409, "The stored signature differs from the exact reviewed recovery call", "RECOVERY_SIGNATURE_MISMATCH");
    },
    send: async encoded => await provider.sendTransactionUntil(SignedTransaction.decode(Buffer.from(encoded, "base64")), "FINAL") as unknown as FinalTransaction,
  };
}

async function prepare(access: AccessContext, input: OperatorRecoveryInput): Promise<Plan> {
  if (input.kind === "source") return prepareSourceRecovery(access, input.attemptId!, input);
  if (input.kind === "retained") return prepareRetainedRecovery(access, { ...input, tokenContract: input.tokenContract! });
  const result = await prepareRefundConfirmation(access, input.attemptId!, {refundAmount: input.refundAmount!, receipt: input.transactionHash});
  if (BigInt(input.refundAmount!) > 0n) {
    const evidence = row<{evidence: string}>("SELECT evidence FROM shared_refund_receipts WHERE organization_id=? AND attempt_id=? AND commitment=? LIMIT 1", access.organizationId, input.attemptId!, result.evidenceCommitment);
    const proof = evidence && JSON.parse(evidence.evidence) as {transactionHash:string;senderAccountId:string};
    if (!proof || proof.transactionHash !== input.transactionHash || proof.senderAccountId !== input.senderAccountId) throw new ApiError(409, "The verified refund differs from the explicit original transaction and sender", "RECOVERY_PROOF_MISMATCH");
  }
  return result;
}

export function checkedRecoveryCall(config: TreasuryConfig, input: OperatorRecoveryInput, plan: Plan): Call {
  if (plan.walletActions.length !== 1 || plan.walletActions[0].actions.length !== 1) throw new ApiError(409, "Recovery must contain exactly one reviewed contract call", "RECOVERY_CALL_INVALID");
  const call = plan.walletActions[0], value = params(call), args = value.args as Record<string, unknown>;
  const allowed = input.kind === "refund" ? ["company_id","payment_id","attempt_id","refund_amount","receipt"] : input.kind === "source" ? ["company_id","payment_id","attempt_id","succeeded","receipt"] : ["company_id","token_contract","withdrawal_id","succeeded","receipt"];
  if (call.receiverId !== config.near_account_id || value.methodName !== methods[input.kind] || !["0","1"].includes(value.deposit) || !/^\d+$/.test(value.gas) || BigInt(value.gas) < 30_000_000_000_000n || BigInt(value.gas) > 100_000_000_000_000n || !args || typeof args !== "object" || Array.isArray(args) || args.company_id !== config.company_id || Object.keys(args).some(key => !allowed.includes(key)) || allowed.some(key => !(key in args)) || typeof args.receipt !== "string" || !args.receipt.length || args.receipt.length > 2000) throw new ApiError(409, "The recovery call is outside the exact company and method being reviewed", "RECOVERY_CALL_INVALID");
  if (plan.eligibleSigners && !plan.eligibleSigners.includes(input.accountId) || plan.signerAccount && plan.signerAccount !== input.accountId) throw new ApiError(403, "The verified recovery does not authorize this operator signer", "RECOVERY_REPORTER_REQUIRED");
  if (input.kind !== "retained") {
    const attempt = row<{payment_id:string}>("SELECT payment_id FROM payout_attempts WHERE id=? AND organization_id=?", input.attemptId!, config.organization_id);
    if (!attempt || args.attempt_id !== input.attemptId || args.payment_id !== attempt.payment_id || input.kind === "refund" && args.refund_amount !== input.refundAmount) throw new ApiError(409, "The recovery call names another payment or refund amount", "RECOVERY_CALL_INVALID");
  } else if (args.token_contract !== input.tokenContract || typeof args.withdrawal_id !== "string" || !/^[1-9]\d*$/.test(args.withdrawal_id)) throw new ApiError(409, "The recovery call names another retained withdrawal", "RECOVERY_CALL_INVALID");
  if (input.kind !== "refund" && (typeof args.succeeded !== "boolean" || !plan.proof || plan.proof.transactionHash !== input.transactionHash || plan.proof.senderAccountId !== input.senderAccountId || plan.proof.succeeded !== args.succeeded)) throw new ApiError(409, "The recovery proof differs from the explicit original transaction", "RECOVERY_PROOF_MISMATCH");
  return {receiverId:call.receiverId,actions:[{type:"FunctionCall",params:{...value,args:{...args},deposit:"0"}}]};
}

async function completed(config: TreasuryConfig, call: Call) {
  const value = params(call), args = value.args as Record<string, unknown>;
  if (value.methodName === methods.retained) {
    const asset = await view<{withdrawal:{id:string;status:string;receipt:string|null}|null}|null>(config,"get_retained_asset",{token_contract:args.token_contract});
    return !!asset?.withdrawal && asset.withdrawal.id === args.withdrawal_id && asset.withdrawal.status === (args.succeeded ? "succeeded" : "failed") && asset.withdrawal.receipt === args.receipt;
  }
  const payment = await view<{attempts:{id:string;status:string;refund_amount:string;receipt:string|null}[]}|null>(config,"get_payment",{payment_id:args.payment_id});
  const attempt = payment?.attempts.find(item=>item.id===args.attempt_id);
  return !!attempt && (value.methodName === methods.refund ? attempt.status === "refunded" && attempt.refund_amount === args.refund_amount && attempt.receipt === args.receipt : args.succeeded ? ["source_sent","uncertain","refund_pending","refund_verifying","refunded","delivered","partially_delivered"].includes(attempt.status) : attempt.status === "transfer_failed");
}

function lease(input: OperatorRecoveryInput) {
  const token = randomUUID(), expiresAt = Date.now()+180_000;
  transaction(()=>getDb().prepare("INSERT INTO recovery_signer_locks(network,account_id,lease_token,expires_at) VALUES(?,?,?,?) ON CONFLICT(network,account_id) DO UPDATE SET lease_token=excluded.lease_token,expires_at=excluded.expires_at WHERE recovery_signer_locks.expires_at<=?").run(input.network,input.accountId,token,expiresAt,Date.now()));
  const assert = () => { const locked=row<{lease_token:string;expires_at:number}>("SELECT lease_token,expires_at FROM recovery_signer_locks WHERE network=? AND account_id=?",input.network,input.accountId); if(!locked||locked.lease_token!==token||locked.expires_at<=Date.now())throw new ApiError(409,"Another recovery owns this signer or the review lease expired","RECOVERY_SIGNER_BUSY"); };
  assert();
  return {assert,release:()=>getDb().prepare("DELETE FROM recovery_signer_locks WHERE network=? AND account_id=? AND lease_token=?").run(input.network,input.accountId,token)};
}

function publicResult(operation: Operation, submission?: Submission, extra: Record<string,unknown> = {}) {
  const call=JSON.parse(operation.wallet_call_json) as Call;
  return { operationId:operation.id,status:operation.status,company:operation.organization_id,companyId:operation.company_id,operatorUser:operation.operator_user_id,signerAccount:operation.operator_account_id,network:operation.network,kind:operation.kind,transactionHash:submission?.tx_hash??null,signed:!!submission,reviewedCall:call,walletActions:operation.status==="prepared"?[call]:[],...extra };
}

export async function runOperatorRecovery(raw: unknown, dependencies: OperatorRecoveryDependencies = {}) {
  const input = operatorRecoveryInput.parse(raw), {config,access} = await authorizeRecoveryOperator(input,dependencies);
  const request = {...input}; delete (request as Partial<OperatorRecoveryInput>).send; delete (request as Partial<OperatorRecoveryInput>).retryFinal;
  const requestHash=digest(request), entityId=input.kind==="retained"?input.tokenContract!:input.attemptId!;
  if(row("SELECT id FROM recovery_operations WHERE organization_id=? AND kind=? AND entity_id=? AND request_hash!=? AND status IN ('prepared','signed','uncertain')",input.company,input.kind,entityId,requestHash))throw new ApiError(409,"A different recovery for this same entity is unresolved. Reconcile its original signature first","RECOVERY_OUTCOME_UNKNOWN");
  let operation=row<Operation>("SELECT * FROM recovery_operations WHERE request_hash=?",requestHash);
  let submission=operation&&row<Submission>("SELECT * FROM recovery_submissions WHERE operation_id=? ORDER BY rowid DESC LIMIT 1",operation.id);
  const recordOutcome = async (outcome: FinalTransaction) => {
    if (!operation || !submission || outcome.final_execution_status!=="FINAL" || outcome.transaction?.hash!==submission.tx_hash || outcome.transaction.signer_id!==input.accountId || outcome.transaction.receiver_id!==config.near_account_id) return false;
    const status=outcome.status;
    if(!status||!("Failure"in status||"SuccessValue"in status))return false;
    let returned: unknown;
    try{if("SuccessValue"in status&&typeof status.SuccessValue==="string")returned=JSON.parse(Buffer.from(status.SuccessValue,"base64").toString());}catch{}
    const scoped=returned===true&&await(dependencies.completed??completed)(config,JSON.parse(operation.wallet_call_json));
    if(returned===true&&!scoped)return false;
    const success=returned===true&&scoped;
    const finalStatus=success?"confirmed":"failed", submissionStatus=success?"confirmed":"Failure"in status?"failed":"refused";
    transaction(()=>{
      getDb().prepare("UPDATE recovery_submissions SET status=?,outcome_json=?,updated_at=? WHERE id=?").run(submissionStatus,JSON.stringify(outcome),now(),submission!.id);
      getDb().prepare("UPDATE recovery_operations SET status=?,updated_at=? WHERE id=?").run(finalStatus,now(),operation!.id);
      activity(access,`recovery.operator_${finalStatus}`,operation!.id,{kind:input.kind,transactionHash:submission!.tx_hash});
    });
    operation={...operation,status:finalStatus};submission={...submission,status:submissionStatus};return true;
  };
  if(operation?.status==="confirmed")return publicResult(operation,submission,{alreadyReconciled:true});
  if(submission&&!['confirmed','failed','refused'].includes(submission.status)){
    try{await recordOutcome(await(dependencies.lookup??nearTransactionStatus)(config,submission.tx_hash,input.accountId));}catch{}
    if(operation!.status==="confirmed")return publicResult(operation!,submission,{alreadyReconciled:true});
    if(!input.send)return publicResult(operation!,submission,{held:true,sameSignedTransactionOnly:true,message:"An original signature is unresolved. Review this exact transaction; no replacement has been created."});
    if(input.retryFinal&&!['failed','refused'].includes(submission.status))throw new ApiError(409,"The original recovery outcome is unknown. A replacement signature is forbidden","RECOVERY_OUTCOME_UNKNOWN");
  }
  if(operation?.status==="failed"&&!input.retryFinal)return publicResult(operation,submission,{held:true,message:"The final recovery failed or refused to restore credit. Review its receipts and state before --retry-final --send."});
  let signer: RecoveryTransport|undefined;
  if(input.send){
    signer=await(dependencies.transport??transport)(config,input);
    const permission=await signer.permission(),gasPrice=await signer.gasPrice();
    assertRecoveryKey(permission,config.near_account_id,methods[input.kind],"100000000000000",gasPrice);
  }
  const lock=input.send?lease(input):undefined;
  try{
    if(!submission||['failed','refused'].includes(submission.status)){
      if(submission&&!input.retryFinal)throw new ApiError(409,"An explicit final-failure retry is required","RECOVERY_RETRY_REVIEW_REQUIRED");
      const plan=await(dependencies.prepare??prepare)(access,input),call=checkedRecoveryCall(config,input,plan),payloadHash=digest(call);
      transaction(()=>{
        lock?.assert();
        const blocked=row<Operation>("SELECT * FROM recovery_operations WHERE organization_id=? AND kind=? AND entity_id=? AND request_hash!=? AND status IN ('prepared','signed','uncertain')",input.company,input.kind,entityId,requestHash);
        if(blocked)throw new ApiError(409,"A different recovery for this same entity is unresolved. Reconcile its original signature first","RECOVERY_OUTCOME_UNKNOWN");
        if(operation&&operation.payload_hash!==payloadHash)throw new ApiError(409,"The fresh verified recovery terms differ from the saved review","RECOVERY_REVIEW_CHANGED");
        if(!operation){
          const id=randomUUID();
          getDb().prepare("INSERT INTO recovery_operations(id,request_hash,organization_id,operator_user_id,operator_account_id,network,treasury_account_id,company_id,kind,entity_id,request_json,wallet_call_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)").run(id,requestHash,input.company,input.operatorUser,input.accountId,input.network,config.near_account_id,config.company_id!,input.kind,entityId,JSON.stringify(request),JSON.stringify(call),payloadHash,now(),now());
          activity(access,"recovery.operator_prepared",id,{kind:input.kind,originalTransactionHash:input.transactionHash,signer:input.accountId});
        }
      });
      operation=row<Operation>("SELECT * FROM recovery_operations WHERE request_hash=?",requestHash)!;
      if(!input.send)return publicResult(operation,undefined,{broadcast:false,message:"Unsigned verified recovery. Review the exact company and call; --send is required to broadcast."});
      lock!.assert();
      const signed=await signer!.sign(call);
      signer!.validate(signed.encoded,signed.hash,call);
      transaction(()=>{
        lock!.assert();
        const existing=row<Submission>("SELECT * FROM recovery_submissions WHERE operation_id=? ORDER BY rowid DESC LIMIT 1",operation!.id);
        if(existing&&!['failed','refused'].includes(existing.status))throw new ApiError(409,"An original signed recovery already exists. Reconcile it before another signature","RECOVERY_OUTCOME_UNKNOWN");
        getDb().prepare("INSERT INTO recovery_submissions(id,operation_id,public_key,tx_hash,signed_transaction_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?,?,'signed',?,?)").run(randomUUID(),operation!.id,signer!.publicKey,signed.hash,encrypt(signed.encoded),now(),now());
        getDb().prepare("UPDATE recovery_operations SET status='signed',updated_at=? WHERE id=?").run(now(),operation!.id);
      });
      submission=row<Submission>("SELECT * FROM recovery_submissions WHERE operation_id=? ORDER BY rowid DESC LIMIT 1",operation.id)!;
      operation={...operation,status:"signed"};
    }
    lock!.assert();
    if(!operation||!submission||submission.public_key!==signer!.publicKey||operation.payload_hash!==digest(JSON.parse(operation.wallet_call_json)))throw new ApiError(409,"The durable recovery signature no longer matches its reviewed operator and call","RECOVERY_SIGNATURE_MISMATCH");
    const call=JSON.parse(operation.wallet_call_json) as Call,encoded=decrypt(submission.signed_transaction_ciphertext);
    signer!.validate(encoded,submission.tx_hash,call);
    try{
      const outcome=await signer!.send(encoded);
      if(!await recordOutcome(outcome))throw new Error("Recovery outcome is unresolved");
      return publicResult(operation,submission,{broadcast:true,final:true});
    }catch{
      transaction(()=>{
        getDb().prepare("UPDATE recovery_submissions SET status='uncertain',updated_at=? WHERE id=? AND status='signed'").run(now(),submission!.id);
        getDb().prepare("UPDATE recovery_operations SET status='uncertain',updated_at=? WHERE id=? AND status='signed'").run(now(),operation!.id);
      });
      operation=row<Operation>("SELECT * FROM recovery_operations WHERE id=?",operation.id)!;
      return publicResult(operation,submission,{held:true,sameSignedTransactionOnly:true,message:"The broadcast outcome is unknown. Repeating this command may only reconcile or rebroadcast the saved signature."});
    }
  }finally{lock?.release();}
}
