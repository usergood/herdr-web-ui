# Saurons eye

Confirmed vocabulary for Projects and their durable work, including the accepted Q1–Q20 workflow design. Definitions describe the agreed domain; runtime availability is documented separately. Earlier unresolved proposals remain in `docs/factory/GLOSSARY.md`.

## Language

**Assignment**:
A durable work item that can be explored, specified, implemented, reviewed and delivered within a Project or begin without one. An independently deliverable GitHub issue corresponds to one Assignment.
_Avoid_: Task, worktask

**Ticket**:
A bounded child unit of an Assignment's agreed specification, with acceptance criteria and dependencies on other Tickets.
_Avoid_: Subtask

**Run**:
One attempt to perform one workflow action for an Assignment.
_Avoid_: Assignment, session

**Agent context**:
An app-managed agent conversation performing or coordinating Assignment work, including implementation and review. Ordinary terminal panes and independently launched agents are outside this boundary.
_Avoid_: Assignment, Run, terminal session

**Board lane**:
An Assignment's overall position in the work lifecycle: Inbox, Queued, Running, Needs you or Done.
_Avoid_: Workflow activity

**Workflow activity**:
The kind of work currently being performed or awaited for an Assignment, such as specifying, implementing, validating or reviewing.
_Avoid_: Board lane

**Paused**:
An Assignment whose execution the owner has temporarily suspended while preserving its work and progress for continuation.
_Avoid_: Discarded, deleted, completed

**Delete**:
Permanent removal of an Assignment, its factory-owned work and linked GitHub issues within the agreed ownership boundary. PRs and pushed branches remain.
_Avoid_: Discard, archive, delivered

**Agent-ready issue**:
A GitHub issue whose planning is complete and whose approved scope is selected for automatic implementation under its Project's readiness rules.
_Avoid_: Unplanned idea

**Specifications**:
The stable owner-facing conversation for an Assignment’s interview, formal Specification drafting and acceptance.
_Avoid_: Orchestrator

**Orchestrator**:
The stable conversation coordinating automatic execution of an accepted Specification and its implementation, independent review and repair work.
_Avoid_: Specifications, Human Review

**Human Review**:
The stable assistant-backed conversation where the owner reviews a proposed result, submits comments and approves or declines it. Approval authorizes merge within the submitted review’s scope and conditions.
_Avoid_: automatic review, Specification approval

**Review-fixes**:
Fresh repair work linked to the review feedback that requested it, beneath Orchestrator for automatic feedback or Human Review for owner feedback.
_Avoid_: Implementation, Reviewer
