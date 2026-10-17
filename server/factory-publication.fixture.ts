import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { approveUpstreamPreparation } from "./upstream-preparation.fixture.ts";
import type { FactoryNative } from "./factory-native.ts";
import type { FactoryRun, FactoryWorker } from "../shared/factory.ts";

import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";

export async function machinePublicationFixture(assignmentTitle?: string) {
  const root = mkdtempSync(join(tmpdir(), "factory-publication-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const id = crypto.randomUUID(); const branch = `saurons-eye/${id}`;
  git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "Owned publication fixture\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const head = git(["rev-parse", "HEAD"]); git(["checkout", "-b", branch]);
  const bare = join(root, "remote.git"); execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
  git(["remote", "add", "origin", "https://github.com/fictional/project.git"]);
  const redirected = join(root, "redirected.git"); execFileSync("git", ["init", "--bare", redirected], { stdio: "ignore" });
  const originalPath = process.env.PATH; const realGit = Bun.which("git");
  if (!realGit) throw new Error("Owned Git fixture requires Git");
  const bin = join(root, "bin"); mkdirSync(bin);
  const globalConfig = join(root, "global.gitconfig"), systemConfig = join(root, "system.gitconfig");
  writeFileSync(globalConfig, "", { mode: 0o600 }); writeFileSync(systemConfig, "", { mode: 0o600 });
  // Stand in only for the fictional GitHub transport. Real Git still reads configuration
  // and performs every ref mutation, including attack rewrites to the other owned bare repo.
  writeFileSync(join(bin, "git"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2), env={...process.env,GIT_CONFIG_GLOBAL:${JSON.stringify(globalConfig)},GIT_CONFIG_SYSTEM:${JSON.stringify(systemConfig)}};delete env.GIT_CONFIG_NOSYSTEM;
const destination="https://github.com/fictional/project.git", index=args.indexOf(destination);
if(index>=0&&(args.includes("push")||args.includes("ls-remote"))){
 const cwdIndex=args.indexOf("-C"); const query=spawnSync(${JSON.stringify(realGit)},[...(cwdIndex>=0?["-C",args[cwdIndex+1]]:[]),"config","--get-regexp","^url\\..*\\.(insteadof|pushinsteadof)$"],{env,encoding:"utf8"});
 const rewritten=(query.stdout??"").split("\\n").some(row=>{const offset=row.indexOf(" ");const key=row.slice(0,offset).toLowerCase(),value=row.slice(offset+1);return offset>0&&destination.startsWith(value)&&(key.endsWith(".insteadof")||args.includes("push")&&key.endsWith(".pushinsteadof"));});
 if(!rewritten)args[index]=${JSON.stringify(bare)};
}
const result=spawnSync(${JSON.stringify(realGit)},args,{env,stdio:"inherit"});process.exit(result.status??1);
`, { mode: 0o700 });
  process.env.PATH = bin + ":" + (originalPath ?? "");
  const rewrite = (kind: "insteadOf" | "pushInsteadOf", scope: "local" | "global" | "system" = "local") => git(["config", "--" + scope, `url.${redirected}.${kind}`, "https://github.com/fictional/project.git"]);
  const clearRewrites = () => { for (const kind of ["insteadOf", "pushInsteadOf"]) for (const scope of ["local", "global", "system"]) { try { git(["config", "--" + scope, "--unset-all", `url.${redirected}.${kind}`]); } catch { /* No setting is already clear. */ } } };
  const redirectedRefs = () => execFileSync("git", ["--git-dir", redirected, "for-each-ref", "--format=%(objectname) %(refname)"], { encoding: "utf8" }).trim();

  const responses = join(root, "responses.json"); const calls = join(root, "calls.jsonl"); writeFileSync(responses, "[]");
  const control = join(root, "control.json"); const waiting = join(root, "waiting"); const release = join(root, "release"); writeFileSync(control, "{}");
  const tool = join(root, "gh.mjs");
  writeFileSync(tool, `import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const controlFile = ${JSON.stringify(control)}; const state = JSON.parse(readFileSync(controlFile,"utf8"));
async function hold() { writeFileSync(${JSON.stringify(waiting)}, "waiting"); const deadline=Date.now()+8000; while(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)process.exit(1); await Bun.sleep(10);} }
if (args[1] === "user") { if (state.arm_user) await hold(); process.stdout.write(JSON.stringify({login:"fixture",id:42})); }
else if (args.includes("PATCH")) {
 if(state.hold_mutation) await hold();
 const saved = JSON.parse(readFileSync(${JSON.stringify(responses)},"utf8"));
 saved[0].body = args.find(a => a.startsWith("body="))?.slice(5);
 saved[0].head.sha = (await import("node:child_process")).execFileSync("git", ["--git-dir", ${JSON.stringify(bare)}, "rev-parse", ${JSON.stringify(`refs/heads/${branch}`)}], {encoding:"utf8"}).trim();
 writeFileSync(${JSON.stringify(responses)}, JSON.stringify(saved)); process.exit(1);
}
else if (args.includes("POST")) {
 if(state.hold_mutation) await hold();
 const field = name => args.find(a => a.startsWith(name + "="))?.slice(name.length + 1);
 writeFileSync(${JSON.stringify(responses)}, JSON.stringify([{ number:27, html_url:"https://github.com/fictional/project/pull/27", state:"open", body:field("body"), head:{sha:${JSON.stringify(head)},ref:${JSON.stringify(branch)},repo:{full_name:"fictional/project"}}, base:{ref:"main",repo:{full_name:"fictional/project"}} }]));
 process.exit(1);
} else { if(state.hold_lookup) await hold(); if(state.hold_account) {state.arm_user=true;writeFileSync(controlFile,JSON.stringify(state));} process.stdout.write(readFileSync(${JSON.stringify(responses)},"utf8")); }
`);
  const stateDir = join(root, "state");
  let closed = false;
  const pane = { pane_id: "owned:p1", workspace_id: "owned", terminal_id: "owned-terminal", cwd: repo, agent: "codex", agent_status: "idle" };
  const options = { port: 0, token: "owned-publication", stateDir, machines: false as const, factory: { native: { snapshot: async () => ({ panes: closed ? [] : [pane], workspaces: closed ? [] : [{ workspace_id: "owned", label: `saurons-eye-run-${id}` }] }) as any, closeWorkspace: async () => { closed = true; return {} as any; }, paneState: async () => pane as any }, accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [tool] } } } };
  let app = createServer(options);
  const headers = { authorization: "Bearer owned-publication", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const created = await post("factory/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fixture" }).then(r => r.json());
    const profile = await post(`factory/machines/local/accounts/${created.id}/verify`, { expected_revision: created.revision }).then(r => r.json());
    const accountOverview = await fetch(`http://localhost:${app.port}/api/factory/machines/local/accounts`, { headers }).then(r => r.json());
    const project = await post("factory/projects", { name: "Fixture", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
    const overview = await fetch(`http://localhost:${app.port}/api/factory`, { headers }).then(r => r.json());
    // Restore a fictional parked/check-reviewed Machine fixture, not provider certification.
    // All behavioral assertions use authenticated HTTP, the fake GitHub tool and owned Git refs.
    const store = new FactoryStore(stateDir);
    const record = store.record();
    store.put("host_leases", { id, signature: "owned", run: { ...record, id, action: "implement-spec", implementation_id: "owned-assignment", provider: "codex", machine_id: "local", condition: "ready", pane_id: pane.pane_id, workspace_id: pane.workspace_id, checkout: repo, worktree: repo, branch, base: head, manifest: { ...(assignmentTitle === undefined ? {} : { implementation: { title: assignmentTitle } }), project: { ...project, checks: [["bun", "-e", "process.exit(0)"]], pull_request: { repository: "fictional/project", base_branch: "main" } }, checkout: overview.checkouts[0], planning_authority: { automatic_execution: true }, account_snapshot: { host_id: accountOverview.host_id, profiles: [{ id: profile.id, revision: profile.revision, service: "github", identity: profile.verified_identity }] } } } });
    for (const axis of ["standards", "spec"]) store.put("host_review_evidence", { ...store.record(), id: `owned-${axis}`, worker_id: `owned-${axis}`, run_id: id, axis, head, outcome: "passed", source_id: `owned-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, id);
    store.close();
    const route = `factory-host/runs/${id}/operations/`;
    const current = await post(route + "head", {}).then(r => r.json());
    const checked = await post(route + "check", { check: { id: crypto.randomUUID(), run_id: id, worker_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), head: "", workspace_hash: "", commands: [], condition: "working" } }).then(r => r.json());
    const body = { ...current, check_id: checked.id, evidence_ids: ["owned-standards", "owned-spec"], reports: ["standards", "spec"].map(axis => ({ worker_id: `owned-${axis}`, source_id: `owned-source-${axis}` })) };
    const repair = async () => {
      writeFileSync(join(repo, "README.md"), "Repaired owned candidate\n"); git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Owned feedback repair"]);
      const repairedHead = git(["rev-parse", "HEAD"]);
      const repairEvidence = new FactoryStore(stateDir);
      for (const axis of ["standards", "spec"]) repairEvidence.put("host_review_evidence", { ...repairEvidence.record(), id: `repair-${axis}`, worker_id: `repair-${axis}`, run_id: id, axis, head: repairedHead, outcome: "passed", source_id: `repair-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, id);
      repairEvidence.close();
      const repairedCurrent = await post(route + "head", {}).then(r => r.json());
      const repairedCheck = await post(route + "check", { check: { id: crypto.randomUUID(), run_id: id, worker_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), head: "", workspace_hash: "", commands: [], condition: "working" } }).then(r => r.json());
      const repairBody = { ...repairedCurrent, previous_head: head, check_id: repairedCheck.id, evidence_ids: ["repair-standards", "repair-spec"], reports: ["standards", "spec"].map(axis => ({ worker_id: `repair-${axis}`, source_id: `repair-source-${axis}` })) };
      return { repairedHead, repairBody };
    };
    return { get app() { return app; }, get closed() { return closed; }, root, control, waiting, release, calls, responses, id, route, body, head, branch, bare, git, post, repair, rewrite, clearRewrites, redirectedRefs,
      restart: () => { app.stop(); app = createServer(options); },
      close: () => { writeFileSync(release, "release"); app.stop(); process.env.PATH = originalPath; rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { app.stop(); process.env.PATH = originalPath; rmSync(root, { recursive: true, force: true }); throw error; }
}


/** Owned GitHub and Git upload effects, observed through public requests. */
export async function factoryPublicationFixture(options: { checks?: string[][]; upstream?: boolean; deferPreparation?: boolean; coordinatorNative?: Partial<FactoryNative>; coordinatorToken?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "saurons-pr-"));
  const state = join(root, "github.json"), log = join(root, "calls.jsonl"), tool = join(root, "gh.mjs");
  writeFileSync(state, JSON.stringify({ pulls: [], head: null, lose_receipt: false }));
  writeFileSync(tool, `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2), endpoint = args[1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, scoped: Boolean(process.env.GH_CONFIG_DIR) }) + "\\n");
const data = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const field = name => { const i = args.indexOf(name); return i < 0 ? null : args[i+1]; };
const raw = Object.fromEntries(args.flatMap((arg,i) => arg === "--raw-field" ? [args[i+1].split(/=(.*)/s).slice(0,2)] : []));
let value;
if (endpoint === "user") value = { login: "fictional-owner", id: 1042 };
else if (endpoint === "graphql") value = { data: { repository: { pullRequests: { nodes: data.graphql_pulls ?? [], pageInfo: { hasNextPage: false, endCursor: null } }, pullRequest: data.graphql_pulls?.[0] ?? null } } };
else if (endpoint.endsWith("/merge") && field("--method") === "PUT") value = { merged: true };
else if (endpoint === "repos/fictional/project") value = { full_name: "fictional/project" };
else if (endpoint.includes("/releases?")) value = data.releases ?? [];
else if (endpoint.includes("/commits/")) value = { sha: data.release_head };
else if (endpoint.includes("/branches/")) value = { name: decodeURIComponent(endpoint.split("/branches/")[1]), commit: { sha: data.head } };
else if (endpoint.includes("/pulls?") && !args.includes("--method")) value = data.pulls;
else if (endpoint === "repos/fictional/project/pulls" && field("--method") === "POST") {
 const repository = data.canonical_repository ?? "fictional/project";
 value = { number: 42, html_url: "https://github.com/" + repository + "/pull/42", state: "open", body: raw.body, head: { ref: raw.head, sha: data.head, repo: { full_name: repository } }, base: { ref: raw.base, repo: { full_name: repository } } };
 data.pulls.push(value); writeFileSync(${JSON.stringify(state)}, JSON.stringify(data));
 if(data.lose_receipt) process.exit(1);
} else { process.stderr.write("Unexpected owned GitHub operation"); process.exit(1); }
process.stdout.write(JSON.stringify(value));
`);
  const uploads: { cwd: string; repository: string; branch: string; head: string }[] = [];
  let uploadEffect = async () => {};
  let parentPane: string | null = null;
  let parentPrompt: (() => Promise<void>) | null = null;
  const f = await factoryDeliveryFixture(true, true, { ...{
    ...(options.coordinatorNative?.modelCatalog ? { modelCatalog: options.coordinatorNative.modelCatalog } : {}),
    prompt: async paneId => { if (paneId === parentPane) await parentPrompt?.(); },
    pushBranch: async (upload: typeof uploads[number]) => {
      uploads.push(upload);
      const data = JSON.parse(readFileSync(state, "utf8")); data.head = upload.head;
      writeFileSync(state, JSON.stringify(data));
      await uploadEffect();
    },
  } }, { githubRepository: "fictional/project", accountTools: { github: { executable: process.execPath, args: [tool] } }, coordinatorNative: options.coordinatorNative, coordinatorToken: options.coordinatorToken });
  const profile = await f.request("/machines/delivery-host/accounts", { name: "Publication fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
  if (!(await f.request(`/machines/delivery-host/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).ok) throw new Error("Owned publication account verification failed");
  await f.request(`/projects/${f.project.id}/configure`, { account_bindings: { "delivery-host": { github: profile.id } }, checks: options.checks ?? [["git", "status", "--porcelain"]], ...(options.upstream ? { permissions: "Owned upstream fixture and isolated workspaces only" } : {}) });
  let prefix = f.prefix;
  let upstreamRevision: string | null = null;
  if (options.upstream) {
    const releasePath = join(root, "release");
    f.git(["worktree", "add", "-b", "owned-upstream-release", releasePath, "main"]);
    writeFileSync(join(releasePath, "feature.md"), "Approved upstream release\n");
    f.git(["add", "feature.md"], releasePath);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "upstream v1"], releasePath);
    upstreamRevision = f.git(["rev-parse", "HEAD"], releasePath).trim();
    const data = JSON.parse(readFileSync(state, "utf8"));
    writeFileSync(state, JSON.stringify({ ...data, releases: [{ id: 101, tag_name: "v1", draft: false, published_at: "2026-10-12T09:00:00Z" }], release_head: upstreamRevision }));
    const local = await f.request("/machines/local/accounts", { name: "Upstream fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
    await f.request(`/machines/local/accounts/${local.id}/verify`, { expected_revision: local.revision });
    const route = `/projects/${f.project.id}/github`;
    const configured = await f.request(route + "/configure", { expected_revision: null, repository: "fictional/project", upstream_repository: "fictional/upstream", account_profile_id: local.id, sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Owned upstream preparation", poll_minutes: 15 });
    if (!configured.ok) throw new Error("Owned upstream configuration failed");
    const detected = await f.request(route + "/schedules/run", { job: "upstream_sync" }).then(r => r.json());
    prefix = `/implementations/${detected.upstream.active.implementation_id}`;
    await approveUpstreamPreparation(f.request, prefix);
  }
  const run = options.upstream ? await f.request(prefix + "/runs", { action: "work", idempotency_key: "approved-upstream-work" }).then(r => r.json()) : await f.start();
  parentPane = run.pane_id;
  const holdParentPrompt = () => {
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const held = new Promise<void>(resolve => release = resolve);
    parentPrompt = async () => { entered(); await held; };
    return { waiting, release: () => { parentPrompt = null; release(); } };
  };
  const commit = () => {
    writeFileSync(join(run.worktree!, "feature.md"), "Approved Assignment change\n");
    f.git(["add", "feature.md"], run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "approved change"], run.worktree!);
    const head = f.git(["rev-parse", "HEAD"], run.worktree!).trim(); f.setReviewHead(head); return head;
  };
  if (upstreamRevision && !options.deferPreparation) f.git(["merge", "--ff-only", upstreamRevision], run.worktree!);
  const head = options.upstream ? f.git(["rev-parse", "HEAD"], run.worktree!).trim() : commit();
  f.setReviewHead(head);
  const settledParent = async () => {
    const observe = async () => {
      const response = await f.request(prefix);
      if (!response.ok) throw new Error(`Owned publication parent observation failed: ${response.status}`);
      const detail = await response.json() as { runs: FactoryRun[] };
      const current = detail.runs.find(candidate => candidate.id === run.id);
      if (!current || current.pane_id !== run.pane_id || current.workspace_id !== run.workspace_id || current.worktree !== run.worktree || current.branch !== run.branch) throw new Error("Owned publication parent identity changed");
      return current;
    };
    let current = await observe();
    // Native delivery owns this reservation until its response settles. Observing it must not resend.
    if (current.continuation?.condition !== "sending") {
      const reconciled = await f.request(`/runs/${run.id}/reconcile`, {});
      if (!reconciled.ok) throw new Error(`Owned publication parent reconciliation failed: ${reconciled.status}`);
      current = await observe();
    }
    const deadline = Date.now() + 8000;
    while (current.condition === "accepted" || ["queued", "sending"].includes(current.continuation?.condition ?? "")) {
      if (Date.now() > deadline) throw new Error("Owned publication parent continuation did not settle");
      await new Promise(resolve => setTimeout(resolve, 20));
      current = await observe();
    }
    if (!["working", "ready", "needs_you", "blocked"].includes(current.condition) || ["blocked", "uncertain"].includes(current.continuation?.condition ?? "")) throw new Error("Owned publication parent requires reconciliation");
  };
  const verify = async () => {
    await settledParent();
    const checked = await f.request(`/runs/${run.id}/checks`, {});
    if (!checked.ok || (await checked.json()).condition !== "passed") throw new Error("Owned publication checks failed");
    for (const role of ["standards", "spec"]) {
      await settledParent();
      const allocated = await f.request(`/runs/${run.id}/workers`, { role, idempotency_key: `publication-${role}` });
      if (!allocated.ok) throw new Error(`Owned publication reviewer allocation failed: ${allocated.status} ${await allocated.text()}`);
      const worker = await allocated.json() as FactoryWorker;
      if (worker.run_id !== run.id || worker.role !== role || !worker.pane_id) throw new Error("Owned publication reviewer was not admitted");
      const reconciled = await f.request(`/runs/${run.id}/workers/${worker.id}/reconcile`, {});
      if (!reconciled.ok || (await reconciled.json()).condition !== "ready") throw new Error("Owned publication reviewer is not at verified native rest");
      // A resting child can resume its parent; drain that observed transition before collecting evidence.
      await settledParent();
      const evidence = await f.request(`/runs/${run.id}/workers/${worker.id}/review-evidence`, {});
      if (!evidence.ok) throw new Error(`Owned independent publication review failed: ${evidence.status} ${await evidence.text()}`);
    }
  };
  const legacyPolicy = async () => {
    const local = await f.request("/machines/local/accounts", { name: "Coordinator fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
    await f.request(`/machines/local/accounts/${local.id}/verify`, { expected_revision: local.revision });
    return f.request(`/projects/${f.project.id}/github/configure`, { expected_revision: null, repository: "fictional/project", account_profile_id: local.id, sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: true, auto_implement: true, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "Owned PR automation fixture", poll_minutes: 15 });
  };
  const agent = (action: string, body?: unknown) => {
    const access = JSON.parse(readFileSync(join(run.worktree!, ".saurons-eye-access.json"), "utf8"));
    return fetch(`http://localhost:${f.app.port}${new URL(access.url).pathname}/${action}`, { headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  };
  return { ...f, prefix, get app() { return f.app; }, profile, run, head, upstreamRevision, uploads, verify, legacyPolicy, agent, holdParentPrompt, route: `/runs/${run.id}/publication`, afterUpload: (effect: () => Promise<void>) => { uploadEffect = effect; },
    github: (change: Record<string, unknown>) => { const data = JSON.parse(readFileSync(state, "utf8")); writeFileSync(state, JSON.stringify({ ...data, ...change })); },
    calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; scoped: boolean }),
    close: async () => { await f.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
