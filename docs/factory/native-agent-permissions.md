# Native Codex launch permissions

Planning with Approve for me passed both `--sandbox workspace-write` and
`--approve-for-me`. Codex 0.162.1 rejects that combination before starting its TUI.
Herdr accepted the terminal command, so the visible workspace remained a shell.

Keep the role's explicit sandbox and select automatic review using
`-a on-request -c 'approvals_reviewer="auto_review"'`. Apply the same arguments to
direct work, planning, coordinators and owned workers; reviewers remain read-only.
Ask for approval retains the user reviewer. Missing permission presets continue
to inherit the CLI's reviewer configuration without changing role sandboxing.

Verify through public HTTP with a temporary Project and owned native workspace.
Pass the generated root arguments to Codex's schema command to exercise its real
argument parser without starting inference, then report only the owned pane.
No live session is restarted or automatically retried by this change.
