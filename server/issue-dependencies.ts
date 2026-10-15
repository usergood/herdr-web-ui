import type { GitHubDependencyEdge, GitHubIssueDependency, ProjectGitHubSource } from "../shared/github-project.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { hash } from "./factory-host.ts";
import { issueReadiness, type ProjectReadinessPolicy } from "../shared/github-readiness.ts";
import type { IssuePlanning } from "../shared/issue-planning.ts";

export function dependencyPlan(store: FactoryStore, source: ProjectGitHubSource) {
  const workflow = new FactoryWorkflow(store);
  const specification = workflow.specification(source.implementation_id);
  const planning = store.get<IssuePlanning>("github_plans", source.id);
  const readiness = issueReadiness(store.get<ProjectReadinessPolicy>("github_readiness_policies", source.project_id), source);
  const reused = planning?.condition === "prepared" && planning.source_revision === source.revision && planning.specification_id === specification?.id && planning.content === specification?.content && readiness.eligible && planning.authorization.approval.id === readiness.approval?.id;
  const approved = specification && (reused || workflow.approved(source.implementation_id, "specification", specification.id) && workflow.approved(source.implementation_id, "testing_seams", specification.id));
  const revision = hash(JSON.stringify(approved ? [specification.id, specification.hash] : []));
  const declarations: { repository: string; number: number; requires: "merge" | "release" }[] = [];
  if (!approved) return { revision, declarations, conflicts: [] as string[], specification_id: null };
  const sections = [...specification.content.matchAll(/^#{1,6}\s+Dependencies\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/gim)];
  // Approved app Specifications need no Dependencies heading when they declare no edges.
  if (!sections.length) return { revision, declarations, conflicts: [] as string[], specification_id: specification.id };
  const section = sections[0]?.[1]?.trim();
  if (sections.length === 1 && /^none\.?$/i.test(section ?? "")) return { revision, declarations, conflicts: [] as string[], specification_id: specification.id };
  let parsed: unknown;
  try { parsed = JSON.parse((section ?? "").replace(/^```json\s*\n([\s\S]*)\n```$/, "$1")); } catch { parsed = null; }
  if (sections.length !== 1 || !Array.isArray(parsed) || parsed.length > 100 || parsed.some(edge => !edge || typeof edge.repository !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(edge.repository) || !Number.isSafeInteger(edge.number) || edge.number < 1 || !["merge", "release"].includes(edge.requires) || Object.keys(edge).some(key => !["repository", "number", "requires"].includes(key)))) return { revision, declarations, conflicts: ["Approved plan dependencies need explicit repository, issue number and merge or release requirements."], specification_id: specification.id };
  return { revision, declarations: parsed as typeof declarations, conflicts: [] as string[], specification_id: specification.id };
}

/** Only an approved plan's explicit Dependencies section creates executable edges. */
export function combinedDependencies(store: FactoryStore, source: ProjectGitHubSource, native: GitHubIssueDependency[], sources: ProjectGitHubSource[]): GitHubDependencyEdge[] {
  const edges: GitHubDependencyEdge[] = native.map(edge => ({ ...edge, requires: "merge", provenance: [{ kind: "github_native", source_revision: source.revision }], implementation_id: null, resolution: "missing", blocker: "missing" }));
  const plan = dependencyPlan(store, source);
  for (const dependency of plan.declarations) {
    let edge = edges.find(edge => edge.repository.toLowerCase() === dependency.repository.toLowerCase() && edge.number === dependency.number);
    if (!edge) {
      const target = sources.find(target => target.current?.repository.toLowerCase() === dependency.repository.toLowerCase() && target.number === dependency.number);
      edge = { repository: dependency.repository, number: dependency.number, external_id: target?.external_id ?? "", url: `https://github.com/${dependency.repository}/issues/${dependency.number}`, state: target?.current?.state ?? "open", source_updated_at: target?.current?.source_updated_at ?? source.current!.source_updated_at, requires: "merge", provenance: [], implementation_id: null, resolution: "missing", blocker: "missing" };
      edges.push(edge);
    }
    if (dependency.requires === "release") edge.requires = "release";
    if (!edge.provenance!.some(provenance => provenance.kind === "app_plan")) edge.provenance!.push({ kind: "app_plan", specification_id: plan.specification_id! });
  }
  return edges.sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
}
