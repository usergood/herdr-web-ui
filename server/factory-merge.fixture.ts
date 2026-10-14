import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";

/** Native GitHub responses and calls belong to this fixture, never an owner's account. */
export async function factoryMergeFixture(remote = false, milestone: "merge" | "release" = "merge", githubInitially = true) {
  const root = mkdtempSync(join(tmpdir(), "saurons-merge-gh-"));
  const state = join(root, "responses.json"), log = join(root, "calls.jsonl"), tool = join(root, "gh.mjs");
  writeFileSync(state, "{}");
  writeFileSync(tool, `import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), endpoint = args[1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, scoped: Boolean(process.env.GH_CONFIG_DIR), token: process.env.GITHUB_TOKEN ?? null}) + "\\n");
const data = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
if (data.pause === endpoint) {
  writeFileSync(${JSON.stringify(join(root, "reading"))}, "reading");
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(join(root, "continue"))}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}
const value = endpoint === "user" ? { login: "fictional-owner", id: 1042 } : data[endpoint];
if (value === undefined) { process.stderr.write("Missing owned GitHub response"); process.exit(1); }
process.stdout.write(JSON.stringify(value));
`);
  const f = await factoryDeliveryFixture(remote, false, {}, { ...(githubInitially ? { githubRepository: "fictional/project" } : {}), accountTools: { github: { executable: process.execPath, args: [tool] } } });
  const machine = remote ? "delivery-host" : "local";
  const profile = await f.request(`/machines/${machine}/accounts`, { name: "Delivery fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
  const verified = await f.request(`/machines/${machine}/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
  if (!verified.ok) throw new Error("Owned GitHub account verification failed");
  if (milestone === "release") await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: milestone });
  const run = await f.start();
  const commit = (name: string, content: string) => {
    writeFileSync(join(run.worktree!, name), content); f.git(["add", name], run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", name], run.worktree!);
  };
  commit("findings.md", "Accepted repository findings\n");
  const head = f.git(["rev-parse", "HEAD"], run.worktree!).trim();
  const sha = f.git(["rev-parse", "HEAD:findings.md"], run.worktree!).trim();
  const merge = "a".repeat(40);
  const tip = "c".repeat(40);
  const tree = { sha: "b".repeat(40), truncated: false, tree: [{ path: "findings.md", mode: "100644", type: "blob", sha }] };
  const pull = { number: 12, html_url: "https://github.com/fictional/project/pull/12", state: "closed", merged: true, merge_commit_sha: merge, base: { ref: "main", repo: { full_name: "fictional/project" } }, head: { sha: head } };
  const data: Record<string, unknown> = {
    "repos/fictional/project": { full_name: "fictional/project" },
    "repos/fictional/project/pulls/12": pull,
    "repos/fictional/project/pulls/12/files?per_page=100&page=1": [{ filename: "findings.md", status: "added", sha }],
    [`repos/fictional/project/git/trees/${merge}?recursive=1`]: tree,
    "repos/fictional/project/git/trees/main?recursive=1": tree,
    "repos/fictional/project/branches/main": { name: "main", commit: { sha: tip } },
    [`repos/fictional/project/git/trees/${tip}?recursive=1`]: tree,
    [`repos/fictional/project/compare/${merge}...${tip}`]: { status: "ahead", merge_base_commit: { sha: merge } },
    [`repos/fictional/project/compare/${merge}...main`]: { status: "ahead", merge_base_commit: { sha: merge } },
  };
  const respond = () => writeFileSync(state, JSON.stringify(data)); respond();
  return { ...f, githubRoot: root, machine, profile, run, head, sha, merge, tip, tree, pull, data, respond, commit,
    links: { expected_revision: null, machine_id: machine, account_profile_id: profile.id, pull_numbers: [12] },
    calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; scoped: boolean; token: string | null }),
    close: async () => { await f.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
