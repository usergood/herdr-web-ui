import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";

it("the owned Machine publishes the exact commit and reconciles a lost GitHub create acknowledgment without another POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-publication-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const id = crypto.randomUUID(); const branch = `saurons-eye/${id}`;
  git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "Owned publication fixture\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const head = git(["rev-parse", "HEAD"]); git(["checkout", "-b", branch]);
  const bare = join(root, "remote.git"); execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
  git(["remote", "add", "origin", "https://github.com/fictional/project.git"]);
  git(["config", `url.${bare}.insteadOf`, "https://github.com/fictional/project.git"]);
  const responses = join(root, "responses.json"); const calls = join(root, "calls.jsonl"); writeFileSync(responses, "[]");
  const tool = join(root, "gh.mjs");
  writeFileSync(tool, `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[1] === "user") { process.stdout.write(JSON.stringify({login:"fixture",id:42})); }
else if (args.includes("PATCH")) {
 const saved = JSON.parse(readFileSync(${JSON.stringify(responses)},"utf8"));
 saved[0].body = args.find(a => a.startsWith("body="))?.slice(5);
 saved[0].head.sha = (await import("node:child_process")).execFileSync("git", ["--git-dir", ${JSON.stringify(bare)}, "rev-parse", ${JSON.stringify(`refs/heads/${branch}`)}], {encoding:"utf8"}).trim();
 writeFileSync(${JSON.stringify(responses)}, JSON.stringify(saved)); process.exit(1);
}
else if (args.includes("POST")) {
 const field = name => args.find(a => a.startsWith(name + "="))?.slice(name.length + 1);
 writeFileSync(${JSON.stringify(responses)}, JSON.stringify([{ number:27, html_url:"https://github.com/fictional/project/pull/27", state:"open", body:field("body"), head:{sha:${JSON.stringify(head)},ref:${JSON.stringify(branch)},repo:{full_name:"fictional/project"}}, base:{ref:"main",repo:{full_name:"fictional/project"}} }]));
 process.exit(1);
} else process.stdout.write(readFileSync(${JSON.stringify(responses)},"utf8"));
`);
  const stateDir = join(root, "state");
  const pane = { pane_id: "owned:p1", workspace_id: "owned", terminal_id: "owned-terminal", cwd: repo, agent: "codex", agent_status: "idle" };
  const options = { port: 0, token: "owned-publication", stateDir, machines: false as const, factory: { native: { snapshot: async () => ({ panes: [pane], workspaces: [{ workspace_id: "owned", label: `saurons-eye-run-${id}` }] }) as any, paneState: async () => pane as any }, accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [tool] } } } };
  let app = createServer(options);
  const headers = { authorization: "Bearer owned-publication", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const created = await post("factory/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fixture" }).then(r => r.json());
    const profile = await post(`factory/machines/local/accounts/${created.id}/verify`, { expected_revision: created.revision }).then(r => r.json());
    const accountOverview = await fetch(`http://localhost:${app.port}/api/factory/machines/local/accounts`, { headers }).then(r => r.json());
    const project = await post("factory/projects", { name: "Fixture", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
    const overview = await fetch(`http://localhost:${app.port}/api/factory`, { headers }).then(r => r.json());
    // Fixture setup models a safely parked, checked Run owned by this Machine.
    const store = new FactoryStore(stateDir);
    const record = store.record();
    store.put("host_leases", { id, signature: "owned", run: { ...record, id, action: "implement-spec", implementation_id: "owned-assignment", provider: "codex", machine_id: "local", condition: "ready", pane_id: pane.pane_id, workspace_id: pane.workspace_id, checkout: repo, worktree: repo, branch, base: head, manifest: { project: { ...project, checks: [["bun", "-e", "process.exit(0)"]], pull_request: { repository: "fictional/project", base_branch: "main" } }, checkout: overview.checkouts[0], planning_authority: { automatic_execution: true }, account_snapshot: { host_id: accountOverview.host_id, profiles: [{ id: profile.id, revision: profile.revision, service: "github", identity: profile.verified_identity }] } } } });
    for (const axis of ["standards", "spec"]) store.put("host_review_evidence", { ...store.record(), id: `owned-${axis}`, worker_id: `owned-${axis}`, run_id: id, axis, head, outcome: "passed", source_id: `owned-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, id);
    store.close();
    const route = `factory-host/runs/${id}/operations/`;
    const current = await post(route + "head", {}).then(r => r.json());
    const checked = await post(route + "check", { check: { id: crypto.randomUUID(), run_id: id, worker_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), head: "", workspace_hash: "", commands: [], condition: "working" } }).then(r => r.json());
    const body = { ...current, check_id: checked.id, evidence_ids: ["owned-standards", "owned-spec"], reports: ["standards", "spec"].map(axis => ({ worker_id: `owned-${axis}`, source_id: `owned-source-${axis}` })) };
    const untrusted = await fetch(`http://localhost:${app.port}/api/${route}publish`, { method: "POST", headers: { authorization: "Bearer owned-publication", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    expect(untrusted.status).toBe(403);
    const forged = await post(route + "publish", { ...body, check_id: "unverified-check" });
    expect((await forged.json()).error.code).toBe("fresh_evidence_required");
    const first = await post(route + "publish", body);
    expect(first.status).toBe(409);
    app.stop(); app = createServer(options);
    const second = await post(route + "publish", body);
    const result = await second.json();
    expect(result).not.toHaveProperty("error");
    expect(second.status).toBe(200);
    expect(result).toMatchObject({ run_id: id, head, number: 27, base_branch: "main" });
    expect((await post(route + "publish", body)).status).toBe(200);
    expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST"))).toHaveLength(1);
    // Verify the effect through Git's public interface, never the factory store.
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim()).toBe(head);
    expect((await post(route + "publish", { ...body, head: "f".repeat(40) })).status).toBe(409);
    writeFileSync(join(repo, "README.md"), "Repaired owned candidate\n"); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Owned feedback repair"]);
    const repairedHead = git(["rev-parse", "HEAD"]);
    const repairEvidence = new FactoryStore(stateDir);
    for (const axis of ["standards", "spec"]) repairEvidence.put("host_review_evidence", { ...repairEvidence.record(), id: `repair-${axis}`, worker_id: `repair-${axis}`, run_id: id, axis, head: repairedHead, outcome: "passed", source_id: `repair-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, id);
    repairEvidence.close();
    const repairedCurrent = await post(route + "head", {}).then(r => r.json());
    const repairedCheck = await post(route + "check", { check: { id: crypto.randomUUID(), run_id: id, worker_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), head: "", workspace_hash: "", commands: [], condition: "working" } }).then(r => r.json());
    const repairBody = { ...repairedCurrent, previous_head: head, check_id: repairedCheck.id, evidence_ids: ["repair-standards", "repair-spec"], reports: ["standards", "spec"].map(axis => ({ worker_id: `repair-${axis}`, source_id: `repair-source-${axis}` })) };
    await post(route + "publish", repairBody); // Lost PATCH acknowledgment must reconcile without replay.
    app.stop(); app = createServer(options);
    const updated = await post(route + "publish", repairBody);
    expect(await updated.json()).toMatchObject({ run_id: id, head: repairedHead, number: 27 });
    expect(updated.status).toBe(200);
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim()).toBe(repairedHead);
    const requests = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(requests.filter(args => args.includes("PATCH"))).toHaveLength(1);

  } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20000);
