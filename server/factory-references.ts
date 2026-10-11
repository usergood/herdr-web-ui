import type { FactoryProject, FactorySettings, ProjectReference, ProjectReferenceLibrary, ProjectReferencePayload } from "../shared/protocol.ts";
import { FactoryArtifacts } from "./factory-artifacts.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

/** Project-owned inputs; native transcript and Implementation ownership stay separate. */
export class FactoryReferences {
  constructor(private readonly store: FactoryStore, private readonly artifacts: FactoryArtifacts) {}
  private project(id: string): void { if (!this.store.get<FactoryProject>("projects", id)) throw new FactoryError("not_found", "Project not found", 404); }
  current(projectId: string): ProjectReferenceLibrary {
    this.project(projectId);
    const entries = this.store.list<{ version_id: string }>("project_reference_heads", projectId).map((head) => this.store.get<ProjectReference>("project_reference_versions", head.version_id)!).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { project_id: projectId, revision: hash(JSON.stringify({ project_id: projectId, entries })), entries };
  }
  create(projectId: string, body: Record<string, unknown>, settings: FactorySettings): ProjectReference {
    const library = this.current(projectId);
    if (body.expected_revision !== library.revision) throw new FactoryError("references_changed", "The Project references changed; refresh before saving", 409);
    for (const [field, limit] of [["title", 200], ["usage_note", 10000], ["caption", 10000]] as const) if (typeof body[field] !== "string" || (body[field] as string).length > limit || field === "title" && !(body[field] as string).trim()) throw new FactoryError("invalid_reference", "Enter a title and bounded reference guidance");
    if (typeof body.read_policy !== "string" || !["always", "reference"].includes(body.read_policy)) throw new FactoryError("invalid_reference", "Select how Codex should read this reference");
    const blob = this.artifacts.retain(body, settings);
    const versions = this.store.list<ProjectReference>("project_reference_versions", projectId).filter((entry) => entry.name === blob.name);
    const previous = versions.at(-1);
    const record: ProjectReference = { ...this.store.record(), ...blob, project_id: projectId, reference_id: previous?.reference_id ?? this.store.record().id, version: (previous?.version ?? 0) + 1, title: (body.title as string).trim(), usage_note: body.usage_note as string, caption: body.caption as string, read_policy: body.read_policy as ProjectReference["read_policy"] };
    this.store.db.transaction(() => { this.store.put("project_reference_versions", record, projectId); this.store.put("project_reference_heads", { id: record.reference_id, version_id: record.id }, projectId); this.store.event(null, "project_reference_saved", { project_id: projectId, reference_id: record.reference_id, version_id: record.id }); })();
    return record;
  }
  get(projectId: string, versionId: string): ProjectReference {
    this.project(projectId);
    const record = this.store.get<ProjectReference>("project_reference_versions", versionId);
    if (!record || record.project_id !== projectId) throw new FactoryError("not_found", "Project reference not found", 404);
    return record;
  }
  remove(projectId: string, versionId: string, expectedRevision: unknown): { ok: true } {
    const library = this.current(projectId);
    if (expectedRevision !== library.revision) throw new FactoryError("references_changed", "The Project references changed; refresh before removing", 409);
    const record = library.entries.find((entry) => entry.id === versionId);
    if (!record) throw new FactoryError("not_found", "Current Project reference not found", 404);
    this.store.remove("project_reference_heads", record.reference_id);
    this.store.event(null, "project_reference_removed", { project_id: projectId, version_id: versionId, versions_retained: true });
    return { ok: true };
  }
  freeze(projectId: string): ProjectReferenceLibrary {
    const library = this.current(projectId);
    this.store.put("project_reference_snapshots", { id: library.revision, ...library }, projectId);
    return library;
  }
  payload(library: ProjectReferenceLibrary): ProjectReferencePayload {
    return { library, files: library.entries.map((entry) => ({ id: entry.id, content_base64: this.artifacts.read(entry).toString("base64") })) };
  }
}
