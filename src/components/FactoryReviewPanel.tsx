import { useState } from "react";
import type { FactoryDetail, ReviewSnapshot } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function FactoryReviewPanel({ detail, busy, perform }: { detail: FactoryDetail; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [mode, setMode] = useState<"workspace" | "branch">("workspace");
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [sideBySide, setSideBySide] = useState(false);
  const [side, setSide] = useState<"old" | "new">("new");
  const [line, setLine] = useState(1); const [finding, setFinding] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const snapshot = detail.snapshots.find((item) => item.id === snapshotId) ?? detail.snapshots.at(-1);
  const file = snapshot?.files[fileIndex];
  const run = detail.runs.at(-1);
  const prefix = `/implementations/${detail.implementation.id}`;
  return <section className="factory-section"><h3>{t("Review changes")}</h3>
    <div className="factory-actions"><label>{t("Changes")}<select className="select" value={mode} onChange={(event) => setMode(event.target.value as "workspace" | "branch")}><option value="workspace">{t("Captured workspace")}</option><option value="branch">{t("Branch aggregate")}</option></select></label><button className="btn" disabled={busy || !detail.implementation.project_id} onClick={() => void perform(async () => { const captured = await factoryRequest<ReviewSnapshot>(`${prefix}/snapshots`, { mode, ...(run?.worktree ? { run_id: run.id } : {}) }); setSnapshotId(captured.id); setFileIndex(0); setSelected([]); })}>{t("Capture review")}</button></div>
    {snapshot && <><p className="factory-context">{snapshot.mode} · {snapshot.machine_id} · {snapshot.base.slice(0, 12)} → {snapshot.head.slice(0, 12)}</p>
      <label>{t("Review snapshot")}<select className="select" value={snapshot.id} onChange={(event) => { setSnapshotId(event.target.value); setFileIndex(0); setSelected([]); }}>{detail.snapshots.map((entry) => <option key={entry.id} value={entry.id}>{entry.created_at} · {entry.mode} · {entry.head.slice(0, 8)}</option>)}</select></label>
      <div className="factory-actions"><label>{t("File")}<select className="select" value={fileIndex} onChange={(event) => setFileIndex(Number(event.target.value))}>{snapshot.files.map((entry, index) => <option key={`${entry.status}:${entry.path}`} value={index}>{entry.path} · {entry.status}</option>)}</select></label><button className="btn" aria-pressed={sideBySide} onClick={() => setSideBySide((current) => !current)}>{t("Side by side")}</button></div>
      {file && <><h4>{file.path} · {file.status}</h4>{file.oversized ? <p role="status">{t("This file exceeds the review size limit.")}</p> : file.binary ? <p role="status">{t("Binary file: a text diff is unavailable.")}</p> : sideBySide ? <div className="factory-diff-sides"><pre>{file.diff.split("\n").filter((row) => !row.startsWith("+")).join("\n")}</pre><pre>{file.diff.split("\n").filter((row) => !row.startsWith("-")).join("\n")}</pre></div> : <pre className="factory-diff">{file.diff}</pre>}
        {!file.oversized && !file.binary && file.diff && <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/comments`, { snapshot_id: snapshot.id, path: file.path, change: file.status, side, line_start: line, line_end: line, content: finding }); setFinding(""); }); }}><label>{t("Side")}<select className="select" value={side} onChange={(event) => setSide(event.target.value as "old" | "new")}><option value="new">{t("After")}</option><option value="old">{t("Before")}</option></select></label><label>{t("Line")}<input className="input" type="number" min={1} required value={line} onChange={(event) => setLine(event.target.valueAsNumber)} /></label><label>{t("Review finding")}<textarea className="input" required value={finding} onChange={(event) => setFinding(event.target.value)} maxLength={10_000} /></label><button className="btn" disabled={busy}>{t("Save draft finding")}</button></form>}
      </>}
      {detail.comments.map((comment) => <article className="factory-message" key={comment.id}><label><input type="checkbox" disabled={comment.status !== "draft" || busy || comment.snapshot_id !== snapshot.id} checked={selected.includes(comment.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, comment.id] : current.filter((id) => id !== comment.id))} />{comment.path}:{comment.line_start} · {comment.side} · {comment.status}</label><p>{comment.content}</p><small>{comment.snapshot_id}</small><button className="btn" disabled={busy || !comment.run_id || comment.status === "resolved"} onClick={() => void perform(async () => { const check = detail.checks.filter((entry) => entry.run_id === comment.run_id && entry.worker_id === null).at(-1); await factoryRequest(`${prefix}/comments/${comment.id}/resolve`, { head: check?.head, summary: "Owner reviewed fresh checks and independent Standards/Spec evidence" }); })}>{t("Resolve with fresh evidence")}</button></article>)}
      <button className="btn" disabled={busy || selected.length === 0 || !snapshot.run_id} onClick={() => void perform(async () => { const batch = await factoryRequest<{ status: string }>(`${prefix}/request-changes`, { run_id: snapshot.run_id, snapshot_id: snapshot.id, comment_ids: selected, idempotency_key: crypto.randomUUID() }); if (batch.status !== "sent") throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again.")); setSelected([]); })}>{t("Request changes")}</button>
    </>}
  </section>;
}
