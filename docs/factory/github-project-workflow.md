# Project GitHub inbox and reviews

## Accepted scope

The owner requested project-scoped issue imports, incoming and outgoing PR review handling, review rules and validators, deduplicated requested-change work, re-review, guarded merges and updates of branches behind their target. This uses the already confirmed public HTTP API with temporary state and owned native-CLI fixtures, and the real browser journey seam. No new test seam is required.

Each Project explicitly selects `owner/repository`, its local verified GitHub account, trusted reviewers, required GitHub check names, review instructions, and independent automatic sync, fix import, branch update and merge policies. All automation starts disabled. The application never silently uses the server's global GitHub account. Remote Projects can use their connection server's local account only when explicitly selected; execution still follows their selected Machine.

Synchronization retains issues as Inbox Implementations without overwriting owner notes. PR snapshots contain reviews, requested reviewers, unresolved threads, check results, head/base revisions and GitHub branch protection. Review instructions are attached to imported work; foreign PR code is never executed to collect a snapshot. Requested changes create one Inbox Implementation per PR/head/review revision, preserving the standard factory specification, testing-seam and execution approvals. Pending reviews do not create fix work. Existing factory admission and worker limits continue to govern execution; import is not permission to run arbitrary PR code.

Automatic merging requires a non-draft PR, the current head and base, trusted current-head approval, no requested changes or unresolved threads, passing selected and required GitHub checks, and strict GitHub branch protection requiring reviews. GitHub remains the final authority when it receives the head-guarded merge. A behind branch may be updated with the expected head, after which checks and review are collected again. Conflicts and unsupported/missing protections remain blocked. No force push or bypass is used.

The owner can explicitly request re-review for a changed head; automatic polling re-requests only after an imported fix is marked implementation-complete and a new head is observed. Mutation intent is saved before a request. An ambiguous mutation is retained for inspection, never blindly retried. Every operation is serialized per Project, detects changed configuration/account scope, and records a durable result. Polling is bounded and pauses after failures.

## Manual production acceptance

Use a disposable GitHub repository first. Verify read-only sync, local note preservation, requested changes, a fix implementation, new-head re-review, behind-base update, failing checks, unresolved conversations and approval. Enable automatic merge only after branch protection is configured. The installation guide covers enabling the feature; it does not enable policies on existing Projects.
