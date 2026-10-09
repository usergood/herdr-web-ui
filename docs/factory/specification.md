# Draft Saurons eye specification

Status: local draft for owner review. This covers the complete requested product. It does not authorize implementation or certify Matt's specification, testing-seam or ticket-publication gates. Product defaults below remain proposals until confirmed.

## Problem statement

The owner already uses Herdr and Codex with a working Herdr Web UI deployment. Ideas, specifications, agent sessions, changes, reviews and research need a durable home across projects and execution machines. A live terminal or native chat alone does not provide assignment identity, approved specification versions, review anchors or retained history.

## Solution

Build **Saurons eye** (`saurons-eye`) on the existing fork with an Inbox, Projects, Implementations and a manual specification-to-delivery workflow. The owner has confirmed the display name and slug. Use the pinned Matt Pocock skills for engineering work, Herdr for process ownership and SSH transport, and application-owned records for durable coordination and evidence. Codex is primary; capability-tested Claude Code and OpenCode adapters remain required delivery scope.

## User stories

1. As the owner, I want to capture an idea or todo without selecting a repository so I can keep unfinished thoughts in one Inbox.
2. As the owner, I want several chats, research notes and artifacts on an Implementation so I can follow its decisions over time.
3. As the owner, I want to attach a Project later so assignment identity and provenance survive project selection.
4. As the owner, I want existing projects to remain usable with ordinary chats and terminals before factory setup.
5. As the owner, I want repository checkouts configured per Machine so local paths and tools resolve on the host where work runs.
6. As the owner, I want application and Project provider defaults with per-Implementation overrides so each Run uses the intended CLI.
7. As the owner, I want a visible effective Machine, checkout and CLI before starting so execution cannot silently move elsewhere.
8. As the owner, I want Grill me on an unassigned Implementation so I can sharpen an idea before choosing a Project.
9. As the owner, I want Grill with docs to inspect the selected repository and prior decisions so its questions focus on unresolved choices.
10. As the owner, I want unanswered questions and confirmed decisions to survive browser and server restarts so I do not lose approvals or have decisions invented for me.
11. As the owner, I want explicit Create specification and Plan tickets actions so completed conversations do not silently publish or start the next skill.
12. As the owner, I want immutable specifications and dependency-linked Tickets so each implementation attempt has a stable contract.
13. As the owner, I want testing decisions reused by affected implementers so changing agent context does not repeat an already settled confirmation.
14. As the owner, I want an explicit Start factory action that rejects missing evidence, unsupported CLIs or stale approvals so arbitrary chat prompts cannot bypass admission.
15. As the owner, I want each repository writer in a dedicated worktree so it cannot overwrite my primary checkout or another writer's files.
16. As the owner, I want Ticket workers integrated through a single owned branch so concurrent results are reconciled against the current integration tip.
17. As the owner, I want two or three independent manually started Implementations within a global agent/build cap so concurrency stays within my machines' resources.
18. As the owner, I want Markdown, image and HTML artifacts rendered in their chat/task context with source and download actions so research is easy to revisit.
19. As the owner, I want laptop-generated artifacts retained centrally so they remain available when the laptop sleeps or its worktree is removed.
20. As the owner, I want aggregate branch and live workspace diffs distinguished so review evidence names exactly what I inspected.
21. As the owner, I want comments anchored to immutable review snapshots so subsequent edits cannot silently move a finding to unrelated lines.
22. As the owner, I want to submit a selected Request changes batch to the correct Run so drafts are durable without sending every keystroke to the agent.
23. As the owner, I want fresh checks and Standards/Spec review evidence after rework so a reply alone cannot resolve a finding.
24. As the owner, I want merge and deployment decisions separately scoped so a completed factory Run does not publish or release changes without authority.
25. As the owner, I want cross-project and Project boards with project, CLI, Machine and condition filters so I can order work and find what needs my answer.
26. As the owner, I want successful, failed, interrupted, cancelled and disconnected attempts in history so pane closure does not erase evidence.
27. As the owner, I want to start eligible work on an SSH-connected laptop and reattach after reconnect so temporary network loss does not create duplicate work.
28. As the owner, I want explicit uncertainty when a remote Run cannot be observed so offline status does not start a competing attempt elsewhere.
29. As the owner, I want a project retrospective over a selected evidence set so proposed environment improvements are grounded in sessions I supplied.
30. As the owner, I want retrospective suggestions separate from applying changes so project improvements remain reviewable worktree changes.
31. As the owner, I want coherent backups and tested restore/rollback so the central history and artifacts survive an upgrade failure.
32. As the owner, I want parallel development and fork-owned update/runtime sources so extending the fork preserves my working upstream installation.

## Implementation decisions

The owner-required behavior is binding product scope. The central database, app-native tracker, generic acceptance boundary, limits and HTML execution mode below are proposed choices. Resolve those choices without weakening repository-specific instructions.

### Ownership and persistence

**F01** — Herdr continues owning native panes and agent processes. Extend existing local/remote bridges instead of introducing a competing Codex app-server integration. Ordinary conversations and live terminals keep functioning.

**F02** — Propose one server-owned SQLite database, with migrations, transactional mutation and durable event history from the first record slice. Remote agents use authenticated bridge/API operations. The database is never a shared file over SSH or a network mount. Keep existing native stores intact.

**F03** — Retain Machines, Projects, machine-specific checkouts, Implementations, Chats, Messages/events, Specification versions, Tickets/edges, Runs, Artifacts/versions, Review snapshots/comments, Approvals and Retrospectives. Application IDs survive pane closure and worktree cleanup. Native IDs remain provenance. Import native events idempotently by source ID and sequence; avoid two independently writable transcripts.

**F04** — Projectless work has an app-owned directory outside repositories. Attaching a Project preserves identity, history and artifacts, and does not silently copy or commit files. Source and committed project documents stay in Git; configured trackers stay authoritative. Store immutable snapshots and external references, with visible sync failures. App-native tracker support requires a stable-ID CLI/API and explicit Other-tracker setup.

### Skills and explicit decisions

**F05** — Freeze the exact `v1.3.1` commit, dependent skills, support files and agent metadata in each Run manifest. Every supported CLI must demonstrably load the invoked skill and required dependencies through its supported mechanism. Installing a Claude plugin does not establish Codex/OpenCode support. Keep question/approval capability differences visible.

**F06** — Distinct owner actions invoke setup, Grill me, Grill with docs, specification, ticket planning, Start factory and retrospective. No automatic chaining between user-invoked skills. Grilling preserves upstream rounds/frontiers and waits for real answers plus shared-understanding confirmation. Specification/TDD seams and Ticket granularity/dependencies retain their required owner gates. A versioned prior confirmation can be reused when its scope still matches.

**F07** — Freeze the selected specification revision, Ticket graph, base commit, instructions, permissions, skill manifest and effective configuration in each Run. Editing a spec creates a new revision and invalidates affected acceptance/evidence without altering an active contract. Proposed product default: explicit specification acceptance before factory start.

### Admission and execution

**F08** — Backend admission requires a selected Project, reachable Machine, verified checkout/base, ready spec and acyclic dependency graph, pinned complete skills, supported provider contract, known instructions/checks/permissions, satisfied or correctly surfaced workflow gates, safe worktree ownership and an explicit scoped Start action. Chat content and board drag/drop cannot bypass it.

**F09** — Record acceptance and dispatch intent transactionally with an idempotency key. Double click, timeout and reconnect cannot allocate duplicate worktrees or agents. An uncertain launch requires identity reconciliation before retry. Reconciliation observes existing accepted actions; it is not backlog dispatch or automatic resume after reconnect.

**F10** — Resolve provider as Implementation override, then Project default, then application default for unassigned work. Resolve Machine from Implementation selection then Project default; unassigned work uses an explicitly selected app execution context. A Project requires a valid checkout on that Machine. Persist resolved settings per Run; later default changes affect future attempts only. Commands use validated argument arrays without shell interpolation.

**F11** — Repository writers use isolated worktrees: one integration worktree per active Implementation and worker worktrees per Ticket. This includes Grill with docs or retrospective actions that write repository files. Each worktree has one active writer. Verify absolute cwd, Git root, Machine, branch and base before writing; safely provision environment, dependencies, writable caches, state, ports and test databases without copying ignored secrets automatically.

**F12** — Implement the pinned ticket-graph workflow and merger role within resource limits. Serialize integration updates, check worker freshness against the current integration tip, and reconcile again if it changed. Resetting a wrong base is only safe for a newly created disposable checkout; preserve unexpected work and stop for reconciliation. Assign writers for shared glossary/progress docs, ADRs, migrations and lockfiles. Deliver owner answers as versioned context with consumption evidence.

**F13** — Keep stage, Run condition and delivery outcome separate. An idle CLI, closed pane, green review, Done card, merged PR and release are distinct evidence. Manual starts/resumes remain the first version; global capacity covers child agents, review contexts and builds across all active Implementations. No queue scheduler, auto dispatch, failover or migration.

### Artifacts and review

**F14** — Artifacts are application-owned blobs with media type, hash, versions, origin and Chat/Implementation links. Remote import verifies size/hash and materializes CLI-readable research notes outside repositories on the selected Machine. Notes, retention, deletion and size limits are visible. Completion does not delete history or commit attachments.

**F15** — Render sanitized Markdown, safe links and images, with source/download. Treat HTML as executable untrusted content: isolated origin or opaque sandbox, restrictive CSP, no app credentials, no default network or top navigation. Script mode is explicit if offered. Resolve artifact identity/authorized roots on the server; reject traversal, symlink escapes and unapproved host paths.

**F16** — Review includes file navigation, unified/side-by-side views, captured staged/unstaged changes and integration aggregate changes. Distinguish branch base/head comparison from live uncommitted views. Snapshots record exact commits or captured workspace identity; comments include repository, Machine, snapshot, path, side, line range and hunk context. Reliable remapping is allowed; otherwise retain the anchor and mark outdated. Handle binary, rename, delete, untracked and oversized cases explicitly.

**F17** — Comments start as durable local drafts. Request changes submits only a selected batch to the intended Implementation/Run and snapshot. Record delivery identity, do not replay uncertain sends automatically, and separate discussion, findings and resolution. Rework uses the existing safe worktree arrangement, relevant checks and fresh review evidence. Changes invalidate affected approvals. External tracker review publication is a separate configured action.

### History, remote execution and operation

**F18** — Boards show Inbox, Specifying, Ready, Running, Review and Done with Needs you/Blocked conditions. Cards include Project or Unassigned, CLI/Machine, action, latest activity, waiting reason and context links. Reordering does not start work. Keep parent Ticket progress compact; retained history includes all attempts, summaries, artifacts, specs, tests, Git/PR references and review/retro discussion.

**F19** — Central records and imported artifacts remain on the server; each Machine owns local checkouts, worktrees, native sessions, environment and credentials. SSH onboarding verifies host identity/key, connectivity, bridge/provider versions, repository and skills. Reconnect verifies and reattaches; disconnected ownership remains exclusive and execution uncertain. New Machine defaults do not migrate active work. Controlled handoff, if included after owner decision, quiesces and verifies source work before preserving/transporting it into a new linked attempt. An unavailable source requires explicit duplicate-risk reconciliation.

**F20** — Retrospective runs are owner-invoked and project/evidence scoped. Retain findings and proposed changes, then separately apply approved improvements in worktrees. The pinned retro skill ends by presenting candidates, not silently applying them; mechanical violations call for deterministic checks, judgement rules belong in standards. Do not imply access to unrelated native sessions. [Pinned retro](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md)

**F21** — Inventory the installed service before choosing deployment/base. Parallel development uses distinct state, port and test Herdr resources. Audit fork plugin IDs, updater origin, installation URLs and remote-runtime namespaces/manifests. Preserve licenses, HTTPS, auth, trusted headers and WebSocket/stream routing. Restrict authenticated mutation/control operations with origin/CSRF protection. Test coherent database/blob restore, native/remote recovery and migration-compatible rollback on copied state before promotion under separate owner scope.

**F22** — Preserve Standards and Spec reviews as separate contexts tied to reviewed revisions, with security/UI/UX evidence appropriate to the change. Code-review findings and skill outcomes are evidence, not merge/deployment authority. Loading the PR-body skill does not authorize publication. A tracker-authorized draft PR may follow the first integrated change, subject to explicit push policy; never silently disable a push guardrail. Review/merge acceptance is tied to the current reviewed head.

## Testing decisions

Proposed seams for owner confirmation before publishing this specification or writing TDD tests:

1. **The existing public server interface through server construction injection.** Exercise factory records, artifact ownership, approvals, launch/recovery and review commands as a caller, with temporary app state and owned Git/Herdr/SSH fixtures. Restart the server and read through the same public interface; avoid private database queries as behavioral assertions.
2. **The browser UI through existing real-client regression runners.** Verify complete user actions, keyboard/mobile operation, visible waiting/error states, rendered artifact isolation and retained context after reconnect. Add matching demo responses for new contracts.

Focused skill/provider contract evidence runs on each installed provider/Machine combination, using disposable repositories and genuine native loading. Actual SSH, filesystem/worktree and HTML sandbox behavior require real boundary checks; fake adapters alone cannot certify them. Record versions, commands, before/after evidence and limitations. Existing generated-types, type/build, unit, integration/browser and SSH checks remain applicable according to changed scope.

The primary journey captures an unassigned idea and attachment, selects a Project/Machine, grills and accepts a specification, manually starts Codex, reviews and requests rework, inspects fresh evidence, safely stops the session, retains history and runs a project retrospective. Each delivery slice has focused observable acceptance plus browser evidence where applicable.

Negative acceptance must reject stale/invalid spec acceptance, cyclic or unready graphs, missing dependencies, wrong repository/base/cwd, dirty existing worktree, duplicate/uncertain launches, unsupported providers, malicious Markdown/HTML/paths, outdated anchors, uncertain comment delivery, unsafe cleanup, upstream update sources and duplicate execution after SSH loss or sleep. Browser/server restart while a question is visible retains it unanswered. Failed synchronization, exhausted repair and real process errors remain visible.

Testing seams are proposed, not confirmed. An eventual approved seam decision is recorded once with scope/revision and supplied to every affected worker.

## Out of scope

Automatic backlog scheduling/dispatch, automatic cross-machine failover or live migration, default-branch merge on successful review, unscoped deployment or destructive actions, a competing Codex process owner, global project/skill-policy mutation by retrospectives, and Conteo changes.

The planning pass also excludes application implementation, live deployment inventory without supplied access, active skill installation, issue/PR publication, service changes and merges. All requested delivery slices remain in the product plan; a phased start is not a reduction of scope.

## Further notes

Owner decisions and the first bounded slice are in [server-kickoff.md](server-kickoff.md). Source-file extension points are in [baseline.md](baseline.md); they are intentionally separate from the product contract. Tracker setup and vocabulary proposals are in [domain-setup.md](domain-setup.md).
