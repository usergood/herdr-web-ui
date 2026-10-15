/** Disposable public HTTP/browser fixture; the CLI never contacts GitHub. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/index.ts";

export function githubQueueFixture(execution = false) {
  const root = mkdtempSync(join(tmpdir(), "queue-fixture-"));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "Fictional Project\n");
  for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], ["remote", "add", "origin", "https://github.com/fictional/project.git"]]) execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const responses = join(root, "responses.json");
  const cli = join(root, "gh.mjs");
  const syncGate = join(root, "sync-gate"); const syncEntered = join(root, "sync-entered");
  const issue = { repository_url: "https://api.github.com/repos/fictional/project", number: 1, node_id: "fictional-contract-issue", title: "Fictional scope", body: "## Scope\nShow a greeting.\n## Acceptance criteria\nShow hello.\n## Dependencies\nNone.\n## Testing seams\nPublic HTTP and real browser journeys.", labels: [{ name: "ready-for-agent" }], state: "open", updated_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/fictional/project/issues/1" };
  const save = (issues = [issue], fail = false, dependencies: Record<string, typeof issue[]> = {}, trusted = false) => writeFileSync(responses, JSON.stringify({ issues, fail, dependencies, trusted }));
  save();
  writeFileSync(cli, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const data = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8")); const endpoint = process.argv[3];
if (endpoint.includes("/issues?") && existsSync(${JSON.stringify(syncGate)})) {
  writeFileSync(${JSON.stringify(syncEntered)}, "entered"); const deadline = Date.now() + 8000;
  while (existsSync(${JSON.stringify(syncGate)})) { if (Date.now() > deadline) throw new Error("Owned GitHub gate timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const number = Number(process.argv.find(arg => arg.startsWith("query="))?.match(/issue[(]number:([0-9]+)/)?.[1] ?? endpoint.match(/issues[/]([0-9]+)/)?.[1]);
const issue = data.issues.find(issue => issue.number === number) ?? data.issues[0];
console.log(JSON.stringify(endpoint === "user" ? {login:"fictional-owner",id:1042} : endpoint.includes("/dependencies/blocked_by") ? data.dependencies[number] ?? [] : endpoint.includes("/issues?") ? data.fail ? {} : data.issues : endpoint.includes("/events?") ? data.trusted ? [{id:number,event:"labeled",label:{name:"ready-for-agent"},actor:{login:"fictional-owner",id:1042},created_at:issue.updated_at}] : [] : endpoint.includes("/issues/") ? issue : endpoint === "graphql" ? {data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}},issue:{id:issue.node_id,title:issue.title,body:issue.body,state:issue.state.toUpperCase(),createdAt:"2026-09-30T12:00:00Z",updatedAt:issue.updated_at,lastEditedAt:null}}}} : {full_name:"fictional/project"}));`);
  // Owned remote native transport: no CLI agent, worktree or live herdr is launched.
  let checkout: unknown; let capabilities: unknown;
  let executionHandler: ((request: Request) => Promise<Response | null>) | null = null;
  let launchOutcome: "working" | "failed" | "lost" = "working";
  const trackerAccess = new Map<string, { token: string }>();
  const nativeRuns = new Map<string, Record<string, unknown>>();
  const launches: string[] = [];
  let hostOffline = false;
  let launchGate: (() => Promise<void>) | null = null;
  let capabilityGate: (() => Promise<void>) | null = null;
  const host = execution ? Bun.serve({ port: 0, async fetch(request) {
    const handled = await executionHandler?.(request.clone());
    if (handled) return handled;
    const path = new URL(request.url).pathname;
    if (hostOffline) return Response.json({ error: { code: "offline", message: "Fictional host unavailable" } }, { status: 503 });
    if (path.endsWith("/capabilities")) { await capabilityGate?.(); return Response.json(capabilities); }
    if (path.endsWith("/inspect")) return Response.json(checkout);
    if (path.endsWith("/operations/head")) return Response.json({ head: (checkout as { head: string }).head });
    if (path.endsWith("/launch")) {
      const { run, access } = await request.json() as { run: Record<string, unknown>; access: { token: string } };
      trackerAccess.set(run.id as string, access);
      launches.push(run.id as string);
      const observed = { ...run, condition: launchOutcome === "failed" ? "failed" : "working", waiting_reason: launchOutcome === "failed" ? "Fictional failure before native allocation" : null, worktree: repo, branch: "fictional-run" };
      nativeRuns.set(run.id as string, observed);
      await launchGate?.();
      return launchOutcome === "lost" ? Response.json({ error: { code: "lost_response", message: "Fictional response loss after acceptance" } }, { status: 503 }) : Response.json(observed);
    }
    const reconcile = /[/]runs[/]([^/]+)[/]reconcile$/.exec(path);
    if (reconcile && nativeRuns.has(reconcile[1]!)) return Response.json(nativeRuns.get(reconcile[1]!)!);
    return Response.json({ error: { code: "fixture_operation_unavailable", message: "No real native operation in this fixture" } }, { status: 409 });
  } }) : null;
  const options = { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } }, ...(host ? { machineEndpoint: (id: string) => id === "fictional-host" ? { url: `http://localhost:${host.port}`, token: "fictional-host" } : undefined } : {}) };
  let app = createServer({ port: 0, stateDir: root, machines: false, token: "fixture-owner", factory: options });
  let origin = `http://localhost:${app.port}`;
  const headers = { authorization: "Bearer fixture-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown, extra: Record<string, string> = headers) => fetch(origin + "/api/factory" + path, { method: "POST", headers: extra, body: JSON.stringify(body) });
  const get = (path: string) => fetch(origin + "/api/factory" + path, { headers });
  async function json(path: string, body?: unknown): Promise<any> {
    const response = body === undefined ? await get(path) : await post(path, body);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  async function setup() {
    const account = await json("/machines/local/accounts", { name: "Fictional", service: "github", expected_login: "fictional-owner" });
    await json(`/machines/local/accounts/${account.id}/verify`, { expected_revision: account.revision });
    let project = await json("/projects", { name: "Queue fixture Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
    if (execution) {
      const local = (await json("")).checkouts.find((entry: any) => entry.project_id === project.id);
      checkout = { path: local.path, repository: local.repository, head: local.head, branch: local.branch, instructions: local.instructions };
      capabilities = await json("/providers");
      for (const provider of (capabilities as any).providers) Object.assign(provider, { installed: true, skills_verified: true, factory_ready: true, reasons: [] });
      await json(`/projects/${project.id}/checkouts`, { machine_id: "fictional-host", path: repo });
      project = await json(`/projects/${project.id}/configure`, { machine_id: "fictional-host", checks: [[process.execPath, "--version"]], permissions: "Owned fictional execution only" });
    }
    const route = `/projects/${project.id}/github`;
    const configuration = { expected_revision: null, repository: "fictional/project", account_profile_id: account.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Fictional standards", poll_minutes: 5 };
    await json(route + "/configure", configuration);
    const readiness = await json(route + "/readiness", { expected_revision: null, account_profile_id: account.id, triage_labels: {}, blocked_label: "blocked" });
    return { account, project, route, readiness, configuration };
  }
  function restart(beforeStart?: () => void) { app.stop(); beforeStart?.(); app = createServer({ port: 0, stateDir: root, machines: false, token: "fixture-owner", factory: options }); origin = `http://localhost:${app.port}`; }
  function holdCapabilities() {
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    capabilityGate = async () => { entered(); await gate; };
    return { waiting, release: () => { capabilityGate = null; release(); } };
  }
  function holdLaunch() {
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    launchGate = async () => { entered(); await gate; };
    return { waiting, release: () => { launchGate = null; release(); } };
  }
  function holdSync() {
    writeFileSync(syncGate, "hold"); rmSync(syncEntered, { force: true });
    const waiting = (async () => { const deadline = Date.now() + 5000; while (!existsSync(syncEntered)) { if (Date.now() > deadline) throw new Error("Owned GitHub observation did not reach its gate"); await new Promise(resolve => setTimeout(resolve, 10)); } })();
    return { waiting, release: () => rmSync(syncGate, { force: true }) };
  }
  const tracker = async (runId: string) => {
    const access = trackerAccess.get(runId); if (!access) throw new Error("Unknown fictional tracker credential");
    const response = await fetch(origin + `/api/factory-agent/${runId}/contract`, { headers: { authorization: `Bearer ${access.token}` } });
    if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<any>;
  };
  return { setExecutionHandler(handler: typeof executionHandler) { executionHandler = handler; }, tracker, failNativeRun: (id: string) => { const run = nativeRuns.get(id); if (!run) throw new Error("Unknown fictional Run"); nativeRuns.set(id, { ...run, condition: "failed", waiting_reason: "Fictional native failure" }); }, setHostOffline: (offline: boolean) => { hostOffline = offline; }, holdLaunch, setLaunchOutcome: (outcome: typeof launchOutcome) => { launchOutcome = outcome; }, launches, root, issue, save, post, get, json, setup, restart, headers, holdCapabilities, holdSync, get origin() { return origin; }, close() { app.stop(); host?.stop(true); rmSync(root, { recursive: true, force: true }); } };
}
