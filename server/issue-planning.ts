import type { IssuePlanning } from "../shared/issue-planning.ts";
import type { ProjectGitHubSource } from "../shared/github-project.ts";
import type { FactoryTicket } from "../shared/factory.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { isJsonObject } from "./http.ts";

type PlannedTicket = { key: string; title: string; acceptance: string; dependencies: string[] };
function ticketBreakdown(text: string): PlannedTicket[] | null {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^```json\s*\n([\s\S]*)\n```$/, "$1")); } catch { return null; }
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const keys = new Set<string>();
  for (const ticket of value) {
    if (!isJsonObject(ticket) || typeof ticket.key !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(ticket.key) || keys.has(ticket.key) || typeof ticket.title !== "string" || !ticket.title.trim() || ticket.title.length > 200 || typeof ticket.acceptance !== "string" || !ticket.acceptance.trim() || ticket.acceptance.length > 20_000 || !Array.isArray(ticket.dependencies) || ticket.dependencies.some(key => typeof key !== "string")) return null;
    keys.add(ticket.key);
  }
  const planned = value as PlannedTicket[];
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    const ticket = planned.find(ticket => ticket.key === key);
    if (!ticket) return false;
    visiting.add(key);
    if (!ticket.dependencies.every(visit)) return false;
    visiting.delete(key); visited.add(key); return true;
  };
  return [...keys].every(visit) ? planned : null;
}

/** Conservative structured-plan reader. Source text is data, never agent instructions. */
function sections(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const aliases: Record<string, string> = { scope: "scope", "what to build": "scope", "acceptance criteria": "acceptance criteria", dependencies: "dependencies", "testing seams": "testing seams", "test plan": "testing seams", "testing decisions": "testing seams", tickets: "tickets" };
  const headings = [...content.matchAll(/^#{1,6}\s+([^\n]+)\r?$/gm)];
  for (const [index, heading] of headings.entries()) {
    const key = aliases[heading[1]!.trim().toLowerCase()];
    if (key) result[key] = key in result ? "" : content.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? content.length).trim();
  }
  return result;
}

/** A known edit to selected scope asks the owner while preserving the previous graph. */
export function reconcileIssuePlan(store: FactoryStore, source: ProjectGitHubSource): void {
  const prior = store.get<IssuePlanning>("github_plans", source.id);
  if (prior?.condition !== "prepared" || !source.current || prior.trusted_scope.body === source.current.body && prior.trusted_scope.title === source.current.title && JSON.stringify(prior.trusted_scope.native_dependencies) === JSON.stringify(source.current.native_dependencies)) return;
  const workflow = new FactoryWorkflow(store);
  const question = workflow.mutate(source.implementation_id, "questions", { question: "Resolve only these planning decisions: changed scope or testing seams. Review the current issue plan and renew trusted readiness, or retain an explicitly approved app plan. Answers alone do not authorize changed scope." }) as import("../shared/factory.ts").FactoryQuestion;
  store.put("github_plans", { ...prior, condition: "needs_you", question_ids: [...prior.question_ids, question.id] }, source.implementation_id);
}

/** Selected planning only: this operation never launches a Run. */
export function prepareIssuePlan(store: FactoryStore, source: ProjectGitHubSource, questionRevision?: unknown): IssuePlanning {
  return store.db.transaction(() => {
    const approval = source.readiness?.approval;
    if (!source.readiness?.eligible || !approval || !source.current) throw new FactoryError("issue_not_ready", "Resolve current issue readiness before reusing planning", 409);
    const workflow = new FactoryWorkflow(store);
    const prior = store.get<IssuePlanning>("github_plans", source.id);
    const questions = workflow.questions(source.implementation_id);
    const pending = questions.filter(question => question.answer === null);
    const retained = workflow.specification(source.implementation_id);
    const appPlan = retained && workflow.approved(source.implementation_id, "specification", retained.id) && workflow.approved(source.implementation_id, "testing_seams", retained.id) ? retained : null;
    const currentAppPlan = !appPlan || workflow.issueApproved(source, "specification", appPlan.id) && workflow.issueApproved(source, "testing_seams", appPlan.id) && (!workflow.tickets(source.implementation_id).length || workflow.issueGraphApproved(source));
    if (currentAppPlan && prior?.condition === "prepared" && !pending.length && (!questions.length || prior.consumed_question_revision === workflow.questionRevision(source.implementation_id)) && prior.source_revision === source.revision && prior.authorization.approval.id === approval.id && retained?.id === prior.specification_id && workflow.graphHash(source.implementation_id) === prior.graph_hash) return prior;
    const content = appPlan?.content ?? source.current.body;
    const plan = sections(content);
    const breakdown = plan.tickets ? ticketBreakdown(plan.tickets) : null;
    const id = source.implementation_id;
    const retainedGraph = appPlan && workflow.tickets(id).length && workflow.issueGraphApproved(source);
    const missing = (appPlan ? [] : ["scope", "acceptance criteria", "dependencies", "testing seams"]).filter(key => !plan[key] || /\b(?:TBD|TODO|undecided|to be decided)\b/.test(plan[key]!));
    if (!currentAppPlan) missing.push("explicit approval of the retained app specification, testing seams and Ticket graph for the current issue scope");
    if (prior?.condition === "prepared" && (prior.trusted_scope.body !== source.current.body || prior.content !== content)) missing.push("changed scope or testing seams");
    if (!retainedGraph && ("tickets" in plan || content.length > 20_000) && !breakdown) missing.push("an unambiguous bounded Ticket breakdown with acceptance criteria and acyclic dependency keys");
    if (missing.length || pending.length) {
      const questionIds = prior?.question_ids ?? [];
      const prompt = `Resolve only these planning decisions: ${missing.join(", ")}. Update the issue plan and renew trusted readiness, or retain an explicitly approved app plan. Answers alone do not authorize changed scope.`;
      if (missing.length && !questions.some(question => questionIds.includes(question.id) && question.answer === null)) {
        const question = workflow.mutate(id, "questions", { question: prompt }) as import("../shared/factory.ts").FactoryQuestion;
        questionIds.push(question.id);
      }
      const waiting: IssuePlanning = { ...store.record(), id: source.id, implementation_id: id, source_id: source.id, source_revision: source.revision, trusted_scope: source.current, condition: "needs_you", origin: appPlan ? "app_plan" : "issue_body", content, dependencies: plan.dependencies ?? "", testing_seams: plan["testing seams"] ?? "", specification_id: appPlan?.id ?? null, graph_hash: null, question_ids: questionIds, consumed_question_revision: null, authorization: { approval, checks_required: true, independent_reviews: ["standards", "spec"] } };
      store.put("github_plans", waiting, id); store.event(id, "issue_plan_needs_owner", waiting);
      return waiting;
    }
    const answeredRevision = workflow.questionRevision(id);
    if (questions.length && questionRevision !== answeredRevision) throw new FactoryError("answers_unconsumed", "Consume the exact answered question revision before preparing planning", 409);
    const specification = appPlan ?? workflow.mutate(id, "specifications", { content }) as import("../shared/factory.ts").SpecificationVersion;
    const planned = breakdown ?? [{ key: "scope", title: source.current.title.slice(0, 200), acceptance: content, dependencies: [] }];
    const keys = new Map(planned.map(ticket => [ticket.key, store.record().id]));
    const tickets: FactoryTicket[] = planned.map(ticket => ({ ...store.record(), id: keys.get(ticket.key)!, implementation_id: id, specification_id: specification.id, title: ticket.title, acceptance: ticket.acceptance, dependencies: [...new Set(ticket.dependencies)].map(key => keys.get(key)!), status: "proposed", tracker_reference: null }));
    const graphHash = retainedGraph ? workflow.graphHash(id) : hash(JSON.stringify(tickets));
    if (!retainedGraph) {
      const graph = { specification_id: specification.id, hash: graphHash, tickets, issue_scope: workflow.issueApprovalScope(source) };
      store.put("graphs", { ...graph, id }, id);
      store.put("graph_versions", { ...store.record(), ...graph }, id);
    }
    const appApprovals = store.list<import("../shared/factory.ts").FactoryApproval>("approvals", id).filter(approval => approval.issue_scope?.source_id === source.id && approval.issue_scope.scope_hash === workflow.issueApprovalScope(source).scope_hash);
    const prepared: IssuePlanning = { ...store.record(), id: source.id, implementation_id: id, source_id: source.id, source_revision: source.revision, trusted_scope: source.current, condition: "prepared", origin: appPlan ? "app_plan" : "issue_body", content, dependencies: plan.dependencies ?? "", testing_seams: plan["testing seams"] ?? appApprovals.filter(approval => approval.kind === "testing_seams" && approval.revision === specification.id).at(-1)!.scope, specification_id: specification.id, graph_hash: graphHash, question_ids: prior?.question_ids ?? [], consumed_question_revision: questions.length ? answeredRevision : null, ...(appPlan ? { app_approval_ids: appApprovals.filter(approval => approval.revision === specification.id || approval.kind === "ticket_graph" && approval.revision === graphHash).map(approval => approval.id) } : {}), authorization: { approval, checks_required: true, independent_reviews: ["standards", "spec"] } };
    store.put("github_plans", prepared, id);
    store.put("github_plan_versions", { ...prepared, id: store.record().id }, id);
    store.event(id, "issue_plan_prepared", prepared);
    return prepared;
  })();
}
