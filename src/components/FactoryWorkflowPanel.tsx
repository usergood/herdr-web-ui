import { useEffect, useState } from "react";
import type { FactoryAction, FactoryCapabilities, FactoryDetail, FactoryProvider } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

type Perform = (action: () => Promise<void>) => Promise<void>;
export function FactoryWorkflowPanel({ detail, machineId, provider, busy, perform }: { detail: FactoryDetail; machineId: string; provider: FactoryProvider; busy: boolean; perform: Perform }) {
  const t = useT();
  const [capabilities, setCapabilities] = useState<FactoryCapabilities | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const prefix = `/implementations/${detail.implementation.id}`;
  useEffect(() => {
    let live = true;
    setCapabilities(null); setProblem(null);
    factoryRequest<FactoryCapabilities>(`/providers?machine_id=${encodeURIComponent(machineId)}`).then((result) => { if (live) setCapabilities(result); }, (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [machineId]);
  const capability = capabilities?.providers.find((entry) => entry.provider === provider);
  const active = detail.runs.some((run) => ["accepted", "working", "needs_you", "blocked", "disconnected", "interrupted"].includes(run.condition));
  const start = (action: FactoryAction) => perform(async () => { await factoryRequest(`${prefix}/runs`, { action, idempotency_key: crypto.randomUUID(), expected: { provider, machine_id: machineId, project_id: detail.implementation.project_id, specification_id: detail.specifications.at(-1)?.id ?? null, graph_hash: detail.graph_hash } }); });
  return <section className="factory-section"><h3>{t("Workflow")}</h3>
    <p>{provider} · {capability?.version ?? t("Not verified")}</p>
    {problem && <p role="status">{problem}</p>}
    {capability && !capability.factory_ready && <p role="status">{capability.reasons.join(". ")}</p>}
    <div className="factory-actions"><button className="btn factory-button" disabled={busy || active} onClick={() => void perform(async () => { setCapabilities(await factoryRequest(`/machines/${encodeURIComponent(machineId)}/prepare`, {})); })}>{t("Prepare this Machine")}</button>
      <button className="btn factory-button" disabled={busy || active || !capability?.installed || !capability.skills_verified} onClick={() => void start("verify-provider")}>{t("Start native verification")}</button>
      <button className="btn factory-button" disabled={busy || !detail.runs.some((run) => run.action === "verify-provider")} onClick={() => void perform(async () => { const run = detail.runs.filter((run) => run.action === "verify-provider").at(-1)!; setCapabilities(await factoryRequest(`/runs/${run.id}/verify-provider`, {})); })}>{t("Verify native evidence")}</button>
      <button className="btn factory-button" disabled={busy || active || !capability?.installed || !capability.skills_verified} onClick={() => void start("setup")}>{t("Set up Project skills")}</button>
      <button className="btn factory-button" disabled={busy || active || !capability?.installed || !capability.skills_verified} onClick={() => void start("grill-me")}>{t("Grill me")}</button>
      <button className="btn factory-button" disabled={busy || active || !detail.implementation.project_id || !capability?.installed || !capability.skills_verified} onClick={() => void start("grill-with-docs")}>{t("Grill with docs")}</button>
      <button className="btn factory-button" disabled={busy || active || !capability?.installed || !capability.skills_verified} onClick={() => void start("to-spec")}>{t("Create specification")}</button>
      <button className="btn factory-button" disabled={busy || active || !detail.implementation.project_id || !capability?.installed || !capability.skills_verified} onClick={() => void start("to-tickets")}>{t("Plan tickets")}</button>
      <button className="btn btn-primary" disabled={busy || active || !capability?.factory_ready} onClick={() => void start("implement-spec")}>{t("Start factory")}</button>
    </div>
    <h4>{t("Questions")}</h4>{detail.questions.map((entry) => <article className="factory-message" key={entry.id}><p>{entry.question}</p>{entry.answer === null ? <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/questions/${entry.id}/answer`, { revision: entry.revision, answer: answers[entry.id] ?? "" }); }); }}><label>{t("Your answer")}<textarea className="input factory-input" required value={answers[entry.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [entry.id]: event.target.value }))} /></label><button className="btn factory-button" disabled={busy}>{t("Save answer")}</button></form> : <p>{entry.answer}</p>}</article>)}
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/questions`, { question }); setQuestion(""); }); }}><label>{t("Open question")}<textarea className="input factory-input" value={question} required onChange={(event) => setQuestion(event.target.value)} /></label><button className="btn factory-button" disabled={busy}>{t("Record question")}</button></form>
    {detail.questions.length > 0 && <button className="btn factory-button" disabled={busy || detail.questions.some((entry) => entry.answer === null)} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "shared_understanding", revision: detail.question_revision, scope: detail.questions.map((entry) => `${entry.question}\n${entry.answer}`).join("\n\n") }); })}>{t("Confirm shared understanding")}</button>}
    {detail.questions.length > 0 && detail.runs.at(-1) && <button className="btn factory-button" disabled={busy || detail.questions.some((entry) => entry.answer === null)} onClick={() => void perform(async () => { const delivery = await factoryRequest<{ condition: string }>(`/runs/${detail.runs.at(-1)!.id}/send-answers`, { revision: detail.question_revision, idempotency_key: crypto.randomUUID() }); if (delivery.condition !== "sent") throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again.")); })}>{t("Send answered context")}</button>}
  </section>;
}
