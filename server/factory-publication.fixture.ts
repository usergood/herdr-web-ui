import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { approveUpstreamPreparation } from "./upstream-preparation.fixture.ts";
import type { FactoryRun, FactoryWorker } from "../shared/factory.ts";

/** Owned GitHub and Git upload effects, observed through public requests. */
export async function factoryPublicationFixture(options: { checks?: string[][]; upstream?: boolean; deferPreparation?: boolean } = {}) {
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
    prompt: async paneId => { if (paneId === parentPane) await parentPrompt?.(); },
    pushBranch: async (upload: typeof uploads[number]) => {
      uploads.push(upload);
      const data = JSON.parse(readFileSync(state, "utf8")); data.head = upload.head;
      writeFileSync(state, JSON.stringify(data));
      await uploadEffect();
    },
  } }, { githubRepository: "fictional/project", accountTools: { github: { executable: process.execPath, args: [tool] } } });
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
