import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubScheduleFixture } from "./github-schedules.fixture.ts";

export async function githubIssueBatchFixture() {
  const f = await githubScheduleFixture();
  const tool = join(f.root, "gh.mjs");
  writeFileSync(tool, `import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), endpoint = args[1];
const path = ${JSON.stringify(f.responses)}, data = JSON.parse(readFileSync(path, "utf8"));
appendFileSync(${JSON.stringify(join(f.root, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
const field = name => args.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
const method = args[args.indexOf("--method") + 1];
let result;
if (endpoint === "user") result = { login: "fictional-owner", id: 1042 };
else if (endpoint === "repos/fictional/schedules") result = { full_name: "fictional/schedules" };
else if (endpoint === "repos/fictional/schedules/issues" && method === "POST") {
  const number = 101 + (data.issues?.length ?? 0);
  if (data.fail_create_number === number) { process.stderr.write("Owned fixture has no creation receipt"); process.exit(1); }
  result = { number, node_id: "fictional-batch-" + number, title: field("title"), body: field("body"), html_url: "https://github.com/fictional/schedules/issues/" + number, state: "open", labels: [] };
  data.issues = [...data.issues ?? [], result]; writeFileSync(path, JSON.stringify(data));
  if (data.lose_create_receipt_number === number) { process.stderr.write("Owned fixture lost the creation receipt"); process.exit(1); }
} else if (/issues\\/\\d+$/.test(endpoint)) {
  result = data.issues?.find(issue => endpoint.endsWith("/" + issue.number));
  if (method === "PATCH" && field("body") !== undefined && data.fail_link_number === result.number) { process.stderr.write("Owned fixture did not receive the dependency links"); process.exit(1); }
  if (method === "PATCH" && field("labels[]") !== undefined && data.fail_label_number === result.number) { process.stderr.write("Owned fixture lost the label receipt"); process.exit(1); }
  if (method === "PATCH") {
    if (field("body") !== undefined) result.body = field("body");
    if (field("labels[]") !== undefined) {
      result.labels = args.filter(arg => arg.startsWith("labels[]=")).map(arg => ({ name: arg.slice(9) }));
      if (data.drift_after_label === result.number) data.issues[0].body = "Unreviewed acceptance and missing plan links";
    }
    writeFileSync(path, JSON.stringify(data));
    if (field("labels[]") !== undefined && data.lose_label_receipt_number === result.number) { process.stderr.write("Owned fixture lost the applied label receipt"); process.exit(1); }
  }
} else if (endpoint?.includes("/issues?")) result = endpoint.includes("page=1&") ? data.issues ?? [] : [];
else if (endpoint === "graphql" && args.some(arg => arg.includes("issue(number:"))) result = { data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
else if (endpoint === "graphql") result = { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
else result = {};
process.stdout.write(JSON.stringify(result));
`);
  const projectId = f.route.split("/")[2]!;
  const assignment = (await f.request("/implementations", { title: "Plan independent improvements", description: "Retain the agreed plan", project_id: projectId })).body;
  const route = `/implementations/${assignment.id}/issue-batches`;
  return { ...f, route, githubRoute: f.route, assignment };
}
export const batchProposal = {
  title: "Independent improvements", idempotency_key: "owned-plan-v1", expected_revision: null,
  items: [
    { key: "notes", title: "Keep owner notes", body: "Preserve notes on repeated import.", deliverable: "One Assignment and delivery PR for note preservation", ready_for_agent: true, dependencies: [], plan: { acceptance_criteria: "The owner's notes survive repeated imports.", dependencies: [], testing_seams: ["Authenticated public HTTP/API", "Real browser user journeys"], planning_decisions: ["Keep internal bounded work as Tickets"] } },
    { key: "history", title: "Show retained history", body: "Expose notes in Assignment history.", deliverable: "One Assignment and delivery PR for history access", ready_for_agent: true, dependencies: [{ key: "notes", requires: "merge" }], plan: { acceptance_criteria: "The owner can read retained notes in history.", dependencies: [], testing_seams: ["Authenticated public HTTP/API", "Real browser user journeys"], planning_decisions: ["Start after note preservation merges"] } },
  ],
};
