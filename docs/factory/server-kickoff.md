# Server kickoff and unresolved decisions

The first bounded slice reconciles the actual installed deployment and produces a reviewed setup plan. Production replacement, changes to a running service and merges require their own explicit scope. The current pass remains planning and specifications only.

## Settled for this planning pass

- The plugin display name is **Saurons eye** and its slug is `saurons-eye`, as chosen by the owner.
- The fork is `usergood/herdr-web-ui`, checked out under `/home/kurri/Personal/herdr-web-ui`.
- The local source baseline is `b87d9d50019cdb87422415f7650ad29285a832cc`, package `0.4.3`; it is not asserted to be the installed server version.
- Codex is primary; Claude Code, OpenCode and extensible provider adapters remain requested scope.
- Skill sources use `v1.3.1` / `24fe0ef7737efae15c87225755e9f6f5965e4888`, with support files and agent metadata pinned together.
- Every repository writer uses safe worktrees. Manual starts and an ordered backlog remain first-version scope.
- Projects may be attached after capture without changing Implementation identity or automatically committing artifacts.
- The owner explicitly selected “Keep this pass to planning and specifications” on 9 October 2026.

## First bounded slice proposal

Read-only inventory of the owner's intended installed deployment and fork checkout, followed by a reviewed skills/provider/tracker setup proposal. Do not start the whole factory implementation merely by reading the handoff.

### Inventory procedure

1. Obtain the owner-designated server connection or confirm this host is the target; identify the installed checkout/package and read its instructions. Compare installed version/commit, install method and local changes with the recorded research/fork baseline.
2. Inspect service manager, launch configuration, process owner, Herdr session/socket, persistent directories and backup arrangement. Record references and security-relevant configuration without printing secret values, tokens or private keys. Existing host/container placement is a discovery fact.
3. Inspect domain/Traefik route, TLS/authentication, trusted-header behavior and WebSocket/stream routing. Identify separate ports, state and test Herdr resources for development. Do not take over panes, restart services, update plugins or change routes.
4. Inventory installed CLI/bridge/Herdr/toolchain versions and selected machine checkouts. Check SSH route, host identity/key and reachability for the laptop only with provided access. Being online is insufficient through NAT; a private network/VPN may be needed.
5. Materialize the normal pinned skills source when reachable, verify the source lock, inspect transitive invocation and support-file references, then propose provider-specific editable installation and permission controls. Source inspection alone does not activate skills. Read the exact guardrail script before claiming its coverage.
6. Present tracker/domain setup findings and proposed edits. The owner-invoked setup skill makes those decisions; do not fabricate a confirmed GitHub/app-native tracker or silently rename CONTEXT documents.
7. Present fork-base reconciliation, development configuration, proposed testing seams, provider matrix and first implementation Ticket. Record genuine owner-only decisions below; look up repository/environment facts first.

### Observable acceptance

- Redacted deployment inventory identifies the actual installed version, paths, service owner, state, socket and route, or names the specific unavailable access fact.
- A comparison explains whether the research baseline is a suitable fork base; local changes and upstream drift are accounted for before any code/base change.
- Development configuration names distinct state/port/Herdr resources and fork plugin/runtime identities; collision checks pass without modifying production.
- Source verification reports tag/commit, required skills, transitive dependencies, complete support files/metadata and actual content hashes. Missing files or network access remain explicit blockers.
- Provider evidence records installed versions and skill loading/control mechanisms, with pending/unsupported cells visible; no full compatibility is inferred from executable discovery.
- Tracker/domain/permission and testing-seam proposals are reviewable. Completed owner confirmations are recorded with scope and revision; no unconfirmed proposal is marked accepted.
- The next Ticket is bounded and demoable. Read-only preparation does not launch implementation or publish issues/PRs.

Slice 0 is not complete in this local pass: installed-deployment discovery, local skill materialization, exact hook-script audit and provider capability checks remain outstanding. The local fork and exact source lock are prepared.

## Owner decisions still pending

| Decision | Proposed default or choices | When it must be settled |
| --- | --- | --- |
| Target deployment/access | Owner identifies the server, installed checkout/service/state and domain, or confirms this host; discover facts read-only after that | Before P01 can reconcile the live installation |
| Fork Project tracker | GitHub Issues in `usergood/herdr-web-ui`; alternatively owner-selected local/Other convention | Owner-invoked setup, before specification/Ticket publication |
| New app-only Project tracker | App-native Other tracker with a real stable-ID CLI/API; reuse existing tracker per Project | Before tracker-dependent factory enablement |
| Domain vocabulary/layout | Confirm Implementation/Ticket/Run definitions; single-context root glossary for this fork | Before committing API vocabulary or writing setup pointers |
| Specification acceptance and Done | Explicit spec acceptance; Done means accepted implementation-complete by default, with PR/merge/release outcome shown separately; stricter Project rules take precedence | Before admission and board completion contracts |
| Cross-machine continuation | First support explicit host choice for new Runs plus same-host reconnect; choose whether controlled work transfer must ship immediately | Before P21 scope is finalized; automatic migration remains excluded |
| HTML execution | Static sandboxed HTML, scripts/network/top navigation off by default; separately choose whether interactive scripts/network are needed | Before artifact preview acceptance |
| Retention and size | Explicit deletion with visible configurable limits; propose 25 MiB per blob and 2 GiB total for development fixtures only, adjust to actual storage needs | Before production artifact/storage policy |
| Resource cap | Initially two manually active Implementations; choose total agent/build limits from measured host capacity and whether a third is permitted | Before any concurrent implementation check |
| Provider versions | Owner-selected installed Codex/Claude Code/OpenCode versions, checked on each execution Machine | Before claiming supported provider matrix |
| Laptop checkout/SSH access | Verified machine-specific paths/identity and reachable private SSH route | Before laptop execution tests |
| Testing seams | Public server interface through existing injection plus real-client browser acceptance; real native/SSH/worktree/HTML boundary evidence as needed | Before `to-spec` publication and TDD; reuse scope-valid confirmations |

Recommendations are not owner answers. Do not use defaults to bypass an unanswered gate. Required permission decisions remain pending until explicitly answered; timeouts never count.

## Copyable receiving-agent instruction

> We are extending our existing Herdr Web UI installation through a separate fork into the specification-driven factory described in this handoff. Codex is primary, but the architecture and delivered adapter matrix must support Claude Code and OpenCode. First inspect the actual installed deployment and intended fork checkout read-only, read their instructions, and pin the specified Matt Pocock 1.3 skill bundle. Preserve the working service, sessions and data. Reconcile this handoff into the fork's own glossary, specifications, issue-tracker setup and dependency-linked implementation plan. Honor manual starts, worktree isolation, durable app-owned chats/artifacts, review comments, project retrospectives and machine-aware execution. List genuine unresolved decisions and propose the first bounded slice with observable acceptance. Do not launch the whole implementation merely by reading this document. Once implementation is explicitly requested, follow the verified skill workflow and project permissions; make progress in the fork, not in Conteo.

## Parallel deployment and recovery proposal

After implementation is separately authorized, use an explicit development state root, distinct port and owned test Herdr resources. Bind development privately and use separately scoped auth/proxy configuration. Do not run plugin install/start/update actions against the current installation during planning. Audit fork plugin IDs, all installation/release URLs, updater origin and remote runtime/socket/state namespaces; distinct app state alone does not prove bridge isolation.

Before promotion, restore coherent database/artifact copies and document recovery of native sessions/worktrees plus remote artifacts not yet imported. Verify that an older binary can read the chosen migration state before rollback; otherwise restore a compatible state copy. Preserve licenses, existing HTTPS/auth and stream routing. Prepare a concrete promotion/rollback result for owner review, then obtain the separate production scope.
