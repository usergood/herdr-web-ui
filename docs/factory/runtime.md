# Saurons eye runtime

The owner requested implementation of the full specification and confirmed both testing seams: the public HTTP interface with temporary state and owned fixtures, and the real browser client. SQLite and the app-native Other tracker are the initial implementation choices. Existing native chats and terminals remain available before factory preparation.

## Start and configure

Open Inbox, capture an Implementation, and add chats, notes or attachments. Select a Project later without changing the Implementation's identity. Register an existing Git checkout and verify another checkout for each execution Machine. Machine onboarding uses the existing SSH dialog with `user@hostname` or an address; an SSH alias is optional.

Configure known check and setup recipes as JSON argument arrays, execution permissions, task environment and shared document paths. Recipes run without shell interpolation. Native contexts and checks get private cache, temporary, database and notes directories; programs should honor the supplied `PORT=0` and `FACTORY_*` environment. Dependencies are installed by the explicitly configured setup recipes. Ignored secrets are not copied from the primary checkout.

Prepare this Machine verifies the complete pinned source under private application state. It installs no global plugin. A Run freezes the source commit and every locked file hash, the effective provider/Machine, verified checkout/base/instructions, specification, graph, approvals, artifact references and permissions.

The connection server owns `stateDir/factory/records.sqlite`, immutable blob files and history. Machines own their operational leases, native sessions and worktrees. SSH never shares a SQLite file. Keep a separate state directory, port and Herdr session for development; use the repository's `check` runner for acceptance.

## Native eligibility and owner gates

Start native verification uses the selected native CLI in an owned disposable context. Verify native evidence requires genuine project-local loading of every required skill and a real recorded question/answer/consumption round. A test adapter or a client-supplied `verified` flag cannot certify a provider. Changed source or provider versions invalidate the proof.

Codex uses project-local `.agents/skills`, Claude uses `.claude/skills`, and OpenCode uses `.opencode/skills`. OpenCode receives a separate local agent policy because it does not share Claude's invocation metadata. These are adapter projections of the exact pinned source, not edits to the vendor. Native child-agent tools are restricted so contexts use the application reservations. Existing native permission prompts remain operative. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode skill permissions](https://opencode.ai/docs/skills/).

Grill me, Grill with docs, Create specification, Plan tickets, Start factory and retrospective are separate owner actions. Questions persist unanswered until the owner saves an answer. Send answered context is explicit and has a durable delivery receipt; an uncertain send does not replay. The CLI records consumption of the exact answered revision. Specification versions and graph approvals are immutable and scoped; their testing seams are supplied to affected workers.

Factory admission requires an accepted current specification, testing seams and acyclic graph, the app-native tracker, known Project checks/permissions, matching pinned skills and verified native provider. Unsupported providers keep ordinary chat and show their eligibility reasons. External tracker publication, pushes, default-branch merges and deployment are separate owner scope.

## Work, review and history

The integration branch and worktree belong to the Run. Implementers receive separate worktrees at the current integration tip. The scoped tracker exposes stable Ticket IDs, accepted context, questions, versioned answer consumption, worker operations, checks and proposal operations. Its private capability lives in a 0600 file and cannot approve specifications or control another Run.

Only the dependency frontier can start ordinary Ticket work. Shared document claims exclude competing writers. Workers reconcile the current integration tip, run the configured checks and submit a committed candidate. The serialized backend merger rejects stale tips, changed cwd/branch/repository, dirty tracked changes, unclaimed shared documents and committed application scaffolding. It retains the branch and never updates the default branch.

Build and native reservations cover active and uncertain contexts across Implementations. The initial limits are two Implementations, six native contexts and two builds; the owner can permit a third Implementation. There is no backlog scheduler or cross-machine failover. Reconciliation observes accepted identities; it does not redispatch a launch.

Branch review compares the recorded base/head. Workspace review captures staged, unstaged and untracked changes. Snapshots are immutable and private generated files are excluded. Findings retain snapshot/path/side/line/hunk anchors; changed captures mark them outdated. Request changes freezes only the selected drafts. A delivered batch can start an owned rework worker. Resolution and acceptance require fresh checks and separate native Standards and Spec reports at the current head.

Artifacts have hashes, size limits, versions, provenance, annotations and source/download actions. HTML uses an opaque sandbox and restrictive CSP. Imported remote outputs remain available centrally while the Machine sleeps. Referenced deleted versions retain their blobs for historical and retrospective evidence. The blob quota includes retained blobs; backups and native checkouts occupy additional storage.

Stop releases only the verified owned native resources and retains work/history. Cleanup checks every generated file, refuses unexpected or ignored outputs and uncommitted changes, and removes only clean stopped checkouts. It preserves Git branches and sibling notes. Native conversation pages can be retained explicitly and a Stop attempts a final capture; unavailable or older native pages remain a visible import limitation rather than an invented transcript.

Retrospectives use only a selected retained Project evidence set. Candidates are immutable records. Approval and Apply in a new worktree are separate actions; the pinned retro action presents candidates without applying them.

## Backup, restore and rollback

Create verified backup captures the database and referenced blobs under one SQLite reservation, verifies hashes and publishes an immutable private directory. Restore verifies schema, integrity and every blob, then creates a separate state directory with execution disabled. It never replaces the working state or activates native leases.

For an upgrade rehearsal, restore a copy, start an isolated instance against that copy, and inspect retained records and artifacts through the UI/API. Keep the original service, checkout and state unchanged. Run the previous compatible application against its own restored copy to rehearse rollback. A newer unsupported schema fails closed. Promotion, credential/device migration and service changes require a separately chosen deployment target and owner dispatch.

Backups cover application records and imported blobs. Git repositories, native transcript stores, worktree outputs that have not been imported, SSH credentials and device/transport configuration require their own machine backups. Do not claim those are present in a database/blob restore.

## Validation

Focused contracts use owned Git/Herdr resources and authenticated bridge fixtures. The browser runner covers capture, notes, restart, desktop/mobile and malicious HTML isolation. `scripts/factory-native-contract.ts` is an optional genuine-provider check using the owner's installed CLI/authentication in an isolated Herdr session:

```sh
bun run check run bun scripts/factory-native-contract.ts codex
```

The genuine Codex 0.162.1 probe passed loading of all 14 pinned skills plus the recorded question/answer/consumption round on this host. That is loading/interaction evidence, not a claim that the entire Ticket factory journey has passed. Use `claude` or `opencode` only when that native CLI is installed and signed in. This check does not install or substitute a provider. A live external Machine acceptance pass additionally needs a reachable SSH address and its owner's credentials; a fixture is not evidence that an unspecified laptop has passed.

Before promotion, run the complete primary journey with the intended CLI/Machine versions, including ticket rework, fresh review evidence, interruption/reconnect and copied-state recovery. Preserve the evidence and limitations from each run.
