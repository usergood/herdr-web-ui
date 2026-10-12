import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("starting an Inbox idea through the public API", () => {
  it("starts work in a new owned workspace while preserving changes in the Project checkout", async () => {
    const root=mkdtempSync(join(tmpdir(),"saurons-inbox-start-"));const repo=join(root,"repo");mkdirSync(repo);
    writeFileSync(join(repo,"README.md"),"Owned committed baseline\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
    writeFileSync(join(repo,"personal-note.txt"),"Keep this uncommitted note\n");
    const owned:string[]=[];
    const app=createServer({port:0,stateDir:join(root,"state"),machines:false,factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const created=await workspaceCreate(options);owned.push(created.workspace.workspace_id);return created;},startAgent:async options=>{await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});}}}});
    const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});
    try {
      const project=await post("/projects",{name:"Inbox Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());
      const idea=await post("/implementations",{title:"Fix the storefront",description:"Keep the checkout's existing files.",project_id:project.id}).then(r=>r.json());
      const response=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-work"});expect(response.status).toBe(202);
      const run=await response.json();expect(run.condition).toBe("working");expect(run.pane_id).toBeString();expect(run.workspace_id).toBeString();expect(run.worktree).not.toBe(repo);
      expect(run.manifest.implementation.description).toBe("Keep the checkout's existing files.");
      expect(readFileSync(join(repo,"personal-note.txt"),"utf8")).toBe("Keep this uncommitted note\n");
      expect(execFileSync("git",["status","--porcelain"],{cwd:repo,encoding:"utf8"})).toBe("?? personal-note.txt\n");
      const again=await post(`/implementations/${idea.id}/runs`,{action:"work",idempotency_key:"owned-work"}).then(r=>r.json());expect(again.id).toBe(run.id);
      const overview=await fetch(`http://localhost:${app.port}/api/factory?navigation=1`).then(r=>r.json());expect(overview.implementations.find((i:any)=>i.id===idea.id).stage).toBe("running");
      const finished=await post(`/implementations/${idea.id}/complete-work`,{run_id:run.id});expect(finished.status).toBe(200);expect((await finished.json()).stage).toBe("done");
      expect((await post(`/implementations/${idea.id}/archive`,{})).status).toBe(200);
    } finally {app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
  });
});
