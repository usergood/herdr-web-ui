import { expect, it, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { factoryPublicationFixture } from "./factory-publication.fixture.ts";
import { fictionalGitHubPull } from "../site/demo/github-fixtures.ts";

async function publicationFixture() {
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
} else { if(state.hold_account) {state.arm_user=true;writeFileSync(controlFile,JSON.stringify(state));} process.stdout.write(readFileSync(${JSON.stringify(responses)},"utf8")); }
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
    store.put("host_leases", { id, signature: "owned", run: { ...record, id, action: "implement-spec", implementation_id: "owned-assignment", provider: "codex", machine_id: "local", condition: "ready", pane_id: pane.pane_id, workspace_id: pane.workspace_id, checkout: repo, worktree: repo, branch, base: head, manifest: { project: { ...project, checks: [["bun", "-e", "process.exit(0)"]], pull_request: { repository: "fictional/project", base_branch: "main" } }, checkout: overview.checkouts[0], planning_authority: { automatic_execution: true }, account_snapshot: { host_id: accountOverview.host_id, profiles: [{ id: profile.id, revision: profile.revision, service: "github", identity: profile.verified_identity }] } } } });
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
    return { get app() { return app; }, get closed() { return closed; }, root, control, waiting, release, calls, responses, id, route, body, head, branch, bare, git, post, repair,
      restart: () => { app.stop(); app = createServer(options); },
      close: () => { writeFileSync(release, "release"); app.stop(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { app.stop(); rmSync(root, { recursive: true, force: true }); throw error; }
}

it("the owned Machine publishes the exact commit and reconciles a lost GitHub create acknowledgment without another POST", async () => {
  const f = await publicationFixture();
  const { calls, id, route, body, head, branch, bare, post } = f;
  try {
    const untrusted = await fetch(`http://localhost:${f.app.port}/api/${route}publish`, { method: "POST", headers: { authorization: "Bearer owned-publication", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    expect(untrusted.status).toBe(403);
    const forged = await post(route + "publish", { ...body, check_id: "unverified-check" });
    expect((await forged.json()).error.code).toBe("fresh_evidence_required");
    const first = await post(route + "publish", body);
    expect(first.status).toBe(409);
    f.restart();
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
    const { repairedHead, repairBody } = await f.repair();
    await post(route + "publish", repairBody); // Lost PATCH acknowledgment must reconcile without replay.
    f.restart();
    const updated = await post(route + "publish", repairBody);
    expect(await updated.json()).toMatchObject({ run_id: id, head: repairedHead, number: 27 });
    expect(updated.status).toBe(200);
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim()).toBe(repairedHead);
    const requests = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(requests.filter(args => args.includes("PATCH"))).toHaveLength(1);

  } finally { f.close(); }
}, 20000);

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Owned publication observation deadline"); await Bun.sleep(10); }
}

it("Stop retains publication held at its final account check and prevents PR creation afterward", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ hold_account: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    let stopAnswered = false;
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}).then(response => { stopAnswered = true; return response; });
    await waitFor(() => f.closed);
    // The fake native boundary proves Stop took ownership before the final account gate opens.
    writeFileSync(f.release, "release");
    const stopped = await stopping; expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ condition: "cancelled" });
    const refused = await publishing; expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: "run_stopping" } });
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST") || args.includes("PATCH"));
    expect(mutations).toHaveLength(0); expect(stopAnswered).toBe(true);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop waits for an already dispatched uncertain PR create before releasing its owned Run", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ hold_mutation: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    const retained = await f.post(`factory-host/runs/${f.id}/reconcile`, {}).then(r => r.json());
    expect(retained.condition).not.toBe("cancelled");
    writeFileSync(f.release, "release");
    const uncertain = await publishing; expect(uncertain.status).toBe(409); expect(await uncertain.json()).toMatchObject({ error: { code: "publication_uncertain" } });
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    f.restart(); expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST"));
    expect(mutations).toHaveLength(1);
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(f.head);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop prevents a repaired PR PATCH after its final account verification resumes", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
    expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
    const { repairedHead, repairBody } = await f.repair();
    writeFileSync(f.control, JSON.stringify({ hold_account: true }));
    publishing = f.post(f.route + "publish", repairBody); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    writeFileSync(f.release, "release");
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    const refused = await publishing;
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(mutations.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(mutations.filter(args => args.includes("PATCH"))).toHaveLength(0);
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: "run_stopping" } });
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(repairedHead);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop also retains publication waiting for its initial frozen account verification", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ arm_user: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    expect((await f.post(`factory-host/runs/${f.id}/reconcile`, {}).then(r => r.json())).condition).not.toBe("cancelled");
    writeFileSync(f.release, "release");
    expect((await publishing).status).toBe(409);
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    expect(readFileSync(f.calls, "utf8")).not.toContain('"POST"');
    expect(readFileSync(f.calls, "utf8")).not.toContain('"PATCH"');
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

test("implementation PR publication defaults off and requires its own explicit Project setting", async () => {
  const f = await factoryDeliveryFixture();
  try {
    expect(f.project.auto_publish_pr).toBe(false);
    const route = `/projects/${f.project.id}/configure`;
    expect((await f.request(route, { auto_publish_pr: "true" })).status).toBe(400);
    const enabled = await f.request(route, { auto_publish_pr: true }).then(r => r.json());
    expect(enabled.auto_publish_pr).toBe(true);
    const unchanged = await f.request(route, { delivery_policy: "release" }).then(r => r.json());
    expect(unchanged.auto_publish_pr).toBe(true);
    expect((await f.request(route, { auto_publish_pr: false }).then(r => r.json())).auto_publish_pr).toBe(false);
  } finally { await f.close(); }
});

test("only an explicitly published accepted head opens its scoped PR and retains Awaiting merge", async () => {
  const f = await factoryPublicationFixture();
  try {
    const proof = { head: f.head, title: "fix(factory): retain the reviewed result", body: "Completed work previously remained ambiguous. Preserve the accepted final change and its evidence." };
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, proof)).status).toBe(200);
    expect(f.uploads).toHaveLength(0);
    const published = await f.request(f.route + "/publish", proof);
    expect(published.status).toBe(200);
    const receipt = await published.json();
    const created = f.calls().find(call => call.args.includes("--method"))!;
    expect(created.args).toContain(`title=${proof.title}`);
    const body = created.args.find(arg => arg.startsWith("body="))!;
    expect(body).toContain(proof.body); expect(body).toContain("git status --porcelain: exit 0");
    expect(body).toContain(`Validation at ${f.head}`); expect(body).toContain(`<!-- saurons-eye-pr:${receipt.id} -->`);
    expect(receipt).toMatchObject({ condition: "confirmed", head: f.head, repository: "fictional/project", target_branch: "main", branch: f.run.branch, pull: { number: 42 } });
    expect(f.uploads).toEqual([{ cwd: f.run.worktree!, repository: "fictional/project", branch: f.run.branch!, head: f.head }]);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.delivery.pull_numbers).toEqual([42]);
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    expect((await f.request(`/projects/${f.project.id}/queue`).then(r => r.json())).capacity.project_implementations).toBe(0);
    expect((await f.request(f.route + "/publish", proof).then(r => r.json())).id).toBe(receipt.id);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
    expect(f.calls().every(call => call.scoped && !call.args.some(arg => /\/(merge|releases|deployments)$/.test(arg)))).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test("GitHub's canonical repository casing still identifies the approved publication receipt", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify(); await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.github({ canonical_repository: "Fictional/Project" });
    const receipt = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(receipt).toMatchObject({ condition: "confirmed", repository: "fictional/project", pull: { number: 42, url: "https://github.com/Fictional/Project/pull/42" } });
  } finally { await f.close(); }
}, 60_000);

test("failed configured checks cannot authorize acceptance or PR publication", async () => {
  const f = await factoryPublicationFixture({ checks: [["git", "rev-parse", "--verify", "refs/heads/missing-owned-ref"]] });
  try {
    expect((await f.request(`/runs/${f.run.id}/checks`, {}).then(r => r.json())).condition).toBe("failed");
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect((await f.request(f.route + "/publish", { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("a failing independent review cannot authorize acceptance or PR publication", async () => {
  const f = await factoryPublicationFixture();
  try {
    f.setReviewOutcome("failed"); await f.verify();
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.review_evidence.map((report: { outcome: string }) => report.outcome)).toEqual(["failed", "failed"]);
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect((await f.request(f.route + "/publish", { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("changed heads, workspace contents, branches, repositories and required checks block publication without remote writes", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    const proof = { head: f.head };
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.request(`/runs/${f.run.id}/accept`, proof);
    expect((await f.request(f.route + "/publish", { head: "0".repeat(40) })).status).toBe(409);
    const dirty = join(f.run.worktree!, "unreviewed.md"); writeFileSync(dirty, "Unreviewed owned change\n");
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409); rmSync(dirty);
    f.git(["branch", "-m", "unapproved-owned-branch"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    f.git(["branch", "-m", f.run.branch!], f.run.worktree!);
    f.git(["remote", "set-url", "origin", "https://github.com/fictional/other.git"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    f.git(["remote", "set-url", "origin", "https://github.com/fictional/project.git"], f.run.worktree!);
    await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "diff", "--exit-code"]] });
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
    writeFileSync(dirty, "Committed after acceptance\n"); f.git(["add", "unreviewed.md"], f.run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unreviewed commit"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    expect((await f.request(f.route).then(r => r.json())).eligible).toBe(false);
    expect(f.uploads).toHaveLength(0);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("an uncertain implementation PR requires manual merge even when legacy GitHub automation would merge it", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect((await f.legacyPolicy()).status).toBe(200);
    // Implementation opt-in and existing PR policy do not authorize publication.
    expect(f.uploads).toHaveLength(0);
    expect((await f.request("").then(r => r.json())).projects[0].auto_publish_pr).toBe(false);
    f.github({ lose_receipt: true });
    const intent = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(intent.condition).toBe("uncertain");
    const pull = structuredClone(fictionalGitHubPull);
    Object.assign(pull, { number: 42, id: "owned-implementation-pr", headRefOid: f.head, headRefName: f.run.branch, author: { login: "fictional-owner" }, body: `<!-- saurons-eye-pr:${intent.id} -->`, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", viewerCanUpdate: true });
    pull.reviewRequests.nodes = [];
    pull.reviews.nodes = [{ id: "owned-trusted-review", state: "APPROVED", body: "Reviewed", submittedAt: "2026-10-14T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: f.head } }];
    f.github({ graphql_pulls: [pull] });
    expect((await f.request(`/projects/${f.project.id}/github/sync`, {})).status).toBe(200);
    expect(f.calls().filter(call => call.args.some(arg => arg.endsWith("/merge")))).toHaveLength(0);
    expect((await f.request(f.prefix).then(r => r.json())).board.activity).toBe("awaiting_merge");
  } finally { await f.close(); }
}, 60_000);

test("restarting during branch upload retains an uncertain publication and never resumes creation automatically", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.afterUpload(async () => { f.restart(); });
    await f.request(f.route + "/publish", { head: f.head }).catch(() => null);
    const view = await f.request(f.route).then(r => r.json());
    expect(view.publication.condition).toBe("uncertain");
    expect((await f.request(f.route + "/publish", { head: f.head }).then(r => r.json())).id).toBe(view.publication.id);
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    await f.request(f.route + "/reconcile", {});
    expect((await f.request(f.route).then(r => r.json())).publication.condition).toBe("prepared");
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    const resumed = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(resumed).toMatchObject({ id: view.publication.id, condition: "confirmed", pull: { number: 42 } });
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("reviewed runtime scaffolding cannot be published as Assignment changes", async () => {
  const f = await factoryPublicationFixture();
  try {
    writeFileSync(join(f.run.worktree!, ".saurons-eye-owned-fixture.json"), '{"fixture":true}');
    f.git(["add", ".saurons-eye-owned-fixture.json"], f.run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "owned runtime data"], f.run.worktree!);
    const head = f.git(["rev-parse", "HEAD"], f.run.worktree!).trim(); f.setReviewHead(head);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, { head })).status).toBe(200);
    expect((await f.request(f.route + "/publish", { head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("disabling automatic publication during upload prevents PR creation and retains the uncertain intent", async () => {
  const f = await factoryPublicationFixture();
  try {
    const projectRoute = `/projects/${f.project.id}/configure`;
    await f.request(projectRoute, { auto_publish_pr: true });
    await f.verify();
    f.afterUpload(async () => { await f.request(projectRoute, { auto_publish_pr: false }); });
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect((await f.request(f.route).then(r => r.json())).publication.condition).toBe("uncertain");
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("implementation_complete");
  } finally { await f.close(); }
}, 60_000);

test("a lost PR receipt survives restart, blocks replay and reconciles the same remotely created PR", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.github({ lose_receipt: true });
    const uncertain = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(uncertain).toMatchObject({ condition: "uncertain", pull: null, head: f.head });
    f.restart();
    expect((await f.request(f.route).then(r => r.json())).publication.id).toBe(uncertain.id);
    expect((await f.request(f.route + "/publish", { head: f.head }).then(r => r.json())).condition).toBe("uncertain");
    const confirmed = await f.request(f.route + "/reconcile", {}).then(r => r.json());
    expect(confirmed).toMatchObject({ id: uncertain.id, condition: "confirmed", pull: { number: 42 } });
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.delivery.pull_numbers).toEqual([42]);
  } finally { await f.close(); }
}, 60_000);

test("a separate automatic publication opt-in publishes only after acceptance with passing checks and both reviews", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.request(`/projects/${f.project.id}/configure`, { auto_publish_pr: true });
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(200);
    expect((await f.request(f.route).then(r => r.json())).publication).toMatchObject({ authority: "project", condition: "confirmed", head: f.head });
    expect(f.uploads).toHaveLength(1);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("pr_open");
  } finally { await f.close(); }
}, 60_000);
