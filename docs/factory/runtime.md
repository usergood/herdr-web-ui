# Saurons eye runtime

The owner requested implementation of the full specification and confirmed both testing seams: the public HTTP interface with temporary state and owned fixtures, and the real browser client. SQLite and the app-native Other tracker are the initial implementation choices. Existing native chats and terminals remain available before factory preparation.

## Start and configure

Open Inbox, capture an Implementation, and add chats, notes or attachments. Select a Project later without changing the Implementation's identity. Register an existing Git checkout and verify another checkout for each execution Machine. Machine onboarding uses the existing SSH dialog with `user@hostname` or an address; an SSH alias is optional.

Configure known check and setup recipes as JSON argument arrays, execution permissions, task environment and shared document paths. Recipes run without shell interpolation. Native contexts and checks get private cache, temporary, database and notes directories; programs should honor the supplied `PORT=0` and `FACTORY_*` environment. Dependencies are installed by the explicitly configured setup recipes. Ignored secrets are not copied from the primary checkout.

For remote execution, the selected Machine must reach the connection server's authenticated app address. `HERDR_FACTORY_PUBLIC_URL` selects that HTTP(S) callback origin; otherwise the request origin is used. `createServer({ factory: { publicUrl } })` provides the same per-instance configuration. Use the deployed HTTPS or reachable private-network address when a browser connects through localhost. SSH onboarding does not require an alias.

Prepare this Machine verifies the complete pinned source under private application state. It installs no global plugin. A Run freezes the source commit and every locked file hash, the effective provider/Machine, verified checkout/base/instructions, specification, graph, approvals, artifact references and permissions.

The connection server owns `stateDir/factory/records.sqlite`, immutable blob files and history. Machines own their operational leases, native sessions and worktrees. SSH never shares a SQLite file. Keep a separate state directory, port and Herdr session for development; use the repository's `check` runner for acceptance.

## Native eligibility and owner gates

Codex Project references are managed from Inbox → Projects or a linked Implementation. Upload a guide/picture, set its usage note and reading policy, and use the guide template for reusable instructions. New Codex Runs/workers receive a frozen library index outside Git; Prepare Codex references returns a prompt for manually started sessions. See [Codex Project references](codex-project-references.md) for the template, limits, bridge requirements and native read proof.

Start native verification uses the selected native CLI in an owned disposable context. Verify native evidence requires genuine project-local loading of every required skill and a real recorded question/answer/consumption round. A test adapter or a client-supplied `verified` flag cannot certify a provider. Changed source or provider versions invalidate the proof.

Codex uses project-local `.agents/skills`, Claude uses `.claude/skills`, and OpenCode uses `.opencode/skills`. OpenCode receives a separate local agent policy because it does not share Claude's invocation metadata. These are adapter projections of the exact pinned source, not edits to the vendor. Native child-agent tools are restricted so contexts use the application reservations. Existing native permission prompts remain operative. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode skill permissions](https://opencode.ai/docs/skills/).

Workflow approvals remain owner decisions. The chat-side Workflow panel uses a scoped Continue operation to retain a resting planning handoff, complete that step without closing its chat and start the accepted successor. A recorded implementation intent may first run genuine native verification and then continue on collector/consumption events after the proof is valid. Remote readiness uses bounded observation of the accepted Run identity, including recovery after a bridge restart; it never redispatches an uncertain probe. Native uncertainty and missing evidence retain their reservations. Retrospective and publication keep their own scopes. Verification questions and consumption revisions are scoped to their probe; product revisions exclude these Machine setup questions while retaining full history. Questions retain either an explicit saved answer or one unambiguous reply from the verified native history of their own Run. Ambiguous or incomplete native evidence stays pending. An older pending confirmation does not block an attributable reply to a later text question. Confirmation questions are resolved only by the explicit shared-understanding decision, which binds to the resulting revision. Saving the final answer can send its context on the same explicit owner action, with a durable delivery receipt; an uncertain send does not replay. The CLI records consumption of the exact answered revision. Specification versions and graph approvals are immutable and scoped; their testing seams are supplied to affected workers.

Specifications now presents the current Specification with one Accept specification button at the top of its history. The button records acceptance of the displayed ID and hash without a chat reply or free Agent context. The Specification reply field retains owner text; a standalone `accepted`, `approved`, `I accept` or `I approve` accepts that presented revision. Quotes, conditions and unrelated text remain discussion. Superseded IDs or hashes are rejected. Reply identities and acceptance receipts survive restart and repeated delivery.

Native to-spec contexts can also retain explicit acceptance: after submitting a Specification through the scoped tracker, the assistant ends its presentation with `Specification <returned id>, SHA-256 <returned hash>`, a blank line and the full returned content as its final text part. Synchronizing an immediately following standalone owner acceptance records that current revision with Run, snapshot, source and turn provenance. Tool/thinking parts earlier in the assistant turn do not replace the presentation. An intervening unanswered question, missing times, another Run or a superseding Specification prevents attribution. Generic imported notes and historical confirmations never grant approval. Shared-understanding confirmation and exact answered-revision consumption remain separate. This records Specification authority; automatic planning/progression is separate implementation work.

Factory admission requires an accepted current specification, testing seams and acyclic graph, the app-native tracker, known Project checks/permissions, matching pinned skills and verified native provider. Unsupported providers keep ordinary chat and show their eligibility reasons. External tracker publication, pushes, default-branch merges and deployment are separate owner scope.

Creating a specification revision invalidates the current Ticket graph for future admission while retaining its immutable graph history and active Run contracts. A failure proven to occur before any native allocation releases admission as Failed and preserves any generated files; ambiguous launches retain ownership.

## Work, review and history

Assignment details and the Project sidebar now preserve named Specifications, Orchestrator and Human Review entries across native-context handoffs. Ticket implementations, independent reviewer contexts and repair histories retain their original parentage and provenance. This is a history/navigation view; automatic startup and Human Review execution remain separate implementation work. See [Workflow conversation history](workflow-conversations.md) for the current behavior and wire metadata.

The integration branch and worktree belong to the Run. Implementers receive separate worktrees at the current integration tip. The scoped tracker exposes stable Ticket IDs, accepted context, questions, versioned answer consumption, worker operations, checks and proposal operations. Its private capability lives in a 0600 file and cannot approve specifications or control another Run.

Only the dependency frontier can start ordinary Ticket work. Shared document claims exclude competing writers. Workers reconcile the current integration tip, run the configured checks and submit a committed candidate. The serialized backend merger rejects stale tips, changed cwd/branch/repository, dirty tracked changes, unclaimed shared documents and committed application scaffolding. It retains the branch and never updates the default branch.

The native adapter includes an exact request guide and `bun .saurons-eye-tracker.mjs help`. A blocked worker remains an owner-answer gate; a ready worker is a candidate awaiting explicit checks/integration. Integrating all accepted Tickets moves the card to Review; acceptance still requires current evidence and does not infer publication.

Agent-context reservations cover active and uncertain app-managed execution globally across Projects, providers and Machines. The default normal limit is six Agent contexts, with one additional shared interview/pre-approval Specification context; implementation and review cannot use that allowance. Builds have a separate default limit of two. Inbox exposes Factory settings and recovery. Ready chats consume no execution slot but retain their worktree ownership. Ordinary terminals and independently launched agents are excluded.

Start and child-worker requests durably queue when capacity is occupied. The dispatcher reconciles accepted identities and admits the oldest eligible request without preempting running work. Request identity, purpose, waiting age and reservations survive restart; dependency-blocked work does not block eligible requests. Capacity and reconnect waits recover automatically. Machine recovery uses six bounded attempts with backoff, then shows the remaining problem and required inspection in the capacity panel. Unknown launches keep their reservations and are observed rather than launched again. Queue metadata is public; retained request bodies and tracker credentials stay private. Cross-machine failover is not implemented.

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

The extended genuine Codex journey also passed initial Ticket work, owned candidate checks/integration, separate Standards and Spec reports, selected Request changes, a fresh rework worker, new integration/checks/reviews, owner resolution and acceptance, native history retention and preservation of the primary checkout. It uses the UI's explicit worker controls rather than claiming automatic backlog dispatch:

```sh
bun run check run bun scripts/factory-native-contract.ts codex --journey
```

The runner retains failed fixtures for diagnosis. `--resume-state /tmp/saurons-eye-native-XXXXXX` continues only a test-owned directory; genuine provider/source proof is revalidated and a new repository/Implementation is created. This is test evidence reuse, not native execution resume or copied-state activation.

Before promotion, run the complete primary journey with the intended CLI/Machine versions, including ticket rework, fresh review evidence, interruption/reconnect and copied-state recovery. Preserve the evidence and limitations from each run.
