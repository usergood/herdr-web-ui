# Guided Project setup: permissions, accounts and skills

Research date: 2026-10-12. Read-only evidence: official provider/Git/OpenSSH/GitHub CLI documentation, installed CLI help and the repository's pinned skill source. No account was switched, credentials copied, paid model called or global configuration changed. Recommendations describe the setup implementation; documented features remain subject to discovery on the selected execution host.

## Provider permission choices

Use provider-specific dropdowns. Store their structured values separately from workflow guidance, freeze them in the Run, and show the effective restrictions of coordinators, implementers and reviewers. A prompt's permission prose does not configure native enforcement.

| Provider | Suitable choices and native mapping | Evidence and limitation |
| --- | --- | --- |
| Codex | Ask for approval: `--sandbox workspace-write --ask-for-approval on-request` with reviewer `user`. Approve for me: the same sandbox/policy with reviewer `auto_review`; the installed CLI also has `--approve-for-me`. Read only: `--sandbox read-only`. Full access is a distinct explicit choice, not an interpretation of Approve for me. | Official [automatic-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) and [CLI](https://learn.chatgpt.com/docs/cli/reference) references. Local `codex-cli 0.162.1 --help` explicitly supports `--approve-for-me`, all three sandbox values, and `on-request`/`never`. |
| Claude Code | Manual approval → `--permission-mode default`; accept edits → `acceptEdits`; planning → `plan`; classifier review → `auto`. `dontAsk` denies actions that would prompt; `bypassPermissions` bypasses permissions. | Official [permissions](https://code.claude.com/docs/en/permissions) and [CLI reference](https://code.claude.com/docs/en/cli-reference). `auto` depends on session/model/managed-policy availability. Claude was absent from this research shell's PATH, so no installed-version pass is claimed. |
| OpenCode | Native permission policies use `ask`, `allow`, and `deny`, globally or by tool/input. Offer an explicit app preset that becomes this structured policy. | Official [permission reference](https://opencode.ai/docs/permissions/). Runtime configuration can use `OPENCODE_CONFIG_CONTENT`, subject to managed settings and agent-specific rules. [Configuration precedence](https://opencode.ai/docs/config/). OpenCode was absent from this research shell's PATH. |

Codex's `--approve-for-me` selects workspace-write, so applying it to a read-only coordinator/reviewer would change its role boundary. Preserve the role sandbox and apply reviewer configuration separately where supported. `--ask-for-approval never` has no automatic reviewer; it is not the owner's requested Approve for me mode. Managed requirements can restrict supported selections. [Automatic-review configuration](https://learn.chatgpt.com/docs/sandboxing/auto-review)

Detect defaults from the selected host's native configuration without running a model. Preserve an existing explicit setting and explain unsupported/unresolved values. Otherwise propose workspace-write/manual approval for Codex, Manual for Claude and an explicit ask policy for OpenCode; the owner can select supported automatic review. Detect model/reasoning from native settings rather than inventing a model available to the account. Show readiness independently from authentication: an imported login does not certify the factory workflow.

## Directory-based GitHub account discovery

Read Git configuration **in the selected checkout**, with includes enabled and origin/scope retained internally. Conditional includes can depend on Git-directory path, branch or remote URL. A linked worktree can resolve differently from the initial checkout, so capture selected account routing before allocation and revalidate the managed worktree. Display author name/email as commit identity, never as proof of an authenticated GitHub account. [Git configuration and conditional includes](https://git-scm.com/docs/git-config)

Inspect narrowly selected values: remote URL/rewrite result, author identity, SSH alias and recognized native account-directory hints. Redact credentials from URLs, helpers and raw command output. Read `.envrc` or wrapper metadata only as data for known literal settings; discovery must not source scripts or execute `core.sshCommand`, credential helpers or arbitrary shell wrappers.

Git `includeIf` does not set `GH_CONFIG_DIR`: that variable belongs to the process environment. A directory-aware shell wrapper or direnv setup is not automatically inherited by a web server. `GH_TOKEN`/`GITHUB_TOKEN` override stored credentials, and `GH_HOST`/`GH_REPO` can override targeting. Resolve recognized literal account hints or let the owner select a discovered profile; strip conflicting credential/target variables for an explicit binding. [GitHub CLI environment](https://cli.github.com/manual/gh_help_environment)

SSH aliases can identify `HostName`, `User`, `IdentityFile` and `IdentitiesOnly`. Multiple configured keys and agent identities mean an alias is a routing hint, not proof of the GitHub login. `ssh -G` evaluates Host/Match blocks, while `Match exec` executes shell commands. Static discovery should leave dynamic configurations unresolved instead of blindly evaluating them. Preserve verified host checking and verify the exact selected identity before accepting an SSH binding. [OpenSSH configuration](https://man.openbsd.org/ssh_config), [ssh -G semantics](https://man.openbsd.org/ssh)

Inventory GitHub accounts with bounded `gh auth status --json hosts` in the selected configuration directory. Inspect returned authentication states: JSON mode can exit zero despite account failures. Keep only sanitized host/login/state receipts. The native tool has `gh auth token --hostname <host> --user <login>` to select a known account without `gh auth switch`; any future import must capture that secret only inside the backend. Installed `gh 2.101.0` help confirmed these token-selector flags. [Auth status](https://cli.github.com/manual/gh_auth_status), [account token selection](https://cli.github.com/manual/gh_auth_token)

## Importing existing native accounts

Import is a deliberate owner action after displaying the discovered identity and host. Copy only selected authentication material into private profile storage; verify the imported native login before binding it. Keep secrets out of responses, logs, transcripts and backups. Preserve the source login, SSH configuration and keys. A GitHub API login and a Git SSH login require separate matching evidence; importing an API token does not register or prove an SSH key.

| Service | Existing credential source | Import boundary |
| --- | --- | --- |
| GitHub | The selected `gh` account/configuration, possibly OS credential storage | Native `auth token` can select the exact account without changing the active login. Import one selected account, then verify `gh api user` in isolated storage. |
| Codex subscription | `auth.json` under `CODEX_HOME` when storage is `file`; `keyring`, `auto` and `ephemeral` can lack an importable file | Accept an available file-backed subscription, then verify its native identity using the existing scoped adapter. Keyring-only or absent credentials require supported profile sign-in. [Official Codex authentication](https://learn.chatgpt.com/docs/auth) |
| Claude subscription | Linux/Windows `.credentials.json`; macOS normally Keychain, with a file fallback. `CLAUDE_CONFIG_DIR` selects the directory and keys the macOS Keychain entry | Copy only an available supported credential file and verify `authMethod: claude.ai` and the actual configuration directory. Do not infer a subscription from an email in cached settings. [Official authentication](https://code.claude.com/docs/en/authentication), [native auth status](https://code.claude.com/docs/en/cli-reference) |

Copying an entire native home would also import histories, hooks, plugins and arbitrary settings. Keep those outside account import. A copied OAuth login may refresh independently; source logout, expiry or revocation can invalidate it. Retain the existing no-fallback identity/revision checks and offer fresh scoped sign-in when reuse is unavailable. [Existing profile contract](account-profiles.md), [verification and account isolation](../../server/accounts.ts)

## Pinned skills for language and standards

The lock pins Matt Pocock **v1.3.1**, commit `24fe0ef7737efae15c87225755e9f6f5965e4888`. The four source files below were read from `vendor/matt-skills` and their Git blob hashes/sizes matched [skills.lock.json](skills.lock.json).

| Skill | Guided setup role |
| --- | --- |
| [setup-matt-pocock-skills](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/setup-matt-pocock-skills/SKILL.md) | Inspect existing tracker and domain layout, present editable drafts, reuse existing CLAUDE.md/AGENTS.md and preserve surrounding content. It configures conventions; it does not generate a finished standards corpus. |
| [grill-with-docs](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/grill-with-docs/SKILL.md) | Explicit router to grilling and domain-modeling for an owner-guided discussion. |
| [domain-modeling](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/domain-modeling/SKILL.md) | Resolve concrete domain terms, check them against code, write glossary entries when resolved, and create ADRs only for qualifying decisions. Avoid invented vocabulary and empty mandatory documents. |
| [writing-for-agents](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/productivity/writing-for-agents/SKILL.md) | Write concise agent-document pointers and standards guidance while keeping one authoritative source for each rule. |

Recommended journey: choose a registered host and browse to the checkout; inspect existing native defaults/accounts and Project docs; select/reuse verified accounts; review permission defaults; then offer the guided setup action. Develop terminology and missing standards through actual owner decisions, with drafts in the owned Run/worktree. Readiness should distinguish configured docs, verified accounts, loaded pinned skills and passing checks/reviews. Registration alone must not overwrite repository instructions, modify global accounts, publish tickets or run unrelated skills.
