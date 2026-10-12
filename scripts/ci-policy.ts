/** Public CI decision command. Inputs are GitHub's event file and NUL-separated changed paths. */
import { appendFileSync, readFileSync } from "node:fs";

try {
  const eventName = process.env["GITHUB_EVENT_NAME"];
  if (!["pull_request", "push", "workflow_dispatch", "workflow_call"].includes(eventName ?? "")) throw new Error("Unsupported CI event");
  const eventPath = process.env["GITHUB_EVENT_PATH"], output = process.env["GITHUB_OUTPUT"], paths = process.argv[2];
  if (!eventPath || !output || !paths) throw new Error("CI event, changed paths and output are required");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { draft?: boolean } };
  const full = process.env["CI_FULL"] ?? "false";
  if (full !== "true" && full !== "false") throw new Error("CI_FULL must be true or false");
  const runFull = full === "true";
  const changed = readFileSync(paths, "utf8").split("\0").filter(Boolean);
  const docsOnly = changed.length > 0 && changed.every(path => path.startsWith("docs/") || /\.(md|txt)$/i.test(path) || path === "LICENSE" || path.startsWith(".github/ISSUE_TEMPLATE/"));
  const draft = eventName === "pull_request" && event.pull_request?.draft === true;
  appendFileSync(output, `run_fast=${runFull || !docsOnly}\nrun_full=${runFull}\ndraft=${draft}\n`, { mode: 0o600 });
} catch (error) {
  console.error(error instanceof Error ? error.message : "CI policy failed");
  process.exitCode = 1;
}
