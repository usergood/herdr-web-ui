# Fork baseline and extension points

The local fork matches the handoff's research baseline. Choosing a production fork base still requires comparing it with the owner's actual installed deployment.

## Verified local facts on 9 October 2026

| Fact | Evidence |
| --- | --- |
| Repository | `origin` is `https://github.com/usergood/herdr-web-ui.git` |
| Commit and version | `b87d9d50019cdb87422415f7650ad29285a832cc`; `package.json` version `0.4.3` |
| Primary checkout | `/home/kurri/Personal/herdr-web-ui`; clean `main` tracking `origin/main` when planning began |
| Planning isolation | A separate worktree on `docs/factory-planning`, initially `/home/kurri/Personal/herdr-web-ui-factory-planning` |
| Application | React frontend, Bun server, shared HTTP/WebSocket contract |
| Process ownership | Herdr owns panes, processes and scrollback; the existing Node PTY sidecar performs terminal attachment |
| Persistence conventions | App state directory is selected by `HERDR_WEB_STATE_DIR`, otherwise under the config root's `herdr-web-ui`; existing stores include private JSON files |
| Domain setup | No existing glossary, glossary map, CONTEXT document or Matt skills tracker setup was found in this fork |
| Fork metadata | Plugin ID and package repository metadata still name upstream; remote bundle fallback still uses upstream releases |

The presence of Bun, Herdr and Codex executables on the current host does not verify the owner's deployment, their versions or factory capability. No live Herdr session, service unit, socket, Traefik route, secret or remote host was inspected or modified during this pass.

## Extension points

| Responsibility | Existing source | Planning consequence |
| --- | --- | --- |
| Launch and worktrees | `shared/protocol.ts`, `WorktreeDialog`, `NewSessionDialog`, `AgentPicker` | Wrap Herdr operations with durable admission and machine/worktree ownership; preserve ordinary workspaces |
| Conversations | `server/conversation.ts`, `codex.ts`, `claude-store.ts`, `opencode.ts` | Add application Chat identity and retained evidence; native sessions remain provenance |
| Remote execution | `server/machines.ts`, `machine-api.ts`, `machine-relay.ts`, `shared/machines.ts` | Reuse SSH bridges and machine-scoped addressing; check fork bridge namespaces before use |
| Files and artifacts | `server/file-view.ts`, `FileViewer` | Existing host file access is broader than factory artifact access; create a separate authorized, retained artifact contract |
| Markdown | `Markdown` | Reuse styling and rendering where suitable; explicitly test sanitization and safe links |
| Factory records | New application persistence | Proposed server-owned SQLite database and artifact directory alongside existing conventions; native provider databases are not the task store |
| Reviews | New snapshots and comment operations | Preserve compared revisions and durable draft/submitted findings independently of panes |
| Updates | `server/updater.ts`, `remote-bundle.ts`, plugin/build scripts | Main updater follows origin tags; remote runtime default is separately upstream-owned and requires an audit |

Current `FileViewer` renders text attachments in a preformatted text view; rendered Markdown/HTML attachments require new work. Its existing host-file resolver is not an authorization model for app-owned artifacts. [Pinned viewer source](https://github.com/devswha/herdr-web-ui/blob/b87d9d50019cdb87422415f7650ad29285a832cc/src/components/FileViewer.tsx)

`createServer(options)` remains the server injection seam. Extend HTTP/WebSocket shapes through the shared protocol, error helpers and demo transport. Follow the directory `AGENTS.md` files before editing those directories. Preserve collector status ownership, prompt-answer navigation semantics, attach leases and reconnect input behavior. Tests and captures use owned test/demo resources. See [repository instructions](../../AGENTS.md), [review rules](../../.github/REVIEW.md) and [development checks](../development.md).

## Design constraints

Keep the existing theme tokens, responsive shell, keyboard conventions, internationalization and accessible written status labels. Factory stage, Run condition and delivery outcome need separate labels; existing pane DONE is only a native signal. Existing modal focus debt does not justify adding inaccessible dialogs. Use desktop/mobile browser evidence for affected controls, with reduced motion and keyboard/IME cases where relevant. See [DESIGN.md](../../DESIGN.md).

## Deployment facts still required

Inventory installed version/commit, install method, service manager, process owner, Herdr session/socket, state directories, backups, route/domain, authentication and proxy trust settings read-only, without exposing secrets. Determine whether this host is the production machine; a local checkout is not proof. Confirm ports, plugin/runtime identities and bridge paths for an isolated development deployment before starting it.
