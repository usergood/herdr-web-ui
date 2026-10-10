import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryArtifact, FactoryChat, FactorySettings } from "../shared/protocol.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

const mediaTypes = new Set(["text/plain", "text/markdown", "text/html", "application/json", "image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewPolicy = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export class FactoryArtifacts {
  constructor(private readonly store: FactoryStore) {}
  retained(): FactoryArtifact[] {
    const evidenceIds = new Set(this.store.list<{ evidence_ids: string[] }>("retrospectives").flatMap((entry) => entry.evidence_ids));
    const runArtifacts = this.store.list<{ artifacts: FactoryArtifact[] }>("run_artifacts").flatMap((entry) => entry.artifacts);
    return [...this.store.list<FactoryArtifact>("artifacts"), ...runArtifacts, ...this.store.list<FactoryArtifact>("deleted_artifacts").filter((entry) => evidenceIds.has(entry.id))];
  }
  create(implementationId: string, body: Record<string, unknown>, settings: FactorySettings): FactoryArtifact {
    const chat = typeof body.chat_id === "string" ? this.store.get<FactoryChat>("chats", body.chat_id) : null;
    if (!chat || chat.implementation_id !== implementationId) throw new FactoryError("invalid_chat", "Select a Chat belonging to this Implementation");
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || /[\x00-\x1f/\\:]/.test(body.name) || [".", ".."].includes(body.name.trim()) || typeof body.media_type !== "string" || !mediaTypes.has(body.media_type) || typeof body.content_base64 !== "string" || body.content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.content_base64)) throw new FactoryError("invalid_artifact", "Use a named text or image attachment with valid base64 content");
    if (body.content_base64.length > Math.ceil(settings.max_artifact_bytes / 3) * 4) throw new FactoryError("artifact_too_large", "This attachment exceeds the configured size limit", 413);
    const bytes = Buffer.from(body.content_base64, "base64");
    const digest = hash(bytes);
    if (bytes.length > settings.max_artifact_bytes) throw new FactoryError("artifact_too_large", "This attachment exceeds the configured size limit", 413);
    if (body.hash !== undefined && body.hash !== digest || body.size !== undefined && body.size !== bytes.length) throw new FactoryError("artifact_mismatch", "The imported size or hash does not match the attachment");
    const all = this.store.list<FactoryArtifact>("artifacts");
    const retainedBytes = readdirSync(join(this.store.root, "blobs")).reduce((total, name) => total + lstatSync(join(this.store.root, "blobs", name)).size, 0);
    if (retainedBytes + (existsSync(join(this.store.root, "blobs", digest)) ? 0 : bytes.length) > settings.max_storage_bytes) throw new FactoryError("storage_full", "Retained attachments reached the configured size limit", 413);
    const name = body.name.trim();
    const versions = [...all, ...this.store.list<FactoryArtifact>("deleted_artifacts")].filter((item) => item.implementation_id === implementationId && item.name === name);
    const record: FactoryArtifact = { ...this.store.record(), implementation_id: implementationId, chat_id: chat.id, name, media_type: body.media_type, hash: digest, size: bytes.length, version: Math.max(0, ...versions.map((item) => item.version)) + 1, origin: typeof body.origin === "string" ? body.origin.slice(0, 200) : "upload", note: typeof body.note === "string" ? body.note.slice(0, 10_000) : "" };
    const destination = join(this.store.root, "blobs", digest);
    if (existsSync(destination)) this.read(record);
    else {
      const temporary = join(this.store.root, "blobs", record.id + ".tmp");
      try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    this.store.db.transaction(() => { this.store.put("artifacts", record, implementationId); this.store.event(implementationId, "artifact_retained", { artifact_id: record.id, hash: digest, size: record.size }); })();
    return record;
  }
  mutate(id: string, action: string, body: Record<string, unknown>): FactoryArtifact | { ok: true } {
    const record = this.store.get<FactoryArtifact>("artifacts", id);
    if (!record) throw new FactoryError("not_found", "Attachment not found", 404);
    if (action === "note") {
      if (typeof body.note !== "string" || body.note.length > 10_000) throw new FactoryError("invalid_note", "Enter a bounded attachment annotation");
      const next = { ...record, note: body.note, updated_at: new Date().toISOString() };
      this.store.put("artifacts", next, record.implementation_id); this.store.event(record.implementation_id, "artifact_annotated", { artifact_id: id }); return next;
    }
    if (body.hash !== record.hash) throw new FactoryError("artifact_changed", "Delete the exact retained attachment version", 409);
    const protectedByRetro = this.store.list<{ evidence_ids: string[] }>("retrospectives").some((entry) => entry.evidence_ids.includes(id)) || this.store.list<{ artifacts: FactoryArtifact[] }>("run_artifacts").some((entry) => entry.artifacts.some((artifact) => artifact.id === id));
    this.store.db.transaction(() => { this.store.remove("artifacts", id); this.store.put("deleted_artifacts", record, record.implementation_id); this.store.event(record.implementation_id, "artifact_deleted", { artifact_id: id, hash: record.hash, retained_for_retrospective: protectedByRetro }); })();
    if (!this.retained().some((entry) => entry.hash === record.hash)) {
      const file = join(this.store.root, "blobs", record.hash);
      if (existsSync(file) && !lstatSync(file).isSymbolicLink() && realpathSync(file) === file) unlinkSync(file);
    }
    return { ok: true };
  }
  read(record: FactoryArtifact): Buffer {
    if (!/^[a-f0-9]{64}$/.test(record.hash)) throw new FactoryError("artifact_corrupt", "The retained attachment needs recovery", 409);
    const path = join(this.store.root, "blobs", record.hash);
    let descriptor: number | undefined;
    try {
      if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error();
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink > 1 || info.size !== record.size) throw new Error();
      const content = readFileSync(descriptor);
      if (content.length !== record.size || hash(content) !== record.hash) throw new Error();
      return content;
    } catch { throw new FactoryError("artifact_corrupt", "The retained attachment is missing or changed; restore a verified backup", 409); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  response(record: FactoryArtifact, mode: string): Response {
    const source = mode === "source";
    return new Response(new Uint8Array(this.read(record)), { headers: {
      "content-type": source ? "text/plain; charset=utf-8" : record.media_type,
      "content-security-policy": previewPolicy, "x-content-type-options": "nosniff",
      "cache-control": "private, no-store", "referrer-policy": "no-referrer",
      ...(mode === "download" ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}` } : {}),
    } });
  }
}
