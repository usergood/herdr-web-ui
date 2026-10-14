import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root=mkdtempSync(join(tmpdir(),"saurons-inbox-browser-"));const repo=join(root,"project");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned project\n");
for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])execFileSync("git",args,{cwd:repo,stdio:"ignore"});
writeFileSync(join(repo,"draft.txt"),"Preserve the owner's draft\n");const owned:string[]=[];const fixtureFailures:{action:string;status:number;code?:string}[]=[];
const app=createServer({port:0,stateDir:join(root,"state"),factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",prompt:async()=>{},createWorkspace:async options=>{const created=await workspaceCreate(options);owned.push(created.workspace.workspace_id);return created;},startAgent:async options=>{
  const cwd=options.args![1]!;const context=JSON.parse(readFileSync(join(cwd,".saurons-eye-context.json"),"utf8"));const access=JSON.parse(readFileSync(join(cwd,".saurons-eye-access.json"),"utf8"));
  const propose=async(action:string,body:unknown)=>{const r=await fetch(access.url+"/"+action,{method:"POST",headers:{authorization:`Bearer ${access.token}`,"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});if(r.status!==201){const b=await r.json();fixtureFailures.push({action,status:r.status,code:b.error?.code});}assert.equal(r.status,201);};
  if(context.run.action==="work"){assert(!options.args!.includes("multi_agent"));assert(readFileSync(join(cwd,".saurons-eye-prompt.md"),"utf8").includes("Fix the storefront"));}
  if(context.run.action==="grill-with-docs"){assert(options.args!.at(-1)!.startsWith("$grill-with-docs"));await propose("question",{question:"Which receipt should this feature preview?"});}
  if(context.run.action==="to-spec")await propose("specification",{content:"# Receipt preview\nShow the receipt selected by the owner.\n\n## Testing plan\nPublic HTTP and real browser checks with owned receipts."});
  if(context.run.action==="to-tickets")await propose("tickets",{specification_id:context.run.manifest.specification.id,tickets:[{key:"receipt",title:"Add the receipt preview",acceptance:"The selected receipt opens from the Project",dependencies:[]}]});
  if(context.run.action==="verify-provider")await propose("question",{question:"Confirm this read-only native verification round?"});
  await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"idle"});
}}}});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||chromium.executablePath(),headless:true,args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const evidence=process.env.UI_EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
  const shot=async(name:string)=>{if(evidence){await page.waitForFunction(()=>document.fonts.status==="loaded");await page.screenshot({path:join(evidence,name),animations:"disabled"});}};
  const project=await page.request.post(`http://localhost:${app.port}/api/factory/projects`,{headers:{"x-herdr-factory":"1"},data:{name:"Inbox Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}}).then(r=>r.json());
  await page.goto(`http://localhost:${app.port}/#projects/${project.id}/inbox`);
  await page.getByRole("textbox",{name:"Idea title",exact:true}).fill("Fix the storefront");await page.getByRole("textbox",{name:"Idea notes",exact:true}).fill("Add a receipt preview.");await page.getByRole("button",{name:"Capture idea",exact:true}).click();
  await page.getByRole("heading",{name:"Fix the storefront",exact:true}).waitFor();
  await page.getByRole("button",{name:"Start work",exact:true}).waitFor();await page.getByRole("button",{name:"Plan implementation",exact:true}).waitFor();
  assert.equal(await page.getByRole("textbox",{name:"Open question",exact:true}).isVisible(),false);
  await shot("inbox-actions-desktop.png");if(evidence){await page.setViewportSize({width:390,height:844});await shot("inbox-actions-mobile.png");await page.setViewportSize({width:1440,height:1000});}
  const launched=page.waitForResponse(r=>r.url().endsWith("/runs")&&r.request().method()==="POST");await page.getByRole("button",{name:"Start work",exact:true}).click();const result=await launched;assert.equal(result.status(),202);const work=await result.json();assert.equal(work.action,"work");assert.equal(work.condition,"working");
  await page.locator(".factory-panel").waitFor({state:"hidden"});assert.equal(await page.getByRole("button",{name:"Chat",exact:true}).getAttribute("aria-pressed"),"true");
  await page.route(`**/api/factory/implementations/${work.implementation_id}`,async route=>{if(route.request().method()!=="GET")return route.continue();const response=await route.fetch();const detail=await response.json();await route.fulfill({json:{...detail,runs:detail.runs.map((r:any)=>r.id===work.id?{...r,condition:"interrupted",waiting_reason:"Owned fixture: native launch rejected an argument"}:r)}});});
  await page.goto(`http://localhost:${app.port}/#factory/${work.implementation_id}`);const recovery=page.getByRole("region",{name:"Next step",exact:true});
  await recovery.getByRole("button",{name:"Stop this attempt",exact:true}).waitFor();assert.equal(await recovery.getByRole("button",{name:"Mark work done",exact:true}).count(),0);
  const stoppedWork=page.waitForResponse(r=>r.url().endsWith(`/runs/${work.id}/stop`)&&r.request().method()==="POST");await recovery.getByRole("button",{name:"Stop this attempt",exact:true}).click();assert.equal((await stoppedWork).status(),200);
  await page.unroute(`**/api/factory/implementations/${work.implementation_id}`);await recovery.getByRole("button",{name:"Start work",exact:true}).waitFor();
  await page.goto(`http://localhost:${app.port}/#projects/${project.id}/inbox`);await page.getByRole("textbox",{name:"Idea title",exact:true}).fill("Plan the new checkout");await page.getByRole("button",{name:"Capture idea",exact:true}).click();
  await page.getByRole("heading",{name:"Plan the new checkout",exact:true}).waitFor();
  const planningId=new URL(page.url()).hash.slice("#factory/".length);
  const planning=page.waitForResponse(r=>r.url().endsWith("/continue")&&r.request().method()==="POST");await page.getByRole("button",{name:"Plan implementation",exact:true}).click();const planned=await planning;assert.equal(planned.status(),202);const plan=await planned.json();assert.equal(plan.action,"grill-with-docs");assert.equal(plan.condition,"working",JSON.stringify(fixtureFailures));
  await page.locator(".factory-panel").waitFor({state:"hidden"});
  const workflow=page.getByRole("dialog",{name:"Workflow",exact:true});
  const openWorkflow=async()=>{await page.getByRole("button",{name:"Workflow",exact:true}).click();await workflow.waitFor();};
  const continueStep=async()=>{
    // A shell fixture has no genuine transcript. Exercise the explicit partial-context
    // decision, rather than treating this stand-in as proof of a full native handoff.
    await workflow.getByRole("button",{name:"Continue with available context",exact:true}).click();
    const launched=page.waitForResponse(r=>r.url().endsWith("/continue")&&r.request().method()==="POST");
    await workflow.getByRole("button",{name:"Continue workflow",exact:true}).click();
    const response=await launched;const run=await response.json();assert.equal(response.status(),202,JSON.stringify(run));await workflow.waitFor({state:"hidden"});return run;
  };
  await openWorkflow();
  const answer=workflow.getByRole("textbox",{name:"Your answer",exact:true});
  await answer.fill("Keep this unsaved answer");
  await page.keyboard.press("Control+Shift+Comma");
  const settings=page.getByRole("dialog",{name:"Settings",exact:true});await settings.waitFor();
  await page.keyboard.press("Escape");await settings.waitFor({state:"hidden"});
  assert(await workflow.isVisible(),"Settings must own Escape without closing Workflow");
  assert.equal(await answer.inputValue(),"Keep this unsaved answer");
  await workflow.getByRole("textbox",{name:"Your answer",exact:true}).fill("The receipt selected by the owner.");await workflow.getByRole("button",{name:"Save answer",exact:true}).click();
  await workflow.getByRole("button",{name:"Confirm shared understanding",exact:true}).click();
  const specRun=await continueStep();assert.equal(specRun.action,"to-spec");
  await openWorkflow();await workflow.getByRole("button",{name:"Accept specification",exact:true}).click();await workflow.getByRole("button",{name:"Confirm testing seams",exact:true}).click();
  const ticketRun=await continueStep();assert.equal(ticketRun.action,"to-tickets");
  await openWorkflow();await workflow.getByText("Add the receipt preview",{exact:true}).waitFor();
  await workflow.getByRole("button",{name:"Approve Ticket graph",exact:true}).click();
  const verifyRun=await continueStep();assert.equal(verifyRun.action,"verify-provider");
  await openWorkflow();await workflow.getByRole("textbox",{name:"Your answer",exact:true}).fill("Confirmed for this owned read-only fixture.");await workflow.getByRole("button",{name:"Save answer",exact:true}).click();
  await workflow.getByText("Native verification will run before implementation.",{exact:true}).waitFor();
  assert.equal(await workflow.getByRole("button",{name:"Finish this step",exact:true}).count(),0);
  assert.equal(await workflow.getByRole("button",{name:"Stop Run",exact:true}).count(),0);
  assert.equal(await page.locator(".factory-panel").isVisible(),false);
  const snapshot=await page.request.get(`http://localhost:${app.port}/api/session`).then(r=>r.json()).then(result=>result.snapshot);
  for(const run of [plan,specRun,ticketRun])assert(snapshot.panes.some((pane:any)=>pane.pane_id===run.pane_id),"Finished planning chats must remain available");
  await shot("inbox-workflow-desktop.png");await page.setViewportSize({width:390,height:844});
  assert(await workflow.evaluate(el=>el.scrollWidth<=el.clientWidth),"Workflow must fit a phone");
  await shot("inbox-workflow-mobile.png");await page.setViewportSize({width:1440,height:1000});
  await page.keyboard.press("Escape");await workflow.waitFor({state:"hidden"});
  const actual=await page.request.get(`http://localhost:${app.port}/api/factory/providers?machine_id=local&implementation_id=${planningId}`).then(r=>r.json());assert.equal(actual.providers.find((p:any)=>p.provider==="codex").factory_ready,false);
  await page.goto(`http://localhost:${app.port}/#factory/${planningId}`);const steps=page.getByRole("region",{name:"Next step",exact:true});
  const head=execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim();const now=new Date().toISOString();const reviewId=crypto.randomUUID();
  await page.route(`**/api/factory/implementations/${planningId}`,async route=>{if(route.request().method()!=="GET")return route.continue();const original=await route.fetch();const detail=await original.json();await route.fulfill({json:{...detail,runs:[...detail.runs,{...verifyRun,id:reviewId,action:"implement-spec",condition:"working"}],checks:[{id:crypto.randomUUID(),created_at:now,updated_at:now,run_id:reviewId,worker_id:null,head,workspace_hash:"owned-ui-fixture",commands:[],condition:"passed"}]}});});
  let acceptedHead:string|undefined;let stoppedReview=false;
  await page.route(`**/api/factory/runs/${reviewId}/accept`,async route=>{acceptedHead=route.request().postDataJSON().head;await route.fulfill({status:409,json:{error:{code:"fixture_review_gate",message:"Owned UI response fixture: acceptance remains gated by the server."}}});});
  page.on("request",r=>{if(r.url().endsWith(`/runs/${reviewId}/stop`))stoppedReview=true;});
  await page.reload();await steps.getByRole("button",{name:"Accept reviewed head",exact:true}).click();await page.getByRole("alert").filter({hasText:"Owned UI response fixture"}).waitFor();assert.equal(acceptedHead,head);assert.equal(stoppedReview,false);assert.equal(await steps.getByRole("button",{name:"Finish this step",exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log("Inbox browser: chat-side approvals and continuation retain planning chats on desktop/mobile; fixture cannot certify native readiness");
} finally {await browser.close();app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
