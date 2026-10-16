import { useState } from "react";
import type { FactoryDetail, ReviewComment, ReviewSnapshot } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

type Perform = (action: () => Promise<void>) => Promise<void>;
type Selection = { side: "old" | "new"; start: number; end: number };

/** Numbers come only from captured hunks, including both sides of context rows. */
function diffRows(diff: string) {
  let old = 0; let next = 0; let hunk = false;
  return diff.split("\n").map(text => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { old = Number(header[1]); next = Number(header[2]); hunk = true; }
    const row: { text: string; old?: number; new?: number } = { text };
    if (!header && hunk) {
      if (text.startsWith(" ")) { row.old = old++; row.new = next++; }
      else if (text.startsWith("-")) row.old = old++;
      else if (text.startsWith("+")) row.new = next++;
    }
    return row;
  });
}

export function ReviewLineComments({ snapshot, file, busy, perform }: { snapshot: ReviewSnapshot; file: ReviewSnapshot["files"][number]; busy: boolean; perform: Perform }) {
  const t = useT();
  // Keep each file's unsaved composition while navigating the captured file list.
  const [compositions, setCompositions] = useState<Record<string, { selection: Selection | null; text: string }>>({});
  const [extend, setExtend] = useState(false);
  const identity = JSON.stringify([snapshot.id, file.path, file.status]);
  const { selection, text } = compositions[identity] ?? { selection: null, text: "" };
  const update = (value: { selection: Selection | null; text: string }) => setCompositions(current => ({ ...current, [identity]: value }));
  const choose = (side: Selection["side"], line: number, shift: boolean) => {
    const start = (extend || shift) && selection?.side === side ? selection.start : line;
    update({ text, selection: { side, start, end: line } }); setExtend(false);
  };
  const start = selection ? Math.min(selection.start, selection.end) : 0;
  const end = selection ? Math.max(selection.start, selection.end) : 0;
  return <>
    <pre tabIndex={0}>{diffRows(file.diff).map((row, index) => <span className="human-review-line" key={index}>
      {(["old", "new"] as const).map(side => row[side] !== undefined && <button key={side} type="button" className="human-review-line-number" aria-label={`${side === "old" ? t("Before") : t("After")} ${row[side]}`} aria-pressed={selection?.side === side && row[side]! >= start && row[side]! <= end} onClick={event => choose(side, row[side]!, event.shiftKey)}>{side === "old" ? "−" : "+"}{row[side]}</button>)}<code>{row.text}{"\n"}</code>
    </span>)}</pre>
    <button type="button" className="btn factory-button" disabled={!selection || busy} aria-pressed={extend} onClick={() => setExtend(current => !current)}>{t("Select range end")}</button>
    {selection && <form className="factory-form" onSubmit={event => {
      event.preventDefault();
      void perform(async () => {
        await factoryRequest(`/implementations/${snapshot.implementation_id}/comments`, { snapshot_id: snapshot.id, path: file.path, change: file.status, side: selection.side, line_start: start, line_end: end, content: text });
        setCompositions(current => ({ ...current, [identity]: { selection: null, text: "" } }));
      });
    }}>
      <p role="status">{file.path} · {selection.side === "old" ? t("Before") : t("After")} {start}–{end}</p>
      <label>{t("Review finding")}<textarea className="input factory-input" maxLength={10000} required value={text} onChange={event => update({ selection, text: event.target.value })} /></label>
      <button className="btn factory-button" disabled={busy || !text.trim() || end - start > 100}>{t("Save draft finding")}</button>
    </form>}
  </>;
}

function Comment({ comment, snapshot, busy, perform }: { comment: ReviewComment; snapshot?: ReviewSnapshot; busy: boolean; perform: Perform }) {
  const t = useT(); const [editing, setEditing] = useState(false); const [text, setText] = useState(comment.content);
  const draft = comment.batch_id === null && !comment.resolution && ["draft", "outdated"].includes(comment.status);
  const prefix = `/implementations/${comment.implementation_id}/comments/${comment.id}`;
  return <article className="factory-message human-review-comment">
    <p>{comment.path} · {comment.change} · {comment.side === "old" ? t("Before") : t("After")} {comment.line_start}–{comment.line_end}</p>
    {comment.status === "outdated" && <p role="status">{t("Stale anchor: the candidate changed. Original lines are retained.")}</p>}
    <details><summary>{t("Original anchor")}</summary><p>{comment.snapshot_id} · {snapshot?.head} · {snapshot?.hash}</p><pre tabIndex={0}>{comment.context}</pre></details>
    {editing ? <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/edit`, { content: text }); setEditing(false); }); }}>
      <label>{t("Review finding")}<textarea className="input factory-input" maxLength={10000} required value={text} onChange={event => setText(event.target.value)} /></label>
      <button className="btn factory-button" disabled={busy || !text.trim()}>{t("Save draft finding")}</button>
      <button type="button" className="btn factory-button" onClick={() => setEditing(false)}>{t("Cancel")}</button>
    </form> : <p>{comment.content}</p>}
    {draft && <div className="factory-actions"><button className="btn factory-button" disabled={busy || editing} onClick={() => { setText(comment.content); setEditing(true); }}>{t("Edit draft")}</button><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/delete`, {}); })}>{t("Remove draft")}</button></div>}
  </article>;
}

export function ReviewDrafts({ detail, busy, perform }: { detail: FactoryDetail; busy: boolean; perform: Perform }) {
  const t = useT();
  const drafts = detail.comments.filter(c => c.batch_id === null && !c.resolution && ["draft", "outdated"].includes(c.status));
  const submitted = detail.comments.filter(c => !drafts.includes(c));
  return <>
    <section aria-label={t("Draft comments")}><h5>{t("Draft comments")}</h5><p>{t("Saved drafts do not start repairs or authorize a merge.")}</p>{drafts.map(comment => <Comment key={comment.id} comment={comment} snapshot={detail.snapshots.find(s => s.id === comment.snapshot_id)} busy={busy} perform={perform} />)}</section>
    {submitted.length > 0 && <section aria-label={t("Submitted comments")}><h5>{t("Submitted comments")}</h5>{submitted.map(comment => <Comment key={comment.id} comment={comment} snapshot={detail.snapshots.find(s => s.id === comment.snapshot_id)} busy={busy} perform={perform} />)}</section>}
  </>;
}
