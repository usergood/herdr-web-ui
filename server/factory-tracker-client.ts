/** Written into app-owned worktrees. Node or Bun can execute this native tracker adapter. */
export const factoryTrackerGuide = `Use only this Run's app-native Other tracker. All JSON fields are snake_case.
Read: bun .saurons-eye-tracker.mjs contract; bun .saurons-eye-tracker.mjs ticket <ticket_id>.
Allocate: bun .saurons-eye-tracker.mjs worker unused '{"role":"implementer","ticket_id":"<frontier ticket ID>","idempotency_key":"<stable key, letters/digits/underscore/hyphen, at most 128>","shared_paths":[]}'.
For rework include "review_batch_id":"<sent batch ID>" and the original accepted ticket_id.
Independent review roles are "standards" and "spec"; omit ticket_id, use a distinct stable idempotency_key.
Worker actions: bun .saurons-eye-tracker.mjs reconcile|refresh|check|integrate|stop|review-evidence <worker_id>.
A needs_you worker with a ready-candidate reason is quiescent, not completed: explicitly reconcile, refresh, check and integrate. A blocked native prompt or unanswered question requires the owner. Idle alone never completes a Ticket.
Final known checks: bun .saurons-eye-tracker.mjs checks. Owner alone resolves findings and accepts the reviewed head.
Questions: bun .saurons-eye-tracker.mjs question unused '{"question":"<actual unresolved choice>"}'. Wait for actual owner answers.
Consume exact answered context: bun .saurons-eye-tracker.mjs consume unused '{"revision":"<contract.question_revision>","worker_id":"<this worker ID>"}'. The coordinator omits worker_id.
Proposals: specification unused '{"content":"..."}', tickets unused '{"specification_id":"...","tickets":[{"key":"t1","title":"...","acceptance":"...","dependencies":[]}]}', or proposal unused '{"proposal":"..."}' through the same command prefix; only the selected action permits each proposal.
Never guess request fields, bypass reservations, approve your own work or publish. An uncertain outcome retains ownership; do not replay.`;
export const factoryTrackerClient = String.raw`import { readFileSync } from "node:fs";
const [command, identity, json] = process.argv.slice(2);
if (command === "help") { process.stdout.write(${JSON.stringify(factoryTrackerGuide)} + "\n"); process.exit(0); }
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
