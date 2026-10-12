import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "saurons-setup-browser-")); const repo = join(root, "storefront"); mkdirSync(repo);
writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "echo fixture", "test:unit": "echo fixture" } }));
writeFileSync(join(repo, "bun.lock"), "Owned picker fixture\n"); writeFileSync(join(repo, "AGENTS.md"), "Keep the existing standards.\n");
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" }); execFileSync("git", ["remote", "add", "origin", "git@github.com:fictional/storefront.git"], { cwd: repo });
const cli = join(root, "gh.mjs");writeFileSync(cli,'const a=process.argv.slice(2); if(a[0]==="auth"&&a[1]==="status") console.log(JSON.stringify({hosts:{"github.com":[{login:"fictional-work",active:true,state:"success"}]}})); else if(a[0]==="auth"&&a[1]==="token") console.log("gho_owned_browser_fixture_not_a_credential"); else console.log(JSON.stringify({login:"fictional-work",id:1042}));');
const app=createServer({port:0,stateDir:join(root,"state"),factory:{accountDiscoveryHome:root,native:{version:async(provider)=>provider==="codex"?"codex-cli 0.162.1":null},accountTools:{github:{executable:process.execPath,args:[cli]}}}});
const workspace=await workspaceCreate({cwd:repo,label:"Owned setup native chat",focus:false}); await herdrRpc("pane.report_agent",{pane_id:workspace.root_pane.pane_id,source:"manual",agent:"codex",state:"working"});
const browser=await chromium.launch({executablePath:process.env["CHROME_PATH"]||chromium.executablePath(),headless:true,args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/workspace/directories?**",route=>route.fulfill({json:{path:repo,parent:root,home:root,directories:[],truncated:false}}));
  await page.goto(`http://localhost:${app.port}/#projects`);
  const dialog=page.getByRole("dialog",{name:"Projects",exact:true});
  assert.equal(await dialog.getByRole("textbox",{name:"Checkout path",exact:true}).count(),0);
  await dialog.getByRole("button",{name:"Checkout path",exact:true}).click(); await dialog.getByRole("button",{name:"Use this folder",exact:true}).click();
  await page.waitForFunction(()=>(document.querySelector('input[maxlength="200"]') as HTMLInputElement)?.value==="storefront");assert.equal(await dialog.getByRole("textbox",{name:"Project name",exact:true}).inputValue(),"storefront");
  await dialog.getByRole("button",{name:"Next",exact:true}).click();
  assert.equal(await dialog.getByRole("combobox",{name:"Execution permissions",exact:true}).inputValue(),"approve_for_me");
  assert.equal(await dialog.locator("textarea").count(),0); await dialog.getByRole("checkbox",{name:"typecheck",exact:true}).waitFor();
  await dialog.getByRole("button",{name:"Next",exact:true}).click();await dialog.getByRole("button",{name:"Import fictional-work",exact:true}).click();await dialog.getByText("Ready",{exact:true}).first().waitFor();
  await dialog.getByRole("button",{name:"Next",exact:true}).click();await dialog.getByText("AGENTS.md",{exact:true}).waitFor();
  await dialog.getByRole("button",{name:"Create Project",exact:true}).click();await page.getByRole("dialog",{name:"Project settings",exact:true}).waitFor();
  await page.getByRole("tab",{name:"Workflow",exact:true}).click();assert.equal(await page.getByRole("textbox",{name:"Execution permissions",exact:true}).count(),0);
  await page.getByRole("button",{name:"Save Project settings",exact:true}).click();await page.getByRole("alert").waitFor({state:"hidden"});
  await page.getByRole("button",{name:"Close settings",exact:true}).click();
  const group=page.locator(".project-navigation-group").filter({has:page.locator("summary").filter({hasText:"storefront"})});await group.locator('summary [data-status="working"]').waitFor();
  await group.locator("summary").click();await herdrRpc("pane.report_agent",{pane_id:workspace.root_pane.pane_id,source:"manual",agent:"codex",state:"blocked"});await group.locator('summary [data-status="blocked"]').waitFor();assert.equal(await group.getAttribute("open"),null);
  assert.deepEqual(errors,[]);console.log("Project setup browser: folder-only picker, defaults, account import, save and folded native statuses passed");
} finally {await browser.close();app.stop();await workspaceClose(workspace.workspace.workspace_id);rmSync(root,{recursive:true,force:true});}
