# Native Inbox launch regression

Starting direct work created a native workspace but herdr rejected `agent.start`
with `invalid_agent_argument`, leaving a shell and an interrupted Run. The prompt
contained line breaks, which herdr does not accept in launch arguments. Project
workflow guidance introduced the same problem for planning and child workers.

Keep the full initial request in a private, immutable `.saurons-eye-prompt.md` in
the owned worktree. Launch with a short single-line instruction to read it, keeping
the selected native skill prefix. Preserve exact multiline idea text and Project
instructions, native permissions, account scope and existing readiness gates.
Record the prompt as application scaffolding for verified cleanup; it is not a
planning document to import into subsequent Runs.

An interrupted or disconnected direct-work attempt must offer **Stop this attempt**
instead of marking the Assignment done. Stopping retains the worktree. The owner
can then choose **Start work** again. Never automatically retry an uncertain launch
or remove the owner's existing pane as part of deploying the fix.

Verify through the confirmed public HTTP and browser seams with owned state.
The native argument-validation fixture uses herdr's real `agent.start` with the
non-model Muse adapter; it cannot certify Codex, Claude or OpenCode. Cover direct
work, each planning adapter, a review worker, preserved formatting, private file
permissions and explicit failed-attempt recovery. Tests must not start paid models.
