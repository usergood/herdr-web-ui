import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import type { FactoryQuestion, FactoryRun, NativeConversationSnapshot } from "../shared/protocol.ts";

const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-answers-"));
  const store = new FactoryStore(root);
  const workflow = new FactoryWorkflow(store);
  const run = { id: "current", implementation_id: "idea", action: "work" } as FactoryRun;
  store.put("implementations", { id: "idea", stage: "inbox" });
  const question = (id: string, second: number, extra: Partial<FactoryQuestion> = {}) => store.put("questions", { ...store.record(), id, implementation_id: "idea", run_id: run.id, question: id, revision: id, answer: null, created_at: time(second), ...extra }, "idea");
  const snapshot = (seconds: number[], extra: Partial<NativeConversationSnapshot> = {}) => ({ ...store.record(), run_id: run.id, sequence: 0, source_id: "verified-native", version: "v1", cursor: null, turns: seconds.map(second => ({ role: "user", ts: time(second), parts: [{ kind: "text", text: `Owner reply ${second}` }] })), ...extra }) as NativeConversationSnapshot;
  return { store, workflow, run, question, snapshot, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("verified native answer retention", () => {
  it("saves an unambiguous reply once without granting an approval or touching other Runs", () => {
    const f = fixture();
    try {
      f.question("scope", 1); f.question("other", 1, { run_id: "other-run" });
      f.workflow.retainNativeAnswers(f.run, f.snapshot([2]), true);
      expect(f.store.get<FactoryQuestion>("questions", "scope")?.answer).toBe("Owner reply 2");
      expect(f.store.get<FactoryQuestion>("questions", "other")?.answer).toBeNull();
      expect(f.store.list("approvals")).toHaveLength(0);
      f.workflow.retainNativeAnswers(f.run, f.snapshot([3]), true);
      expect(f.store.get<FactoryQuestion>("questions", "scope")?.answer).toBe("Owner reply 2");
    } finally { f.close(); }
  });

  it("keeps ambiguous, truncated and untimed evidence pending", () => {
    const f = fixture();
    try {
      f.question("scope", 1);
      for (const snapshot of [f.snapshot([2, 3]), f.snapshot([2], { cursor: "older-page" }), f.snapshot([2], { turns: [{ role: "user", ts: null, parts: [{ kind: "text", text: "Unknown time" }] }] })]) {
        f.workflow.retainNativeAnswers(f.run, snapshot, true);
        expect(f.store.get<FactoryQuestion>("questions", "scope")?.answer).toBeNull();
      }
    } finally { f.close(); }
  });

  it("never treats a native reply as shared-understanding confirmation", () => {
    const f = fixture();
    try {
      f.question("confirmation", 1, { answer_kind: "confirmation" });
      f.workflow.retainNativeAnswers(f.run, f.snapshot([2]), true);
      expect(f.store.get<FactoryQuestion>("questions", "confirmation")?.answer).toBeNull();
      expect(f.store.list("approvals")).toHaveLength(0);
    } finally { f.close(); }
  });

  it("keeps replies pending when two unanswered questions overlap", () => {
    const f = fixture();
    try {
      f.question("database", 1); f.question("automatic-start", 2);
      const snapshot = f.snapshot([3]);
      snapshot.turns[0]!.parts = [{ kind: "text", text: "For the database question, use SQLite" }];
      f.workflow.retainNativeAnswers(f.run, snapshot, true);
      expect(f.store.get<FactoryQuestion>("questions", "database")?.answer).toBeNull();
      expect(f.store.get<FactoryQuestion>("questions", "automatic-start")?.answer).toBeNull();
    } finally { f.close(); }
  });
});
