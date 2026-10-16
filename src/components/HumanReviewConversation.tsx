import { factoryReasonRole } from "../lib/factoryPresentation.ts";
import { useState, type ReactNode } from "react";
import type { FactoryDetail, ReviewSnapshot } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import "./HumanReviewConversation.css";
import { ReviewDrafts, ReviewLineComments, type ReviewCompositions } from "./HumanReviewComments.tsx";

function ChangedFiles({ files, selected, choose, prefix = "" }: { files: ReviewSnapshot["files"]; selected: number; choose: (index: number) => void; prefix?: string }) {
  const directories = [...new Set(files.flatMap(file => {
    if (!file.path.startsWith(prefix)) return [];
    const rest = file.path.slice(prefix.length); return rest.includes("/") ? [rest.split("/")[0]!] : [];
  }))];
  return <ul className="human-review-files">{directories.map(name => <li key={name}><details open><summary>{name}</summary><ChangedFiles files={files} prefix={`${prefix}${name}/`} selected={selected} choose={choose} /></details></li>)}{files.map((file, index) => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/") && <li key={`${file.status}:${file.path}`}><button className="project-navigation-row" aria-current={selected === index ? "true" : undefined} onClick={() => choose(index)}>{file.path} · {file.status}</button></li>)}</ul>;
}

export function HumanReviewConversation({ detail, busy, perform, history }: { detail: FactoryDetail; busy: boolean; history: ReactNode; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const review = detail.human_reviews?.at(-1);
  const [compositions, setCompositions] = useState<ReviewCompositions>({});
  const composing = Object.values(compositions).some(draft => !!draft.text.trim());
  const [editingDrafts, setEditingDrafts] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [text, setText] = useState(""); const [key, setKey] = useState(() => crypto.randomUUID());
  const approval = detail.human_review_approvals?.filter(a => a.review_id === review?.id && !a.superseded_by_batch_id).at(-1);
  const retainedComments = detail.comments.some(c => c.status !== "resolved");
  const snapshot = detail.snapshots.find(s => s.id === review?.snapshot_id);
  const file = snapshot?.files[fileIndex];
  const chatIds = new Set(detail.chats.filter(c => c.title === "Human Review").map(c => c.id));
  const assistant = detail.runs.find(r => r.id === review?.assistant_run_id);
  const drafts = detail.comments.filter(c => c.batch_id === null && !c.resolution && ["draft", "outdated"].includes(c.status));
  const batch = detail.human_feedback_batches?.filter(b => b.review_id === review?.id).at(-1);
  const progress = detail.automatic_review?.find(r => r.run_id === review?.run_id);
  const repairing = review?.condition === "repairing";
  const feedbackReady = !busy && review?.condition === "ready" && drafts.length > 0 && drafts.every(c => c.status === "draft" && c.snapshot_id === review.snapshot_id) && !composing && !drafts.some(c => editingDrafts.includes(c.id)) && !text.trim() && (!approval || approval.condition === "blocked" && approval.merge_not_sent) && !detail.implementation.pause && !detail.implementation.deletion;
  const waiting = detail.capacity_waiting?.filter(w => w.id.startsWith("discussion:"));
  return <div className="human-review-conversation">
    {!review ? <p role="status">{t("Human Review opens automatically after checks, independent reviews and PR publication.")}</p> : <>
      {repairing && progress?.condition !== "blocked" && approval?.condition !== "blocked" ? <p role="status">{batch?.merge_authorized ? t("Approved fixes are running. Merge follows passing checks and independent reviews.") : t("Fixes are running. A later approval is required to merge.")}</p> : batch?.resolution && review.head === batch.resolution.head && !batch.merge_authorized ? <p role="status">{t("Fixes passed checks and independent reviews. Awaiting your approval.")}</p> : null}
      {repairing && progress?.reason && <p role={progress.condition === "blocked" ? "alert" : "status"}>{progress.reason}</p>}
      <div className="factory-actions"><button className="btn factory-button" disabled={!feedbackReady} onClick={() => void perform(async () => {
        await factoryRequest(`/implementations/${detail.implementation.id}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id!, head: review.head, disposition: "decline", comment_ids: drafts.map(c => c.id), idempotency_key: `decline-${review.snapshot_id}` });
      })}>{t("Decline")}</button><p>{t("Decline submits all saved drafts for repair and grants no merge authority.")}</p></div>
      {drafts.length > 0 && <div className="factory-actions"><button className="btn factory-button" disabled={!feedbackReady} onClick={() => void perform(async () => {
        await factoryRequest(`/implementations/${detail.implementation.id}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id!, head: review.head, disposition: "approve", comment_ids: drafts.map(c => c.id), idempotency_key: `approve-comments-${review.snapshot_id}` });
      })}>{t("Approve with comments")}</button><p>{t("Approval submits all saved comments for repair, then merges after passing checks and independent reviews. No further approval is required.")}</p></div>}
      <p role={review.condition === "blocked" ? "alert" : "status"}>{review.reason ?? t("Review the captured result and discuss it with the assistant.")}</p>
      <p className="field-hint">{t("Approval merges this checked and independently reviewed candidate into its authorized target.")}</p>
      {approval && <p role={approval.condition === "blocked" ? "alert" : "status"}>{approval.reason ?? (approval.condition === "released" ? t("Release verified") : approval.condition === "merged" ? t("Merge verified") : t("Merge approval retained"))}</p>}
      {(retainedComments || composing || text.trim()) && <p role="status">{t("Finish your draft comments before approving without comments.")}</p>}
      <button className="btn factory-button" disabled={busy || review.condition !== "ready" || !review.snapshot_id || retainedComments || composing || !!text.trim() || !!approval && approval.condition !== "blocked"} onClick={() => void perform(async () => {
        if (!review.snapshot_id) return;
        await factoryRequest(`/implementations/${detail.implementation.id}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `approve-${review.snapshot_id}` });
      })}>{t("Approve and merge")}</button>
      {assistant?.waiting_reason && <p role={factoryReasonRole(assistant.condition)}>{assistant.waiting_reason}</p>}
      {detail.human_review_deliveries?.filter(d => d.reason).map(d => <p role={d.condition === "uncertain" ? "alert" : "status"} key={d.id}>{d.reason}</p>)}
      {waiting?.map(w => <p role={factoryReasonRole(w.condition)} key={w.id}>{w.reason}</p>)}
      <div className="human-review-layout"><div className="human-review-candidate">{snapshot && <>
        <details className="human-review-provenance"><summary>{t("Review snapshot")}</summary><dl><dt>{t("Review snapshot")}</dt><dd>{snapshot.id}</dd><dt>{t("Before")}</dt><dd>{snapshot.base}</dd><dt>{t("After")}</dt><dd>{snapshot.head}</dd><dt>{t("Captured workspace")}</dt><dd>{snapshot.machine_id} · {snapshot.mode} · {snapshot.hash}</dd></dl></details>
        <div className="human-review-changes"><nav aria-label={t("Changed files")}><ChangedFiles files={snapshot.files} selected={fileIndex} choose={setFileIndex} /></nav>
          <section className="human-review-diff" aria-label={t("Captured diff")}>{file ? <><h5>{file.path} · {file.status}</h5>{file.oversized ? <p role="status">{t("This file exceeds the review size limit.")}</p> : file.binary ? <p role="status">{t("Binary file: a text diff is unavailable.")}</p> : <ReviewLineComments snapshot={snapshot} file={file} busy={busy || repairing} perform={perform} compositions={compositions} setCompositions={setCompositions} />}</> : <p role="status">{t("No changed files in this snapshot.")}</p>}</section>
        </div>
      </>}<ReviewDrafts detail={detail} busy={busy || repairing} perform={perform} editingChanged={(id, editing) => setEditingDrafts(current => editing ? [...new Set([...current, id])] : current.filter(key => key !== id))} /></div>
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
