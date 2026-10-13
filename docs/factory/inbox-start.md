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

To use it, open **Inbox chat** under a Project, enter the idea title and optional
notes, and choose **Capture idea**. The saved Assignment offers **Start work** or
**Plan implementation**. Start work opens the selected CLI's chat immediately.
Return to the Assignment to **Continue in agent chat** or **Mark work done**, then
archive completed work. Completion retains the worktree; it does not merge or
publish its changes.

If a start is interrupted, choose **Stop this attempt**, then **Start work** again.
Stopping preserves its worktree and does not mark the Assignment complete. If a
native agent is already present, **Continue in agent chat** opens it for inspection.

For planning, answer the agent's questions in its chat or the recorded **Questions**
form. Confirm shared understanding, then choose **Finish this step** and **Create
specification**. Read and accept the specification and its testing plan before
**Plan tickets**. Approve the Ticket graph before **Start implementation**. If the
provider has not passed native factory verification, the page explains the gate
and offers the verification round. Reviewing implementation offers **Accept
reviewed head**; the server still requires fresh checks and independent passing
Standards and Spec evidence for that exact head.

Finishing planning retains a text-only native discussion handoff of at most
50,000 characters and exports changed Markdown documents from the owned worktree
(50 files, 512 KiB per file, 2 MiB total). The next workspace receives their frozen
versions and a source/hash index. Revised captures use the latest document copies;
older captures stay in history. Tool output, reasoning and scoped credentials are
excluded from the discussion handoff. The original native store and worktree remain
on the execution host. A partial transcript is labelled; failed capture shows a
warning and requires **Continue with available context** before guided planning
continues. Stop still releases native ownership when capture fails.

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
