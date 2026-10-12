# Project workspaces

Projects are managed independently of Inbox. Project settings use the same dialog
layout and navigation as the existing Settings view. Global Inbox and Project Inbox
are independent pages; Project Inbox content is restricted to its Project. The sidebar lists each active Project,
its Inbox chat shortcut, Assignments (durable Implementations), and linked native
chats and worker panes. Herdr owns all native panes and processes.

## Using Projects

1. Open **Projects** in the sidebar. Enter a name, select a registered host by name,
   and use **Browse… → Use this folder** to choose the repository root.
2. Open the settings button beside the Project’s name to rename it or configure its workflow, execution checks,
   permissions, accounts, GitHub integration and shared reference library. Verify a
   checkout on each host you want to use. A removed host must be explicitly replaced.
3. The Project name opens its Assignments page. Use **Inbox chat** beneath the Project to capture an idea directly into that
   Project. Global **Inbox** accepts manual and externally imported ideas. Open
   **Assignments** to find all work, including progressed unassigned work and history
   belonging to removed Projects.
4. Open an Assignment or its child worker from the Project tree. Native chats match
   checkout directories on their own host; recorded workers use their frozen Run's
   Project even when their worktrees live elsewhere.
5. Use **Archive task** on a finished Assignment or **Archive chat** on an idle/done
   native chat. Restore Assignments through **Assignments → Archived tasks**, and
   native chats through **Projects → Archived chats**. Both Inbox pages are standalone;
   herdr tabs are shown only when you open a native pane. Removal and archiving retain
   records; native panes keep their herdr ownership.

The context field is handoff guidance for fresh, bounded Ticket workers. It does not
measure usage or forcibly stop a CLI at the selected token count. No-mistakes remains
a researched candidate rather than an enabled gate. Removing a Project pauses its
GitHub synchronization; restoring the registration resumes its saved policy.

## Acceptance criteria

- Global Inbox and Project Inbox are standalone pages without native herdr tabs.
  Project settings use the Settings dialog layout and their own section navigation.
  On a phone, system Back returns from a section to its list before closing the
  dialog; closing settings returns to that Project's Assignments page.
- Create, rename, edit workflow/defaults and verified checkouts, remove and restore
  Projects through a dedicated Projects page. Removal hides the registration but
  retains history, references and checkouts; refuse removal while work is active.
- Select only registered Machines by their roster names. Browse folders on the
  selected Machine with the existing DirectoryBrowser; verify repository identity
  on the server. A removed host remains historical provenance, not a selectable
  execution option.
- Capture ideas globally or from a Project Inbox shortcut. Project capture assigns
  the Project atomically. External capture continues through the same Inbox API.
- Assignments remain discoverable after progressing beyond Inbox, including work
  without a Project and work whose Project registration was removed.
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

## Browser evidence

The [desktop and phone screenshots](../screenshots/project-workspaces/) use owned
fictional fixtures. `scripts/factory-browser-regression.ts` verifies the real client
through Project lifecycle, folder selection, task hierarchy, native close/reorder
scopes, global/Project Inbox isolation, chat archives, restart and mobile settings.
