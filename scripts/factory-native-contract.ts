/** Optional genuine-provider boundary check. Never substitutes a fake or writes a user's repository. */
import "./test-herdr.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { FactoryDetail, FactoryRun, InteractivePrompt } from "../shared/protocol.ts";

const provider = process.argv[2] ?? "codex";
if (!["codex", "claude", "opencode"].includes(provider)) throw new Error("Select codex, claude or opencode");
const state = mkdtempSync(join(tmpdir(), "saurons-eye-native-"));
const app = createServer({ port: 0, stateDir: state, machines: false });
const origin = `http://localhost:${app.port}`;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${value.error?.code}`); return value;
}
let run: FactoryRun | undefined;
try {
  const idea = await api<{ id: string }>("/api/factory/implementations", { title: "Owned native verification probe", description: "Read-only fixture: inspect local pinned instructions, record the fixed verification question and consume its explicit fixture answer. No source edits, publication or global setup." });
  await api(`/api/factory/implementations/${idea.id}/configure`, { provider, machine_id: "local" });
  run = await api(`/api/factory/implementations/${idea.id}/runs`, { action: "verify-provider", idempotency_key: "owned-native-verification" });
  if (!run.pane_id || run.condition !== "working") throw new Error(`Native launch ${run.condition}: ${run.waiting_reason}`);
  console.log(`${provider}: genuine native probe launched on an owned workspace`);
  const deadline = Date.now() + 300_000; const answered = new Set<string>(); let sent = false;
  while (Date.now() < deadline) {
    const detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
    const questions = detail.questions.filter((question) => question.run_id === run!.id);
    for (const question of questions) if (question.answer === null && !answered.has(question.id)) {
      if (!/Confirm this read-only native verification round\?/i.test(question.question)) throw new Error("The native provider asked outside this fixture's predeclared decision");
      await api(`/api/factory/implementations/${idea.id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed for this owned read-only verification fixture." }); answered.add(question.id);
    }
    const menu = await api<{ prompt: InteractivePrompt | null }>(`/api/pane/prompt?pane_id=${encodeURIComponent(run.pane_id)}`);
    if (menu.prompt) {
      // Actual key navigation via the public responder; never digit injection or session-wide permission.
      const safe = menu.prompt.options.findIndex((option) => /yes.*(?:once|proceed)|trust.*directory|yes,.*trust/i.test(option.label));
      const text = [menu.prompt.question, menu.prompt.body, menu.prompt.title].filter(Boolean).join("\n");
      if (safe >= 0 && (text.includes(state) || text.includes(".saurons-eye-tracker.mjs"))) await api("/api/pane/prompt/answer", { pane_id: run.pane_id, prompt_id: menu.prompt.id, option_index: safe });
    }
    if (questions.length && questions.every((question) => question.answer !== null) && !sent) {
      const delivery = await api<{ condition: string }>(`/api/factory/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: crypto.randomUUID() });
      if (delivery.condition === "uncertain" || delivery.condition === "sending") throw new Error("Native answered-context delivery is uncertain; it was not replayed");
      sent = delivery.condition === "sent";
    }
    if (sent) {
      try { const capabilities = await api<{ providers: { provider: string; factory_ready: boolean }[] }>(`/api/factory/runs/${run.id}/verify-provider`, {}); if (capabilities.providers.find((entry) => entry.provider === provider)?.factory_ready) { console.log(`${provider}: native loading and recorded owner-question round verified`); break; } }
      catch { /* incomplete evidence never certifies a provider */ }
    }
    if (Date.now() + 500 >= deadline) throw new Error("Native verification deadline: loading/question evidence remains unverified");
    await Bun.sleep(500);
  }
} finally {
  if (run?.workspace_id) { try { await api(`/api/factory/runs/${run.id}/stop`, { summary: "Owned native fixture finished" }); } catch { /* isolated check runner closes its own Herdr session */ } }
  app.stop(); rmSync(state, { recursive: true, force: true });
}
