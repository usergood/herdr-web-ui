# Starting work from Inbox

Restore the global Agents overview: it lists native agents across Projects and
unassigned workspaces. Project grouping filters the workspace tree only.

An idea needs a title, optional notes and a Project. Its main actions are:

- **Start work** opens a new native agent workspace with the idea and Project
  defaults. Existing changes in the primary checkout remain untouched; the owned
  workspace starts from its committed revision. No specification or Ticket graph
  is required for this direct start.
- **Plan implementation** starts the pinned `grill-with-docs` skill in a new
  workspace and opens its chat. Guide the owner through questions, specification
  approval, Ticket planning and implementation; show the next relevant action.
- **Save for later** retains the idea without launching an agent.

Ordinary idea views show the description, next action and existing proposals.
Manual question/specification/Ticket editors and native factory certification
controls belong under advanced controls. Actual owner questions and approvals
remain visible, and factory implementation still requires approved scope and a
genuinely verified provider. No fixture can certify a real provider.

Planning and direct work must tolerate changes in the primary checkout because
they create owned workspaces. They preserve frozen repository/account identities,
idempotency, uncertain-run ownership, registered-host routing and retained history.
Starts open the correct host's chat automatically and never replay after an
ambiguous delivery or disconnection. HTTP errors explain the actionable problem
without presenting internal route paths as the main message.

Verify through the existing confirmed public HTTP interface with temporary state
and owned fixtures, and real browser journeys. Cover global/project Inbox capture,
direct start, pinned planning, existing dirty files, active-work continuation,
scope/host failures and desktop/phone layouts. Never run paid agents in tests.
