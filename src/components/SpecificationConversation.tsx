import { useRef, useState } from "react";
import type { FactoryDetail, FactoryMessage, SpecificationVersion } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";

/** The rendered revision is also the authority boundary for both owner controls. */
export function SpecificationConversation({ detail, specification, busy, perform }: { detail: FactoryDetail; specification: SpecificationVersion; busy: boolean; perform: (work: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [reply, setReply] = useState("");
  const replyIdentity = useRef(crypto.randomUUID());
  const prefix = `/implementations/${detail.implementation.id}/specification-acceptance`;
  const accepted = detail.approvals.some(a => a.kind === "specification" && a.revision === specification.id);
  const chatIds = new Set(detail.chats.filter(c => c.title === "Specifications").map(c => c.id));
  const replies: FactoryMessage[] = detail.messages.filter(m => chatIds.has(m.chat_id));
  return <div className="specification-conversation">
    <div className="factory-actions">
      <button className="btn factory-button" disabled={busy || accepted} onClick={() => void perform(async () => { await factoryRequest(prefix, { specification_id: specification.id, hash: specification.hash, source: "button" }); })}>{t("Accept specification")}</button>
      {accepted && <p role="status">{t("Specification accepted")}</p>}
    </div>
    <p>{t("Revision {revision}", { revision: specification.revision })}</p>
    <Markdown>{specification.content}</Markdown>
    {replies.map(message => <article className="factory-message" key={message.id}><small>{t("Specification reply")} · {new Date(message.created_at).toLocaleString()}</small><Markdown>{message.content}</Markdown></article>)}
    <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      await factoryRequest(prefix, { specification_id: specification.id, hash: specification.hash, source: "owner_chat", content: reply, idempotency_key: replyIdentity.current });
      setReply(""); replyIdentity.current = crypto.randomUUID();
    }); }}>
      <label>{t("Specification reply")}<textarea className="input factory-input" required maxLength={20_000} value={reply} disabled={busy} onChange={event => { setReply(event.target.value); replyIdentity.current = crypto.randomUUID(); }} /></label>
      <p className="field-hint">{t("Reply accepted to approve this revision, or use Accept specification.")}</p>
      <button className="btn factory-button" disabled={busy || !reply.trim()}>{t("Send reply")}</button>
    </form>
  </div>;
}
