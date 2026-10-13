import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const provider of ["codex", "claude", "opencode"] as const) it.skipIf(process.platform === "win32")(`reads ${provider} model-specific efforts through HTTP and the native CLI protocol without sending prompts`, async () => {
  const root=mkdtempSync(join(tmpdir(),"saurons-native-models-"));const repo=join(root,"repo");const bin=join(root,"bin");mkdirSync(repo);mkdirSync(bin);
  writeFileSync(join(repo,"README.md"),"Owned model fixture\n");
  for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
  writeFileSync(join(bin,provider),`#!${process.execPath}
import { createInterface } from "node:readline";
import {spawn} from "node:child_process"; import {appendFileSync} from "node:fs";
if(${JSON.stringify(provider)} === "codex" && process.argv.includes("app-server")){const helper=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});appendFileSync(${JSON.stringify(join(root,"helpers"))},String(helper.pid)+"\\n");}
if(process.argv.includes("auth")){console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",email:"owned@example.test",configDirectory:process.env.CLAUDE_CONFIG_DIR}));process.exit(0);}
if(process.env.CLAUDE_CONFIG_DIR && process.argv.includes("--print")){const settings=JSON.parse(process.argv[process.argv.indexOf("--settings")+1]);if(settings.forceLoginMethod!=="claudeai"||settings.apiKeyHelper!==""||settings.env?.ANTHROPIC_API_KEY!==""||!settings.disableAllHooks)process.exit(18);}
if(process.argv.includes("--version")){console.log(${JSON.stringify(provider==="opencode"?"2.0.0":"codex-cli 0.162.1")});process.exit(0);}
if(process.argv.includes("serve")){
 const app=Bun.serve({hostname:"127.0.0.1",port:Number(process.argv[process.argv.indexOf("--port")+1]),fetch(request){if(request.headers.get("authorization")!=="Basic "+Buffer.from("opencode:"+process.env.OPENCODE_SERVER_PASSWORD).toString("base64"))return new Response("Forbidden",{status:401});if(new URL(request.url).pathname!=="/api/model")return new Response("No prompts allowed",{status:404});return Response.json({location:{directory:process.cwd()},data:[{id:"fixture-sol",providerID:"fixture",name:"Fixture Sol",variants:[{id:"medium"},{id:"xhigh"}]}]});}});console.log("opencode server listening on http://127.0.0.1:"+app.port);await new Promise(()=>{});
}
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(message.type==="control_request"&&message.request.subtype==="initialize")console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"fixture-sol",displayName:"Fixture Sol",supportedEffortLevels:["medium","xhigh"]}]}}}));
 else if(message.method==="initialize")console.log(JSON.stringify({id:message.id,result:{userAgent:"owned-fixture"}}));
 else if(message.method==="initialized")continue;
 else if(message.method==="model/list")console.log(JSON.stringify({id:message.id,result:{data:[{id:"fixture-sol",model:"fixture-sol",displayName:"Fixture Sol",defaultReasoningEffort:"medium",supportedReasoningEfforts:[{reasoningEffort:"medium"},{reasoningEffort:"xhigh"}]}],nextCursor:null}}));
 else process.exit(17);
}
`);chmodSync(join(bin,provider),0o700);
  const program=join(root,"server.ts");writeFileSync(program,`import {createServer} from ${JSON.stringify(join(import.meta.dir,"index.ts"))};const app=createServer({port:0,stateDir:${JSON.stringify(join(root,"state"))},machines:false,factory:{accountDiscoveryHome:${JSON.stringify(root)}}});console.log(JSON.stringify({port:app.port}));`);
  const child=Bun.spawn([process.execPath,program],{cwd:repo,env:{...process.env,PATH:bin+":"+process.env.PATH,HERDR_SOCKET:join(root,"absent.sock"),HERDR_SOCKET_PATH:join(root,"absent.sock")},stdout:"pipe",stderr:"ignore"});
  const reader=child.stdout.getReader();let text="";
  try{
    const timeout=AbortSignal.timeout(10000);let port:number|undefined;
    while(!port){timeout.throwIfAborted();const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>timeout.addEventListener("abort",()=>reject(new Error("Owned server did not start")),{once:true}))]);if(chunk.done)throw new Error("Owned server exited");text+=new TextDecoder().decode(chunk.value);for(const line of text.split("\n")){try{port=JSON.parse(line).port;}catch{/* Startup notices are not the port receipt. */}}}
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1","x-herdr-machine":"1"},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
    const project=await post("/projects",{name:"Native catalog fixture",path:repo,machine_id:"local",provider,tracker:"app"}).then(r=>r.json());
    const response=await post("/model-catalog",{project_id:project.id,machine_id:"local",provider});expect(response.status).toBe(200);
    const catalog=await response.json();expect(catalog.problem).toBeNull();expect(catalog.models).toEqual([{id:provider==="opencode"?"fixture/fixture-sol":"fixture-sol",name:"Fixture Sol",reasoning:[{id:"medium",name:"Medium"},{id:"xhigh",name:"Extra high"}],default_reasoning:provider==="codex"?"medium":null}]);
    const selection={model:provider==="opencode"?"fixture/fixture-sol":"fixture-sol",reasoning:"xhigh"};const saved=await post(`/projects/${project.id}/configure`,{execution_preset:selection});expect(saved.status).toBe(200);expect((await saved.json()).execution_preset).toEqual(selection);
    if (provider === "claude") {
      const profile = await post("/machines/local/accounts", { name: "Owned subscription", service: "claude", expected_login: "owned@example.test" }).then(r => r.json());
      expect((await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status).toBe(200);
      expect((await post(`/projects/${project.id}/configure`, { account_bindings: { local: { claude: profile.id } } })).status).toBe(200);
      const scoped = await post("/model-catalog", { project_id: project.id, provider });
      expect(scoped.status).toBe(200); expect((await scoped.json()).problem).toBeNull();
      mkdirSync(join(repo, ".claude")); writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "owned-conflicting-helper" }));
      const conflict = await post("/model-catalog", { project_id: project.id, provider });
      expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("account_subscription_settings");
    }
  }finally{child.kill();await child.exited;reader.releaseLock();if(existsSync(join(root,"helpers")))for(const pid of readFileSync(join(root,"helpers"),"utf8").trim().split("\n")){try{process.kill(Number(pid),"SIGKILL");}catch{/* An owned helper already stopped. */}}rmSync(root,{recursive:true,force:true});}
},15000);
