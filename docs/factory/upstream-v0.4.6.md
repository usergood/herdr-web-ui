# Upstream v0.4.6 integration

The owner requested the Project references feature be committed and merged, followed by the latest original-project release. Integrate [herdr-web-ui v0.4.6](https://github.com/devswha/herdr-web-ui/releases/tag/v0.4.6) at `7e12a892273b5d7a2f61c181c95a2bb0ad178309`, not later unreleased upstream commits.

## Required result

- Retain the complete released upstream delta: native pane layouts and operations, terminal-history search and scrollbar, tab reordering, pane moves, cross-PC palette search, plugin actions, agent integration status, response compression, lifecycle refresh and input/security fixes.
- Preserve Saurons eye branding, fork-owned update/runtime sources, owner-configured external services, disabled telemetry, and bridge auto-updates off by default. Update all four README upstream version notices.
- Keep factory controls and the merged Project reference library accessible alongside the new pane canvas. Native Codex Runs/workers retain the same frozen reference snapshot; manual preparation remains explicit.
- Keep factory and reference browser runners alongside upstream's added runners. Test expectations must match the actual combined lane, including its failure summary.
- Preserve original upstream changelog links and contributor credits. Package/plugin version is 0.4.6 and the remote runtime version is 25; merging does not publish a release or runtime bundle.

## Baseline and ancestry

PR #2 already integrated v0.4.5 (`5d18c53`) into fork main, but its squash merge omitted the upstream parents. The preparation branch records that already-integrated release with an unchanged-tree ancestry merge before merging v0.4.6. The GitHub PR itself remains squash merged under this repository's workflow. Future integrations should use this recorded release pin when identifying the baseline instead of treating old released changes as new.

## Verification

Use the existing public HTTP/Herdr contract fixtures and real browser journeys with temporary state and owned panes. Run `bun run check full` on the final committed combined source, plus the demo build and Linux remote-bundle startup/live-terminal smoke check. Standards and Spec reviews cover conflict resolution against the updated fork main and this integration record. GitHub Actions remains disabled by owner choice. Windows/macOS execution and a live external SSH host are separate acceptance evidence.
