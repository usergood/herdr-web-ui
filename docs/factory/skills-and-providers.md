# Pinned workflow and provider verification plan

Use `mattpocock/skills` tag `v1.3.1`, resolved commit `24fe0ef7737efae15c87225755e9f6f5965e4888`. Its annotated tag object resolves to that commit. [Release](https://github.com/mattpocock/skills/releases/tag/v1.3.1)

[skills.lock.json](skills.lock.json) records every file identity from the complete pinned source tree, including agent metadata and support files. It is a source lock, not an installed bundle or a verified runtime manifest. Materialization, content-hash verification and transitive invocation audit are pending Slice 0. Never fetch floating main or update a running attempt's skill manifest.

## Minimum bundle and invocation

| UI action or dependency | Skill | Invocation |
| --- | --- | --- |
| Configure project workflow | setup-matt-pocock-skills | Owner |
| Grill me | grill-me | Owner |
| Grill with docs | grill-with-docs | Owner |
| Interview dependency | grilling | Model-invoked dependency |
| Domain documents | domain-modeling | Model-invoked dependency |
| Create specification | to-spec | Owner |
| Plan tickets | to-tickets | Owner |
| Start factory | implement-spec | Owner for selected spec/graph |
| Test implementation | tdd | Model-invoked dependency |
| Module/test seam reference | codebase-design | Model-invoked dependency |
| Review changes | code-review | Workflow or explicit request |
| Prepare PR body | pr | Load when a body is being prepared; publication is separately authorized |
| Run retrospective | retro | Owner |
| Agent-writing reference | writing-for-agents | Model-invoked dependency |

Known direct invocation edges from inspected pinned instructions: `grill-me → grilling`; `grill-with-docs → grilling` and `domain-modeling`; `implement-spec → tdd` and `code-review`; `tdd → codebase-design` when the seam/interface needs design; `retro → writing-for-agents`. Keep every skill's support files and `agents/openai.yaml`. Audit the full materialized sources for additional conditional/transitive instructions; the source lock includes the full tree so discovered dependencies cannot float.

The owner phrase grill-me-with-docs maps to upstream grill-with-docs. Use implement-spec for execution, rather than replacing it with a factory prompt. User-invoked skills cannot call one another automatically. Preserve Codex implicit-invocation policy and Claude frontmatter metadata consistently. Dependencies must actually load; mentioning their names is not proof. [Invocation contract](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/.agents/invocation.md)

## Gates the interface must retain

Grilling asks each decision frontier in rounds and waits for answers and final shared-understanding confirmation. The interface cannot replace the pinned question contract with a fixed quiz, infer unanswered choices or count a timeout as approval. [Grilling](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/productivity/grilling/SKILL.md)

Specification creation synthesizes existing discussion, checks proposed test seams with the owner and publishes only through the configured tracker. Ticket planning gets granularity/dependency approval before publishing. TDD uses agreed public seams and loads design guidance if necessary; reuse applicable versioned confirmations across workers. [To spec](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/to-spec/SKILL.md), [TDD](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/tdd/SKILL.md)

Project setup confirms tracker findings and proposed edits before writing configuration. Retrospective loads writing-for-agents, examines selected primary session evidence and presents improvement candidates. Applying improvements is a separately scoped app action. Keep standards/spec review contexts separate and tie both to the captured revisions. [Setup](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/setup-matt-pocock-skills/SKILL.md), [Retro](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md), [Review](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md)

## Provider adapter contract

Every adapter implements discovery/capabilities; launch with explicit absolute cwd; native attach/resume; skill/dependency loading; message and question/approval delivery; condition/interruption/transcript/completion evidence; and child-agent/worktree behavior required for factory execution. Arguments are structured and validated. Native IDs are qualified by Machine and retained as provenance.

| Capability to verify on each installed version | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Discovery, ordinary chat, explicit cwd | Pending | Pending | Pending |
| Pinned editable skill loading and dependencies | First factory target; pending | Native managed plugin is Claude-specific; pending | Mechanism and metadata behavior pending |
| Durable questions and approval identity | Pending | Pending | Pending |
| Child agents, worker worktrees and merger role | Pending | Pending | Pending |
| Sandbox/permissions and scoped Git protection | Pending | Test native controls/hooks | Test native controls/hooks |
| Attach/resume and transcript import | Pending | Pending | Pending |
| Complete Ticket graph, checks and separate reviews | Pending | Pending | Pending |
| Local/SSH versions and reconnect behavior | Pending | Pending | Pending |

Pending means no compatibility pass is claimed. A shared executable name, ordinary chat support or installed skill folder is insufficient. Record version, OS/architecture, Machine, loading evidence and tests for each cell. Unsupported factory capabilities leave ordinary chat available with a clear Start factory reason; no silent provider substitution or flattened subagent workflow. Extensible providers meet the same contract.

## Git protection inventory and verification

Upstream git-guardrails-claude-code documents a Claude Bash PreToolUse hook blocking push, hard reset, force clean, force branch deletion and whole-workspace checkout/restore. Its setup asks project/global scope and customization, then verifies the hook. It provides no Codex/OpenCode protection. [Pinned guardrail skill](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/misc/git-guardrails-claude-code/SKILL.md)

The exact script-parser/check inventory is pending source materialization; its content could not be retrieved in this pass. Lock its support-file identity and audit actual patterns before claiming protection. Test structured direct commands, flags, chaining/substitution, aliases/wrappers, non-shell Git access and unsupported bypasses with each provider's supported permission controls. Backend gates cover managed worktree ownership, launch, cleanup, publication, merge and deployment operations. Accurately describe gaps; a powerful general terminal remains outside these managed factory gates.

Propose project-scoped controls first, without overwriting existing settings. A PR workflow that needs push must either retain the block and wait for a separately authorized publisher, or use an explicit narrowed operation bound to repository, branch and reviewed revision. Do not disable a push block silently. The PR-body skill is not publication authority.

## Materialization and acceptance

Obtain a normal pinned source checkout when network access is available; verify the resolved commit and all locked paths/modes/Git object IDs, compute content hashes for the runtime manifest and audit referenced files/dependencies. Use editable installation for Codex and the actual supported mechanisms of the other CLIs. Do not alter global active skills or unrelated projects during factory project setup.

The full source snapshot may be retained as a verified vendor/cache artifact. Enabling its experimental or unrelated skills is not implied by locking the tree. Archive licensing and provenance. A factory-enabled provider must show actual required loading and pass the complete workflow in a disposable Project on its selected Machine before admission is enabled.
