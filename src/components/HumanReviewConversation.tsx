import { useState, type ReactNode } from "react";
import type { FactoryDetail, ReviewSnapshot } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import "./HumanReviewConversation.css";

function ChangedFiles({ files, selected, choose, prefix = "" }: { files: ReviewSnapshot["files"]; selected: number; choose: (index: number) => void; prefix?: string }) {
  const directories = [...new Set(files.flatMap(file => {
    if (!file.path.startsWith(prefix)) return [];
    const rest = file.path.slice(prefix.length); return rest.includes("/") ? [rest.split("/")[0]!] : [];
  }))];
  return <ul className="human-review-files">{directories.map(name => <li key={name}><details open><summary>{name}</summary><ChangedFiles files={files} prefix={`${prefix}${name}/`} selected={selected} choose={choose} /></details></li>)}{files.map((file, index) => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/") && <li key={`${file.status}:${file.path}`}><button className="project-navigation-row" aria-current={selected === index ? "true" : undefined} onClick={() => choose(index)}>{file.path} · {file.status}</button></li>)}</ul>;
}

export function HumanReviewConversation({ detail, busy, perform, history }: { detail: FactoryDetail; busy: boolean; history: ReactNode; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const review = detail.human_reviews?.at(-1);
  const [fileIndex, setFileIndex] = useState(0);
  const [text, setText] = useState(""); const [key, setKey] = useState(() => crypto.randomUUID());
  const approval = detail.human_review_approvals?.find(a => a.review_id === review?.id);
  const retainedComments = detail.comments.some(c => c.status !== "resolved");
  const snapshot = detail.snapshots.find(s => s.id === review?.snapshot_id);
  const file = snapshot?.files[fileIndex];
  const chatIds = new Set(detail.chats.filter(c => c.title === "Human Review").map(c => c.id));
  const assistant = detail.runs.find(r => r.id === review?.assistant_run_id);
  const waiting = detail.capacity_waiting?.filter(w => w.id.startsWith("discussion:"));
  return <div className="human-review-conversation">
    {!review ? <p role="status">{t("Human Review opens automatically after checks, independent reviews and PR publication.")}</p> : <>
      <p role="status">{review.reason ?? t("Review the captured result and discuss it with the assistant.")}</p>
      <p className="field-hint">{t("Approval merges this checked and independently reviewed candidate into its authorized target.")}</p>
      {approval && <p role="status">{approval.reason ?? (approval.condition === "released" ? t("Release verified") : approval.condition === "merged" ? t("Merge verified") : t("Merge approval retained"))}</p>}
      {(retainedComments || text.trim()) && <p role="status">{t("Finish your draft comments before approving without comments.")}</p>}
      <button className="btn factory-button" disabled={busy || review.condition !== "ready" || !review.snapshot_id || retainedComments || !!text.trim() || !!approval && approval.condition !== "blocked"} onClick={() => void perform(async () => {
        if (!review.snapshot_id) return;
        await factoryRequest(`/implementations/${detail.implementation.id}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `approve-${review.id}` });
      })}>{t("Approve and merge")}</button>
      {assistant?.waiting_reason && <p role="status">{assistant.waiting_reason}</p>}
      {detail.human_review_deliveries?.filter(d => d.reason).map(d => <p role="status" key={d.id}>{d.reason}</p>)}
      {waiting?.map(w => <p role="status" key={w.id}>{w.reason}</p>)}
      <div className="human-review-layout"><div className="human-review-candidate">{snapshot && <>
        <details className="human-review-provenance"><summary>{t("Review snapshot")}</summary><dl><dt>{t("Review snapshot")}</dt><dd>{snapshot.id}</dd><dt>{t("Before")}</dt><dd>{snapshot.base}</dd><dt>{t("After")}</dt><dd>{snapshot.head}</dd><dt>{t("Captured workspace")}</dt><dd>{snapshot.machine_id} · {snapshot.mode} · {snapshot.hash}</dd></dl></details>
        <div className="human-review-changes"><nav aria-label={t("Changed files")}><ChangedFiles files={snapshot.files} selected={fileIndex} choose={setFileIndex} /></nav>
          <section className="human-review-diff" aria-label={t("Captured diff")}>{file ? <><h5>{file.path} · {file.status}</h5>{file.oversized ? <p role="status">{t("This file exceeds the review size limit.")}</p> : file.binary ? <p role="status">{t("Binary file: a text diff is unavailable.")}</p> : <pre tabIndex={0}>{file.diff}</pre>}</> : <p role="status">{t("No changed files in this snapshot.")}</p>}</section>
        </div>
      </>}</div>
      <section aria-label={t("Review discussion")}>{detail.messages.filter(m => chatIds.has(m.chat_id)).map(m => <article className="factory-message" key={m.id}><p>{m.content}</p></article>)}
        {history}
        <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await factoryRequest(`/implementations/${detail.implementation.id}/human-review/messages`, { review_id: review.id, content: text, idempotency_key: key }); setText(""); setKey(crypto.randomUUID()); }); }}>
          <label>{t("Discuss this review")}<textarea className="input factory-input" value={text} maxLength={20000} required onChange={event => setText(event.target.value)} /></label>
          <button className="btn factory-button" disabled={busy || review.condition !== "ready" || !text.trim()}>{t("Send discussion")}</button>
        </form>
      </section></div>
    </>}
    {!review && history}
  </div>;
}
