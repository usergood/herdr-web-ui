# Automatic review and PR publication

For automatically accepted Specifications, the backend continues a checked execution plan with separate app-owned Standards and Spec workers. Reviewer is a display group; it allocates no third agent. Both reports must cover the final checked integration commit. Historical Runs keep their frozen workflow.

Failed reports are copied into immutable automatic finding batches. Fresh Review-fixes workers remain beneath Orchestrator, use the accepted Tickets and shared-path claims, and receive the full original reports. The backend integrates their candidates, reruns configured checks and starts fresh independent reviewers. Repaired-head/check/report references are retained separately from the original findings. Automatic repair stops after three rounds; uncertain Machine observations stop after six attempts. Native prompts, unanswered scope questions and exhausted recovery remain visible.

Before accepting the Specification, configure the Project's PR repository and target branch in execution settings and select its verified GitHub account on the execution Machine. These settings freeze with the Run. Without a destination, passing review waits visibly; changing live Project settings does not retroactively authorize an old Run.

The Machine verifies the owned clean worktree, frozen origin, branch and account. It pushes only the accepted branch without force, then creates a PR for that exact head and target. A durable creation intent and unique Run/head marker allow lookup after a lost response or restart. Unknown creation outcomes are observed rather than posted again. A conflicting branch, mismatched PR, changed workspace or denied permission retains the problem and its ownership.

Assignment detail exposes `automatic_review`, original automatic finding batches through its scoped tracker contract, independent reports and `pull_requests` with the check/report IDs for the published head. Desktop/mobile progress shows review, repairs, reasons, reports and the PR link. PR publication leaves the Assignment in review with `pr_open`; it does not mark Done or authorize merge. Human Review and delivery remain separately scoped.

Validation uses authenticated HTTP with disposable Machine/GitHub/repository fixtures and the real desktop/mobile client. `server/factory-automatic-review.contract.test.ts`, `server/factory-publication.contract.test.ts` and `scripts/factory-automatic-review-browser-regression.ts` cover the workflow without paid agents or live GitHub mutations.
