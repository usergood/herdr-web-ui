import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";

/** Owned GitHub and Git upload effects, observed through public requests. */
export async function factoryPublicationFixture(options: { checks?: string[][] } = {}) {
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
  const f = await factoryDeliveryFixture(true, true, { ...{
    pushBranch: async (upload: typeof uploads[number]) => {
      uploads.push(upload);
      const data = JSON.parse(readFileSync(state, "utf8")); data.head = upload.head;
      writeFileSync(state, JSON.stringify(data));
      await uploadEffect();
    },
  } }, { githubRepository: "fictional/project", accountTools: { github: { executable: process.execPath, args: [tool] } } });
  const profile = await f.request("/machines/delivery-host/accounts", { name: "Publication fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
  if (!(await f.request(`/machines/delivery-host/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).ok) throw new Error("Owned publication account verification failed");
  await f.request(`/projects/${f.project.id}/configure`, { account_bindings: { "delivery-host": { github: profile.id } }, checks: options.checks ?? [["git", "status", "--porcelain"]] });
  const run = await f.start();
  const commit = () => {
    writeFileSync(join(run.worktree!, "feature.md"), "Approved Assignment change\n");
    f.git(["add", "feature.md"], run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "approved change"], run.worktree!);
    const head = f.git(["rev-parse", "HEAD"], run.worktree!).trim(); f.setReviewHead(head); return head;
  };
  const head = commit();
  const verify = async () => {
    const checked = await f.request(`/runs/${run.id}/checks`, {});
    if (!checked.ok || (await checked.json()).condition !== "passed") throw new Error("Owned publication checks failed");
    for (const role of ["standards", "spec"]) {
      const worker = await f.request(`/runs/${run.id}/workers`, { role, idempotency_key: `publication-${role}` }).then(r => r.json());
      if (!(await f.request(`/runs/${run.id}/workers/${worker.id}/review-evidence`, {})).ok) throw new Error("Owned independent publication review failed");
    }
  };
  const legacyPolicy = async () => {
    const local = await f.request("/machines/local/accounts", { name: "Coordinator fixture", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
    await f.request(`/machines/local/accounts/${local.id}/verify`, { expected_revision: local.revision });
    return f.request(`/projects/${f.project.id}/github/configure`, { expected_revision: null, repository: "fictional/project", account_profile_id: local.id, sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: true, auto_implement: true, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "Owned PR automation fixture", poll_minutes: 15 });
  };
  return { ...f, get app() { return f.app; }, profile, run, head, uploads, verify, legacyPolicy, route: `/runs/${run.id}/publication`, afterUpload: (effect: () => Promise<void>) => { uploadEffect = effect; },
    github: (change: Record<string, unknown>) => { const data = JSON.parse(readFileSync(state, "utf8")); writeFileSync(state, JSON.stringify({ ...data, ...change })); },
    calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; scoped: boolean }),
    close: async () => { await f.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
