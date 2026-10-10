# Owner handoff prepared 9 October 2026

Current scope: the owner subsequently requested the complete implementation and confirmed both testing seams. Planning statements below are historical; [runtime.md](runtime.md) and [specification.md](specification.md) record the current contract. Production promotion remains separate.

Prepared 9 October 2026 for implementation on the owner's server. Extend a fork of **devswha/herdr-web-ui** into a personal software factory. The owner already runs Herdr and Codex on the server and has installed Herdr Web UI successfully. Preserve that working setup while developing the fork.

This is the handoff for a separate repository, not a Conteo feature. It authorizes preparing the implementation plan and specifications; production replacement, changes to the running service, and merges require their own explicit scope. No server access details, fork URL, installed version, or deployment paths were supplied.

## Owner requirements

- Build directly on a Herdr Web UI fork.

- Support multiple CLI agents, with Codex as the primary implementation target; include project defaults and per-Implementation overrides for Codex, Claude Code, OpenCode, and extensible providers.

- Use Matt Pocock's skills from the requested 1.3 release line, pinned below to v1.3.1 for the factory workflow, centered on specification implementation and its guardrails.

- Offer Grill me for an Implementation and a project-aware Grill with docs flow from an existing idea or todo.

- Every repository-writing implementation uses Git worktrees.

- Configure projects, repositories, CLI defaults, and execution machines.

- Store unassigned chats, ideas, todos, research, and artifacts in the application even before a repository is selected.

- Render Markdown, images, and HTML artifacts in chat/task context.

- Provide Git diff review and comments that can be sent back for fixes.

- Run the project retrospective skill from the interface.

- Provide a cross-project Kanban board and retained completed-work history.

- Support the main server and an additional SSH-connected machine such as the laptop.

**Manual starts remain the agreed first-version scope.** The earlier discussion explicitly removed automatic queue scheduling. Keep an ordered backlog and support two or three manually started independent Implementations; no background scheduler, automatic dispatch on reconnect, or automatic cross-machine migration is implied. The dependency scheduling inside an explicitly started implement-spec run remains part of that skill.

## Verified upstream baseline and skill contract

The latest verified release in the requested 1.3 line is **mattpocock/skills v1.3.1**, commit **24fe0ef7737efae15c87225755e9f6f5965e4888**. Pin that tag and resolved commit, including dependent skills and support files; do not install floating main or silently update active Runs. Version 1.3 uses GLOSSARY.md and GLOSSARY-MAP.md for domain vocabulary. Existing CONTEXT.md projects need a reviewed migration or explicit compatibility decision, not an automatic rename across repositories. [Release](https://github.com/mattpocock/skills/releases/tag/v1.3.1)

The owner phrase “grill-me-with-docs” maps to upstream **grill-with-docs**. The main execution skill is **implement-spec**, not an invented factory prompt.

| UI action | Pinned skill and invocation boundary |
| - | - |
| Configure project workflow | setup-matt-pocock-skills, owner-invoked |
| Grill me | grill-me, owner-invoked |
| Grill with docs | grill-with-docs, owner-invoked |
| Create specification | to-spec, owner-invoked |
| Plan tickets | to-tickets, owner-invoked |
| Start factory | implement-spec, owner-invoked for the selected spec and tickets |
| Review changes | code-review, invoked by the implementation workflow or explicitly requested |
| Prepare PR body | pr, loaded when a PR is being prepared; does not itself grant publication authority |
| Run retrospective | retro, owner-invoked |

A button click is an explicit invocation only for the clearly described action and scope. Do not autonomously chain the user-invoked skills merely because the previous stage ended. Preserve required confirmations inside invoked skills: shared understanding after grilling, testing seams before specification publication/TDD, and ticket granularity/dependencies before publishing tickets. Reuse already confirmed testing decisions; do not ask again solely because a different subagent starts. Dependencies such as grilling, domain-modeling, codebase-design, tdd and writing-for-agents must actually be loaded using each CLI's supported mechanism; putting a skill name into a prompt is not proof of loading. [Invocation rules](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/.agents/invocation.md)

implement-spec works from a ticket graph, coordinates worktree implementers and an integration branch, and finishes with code-review. Its PR behavior depends on the configured tracker or owner request; a draft can be opened after the branch gains a first integrated change. Completing the integration branch does not merge it into the default branch. [implement-spec](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/implement-spec/SKILL.md)

Use the required standards/spec review, with relevant security, UI and UX acceptance evidence for the affected change. The earlier Zazen factory supplies visual inspiration, not a replacement workflow or automatic merge policy. Optional specialist reviews must not bypass Matt's workflow or multiply agents without the configured resource cap.

The minimum bundle includes setup-matt-pocock-skills, grill-me, grill-with-docs, grilling, domain-modeling, to-spec, to-tickets, implement-spec, tdd, codebase-design, code-review, pr, retro and writing-for-agents, with complete referenced files and agent metadata. Resolve transitive dependencies from the pinned sources. Codex is supported through editable skill installation; the native managed plugin in this release is Claude-specific. [Pinned README](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/README.md)

Upstream git-guardrails-claude-code is explicitly Claude Code-specific; do not claim that installing it protects Codex or OpenCode. Inventory exact checks and command restrictions, then use tested provider hooks/permission controls and backend gates. Any narrowed exception must be explicit; a push block must not be silently disabled just to open a PR. [Git guardrails](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/misc/git-guardrails-claude-code/SKILL.md)

The inspected Herdr Web UI baseline is **b87d9d50019cdb87422415f7650ad29285a832cc**, package version **0.4.3**, on 9 October 2026. This is a research baseline, not a claim about the owner's installed version. Reconcile the actual server version before choosing a fork base.

## Product vocabulary and workflow

Use **Implementation** for the durable assignment being specified, built, and reviewed. Use **Ticket** for a bounded child unit of an Implementation's specification. A **Run** is one attempt to perform a workflow action with one selected CLI and execution machine. These terms should be confirmed in the fork's glossary before they become API contracts.

An Implementation can initially be an unassigned idea, todo, or research effort. It can own several chats, notes, and artifacts without a project. Attaching a project later preserves its ID, history, attachments, and provenance; it does not silently move files into that repository.

Proposed flow with explicit owner actions at user-invoked skill boundaries:

Idea or todo → project selection → Grill with docs → specification → dependency-linked tickets → explicit Start factory → implementation and verification → review and rework → owner decision → integrated or completed → optional retrospective.

Grill me is also available without a project. Project-aware discovery first reads the repository and existing decisions, then asks about unresolved product choices. Preserve the pinned grilling skill's question and round behavior rather than inventing a different interrogation contract. A visible question remains unanswered until the owner responds.

Keep three states distinct:

- Workflow stage, such as specifying, implementing, or reviewing.

- Run condition, such as working, waiting for an answer, interrupted, failed, or disconnected.

- Delivery outcome, such as implementation complete, PR open, merged, or released.

An idle CLI, a closed pane, a green review, and a merged PR are not interchangeable completion signals.

## Application architecture

Keep Herdr responsible for panes and agent processes. Extend the existing Web UI server and frontend with factory services, using its local and remote bridges wherever they provide the required behavior. Do not start a competing Codex app-server integration by default.

Proposed modules:

- Projects and machine-specific checkouts.

- Inbox, Implementations, chats, and durable artifacts.

- Specification versions, ticket graphs, and approvals.

- Skill catalog and CLI capability adapters.

- Factory admission, run tracking, and recovery.

- Worktrees, integration branches, and review snapshots.

- Kanban and history.

Use a server-owned SQLite database initially, plus an application-owned artifact directory. This is a proposed implementation choice, to be checked against the fork's existing persistence conventions. The server is the sole database writer; remote agents use authenticated bridge/API operations, never a shared SQLite file across SSH or network mounts. Add migrations, transactional updates, backup/restore, and durable event history from the first persistence slice.

Run control must not depend on an open browser tab. Closing or reconnecting the browser must not lose questions, review comments, artifacts, or accepted actions. Existing upstream browser message queues are a separate convenience and must not be mistaken for a durable factory job queue.

## Upstream extension points

Verified at the Herdr Web UI research baseline:

| Area | Existing seam and planned extension |
| - | - |
| Launch and worktrees | shared/protocol.ts, src/components/WorktreeDialog.tsx, NewSessionDialog.tsx, AgentPicker.tsx; wrap existing operations with durable run admission |
| Chat bindings | server/conversation.ts, codex.ts, claude-store.ts, opencode.ts; keep application chat IDs separate from native sessions and panes |
| Remote machines | server/machines.ts, machine-api.ts, machine-relay.ts, shared/machines.ts; reuse SSH transport and machine-scoped identities |
| Artifacts | server/file-view.ts and src/components/FileViewer.tsx; add retained app ownership and rendered previews |
| Markdown | src/components/Markdown.tsx; reuse rendering while preserving sanitization boundaries |
| Factory persistence and review | New application records/migrations and diff-comment endpoints are needed; provider SQLite stores are not an app task database |
| Updates | server/updater.ts and remote-bundle.ts; audit fork release and remote-runtime sources separately |

Current Markdown and HTML file attachments are displayed as text by FileViewer; inline rendered attachments are new work. Existing native conversations and live terminals should continue to function. [File viewer](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/src/components/FileViewer.tsx), [protocol](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/shared/protocol.ts)

The app updater follows Git origin, while remote runtime defaults reference upstream release bundles. Supply matching fork-owned bridge manifests/builds and avoid runtime/state collisions with the existing installation. [Updater](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/server/updater.ts), [remote bundles](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/server/remote-bundle.ts)

During implementation, read the fork's AGENTS.md and DESIGN.md and keep shared protocol, tests and demo transport aligned. Do not replace Herdr's process ownership or run node-pty directly in Bun; preserve the existing Node terminal sidecar. [Upstream instructions](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/AGENTS.md)

## Proposed records and ownership

| Record | Minimum purpose |
| - | - |
| Machine | Stable identity, display name, SSH profile reference, connection status, capability/version observations |
| Project | Repository identity, display name, default CLI, default machine, policy profile and issue-tracker configuration |
| Project checkout | Project plus machine, verified local path, remote identity, base branch and toolchain readiness |
| Implementation | Title, description, optional project, stage, selected CLI/machine overrides, links to chats and spec |
| Chat | Stable application ID, optional Implementation/project, purpose, provider session and machine references |
| Message or event | Sequence, author/source, timestamp, content, native provenance and delivery state |
| Specification version | Immutable content or tracker snapshot, source/revision, acceptance criteria, approval and supersession |
| Ticket | Specification linkage, dependency edges, tracker reference and acceptance evidence |
| Run | Action, Implementation, specification version, skill manifest, effective provider/machine, worktrees, native session, status |
| Artifact | Application blob identity, media type, hash, title, version, origin and chat/Implementation links |
| Review snapshot and comment | Compared revisions, file/side/line/hunk anchor, comment, response and resolution state |
| Approval | Actor, exact operation/revision, scope, timestamp and invalidation |
| Retrospective | Project, chosen session/run evidence, findings, proposed changes and follow-up status |

Application records survive pane closure and worktree removal. Native session IDs remain useful provenance, but the application needs retained transcript/evidence appropriate to its history promise. Avoid two competing writable transcripts: preserve source event IDs and synchronize idempotently.

Source code and committed project documentation remain in Git. Existing issue trackers remain authoritative where configured by project skills. Store IDs and immutable run snapshots in the app; present synchronization failures explicitly. Projects without a tracker must complete the skills setup decision before tracker-dependent factory execution. An app-native tracker is a proposed default for new projects: implement its stable-ID CLI/API and document it as the skills' Other tracker, including publication, dependencies and resolution. That adapter does not already exist upstream. Existing GitHub/GitLab/local conventions remain configured choices; avoid multiple canonical .scratch copies across worktrees. [Project setup](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/setup-matt-pocock-skills/SKILL.md)

Global decisions are not automatically inherited by every project. Repository instructions and approved project policies are loaded from the selected checkout and recorded with the run.

## Projects and CLI selection

Project setup registers an existing repository checkout or explicitly requested clone on a selected machine. Verify the repository's identity and accessible base branch; discover instructions, dependency setup, checks, skill availability, and tracker configuration. Existing projects must remain usable without running a factory.

Resolve CLI as Implementation override → project default → application default for unassigned work. Resolve execution machine as Implementation selection → project default, with a valid checkout on that machine. Store the resolved settings per Run; changing defaults never rewrites a running or historical attempt.

Build a provider interface around:

- Discovery and capability checks.

- Start and attach/resume with an explicit working directory.

- Skill loading and dependency resolution.

- Sending messages and surfacing questions/approvals.

- Status, interruption, transcripts, and completion evidence.

- Child-agent/worktree support required by implement-spec.

A shared command name does not establish compatibility. Verify how each installed CLI loads the pinned skills and supplies the tools they require. Commands use structured argument arrays and validated provider configuration, not shell interpolation of titles or chat content.

Codex is the first fully verified factory provider. Claude Code and OpenCode are required supported targets, introduced through capability-tested adapters. If a CLI supports chat but not the complete factory contract, keep ordinary chat available and explain why Start factory is unavailable. Do not silently substitute a CLI, flatten required subagent behavior, or claim identical question UI support across providers.

## Factory admission and guardrails

The backend, not only the button, must enforce factory eligibility. An arbitrary chat prompt or drag to the Running column cannot bypass these conditions:

1. An Implementation has a selected project, reachable machine, and verified checkout.

2. A specific specification revision and its ticket/dependency graph are present and ready under the pinned skill workflow.

3. Required skills and dependencies are available at the pinned revision, and the chosen CLI can execute the contract.

4. All required question/confirmation gates from grilling, specification, ticket planning and TDD are satisfied or currently surfaced to the owner. An internal dependency becoming ready is not permission to skip a gate.

5. Repository instructions, permissions, required checks, and any existing owner decisions are known.

6. Writable worktrees and integration ownership are allocated safely; no incompatible active run holds them.

7. The explicit start action records the approved scope and effective settings.

Track admission and dispatch transactionally with idempotency keys. A double-click, response timeout, or reconnect must not create duplicate worktrees or agents. A launch with an uncertain outcome requires reconciliation before retry.

Freeze the starting specification revision, base commit, skill manifest, and configuration in the Run. A later spec edit creates a new version and marks affected evidence stale; it does not silently alter an active implementation contract.

Proposed product defaults: explicit owner acceptance of a specification before factory start; explicit merge approval tied to the reviewed PR/head; deployments and destructive operations separately scoped. Preserve any stricter existing repository requirements. Skill outcomes and review recommendations are evidence, not blanket authorization.

The interface must show real execution errors, missing evidence, exhausted repair attempts, and unresolved questions. Timeouts never count as answers or approvals.

These controls govern managed factory runs. Herdr's general terminal remains powerful; a prompt policy cannot technically prevent arbitrary commands typed outside the factory. Use provider sandbox/permission controls and narrowly scoped machine access, and accurately describe the boundary.

## Worktrees and shared files

Model one integration worktree per active Implementation and separate worker worktrees for its tickets, matching implement-spec's integration-branch workflow. Workers must use the correct integration tip; use the skill's merger role, serialize integration updates and revalidate freshness before accepting each result. If the integration tip advances after a worker synchronizes, reconcile again rather than assuming the merge remains a fast-forward. Upstream wording about resetting a wrong-base worktree only applies safely to a newly provisioned disposable checkout: preserve unexpected existing work and stop for reconciliation instead of resetting it destructively. Several independent Implementations can run simultaneously, but one worktree has only one active writer.

Use explicit absolute paths and verify Git root, branch, base commit, and machine before starting a writer. Ordinary implementation work must not occur in the user's primary checkout. Grill with docs and retrospective changes that write repository files also use dedicated or correctly owned worktrees.

Tracked files such as source, tests, skills and project instructions come from each checkout's Git revision. Ignored secrets, local databases, dependencies, and uncommitted files are not automatically inherited. Worktree setup explicitly supplies permitted environment settings, installs dependencies as required, and isolates writable caches, local state, test databases, and ports.

Project-wide progress files, glossary changes, ADRs, lockfiles and migrations need an assigned writer or integration coordination. Agents cannot treat another worktree's uncommitted edits as the canonical state. Shared owner answers are delivered as versioned context to affected runs; a changed file elsewhere is not proof that an agent has consumed it.

Closing a Herdr pane is separate from removing a worktree. Before cleanup: persist artifacts/transcript evidence, identify uncommitted and ignored outputs, verify commit preservation and merge/abandonment state, stop associated processes, and confirm no active run uses the checkout. Keep unfinished branches/worktrees available for repair. Never force-remove dirty work merely because an agent reported success.

## Inbox and application artifacts

An unassigned chat or research Run receives an application-owned working directory outside every project checkout, for example under the application's data root. It may create documents and experiments there, but cannot invoke repository factory implementation until attached to a project and eligible specification.

Store uploads and generated artifacts durably in the app, linked to the producing chat/Run and optionally the Implementation. Import artifacts from remote machines through the bridge with size/hash verification; a laptop path alone is not a retained attachment. Once imported, they remain available while the laptop is offline and after its worktree is removed.

Provide inline Markdown rendering, images, and HTML previews, plus source/download actions. Render Markdown with sanitized HTML and safe links. Treat HTML as untrusted executable content: use an isolated origin or opaque sandbox, restrictive CSP, no application credentials, and no default network/top-navigation access. If scripts are supported, keep them isolated and make the execution mode explicit. A preview must not gain terminal control through the app's origin.

Resolve artifact IDs and authorized roots server-side; reject path traversal and symlink escapes. A model-produced path never grants access to arbitrary host files. Persist artifact versions and ownership; transferring an idea to a project does not automatically commit its research attachments.

Supply the skill's exploration notes from an app-owned path outside the repository, readable by its subagents on the selected machine; materialize verified copies remotely when needed. Do not substitute a URL inaccessible to the CLI.

Provide notes on artifacts so the owner can revisit research and capture new ideas. Retention, explicit deletion, and storage limits should be visible; task completion does not delete history.

## Diff review and rework

Keep Matt's Standards and Spec reviews in separate contexts and preserve both results with the reviewed revisions. The app's human comments supplement those reviews. [Code review](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md)

Provide an Implementation review page with a file list, unified and side-by-side diff, local staged/unstaged changes where relevant, and the integration branch's aggregate changes. Distinguish base-to-head branch review from a live uncommitted workspace view.

Anchor each review to base/head commit IDs or a captured worktree snapshot. Comments include repository, machine, snapshot, path, old/new side, line range, and hunk context. After changes, remap only when reliable; otherwise mark the comment outdated while retaining its original anchor.

Comments begin as durable local drafts. An explicit Request changes action submits a selected batch to the correct Implementation/Run with its review snapshot. Do not inject every keystroke into a working agent or replay an uncertain send automatically. Separate general discussion, actionable findings, and resolved findings.

Rework happens in the existing safe worktree arrangement, followed by relevant checks and a fresh review snapshot. Track which findings were addressed and how; never equate a reply with verified resolution. Code changes invalidate affected approval/evidence. Binary files, renames, deleted files, untracked files, and oversized diffs need explicit handling.

GitHub or other tracker review publishing is a separate configured action, not an implicit consequence of making a local comment.

## Kanban and history

Provide cross-project and project boards with project, CLI, machine and status filters. Proposed columns: Inbox, Specifying, Ready, Running, Review, Done; Blocked and Needs you can be prominent conditions rather than hiding the current phase.

Cards show project or Unassigned, selected machine and CLI, current action, latest activity, waiting reason, and links to chats/spec/review. A parent Implementation can show ticket progress without flooding the top-level board with every subagent.

Drag/drop may reorder ideas or request valid transitions; execution and completion still pass backend checks. The owner manually starts or resumes work. Support two or three independent active Implementations with a global limit on total agents/builds so each one cannot multiply concurrency without bounds.

History includes successful, failed, cancelled and interrupted attempts, final summaries, specifications, artifacts, review discussions, tests, Git/PR references and retrospective links. Delivery status remains explicit even when a card is marked Done under its configured acceptance boundary.

## Remote machines and laptop execution

Use Herdr's supported remote-PC/SSH integration as the transport. The central server stores app records and artifacts; each machine owns its local repository checkout, worktrees, credentials, native sessions, and execution environment. Register repository paths per machine, not one global path string.

The server needs a route to the laptop's SSH service. Onboarding checks identity, host key, credentials, reachability, bridge/provider versions, repository identity, and skills. A private network or VPN may be necessary; being online alone does not make a laptop reachable through NAT.

An explicit run on the laptop executes there. Reconnection reattaches to an existing live run after verifying identity; it does not start a duplicate. Offline/disconnected status must not imply failure or permission to start elsewhere. Preserve an exclusive run/worktree ownership record; if the app loses contact, mark execution uncertain until reconciled.

Changing a project's default machine affects future Runs. Moving an existing Implementation is a controlled handoff: quiesce and verify the source, preserve committed and uncommitted work and artifacts, transfer through an authorized mechanism, verify the destination, and start a new linked attempt. Native conversation portability varies by CLI; use a documented context handoff if exact resume cannot be supported.

Do not promise automatic live migration or failover in the first version. The owner can select the laptop for new eligible work while it is online, and continue existing laptop sessions after reconnect. If the source is unavailable, allow a separately identified recovery branch only after explicit reconciliation of duplicate-execution risks.

## Retrospectives

Provide Run retrospective on a project, with a selectable completed Implementation or session set and visible evidence scope. Invoke the pinned retro skill through an explicit user action.

Retain findings and proposed environment improvements in the app, linking their originating evidence. Changes to project instructions, navigation docs, deterministic checks or standards must be reviewable repository changes in a worktree. A retrospective is not a license to mutate global skills, all projects, CI policy or live infrastructure.

Separate suggesting improvements from applying them. Preserve the skill's exact gates after inspecting its pinned content. Confirm whether the selected evidence is sufficient; do not imply the agent remembers unrelated sessions it has not received.

## Deployment and fork maintenance

The owner already has a working server deployment. First inventory its actual version, install method, Herdr session/socket, service manager, persistent directories, Traefik route and authentication without printing secrets. Existing host-versus-container placement is a discovery fact, not a reason to reinstall.

Develop the fork alongside that deployment on a different port, with distinct application state and test Herdr resources. Preserve upstream licenses and attribution. Keep upstream changes reviewable and document the fork's base commit.

Audit plugin IDs, update sources, release download URLs, installation scripts and remote bridge bundles before deploying. The fork must not overwrite the user's upstream installation or later replace itself with an upstream release through an unchanged updater. Do not globally disable updates for the user's other software.

Preserve HTTPS, application authentication, WebSocket/stream routing and trusted-header behavior through Traefik. Restrict host and remote control endpoints. Bind public API actions to the authenticated owner and validate origin/CSRF protections.

Back up the central database and artifact blobs coherently, and document recovery of host-native sessions/worktrees and remote artifacts not yet imported. Test rollback on copied state; database migration compatibility must be checked before switching a binary backward.

## Delivery slices and acceptance

These are delivery slices for the complete requested scope, not permission to omit later features.

| Slice | Completion evidence |
| - | - |
| 0 Baseline and skills | Installed deployment and fork baseline recorded; exact 1.3 skill bundle/dependencies pinned; CLI compatibility and tracker setup plan verified; test deployment cannot overwrite live state |
| 1 Records and inbox | Projectless ideas, todos and chats persist through restart; projects have machine/CLI defaults; attaching an idea preserves identity and artifacts |
| 2 Specification workflow | Grill me and project-aware Grill with docs work; versioned spec/ticket graph visible; unresolved decisions block dependent execution; stale spec acceptance is rejected |
| 3 Codex factory | A user-started Implementation completes the pinned workflow through isolated integration/worker worktrees; checks and reviews retained; duplicate starts and unsupported launches refused |
| 4 Review and history | Diff comments remain anchored after rework; request-changes targets the correct run; Markdown/images/HTML render safely; artifacts and history survive cleanup |
| 5 Multiple CLIs | Codex, Claude Code and OpenCode tested against a capability matrix; defaults/overrides respected; unsupported capabilities fail clearly without provider substitution |
| 6 Remote and concurrency | Two independent Implementations run without file/port/state collisions; optional third subject to resource limit; laptop execution/reconnect tested; no duplicate run after SSH loss |
| 7 Retro and deployment | Project retro produces reviewable improvements; Kanban reflects evidence; backups restore database/artifacts; parallel deployment can be promoted and rolled back under owner scope |

Critical end-to-end scenario: capture an unassigned idea and research attachment; choose a project/machine; grill and approve a spec; manually start Codex factory; inspect and comment on its diff; request fixes; review new evidence; retain history after safely stopping the session; run a project retro.

Critical negative cases: invalid or changed specification; missing skill dependency; wrong repository/branch/cwd; dirty existing checkout; double start; interrupted launch; CLI unsupported; malicious Markdown/HTML/path; outdated review anchor; SSH disconnect and laptop sleep; browser/server restart during a question; cleanup with unpublished work; updater pointing to upstream.

Every slice needs focused behavior tests and a browser acceptance pass where applicable. Record what was actually verified and on which provider/machine versions.

## Decisions to settle during server kickoff

Resolve repository-answerable facts first. Ask only where a product choice or owner-only access remains:

- Exact fork owner/name, current deployment checkout/version, domain, machine paths and SSH reachability.

- Whether the existing issue-tracker setup should be reused per project; how an app-only project completes setup before becoming factory-enabled.

- Specification approval policy and final Done definition for the generic factory, without weakening existing project rules.

- Whether cross-machine continuation initially means choosing a host and reconnecting there, or whether explicit work transfer must also ship immediately.

- Artifact retention/size limits and whether interactive HTML needs JavaScript or external network access.

- Resource limits and which installed Claude Code/OpenCode versions must pass the first supported-provider matrix.

Recommended defaults above may be used for design and local tests; do not label them already answered by the owner.

## Server kickoff prompt

Copy this handoff into the fork's planning records and use the following instruction with it:

> We are extending our existing Herdr Web UI installation through a separate fork into the specification-driven factory described in this handoff. Codex is primary, but the architecture and delivered adapter matrix must support Claude Code and OpenCode. First inspect the actual installed deployment and intended fork checkout read-only, read their instructions, and pin the specified Matt Pocock 1.3 skill bundle. Preserve the working service, sessions and data. Reconcile this handoff into the fork's own glossary, specifications, issue-tracker setup and dependency-linked implementation plan. Honor manual starts, worktree isolation, durable app-owned chats/artifacts, review comments, project retrospectives and machine-aware execution. List genuine unresolved decisions and propose the first bounded slice with observable acceptance. Do not launch the whole implementation merely by reading this document. Once implementation is explicitly requested, follow the verified skill workflow and project permissions; make progress in the fork, not in Conteo.

No part of this handoff requires a new Codex desktop chat, cloud task, GitHub fork or server modification to be created by the agent delivering the handoff.

## Primary references for the receiving agent

- [Herdr Web UI source at the inspected commit](https://github.com/devswha/herdr-web-ui/tree/b87d9d50019cdb87422415f7650ad29285a832cc)

- [Herdr Web UI remote PCs](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/docs/remote-pcs.md)

- [Herdr Web UI user guide and proxy requirements](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/docs/guide.md)

- [Herdr automation](https://herdr.dev/docs/agent-automation/) and [CLI reference](https://herdr.dev/docs/cli-reference/); verify installed API schema before using commands.

- [Matt Pocock pinned skills tree](https://github.com/mattpocock/skills/tree/24fe0ef7737efae15c87225755e9f6f5965e4888)

- [Grilling](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/productivity/grilling/SKILL.md), [Grill with docs](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/grill-with-docs/SKILL.md), [To spec](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/to-spec/SKILL.md), [To tickets](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/to-tickets/SKILL.md), [TDD](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/tdd/SKILL.md)

- [Original Zazen factory reference](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code), for historical design inspiration only.

This handoff contains everything needed to recover the intended scope. Temporary research clones and notes from its preparation are not prerequisites for implementation.

## Additional owner checkout instruction

“And the fork of the herdr-web-ui should be forked with gh to my usergood name and checked out ot a folder here in /Personal here where we are.”

Current checkout and planning status are in [README.md](README.md); the original handoff's historical statements above remain preserved.
