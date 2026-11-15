import { createServer } from "node:http";
import { configurePublicDemoEnvironment } from "./environment";
const {publicOrigin,port,tokens}=configurePublicDemoEnvironment();
const {PublicDemoRuntime}=await import("./runtime");
const runtime=new PublicDemoRuntime(tokens,publicOrigin);
const server=createServer(async(req,res)=>{
  try{
    if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress??"")||req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);res.end();return;}
    const raw=req.url??"/";
    if(!raw.startsWith("/")||raw.startsWith("//")||raw.split("?")[0].includes("%")||raw.includes("\\")||raw.split("?")[0].split("/").some(segment=>segment==="."||segment==="..")){res.writeHead(400);res.end();return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1_048_576){res.writeHead(413);res.end();req.destroy();return;}chunks.push(chunk);}
    const method=req.method??"GET",response=await runtime.handle(new Request(`${publicOrigin}${raw}`,{method,headers:{origin:req.headers.origin??"",cookie:req.headers.cookie??"","content-type":"application/json",...(typeof req.headers["x-razor-demo-profile"]==="string"?{"x-razor-demo-profile":req.headers["x-razor-demo-profile"]}:{})},...(!["GET","HEAD"].includes(method)?{body:Buffer.concat(chunks).toString()}:{})}));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:"The demo request could not finish",code:"DEMO_REQUEST_FAILED"}));}
});
server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxConnections=64;
function shutdown(){server.close(()=>{runtime.close();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
server.listen(port,"127.0.0.1",()=>console.info(JSON.stringify({service:"razor-public-demo",port,publicOrigin,storage:"isolated-memory",externalRequests:"blocked"})));
