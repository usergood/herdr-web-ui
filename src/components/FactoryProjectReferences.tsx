import { useEffect, useRef, useState } from "react";
import type { CodexReferenceContext, FactoryProject, ProjectReference, ProjectReferenceLibrary } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { copyText } from "../lib/clipboard.ts";
import { Markdown } from "./Markdown.tsx";
import { FactoryArtifactPreview } from "./FactoryArtifactPreview.tsx";
import { base64FromBytes } from "../lib/api.ts";

export function FactoryProjectReferences({ project, machineId, maxBytes, busy, perform }: { project: FactoryProject; machineId: string; maxBytes: number; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const prefix = `/projects/${project.id}/references`;
  const [library, setLibrary] = useState<ProjectReferenceLibrary | null>(null);
  const [name, setName] = useState("project-guide.md"); const [title, setTitle] = useState(""); const [note, setNote] = useState(""); const [caption, setCaption] = useState("");
  const [policy, setPolicy] = useState<ProjectReference["read_policy"]>("always"); const [text, setText] = useState("");
  const [file, setFile] = useState<{ media: string; content: string } | null>(null);
  const [preview, setPreview] = useState<{ entry: ProjectReference; text?: string } | null>(null);
  const [context, setContext] = useState<CodexReferenceContext | null>(null); const [copied, setCopied] = useState(false); const [loadError, setLoadError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false); const [editing, setEditing] = useState(false);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  async function reload() { const next = await factoryRequest<ProjectReferenceLibrary>(prefix); setLibrary(next); setLoadError(false); return next; }
  useEffect(() => { let live = true; setLibrary(null); setContext(null); void factoryRequest<ProjectReferenceLibrary>(prefix).then((result) => { if (live) { setLibrary(result); setLoadError(false); } }).catch(() => { if (live) setLoadError(true); }); return () => { live = false; }; }, [prefix]);
  async function selectFile(selected: File) {
    if (selected.size > maxBytes) throw new Error(t("This reference exceeds the upload limit"));
    const media = selected.name.toLowerCase().endsWith(".md") ? "text/markdown" : selected.type || "text/plain";
    setName(selected.name); setTitle(selected.name); setCaption(""); setNote(""); setPolicy("reference"); setEditorOpen(true); setEditing(false); setDraftRevision(library?.revision ?? null);
    if (media.startsWith("text/") || media === "application/json") { setText(await selected.text()); setFile({ media, content: "" }); }
    else { setFile({ media, content: base64FromBytes(new Uint8Array(await selected.arrayBuffer())) }); setText(""); }
  }
  async function save() {
    if (!library) return;
    const bytes = new TextEncoder().encode(text); if (bytes.length > maxBytes) throw new Error(t("This reference exceeds the upload limit"));
    await factoryRequest(prefix, { expected_revision: draftRevision ?? library.revision, name, title, usage_note: note, read_policy: policy, caption, media_type: file?.media ?? "text/markdown", content_base64: file?.content || base64FromBytes(bytes) });
    setContext(null); setPreview(null); setText(""); setTitle(""); setFile(null); setEditorOpen(false); setEditing(false); setDraftRevision(null); await reload();
  }
  async function edit(entry: ProjectReference) {
    const response = await fetch(`/api/factory${prefix}/${entry.id}/source`); if (!response.ok) throw new Error(t("Project references unavailable"));
    const binary = entry.media_type.startsWith("image/");
    const content = binary ? base64FromBytes(new Uint8Array(await response.arrayBuffer())) : await response.text();
    setName(entry.name); setTitle(entry.title); setNote(entry.usage_note); setCaption(entry.caption); setPolicy(entry.read_policy);
    setFile({ media: entry.media_type, content: binary ? content : "" }); setText(binary ? "" : content); setEditing(true); setEditorOpen(true); setDraftRevision(library?.revision ?? null);
  }
  return <section className="factory-section" aria-label={t("Project references")}>
    <h3>{t("Project references")}</h3><p>{t("Shared Project guidance for Codex, stored outside your code repository.")}</p>
    {loadError && <p role="alert">{t("Project references unavailable")}</p>}
    <div className="factory-actions"><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await reload(); })}>{t("Refresh references")}</button><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { const template = await factoryRequest<{ name: string; content: string }>("/reference-template"); setName(template.name); setText(template.content); setFile(null); setPolicy("always"); setEditing(false); setEditorOpen(true); setDraftRevision(library?.revision ?? null); })}>{t("Use guide template")}</button><button className="btn factory-button" disabled={busy || !library} onClick={() => upload.current?.click()}>{t("Upload reference")}</button></div>
    <input type="file" ref={upload} hidden accept=".md,.txt,.json,.html,.png,.jpg,.jpeg,.gif,.webp" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void perform(() => selectFile(selected)); event.target.value = ""; }} />
    <details open={editorOpen} onToggle={(event) => { setEditorOpen(event.currentTarget.open); if (event.currentTarget.open && draftRevision === null) setDraftRevision(library?.revision ?? null); }}><summary>{t("Reference editor")}</summary><form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(save); }}>
      <label>{t("Reference title")}<input className="input factory-input" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t("Reference filename")}<input className="input factory-input" required readOnly={editing} maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("When to use this reference")}<textarea className="input factory-input" maxLength={10000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <label>{t("Reading policy")}<select className="select factory-input" value={policy} onChange={(event) => setPolicy(event.target.value as ProjectReference["read_policy"])}><option value="always">{t("Always read")}</option><option value="reference">{t("Reference when relevant")}</option></select></label>
      {(!file || !file.content) && <label>{t("Reference text")}<textarea className="input factory-input" name="reference-content" required value={text} onChange={(event) => setText(event.target.value)} /></label>}
      <label>{t("Picture caption or additional context")}<textarea className="input factory-input" maxLength={10000} value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
      <button className="btn factory-button" disabled={busy || !library}>{t("Save Project reference")}</button>
    </form></details>
    {library?.entries.map((entry) => <article className="factory-artifact" key={entry.id}><h4>{entry.title} · v{entry.version}</h4><p>{entry.usage_note}</p><small>{entry.name} · {entry.read_policy === "always" ? t("Always read") : t("Reference when relevant")}</small>{entry.caption && <p>{entry.caption}</p>}
      <div className="factory-actions"><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { const source = entry.media_type.startsWith("image/") || entry.media_type === "text/html" ? undefined : await fetch(`/api/factory${prefix}/${entry.id}/source`).then(async (response) => { if (!response.ok) throw new Error(t("Project references unavailable")); return response.text(); }); setPreview({ entry, text: source }); })}>{t("Read reference")}</button><button className="btn factory-button" disabled={busy} onClick={() => void perform(() => edit(entry))}>{t("Edit reference")}</button><a className="btn factory-button" href={`/api/factory${prefix}/${entry.id}/download`} download={entry.name}>{t("Download")}</a><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/${entry.id}/remove`, { expected_revision: library.revision }); setContext(null); setPreview(null); await reload(); })}>{t("Remove from library")}</button></div>
      {preview?.entry.id === entry.id && (preview.text === undefined ? <FactoryArtifactPreview artifact={entry} previewPath={`/api/factory${prefix}/${entry.id}/preview`} /> : entry.media_type === "text/markdown" ? <Markdown>{preview.text}</Markdown> : <pre>{preview.text}</pre>)}
    </article>)}
    <p>{t("Removing a reference keeps its retained version history.")}</p>
    <button className="btn factory-button" disabled={busy || !library || !library.entries.length} onClick={() => void perform(async () => { setContext(await factoryRequest<CodexReferenceContext>(`${prefix}/prepare`, { machine_id: machineId, expected_revision: library!.revision })); setCopied(false); })}>{t("Prepare Codex references")}</button>
    {context && <div className="factory-form"><p>{t("Paste this prompt into Codex to use the prepared references.")}</p><label>{t("Codex reference prompt")}<textarea className="input factory-input" name="codex-reference-prompt" readOnly value={context.prompt} /></label><button className="btn factory-button" onClick={() => void perform(async () => { if (!(await copyText(context.prompt))) throw new Error(t("Copy failed")); setCopied(true); })}>{t("Copy reference prompt")}</button>{copied && <p role="status">{t("Reference prompt copied")}</p>}</div>}
  </section>;
}
