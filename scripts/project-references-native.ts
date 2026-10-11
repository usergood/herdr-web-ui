/** Optional genuine Codex read proof, using only owned test resources and normal CLI auth. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationResponse, InteractivePrompt } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { agentStart, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

if (!Bun.which("codex")) throw new Error("Install and sign in to Codex before running this optional native proof");
const root = mkdtempSync(join(tmpdir(), "project-references-native-")); const repo = join(root, "repo"); mkdirSync(repo);
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" }); writeFileSync(join(repo, "README.md"), "# Owned native read proof\n");
execFileSync("git", ["add", "README.md"], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
const app = createServer({ port: 0, stateDir: join(root, "state"), machines: false }); let workspaceId: string | undefined; let succeeded = false;
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://localhost:${app.port}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Owned request failed ${response.status}: ${path}`); return await response.json() as T;
}
try {
  const project = await api("/factory/projects", { name: "Native references proof", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
  const library = await api(`/factory/projects/${project.id}/references`); const marker = `PROJECT-REFERENCE-${randomUUID()}`;
  await api(`/factory/projects/${project.id}/references`, { expected_revision: library.revision, name: "project-policy.md", title: "Project policy", media_type: "text/markdown", content_base64: Buffer.from(`# Project policy\n\nThe exact project label is ${marker}.\n`).toString("base64"), usage_note: "Read this guide and report its project label", read_policy: "always", caption: "" });
  const selected = await api(`/factory/projects/${project.id}/references`); const context = await api(`/factory/projects/${project.id}/references/prepare`, { expected_revision: selected.revision, machine_id: "local" });
  const created = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-project-references-native" }); workspaceId = created.workspace.workspace_id; const paneId = created.root_pane.pane_id;
  await agentStart({ name: `refs-${randomUUID().slice(0, 8)}`, kind: "codex", paneId, args: ["-C", repo, "--sandbox", "read-only", context.prompt + " Return only the exact project label from the document. Do not modify any file."], timeoutMs: 60_000 });
  const deadline = Date.now() + 180_000; let read = false;
  while (Date.now() < deadline) {
    const { prompt } = await api<{ prompt: InteractivePrompt | null }>(`/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
    if (prompt && !prompt.fallback && /trust/i.test([prompt.question, prompt.body].join(" ")) && [prompt.question, prompt.body].join(" ").includes(repo)) {
      const index = prompt.options.findIndex((option) => /trust.*directory|trust and continue|yes,.*trust/i.test(option.label));
      if (index >= 0) await api("/pane/prompt/answer", { pane_id: paneId, prompt_id: prompt.id, option_index: index });
    }
    const conversation = await api<ConversationResponse>(`/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    if (conversation.source === "codex-transcript" && conversation.turns.some((turn) => turn.role === "assistant" && turn.parts.some((part) => part.kind === "text" && part.text.includes(marker)))) { read = true; break; }
    await Bun.sleep(200);
  }
  assert(read, "The genuine Codex transcript must report the label that exists only inside the external reference");
  assert(readFileSync(context.index_path, "utf8").includes(selected.revision));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
  succeeded = true; console.log("PASS genuine Codex read the external Project guide; primary checkout unchanged");
} finally { if (workspaceId) await workspaceClose(workspaceId).catch(() => {}); app.stop(); if (succeeded) rmSync(root, { recursive: true, force: true }); else console.log(`Owned native proof evidence retained at ${root}`); }
