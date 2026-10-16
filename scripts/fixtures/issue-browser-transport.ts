/** Shared transport for owned GitHub source and planning browser scenarios. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function issueBrowserCli(root: string, responses: string): string {
  const cli = join(root, "gh.mjs");
  writeFileSync(cli, `import { readFileSync } from "node:fs";
const endpoint = process.argv[3];
const data = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
const issueNumber = Number(process.argv.find(arg => arg.startsWith("query="))?.match(/issue[(]number:([0-9]+)/)?.[1]);
const issue = data.issues?.find(issue => issue.number === issueNumber || endpoint?.endsWith("/" + issue.number)) ?? data.issues?.[0];
const result = endpoint === "user" ? { login: "fictional-owner", id: 1042 } : endpoint?.includes("/branches/") ? { name: "main", commit: { sha: "f".repeat(40) } } : endpoint?.includes("/compare/") ? { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } } : endpoint?.includes("/pulls/") ? data.delivery_pull : endpoint?.includes("/events?") ? [] : endpoint?.includes("/dependencies/blocked_by") ? data.dependencies?.[endpoint.split("/issues/")[1].split("/")[0]] ?? [] : endpoint?.match(/issues[/][0-9]+$/) ? issue : endpoint?.includes("/issues?") ? data.issues ?? { error: "Incomplete inventory" } : endpoint === "graphql" && Number.isSafeInteger(issueNumber) && process.argv.some(arg => arg.includes("comments(first:")) ? { data: { repository: { issue: { comments: { nodes: data.comments ?? [], pageInfo: { hasNextPage: false, endCursor: null } } } } } } : endpoint === "graphql" ? { data: { repository: { issue: issue ? { id: issue.node_id, title: issue.title, body: issue.body, state: issue.state.toUpperCase(), updatedAt: issue.updated_at, createdAt: "2026-09-30T12:00:00Z", lastEditedAt: null } : null, pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } : {};
console.log(JSON.stringify(result));\n`);
  return cli;
}

export const factoryBrowserHeaders = { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };

export function factoryBrowserPost(origin: string) {
  return async (path: string, body: unknown) => {
    const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers: factoryBrowserHeaders, body: JSON.stringify(body) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
}
