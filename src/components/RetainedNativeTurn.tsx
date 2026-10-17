import type { ConversationTurn } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { turnRevision } from "../lib/turnRevision.ts";
import { Markdown } from "./Markdown.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";

/** Keep one unreadable retained message from unmounting the Assignment. */
export function RetainedNativeTurn({ turn }: { turn: ConversationTurn }) {
  const t = useT();
  return <RenderBoundary resetKey={turnRevision(turn, true)} fallback={() => <p role="alert">{t("This preview can't be shown.")}</p>}>
    <article className="factory-message"><small>{turn.role} · {turn.ts}</small>{turn.parts.map((part, index) => part.kind === "text" ? <Markdown key={index}>{part.text}</Markdown> : part.kind === "skill" ? <small key={index}>{part.skill.name} · {part.skill.status}</small> : part.kind === "tool" ? <details key={index}><summary>{part.name} · {part.summary}</summary><pre>{part.output}</pre></details> : null)}</article>
  </RenderBoundary>;
}
