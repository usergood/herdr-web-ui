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
const app=createServer({port:0,stateDir:join(root,"state"),factory:{accountDiscoveryHome:root,native:{version:async()=>"codex-cli 0.162.1",createWorkspace:async options=>{const created=await workspaceCreate(options);owned.push(created.workspace.workspace_id);return created;},startAgent:async options=>{
  const cwd=options.args![1]!;const context=JSON.parse(readFileSync(join(cwd,".saurons-eye-context.json"),"utf8"));const access=JSON.parse(readFileSync(join(cwd,".saurons-eye-access.json"),"utf8"));
  const propose=async(action:string,body:unknown)=>{const r=await fetch(access.url+"/"+action,{method:"POST",headers:{authorization:`Bearer ${access.token}`,"content-type":"application/json","x-herdr-factory":"1"},body:JSON.stringify(body)});if(r.status!==201){const b=await r.json();fixtureFailures.push({action,status:r.status,code:b.error?.code});}assert.equal(r.status,201);};
  if(context.run.action==="work"){assert(!options.args!.includes("multi_agent"));assert(options.args!.at(-1)!.includes("Fix the storefront"));}
  if(context.run.action==="grill-with-docs"){assert(options.args!.at(-1)!.startsWith("$grill-with-docs"));await propose("question",{question:"Which receipt should this feature preview?"});}
  if(context.run.action==="to-spec")await propose("specification",{content:"# Receipt preview\nShow the receipt selected by the owner.\n\n## Testing plan\nPublic HTTP and real browser checks with owned receipts."});
  if(context.run.action==="to-tickets")await propose("tickets",{specification_id:context.run.manifest.specification.id,tickets:[{key:"receipt",title:"Add the receipt preview",acceptance:"The selected receipt opens from the Project",dependencies:[]}]});
  await herdrRpc("pane.report_agent",{pane_id:options.paneId,source:"manual",agent:"codex",state:"working"});
}}}});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||chromium.executablePath(),headless:true,args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const project=await page.request.post(`http://localhost:${app.port}/api/factory/projects`,{headers:{"x-herdr-factory":"1"},data:{name:"Inbox Project",path:repo,machine_id:"local",provider:"codex",tracker:"app"}}).then(r=>r.json());
  await page.goto(`http://localhost:${app.port}/#projects/${project.id}/inbox`);
  await page.getByRole("textbox",{name:"Idea title",exact:true}).fill("Fix the storefront");await page.getByRole("textbox",{name:"Idea notes",exact:true}).fill("Add a receipt preview.");await page.getByRole("button",{name:"Capture idea",exact:true}).click();
  await page.getByRole("heading",{name:"Fix the storefront",exact:true}).waitFor();
  await page.getByRole("button",{name:"Start work",exact:true}).waitFor();await page.getByRole("button",{name:"Plan implementation",exact:true}).waitFor();
  assert.equal(await page.getByRole("textbox",{name:"Open question",exact:true}).isVisible(),false);
  const launched=page.waitForResponse(r=>r.url().endsWith("/runs")&&r.request().method()==="POST");await page.getByRole("button",{name:"Start work",exact:true}).click();const result=await launched;assert.equal(result.status(),202);const work=await result.json();assert.equal(work.action,"work");assert.equal(work.condition,"working");
  await page.locator(".factory-panel").waitFor({state:"hidden"});assert.equal(await page.getByRole("button",{name:"Chat",exact:true}).getAttribute("aria-pressed"),"true");
  await page.goto(`http://localhost:${app.port}/#projects/${project.id}/inbox`);await page.getByRole("textbox",{name:"Idea title",exact:true}).fill("Plan the new checkout");await page.getByRole("button",{name:"Capture idea",exact:true}).click();
  await page.getByRole("heading",{name:"Plan the new checkout",exact:true}).waitFor();
  const planningId=new URL(page.url()).hash.slice("#factory/".length);
  const planning=page.waitForResponse(r=>r.url().endsWith("/runs")&&r.request().method()==="POST");await page.getByRole("button",{name:"Plan implementation",exact:true}).click();const planned=await planning;assert.equal(planned.status(),202);const plan=await planned.json();assert.equal(plan.action,"grill-with-docs");assert.equal(plan.condition,"working",JSON.stringify(fixtureFailures));
  await page.locator(".factory-panel").waitFor({state:"hidden"});
  await page.goto(`http://localhost:${app.port}/#factory/${planningId}`);const steps=page.getByRole("region",{name:"Next step",exact:true});
  await steps.getByRole("textbox",{name:"Your answer",exact:true}).fill("The receipt selected by the owner.");await steps.getByRole("button",{name:"Save answer",exact:true}).click();
  await steps.getByRole("button",{name:"Confirm shared understanding",exact:true}).click();await steps.getByRole("button",{name:"Finish this step",exact:true}).click();
  await steps.getByRole("button",{name:"Create specification",exact:true}).click();await page.locator(".factory-panel").waitFor({state:"hidden"});
  await page.goto(`http://localhost:${app.port}/#factory/${planningId}`);await steps.getByRole("button",{name:"Finish this step",exact:true}).click();
  await steps.getByRole("button",{name:"Accept specification",exact:true}).click();await steps.getByRole("button",{name:"Confirm testing seams",exact:true}).click();await steps.getByRole("button",{name:"Plan tickets",exact:true}).click();
  await page.locator(".factory-panel").waitFor({state:"hidden"});await page.goto(`http://localhost:${app.port}/#factory/${planningId}`);await steps.getByText("Add the receipt preview",{exact:true}).waitFor();
  await steps.getByRole("button",{name:"Finish this step",exact:true}).click();await steps.getByRole("button",{name:"Approve Ticket graph",exact:true}).click();
  assert.equal(await steps.getByRole("button",{name:"Start implementation",exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);console.log("Inbox browser: direct work, pinned grilling, owner answers, specification and Ticket approvals passed; fixture cannot certify factory readiness");
} finally {await browser.close();app.stop();for(const id of owned)await workspaceClose(id).catch(()=>{});rmSync(root,{recursive:true,force:true});}
