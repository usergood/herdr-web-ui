import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

/** Owned native GitHub responses, exercised only through the server's HTTP surface. */
export async function githubScheduleFixture() {
  const root = mkdtempSync(join(tmpdir(), "saurons-schedules-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "Fictional schedule Project\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/fictional/schedules.git"]);
  const responses = join(root, "responses.json"), log = join(root, "calls.jsonl"), tool = join(root, "gh.mjs");
  writeFileSync(responses, "{}"); writeFileSync(log, "");
  writeFileSync(tool, `import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), data = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8")), endpoint = args[1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (endpoint === "graphql") {
  if (data.pause) {
    writeFileSync(${JSON.stringify(join(root, "reading"))}, "reading");
    const deadline = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(join(root, "continue"))}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (data.fail) { process.stderr.write("Owned GitHub fixture unavailable"); process.exit(1); }
}
const result = endpoint === "user" ? { login: "fictional-owner", id: 1042 }
  : endpoint === "graphql" ? { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }
  : endpoint?.includes("/issues?") ? [] : endpoint === "repos/fictional/schedules" ? { full_name: "fictional/schedules", default_branch: "main" } : {};
process.stdout.write(JSON.stringify(result));
`);
  let now = Date.parse("2026-10-14T08:59:00Z");
  let poll: () => Promise<void> = async () => {};
  const options = { port: 0, token: "", tailscaleOwner: null, machines: false, stateDir: join(root, "state"), factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [tool] } }, scheduleTiming: { now: () => now, subscribe: (run: () => Promise<void>) => { poll = run; return () => { poll = async () => {}; }; } } } };
  let app = createServer(options);
  const origin = () => `http://localhost:${app.port}`;
  const headers = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-factory": "1" };
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin() + "/api/factory" + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const profile = (await request("/machines/local/accounts", { name: "Schedule fixture", service: "github", expected_login: "fictional-owner" })).body;
  await request(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
  const project = (await request("/projects", { name: "Schedule fixture", path: repo, provider: "codex", machine_id: "local", tracker: "app" })).body;
  const route = `/projects/${project.id}/github`;
  const policy = { expected_revision: null, repository: "fictional/schedules", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Owned schedule fixture", poll_minutes: 5 };
  return { root, route, policy, advance: (value: string) => { now = Date.parse(value); }, tick: () => poll(), restart: () => { app.stop(); app = createServer(options); }, request, origin, headers, responses, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]), close: () => { app.stop(); rmSync(root, { recursive: true, force: true }); } };
}
