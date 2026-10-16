/** Disposable repository + native GitHub executable, used only through the public Machine API. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import { FactoryStore } from "../server/factory-store.ts";

export async function mergeFixture(options: { milestone?: "merge" | "release" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-merge-")); const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "result.txt"), "before\n"); git(["add", "."]); git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]); const id = crypto.randomUUID(); const branch = `saurons-eye/${id}`;
  git(["checkout", "-b", branch]); writeFileSync(join(repo, "result.txt"), "after\n"); git(["commit", "-am", "candidate"]);
  const head = git(["rev-parse", "HEAD"]); git(["remote", "add", "origin", "https://github.com/fictional/project.git"]);
  const responses = join(root, "github.json"); const calls = join(root, "calls.jsonl");
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const pull = { author: { login: "fixture" }, number: 27, url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: head, headRefName: branch, baseRefName: "main", headRepository: { nameWithOwner: "fictional/project" }, baseRepository: { nameWithOwner: "fictional/project" }, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", merged: false, mergeCommit: null, reviewThreads: connection([]), reviewRequests: connection([]), reviews: connection([{ author: { login: "reviewer" }, state: "APPROVED", commit: { oid: head } }]), commits: connection([{ commit: { statusCheckRollup: { contexts: connection([{ name: "Required CI", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }]) };
  writeFileSync(responses, JSON.stringify({ pull, lose: false, release: null }));
  const tool = join(root, "gh.mjs");
  writeFileSync(tool, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2), path=args[1], file=${JSON.stringify(responses)}; appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const state=JSON.parse(readFileSync(file,'utf8')); const git=args=>execFileSync('git',['-C',${JSON.stringify(repo)},...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
let out;
if(path==='user')out={login:'fixture',id:42};
else if(path==='graphql')out={data:{repository:{pullRequest:state.pull}}};
else if(path?.endsWith('/merge')){ if(state.deny) { console.log(JSON.stringify({merged:false,message:state.deny}));process.exit(0); }
const sha=git(['commit-tree',git(['rev-parse',${JSON.stringify(head + "^{tree}")}]),'-p',git(['rev-parse','main']),'-m','Owned squash merge']); git(['update-ref','refs/heads/main',sha]); state.pull.state='MERGED';state.pull.merged=true;state.pull.mergeCommit={oid:sha};writeFileSync(file,JSON.stringify(state));if(state.lose)process.exit(1);out={merged:true,sha};}
else if(path?.includes('/compare/')){ const range=decodeURIComponent(path.split('/compare/')[1]);const [base,head]=range.split('...');try{git(['merge-base','--is-ancestor',base,head]);out={status:base===head?'identical':'ahead',merge_base_commit:{sha:base}};}catch{out={status:'diverged'};} }
else if(path?.endsWith('/releases'))out=state.release?[{draft:false,prerelease:false,tag_name:state.release}]:[];
else if(path?.includes('/commits/'))out={sha:git(['rev-parse',decodeURIComponent(path.split('/commits/')[1])+'^{commit}'])};
else out={}; console.log(JSON.stringify(out));`);
  const pane = { pane_id: "owned:p1", workspace_id: "owned", terminal_id: "owned-terminal", cwd: repo, agent: "codex", agent_status: "idle" };
  const stateDir = join(root, "state");
  const serverOptions = { port: 0, token: "owned-merge", stateDir, machines: false as const, factory: { native: { snapshot: async () => ({ panes: [pane], workspaces: [{ workspace_id: "owned", label: `saurons-eye-run-${id}` }] }) as any, paneState: async () => pane as any }, accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [tool] } } } };
  let app = createServer(serverOptions);
  const headers = { authorization: "Bearer owned-merge", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const created = await post("factory/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fixture" }).then(r => r.json());
  const profile = await post(`factory/machines/local/accounts/${created.id}/verify`, { expected_revision: created.revision }).then(r => r.json());
  const accountOverview = await fetch(`http://localhost:${app.port}/api/factory/machines/local/accounts`, { headers }).then(r => r.json());
  const initialProject = await post("factory/projects", { name: "Fixture", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
  const project = await post(`factory/projects/${initialProject.id}/configure`, { delivery_policy: options.milestone ?? "merge" }).then(r => r.json());
  const overview = await fetch(`http://localhost:${app.port}/api/factory`, { headers }).then(r => r.json());
  const store = new FactoryStore(stateDir); const record = store.record();
  const pr = { ...record, id: `${id}:${head}`, run_id: id, head, repository: "fictional/project", base_branch: "main", branch, number: 27, url: pull.url, check_id: "", evidence_ids: ["owned-standards", "owned-spec"] };
  const run = { ...record, id, action: "implement-spec", implementation_id: "owned-assignment", provider: "codex", machine_id: "local", condition: "ready", pane_id: pane.pane_id, workspace_id: pane.workspace_id, checkout: repo, worktree: repo, branch, base, manifest: { github_policy: { repository: "fictional/project", trusted_reviewers: ["reviewer"], required_checks: ["Required CI"] }, checkout: overview.checkouts[0], project: { ...project, checks: [["bun", "-e", "process.exit(0)"]], pull_request: { repository: "fictional/project", base_branch: "main" } }, planning_authority: { automatic_execution: true }, account_snapshot: { host_id: accountOverview.host_id, profiles: [{ id: profile.id, revision: profile.revision, service: "github", identity: profile.verified_identity }] } } };
  store.put("host_leases", { id, signature: "owned", run });
  for (const axis of ["standards", "spec"]) store.put("host_review_evidence", { ...record, id: `owned-${axis}`, worker_id: `owned-${axis}`, run_id: id, axis, head, outcome: "passed", source_id: `owned-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, id);
  const route = `factory-host/runs/${id}/operations/`;
  const current = await post(route + "head", {}).then(r => r.json());
  const checked = await post(route + "check", { check: { ...record, id: crypto.randomUUID(), run_id: id, worker_id: null, head: "", workspace_hash: "", commands: [], condition: "working" } }).then(r => r.json()); pr.check_id = checked.id;
  store.put("host_publications", { ...pr, condition: "published" }, id); store.close();
  const approval = { ...record, implementation_id: run.implementation_id, review_id: id, run_id: id, snapshot_id: crypto.randomUUID(), head, idempotency_key: "owned-approval", provenance: { kind: "owner_button", origin: "http://localhost" }, condition: "pending", reason: null, merge_sha: null, release_tag: null };
  const body = { ...current, approval, pull_request: pr, check_id: checked.id, evidence_ids: pr.evidence_ids, reports: ["standards", "spec"].map(axis => ({ worker_id: `owned-${axis}`, source_id: `owned-source-${axis}` })) };
  return { body, head, base, git, post, route, stateDir, id, run, headers, get app() { return app; },
    change: (patch: Record<string, unknown>) => { const s = JSON.parse(readFileSync(responses, "utf8")); writeFileSync(responses, JSON.stringify({ ...s, ...patch })); },
    pull: (patch: Record<string, unknown>) => { const s = JSON.parse(readFileSync(responses, "utf8")); writeFileSync(responses, JSON.stringify({ ...s, pull: { ...s.pull, ...patch } })); },
    calls: () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]),
    restart: () => { app.stop(); app = createServer(serverOptions); }, close: () => { app.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}
