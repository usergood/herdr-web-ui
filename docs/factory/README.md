# Saurons eye

**Saurons eye** (`saurons-eye`) extends the `usergood/saurons-eye` fork with durable ideas, Projects, Implementations and a manual specification-to-delivery workflow. The owner requested the complete implementation and confirmed the public HTTP/API and real browser testing seams. The earlier planning-only boundary is historical.

Start with [runtime.md](runtime.md) for configuration, execution, review, remote-machine onboarding and recovery. The [specification](specification.md) remains the complete product contract. Production service changes, external publication and deployment retain their separate owner scope.

Use [account setup](account-setup.md) to create Machine profiles, authorize native subscription/OAuth logins, generate and register GitHub keys, and bind accounts to a Project. The [account specification](account-profiles.md) describes the implementation; [the research](project-account-profiles-research.md) records its primary sources and initial design.

Inbox and Project Inbox expose **Factory settings and recovery** directly. The same global
controls remain under **Projects → Factory**. Set **Concurrent Implementations** and **Native
context limit** to 6 to admit six tasks; Projects inherit these limits. The default task limit
is 6, and both limits support up to 32. Existing saved limits are preserved until you save them.

A native turn at rest is `ready`: its chat stays open and its worktree remains owned, but it
no longer consumes an execution slot. Continuing the chat counts it again. Pending owner
questions, background work and uncertain/disconnected execution retain capacity. Ready does
not accept an implementation or integrate a Ticket; those still require the owner and checks.

## Interface cleanup design

The [interface-cleanup design](interface-cleanup-design.md) records the agreed five-lane board, delivery-based completion, planned GitHub issue batches, opt-in implementation queue and scheduled upstream intake. These are planned changes pending Specification, Tickets and implementation. Existing runtime behavior remains documented below. Confirmed terms live in the [root glossary](../../GLOSSARY.md); the older proposal remains in the planning history.

## Records and source

The connection server owns the SQLite records, imported artifacts and evidence. Execution Machines own their worktrees and native processes. Repository-writing Runs use owned worktrees; the primary checkout is preserved. Existing ordinary chats and terminals remain available.

The complete Matt Pocock `v1.3.1` source is retained in `vendor/matt-skills`, pinned to `24fe0ef7737efae15c87225755e9f6f5965e4888`. [skills.lock.json](skills.lock.json) records every file and its Git identity. Each Run also freezes the verified SHA-256 manifest, selected scope and effective configuration. Project-local preparation installs no global plugin.

## Validation and operation

[Local inventory](local-inventory.md) records the observed tools and service state. No deployment checkout or external SSH address has been selected. An SSH alias is optional: onboarding accepts an address such as `user@hostname`.

Codex is the installed primary provider. Native readiness requires genuine pinned loading and a recorded owner-question round; a fixture adapter cannot certify it. Claude Code and OpenCode remain disabled for factory admission until their installed versions pass the same native contract on their selected Machine. Focused API, browser and genuine native validation are described in [runtime.md](runtime.md).

Manual starts are the first-version scope. Reordering, reconnecting and changing defaults do not dispatch or migrate work. The app retains uncertain ownership and requires explicit observation/control of accepted identities. Global limits cover root agents, Ticket workers, independent review contexts and builds.

The [local dictation and queue research](local-transcription-and-queue-research.md) records a
working CPU Whisper benchmark and proposes managed transcription setup plus an automatic queue
for factory Implementations only. These remain proposed extensions; existing worker controls,
owner approvals and ordinary chat behavior retain their current scope.

The [model selection implementation](agent-model-selection.md) loads native model and reasoning catalogs, saves Project defaults, and allows explicit task overrides inherited by owned workers. The [provider admission research](provider-admission-research.md) records the remaining subscription/API spending rules and quota-reset resumption requirements; those rules are not active automation.

## Planning provenance

The original [handoff](handoff.md), [baseline](baseline.md), [dependency plan](implementation-plan.md), [glossary](GLOSSARY.md), [skills/provider research](skills-and-providers.md) and [server kickoff](server-kickoff.md) preserve the earlier decisions and source investigation. Their historical planning statements do not revoke the later implementation request or confirmed testing seams. There is no Conteo work in this repository.

## Project navigation and workflow

[Project workspaces](project-workspaces.md) describes independent Project management,
host-scoped folder selection, sidebar assignments and native chats, archive/restore,
and frozen workflow/context targets. The [review gate and context research](project-workflow-and-context-research.md)
explains why no-mistakes is not enabled and why provider compaction does not prove a hard token cap.
