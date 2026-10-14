import type { ProjectIssuePlan } from "../shared/github-project.ts";

/** Both publication and approval must accept the same bounded issue plan. */
export function validIssuePlan(value: unknown): value is ProjectIssuePlan {
    const plan = value as ProjectIssuePlan | null;
    const strings = (items: unknown, required = false): items is string[] => Array.isArray(items) && (!required || items.length > 0) && items.length <= 100 && items.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 10_000);
    if (!plan || typeof plan.acceptance_criteria !== "string" || !plan.acceptance_criteria.trim() || plan.acceptance_criteria.length > 50_000 || !strings(plan.testing_seams, true) || !strings(plan.planning_decisions) || !Array.isArray(plan.dependencies) || plan.dependencies.length > 100 || plan.dependencies.some(item => !item || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(item.repository) || !Number.isSafeInteger(item.issue_number) || item.issue_number < 1 || !["merge", "release"].includes(item.requires))) return false;
    return true;
}
