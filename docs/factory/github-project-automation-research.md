# Project GitHub import and pull-request automation research

Research date: 2026-10-11. Primary GitHub REST, GraphQL and GitHub CLI documentation only. This note proposes an implementation; no issue, review, reviewer request, branch, merge, repository setting, or external message was created or changed.

## Recommended boundary

Use one account-scoped GitHub adapter for Project issue/PR import and polling, one central eligibility evaluator, and one serialized mutation controller. The evaluator consumes a complete remote snapshot plus our Standards/Spec validator results. It should return either an explicitly eligible action or concrete waiting/blocking reasons. Imported text and a worker's claim that a task is finished must not grant mutation authority. This architecture is a recommendation, not a GitHub feature.

Keep “read/import,” “queue rework,” “update owned PR branch,” “request reviewers,” and “merge” as separate Project policy capabilities. Each action must retain the Project, repository identity, bound GitHub account identity, expected head and policy version. The Project import button should not silently enable automation for every imported PR.

## Import and durable identity

GitHub's issue endpoints can return both issues and PRs; a `pull_request` field distinguishes PRs. The issue `id` of such a row is not its pull-request database ID. Fetch PR details from the pull-request endpoint before binding execution or merge state. Repository issue listing supports `state`, `since`, sort/order and pagination. [Issue API](https://docs.github.com/en/rest/issues/issues#list-repository-issues)

Recommended import identity: GitHub host + repository node/database ID + issue/PR number + kind, retaining canonical URL and current owner/name. Keep source title/body/labels/assignees/state and fetch time as imported evidence, distinct from our editable implementation/specification. Store PR head repository/ref/SHA, base repository/ref/SHA and draft/merged state separately. Repository IDs help survive the authorized repository rename.

Use issue/PR URLs or owner/repository/number as selectors; do not let imported Markdown select an arbitrary API host, executable or credential. An issue import can become a new Implementation; an imported PR can become a review/repair task without creating a duplicate coding task. Preserve deduplication on remote identity and explicit links to any app-created PR. These are recommended product semantics.

REST lists must follow every `Link: rel="next"` page, normally with `per_page=100`. GraphQL connections require `first` or `last` in 1–100 and advancing `pageInfo.endCursor` until `hasNextPage=false`. Each nested reviews/threads/comments/checks connection needs independent pagination. Reaching an application page/byte deadline marks the snapshot incomplete; it must never mean “no more findings.” [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api), [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)

## Remote reviews and outstanding work

REST `GET /repos/{owner}/{repo}/pulls/{number}/reviews` returns reviews chronologically, with reviewer identity, state, `submitted_at` and `commit_id`. Pending reviews lack submission time. The creation API can attach a review to an explicit commit; approvals, change requests and ordinary comments are different events. Review-summary updates change text, not the review decision. Retain all pages rather than choosing the final array row globally. [Review API](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request)

GraphQL exposes `reviewDecision`, `latestOpinionatedReviews(writersOnly: false)`, `latestReviews`, `reviewRequests`, and `reviewThreads`. Reviews expose `commit.oid`; threads expose `isResolved`, `isOutdated` and resolution permissions. `latestReviews` is per-user and excludes pending reviews. The opinionated field and repository decision are useful cross-checks; the public field descriptions do not fully specify every history-reduction edge case. Preserve full history and fail closed if those views disagree. An outdated thread is not automatically resolved. [Current GraphQL schema](https://docs.github.com/en/graphql/reference/pulls#pullrequest), [review fields](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview), [thread fields](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread)

Recommended reduction:

- Group by stable reviewer identity, not display name; keep the latest effective submitted opinion and its reviewed SHA.
- `APPROVED` qualifies only when that review covers the current PR head, the reviewer meets the configured identity/permission policy, and it has not been dismissed or superseded by a change request.
- `COMMENTED`, `PENDING` and `DISMISSED` never create an approval. A later ordinary comment must not erase an earlier unresolved change request.
- A new head invalidates prior positive eligibility. Historical change-request evidence remains visible; a push alone is not proof that it was addressed.
- Keep pending reviewer requests separate from submitted opinions. Required outstanding reviewers or unsubmitted work keep the task waiting.
- Fetch all review threads and block on unresolved threads, including outdated ones. A worker's “fixed” message must not substitute for GitHub resolution.
- Distinguish review summary text, inline thread replies and general PR issue comments. Import all as evidence; only explicit findings/change requests should create automatic repair work.

These rules intentionally strengthen the merge gate beyond a green summary badge. GitHub can permit informational change requests when protection does not require reviews; we should still honor the Project's explicit policy. Authors cannot approve their own PRs, including when another local profile authenticates as the same GitHub user. Repository rules can dismiss stale approvals and require approval of the latest push. [Required-review behavior and self-approval restriction](https://docs.github.com/en/enterprise-cloud%40latest/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)

Our central Standards and Spec validators should produce independent, structured, persisted results bound to head SHA, base/diff identity, policy/specification version and evidence artifacts. A result from an older head or a missing validator is waiting, not passing. App validator completion is distinct from GitHub `APPROVED`: publishing under the PR author's account cannot satisfy a required independent GitHub approval. An explicit Project policy must define whether it also requires external approvals and from whom.

## Checks and merge eligibility

Inspect both check runs and legacy commit statuses. Check runs include name, status/conclusion, associated SHA and GitHub App identity; the API can filter by `app_id`. Legacy combined status describes status contexts and its `total_count`; it does not replace check-run inspection. A missing check or an unknown conclusion cannot satisfy a configured validator. [Check-run API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [combined commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)

GitHub branch protection can require named checks from a particular App, current-base testing, resolved conversations, required approvals and the latest-push approval. Reading classic protection through REST requires fine-grained Administration-read; lack of permission to inspect protection is not proof of no rules. Preserve server-side enforcement and our configured minimum checks independently. [Branch protection API](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection), [protected-branch semantics](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Recommended eligibility is the conjunction of: open/non-draft PR; correct bound repository/base; complete fresh snapshot; explicit merge policy; current Standards pass; current Spec pass; accepted current check results from trusted contexts/Apps; configured current-head approvals; no active change requests or unresolved threads; known clean mergeability; and no required base update. Record why each condition passed. Empty arrays and `null` values must not pass by vacuous truth.

GitHub's PR `mergeable` can be `null` while a background computation runs. Retry later with a bounded deadline. Merge and branch-update APIs provide different optimistic concurrency guards:

| Operation | Interface | Guard / important behavior |
| --- | --- | --- |
| Direct merge | `PUT /repos/{owner}/{repo}/pulls/{number}/merge` | Send `sha=<validated head>` and `merge_method=squash`; mismatched head yields `409`, unmergeable yields `405` |
| Update behind base | `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` | Send `expected_head_sha=<observed head>`; head mismatch yields `422`; success is asynchronous `202` |
| GraphQL guarded merge | `mergePullRequest` | Supply `expectedHeadOid`; do not omit its concurrency guard |

[REST merge/update specifications](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [update-branch specification](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch), [GraphQL merge guard](https://docs.github.com/en/graphql/reference/pulls#mergepullrequestinput)

Immediately before merging, refresh eligibility and compare head/base with the validated snapshot. Use an account-scoped local lease to serialize our own mutation attempts, persist an intent/receipt, and query the PR after a timeout before deciding to retry. A request accepted into a merge queue or an asynchronous `202` is not a completed merge. Current asynchronous merge APIs also support stacked PRs and may include open downstack PRs; do not use those paths implicitly for a single imported task. [Asynchronous merge behavior](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)

A head guard does not atomically compare our entire review snapshot or base SHA. GitHub protection/required checks remain the authority at mutation time; our preflight alone cannot make separate reads atomic. Avoid `--admin` or other bypass paths. Publishing our validator results as trusted required checks can let server rules participate in the final gate; it is a separate integration/permission decision.

## Behind-base updates and conflicts

For app-owned or explicitly delegated writable branches, request an update only when the configured policy requires current base. A `202` response enters `updating_base`; poll until the head changes or an explicit failure/deadline occurs, then invalidate every old approval/check/validator record and validate the new diff. A `422` may mean stale head, conflict or another validation failure: refresh remote state and classify its body, without retrying unchanged data indefinitely.

GitHub Apps also need permission to write Contents in the **head repository**, which can be a different fork. An upstream account's PR-write scope does not automatically grant arbitrary fork branch access. On user-owned forks, maintainer edits depend on the author's opt-in and upstream push access. Imported PRs from unwritable branches can be observed/reviewed, but branch repair requires an authorized writable path. [Update-branch permission note](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch), [fork edit permissions](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork)

A clean GitHub update is the smallest normal behind-base operation. Conflicts should produce an explicit repair task with retained head/base, conflict evidence, owned checkout and controlled push; resolve and rerun validators before review. Do not force-push another contributor's branch or treat “behind” as an instruction to rebase. This is a recommended authorization boundary.

## Repair and re-request cycle

Deduplicate repair work by PR identity + triggering review/finding ID/version + observed head + Project policy version. Coalesce new findings into the active repair rather than launching multiple workers against the same branch. Keep feedback text as untrusted task evidence under the already frozen provider/model/reasoning/permission/account settings.

After a pushed repair: observe the new remote SHA; rerun checks and both central validators; retain which findings the repair addressed; then request the configured reviewer(s) once for that new head. A reviewer request is a notification and must not repeat on every poll. Do not auto-dismiss change requests or resolve reviewers' threads simply to make the merge gate green.

REST supports `POST .../requested_reviewers` and, in the current documented API, `POST .../requested_reviewers/rerequest`, accepting reviewer logins/team slugs. Both require Pull-requests-write; re-request returns `201`, `403` or `422` when a user is not a collaborator. Pin the supported API version rather than assuming every GitHub Enterprise deployment exposes new endpoints. [Review-request API](https://docs.github.com/en/rest/pulls/review-requests#rerequest-reviewers-for-a-pull-request)

Requesting review requires repository write access; reviewers must have appropriate read access. Multiple/team reviewers have plan/account constraints. A reviewer who already reviewed can be requested again after changes. [Review-request permissions](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review)

## Polling and account isolation

Share a serialized per-account API queue across Projects, stagger/jitter polls, poll tracked PR review/check state independently from issue import, and persist `next_poll_at` rather than busy looping. Cache REST ETags per exact URL/query and account identity; conditional `If-None-Match` returning authenticated `304` reuses the retained response and does not consume primary quota. A PR-detail `304` alone says nothing about separately polled reviews/checks. [REST polling guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

Honor `Retry-After`; if remaining quota is zero, wait until `X-RateLimit-Reset`. For secondary limiting without either indicator, wait at least a minute and increase bounded retry delays. Other `403` responses can be permission failures, not rate limits; distinguish them. On authorization loss, incomplete data or backoff, preserve evidence and stop dependent mutations. [Rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)

## GitHub CLI fit

Existing private Project/Machine GitHub profiles can run `gh api` with explicit repository/host and scoped environment. `--paginate` follows REST pages; GraphQL pagination needs an `$endCursor` query variable and returned `pageInfo`; `--slurp` groups pages. Use `--include` when retaining cache/rate headers and `--input` for mutation JSON rather than interpolating review text into shell commands. Specifying fields normally changes the default method to POST, so read operations with query fields need explicit GET. [gh api manual](https://cli.github.com/manual/gh_api)

`gh pr view --json` is useful for summaries but exposes finite connections and no comprehensive review-thread field. Use paginated API reads for the authoritative snapshot. `gh pr merge --squash --match-head-commit <SHA>` supplies the head guard, while `--auto` delegates later execution to GitHub requirements and does not inherently rerun our local validators. `gh pr update-branch` defaults to a merge of base into head, with an optional rebase. [PR view fields](https://cli.github.com/manual/gh_pr_view), [guarded merge](https://cli.github.com/manual/gh_pr_merge), [branch update](https://cli.github.com/manual/gh_pr_update-branch)

## Proposed persisted transitions

| Observation | Next app state/action |
| --- | --- |
| Draft, required reviewer pending, old-head approval, incomplete pages, missing/currently running checks or validators | `waiting_review` or `validating`; retain specific reasons |
| Current effective changes requested / actionable findings | `rework_queued`, deduplicated; run one authorized repair |
| Required base update and writable clean branch | `updating_base`; guarded request, observe new head, validate again |
| Conflict, missing authority, policy mismatch, unknown semantics after bounded retry | `blocked`; evidence retained, no dependent mutation |
| All current eligibility conditions true and merge policy enabled | `merge_ready` → guarded `merging` |
| Confirmed remote merged receipt | `merged`; store actual merge SHA/time |
| Remote closed without merge | `closed`; stop automatic repair/merge |

These are application design recommendations. Tests should model pagination beyond 100, comment after change request, stale approval after push/base update, pending/private reviews, unresolved outdated threads, missing/spoofed check contexts, unknown mergeability, fork write denial, duplicate polling, head changes during mutation, timeout reconciliation and account-scoped rate limiting.

