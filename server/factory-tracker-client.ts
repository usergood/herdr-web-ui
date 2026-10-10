/** Written into app-owned worktrees. Node or Bun can execute this native tracker adapter. */
export const factoryTrackerClient = String.raw`import { readFileSync } from "node:fs";
const [command, identity, json] = process.argv.slice(2);
const access = JSON.parse(readFileSync(".saurons-eye-access.json", "utf8"));
const routes = { contract: ["GET", "contract"], question: ["POST", "question"], consume: ["POST", "consume"], worker: ["POST", "worker"], checks: ["POST", "checks"], artifact: ["POST", "artifact"], specification: ["POST", "specification"], tickets: ["POST", "tickets"], proposal: ["POST", "proposal"] };
let route = routes[command]; let body = json ? JSON.parse(json) : {};
if (command === "ticket") route = ["GET", "ticket/" + encodeURIComponent(identity)];
if (["refresh", "reconcile", "check", "integrate", "stop", "review-evidence"].includes(command)) route = ["POST", "worker/" + encodeURIComponent(identity) + "/" + command];
if (!route) throw new Error("Use contract, ticket <id>, question/consume/worker/artifact <unused> <JSON>, checks, or a worker action <id>");
const response = await fetch(access.url + "/" + route[1], { method: route[0], headers: { authorization: "Bearer " + access.token, "content-type": "application/json", "x-herdr-factory": "1" }, ...(route[0] === "GET" ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(360000) });
const result = await response.json();
if (!response.ok) { process.stderr.write(JSON.stringify(result.error) + "\n"); process.exitCode = 1; }
else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
`;
