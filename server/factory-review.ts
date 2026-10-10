import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { FactoryProject, FactoryRun, Implementation, ProjectCheckout, ReviewComment, ReviewSnapshot } from "../shared/protocol.ts";
import { FactoryError, git, hash, inspectCheckout } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { HerdrError } from "./herdr/client.ts";

const FILE_LIMIT = 2 * 1024 * 1024;
const CAPTURE_LIMIT = 16 * 1024 * 1024;
function namedChanges(text: string): { status: string; path: string; oldPath?: string }[] {
  const parts = text.split("\0"); const result: { status: string; path: string; oldPath?: string }[] = [];
  for (let index = 0; index < parts.length && parts[index];) {
    const status = parts[index++]!; const path = parts[index++]!;
    if (status.startsWith("R") || status.startsWith("C")) result.push({ status, oldPath: path, path: parts[index++]! });
    else result.push({ status, path });
  }
  return result;
}
function linesInDiff(diff: string, side: "old" | "new"): Set<number> {
  const lines = new Set<number>(); let old = 0; let added = 0; let hunk = false;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { old = Number(header[1]); added = Number(header[2]); hunk = true; continue; }
    if (!hunk) continue;
    if (line.startsWith(" ")) { lines.add(side === "old" ? old : added); old++; added++; }
    else if (line.startsWith("-")) { if (side === "old") lines.add(old); old++; }
    else if (line.startsWith("+")) { if (side === "new") lines.add(added); added++; }
  }
  return lines;
}

export async function captureReview(path: string, base: string, mode: ReviewSnapshot["mode"]): Promise<{ files: ReviewSnapshot["files"]; head: string }> {
    const take = async (): Promise<{ files: ReviewSnapshot["files"]; head: string }> => {
      const head = (await git(path, ["rev-parse", "HEAD"])).trim();
      const files: ReviewSnapshot["files"] = [];
      const groups = mode === "branch" ? [{ name: "branch", args: [base, head] }] : [{ name: "staged", args: ["--cached", "HEAD"] }, { name: "unstaged", args: [] as string[] }];
      let size = 0;
      for (const group of groups) {
        const changes = namedChanges(await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", ...group.args, "--"]));
        for (const change of changes) {
          const file = join(path, change.path);
          const oversized = existsSync(file) && lstatSync(file).size > FILE_LIMIT;
          const diff = oversized ? "" : await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", ...group.args, "--", ...(change.oldPath ? [change.oldPath] : []), change.path]);
          size += diff.length;
          files.push({ path: change.path, status: `${group.name}:${change.status}`, diff, binary: /Binary files .* differ|GIT binary patch/.test(diff), oversized });
        }
      }
      if (mode === "workspace") for (const name of (await git(path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
        if (name.startsWith(".saurons-eye-") || name === ".opencode/agents/saurons-eye.md" || /^(\.agents|\.claude|\.opencode)\/skills\//.test(name)) continue;
        const file = join(path, name); const info = lstatSync(file);
        if (info.isSymbolicLink() || !realpathSync(file).startsWith(path + "/")) { files.push({ path: name, status: "untracked:symlink", diff: "", binary: false, oversized: false }); continue; }
        const oversized = info.size > FILE_LIMIT;
        const bytes = oversized ? null : readFileSync(file); const binary = bytes?.includes(0) ?? false;
        const content = bytes && !binary ? bytes.toString("utf8") : "";
        const rows = content.split("\n"); if (rows.at(-1) === "") rows.pop();
        const diff = content ? `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${rows.length} @@\n${rows.map((line) => "+" + line).join("\n")}\n` : "";
        size += diff.length; files.push({ path: name, status: "untracked:A", diff, binary, oversized });
      }
      if (files.length > 200 || size > CAPTURE_LIMIT) throw new FactoryError("review_too_large", "This review exceeds the capture budget; split the change before review", 413);
      return { files, head };
    };
    let captured = await take(); let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) { const next = await take(); if (hash(JSON.stringify(next)) === hash(JSON.stringify(captured))) { stable = true; break; } captured = next; }
    if (!stable) throw new FactoryError("workspace_changed", "The workspace changed during capture; capture it again after writing stops", 409);
    return captured;
}

export class FactoryReview {
  constructor(private readonly store: FactoryStore, private readonly remote: (machineId: string, path: string, base: string, mode: ReviewSnapshot["mode"]) => Promise<{ repository: string; files: ReviewSnapshot["files"]; head: string }>, private readonly inspect: (machineId: string, path: string) => ReturnType<typeof inspectCheckout>) {}
  async capture(id: string, body: Record<string, unknown>): Promise<ReviewSnapshot> {
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) throw new FactoryError("not_found", "Implementation not found", 404);
    if (body.mode !== "branch" && body.mode !== "workspace") throw new FactoryError("invalid_snapshot", "Select branch or captured workspace changes");
    const run = typeof body.run_id === "string" ? this.store.get<FactoryRun>("runs", body.run_id) : null;
    if (body.run_id !== undefined && (!run || run.implementation_id !== id)) throw new FactoryError("invalid_run", "Select this Implementation's Run");
    const project = implementation.project_id ? this.store.get<FactoryProject>("projects", implementation.project_id) : null;
    const machineId = run?.machine_id ?? implementation.machine_id ?? project?.machine_id ?? "local";
    const checkout = implementation.project_id ? this.store.list<ProjectCheckout>("checkouts", implementation.project_id).find((entry) => entry.machine_id === machineId) : null;
    const path = run?.worktree ?? checkout?.path;
    if (!path) throw new FactoryError("checkout_required", "Select a verified Project checkout", 409);
    const inspected = await this.inspect(machineId, path);
    if (checkout && inspected.repository !== checkout.repository) throw new FactoryError("wrong_checkout", "The checkout identity changed", 409);
    const base = run?.base ?? checkout!.head;
    const captured = machineId === "local" ? await captureReview(path, base, body.mode) : await this.remote(machineId, path, base, body.mode);
    if ("repository" in captured && captured.repository !== inspected.repository) throw new FactoryError("wrong_checkout", "The remote review belongs to a different repository", 409);
    const snapshot: ReviewSnapshot = { ...this.store.record(), implementation_id: id, run_id: run?.id ?? null, machine_id: machineId, repository: inspected.repository, mode: body.mode, base, head: captured.head, hash: hash(JSON.stringify({ mode: body.mode, base, ...captured })), files: captured.files };
    this.store.db.transaction(() => {
      this.store.put("snapshots", snapshot, id);
      for (const comment of this.store.list<ReviewComment>("comments", id)) {
        const previous = this.store.get<ReviewSnapshot>("snapshots", comment.snapshot_id);
        if (previous?.mode === snapshot.mode && previous.run_id === snapshot.run_id && previous.hash !== snapshot.hash) this.store.put("comments", { ...comment, status: "outdated", updated_at: snapshot.created_at }, id);
      }
      this.store.event(id, "review_captured", { snapshot_id: snapshot.id, mode: snapshot.mode, base, head: snapshot.head, hash: snapshot.hash });
    })();
    return snapshot;
  }
  comment(id: string, body: Record<string, unknown>): ReviewComment {
    const snapshot = typeof body.snapshot_id === "string" ? this.store.get<ReviewSnapshot>("snapshots", body.snapshot_id) : null;
    if (!snapshot || snapshot.implementation_id !== id) throw new FactoryError("invalid_snapshot", "Select this Implementation's review snapshot");
    if (typeof body.path !== "string" || !["old", "new"].includes(String(body.side)) || !Number.isSafeInteger(body.line_start) || !Number.isSafeInteger(body.line_end) || Number(body.line_start) < 1 || Number(body.line_end) < Number(body.line_start) || Number(body.line_end) - Number(body.line_start) > 100 || typeof body.content !== "string" || !body.content.trim() || body.content.length > 10_000) throw new FactoryError("invalid_comment", "Enter a review finding with a valid line range");
    const candidates = snapshot.files.filter((file) => file.path === body.path && (body.change === undefined || body.change === file.status));
    if (candidates.length !== 1) throw new FactoryError("ambiguous_anchor", "Select the exact staged, unstaged or branch change");
    const file = candidates[0]!;
    const lines = linesInDiff(file.diff, body.side as "old" | "new");
    for (let line = Number(body.line_start); line <= Number(body.line_end); line++) if (!lines.has(line)) throw new FactoryError("invalid_anchor", "This line is not present on the selected side of the captured hunk");
    const comment: ReviewComment = { ...this.store.record(), implementation_id: id, run_id: snapshot.run_id, snapshot_id: snapshot.id, path: file.path, change: file.status, side: body.side as "old" | "new", line_start: body.line_start as number, line_end: body.line_end as number, context: file.diff, content: body.content.trim(), status: "draft", batch_id: null };
    this.store.db.transaction(() => { this.store.put("comments", comment, id); this.store.event(id, "review_drafted", { comment_id: comment.id, snapshot_id: snapshot.id }); })(); return comment;
  }
  async requestChanges(id: string, body: Record<string, unknown>, send: (run: FactoryRun, text: string) => Promise<void>): Promise<{ id: string; status: string }> {
    if (typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key) || typeof body.run_id !== "string" || typeof body.snapshot_id !== "string" || !Array.isArray(body.comment_ids) || !body.comment_ids.length || body.comment_ids.length > 100 || body.comment_ids.some((value: unknown) => typeof value !== "string")) throw new FactoryError("invalid_batch", "Select a Run, snapshot and a bounded finding batch");
    const signature = hash(JSON.stringify({ run_id: body.run_id, snapshot_id: body.snapshot_id, comment_ids: body.comment_ids }));
    const previous = this.store.list<{ id: string; key: string; signature: string; status: string }>("review_batches", id).find((batch) => batch.key === body.idempotency_key);
    if (previous) { if (previous.signature !== signature) throw new FactoryError("batch_conflict", "This submission key belongs to another selected batch", 409); return previous; }
    const run = this.store.get<FactoryRun>("runs", body.run_id);
    const snapshot = this.store.get<ReviewSnapshot>("snapshots", body.snapshot_id);
    if (!run || run.implementation_id !== id || !snapshot || snapshot.implementation_id !== id || snapshot.run_id !== run.id) throw new FactoryError("batch_target_changed", "The findings must target this Run and its exact review snapshot", 409);
    const current = await this.capture(id, { mode: snapshot.mode, run_id: run.id });
    if (current.hash !== snapshot.hash) throw new FactoryError("snapshot_outdated", "The code changed after this review; findings retain their original anchors", 409);
    const comments = [...new Set(body.comment_ids as string[])].map((commentId) => this.store.get<ReviewComment>("comments", commentId));
    if (comments.some((comment) => !comment || comment.implementation_id !== id || comment.run_id !== run.id || comment.snapshot_id !== snapshot.id || comment.status !== "draft" || comment.batch_id !== null)) throw new FactoryError("invalid_finding_selection", "Submit only unsent drafts from the selected snapshot", 409);
    const batch = { ...this.store.record(), implementation_id: id, run_id: run.id, snapshot_id: snapshot.id, key: body.idempotency_key, signature, status: "sending", comment_ids: comments.map((comment) => comment!.id) };
    this.store.db.transaction(() => {
      if (this.store.list<{ key: string }>("review_batches", id).some((entry) => entry.key === body.idempotency_key)) throw new FactoryError("batch_claimed", "This selected batch is already claimed; read its receipt before retrying", 409);
      if (comments.some((comment) => this.store.get<ReviewComment>("comments", comment!.id)?.status !== "draft")) throw new FactoryError("finding_claimed", "A selected finding is already claimed by another submission", 409);
      this.store.put("review_batches", batch, id);
      for (const comment of comments) this.store.put("comments", { ...comment!, status: "submitted", batch_id: batch.id, updated_at: batch.created_at }, id);
      this.store.event(id, "request_changes_submitted", { batch_id: batch.id, snapshot_id: snapshot.id, comment_ids: batch.comment_ids });
    }).immediate();
    const text = `Request changes batch ${batch.id} for Run ${run.id}, snapshot ${snapshot.id} (${snapshot.base}..${snapshot.head}, ${snapshot.mode}).\n\n${comments.map((comment) => `${comment!.path}:${comment!.line_start}-${comment!.line_end} (${comment!.side}, ${comment!.change})\n${comment!.content}\n\nCaptured hunk:\n${comment!.context}`).join("\n\n")}\n\nRetain the original finding anchors. Use a fresh owned Ticket worker with review_batch_id ${batch.id}; keep the coordinator read-only. Rework needs fresh checks and separate Standards and Spec evidence before owner acceptance.`;
    try { await send(run, text); batch.status = "sent"; }
    catch (error) {
      batch.status = error instanceof FactoryError && ["agent_busy", "delivery_busy", "input_draft", "run_unavailable", "native_identity_changed", "disconnected", "recovery_copy"].includes(error.code) || error instanceof HerdrError && ["agent_blocked", "agent_not_found", "agent_not_ready", "cancelled", "input_draft"].includes(error.code) ? "blocked" : "uncertain";
      if (batch.status === "blocked") for (const comment of comments) this.store.put("comments", { ...comment!, status: "draft", batch_id: null }, id);
    }
    this.store.db.transaction(() => { this.store.put("review_batches", batch, id); this.store.event(id, batch.status === "sent" ? "request_changes_delivered" : "request_changes_uncertain", { batch_id: batch.id, run_id: run.id }); })();
    return batch;
  }
}
