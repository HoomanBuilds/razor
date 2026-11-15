export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const limit=1_048_576;
async function proxy(request:Request,context:{params:Promise<{path:string[]}>}) {
  const {path}=await context.params;
  if(!path.length||path.some(segment=>!segment||segment==="."||segment===".."||/[\\/%]/.test(segment))||!["state","action","api"].includes(path[0])||path[0]==="api"&&path[1]==="demo")return Response.json({error:"Invalid demo endpoint",code:"DEMO_PATH_INVALID"},{status:400});
  const configuredOrigin=new URL(process.env.APP_URL||request.url).origin;
  if(!["GET","HEAD"].includes(request.method)&&(request.headers.get("origin")!==configuredOrigin||request.headers.get("sec-fetch-site")==="cross-site"))return Response.json({error:"Request origin is not allowed",code:"ORIGIN_REJECTED"},{status:403});
  if(Number(request.headers.get("content-length")||0)>limit)return Response.json({error:"Request too large",code:"DEMO_BODY_LIMIT"},{status:413});
  const chunks:Uint8Array[]=[];let size=0;
  if(request.body){const reader=request.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();return Response.json({error:"Request too large",code:"DEMO_BODY_LIMIT"},{status:413});}chunks.push(value);}}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  const cookie=/(?:^|;\s*)razor_demo_session=([a-zA-Z0-9_-]{43})(?:;|$)/.exec(request.headers.get("cookie")??"")?.[1];
  const target=new URL(`http://127.0.0.1:8831/${path.map(encodeURIComponent).join("/")}`);target.search=new URL(request.url).search;
  try{
    const upstream=await fetch(target,{method:request.method,redirect:"manual",cache:"no-store",headers:{accept:request.headers.get("accept")||"application/json","content-type":"application/json",origin:configuredOrigin,...(cookie?{cookie:`razor_demo_session=${cookie}`}:{})},...(!["GET","HEAD"].includes(request.method)?{body}:{}),signal:AbortSignal.timeout(30_000)});
    if(upstream.status>=300&&upstream.status<400)return Response.json({error:"Demo redirect blocked",code:"DEMO_REDIRECT_BLOCKED"},{status:502});
    const headers=new Headers({"cache-control":"private, no-store","x-razor-demo":"simulated-no-broadcast","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
    for(const name of ["content-type","content-disposition","content-security-policy"])if(upstream.headers.has(name))headers.set(name,upstream.headers.get(name)!);
    const sessionCookie=upstream.headers.get("set-cookie");if(sessionCookie&&/^razor_demo_session=[a-zA-Z0-9_-]{43}; Path=\/api\/demo\/workspace; HttpOnly; SameSite=Strict; Max-Age=7200(?:; Secure)?$/.test(sessionCookie))headers.set("set-cookie",sessionCookie);
    return new Response(upstream.body,{status:upstream.status,headers});
  }catch{return Response.json({error:"The interactive demo is starting. Please try again shortly.",code:"DEMO_SERVICE_UNAVAILABLE"},{status:503,headers:{"cache-control":"no-store"}});}
}
export const GET=proxy;
export const HEAD=proxy;
export const POST=proxy;
export const PUT=proxy;
export const PATCH=proxy;
export const DELETE=proxy;
