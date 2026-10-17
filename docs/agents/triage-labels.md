# Triage labels

| Canonical role | Default label | Meaning |
| --- | --- | --- |
| needs-triage | `needs-triage` | Requires evaluation |
| needs-info | `needs-info` | Requires more information |
| ready-for-agent | `ready-for-agent` | Planning complete; eligible for agent implementation |
| ready-for-human | `ready-for-human` | Requires human implementation |
| wontfix | `wontfix` | Will not be actioned |

The agreed design allows each Project to override these label strings, inheriting defaults where no override exists. Resolve labels through the Project mapping; conflicting triage roles require correction. This file establishes vocabulary and does not create labels remotely.

Trusted readiness applies to a fixed issue scope; non-ready issues await an explicit planning start. Project opt-in, changed-scope and explicit issue-batch publication boundaries remain in `docs/factory/interface-cleanup-design.md`. The accepted `docs/factory/automatic-dispatch-pause-delete-design.md` supersedes repeated planning gates: Specification approval authorizes automatic progress through checked/reviewed PR publication, while merge authority comes from explicit Human Review approval and its repair lineage. Readiness alone grants neither blanket publication nor merge authority. Use the implemented/enabled policy; this design record activates no runtime automation.
