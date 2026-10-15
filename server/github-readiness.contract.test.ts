import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import type { ProjectGitHubOverview } from "../shared/github-project.ts";
import type { ProjectReadinessPolicy } from "../shared/github-readiness.ts";

test("readiness endpoints retain their public contract and require explicit owner controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "readiness-contract-"));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "Fictional Project\n");
  for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], ["remote", "add", "origin", "https://github.com/fictional/project.git"]]) execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const cli = join(root, "gh.mjs");
  const issue = { number: 1, node_id: "fictional-contract-issue", title: "Fictional scope", body: "Plan: add example. Acceptance: public behavior. Dependencies: none. Testing seams: public HTTP.", labels: [{ name: "ready-for-agent" }], state: "open", updated_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/fictional/project/issues/1" };
  writeFileSync(cli, `const issue = ${JSON.stringify(issue)}; const endpoint = process.argv[3]; console.log(JSON.stringify(endpoint === "user" ? {login:"fictional-owner",id:1042} : endpoint.includes("/dependencies/blocked_by") ? [] : endpoint.includes("/issues?") ? [issue] : endpoint.includes("/events?") ? [] : endpoint.includes("/issues/") ? issue : endpoint === "graphql" ? {data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}},issue:{id:issue.node_id,title:issue.title,body:issue.body,state:"OPEN",createdAt:"2026-09-30T12:00:00Z",updatedAt:issue.updated_at,lastEditedAt:null}}}} : {full_name:"fictional/project"}));`);
  const app = createServer({ port: 0, stateDir: root, machines: false, token: "fixture-owner", factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } });
  const origin = `http://localhost:${app.port}`;
  const headers = { authorization: "Bearer fixture-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown, extra: Record<string, string> = headers) => fetch(origin + "/api/factory" + path, { method: "POST", headers: extra, body: JSON.stringify(body) });
  try {
    const account = await (await post("/machines/local/accounts", { name: "Fictional", service: "github", expected_login: "fictional-owner" })).json();
    await post(`/machines/local/accounts/${account.id}/verify`, { expected_revision: account.revision });
    const project = await (await post("/projects", { name: "Contract Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" })).json();
    const route = `/projects/${project.id}/github`;
    await post(route + "/configure", { expected_revision: null, repository: "fictional/project", account_profile_id: account.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: ["fictional-reviewer"], required_checks: [], review_context: "Fictional standards", poll_minutes: 5 });
    const config = { expected_revision: null, account_profile_id: account.id, triage_labels: {}, blocked_label: "blocked" };
    for (const path of ["/readiness", "/issues/1/approve", "/issues/1/prepare", "/issues/1/delivery"]) {
      const refused = await post(route + path, config, { ...headers, "x-herdr-machine": "" });
      expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: { code: "invalid_origin", message: "Use GitHub controls from this app" } });
      expect((await post(route + path, config, { ...headers, origin: "https://fictional.invalid" })).status).toBe(403);
    }
    const response = await post(route + "/readiness", config); expect(response.status).toBe(200);
    const policy = await response.json() as ProjectReadinessPolicy;
    expect(policy).toMatchObject({ project_id: project.id, repository: "fictional/project", owner: { login: "fictional-owner", account_id: "1042" }, triage_labels: { "ready-for-agent": "ready-for-agent" }, blocked_label: "blocked" });
    const synced = await (await post(route + "/sync", {})).json() as ProjectGitHubOverview;
    const coverage = { source_revision: synced.sources[0]!.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null };
    const linked = await post(route + "/issues/1/delivery", coverage);
    expect(linked.status).toBe(200);
    expect((await linked.json() as ProjectGitHubOverview).sources[0]!.delivery).toMatchObject({ source_revision: coverage.source_revision, target_branch: "main", intended_prs: coverage.intended_prs });
    const staleCoverage = await post(route + "/issues/1/delivery", coverage);
    expect(staleCoverage.status).toBe(409);
    expect(await staleCoverage.json()).toEqual({ error: { code: "delivery_changed", message: "Refresh the issue and its intended coverage before linking delivery" } });
    expect(synced.sources[0]!.readiness).toMatchObject({ eligible: false, blockers: ["evidence_missing"], approval: null });
    const approved = await post(route + "/issues/1/approve", { source_revision: synced.sources[0]!.revision, policy_revision: policy.revision }); expect(approved.status).toBe(200);
    expect((await approved.json() as ProjectGitHubOverview).sources[0]!.readiness).toMatchObject({ eligible: true, blockers: [], approval: { provenance: "app_owner", source_revision: synced.sources[0]!.revision, policy_revision: policy.revision } });
    const prepare = await post(route + "/issues/1/prepare", { source_revision: synced.sources[0]!.revision });
    expect(prepare.status).toBe(200);
    const planning = (await prepare.json() as ProjectGitHubOverview).sources[0]!.planning;
    expect(planning).toMatchObject({ condition: "needs_you", origin: "issue_body", content: issue.body, source_revision: synced.sources[0]!.revision, authorization: { checks_required: true, independent_reviews: ["standards", "spec"], approval: { provenance: "app_owner" } } });
    expect(planning!.question_ids.length).toBeGreaterThan(0);
    const detail = await fetch(origin + `/api/factory/implementations/${synced.sources[0]!.implementation_id}`, { headers }).then(response => response.json());
    expect(detail.runs).toEqual([]); expect(detail.implementation.outcome).toBe("none");
  } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
});
