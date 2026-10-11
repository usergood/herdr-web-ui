# Project account profiles: GitHub, Codex, Claude and Cloudflare

Research date: 2026-10-11. Repository inspected at `03c366ff04d6f21ddb74ecbc6f00a7b57bf85582`. This is a design proposal; account selection is not implemented by this report.

**Recommendation:** let each Project select named account profiles on each execution Machine, freeze those selections when a Run starts, and resolve credentials privately on that Machine. Preserve the owner's existing Git SSH setup. Add process-scoped selection instead of changing a shared active account whenever an agent starts. The owner selected **subscription logins for both Codex and Claude**: use their native subscription/OAuth identities and preserve that billing model.

The services have separate identities: Git commit authorship, GitHub SSH authentication, `gh` API authentication, model billing, and Cloudflare resource access can all differ. A repository owner or SSH alias cannot identify the Codex/Claude billing account. Treat each binding independently and show the resolved set before Start.

## What the tools support

| Tool | Supported selection/isolation | Limit or prerequisite |
| --- | --- | --- |
| Git | Conditional `includeIf "gitdir:…"` settings; command-scoped `-c`; per-worktree config with `extensions.worktreeConfig`. [Git configuration][git-config] | `gitdir:` follows the actual Git directory in a linked worktree, not the visible checkout path. `user.name`/`user.email` configure authorship, not authentication. |
| OpenSSH | `Host` aliases with `HostName`, explicit `IdentityFile`, and `IdentitiesOnly yes`. [OpenSSH configuration][ssh-config] | Verify the intended alias is used by Git's transport and that additional matching config does not add identities. Agent-held keys remain on their Machine. |
| GitHub CLI | `GH_CONFIG_DIR` selects configuration; `GH_TOKEN` then `GITHUB_TOKEN` override stored credentials. Enterprise hosts have separate token variables. [Environment reference][gh-environment] | `GH_HOST` chooses a hostname, not a user at `github.com`. Configuration-directory isolation alone does not establish OS credential-store isolation. |
| Codex CLI | A separate existing `CODEX_HOME` selects config, auth, sessions, skills and other state. File authentication resides in that home. [Environment variables][codex-environment], [authentication][codex-auth] | `--profile` is a configuration layer, not a separate account store. Keyring isolation needs verification on the chosen platform/backend. |
| Claude Code | `CLAUDE_CONFIG_DIR` separates credential files and documented macOS Keychain entries. [Authentication][claude-auth] | Subscription login, API credentials and cloud/gateway selection have precedence; directory selection alone does not remove stronger ambient credentials. Claude was not installed here. |
| Cloudflare `cf` | Native OAuth profiles: `auth create`, directory `auth activate`, or per-command `--profile`. `CLOUDFLARE_API_TOKEN` overrides profiles. [Sign-in and resolution][cf-start] | Own credentials, separate from Wrangler. Explicit account/zone selection is still required; the CLI is beta. |
| Wrangler | Current docs describe beta OAuth profiles, directory bindings and `--profile`, with an API token overriding profiles. [Authentication profiles][wrangler-profiles] | No Wrangler executable was installed here. Verify support in the project's pinned release; `--env` selects deployment configuration and is not an account login. |
| `cloudflared` | Account certificate and tunnel credentials have different scopes. [Tunnel permissions][tunnel-permissions] | It is a different executable and credential system from `cf`/Wrangler. Running a tunnel does not require exposing account-wide tunnel management credentials to agents. |

Version-only local observations: Git `2.53.0`, OpenSSH `10.2p1`, `gh` `2.101.0`, Codex `0.162.1`, `cf` `1.0.0-beta.12`, and `cloudflared` `2025.2.1`. Claude and Wrangler were absent from `PATH`. No auth status, login, account switching, token command, credential file, SSH configuration, or account configuration was read or executed.

## Details that change the design

**Git and linked worktrees.** A disposable repository and linked worktree were created under `/tmp`, with an isolated global config and fictional commit identity. The original repository lived under `work/`; the linked worktree lived under `factory/`. Its `gitdir:…/work/` include matched. The newer `worktree:…/factory/` condition in current online docs did not match on installed Git `2.53.0`. Therefore do not use that condition without a version/behavior probe. A path-based policy can follow the original repository unexpectedly when the factory creates worktrees elsewhere. Preserve it as an owner baseline, then verify or apply a reviewed explicit Run selection. [Conditional includes][git-config]

**SSH and `gh` are independent.** Keep SSH aliases outside Git and select an owner-approved key/agent; use explicit transport settings when the remote hostname cannot carry an alias. A generated SSH command must use a trusted executable and structured arguments, or a vetted wrapper, with host-key verification retained. [Identity selection][ssh-config] `gh auth switch` changes the authentication configuration for the selected host, creating a race for concurrent jobs sharing that config. Avoid it in Run startup. [Switch command][gh-switch] Separate private `GH_CONFIG_DIR` directories can hold different active selections; tokens injected only into the intended process are another option. Clear conflicting inherited token variables before selecting a stored profile. [Token precedence][gh-environment]

**Codex configuration profiles are not account profiles.** Current `--profile` overlays `$CODEX_HOME/<name>.config.toml`; docs identify the format change at `0.134.0`. Keep an account-specific home with independently provisioned settings and sign-in. Do not copy a live refresh-token cache for each Run. Project-local config cannot redirect several provider/auth settings. [Profiles and project restrictions][codex-config] ChatGPT sign-in and API-key usage have different billing and policy scopes; file, keyring, auto and ephemeral stores are supported. File-backed separation is documented; this research does not prove keyring namespace behavior. [Credential storage and billing][codex-auth] Different homes also separate history/config/plugins/skills, so provider verification must include the selected home and required skills. Ambient `CODEX_API_KEY`, access tokens, workload identity and custom-provider `env_key` settings require explicit handling. [Environment reference][codex-environment]

**Claude precedence matters.** Cloud/provider variables, bearer/API keys, helpers and explicit OAuth tokens can override subscription `/login`; interactive API keys need approval, while noninteractive `-p` uses a present key. Docs explicitly scope macOS Keychain entries to `CLAUDE_CONFIG_DIR`. This is documentation evidence, not a local runtime pass. [Authentication and credential storage][claude-auth] The directory also contains settings/history/plugins. [Settings locations][claude-settings]

For the requested subscription setup, provision each account once through its normal native login in a private account directory: an existing `CODEX_HOME` for Codex, a `CLAUDE_CONFIG_DIR` for Claude. Login is an owner action outside factory Runs; the application stores a reference to the resulting native identity. Launch later Runs with that directory, remove conflicting API/cloud/gateway credentials, and check the intended subscription account. Do not replace subscription login with API keys, export refresh tokens into Project settings, or copy credentials into per-Run worktrees. Expiry or a missing entitlement requires reauthentication of the selected identity, without automatically choosing another account. Independent login provisioning and refresh behavior need a real owned-account test before claiming simultaneous account support.

**Cloudflare now has native profiles.** For `cf`, token first, explicit `--profile` second, nearest directory binding third, default last. Its `.env` loader can introduce a token that wins over the intended profile. The process account ID overrides project `accountId`; saved/automatic account choices are weaker than an explicit pin. It does not reuse Wrangler login. [Credential/account resolution][cf-start], [variables][cf-environment] Wrangler's documented profiles similarly prefer explicit selection over directory binding, resolve a `--config` binding from the config directory, and fail if a profile cannot reach the selected account. These are beta capabilities; exact minimum version and runtime storage behavior are unverified here. [Profiles][wrangler-profiles]

Wrangler's `.env.<environment>` file replaces `.env` for `--env`; its config supports `account_id`. These select context, not permission. [Environment variables][wrangler-environment], [configuration][wrangler-config] Its current docs also describe optional keychain-backed encrypted OAuth storage, with platform/fallback differences. Do not infer credential isolation from changing `XDG_CONFIG_HOME` or invent a `WRANGLER_HOME` setting. [OAuth storage][wrangler-commands] Prefer native profiles where verified, and scoped API tokens for narrowly authorized automation. Tokens can restrict both operations and resources, with optional IP/TTL limits. [API token permissions][cf-tokens]

`cf` here is the first-party Cloudflare CLI; its installed help confirms profile commands. Resolve executable path, package/version and command contract on each Machine before enabling an adapter. `cloudflared` account certificates permit managing all account tunnels, while locally managed tunnel credentials are tunnel-specific. Keep tunnel infrastructure credentials outside ordinary project execution. [Cloudflare CLI][cf-overview], [tunnel scopes][tunnel-permissions]

## How this fits Saurons eye

The current code has environment provisioning, but no account-profile model or account-identity gate:

- [`FactoryProject.environment`](../../shared/factory.ts) is a general string map. [`factoryEnvironment`](../../server/factory-environment.ts) merges it into coordinator/worker environments and adds owned cache/state/temp paths. It does not select or validate accounts.
- [`FactoryRuntime`](../../server/factory-runtime.ts) freezes the whole Project in the Run manifest. [`FactoryExecutionHost`](../../server/factory-execution-host.ts) writes that Run into `.saurons-eye-context.json`; [`FactoryWorktrees`](../../server/factory-worktrees.ts) gives workers a similar context. Raw credentials entered as Project environment values can therefore become durable records and agent-readable context.
- [`FactoryBackup`](../../server/factory-backup.ts) serializes the database. This is another reason to keep secrets out of Project/Run records, even when files have private permissions.
- [`FactoryNative`](../../server/factory-native.ts) launches structured provider arguments through Herdr. Selecting an environment must survive Herdr workspace creation, shell startup, provider settings and child processes; changing only the web server's environment is insufficient.
- [`git()`](../../server/factory-host.ts) removes inherited `GIT_*` variables before managed Git operations. Check execution separately inherits the service environment except `GIT_*`. Account resolution must cover both paths and preserve the repository-routing protection; a new generic environment entry is not a sufficient fix.
- Provider proofs currently bind version and skills hash. Different account homes can supply different policies/helpers/plugins; add profile revision and tested auth capability without treating login as proof of provider workflow support.
- Existing specification [F10/F11/F19](specification.md) already pins Run settings, avoids copying ignored secrets, and keeps each Machine's credentials local. Account binding belongs in those admission/execution boundaries.

These findings come from the cited local source at the recorded repository revision. They establish design gaps, not evidence that personal credentials have been leaked.

## Proposed account references and launch contract

The following JSON illustrates a future owner configuration, **not a currently accepted API**. IDs and values are fictional. Private paths, credential material and helpers live in an owner-controlled Machine registry outside repositories and artifact storage.

```json
{
  "project_account_bindings": {
    "machine_id": "laptop-example",
    "git": "github-client-a-ssh",
    "github": "github-client-a-api",
    "codex": "codex-client-a",
    "claude": "claude-client-a",
    "cloudflare": "cloudflare-client-a-preview"
  }
}
```

A Project may offer several registered bindings per service; the owner chooses defaults and explicit Implementation overrides. Resolve override → Project binding for the selected Machine. Never infer an account from a freeform chat, repository-supplied `.env`, or a directory label. An unassigned Implementation needs an explicitly chosen binding before account-dependent work.

For every accepted Run, store only profile ID/revision, provider version, auth method/billing class, expected public account/org/repository/resource identity, permitted operations, and the normalized verification receipt. Require subscription billing for the Codex and Claude bindings in this proposal. Resolve private paths and any non-model secret-manager references on its execution Machine. Store public identity details only where the owner intends; omit tokens, auth JSON, helper output, raw process environments and secret fingerprints. The same Project on a laptop and server has separate Machine bindings.

An execution-host adapter should:

1. Resolve a registered, owner-held profile and validate paths/permissions without accepting arbitrary file paths or shell helpers from Project input. Separate nonsecret settings from secret references; reject credential fields in durable `environment` records.
2. Construct a minimal process environment, explicitly removing competing credentials/provider endpoint overrides before applying the profile. Reject conflicting configured helpers or managed-provider requirements; preserve native owner/admin policies. Use the same resolver for coordinator, workers, checks and permitted publication commands. Keep model credentials out of unrelated build/setup commands; inject Cloudflare/GitHub credentials only for the allowed operation.
3. Verify identity and resource scope before launch. Fail for missing profile, wrong Machine, wrong identity, incompatible version, expired login or inaccessible target; never retry with the default account. A mismatch is a visible blocked/failed admission, not a silent fallback.
4. Freeze profile revision and expected identity in the Run. Workers inherit that frozen binding. Later Project defaults affect future Runs only. A refresh may rotate the credential while retaining identity; revocation or changing the profile's account invalidates admission and requires an explicit new/reconciled attempt.
5. Prefer command-scoped native profile flags and per-account homes over shared mutable activation. Manual project shells can use an owner-reviewed launcher with the same resolver, so `git`, `gh`, Codex, Claude and Cloudflare follow one declared context.

A launcher helps consistency; it is not an access-control boundary against arbitrary shell execution. Same-OS-user processes may read other private directories, bypass PATH wrappers, or invoke unwrapped binaries. Projects requiring strong tenant separation need separate OS users/containers or another enforced credential broker, plus provider sandbox/network controls. Naming a profile or setting directory permissions does not alone provide that isolation.

## Identity checks and limitations

| Surface | Candidate check for a future adapter | What still needs proof |
| --- | --- | --- |
| Git/SSH | Validate resolved author config and remote destination; evaluate an approved SSH configuration, then check expected SSH principal using a bounded read-only connection | Transport principal is independent of author email; GitHub's successful SSH greeting can exit nonzero. No SSH connection was made here. |
| `gh` | `gh auth status --active --hostname …` without token output; optionally `gh api user --jq .login` under the selected context | Parse identity and errors, not merely JSON exit status: `auth status --json` can exit zero despite authentication issues. [Status reference][gh-status] |
| Codex | `codex login status` reports auth method. A private local integration can inspect supported `account/read` metadata without refresh | Method alone does not prove a particular organization/API project. The app-server example exposes ChatGPT email/plan, and API-key mode only a type; no identity probe was run. Do not make account tokens a hosted web auth service. [CLI auth][codex-auth], [app-server boundaries and metadata][codex-app-server] |
| Claude | Owner-visible `/status`, or a verified version's safe auth-status contract | Check account/org and billing method after precedence. No installed CLI was available for a runtime check. [Authentication status][claude-auth] |
| `cf` / Wrangler | `cf auth whoami` / `wrangler whoami`, plus target-account and resource permission checks under explicit profile selection | A valid token or listed membership does not prove every intended permission. Restrict normalized receipts to safe metadata. [cf sign-in][cf-start], [Wrangler whoami][wrangler-commands] |

Do not run `gh auth token`, `wrangler auth token`, dump config files, enable diagnostic environment dumps, or capture login flows in screenshots. A future redaction test should use fake secrets and assert absence from API responses, Run manifests, context files, logs, artifacts and backups. Scope-check commands should not create resources or deploy.

## Phased implementation and acceptance

1. **Profiles and preflight:** introduce private Machine profile registrations and nonsecret Project/Implementation references, owner-visible resolved identities, and fail-closed verification. Start with existing GitHub SSH/`gh` and account-specific native Codex subscription homes. Do not rewrite global SSH/Git configs or log users out.
2. **Managed execution:** thread a frozen binding through admission, execution-host protocol, Herdr environments, workers and checks. Re-run genuine provider loading with the selected account home. Include identity/profile drift in reconciliation and retain existing Stop/offline behavior.
3. **Cloudflare and Claude:** add explicit, pinned native Cloudflare profiles or operation-scoped token injection; separate preview and production grants. Add account-specific Claude subscription directories once its installed version and credential backend pass the same contract. Production publication/deployment stays a separately authorized operation.
4. **Manual launcher:** optionally reuse the resolver for project terminals and noninteractive commands. Adapt existing owner mappings without copying ignored secrets into factory worktrees. Avoid depending solely on shell `cd` hooks: automated worktrees and remote processes may never run them.

Acceptance should cover concurrent Projects using different accounts on one Machine; two Machines with the same Project; linked worktrees outside the original directory; shell startup and inherited credentials attempting to override the selection; wrong/expired/missing identities; worker inheritance; Run/default drift; revocation; reconnection without account/launch replay; redaction across retained state/backups; and separate build versus deployment authority. Public HTTP/API fixtures and real browser journeys remain the confirmed test seams; native CLI/account integration needs owned test identities and disposable repositories/resources, with versioned evidence.

The completed local experiment proves only Git conditional behavior. Real multi-account authentication, OAuth refresh concurrency, keyring namespaces for Codex/`gh`, Wrangler's supported minimum version/storage, remote Machine provisioning and phone account UI remain unverified. No accounts, logins, global settings, deployment routes or live Herdr sessions were changed.

[git-config]: https://git-scm.com/docs/git-config
[ssh-config]: https://man.openbsd.org/ssh_config
[gh-environment]: https://cli.github.com/manual/gh_help_environment
[gh-switch]: https://cli.github.com/manual/gh_auth_switch
[gh-status]: https://cli.github.com/manual/gh_auth_status
[codex-auth]: https://learn.chatgpt.com/docs/auth
[codex-config]: https://learn.chatgpt.com/docs/config-file/config-advanced
[codex-environment]: https://learn.chatgpt.com/docs/config-file/environment-variables
[codex-app-server]: https://learn.chatgpt.com/docs/app-server
[claude-auth]: https://code.claude.com/docs/en/authentication
[claude-settings]: https://code.claude.com/docs/en/settings
[cf-start]: https://developers.cloudflare.com/cf/get-started/
[cf-overview]: https://developers.cloudflare.com/cf/
[cf-environment]: https://developers.cloudflare.com/cf/environment-variables/
[cf-tokens]: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
[wrangler-profiles]: https://developers.cloudflare.com/workers/wrangler/profiles/
[wrangler-environment]: https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
[wrangler-config]: https://developers.cloudflare.com/workers/wrangler/configuration/
[wrangler-commands]: https://developers.cloudflare.com/workers/wrangler/commands/general/
[tunnel-permissions]: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/tunnel-permissions/
