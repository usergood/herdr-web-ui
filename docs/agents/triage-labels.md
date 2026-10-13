# Triage labels

| Canonical role | Default label | Meaning |
| --- | --- | --- |
| needs-triage | `needs-triage` | Requires evaluation |
| needs-info | `needs-info` | Requires more information |
| ready-for-agent | `ready-for-agent` | Planning complete; eligible for agent implementation |
| ready-for-human | `ready-for-human` | Requires human implementation |
| wontfix | `wontfix` | Will not be actioned |

The agreed design allows each Project to override these label strings, inheriting defaults where no override exists. Resolve labels through the Project mapping; conflicting triage roles require correction. This file establishes vocabulary and does not create labels remotely.

Automatic dispatch is a separate Project opt-in. Trusted readiness applies to a fixed issue scope and does not approve PR publication or merge. Non-ready issues await an explicit Start planning. See `docs/factory/interface-cleanup-design.md` for the proposed dispatch, changed-scope and batch-publication rules.
