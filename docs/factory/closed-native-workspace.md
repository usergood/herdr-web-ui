# Stopping a closed native workspace

An interrupted Inbox Run retained its workspace and pane IDs after those native
objects had been closed. Stop required a live pane, so it failed and the Run's
ownership continued blocking every new Start.

An explicit Stop may finish when a successful fresh native snapshot confirms both
recorded IDs are absent, the retained worktree still resolves to its recorded path,
and there is no matching Run label or pane in its worktree. Candidate panes must
provide directory evidence that resolves outside the worktree; missing or
unresolvable evidence cannot prove closure.
Cancel the Run and its host lease, stop any owned workers/builds through their usual
guards, and retain the worktree and history. Do not close unrelated workspaces.

Unavailable snapshots, missing recorded IDs, changed identities and possible moved
panes retain ownership. A closed-workspace observation must not automatically start
another agent; the owner chooses a new Start explicitly.

Verify through public HTTP with owned repositories/workspaces: rejected launch,
workspace closure, Stop and repeated Stop, a fresh Start, preserved context and an
unrelated workspace. Include unavailable observation, another pane in the worktree,
a moved worktree replaced by a symlink, missing/unresolvable pane directories,
and the existing stop-during-allocation regression. No paid models run in tests.
