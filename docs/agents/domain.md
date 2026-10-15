# Domain documentation

Use a single context: the root `GLOSSARY.md` contains confirmed vocabulary and `docs/adr/` records significant decisions. Read them before designing or changing factory lifecycle, queue, issue mapping, conversation roles or delivery behavior.

`docs/factory/GLOSSARY.md` preserves the earlier proposed vocabulary. Confirmed root entries take precedence for overlapping terms; remaining historical entries are not newly approved by this setup. Surface unresolved terminology rather than silently promoting it.

For capacity/dispatch, execution approvals, Pause/Delete, board progress, conversation roles or Human Review/merge authority, read `docs/factory/automatic-dispatch-pause-delete-design.md`. It records the accepted Q1–Q20 Specification and supersedes conflicting clauses in `docs/factory/interface-cleanup-design.md`; unrelated earlier decisions remain applicable. Runtime documentation describes current behavior until each implementation Ticket delivers its change.

Coding standards remain in the existing root and directory `AGENTS.md` files, `CONTRIBUTING.md`, `.github/REVIEW.md`, `docs/development.md` and `DESIGN.md`. Read the applicable files for the paths being changed. This setup adds pointers rather than another copy of those standards.
