# Automatic factory execution, Pause/Delete and Human Review

Accepted design from the owner's 2026-10-15 Q1–Q20 interview and Specification `c5060f3e-7ec0-4fc5-871a-644b1b1378e0`, revision 1, SHA-256 `bd4323c7f3fd01b0df7a49770e2d5dd3afd07e9b84b79af79a255c0f976c830a`. Its bounded Ticket graph was subsequently approved. This is the implementation target, not a claim that the runtime already implements it. Update operational instructions only as each behavior ships.

This design supersedes conflicting approval, capacity, Discard, recovery, board-ordering and conversation-role proposals in the [earlier interface design](interface-cleanup-design.md) and [original specification](specification.md). Unrelated decisions remain applicable. The earlier nine-file Q1–Q16 documentation proposal is source material; Q17–Q20 add Specifications drafting and conditional Human Review merge authority. The earlier idea that Orchestrator performs to-spec is superseded.

## Specification approval and automatic execution

Specifications owns the interview and to-spec, presents the current formal revision, and accepts it in the same conversation. One top approval button records acceptance without requiring a chat message. An attributable explicit accepted owner chat response has the same revision-scoped effect. Quoted, ambiguous, stale or unrelated text cannot approve a Specification. Preserve exact owner-answer receipts, versioned consumption and shared-understanding confirmation; do not reinterpret historical confirmation messages as this new chat approval.

Specification approval authorizes internal Ticket/dependency/test planning, fresh worker dispatch, implementation, backend integration, configured checks, independent Standards and Spec review, bounded repairs within scope and PR preparation/publication under the accepted workflow. Plans and evidence remain inspectable. Separate owner Ticket-graph, testing-plan and routine Continue/Retry gates are removed from this automatic path; record Specification-derived authority without fabricating owner receipts for internal plans.

Use implement-spec for whole-Specification coordination, tdd for bounded Tickets and code-review for independent review. Adapt app prompts and enforcement together so the pinned Ticket-planning skill does not restore its ordinary approval gate. Preserve native permissions, trusted readiness, dependencies, required Project checks and owner decisions about new scope. A changed Specification never silently replaces an executing Run's frozen contract. Ordinary capacity and reconnect waits recover automatically; bounded recovery that exhausts exposes the precise remaining problem and required owner action.

Execution uses fresh app-owned workers, isolated worktrees and reservations. The backend merger owns integration. The connection server remains authoritative for durable records; execution Machines own their native processes and worktrees. Stable conversation entries do not require one permanent native context or unmanaged children.

## Capacity and dispatch

One configurable normal cap N counts executing app-managed Agent contexts globally across Projects, providers and Machines. Ordinary terminals and independently launched agents are excluded. Keep the independent build cap; remove concurrent-Assignment admission and configuration, including the earlier per-Project implementing-Assignment cap. Introduce no backlog-size cap. Preserve saved agent/build limits; an old Assignment-limit value must not become a different agent limit during migration.

Exactly one additional owner-facing interview/pre-approval Specification context is shared across the app, so admitted execution can reach N+1. Further planning requests queue when that allowance is occupied. Implementation, review and repairs cannot use it based on their display names. Viewing, editing and approving existing Specifications, reading review diffs and using lifecycle/review controls require no spare Agent context; an executing Human Review assistant uses normal capacity.

Persist request identity, purpose, eligibility, reservation and waiting age. Give each free slot to the oldest eligible waiting Agent-context request globally, including Assignment coordinators and child work. Preserve age across restart and recoverable dispatch attempts. Skip unmet dependencies, owner-paused/deleting work and genuine admission restrictions; existing execution is not preempted. Reconcile accepted identities before further admission and atomically prevent duplicate reservations/launches.

Retained ownership and executing capacity are distinct. Safely park coordinators awaiting children and conversations awaiting owner answers; their continuations reenter the same queue and reacquire capacity before executing. A coordinator must yield the only slot when N=1. Release capacity only after verified non-execution; uncertain starts, disconnects and interrupted builds retain reservations. Internal yielding never marks the Assignment Paused. Show effective limits, occupants, planning allowance and uncertainty so ordinary waits need no manual retry.

## Pause and Resume

Pause is owner suspension of the whole Assignment, orthogonal to its Board lane. It is available for unfinished work without a spare Agent context. Durably record the request and block new dispatch before stopping all owned attempts, child agents and builds across Machines. Coordinate in-flight allocation/integration so a late response cannot bypass the acknowledged control.

Preserve dirty changes, worktrees, history and completed progress; Paused survives restart. Unreachable Machines or unknown execution leave Pause pending with its reason and retain uncertain reservations. Automatically reconcile after reconnect; claim stopped only after verification. Resume queues unfinished work from retained progress without repeating completed Tickets or asking for renewed approval of unchanged scope.

## Permanent Delete

Delete replaces retained-history Discard. Expose it for failed, stopped, paused, unfinished and finished Assignments, independently of Done/archive eligibility or agent capacity. Durably record deletion, block dispatch and stop/reconcile all owned execution before cleanup. Enumerate every attempt's ownership rather than only the current parent Run, and verify resource identity before removal.

Remove Assignment-owned records, chats, retained transcripts, Specifications, Tickets, approvals, events, checks, review evidence, exclusive artifacts/attachments, notes, caches, temporary state, native workspaces, dirty/ignored worktrees and Assignment-only local branches. The conservative clean-worktree cleanup operation is insufficient. Delete linked GitHub issues permanently; closing them does not satisfy Delete. Preserve PRs, pushed branches, primary checkouts, unrelated workspaces and shared Project resources. Shared content survives independent references; remove this Assignment's references and exclusive content.

Purge the Assignment from existing app-managed backup snapshots and recovery copies while preserving other Assignments' recoverability and valid hashes. Coordinate concurrent backup creation and restore so in-flight copies cannot restore deleted content. Owner-exported copies and provider-managed conversation stores outside the factory are explicit exclusions.

After cleanup retain only minimal repository/source identifiers suppressing automatic recreation from deleted issues, retained PR automation or stale synchronization, with no Assignment content/history. Intake from that source again requires a fresh explicit owner action. Pending cleanup retains only the identity/progress necessary to finish; do not erase it prematurely.

Repeated or interrupted requests reconcile safely without duplicate effects. Offline Machines, uncertain execution, denied/ambiguous issue deletion or failed backup cleanup leave Delete pending with a concrete reason; recover automatically when possible. Final deletion requires confirmation of every required cleanup. Deleting externally finished work does not certify factory validation or delivery.

## Board and conversation hierarchy

Keep five Board lanes: Inbox, Queued, Running, Needs you and Done. Assignment cards show active Ticket names and an expandable complete Ticket list with waiting/running/completed counts and concrete blocking reasons. Show overlapping colored text activity tags such as Specifying, Implementing, Testing, Auto-Review and Fixing, with Paused separately. Retained prior activity must not imply execution while paused. Remove priority arrows and drag ordering because global waiting age controls dispatch. Use accessible labels and existing theme tokens; color alone conveys no meaning.

Keep these stable logical entries and their history across native-context handoffs and restart:

```text
Assignment
  Specifications
  Orchestrator
    Implementation — <Ticket title>
    Reviewer
      Standards
      Spec
    Review-fixes — <automatic repair>
  Human Review
    Review-fixes — <submitted owner-feedback batch>
```

Specifications performs interview/drafting. Orchestrator starts after Specification approval. Reviewer is a display grouping, not a third reviewer agent. Independent Standards and Spec contexts retain separate evidence. Automatic repairs remain beneath Orchestrator; fresh owner-feedback fixes belong beneath Human Review without moving earlier history. Display identity changes neither reservations nor eligibility for the planning allowance.

## Human Review and merge authority

After passing automatic checks and reviews with a PR available, park Orchestrator and hand off to Human Review. The owner gets an assistant conversation, file tree, readable navigable Git diffs and direct old/new line or range comments on desktop and mobile. Preserve captured snapshot/head/path/change/side/range provenance and binary/oversized/renamed/deleted-file handling. Drafts survive file navigation and reload; discussion or drafting alone launches no fixes and authorizes no merge.

Submit Approve or Decline with the complete draft batch as one revision-bound, repeat-safe operation tied to the exact snapshot and candidate head. Retain original anchors. Changed candidates expose stale anchors/authority for explicit reconciliation rather than silently applying feedback to another diff. Keep drafts separate from submitted history.

Each submitted human-feedback batch creates fresh Review-fixes work beneath Human Review, linked to its comments and reviewed revision. Keep comment-to-fix evidence. Fresh checks and independent Standards and Spec reviews cover the repaired candidate; results return to the same Human Review conversation. The assistant uses normal capacity while executing, consumes none while parked and yields while its fix workers run.

| Disposition | Effect |
| --- | --- |
| Approve without comments | Authorize merge of the current valid checked and independently reviewed candidate. |
| Approve with comments | Authorize fixes for that exact batch and necessary in-scope repairs, then merge after fresh passing checks and independent reviews without a second human approval for those repairs. |
| Decline | Submit comments for repair without merge authority; return the checked/reviewed result to the same Human Review conversation for later explicit approval. |

Make the merge effect clear in the interface. Bind conditional authority to the original review and repair lineage: authorized fixes do not invalidate it merely by changing the head, and unrelated future changes do not inherit it. New scope, unrelated changes or stale/invalid authority need an owner decision. Duplicate submissions, lost responses and repeated reconciliation must not duplicate fix batches or merges.

Revalidate the candidate against the Project's authorized repository/target branch, required CI/review constraints and merge policy. Conflicts, permission failures and unknown merge outcomes stay visible and are reconciled without claiming success. Human Review approval preserves native controls, required checks, independent reviews and repository protections. Specification approval alone never grants blanket merge authority.

Done still requires verified merge covering intended changes, followed by a containing release when required by the Assignment's frozen Project delivery milestone. Approval, checks, PR publication, issue closure or a clean worktree alone are insufficient. Release, deployment and website publication retain their separate authorization.

## Validation and provenance

Use the owner-confirmed public authenticated HTTP/API through server creation with disposable state and owned native/Machine/GitHub fixtures, plus desktop/mobile browser journeys covering every human step. The seam answer was “Yes public http/api, mobile and desktop views. And all human steps.” Add no internal acceptance seam. Apply red → green one behavior at a time in the implementation Tickets; this documentation Ticket changes no runtime behavior and adds no runtime tests.

Cover automatic approval-to-PR progress, exact-revision button/chat approvals, capacity saturation and N=1 handoffs, durable oldest-first dispatch, pending Pause/Delete and restart/late-response races, all-attempt cleanup and backups, protected shared resources, issue deletion/re-import suppression, named history and board progress, comment drafts/staleness, each Approve/Decline path, repeat submissions and merge reconciliation. Test fixtures never launch paid agents, delete live issues or mutate owner work. Use owned repositories/workspaces and bounded polls. Native capability evidence remains separate from fixture evidence.

Changed HTTP/WS contracts require shared snake_case types, server enforcement, browser/demo handling and contract coverage. Preserve standard error envelopes, authentication/origin checks, Machine scoping, private atomic state writes, bridge invariants, accessibility, tokens and translations. Run required Project/repository checks and independent Standards/Spec reviews on one final revision, including repaired and cross-Ticket journeys.

The initial report established missing removal controls and confusing capacity waits, not a proven live reservation root cause. Earlier Q1–Q16 confirmation and notes describing Q17–Q20 as unsynchronized are historical: the accepted Specification incorporates the retained answered Q1–Q20 receipts and confirmed seams. This record does not rewrite historical Runs' frozen approvals or authorize live cleanup/publication/merge/deployment during this documentation Ticket.
