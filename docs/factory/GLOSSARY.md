# Proposed factory glossary

Vocabulary proposed by the owner for review before API contracts are committed. These are product terms; technical storage and protocol decisions belong in the specification.

| Term | Meaning |
| --- | --- |
| Implementation | A durable assignment being explored, specified, built and reviewed. It may begin as an idea, todo or research effort without a Project. |
| Ticket | A bounded child unit of an Implementation's specification, with acceptance criteria and dependencies on other Tickets. |
| Run | One attempt to perform one workflow action using a selected CLI provider and execution Machine. |
| Project | A registered software project with repository identity and approved workflow defaults. |
| Project checkout | A Project's verified repository checkout on a particular Machine. |
| Machine | An identified execution host, such as the server or an SSH-connected laptop. |
| Provider | A CLI agent integration, initially Codex, Claude Code and OpenCode. |
| Chat | A durable application conversation, optionally linked to an Implementation or Project. |
| Artifact | A retained upload or generated output with ownership, versions and originating context. |
| Specification version | An immutable revision of an Implementation's agreed requirements and acceptance criteria. |
| Approval | An owner's recorded acceptance of a specific action, scope and revision. |
| Review snapshot | The fixed revisions or captured workspace state against which changes were reviewed. |
| Finding | An actionable review concern with an anchor, evidence and resolution state. |
| Retrospective | A project-scoped examination of selected session evidence and proposed environment improvements. |
| Workflow stage | The phase an Implementation is in, such as specifying, implementing or reviewing. |
| Run condition | The execution condition of an attempt, such as working, waiting for an answer, interrupted or disconnected. |
| Delivery outcome | What was delivered, such as implementation complete, PR open, merged or released. |
| Inbox | Unassigned ideas, todos, research efforts and chats retained before Project selection. |
| Backlog | The owner's ordered list of planned work. Order does not authorize execution. |
| Integration worktree | The dedicated checkout that gathers one active Implementation's Ticket results. |
| Worker worktree | A dedicated checkout owned by one Ticket implementer. |
| Needs you | A visible unresolved question or owner decision, without replacing the Implementation's workflow stage. |

Herdr's existing **workspace**, **pane** and native **session** terms keep their upstream meanings. A pane is not an Implementation, and closing it does not complete or delete the assignment. In engineering-skill prose, lower-case “implementation” can mean a module's code; use capitalized **Implementation** for the product record.
