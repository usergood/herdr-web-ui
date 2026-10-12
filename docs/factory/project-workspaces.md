# Project workspaces

Projects are managed independently of Inbox. The sidebar lists each active Project,
its Inbox chat shortcut, Assignments (durable Implementations), and linked native
chats and worker panes. Herdr owns all native panes and processes.

## Acceptance criteria

- Create, rename, edit workflow/defaults and verified checkouts, remove and restore
  Projects through a dedicated Projects page. Removal hides the registration but
  retains history, references and checkouts; refuse removal while work is active.
- Select only registered Machines by their roster names. Browse folders on the
  selected Machine with the existing DirectoryBrowser; verify repository identity
  on the server. A removed host remains historical provenance, not a selectable
  execution option.
- Capture ideas globally or from a Project Inbox shortcut. Project capture assigns
  the Project atomically. External capture continues through the same Inbox API.
- Match native panes by explicit Run/worker provenance first, then by the longest
  checkout-directory boundary on the same Machine. Do not match sibling prefixes.
  Linked chats leave the ordinary Herdr roster; unmatched panes remain there.
- Show worker panes below their Assignment with provider marks. Native background
  tasks use the existing task API when their parent is expanded; do not add status
  subscriptions or infer parenthood from names.
- Completed Assignments and idle/done native chats can be archived from the chat
  header. Hide them from active navigation, retain history, and offer restoration.
  Archiving never closes a native pane or marks unfinished work complete.
- Project workflow instructions and a 150,000–200,000 token context target are
  persisted, validated and frozen into newly started Runs and worker prompts.
  Explain that the target is handoff guidance, not a measured hard token limit.
  Existing pinned Matt Pocock skill verification, approved Tickets, bounded workers,
  checks and independent Standards/Spec review remain mandatory.

## Confirmed testing seams

Reuse the owner's confirmed public HTTP/API seam (`createServer` with disposable
state and owned repositories) and real browser journeys with fictional fixtures.
HTTP tests cover lifecycle, archive guards, capture ownership and workflow policy.
Browser tests cover navigation, folder browsing, registered host names, directory
boundaries, child relationships, unmatched panes and archive/restore controls.

The proposed `no-mistakes` gate is researched separately in
`project-workflow-and-context-research.md`; no third-party daemon is installed or
enabled by this change.
