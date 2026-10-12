import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

describe("guided Project setup through the public API", () => {
  it("imports a selected saved GitHub login without switching native accounts or returning credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "saurons-account-import-")); const cli = join(root, "gh-fixture.mjs");
    const token = "gho_owned_fixture_token_not_a_real_credential";
    writeFileSync(cli, `const args=process.argv.slice(2); if(args[0]==="auth"&&args[1]==="status") console.log(JSON.stringify({hosts:{"github.com":[{login:"fictional-work",active:true,state:"success",tokenSource:"keyring"}]}})); else if(args[0]==="auth"&&args[1]==="token") console.log(${JSON.stringify(token)}); else if(args[0]==="api"&&args[1]==="user") console.log(JSON.stringify({login:"fictional-work"})); else if(args[0]==="api"&&args[1]==="repos/fictional/storefront") console.log(JSON.stringify({full_name:"fictional/storefront",default_branch:"main"})); else if(args[0]==="api"&&args[1].endsWith("/protection")) console.log(JSON.stringify({required_status_checks:{contexts:["Fast checks"]},enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1},required_conversation_resolution:{enabled:true}})); else if(args[0]==="api"&&args[1].endsWith("/collaborators")) console.log(JSON.stringify([{login:"fictional-reviewer"}])); else {process.stderr.write("Unexpected or mutating command");process.exit(1);}`);
    const app = createServer({ port: 0, stateDir: join(root, "state"), factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } });
    try {
      const origin = `http://localhost:${app.port}/api/factory/machines/local/accounts`;
      const sources = await fetch(origin + "/discovery"); expect(sources.status).toBe(200); const inventory = await sources.json();
      expect(inventory.sources[0].login).toBe("fictional-work");
      const imported = await fetch(origin + "/import", { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, body: JSON.stringify({ source_id: inventory.sources[0].id }) });
      expect(imported.status).toBe(201); const text = await imported.text(); expect(text).not.toContain(token); const profile = JSON.parse(text);
      expect(profile.state).toBe("ready"); expect(profile.expected_login).toBe("fictional-work");
      const again = await fetch(origin); expect((await again.json()).profiles).toContainEqual(expect.objectContaining({ id: profile.id, state: "ready" }));
      const repo=join(root,"repository");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"# GitHub discovery fixture\n");execFileSync("git",["init","-b","main"],{cwd:repo,stdio:"ignore"});execFileSync("git",["add","."],{cwd:repo});execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"],{cwd:repo,stdio:"ignore"});execFileSync("git",["remote","add","origin","git@github.com:fictional/storefront.git"],{cwd:repo});
      const post=(path:string,body:unknown)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json","x-herdr-factory":"1","x-herdr-machine":"1"},body:JSON.stringify(body)});
      const project=await post("/projects",{name:"GitHub fixture",path:repo,machine_id:"local",provider:"codex",tracker:"app"}).then(r=>r.json());
      const defaults=await post(`/projects/${project.id}/github/settings`,{account_profile_id:profile.id});expect(defaults.status).toBe(200);const settings=await defaults.json();
      expect(settings.repository).toBe("fictional/storefront");expect(settings.required_checks).toEqual(["Fast checks"]);expect(settings.reviewers).toContain("fictional-reviewer");
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("detects repository checks and guidance without running repository scripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "saurons-project-discovery-")); const repo = join(root, "storefront"); mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "storefront", scripts: { typecheck: "tsc --noEmit", "test:unit": "echo owned fixture", build: "echo owned fixture" } }));
    writeFileSync(join(repo, "bun.lock"), "Owned discovery marker\n"); writeFileSync(join(repo, "AGENTS.md"), "Preserve the existing standards.\n");
    execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:fictional/storefront.git"], { cwd: repo });
    const app = createServer({ port: 0, stateDir: join(root, "state"), factory: { accountDiscoveryHome: root, native: { version: async () => "codex-cli 0.162.1" } } });
    try {
      const response = await fetch(`http://localhost:${app.port}/api/factory/project-discovery`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ path: repo, machine_id: "local" }) });
      expect(response.status).toBe(200); const result = await response.json();
      expect(result.name).toBe("storefront"); expect(result.github.repository).toBe("fictional/storefront");
      expect(result.checks).toContainEqual({ id: "script:typecheck", name: "typecheck", args: ["bun", "run", "typecheck"] });
      expect(result.guidance).toContain("AGENTS.md"); expect(result.permission_modes.codex).toContain("approve_for_me");
      const registered = await fetch(`http://localhost:${app.port}/api/factory/projects`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ name: "Storefront", path: repo, machine_id: "local", provider: "codex", tracker: "app", guided_setup: true, permission_mode: "approve_for_me", check_ids: ["script:typecheck"], guidance_task: true }) });
      expect(registered.status).toBe(201); const project = await registered.json();
      expect(project.checks).toEqual([["bun", "run", "typecheck"]]); expect(project.permission_mode).toBe("approve_for_me");
      expect(project.workflow_instructions).toContain("domain-modeling"); expect(project.guidance_assignment_id).toBeString();
      const overview = await fetch(`http://localhost:${app.port}/api/factory?navigation=1`).then((response) => response.json());
      expect(overview.implementations).toContainEqual(expect.objectContaining({ id: project.guidance_assignment_id, project_id: project.id, stage: "inbox" }));
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("saves a native permission choice without requiring permissions prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "saurons-project-setup-"));
    const repo = join(root, "repo"); mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Owned setup fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    const app = createServer({ port: 0, stateDir: join(root, "state") });
    const post = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const created = await post("/projects", { name: "Owned Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
      expect(created.status).toBe(201); const project = await created.json();
      const native = await fetch(`http://localhost:${app.port}/api/factory-host/runs/missing/verify-provider`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: "{}" });
      expect((await native.json()).error.code).toBe("verification_run_required");
      const saved = await post(`/projects/${project.id}/configure`, { permission_mode: "approve_for_me", permissions: "", context_target_tokens: 150000 });
      expect(saved.status).toBe(200);
      const value = await saved.json(); expect(value.permission_mode).toBe("approve_for_me");
      expect(value.permissions).toContain("automatic review");
      const guide=await post(`/projects/${project.id}/guidance`,{});expect(guide.status).toBe(201);const assignment=await guide.json();
      expect(assignment.description).toContain("writing-for-agents");expect(assignment.project_id).toBe(project.id);
      const duplicate=await post(`/projects/${project.id}/guidance`,{}).then(r=>r.json());expect(duplicate.id).toBe(assignment.id);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
