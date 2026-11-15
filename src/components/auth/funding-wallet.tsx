"use client";

import { isPublicDemo, requireLiveWallet } from "@/lib/demo-scope";
import { DemoAction } from "@/components/demo/demo-action";

import { withTaskDrawerWallet } from "@/components/workspace/task-drawer";

import { ContractUpgradeDisclosure } from "@/components/contract-upgrade-disclosure";
import type { ContractUpgradePolicy } from "@/lib/contract-upgrade-policy";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPublicClient, createWalletClient, custom, decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, isAddress, type Chain, type EIP1193Provider } from "viem";
import { mainnet, base, arbitrum, polygon, optimism, bsc, avalanche, gnosis, aurora, berachain, monad, plasma, scroll, linea, mantle, blast, celo, zkSync, abstract } from "viem/chains";
import { Copy, ExternalLink, Wallet } from "lucide-react";
import { connectNearWallet, identityRequest, walletErrorMessage, type AuthConfig } from "./wallets";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { DIRECT_USDC_ASSET, isDirectFunding, validateDirectFunding } from "@/lib/direct-funding";
import { NATIVE_USDC } from "@/lib/native-usdc";

export interface FundingWalletActionProps {
  compact?: boolean;
  upgradePolicy?:ContractUpgradePolicy|null;
  funding:{id:string;origin_asset:string;amount_in:string;deposit_address:string;deposit_memo:string|null;quote:string|object;status:string;source_tx_hash?:string|null};
  token:{assetId:string;symbol:string;blockchain:string;decimals:number;contractAddress?:string|null};
  onSubmitted:(txHash:string)=>Promise<void>;
  beforeSend?:()=>Promise<void>;
  depositAllowed?:boolean;
  onBroadcast?:(txHash:string)=>Promise<void>;
}

interface BoundQuote {quoteRequest:{originAsset:string;refundTo:string;dry:boolean;deadline:string;depositType:string};quote:{amountIn:string;depositAddress:string;depositMemo?:string;deadline?:string;timeWhenInactive?:string;amountInUsd?:string}}
interface SourceReceipt {hash:string;confirmed:boolean;sender:string}
const EVM_CHAINS:Record<string,Chain>={eth:mainnet,base,arb:arbitrum,pol:polygon,op:optimism,bsc,avax:avalanche,gnosis,aurora,bera:berachain,monad,plasma,scroll,linea,mantle,blast,celo,zksync:zkSync,abs:abstract};
const NEAR_ACCOUNT=/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;
const storageKey=(id:string)=>`razor:funding:${id}:v1`;

export function validateFundingQuote(funding:FundingWalletActionProps["funding"],token:FundingWalletActionProps["token"]):BoundQuote {
  let quote:BoundQuote;
  try {quote=typeof funding.quote==="string"?JSON.parse(funding.quote):funding.quote as BoundQuote;} catch {throw new Error("This funding quote cannot be read. Create a fresh funding request.");}
  if(token.assetId!==funding.origin_asset || quote?.quoteRequest?.originAsset!==funding.origin_asset || quote.quote?.amountIn!==funding.amount_in || quote.quote.depositAddress!==funding.deposit_address || (quote.quote.depositMemo || null)!==(funding.deposit_memo || null) || quote.quoteRequest.dry!==false || quote.quoteRequest.depositType!=="ORIGIN_CHAIN" || typeof quote.quoteRequest.refundTo!=="string" || !quote.quoteRequest.refundTo) throw new Error("The funding instructions do not match the quoted asset, amount and destination. Create a fresh funding request.");
  if(!/^[1-9]\d*$/.test(funding.amount_in) || !Number.isInteger(token.decimals) || token.decimals<0 || token.decimals>38) throw new Error("The funding amount or token decimals are invalid.");
  if(isDirectFunding(quote)) {
    validateDirectFunding(quote,funding);
    if(token.assetId!==DIRECT_USDC_ASSET || token.blockchain!=="near" || token.contractAddress!==NATIVE_USDC.near || token.decimals!==6 || token.symbol!=="USDC") throw new Error("Direct funding requires the verified native USDC token on NEAR mainnet.");
  }
  const deadline=Date.parse(quote.quote.deadline || quote.quoteRequest.deadline);
  const inactive=Date.parse(quote.quote.timeWhenInactive || "");
  if(Number.isFinite(inactive) && inactive<=Date.now())throw new Error("These deposit instructions need refreshing before a new transfer. Check any existing deposit first.");
  if(!Number.isFinite(deadline) || deadline<=Date.now()) throw new Error("This funding quote expired. Create a fresh request before transferring.");
  if(funding.status!=="pending_deposit") throw new Error("This funding request has already moved past the deposit step. Check its status before making another transfer.");
  return quote;
}

export function selectFundingAccount(accounts: readonly string[], refundTo: string, evm = false) {
  const account = accounts.find(value => evm ? value.toLowerCase() === refundTo.toLowerCase() : value === refundTo);
  if (!account) throw new Error("Connect the account selected as this quote's refund address, or create a new quote for the account you control.");
  return account;
}

async function transferEvm(props:FundingWalletActionProps,quote:BoundQuote,onHash:(hash:string,sender:string)=>void):Promise<SourceReceipt> {
  const chain=EVM_CHAINS[props.token.blockchain],provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;
  if(!chain || !provider) throw new Error("Open a compatible EVM wallet, or use the deposit instructions below.");
  if(props.funding.deposit_memo) throw new Error("This route requires a memo. Use a wallet that supports the exact deposit instructions.");
  if(!isAddress(props.funding.deposit_address)) throw new Error("The quote returned an invalid EVM deposit address. Create another funding request.");
  const wallet=createWalletClient({chain,transport:custom(provider)}),sender=getAddress(selectFundingAccount(await wallet.requestAddresses(),quote.quoteRequest.refundTo,true));
  if(!sender) throw new Error("Select a source account in your wallet.");
  if(sender.toLowerCase()!==quote.quoteRequest.refundTo.toLowerCase()) throw new Error("Connect the wallet entered as this quote's refund address, or create a new funding request using your connected wallet.");
  if(await wallet.getChainId()!==chain.id) await wallet.switchChain({id:chain.id});
  if(await wallet.getChainId()!==chain.id) throw new Error(`Switch your wallet to ${chain.name}, then try again.`);
  const current=await wallet.getAddresses();
  if(!current.some(account=>account.toLowerCase()===sender.toLowerCase())) throw new Error("Your wallet changed accounts. Reconnect before continuing.");
  const rpc=createPublicClient({chain,transport:http()}),amount=BigInt(props.funding.amount_in),destination=getAddress(props.funding.deposit_address);
  let hash:`0x${string}`;
  let expectedTo=destination,expectedData:`0x${string}`="0x",expectedValue=amount;
  if(props.token.contractAddress) {
    if(!isAddress(props.token.contractAddress)) throw new Error("The live catalog returned an invalid token contract. Use a fresh quote.");
    const contract=getAddress(props.token.contractAddress);
    const [decimals,balance]=await Promise.all([rpc.readContract({address:contract,abi:erc20Abi,functionName:"decimals"}),rpc.readContract({address:contract,abi:erc20Abi,functionName:"balanceOf",args:[sender]})]);
    if(decimals!==props.token.decimals) throw new Error("The token decimals differ from the live catalog. Refresh the asset list.");
    if(balance<amount) throw new Error(`Your wallet has insufficient ${props.token.symbol} for this deposit.`);
    const data=encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[destination,amount]});
    expectedTo=contract;expectedData=data;expectedValue=0n;
    const simulation=await rpc.call({account:sender,to:contract,data});
    if(simulation.data && simulation.data!=="0x" && !decodeFunctionResult({abi:erc20Abi,functionName:"transfer",data:simulation.data})) throw new Error("The token contract did not accept this transfer.");
    await rpc.estimateGas({account:sender,to:contract,data});
    validateFundingQuote(props.funding,props.token);
    await props.beforeSend?.();
    hash=await wallet.sendTransaction({account:sender,to:contract,data});
  } else {
    const gas=await rpc.estimateGas({account:sender,to:destination,value:amount});
    const [balance,gasPrice]=await Promise.all([rpc.getBalance({address:sender}),rpc.getGasPrice()]);
    if(balance<amount+gas*gasPrice) throw new Error(`Keep enough ${chain.nativeCurrency.symbol} in your wallet for the deposit and network fee.`);
    validateFundingQuote(props.funding,props.token);
    await props.beforeSend?.();
    hash=await wallet.sendTransaction({account:sender,to:destination,value:amount});
  }
  onHash(hash,sender);
  const receipt=await rpc.waitForTransactionReceipt({hash,confirmations:1,timeout:120_000});
  if(receipt.status!=="success") throw new Error("The source transaction reverted. Check its explorer receipt before making a new funding request.");
  const confirmed=await rpc.getTransaction({hash:receipt.transactionHash});
  if(confirmed.from.toLowerCase()!==sender.toLowerCase() || confirmed.to?.toLowerCase()!==expectedTo.toLowerCase() || confirmed.input!==expectedData || confirmed.value!==expectedValue) throw new Error("The source transaction was replaced with different transfer details. Check its receipt before continuing.");
  if(receipt.transactionHash!==hash) onHash(receipt.transactionHash,sender);
  return {hash:receipt.transactionHash,sender,confirmed:true};
}

async function transferNear(props:FundingWalletActionProps,quote:BoundQuote,onHash:(hash:string,sender:string)=>void):Promise<SourceReceipt> {
  const config=await identityRequest<AuthConfig>("/auth/config");
  if(config.nearNetwork!=="mainnet") throw new Error("This deposit uses NEAR mainnet. Your Razor wallet connection is on testnet. Use the mainnet deposit instructions below.");
  const {wallet,accounts}=await connectNearWallet({accountId:quote.quoteRequest.refundTo}),sender=selectFundingAccount(accounts.map(account=>account.accountId),quote.quoteRequest.refundTo),contract=props.token.contractAddress;
  if(sender!==quote.quoteRequest.refundTo) throw new Error("Connect the NEAR account entered as this quote's refund address, or create a new funding request.");
  if(props.funding.deposit_memo || !contract || !NEAR_ACCOUNT.test(contract) || !NEAR_ACCOUNT.test(props.funding.deposit_address)) throw new Error("Use a NEAR wallet that can follow these exact token deposit instructions.");
  const {JsonRpcProvider}=await import("near-api-js"),rpc=new JsonRpcProvider({url:process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.mainnet.near.org"});
  if(await rpc.getNetworkId()!=="mainnet") throw new Error("The NEAR RPC connection is not on mainnet. Use the mainnet deposit instructions below.");
  async function view<T>(method:string,args:object):Promise<T> {
    const result=await rpc.query<{result:number[]}>({request_type:"call_function",finality:"final",account_id:contract!,method_name:method,args_base64:btoa(JSON.stringify(args))});
    return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
  }
  const registration=await view<{total:string}|null>("storage_balance_of",{account_id:props.funding.deposit_address});
  const balance=BigInt(await view<string>("ft_balance_of",{account_id:sender})),amount=BigInt(props.funding.amount_in);
  const actions:Array<{type:"FunctionCall";params:{methodName:string;args:object;gas:string;deposit:string}}>=[];
  if(!registration) {
    const bounds=await view<{min:string}>("storage_balance_bounds",{});
    if(!/^\d+$/.test(bounds.min)) throw new Error("The token returned invalid storage registration costs.");
    actions.push({type:"FunctionCall",params:{methodName:"storage_deposit",args:{account_id:props.funding.deposit_address,registration_only:true},gas:"30000000000000",deposit:bounds.min}});
  }
  if(balance<amount) {
    if(contract!=="wrap.near") throw new Error(`Your NEAR wallet has insufficient ${props.token.symbol} for this deposit.`);
    actions.push({type:"FunctionCall",params:{methodName:"near_deposit",args:{},gas:"30000000000000",deposit:(amount-balance).toString()}});
  }
  actions.push({type:"FunctionCall",params:isDirectFunding(quote)?{methodName:"ft_transfer_call",args:{receiver_id:props.funding.deposit_address,amount:props.funding.amount_in,msg:quote.quoteRequest.customRecipientMsg},gas:"120000000000000",deposit:"1"}:{methodName:"ft_transfer",args:{receiver_id:props.funding.deposit_address,amount:props.funding.amount_in},gas:"50000000000000",deposit:"1"}});
  validateFundingQuote(props.funding,props.token);
  await props.beforeSend?.();
  const result=await wallet.signAndSendTransaction({signerId:sender,receiverId:contract,network:"mainnet",actions});
  const hash=result.transaction.hash;
  onHash(hash,sender);
  const confirmed=await rpc.viewTransactionStatusWithReceipts({txHash:hash,accountId:sender,waitUntil:"FINAL"});
  if(confirmed.transaction.signer_id!==sender || confirmed.transaction.receiver_id!==contract || typeof confirmed.status!=="object" || !("SuccessValue" in confirmed.status) || confirmed.receipts_outcome.some(receipt=>typeof receipt.outcome.status==="object" && "Failure" in receipt.outcome.status)) throw new Error("The NEAR source transaction did not complete successfully. Check the explorer receipt before creating another request.");
  return {hash,sender,confirmed:true};
}

async function transferSolana(props:FundingWalletActionProps,quote:BoundQuote,onHash:(hash:string,sender:string)=>void):Promise<SourceReceipt> {
  const [{Connection,PublicKey,SystemProgram,Transaction,clusterApiUrl},spl]=await Promise.all([import("@solana/web3.js"),import("@solana/spl-token")]);
  const provider=(window as unknown as {solana?:{connect:()=>Promise<{publicKey:InstanceType<typeof PublicKey>}>;publicKey?:InstanceType<typeof PublicKey>;signAndSendTransaction:(tx:InstanceType<typeof Transaction>)=>Promise<{signature:string}>}}).solana;
  if(!provider) throw new Error("Open a compatible Solana wallet, or use the deposit instructions below.");
  if(props.funding.deposit_memo) throw new Error("This route requires a memo. Use the exact manual deposit instructions.");
  const {publicKey:sender}=await provider.connect(),connection=new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),"confirmed"),destination=new PublicKey(props.funding.deposit_address),amount=BigInt(props.funding.amount_in);
  if(process.env.NEXT_PUBLIC_SOLANA_RPC_URL) {
    const canonical=new Connection(clusterApiUrl("mainnet-beta"),"confirmed");
    const [configuredGenesis,mainnetGenesis]=await Promise.all([connection.getGenesisHash(),canonical.getGenesisHash()]);
    if(configuredGenesis!==mainnetGenesis) throw new Error("Your Solana RPC connection is not on mainnet. Use the mainnet deposit instructions below.");
  }
  if(sender.toBase58()!==quote.quoteRequest.refundTo) throw new Error("Connect the Solana account entered as this quote's refund address, or create a new funding request.");
  const transaction=new Transaction();
  if(props.token.contractAddress) {
    const mintAddress=new PublicKey(props.token.contractAddress),mintInfo=await connection.getAccountInfo(mintAddress,"confirmed");
    if(!mintInfo || (!mintInfo.owner.equals(spl.TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(spl.TOKEN_2022_PROGRAM_ID))) throw new Error("The source asset is not a supported Solana token mint.");
    const program=mintInfo.owner,mint=await spl.getMint(connection,mintAddress,"confirmed",program);
    if(mint.decimals!==props.token.decimals) throw new Error("The token decimals changed. Refresh the asset catalog.");
    if(program.equals(spl.TOKEN_2022_PROGRAM_ID) && mint.tlvData.length) throw new Error("This token uses Solana transfer extensions. Use a wallet that supports its exact token transfer requirements.");
    const from=spl.getAssociatedTokenAddressSync(mintAddress,sender,false,program),to=spl.getAssociatedTokenAddressSync(mintAddress,destination,true,program);
    const balance=await spl.getAccount(connection,from,"confirmed",program);
    if(balance.amount<amount) throw new Error(`Your Solana wallet has insufficient ${props.token.symbol} for this deposit.`);
    transaction.add(spl.createAssociatedTokenAccountIdempotentInstruction(sender,to,destination,mintAddress,program));
    transaction.add(spl.createTransferCheckedInstruction(from,mintAddress,to,sender,amount,props.token.decimals,[],program));
  } else transaction.add(SystemProgram.transfer({fromPubkey:sender,toPubkey:destination,lamports:amount}));
  const block=await connection.getLatestBlockhash("confirmed");
  transaction.feePayer=sender;transaction.recentBlockhash=block.blockhash;
  const simulation=await connection.simulateTransaction(transaction);
  if(simulation.value.err) throw new Error("The Solana source transfer could not be simulated. Check your balance, token account and SOL for network fees.");
  if(provider.publicKey?.toBase58()!==sender.toBase58()) throw new Error("Your Solana wallet changed accounts. Reconnect and try again.");
  validateFundingQuote(props.funding,props.token);
  await props.beforeSend?.();
  const {signature:hash}=await provider.signAndSendTransaction(transaction);
  onHash(hash,sender.toBase58());
  const receipt=await connection.confirmTransaction({signature:hash,...block},"confirmed");
  if(receipt.value.err) throw new Error("The Solana source transaction failed. Check the explorer receipt before making a new request.");
  return {hash,sender:sender.toBase58(),confirmed:true};
}

function explorer(network:string,hash:string):string|undefined {
  if(EVM_CHAINS[network]?.blockExplorers?.default.url)return `${EVM_CHAINS[network].blockExplorers!.default.url}/tx/${hash}`;
  if(network==="sol")return `https://solscan.io/tx/${encodeURIComponent(hash)}`;
  if(network==="near")return `https://nearblocks.io/txns/${encodeURIComponent(hash)}`;
}

export function FundingWalletAction(props:FundingWalletActionProps) {
  const [manual, setManual] = useState(false);
  const {funding,token,onSubmitted}=props,[phase,setPhase]=useState<"idle"|"signing"|"confirming"|"confirmed">("idle"),[hash,setHash]=useState<string|null>(funding.source_tx_hash || null),[error,setError]=useState<string|null>(null),[copied,setCopied]=useState(false),busy=useRef(false);
  useEffect(()=>{
    let cached:string|null=null;
    try{cached=sessionStorage.getItem(storageKey(funding.id));}catch{}
    setHash(funding.source_tx_hash || cached);setPhase("idle");setError(null);setManual(false);
  },[funding.id]);
  useEffect(()=>{if(funding.source_tx_hash)setHash(funding.source_tx_hash);},[funding.source_tx_hash]);
  let invalid:string|null=null,quote:BoundQuote|null=null;
  try {quote=validateFundingQuote(funding,token);} catch(error){invalid=walletErrorMessage(error);}
  const supported=Boolean(EVM_CHAINS[token.blockchain] || token.blockchain==="near" || token.blockchain==="sol"),pending=phase==="signing"||phase==="confirming",canSend=props.depositAllowed!==false&&supported&&!invalid&&!hash&&!pending&&!funding.deposit_memo;
  const amount=/^\d+$/.test(funding.amount_in)&&token.decimals>=0&&token.decimals<=38?formatUnits(BigInt(funding.amount_in),token.decimals):"Unavailable";
  async function send() {
    if(busy.current || !canSend || !quote)return;
    requireLiveWallet();
    busy.current=true;setPhase("signing");setError(null);
    let broadcastHash:string|undefined;
    function broadcast(txHash:string) {broadcastHash=txHash;setHash(txHash);setPhase("confirming");try{sessionStorage.setItem(storageKey(funding.id),txHash);}catch{} if(props.onBroadcast) void props.onBroadcast(txHash).catch(error=>setError(`Source transfer submitted. Reopen this task to reconcile it. ${walletErrorMessage(error)}`));}
    try {
      const sendTransfer=token.blockchain==="near"?transferNear:token.blockchain==="sol"?transferSolana:transferEvm;
      const receipt=await withTaskDrawerWallet(()=>sendTransfer(props,quote!,hash=>broadcast(hash)));
      setPhase(receipt.confirmed?"confirmed":"idle");
      await onSubmitted(receipt.hash);
    } catch(error) {
      setError(broadcastHash?`A source transaction was submitted. Check its receipt before sending again. ${walletErrorMessage(error)}`:walletErrorMessage(error));
      setPhase("idle");
      if(broadcastHash) {try{await onSubmitted(broadcastHash);}catch{}}
    } finally {busy.current=false;}
  }
  async function check() {if(!hash||busy.current)return;busy.current=true;setPhase("confirming");setError(null);try{await onSubmitted(hash);}catch(error){setError(walletErrorMessage(error));}finally{busy.current=false;setPhase("idle");}}
  async function trackManual(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(busy.current)return;
    const value=String(new FormData(event.currentTarget).get("sourceHash")||"").trim();
    if(!/^[A-Za-z0-9:_-]{8,160}$/.test(value)){setError("Enter the exact source transaction hash from your wallet or exchange.");return;}
    busy.current=true;setError(null);setHash(value);setPhase("confirming");
    try{sessionStorage.setItem(storageKey(funding.id),value);}catch{}
    try{await onSubmitted(value);}catch(error){setError(walletErrorMessage(error));}finally{busy.current=false;setPhase("idle");}
  }
  const txUrl=hash?explorer(token.blockchain,hash):undefined;
  const tracking=props.depositAllowed===false||!!hash;
  const direct=quote&&isDirectFunding(quote)?quote:null;
  if(isPublicDemo())return props.depositAllowed===false||["credited","confirmed","completed"].includes(funding.status)?<p className="text-sm text-muted-foreground">Demo deposit {funding.status.replaceAll("_"," ")}</p>:<DemoAction action="fund" options={{fundingId:funding.id}}>Simulate deposit</DemoAction>;
  if (props.compact) return <section aria-busy={pending} className="grid gap-4">
    {props.upgradePolicy && props.depositAllowed !== false && !hash && <details className="border-t pt-4 text-sm"><summary className="cursor-pointer">Contract upgrades: {props.upgradePolicy.upgradable ? "operator-controlled" : "immutable"}</summary><div className="mt-3"><ContractUpgradeDisclosure policy={props.upgradePolicy}/></div></details>}
    {direct && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Company deposit message</summary><dl className="mt-3 grid gap-3"><div><dt>Token contract</dt><dd className="mt-1 break-all">{token.contractAddress}</dd></div><div><dt>Message</dt><dd className="mt-1 break-all font-mono">{direct.quoteRequest.customRecipientMsg}</dd></div><div><dt>Wallet action</dt><dd className="mt-1">120 Tgas limit · 1 yoctoNEAR attached</dd></div></dl></details>}
    {invalid && !hash && props.depositAllowed !== false && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
    {props.depositAllowed !== false && (!supported || funding.deposit_memo) && <p className="text-xs text-muted-foreground">Send with an external wallet, then track its transaction below.</p>}
    {!hash && supported && !funding.deposit_memo && props.depositAllowed !== false && <button type="button" disabled={!canSend} onClick={() => void send()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50"><Wallet size={16}/>{phase === "signing" ? "Confirm in wallet" : phase === "confirming" ? "Awaiting confirmation" : "Send from wallet"}</button>}
    {hash && <div className="grid gap-3"><p role="status" className="text-sm">{phase === "confirming" ? "Checking source transfer..." : phase === "confirmed" ? "Source transfer confirmed" : "Source transaction recorded"}</p><div className="flex flex-wrap items-center justify-between gap-3">{txUrl ? <a href={txUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary">Source transaction <ExternalLink size={13}/></a> : <details className="text-xs"><summary className="cursor-pointer">Source transaction</summary><code className="mt-2 block break-all">{hash}</code></details>}<button type="button" disabled={pending} className="min-h-9 text-sm text-primary disabled:opacity-50" onClick={() => void check()}>Check transfer</button></div></div>}
    {!hash && ["pending_deposit", "source_unknown", "unknown", "processing", "recovery_pending", "reported_delivered", "closed_unsent", "cancelled"].includes(funding.status) && <div>{manual ? <form className="grid gap-4 border-t pt-4" onSubmit={event => void trackManual(event)}><label className="grid gap-2 text-sm"><span>Source transaction hash</span><input name="sourceHash" required maxLength={160} className="min-h-11 w-full rounded-xl border bg-white px-3 py-2 text-sm"/></label><div className="flex items-center justify-between gap-3"><button type="button" disabled={pending} className="text-sm text-muted-foreground" onClick={() => setManual(false)}>Cancel</button><button type="submit" disabled={pending} className="min-h-10 rounded-full bg-primary px-4 text-sm text-white disabled:opacity-50">Track transfer</button></div></form> : <button type="button" className="min-h-9 text-sm text-primary" onClick={() => setManual(true)}>Track an existing transfer</button>}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
  return <section aria-busy={pending} className="space-y-4 rounded-lg border border-border bg-card p-4">
    <ContractUpgradeDisclosure policy={props.upgradePolicy}/>
    <div><p className="text-sm font-semibold">{tracking?"Source transfer tracking":"Fund from your wallet"}</p><AssetIdentity symbol={token.symbol} network={token.blockchain} assetId={token.assetId} showAssetId className="my-3"/><p className="mt-1 text-xs text-muted-foreground">{tracking?"Original quoted deposit:":"Send exactly"} {amount} {token.symbol} on {token.blockchain}. Your source wallet pays its network fees.</p></div>
    {props.depositAllowed===false&&<p role="status" className="text-sm">New deposits are blocked for this saved quote. Check wallet activity and track any submitted source transfer below.</p>}
    <dl className="grid gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Original deposit address</dt><dd className="mt-1 flex items-start gap-2"><code className="break-all">{funding.deposit_address}</code><button type="button" aria-label="Copy deposit address" className="shrink-0 p-1" onClick={async()=>{try{await navigator.clipboard.writeText(funding.deposit_address);setCopied(true);}catch{setError("Copy the deposit address manually from the instructions.");}}}><Copy size={14}/></button>{copied?<span className="text-xs">Copied</span>:null}</dd></div>{funding.deposit_memo?<div><dt className="text-xs text-muted-foreground">Required deposit memo</dt><dd><code className="break-all">{funding.deposit_memo}</code></dd></div>:null}</dl>
    {direct&&<div className="space-y-2 rounded-lg bg-muted p-3 text-xs"><p className="font-semibold">Direct native USDC deposit on NEAR mainnet</p><p>Source account: <span className="break-all">{direct.quoteRequest.refundTo}</span></p><p>Company: <span className="break-all">{direct.companyId}</span></p><p>Token contract: <span className="break-all">{token.contractAddress}</span></p><p>This wallet action calls ft_transfer_call with this company's deposit message. A plain transfer to the shared address will not credit the company. No routing-provider swap or fee is included.</p><p>Your wallet shows the native NEAR network fee. Transfer gas limit: 120 Tgas; attached deposit: 1 yoctoNEAR. Any required token registration is a separate wallet action.</p><details><summary className="cursor-pointer">Exact company deposit message</summary><code className="mt-2 block break-all">{direct.quoteRequest.customRecipientMsg}</code></details></div>}
    {invalid&&!hash&&props.depositAllowed!==false?<p role="alert" className="text-sm text-destructive">{invalid}</p>:null}
    {props.depositAllowed!==false&&(!supported||funding.deposit_memo)?<p className="text-xs leading-5 text-muted-foreground">Use a wallet or exchange that supports {token.symbol} on {token.blockchain}. Send the exact amount to this deposit address{funding.deposit_memo?" and include the required memo":""} before the quote expires. Then record its source transaction hash below. A manual transfer is not automatically detected by your browser.</p>:null}
    {!hash&&supported&&!funding.deposit_memo&&props.depositAllowed!==false?<button type="button" disabled={!canSend} onClick={()=>void send()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"><Wallet size={16}/>{phase==="signing"?"Confirm source transfer...":phase==="confirming"?"Waiting for source confirmation...":`Send ${amount} ${token.symbol}`}</button>:null}
    {hash&&<div className="space-y-2"><p role="status" className="text-sm">{phase==="confirming"?"Checking the recorded source transfer...":phase==="confirmed"?"Source transfer confirmed. Checking the NEAR deposit.":"Source transaction recorded. Check the deposit status."}</p><div className="flex flex-wrap items-center gap-3">{txUrl?<a href={txUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline">View source transaction <ExternalLink size={13}/></a>:<code className="break-all text-xs">{hash}</code>}<button type="button" disabled={pending} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50" onClick={()=>void check()}>Check deposit status</button></div></div>}
    {!hash&&["pending_deposit","source_unknown","unknown","processing","recovery_pending","reported_delivered","closed_unsent","cancelled"].includes(funding.status)&&<form className="grid gap-3 border-t pt-4" onSubmit={event=>void trackManual(event)}><label className="grid gap-2 text-sm"><span>Already sent from a wallet or exchange?</span><input name="sourceHash" required maxLength={160} className="min-h-10 w-full rounded-md border bg-card px-3 py-2 text-sm" placeholder="Paste the source transaction hash"/></label><button type="submit" disabled={pending} className="justify-self-start rounded-lg border px-3 py-2 text-sm disabled:opacity-50">Track existing transfer</button><p className="text-xs text-muted-foreground">Recording a hash does not prove payment or company credit. Do not send another deposit while the original is being checked.</p></form>}
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}<p className="text-xs text-muted-foreground">Source confirmation and NEAR treasury credit are checked separately. Recipient delivery appears after payout reconciliation.</p>
  </section>;
}
