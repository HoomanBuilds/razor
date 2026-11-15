import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { app } from "../../src/server/app";
import { ApiError, requirePermission } from "../../src/server/context";
import { createMemoryDatabase, getDb, row, rows, withDatabase } from "../../src/server/db";
import { demoPolicy, inspectDemoClaim, inspectDemoDistribution } from "./distributions";
import { decrypt, hashToken } from "../../src/server/identity/crypto";
import { getAccess } from "../../src/server/identity/session";
import { getPayment, getTreasury } from "../../src/server/payments/service";
import { payrollPreview, approveReviewedPayrollRun } from "../../src/server/payment-management/service";
import { executionOverview } from "../../src/server/payroll-execution/service";
import type { Token } from "../../src/server/payments/intents";
import { companies, identities, sessions, type Profile } from "../demo/seed";
import { seedPublicDemo } from "./fixtures";
import { creditDemoFunding, previewDemoFunding, settleDemoPayments } from "./simulation";

const cookieName="razor_demo_session", ttl=30*60_000, lifetime=2*3600_000;
type Scenario=ReturnType<typeof seedPublicDemo>;
interface Session { token:string; db:DatabaseSync; scenario:Scenario; profile:Profile; createdAt:number; lastSeen:number; active:number; writing:boolean; writes:number; windowAt:number; requests:number; windowWrites:number; funded:boolean; }
const blocked=()=>Response.json({error:"This action requires live services and is unavailable in the demo.",code:"DEMO_EXTERNAL_ACTION_DISABLED",simulated:true},{status:403});
const allowedWrite=(method:string,path:string)=>{
  if(method==="POST" && /^\/api\/recipient-portal\/[^/]+\/confirm$/.test(path))return true;
  if(method==="POST" && /^\/api\/notifications\/[^/]+\/read$/.test(path))return true;
  if(method==="POST" && /^\/api\/recipient-workspace\/(profiles\/[^/]+\/confirm|invoices)$/.test(path))return true;
  if(method==="PUT" && /^\/api\/personal-expenses\/[^/]+\/correction$/.test(path))return true;
  const match=/^\/api\/organizations\/[^/]+\/(.+)$/.exec(path);if(!match)return false;
  const tail=match[1];
  if(method==="POST")return /^(select|payments|payroll|bills|distributions|recipients|recipients\/import|recipients\/[^/]+\/invite|payments\/[^/]+\/(approve|revalidate|cancel)|payroll\/[^/]+\/approve|bills\/[^/]+\/(approve|dispute|terms|accept|resolve|installments)|payment-management\/(payroll\/[^/]+\/approve|bills\/(preview|approve)|payments\/[^/]+\/(cancel|replace))|operations\/(recurring|notices\/[^/]+\/read)|projects\/classifications|expenses\/[^/]+\/review|client-reserves|client-reserves\/[^/]+\/(allocate|release)|clearing\/(rounds\/preview|funded\/preview|invoices\/[^/]+\/(accept|share)))$/.test(tail);
  if(method==="PATCH")return /^(recipients\/[^/]+|networks\/[^/]+|operations\/recurring\/[^/]+|payment-management\/payroll\/[^/]+\/items\/[^/]+)$/.test(tail);
  if(method==="DELETE")return /^(recipients|distributions)\/[^/]+$/.test(tail);
  return method==="PUT" && tail==="expenses/policy";
};
export class PublicDemoRuntime {
  private sessions=new Map<string,Session>();
  private creations:number[]=[];
  constructor(private readonly tokens:Token[],private readonly origin:string,private readonly maximumSessions=12){}
  close(){for(const session of this.sessions.values())session.db.close();this.sessions.clear();}
  private prune(){const now=Date.now();for(const [id,session]of this.sessions)if(!session.active&&(now-session.lastSeen>=ttl||now-session.createdAt>=lifetime)){session.db.close();this.sessions.delete(id);}}
  private create(){
    this.prune();const now=Date.now();this.creations=this.creations.filter(at=>now-at<60_000);
    if(this.sessions.size>=this.maximumSessions)throw new ApiError(503,"The demo is at capacity. Please try again shortly.","DEMO_CAPACITY");
    if(this.creations.length>=20)throw new ApiError(429,"Please wait before starting another demo session.","DEMO_START_LIMIT");
    const db=createMemoryDatabase();let scenario:Scenario;
    try{scenario=withDatabase(db,()=>seedPublicDemo(this.tokens));}catch(error){db.close();throw error;}
    const token=randomBytes(32).toString("base64url"),session:Session={token,db,scenario,profile:"owner",createdAt:now,lastSeen:now,active:0,writing:false,writes:0,windowAt:now,requests:0,windowWrites:0,funded:false};
    this.sessions.set(token,session);this.creations.push(now);return session;
  }
  private state(session:Session){
    const ids=Object.values(session.scenario.paymentIds),settled=ids.every(id=>row<{status:string}>("SELECT status FROM payments WHERE id=?",id)?.status==="paid");
    return {fictional:true,noBroadcast:true,profile:session.profile,companies:Object.values(companies),profiles:Object.entries(identities).map(([id,value])=>({id,name:value.name,userId:value.id})),...session.scenario,funded:session.funded,settled,treasury:session.profile==="owner"?getTreasury(getAccess(identities.owner.id,companies.northstar.id)):null,expiresAt:new Date(Math.min(session.lastSeen+ttl,session.createdAt+lifetime)).toISOString()};
  }
  private access(session:Session,organizationId=companies.northstar.id){return getAccess(identities[session.profile].id,organizationId);}
  private entityAccess(session:Session,table:"funding_legs"|"payroll_runs"|"payments",id:string){
    const value=row<{organization_id:string}>(`SELECT organization_id FROM ${table} WHERE id=?`,id);
    if(!value)throw new ApiError(404,"This demo record is unavailable","DEMO_RECORD_NOT_FOUND");
    return this.access(session,value.organization_id);
  }
  private async action(session:Session,value:unknown){
    if(!value||typeof value!=="object")throw new ApiError(400,"Choose a demo action","DEMO_ACTION_INVALID");
    const input=value as Record<string,unknown>;
    if(Object.keys(input).some(key=>!["action","profile","fundingId","runId","paymentId","organizationId"].includes(key)))throw new ApiError(400,"Unknown demo action field","DEMO_ACTION_INVALID");
    for(const key of ["fundingId","runId","paymentId","organizationId"])if(input[key]!==undefined&&(typeof input[key]!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(input[key] as string)))throw new ApiError(400,"Invalid demo record","DEMO_ACTION_INVALID");
    if(input.action==="profile"){
      if(typeof input.profile!=="string"||!Object.hasOwn(identities,input.profile))throw new ApiError(400,"Choose a demo profile","DEMO_PROFILE_INVALID");
      session.profile=input.profile as Profile;return this.state(session);
    }
    if(input.action==="fund"){
      if(input.fundingId){const access=this.entityAccess(session,"funding_legs",input.fundingId as string);creditDemoFunding(access,input.fundingId as string);}
      else {
        const access=this.access(session,input.organizationId as string|undefined),token=this.tokens.find(value=>value.blockchain==="base"&&value.symbol==="USDC")!;
        const leg=previewDemoFunding(access,this.tokens,{originAsset:token.assetId,amount:"5000000000",reference:"DEMO WORKING CAPITAL"}) as {id:string};creditDemoFunding(access,leg.id);
      }
      session.funded=true;return this.state(session);
    }
    if(input.action==="approve-payroll"||input.action==="settle-payroll"){
      const id=(input.runId as string|undefined)??session.scenario.runId,access=this.entityAccess(session,"payroll_runs",id);
      if(input.action==="approve-payroll"){
        const current=row<{status:string}>("SELECT status FROM payroll_runs WHERE id=?",id)!;
        requirePermission(access,"payments:approve");if(current.status!=="approved"){const review=await payrollPreview(access,id);approveReviewedPayrollRun(access,id,review.reviewToken);}
      }else {
        const current=row<{status:string}>("SELECT status FROM payroll_runs WHERE id=?",id)!;if(current.status!=="approved")throw new ApiError(409,"Approve the exact pay run first","DEMO_PAYROLL_NOT_APPROVED");
        const items=rows<{payment_id:string}>("SELECT payment_id FROM payroll_items WHERE run_id=? AND payment_id IS NOT NULL",id);settleDemoPayments(access,items.map(item=>item.payment_id),this.tokens);
      }
      return this.state(session);
    }
    if(input.action==="settle-payment"&&typeof input.paymentId==="string"){settleDemoPayments(this.entityAccess(session,"payments",input.paymentId),[input.paymentId],this.tokens);return this.state(session);}
    throw new ApiError(400,"Unknown demo action","DEMO_ACTION_INVALID");
  }
  private async api(session:Session,request:Request,url:URL,body:string){
    const path=url.pathname,method=request.method;
    if(path.startsWith("/api/demo")||/^\/api\/(?:integrations|invoice-ingress|evidence-shares|funding-requests|accounting-oauth|netsuite-oauth)(?:\/|$)/.test(path))return blocked();
    if(path.startsWith("/api/auth/")&&!(["GET","HEAD"].includes(method)&&["/api/auth/config","/api/auth/session"].includes(path)))return blocked();
    if(path==="/api/auth/config")return Response.json({socialEnabled:false,privyAppId:null,walletFamilies:[],nearNetwork:"mainnet",origin:this.origin,ownerWalletSetup:{providers:[],nativeEmbeddedNear:false},simulated:true});
    const organizationId=/^\/api\/organizations\/([^/]+)(?:\/|$)/.exec(path)?.[1],access=organizationId?this.access(session,organizationId):null;
    if(path==="/api/assets"||path.endsWith("/funding-assets"))return Response.json({tokens:this.tokens,routingCatalogAvailable:true,simulated:true});
    if(access&&method==="GET"&&/^\/api\/organizations\/[^/]+\/distributions\/[^/]+$/.test(path))return Response.json({distribution:inspectDemoDistribution(access,path.split("/").at(-1)!,session.scenario.distributionStates)});
    if(method==="GET"&&/^\/api\/recipient-distributions\/[^/]+$/.test(path))return Response.json(inspectDemoClaim(identities[session.profile].id,path.split("/").at(-1)!,session.scenario.distributionStates));
    if(access&&method==="GET"&&path===`/api/organizations/${organizationId}/treasury-policy`)return Response.json({configured:true,config:getTreasury(access).config,current:{...demoPolicy(organizationId!),token_contract:getTreasury(access).config?.token_contract},treasury:getTreasury(access),localPaused:demoPolicy(organizationId!).paused,simulated:true});
    if(access&&method==="POST"&&path===`/api/organizations/${organizationId}/funding`)return Response.json(previewDemoFunding(access,this.tokens,JSON.parse(body)),{status:201});
    if(access&&method==="POST"&&/^\/api\/organizations\/[^/]+\/funding\/[^/]+\/reconcile$/.test(path)){
      const id=path.split("/").at(-2)!;creditDemoFunding(access,id);session.funded=true;return Response.json(row("SELECT * FROM funding_legs WHERE id=? AND organization_id=?",id,organizationId!));
    }
    if(access&&method==="GET"&&path.endsWith("/onboarding/config"))return Response.json({ready:false,network:"mainnet",treasuryId:null,verifiedWallets:[],reason:"Wallet setup is unavailable in this simulated workspace.",simulated:true});
    if(access&&method==="GET"&&(path.endsWith("/treasury-policy/storage")||path.endsWith("/retained-assets")))return Response.json({configured:false,simulated:true});
    if(access&&method==="GET"&&/^\/api\/organizations\/[^/]+\/payroll\/[^/]+\/execution$/.test(path)){
      const unavailable=async()=>{throw new ApiError(403,"Wallet execution is disabled in this demo","DEMO_EXTERNAL_ACTION_DISABLED");};
      const overview=await executionOverview(access,path.split("/").at(-2)!,{tokens:async()=>this.tokens,authority:async()=>({policyVersion:"1",paused:!!row<{paused:number}>("SELECT paused FROM organizations WHERE id=?",organizationId!)?.paused,signerAccounts:["Demo company authority"],approvalAccounts:["Demo company authority"]}),quote:unavailable,resume:unavailable,approval:unavailable,reconcile:unavailable,close:unavailable,receipt:unavailable});
      return Response.json({...overview,simulated:true});
    }
    if(access&&method==="GET"&&/^\/api\/organizations\/[^/]+\/payments\/[^/]+\/recovery$/.test(path)){
      const id=path.split("/").at(-2)!,payment=getPayment(access,id),attempt=row("SELECT * FROM payout_attempts WHERE payment_id=? ORDER BY created_at DESC LIMIT 1",id);
      return Response.json({available:!!attempt,payment,attempt,network:"mainnet",treasuryAccount:null,chainState:"uncertain",ownerAccounts:[],reporterAccounts:[],refundAccounts:[],sourceRecoveryAccounts:[],executorAccounts:[],providerStatus:"UNKNOWN",canRecoverSource:false,canReport:false,canReportDelivery:false,canReportRefund:false,canConfirmRefund:false,canClose:false,hasObservedDelivery:false,requiresPlatformRecovery:true,refundReporter:null,message:"This simulated unknown outcome stays held. No retry or backup payment is permitted.",simulated:true});
    }
    if(!["GET","HEAD"].includes(method)&&!allowedWrite(method,path))return blocked();
    const response=await app.request(`${this.origin}${path}${url.search}`,{method,headers:{"content-type":"application/json",origin:this.origin,cookie:`razor_session=${sessions[session.profile]}`},...(!["GET","HEAD"].includes(method)?{body}:{})});
    if(response.status>=300&&response.status<400)return blocked();
    const headers=new Headers(response.headers);headers.delete("set-cookie");headers.delete("location");headers.delete("content-length");
    if(path.includes("/recipients")&&headers.get("content-type")?.includes("application/json")){
      const mapInvites=(value:unknown):unknown=>{
        if(Array.isArray(value))return value.map(mapInvites);
        if(!value||typeof value!=="object")return value;
        return Object.fromEntries(Object.entries(value).map(([key,item])=>{
          if(key!=="invitationUrl"||typeof item!=="string")return [key,mapInvites(item)];
          const token=new URL(item).searchParams.get("token");if(!token)return [key,item];
          const recipient=row<{email:string|null;user_id:string|null}>("SELECT email,user_id FROM recipients WHERE invitation_token_hash=?",hashToken(token));
          const profile=Object.entries(identities).find(([,identity])=>identity.id===recipient?.user_id||recipient?.email&&identity.email.toLowerCase()===decrypt(recipient.email).toLowerCase())?.[0];
          const link=new URL("/demo",this.origin);link.searchParams.set("kind","receive");link.searchParams.set("token",token);if(profile)link.searchParams.set("profile",profile);
          return [key,link.toString()];
        }));
      };
      return new Response(JSON.stringify(mapInvites(await response.json())),{status:response.status,headers});
    }
    return new Response(response.body,{status:response.status,headers});
  }
  async handle(request:Request):Promise<Response>{
    let session:Session|undefined,created=false,writing=false,entered=false;
    try{
      const url=new URL(request.url),method=request.method;
      if(!["GET","HEAD","POST","PUT","PATCH","DELETE"].includes(method))throw new ApiError(405,"Method unavailable","DEMO_METHOD_INVALID");
      if(url.pathname.includes("%")||url.pathname.includes("\\")||url.pathname.includes("//")||url.pathname.split("/").includes(".."))throw new ApiError(400,"Invalid demo path","DEMO_PATH_INVALID");
      if(!["GET","HEAD"].includes(method)&&request.headers.get("origin")!==this.origin)throw new ApiError(403,"Request origin is not allowed","ORIGIN_REJECTED");
      if(url.pathname==="/health"&&method==="GET")return Response.json({service:"razor-public-demo",status:"ok",isolated:true});
      const body=!["GET","HEAD"].includes(method)?await request.text():"";
      if(Buffer.byteLength(body)>1_048_576)throw new ApiError(413,"Use a request smaller than 1 MB","DEMO_BODY_LIMIT");
      let control:unknown;if(url.pathname==="/action"&&method==="POST")control=JSON.parse(body);
      const reset=!!control&&typeof control==="object"&&(control as {action?:unknown}).action==="reset";
      this.prune();const token=/(?:^|;\s*)razor_demo_session=([a-zA-Z0-9_-]{43})(?:;|$)/.exec(request.headers.get("cookie")??"")?.[1];
      session=token?this.sessions.get(token):undefined;
      if(session&&(Date.now()-session.lastSeen>=ttl||Date.now()-session.createdAt>=lifetime))throw new ApiError(410,"Your demo expired. Reset to start a fresh workspace.","DEMO_SESSION_EXPIRED");
      if(!session){
        if(token&&!reset)throw new ApiError(410,"Your demo expired. Reset to start a fresh workspace.","DEMO_SESSION_EXPIRED");
        if(!(url.pathname==="/state"&&method==="GET")&&!reset)throw new ApiError(401,"Open the demo workspace first","DEMO_SESSION_REQUIRED");
        session=this.create();created=true;
      }
      const now=Date.now();if(now-session.windowAt>=60_000){session.windowAt=now;session.requests=0;session.windowWrites=0;}
      if(++session.requests>600||session.active>=24)throw new ApiError(429,"Please slow down and try again","DEMO_RATE_LIMIT");
      writing=!["GET","HEAD"].includes(method);
      if(writing){
        if(session.writing||reset&&session.active)throw new ApiError(409,"Another demo action is still finishing","DEMO_BUSY");
        if(++session.windowWrites>60)throw new ApiError(429,"Please wait before making more changes","DEMO_RATE_LIMIT");
        if(!reset&&session.writes>=200)throw new ApiError(429,"Reset the demo to continue making changes","DEMO_WRITE_LIMIT");
        session.writing=true;session.writes++;
      }
      session.active++;entered=true;session.lastSeen=now;
      if(reset&&!created){const next=createMemoryDatabase();let scenario:Scenario;try{scenario=withDatabase(next,()=>seedPublicDemo(this.tokens));}catch(error){next.close();throw error;}session.db.close();session.db=next;session.scenario=scenario;session.profile="owner";session.writes=0;session.funded=false;}
      const current=session;
      const response=await withDatabase(session.db,async()=>{
        if(url.pathname==="/state"&&method==="GET"||reset)return Response.json(this.state(current));
        if(url.pathname==="/action"&&method==="POST")return Response.json(await this.action(current,control));
        if(url.pathname.startsWith("/api/"))return this.api(current,request,url,body);
        throw new ApiError(404,"Demo endpoint unavailable","DEMO_NOT_FOUND");
      });
      const headers=new Headers(response.headers);headers.set("cache-control","private, no-store");headers.set("x-razor-demo","simulated-no-broadcast");headers.set("referrer-policy","no-referrer");headers.delete("content-length");
      if(created||reset)headers.set("set-cookie",`${cookieName}=${session.token}; Path=/api/demo/workspace; HttpOnly; SameSite=Strict; Max-Age=7200${this.origin.startsWith("https:")?"; Secure":""}`);
      return new Response(response.body,{status:response.status,headers});
    }catch(error){
      const status=error instanceof ApiError?error.status:error instanceof SyntaxError?400:500;
      return Response.json({error:error instanceof ApiError?error.message:status===400?"Submit valid JSON":"The demo could not complete this action",code:error instanceof ApiError?error.code:status===400?"DEMO_JSON_INVALID":"DEMO_REQUEST_FAILED",simulated:true},{status,headers:{"cache-control":"private, no-store"}});
    }finally{if(session&&entered){session.active--;if(writing)session.writing=false;}}
  }
}
