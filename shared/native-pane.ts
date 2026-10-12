import type { HerdrPane } from "./protocol.ts";

/** A CLI can start a fresh history while keeping its native terminal. */
export function nativeSessionRef(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  return session ? JSON.stringify([session.agent, session.kind, session.value]) : null;
}
