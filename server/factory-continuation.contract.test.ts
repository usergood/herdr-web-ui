import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, type WorkspaceCreateResult } from "./herdr/client.ts";
import type { FactoryRun } from "../shared/protocol.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "saurons-continuation-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned continuation fixture\n");
  for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const owned: string[] = [];
  const app = createServer({ port: 0, stateDir: join(root, "state"), machines: false, factory: { accountDiscoveryHome: root, native: {
    version: async () => "owned-continuation-fixture",
    createWorkspace: async options => { const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; },
    startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); },
  } } });
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const project = await request("/projects", { name: "Continuation Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
  const idea = await request("/implementations", { title: "Continue approved work", description: "", project_id: project.id }).then(r => r.json());
  const prefix = `/implementations/${idea.id}`;
  const start = (action: string, key: string): Promise<FactoryRun> => request(`${prefix}/runs`, { action, idempotency_key: key }).then(r => r.json());
  const agent = (run: FactoryRun, path: string, body?: unknown) => {
    const access = JSON.parse(readFileSync(join(run.worktree!, ".saurons-eye-access.json"), "utf8"));
    return fetch(`${access.url}/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { app, repo, prefix, request, start, agent, close: async () => { app.stop(); for (const id of owned) await workspaceClose(id).catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
}

describe("continuing approved workflow steps", () => {
  it("confirms shared understanding once without inventing text answers or approving obsolete probes", async () => {
    const f = await fixture();
    try {
      const old = await f.start("verify-provider", "old-confirmation-probe");
      const obsolete = await f.agent(old, "question", { question: "Confirm the old probe?" }).then(r => r.json());
      await f.request(`/runs/${old.id}/stop`, {});
      const run = await f.start("grill-with-docs", "shared-understanding");
      const text = await f.agent(run, "question", { question: "Which result?" }).then(r => r.json());
      const confirmation = await f.agent(run, "question", { question: "Confirm the agreed scope?", answer_kind: "confirmation" }).then(r => r.json());
      let detail = await f.request(f.prefix).then(r => r.json());
      const approval = () => f.request(`${f.prefix}/approvals`, { kind: "shared_understanding", revision: detail.question_revision, scope: "The owner's agreed scope" });
      expect((await approval()).status).toBe(409);
      await f.request(`${f.prefix}/questions/${text.id}/answer`, { revision: text.revision, answer: "The retained workflow repair" });
      detail = await f.request(f.prefix).then(r => r.json());
      const accepted = await approval();
      expect(accepted.status).toBe(201);
      const receipt = await accepted.json();
      detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.questions.find((q: { id: string }) => q.id === confirmation.id).answer).toBe("Confirmed");
      expect(detail.questions.find((q: { id: string }) => q.id === obsolete.id).answer).toBeNull();
      expect(receipt.revision).toBe(detail.question_revision);
      expect((await f.agent(run, "consume", { revision: receipt.revision })).status).toBe(200);
    } finally { await f.close(); }
  }, 60_000);

  it("retains an ordinary Work result for review while continuing without closing its chat or accepting delivery", async () => {
    const f = await fixture();
    try {
      const work = await f.start("work", "bootstrap-repair");
      writeFileSync(join(work.worktree!, "repair.txt"), "Preserve this repair for review\n");
      const continued = await f.request(`${f.prefix}/continue`, { action: "verify-provider", run_id: work.id, idempotency_key: "continue-repair", allow_partial_handoff: true });
      expect(continued.status, JSON.stringify(await continued.clone().json())).toBe(202);
      expect(readFileSync(join(work.worktree!, "repair.txt"), "utf8")).toBe("Preserve this repair for review\n");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === work.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.implementation.stage).not.toBe("done"); expect(detail.implementation.outcome).toBe("none");
      expect(detail.approvals.some((approval: { kind: string }) => approval.kind === "review")).toBe(false);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps product understanding approved when a native probe is abandoned", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "product-plan");
      const question = await f.agent(plan, "question", { question: "Which product should we improve?" }).then(r => r.json());
      await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The fictional receipt preview." });
      const before = await f.request(f.prefix).then(r => r.json());
      expect((await f.request(`${f.prefix}/approvals`, { kind: "shared_understanding", revision: before.question_revision, scope: "The fictional receipt preview." })).status).toBe(201);
      await f.request(`/runs/${plan.id}/stop`, {});
      const probe = await f.start("verify-provider", "abandoned-probe");
      await f.agent(probe, "question", { question: "Confirm this native probe?" });
      await f.request(`/runs/${probe.id}/stop`, {});
      const after = await f.request(f.prefix).then(r => r.json());
      expect(after.question_revision).toBe(before.question_revision);
      expect(after.question_context.questions.map((q: { id: string }) => q.id)).toEqual([question.id]);
      const continued = await f.request(`${f.prefix}/continue`, { action: "to-spec", run_id: null, idempotency_key: "continue-product" });
      expect(continued.status).toBe(202);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps a working chat and blocks continuation while a proposal or approval is missing", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "planning");
      await herdrRpc("pane.report_agent", { pane_id: plan.pane_id, source: "manual", agent: "codex", state: "working" });
      const busy = await f.request(`${f.prefix}/continue`, { action: "to-spec", run_id: plan.id, idempotency_key: "busy", allow_partial_handoff: true });
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe("step_not_ready");
      const unapproved = await f.request(`${f.prefix}/continue`, { action: "implement-spec", run_id: plan.id, idempotency_key: "unapproved" });
      expect(unapproved.status).toBe(409); expect((await unapproved.json()).error.code).toBe("scope_unaccepted");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === plan.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json()); expect(detail.runs.length).toBe(1);
    } finally { await f.close(); }
  }, 60_000);

  it("continues resting planning without closing its chat and reuses a repeated Continue request", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "planning");
      const body = { action: "to-spec", run_id: plan.id, idempotency_key: "continue-plan", allow_partial_handoff: true };
      const response = await f.request(`${f.prefix}/continue`, body);
      const next = await response.json();
      expect(response.status, JSON.stringify(next)).toBe(202); expect(next.action).toBe("to-spec");
      const repeated = await f.request(`${f.prefix}/continue`, body).then(r => r.json());
      expect(repeated.id).toBe(next.id);
      const changed = await f.request(`${f.prefix}/continue`, { ...body, action: "to-tickets" });
      expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("continuation_conflict");
      const snapshot = await sessionSnapshot();
      expect(snapshot.panes.some(pane => pane.pane_id === plan.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.runs.find((run: FactoryRun) => run.id === plan.id).condition).toBe("completed");
      expect(detail.implementation.stage).not.toBe("done");
    } finally { await f.close(); }
  }, 60_000);

  it("allows a replacement verification to consume its own answers without answering an obsolete probe", async () => {
    const f = await fixture();
    try {
      const first = await f.start("verify-provider", "first-probe");
      const oldQuestion = await f.agent(first, "question", { question: "Confirm the first native probe?" }).then(r => r.json());
      expect((await f.request(`/runs/${first.id}/stop`, {})).status).toBe(200);
      const second = await f.start("verify-provider", "second-probe");
      const question = await f.agent(second, "question", { question: "Confirm the replacement native probe?" }).then(r => r.json());
      expect((await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed for the replacement probe." })).status).toBe(200);
      const contract = await f.agent(second, "contract").then(r => r.json());
      expect(contract.questions.map((q: { id: string }) => q.id)).toEqual([question.id]);
      expect((await f.agent(second, "consume", { revision: contract.question_revision })).status).toBe(200);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.questions.find((q: { id: string }) => q.id === oldQuestion.id).answer).toBeNull();
      // An owned stand-in must still never certify a genuine native provider.
      const verification = await f.request(`/runs/${second.id}/verify-provider`, {});
      expect(verification.status).toBe(409);
      expect((await verification.json()).error.code).toBe("native_evidence_required");
    } finally { await f.close(); }
  }, 60_000);
});
