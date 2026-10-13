# Saurons eye

Confirmed vocabulary for Projects and their durable work. Earlier unresolved proposals remain in `docs/factory/GLOSSARY.md`.

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

**Board lane**:
An Assignment's overall position in the work lifecycle: Inbox, Queued, Running, Needs you or Done.
_Avoid_: Workflow activity

**Workflow activity**:
The kind of work currently being performed or awaited for an Assignment, such as specifying, implementing, validating or reviewing.
_Avoid_: Board lane

**Discarded**:
An Assignment intentionally finished without delivering its proposed changes, with its history retained.
_Avoid_: Deleted, delivered

**Agent-ready issue**:
A GitHub issue whose planning is complete and whose approved scope is selected for automatic implementation under its Project's readiness rules.
_Avoid_: Unplanned idea
