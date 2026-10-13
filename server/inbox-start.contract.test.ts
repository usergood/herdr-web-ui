import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { HerdrError, herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { factoryNative } from "./factory-native.ts";

describe("starting an Inbox idea through the public API", () => {
  it.skipIf(!Bun.which("codex"))("launches Approve for me planning with arguments accepted by the real Codex parser",async()=>{
    const root=mkdtempSync(join(tmpdir(),"saurons-codex-permissions-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    const home=join(root,"codex-home");mkdirSync(home,{mode:0o700});
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const owned:string[]=[];let parserExit:number|undefined;const sandboxes:string[]=[];
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{
      // A schema command checks the real root argument parser without starting inference.
      const result=Bun.spawnSync(["codex",...options.args!.slice(0,-1),"app-server","generate-json-schema","--out",join(root,"schema")],{env:{...process.env,CODEX_HOME:home},stdout:"pipe",stderr:"pipe"});
      parserExit=result.exitCode;if(result.exitCode!==0)throw new HerdrError("invalid_agent_argument","Owned Codex parser rejected native permission arguments");
      sandboxes.push(options.args![options.args!.indexOf("--sandbox")+1]!);
      await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});
    }}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Permissions fixture",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());expect((await post(`/projects/${project.id}/configure`,{permission_mode:"approve_for_me"})).status).toBe(200);
      const idea=await post("/implementations",{title:"Plan owned work",description:"",project_id:project.id}).then(r=>r.json());const response=await post(`/implementations/${idea.id}/runs`,{action:"grill-with-docs",idempotency_key:"owned-approve"});const run=await response.json();expect(parserExit).toBe(0);expect(run.condition).toBe("working");
      expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(200);
      const work=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-work"}).then(r=>r.json());expect(work.condition).toBe("working");
      const review=await post(`/runs/${work.id}/workers`,{role:"standards",idempotency_key:"owned-review"}).then(r=>r.json());expect(review.condition).toBe("working");expect(sandboxes).toEqual(["workspace-write","workspace-write","read-only"]);
    }finally{app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("freezes a task model override for the parent and reviewer while Project defaults change",async()=>{
    const root=mkdtempSync(join(tmpdir(),"saurons-model-launch-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const owned:string[]=[];const launches:string[][]=[];
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"owned-cli-fixture",modelCatalog:async provider=>({protocol:1,provider,models:[{id:"fixture-sol",name:"Fixture Sol",reasoning:[{id:"medium",name:"Medium"},{id:"xhigh",name:"Extra high"}],default_reasoning:"medium"},{id:"fixture-other",name:"Fixture Other",reasoning:[{id:"high",name:"High"}],default_reasoning:"high"}],problem:null}),createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{launches.push(options.args!);await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Preset fixture",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());expect((await post(`/projects/${project.id}/configure`,{execution_preset:{model:"fixture-sol",reasoning:"xhigh"}})).status).toBe(200);
      const idea=await post("/implementations",{title:"Use selected model",description:"",project_id:project.id}).then(r=>r.json());const run=await post(`/implementations/${idea.id}/runs`,{action:"work",execution_preset:{model:"fixture-other",reasoning:"high"},idempotency_key:"override"}).then(r=>r.json());expect(run.condition).toBe("working");expect(run.manifest.execution_preset).toEqual({model:"fixture-other",reasoning:"high"});
      expect((await post(`/projects/${project.id}/configure`,{execution_preset:{model:"fixture-sol",reasoning:"medium"}})).status).toBe(200);
      const reviewer=await post(`/runs/${run.id}/workers`,{role:"standards",idempotency_key:"review"}).then(r=>r.json());expect(reviewer.condition).toBe("working");
      for(const args of launches){expect(args[args.indexOf("--model")+1]).toBe("fixture-other");expect(args).toContain('model_reasoning_effort="high"');}
      expect(launches[1]![launches[1]!.indexOf("--sandbox")+1]).toBe("read-only");
      expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(200);
      const invalid=await post(`/implementations/${idea.id}/runs`,{action:"work",execution_preset:{model:"fixture-other",reasoning:"xhigh"},idempotency_key:"invalid-effort"});expect(invalid.status).toBe(409);expect((await invalid.json()).error.code).toBe("reasoning_unavailable");
      const next=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"inherit-default"}).then(r=>r.json());expect(next.condition).toBe("working");expect(next.manifest.execution_preset).toEqual({model:"fixture-sol",reasoning:"medium"});
    }finally{app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("stops an already closed failed workspace and allows a fresh explicit start",async()=>{
    const root=mkdtempSync(join(tmpdir(),"saurons-stop-closed-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const owned:string[]=[];let reject=true,unavailable=false;let directoryEvidence:{paneId:string;cwd:string|null}|undefined;
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"owned-cli-fixture",snapshot:async()=>{
      if(unavailable)throw new HerdrError("connect_failed","Owned unavailable snapshot");
      const snapshot=await sessionSnapshot();
      if(directoryEvidence)snapshot.panes=snapshot.panes.map(p=>p.pane_id===directoryEvidence!.paneId?{...p,cwd:directoryEvidence!.cwd,foreground_cwd:directoryEvidence!.cwd}:p);
      return snapshot;
    },createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{if(reject)throw new HerdrError("invalid_agent_argument","Owned rejected launch");await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Closed workspace fixture",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());const idea=await post("/implementations",{title:"Retry owned work",description:"Keep original context",project_id:project.id}).then(r=>r.json());const run=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"rejected"}).then(r=>r.json());expect(run.condition).toBe("interrupted");
      const other=await workspaceCreate({cwd:repo,label:"Unrelated owned fixture"});owned.push(other.workspace.workspace_id);await workspaceClose(run.workspace_id);
      expect((await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"before-stop"})).status).toBe(409);
      const candidate=await workspaceCreate({cwd:run.worktree,label:"Moved owned fixture"});owned.push(candidate.workspace.workspace_id);expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(409);expect((await sessionSnapshot()).workspaces.some(w=>w.workspace_id===candidate.workspace.workspace_id)).toBe(true);
      const moved=join(root,"moved-worktree");renameSync(run.worktree,moved);symlinkSync(repo,run.worktree,"dir");
      try{expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(409);}
      finally{rmSync(run.worktree);renameSync(moved,run.worktree);}
      directoryEvidence={paneId:candidate.root_pane.pane_id,cwd:null};expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(409);directoryEvidence=undefined;
      directoryEvidence={paneId:candidate.root_pane.pane_id,cwd:join(root,"unresolvable-cwd")};expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(409);expect((await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"uncertain-pane"})).status).toBe(409);directoryEvidence=undefined;
      await workspaceClose(candidate.workspace.workspace_id);
      unavailable=true;expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(502);expect((await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"while-offline"})).status).toBe(409);unavailable=false;
      const stopped=await post(`/runs/${run.id}/stop`,{});expect(stopped.status).toBe(200);expect((await stopped.json()).condition).toBe("cancelled");expect((await post(`/runs/${run.id}/stop`,{})).status).toBe(200);
      expect(readFileSync(join(run.worktree,".saurons-eye-prompt.md"),"utf8")).toContain("Keep original context");expect((await sessionSnapshot()).workspaces.some(w=>w.workspace_id===other.workspace.workspace_id)).toBe(true);
      reject=false;const next=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"after-stop"}).then(r=>r.json());expect(next.condition).toBe("working");expect(next.id).not.toBe(run.id);
    }finally{app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("starts work in a new owned workspace while preserving changes in the Project checkout", async () => {
    const root=mkdtempSync(join(tmpdir(),"saurons-inbox-start-"));const repo=join(root,"repo");mkdirSync(repo);
    writeFileSync(join(repo,"README.md"),"Owned committed baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    writeFileSync(join(repo,"personal-note.txt"),"Keep this uncommitted note\n");
    const owned:string[]=[];
    // Muse preserves herdr's real argument validation without starting a paid model CLI.
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const created=await workspaceCreate(options);owned.push(created.workspace.workspace_id);return created;},startAgent:async options=>{await factoryNative.startAgent({...options,kind:"muse"});await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try {
      const project=await post("/projects",{name:"Inbox Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());
      const idea=await post("/implementations",{title:"Fix the storefront",description:"Keep the checkout's existing files.\nPreserve `literal code`, quotes and café.",project_id:project.id}).then(r=>r.json());
      const response=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-work"});expect(response.status).toBe(202);
      const run=await response.json();expect(run.condition).toBe("working");expect(run.pane_id).toBeString();expect(run.workspace_id).toBeString();expect(run.worktree).not.toBe(repo);
      expect(run.manifest.implementation.description).toBe("Keep the checkout's existing files.\nPreserve `literal code`, quotes and café.");
      expect(readFileSync(join(run.worktree,".saurons-eye-prompt.md"),"utf8")).toContain("Keep the checkout's existing files.\nPreserve `literal code`, quotes and café.");
      expect(readFileSync(join(run.worktree,".saurons-eye-prompt.md"),"utf8")).toContain("Frozen Project workflow:");
      expect(statSync(join(run.worktree,".saurons-eye-prompt.md")).mode&0o777).toBe(0o600);
      const reviewed=await post(`/runs/${run.id}/workers`,{role:"standards",idempotency_key:"owned-review"});expect(reviewed.status).toBe(200);const reviewer=await reviewed.json();expect(reviewer.condition).toBe("working");
      expect(readFileSync(join(reviewer.worktree,".saurons-eye-prompt.md"),"utf8")).toContain("Review only the Standards axis");
      expect(readFileSync(join(repo,"personal-note.txt"),"utf8")).toBe("Keep this uncommitted note\n");
      expect(execFileSync("git",["status","--porcelain"],{cwd:repo,encoding:"utf8"})).toBe("?? personal-note.txt\n");
      const again=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-work"}).then(r=>r.json());expect(again.id).toBe(run.id);
      const overview=await fetch(`http://localhost:${app.port}/api/factory?navigation=1`).then(r=>r.json());expect(overview.implementations.find((i:any)=>i.id===idea.id).stage).toBe("running");
      const finished=await post(`/implementations/${idea.id}/complete-work`,{run_id:run.id});expect(finished.status).toBe(200);expect((await finished.json()).stage).toBe("done");
      expect((await post(`/implementations/${idea.id}/archive`,{})).status).toBe(200);
    } finally {app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("retains verified cleanup when the owner stops during workspace allocation",async()=>{
    const root=mkdtempSync(join(tmpdir(),"saurons-launch-stop-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    let release!:()=>void,notify!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const created=new Promise<void>(resolve=>{notify=resolve;});const owned:string[]=[];let pending:Promise<Response>|undefined;
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"owned-cli-fixture",createWorkspace:async options=>{const workspace=await workspaceCreate(options);owned.push(workspace.workspace.workspace_id);notify();await held;return workspace;},startAgent:async()=>{throw new Error("Cancelled fixture must not launch a model");}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Cancellation fixture",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());const idea=await post("/implementations",{title:"Stop owned work",description:"",project_id:project.id}).then(r=>r.json());pending=post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-stop"});await created;
      const detail=await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r=>r.json());const id=detail.runs.at(-1).id;const stopping=await post(`/runs/${id}/stop`,{});expect(stopping.status).toBe(409);expect((await stopping.json()).error.code).toBe("native_identity_uncertain");release();const run=await (await pending).json();expect(run.condition).toBe("cancelled");
      const cleaned=await post(`/runs/${id}/cleanup`,{});expect(cleaned.status).toBe(200);expect((await cleaned.json()).removed).toHaveLength(1);
    }finally{release();await pending?.catch(()=>{});app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  for(const provider of ["codex","claude","opencode"] as const) it(`starts ${provider} planning through native validation with its selected skill`, async()=>{
    const root=mkdtempSync(join(tmpdir(),"saurons-native-planning-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const owned:string[]=[];const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"owned-cli-fixture",createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{await factoryNative.startAgent({...options,kind:"muse"});await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:provider,state:"working"});}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Planning fixture",path:repo,machine_id:"local",provider,tracker:"app"}).then(r=>r.json());await post(`/projects/${project.id}/configure`,{workflow_instructions:"Preserve the domain language.\nKeep actual owner decisions."});
      const idea=await post("/implementations",{title:"Plan the receipt",description:"First line.\nSecond line.",project_id:project.id}).then(r=>r.json());const response=await post(`/implementations/${idea.id}/runs`,{action:"grill-with-docs",idempotency_key:"owned-plan"});expect(response.status).toBe(202);const run=await response.json();expect(run.condition).toBe("working");
      const prompt=readFileSync(join(run.worktree,".saurons-eye-prompt.md"),"utf8");expect(prompt).toContain("Preserve the domain language.\nKeep actual owner decisions.");expect(prompt).toContain(`${provider==="codex"?"$":provider==="opencode"?"@":"/"}grill-with-docs`);
    }finally{app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("hands native owner decisions and grilling documents to the specification agent", async () => {
    const root=mkdtempSync(join(tmpdir(),"saurons-planning-handoff-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const home=join(root,"codex-home");mkdirSync(join(home,"sessions"),{recursive:true});const script=join(root,"codex");writeFileSync(script,'#!/bin/sh\nexec 3< "$CODEX_HOME/sessions/rollout-$2.jsonl"\nsleep 600\n');chmodSync(script,0o700);const thread="01a0c7a1-56d9-7e20-9f08-f7a2d973bd01";
    let scopedToken="";const owned:string[]=[];const app=createServer({port:0,stateDir:join(root,"state"),codexHome:home,machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{
      const cwd=options.args![1]!;const context=JSON.parse(readFileSync(join(cwd,".saurons-eye-context.json"),"utf8"));
      if(context.run.action==="grill-with-docs"){
        scopedToken=JSON.parse(readFileSync(join(cwd,".saurons-eye-access.json"),"utf8")).token;
        writeFileSync(join(cwd,"GLOSSARY.md"),"# Domain language\nReceipt means the owner's delivery record.\n");mkdirSync(join(cwd,"docs","adr"),{recursive:true});writeFileSync(join(cwd,"docs","adr","001.md"),"# Decision\nPreview only the selected receipt.\n");
        writeFileSync(join(home,"sessions",`rollout-${thread}.jsonl`),[{type:"session_meta",payload:{id:thread,cwd}},{type:"response_item",timestamp:new Date().toISOString(),payload:{type:"message",role:"user",content:[{type:"input_text",text:"Native-only decision: preview the receipt, never send it."}]}},{type:"response_item",timestamp:new Date().toISOString(),payload:{type:"message",role:"assistant",content:[{type:"output_text",text:`Confirmed: local receipt preview only. Scoped fixture credential ${scopedToken}`}]}}].map(x=>JSON.stringify(x)).join("\n"));
        await herdrRpc("pane.send_text",{pane_id:options.paneId,text:`CODEX_HOME='${home}' '${script}' resume ${thread}\n`});
        const deadline=Date.now()+10000;for(;;){const info=await herdrRpc<any>("pane.process_info",{pane_id:options.paneId});if(JSON.stringify(info).includes(script))break;if(Date.now()>deadline)throw new Error("Owned codex fixture did not start");await Bun.sleep(50);}
      }
      await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"idle"});
    }}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try {
      const project=await post("/projects",{name:"Handoff Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());const idea=await post("/implementations",{title:"Preview a receipt",description:"An owned planning fixture",project_id:project.id}).then(r=>r.json());
      const plan=await post(`/implementations/${idea.id}/runs`,{action:"grill-with-docs",idempotency_key:"plan"}).then(r=>r.json());expect(plan.condition).toBe("working");
      const capture=await post(`/runs/${plan.id}/import-conversation`,{});const captured=await capture.json();expect({status:capture.status,code:captured.error?.code,message:captured.error?.message}).toEqual({status:200,code:undefined,message:undefined});
      const first=await post(`/runs/${plan.id}/import-artifacts`,{}).then(r=>r.json());expect(first).toHaveLength(3);
      writeFileSync(join(root,"outside.md"),"Owned fixture outside the Run\n");symlinkSync(join(root,"outside.md"),join(plan.worktree,"escape.md"));const escaped=await post(`/runs/${plan.id}/import-artifacts`,{});expect(escaped.status).toBe(403);rmSync(join(plan.worktree,"escape.md"));
      writeFileSync(join(plan.worktree,"oversized.md"),"x".repeat(512*1024+1));const oversized=await post(`/runs/${plan.id}/import-artifacts`,{});expect(oversized.status).toBe(413);rmSync(join(plan.worktree,"oversized.md"));
      writeFileSync(join(plan.worktree,"docs","adr","001.md"),"# Decision\nPreview only the selected receipt. Final owner decision: include its date.\n");
      const notesRoot=JSON.parse(readFileSync(join(plan.worktree,".saurons-eye-context.json"),"utf8")).environment.notes;
      writeFileSync(join(notesRoot,"private-fixture.txt"),scopedToken);const rejected=await post(`/runs/${plan.id}/import-artifacts`,{});expect(rejected.status).toBe(409);expect((await rejected.json()).error.code).toBe("private_runtime_material");rmSync(join(notesRoot,"private-fixture.txt"));
      const stopped=await post(`/runs/${plan.id}/stop`,{summary:"Owner finished discussion"});expect(stopped.status).toBe(200);
      const specification=await post(`/implementations/${idea.id}/runs`,{action:"to-spec",idempotency_key:"spec"}).then(r=>r.json());expect(specification.condition).toBe("working");
      const detail=await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r=>r.json());
      expect(detail.messages.map((m:any)=>m.content).join("\n")).toContain("Native-only decision: preview the receipt, never send it.");
      expect(JSON.stringify(detail.messages).includes(scopedToken)).toBe(false);expect(JSON.stringify(detail.native_snapshots).includes(scopedToken)).toBe(false);
      expect(specification.manifest.artifacts.map((a:any)=>a.name).join("\n")).toContain("GLOSSARY");
      const notes=JSON.parse(readFileSync(join(specification.worktree,".saurons-eye-context.json"),"utf8")).environment.notes;
      const index=JSON.parse(readFileSync(join(notes,".research-index.json"),"utf8"));const documents=index.map((e:any)=>readFileSync(join(notes,e.file),"utf8")).join("\n");expect(documents).toContain("Receipt means the owner's delivery record.");expect(documents).toContain("Final owner decision: include its date.");expect(index).toHaveLength(3);
      expect(specification.manifest.artifacts.filter((a:any)=>first.some((old:any)=>old.id===a.id))).toHaveLength(1);
      const reimported=await post(`/runs/${specification.id}/import-artifacts`,{}).then(r=>r.json());expect(reimported).toEqual([]);
      expect(execFileSync("git",["status","--porcelain"],{cwd:repo,encoding:"utf8"})).toBe("");
    } finally {app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
  it("refuses a head changed during final native capture and preserves Run ownership", async () => {
    const root=mkdtempSync(join(tmpdir(),"saurons-accept-capture-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    const owned:string[]=[];let advance:string|null=null;let changed=false;
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const w=await workspaceCreate(options);owned.push(w.workspace.workspace_id);return w;},startAgent:async options=>{await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"idle"});},snapshot:async()=>{
      if(advance){const cwd=advance;advance=null;writeFileSync(join(cwd,"receipt.md"),"New unreviewed receipt decision\n");for(const args of [["add","receipt.md"],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","unreviewed change"]])execFileSync("git",args,{cwd,stdio:"ignore"});changed=true;}
      return sessionSnapshot();
    }}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try {
      const project=await post("/projects",{name:"Acceptance Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());const idea=await post("/implementations",{title:"Review receipt",description:"",project_id:project.id}).then(r=>r.json());const run=await post(`/implementations/${idea.id}/runs`,{action:"grill-with-docs",idempotency_key:"capture-race"}).then(r=>r.json());expect(run.condition).toBe("working");
      advance=run.worktree;const accepted=await post(`/runs/${run.id}/accept`,{head:run.base});expect(accepted.status).toBe(409);expect((await accepted.json()).error.code).toBe("review_stale");expect(changed).toBe(true);
      const detail=await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r=>r.json());expect(detail.runs.at(-1).condition).toBe("working");expect(detail.approvals.some((a:any)=>a.kind==="review")).toBe(false);expect((await sessionSnapshot()).panes.some(p=>p.pane_id===run.pane_id)).toBe(true);
    } finally {app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
});
