# Domain documentation

Use a single context: the root `GLOSSARY.md` contains confirmed vocabulary and `docs/adr/` records significant decisions. Read them before designing or changing factory lifecycle, queue, issue mapping or delivery behavior.

`docs/factory/GLOSSARY.md` preserves the earlier proposed vocabulary. Confirmed root entries take precedence for overlapping terms; remaining historical entries are not newly approved by this setup. Surface unresolved terminology rather than silently promoting it.

`docs/factory/interface-cleanup-design.md` is the agreed product direction pending formal Specification, Tickets and implementation. Existing runtime documentation describes current behavior until its implementation changes. When they differ, preserve that distinction; do not describe a planned feature as active.

Coding standards remain in the existing root and directory `AGENTS.md` files, `CONTRIBUTING.md`, `.github/REVIEW.md`, `docs/development.md` and `DESIGN.md`. Read the applicable files for the paths being changed. This setup adds pointers rather than another copy of those standards.
