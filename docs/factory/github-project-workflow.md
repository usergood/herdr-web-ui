# Project GitHub inbox and reviews

## Accepted scope

The owner requested project-scoped issue imports, incoming and outgoing PR review handling, review rules and validators, deduplicated requested-change work, re-review, guarded merges and updates of branches behind their target. This uses the already confirmed public HTTP API with temporary state and owned native-CLI fixtures, and the real browser journey seam. No new test seam is required.

Each Project explicitly selects `owner/repository`, its local verified GitHub account, trusted reviewers, required GitHub check names, review instructions, and independent automatic sync, fix import, branch update and merge policies. All automation starts disabled. The application never silently uses the server's global GitHub account. Remote Projects can use their connection server's local account only when explicitly selected; execution still follows their selected Machine.

Synchronization retains issues as Inbox Implementations without overwriting owner notes. PR snapshots contain reviews, requested reviewers, unresolved threads, check results, head/base revisions and GitHub branch protection. Review instructions are attached to imported work; foreign PR code is never executed to collect a snapshot. Requested changes create one Inbox Implementation per PR/head/review revision, preserving the standard factory specification, testing-seam and execution approvals. Pending reviews do not create fix work. Existing factory admission and worker limits continue to govern execution; import is not permission to run arbitrary PR code.

Automatic merging requires a non-draft PR, the current head and base, trusted current-head approval, no requested changes or unresolved threads, passing selected and required GitHub checks, and strict GitHub branch protection requiring reviews. GitHub remains the final authority when it receives the head-guarded merge. A behind branch may be updated with the expected head, after which checks and review are collected again. Conflicts and unsupported/missing protections remain blocked. No force push or bypass is used.

The owner can explicitly request re-review for a changed head; automatic polling re-requests only after an imported fix is marked implementation-complete and a new head is observed. Mutation intent is saved before a request. An ambiguous mutation is retained for inspection, never blindly retried. Every operation is serialized per Project, detects changed configuration/account scope, and records a durable result. Polling is bounded and pauses after failures.

## Manual production acceptance

Use a disposable GitHub repository first. Verify read-only sync, local note preservation, requested changes, a fix implementation, new-head re-review, behind-base update, failing checks, unresolved conversations and approval. Enable automatic merge only after branch protection is configured. The installation guide covers enabling the feature; it does not enable policies on existing Projects.

## Configuration

Open an Implementation assigned to the Project, expand **Project execution settings → Project GitHub workflow**, and select its `owner/repository` and a verified connection-server GitHub profile. A local checkout's origin must match; for a remote-only Project the selected repository is explicitly verified through that profile. Enter trusted reviewer logins and exact required GitHub check names, one per line. Put Project-specific review instructions or skill references in **Review rules**. Save the settings, then independently enable issue imports, requested-change imports and automatic synchronization as needed. **Sync GitHub** performs the same bounded operation immediately.

Open **Source** on a PR to read its file patches inside the application. The head is checked before and after loading. Binary or GitHub-omitted patches display their file status; a missing patch is never evidence that a file has no changes. **Import PR review** creates factory work with the frozen PR revision and Project review context. Imports do not bypass specification, testing-seam, Ticket graph or provider admission requirements.

Enable **Update behind branches** only for PRs owned by the selected account. Enable **Merge approved PRs** only with GitHub branch protection that enforces reviews, strict required checks and conversation resolution for administrators too. The policy also requires trusted approval on the current head and no pending reviewer requests. Missing protection, ruleset-only protection that this adapter cannot prove, failed/ambiguous mutations and inventories exceeding the bounded complete-snapshot budget stay blocked. Nested reviews, requests, threads, thread comments and checks are bounded at 100 each; top-level issues/PRs and file lists paginate. Incomplete snapshots cannot authorize mutations or fix imports.

Changing Project account bindings or checkout scope invalidates active operations and requires saving GitHub settings again. Polling is at least five minutes and backs off to at least fifteen minutes on failures. Mutation receipts remain visible across restarts and policy edits. After an ambiguous request inspect the retained receipt and GitHub state; the application does not blindly replay it.
