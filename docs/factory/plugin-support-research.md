# Plugin support and a possible Saurons eye extraction

Research date: 2026-10-11. Research only: no plugin was installed, linked, invoked, enabled, or removed, and no service or migration was started.

**Recommendation:** keep the working fork while testing a hybrid: a standalone Saurons eye factory/reference service distributed as a Herdr plugin, alongside the upstream browser client for native chat and terminal panes. Current plugin support can launch that service and expose actions. It cannot inject our Inbox, Project reference manager, or review panels into unmodified upstream React. Removing the fork while retaining the same integrated browser experience would require an upstream extension contract or an accepted upstream feature, not just a new manifest.

## Versions and primary evidence

- Installed `herdr --version`: **0.9.3**. Read-only CLI help and `herdr api schema --json` were inspected; bundled socket protocol is **22**, with plugin list/link/enable/disable/action/log/pane methods. No live socket requests were made.
- Herdr stable docs identify **v0.9.3**. Its annotated tag points to commit **`7b116c05bfda646af39d2524c54e70c751f57ee8`**; source was read from an isolated public release checkout. [Release source][herdr-tree]
- Upstream `devswha/herdr-web-ui` **v0.4.6**, commit **`7e12a892273b5d7a2f61c181c95a2bb0ad178309`**, released 2026-10-10. This release adds plugin action support and read-only metadata. [Release][web-release]
- Fork baseline **`f73998e06ef5457a58278ec9629500f7d28e14b5`**, which integrates v0.4.6 and includes the implemented Codex Project reference slice. The research checkout is separate from the root agent's ongoing PWA work. [Fork baseline][fork-tree]

The local CLI's `plugin pane open --help` advertises overlay/split/tab/zoomed. The bundled schema and pinned source additionally contain popup support. The source's CLI spec omits popup from its advertised value parser even though its implementation recognizes it. This discrepancy is a reason to test the actual supported path, not assume every documented placement works through every client. [CLI spec][herdr-cli-spec], [placement parser][herdr-cli-plugin], [pane schema][herdr-plugin-schema]

## Three different extension systems

| System | Actual extension boundary | What it does not establish |
| --- | --- | --- |
| **Herdr plugin** | `herdr-plugin.toml` declares executable actions, builds, startup/event commands, terminal pane entrypoints, and link handlers. Commands receive native workspace/pane context and can call the CLI/socket API. [Manifest loader][herdr-manifest] | A browser component loader, arbitrary web-ui routes, provider-native tools, or a supervised service manager |
| **herdr-web-ui plugin support** | The browser lists the selected Machine's Herdr actions and invokes one through authenticated bridge routes. Settings lists plugin name/version/enabled state and actions. [Protocol][web-protocol], [Settings][web-settings] | A frontend SDK, custom Settings fields, iframe slots, or an in-browser factory plugin module |
| **Codex native plugin/skill** | OpenAI plugins package skills, MCP configuration, optional assets, and lifecycle hooks for supported Codex surfaces. [Official OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins) | A Herdr plugin registration or React extension in herdr-web-ui. Installing one does not install the other |

Native Codex hooks have their own trust and execution-environment requirements. A Herdr plugin can distribute provider adapters or reference files, but each native CLI still needs its own supported discovery and permission integration. [Official OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [Project reference implementation](codex-project-references.md)

## What Herdr plugin v1 actually supplies

The official docs explicitly exclude runtime action registration and native non-terminal plugin UI. The loader's supported fields match that description; a pane entrypoint is an argv command, not a URL or HTML component. [Pinned plugin documentation][herdr-plugin-doc], [manifest loader][herdr-manifest]

| Capability | Source behavior | Consequence for us, inferred |
| --- | --- | --- |
| Manifest actions | Static IDs/title/context/platforms and argv; invoked with workspace/tab/pane/worktree context. [Schema][herdr-plugin-schema] | Useful for Open factory, Capture current pane, Prepare references, and service status commands; complex forms belong in our own UI |
| Native event hooks | Selected workspace/worktree/tab/pane/agent lifecycle events spawn commands asynchronously. High-volume output/layout events are excluded from the plugin hook set. [Event kinds][herdr-events], [runtime][herdr-runtime] | Can notify an owned backend of lifecycle changes; not a pre-tool authorization hook or a complete transcript stream |
| Startup | Enabled plugins get one-shot commands after socket readiness/session restore, and on takeover. Startup failures do not stop Herdr. [Runtime][herdr-runtime], [plugin docs][herdr-plugin-doc] | Our launcher must own daemon lifecycle, readiness, idempotence, and reconciliation; a startup entry is not supervision |
| Panes | Overlay/split/tab/zoomed commands run through normal terminal launch paths; popup is a session-modal terminal resource with no pane ID. [Pane implementation][herdr-panes] | A TUI or a terminal with a clickable service URL is possible; a rendered React board or image viewer is not this pane type |
| Config/state | Plugin-specific config and state directories plus source root, socket path, binary path, and invocation context are injected. [Environment][herdr-env], [runtime][herdr-runtime] | Keep DB, private blobs, credentials, and leases out of the replaceable source checkout |
| Services/security | Manifest has no service definition; plugins execute ordinary user code with inherited environment. Herdr does not sandbox or review that code. [Manifest][herdr-manifest], [trust documentation][herdr-plugin-doc] | Packaging changes neither filesystem authority nor the need for native sandbox, capability, ownership, and owner approval checks |

Registry/enabled state is per user, available across Herdr sessions; install refresh replaces managed source while plugin config/state persist. Build commands run at install, while local link skips them; there is no separate v1 plugin-update command. A singleton service must therefore distinguish its bound Herdr session/socket rather than let startup on another session silently retarget it. [Install/lifecycle docs][herdr-plugin-doc], [registry implementation][herdr-registry]

## What upstream v0.4.6 exposes to the browser

Source was inspected across `src/`, `server/`, `shared/`, the manifest, and Vite configuration. This is a bounded conclusion about the pinned release, not a promise that upstream will never add an SDK:

- `GET /api/plugins/actions` lists installed plugins and platform-compatible actions. `POST /api/plugin/action` carries `plugin_id`, `action_id`, and optionally `pane_id`; `GET` polls a retained Herdr command log. [Routes][web-server], [wire types][web-protocol]
- Invocation preserves the selected pane's context instead of accidentally using Herdr's own focus; absent context fields are explicitly cleared. [Context adapter][web-plugin-actions]
- The result is log ID/status/exit code/failure text/`opened_pane_id`. Successful arbitrary stdout is not surfaced as a custom result. The palette selects a focused pane named by that action's own stdout, then closes. There is no `open_url`, web view, component, or custom action-result renderer. [Result adapter][web-plugin-actions], [palette][web-palette]
- Settings metadata is read-only; install/enable/remove remain Herdr operations. Its plugin group is a statically compiled component. [Settings][web-settings]
- App routes/components are compiled into the client, and the server has explicit HTTP routes followed by an API 404. There is no manifest-driven React or backend-route loader. The existing iframe is a PDF file preview, not a plugin UI slot. [App][web-app], [server][web-server], [file viewer][web-file-viewer], [build config][web-vite]

**An unchanged-client launch path exists:** Open factory can open an ordinary plugin terminal pane that prints a configured HTTPS factory URL, optionally a QR code. Upstream's terminal recognizes web links, which the user opens in their browser. Simply printing a URL to successful action stdout does not navigate the browser. Running a host `open`/`xdg-open` command targets the Machine that ran the action; it is not reliable phone navigation. The latter is a deployment inference. [Terminal link handling][web-terminal], [result behavior][web-plugin-actions]

Returning from the standalone factory to a native pane can use the upstream browser's existing `?pane=<id>&machine=<id>` selection, with a configured upstream origin and verified Machine mapping. A direct factory deep-link action result would require an upstream contract change. [Pane/Machine URL selection][web-app]

## Mapping our features to migration seams

Our fork is **already a Herdr plugin**, identified as `usergood.saurons-eye`; its manifest starts the whole fork's web server. The new question is whether to extract the added application, leaving native terminal/chat browsing to upstream. [Our manifest][fork-manifest]

| Feature | Current ownership and coupling | Feasible extraction, inferred |
| --- | --- | --- |
| Durable state/API | `FactoryService` composes SQLite, artifacts, workflow, backup, review, runtime/pipeline, references and retrospectives; index.ts owns outer access checks and routes. [Service][fork-service], [store][fork-store], [server composition][fork-server] | Standalone service can retain these deep modules and routes, with its own HTTP/auth composition and controlled import of existing state |
| Native execution/input/history | FactoryNative calls Herdr; the bridge additionally binds factory input to its pane serialization/strict-agent checks and forwards collector status/end events. [Native adapter][fork-native], [input/status binding][fork-server] | Extract an explicit executor/observation adapter. Preserve one input authority; independent direct RPC senders must not bypass browser serialization, leases, or offline semantics |
| Project references | Project/version records and retained bytes are private; Machine materialization verifies identities/hashes and writes an immutable outside-Git index. New Codex Runs/workers receive it; manual sessions receive a copied prompt. Other providers with nonempty libraries are refused. [Reference records][fork-references], [materializer][fork-reference-context], [current slice](codex-project-references.md) | Good standalone candidate: its own reference-management UI and backend plus native launch/manual preparation adapters. A native skill may advertise the index, but is not the canonical library |
| Inbox/board/reviews | FactoryPanel and its children are static React imports in App; they call `/api/factory` and receive Machine lists and pane-selection callbacks. [Panel][fork-panel], [App][fork-app], [API client][fork-factory-api] | Reuse in a separate frontend entry with its own machine/context API and upstream pane links. No current upstream slot can mount them |
| Auth/devices | The outer server authenticates device/token/bridge identities and disallows factory access for watch-only devices. Scoped tracker tokens have distinct authority. [Access checks][fork-server], [tracker checks][fork-service] | Preserve owner/watch/scoped-agent separation in the new service. A shared host, browser origin, or Herdr context is not an authentication grant; avoid cookie/token namespace collisions |
| SSH/execution Machines | FactoryRuntime uses authenticated `/api/factory-host/*` calls via the current Machine endpoint. Upstream bridge/proxy routes are explicitly allowlisted and have no factory host service. [Runtime transport][fork-runtime], [upstream Machine allowlist][web-machine-api] | Own and version a remote execution service/plugin or propose a narrow upstream transport capability. Installing a central plugin alone does not replicate remote references or provide host execution |
| Bundles/updates | Fork bundles ship server/shared/vendor and skill lock; manifests/checksums/runtime versions are owned here. Launch/update infrastructure follows active releases separately from the plugin checkout. [Bundle builder][fork-bundles], [updater][fork-updater], [launcher](../../scripts/plugin.ts) | Separate artifact/protocol/update ownership is necessary; upstream bundles cannot substitute for our factory-capable remote host |

Moving modules must preserve immutable contracts, exact-head validation, reservations, Stop/late-response rules, backups, HTML isolation, and manual publication gates. No feature should disappear under the assumption that Herdr owns our domain records: its plugin system supplies execution context, not this factory state model. This paragraph is a migration requirement inferred from our current implementation.

## Options and recommendation

| Option | Result | Effort category and dependency, inferred |
| --- | --- | --- |
| Keep the fork, modularize internally | Same integrated PWA/Inbox/native browser experience; continue upstream merges | Lowest immediate change; continuing frontend/bridge merge maintenance |
| **Hybrid standalone Herdr plugin + upstream client** | Factory/reference UI and durable backend evolve separately; upstream supplies native panes/chat. Action opens a terminal launcher/link; factory links back to upstream panes | Small launch experiment, followed by substantial service/UI/input/auth/SSH extraction and state migration work |
| Full in-upstream plugin UI | Same integrated owner experience with no UI fork | Requires upstream agreement and design for UI registration, origin/auth boundaries, API routing, lifecycle, remote transport, and compatibility. No such seam exists in v0.4.6 |
| Native Codex plugin only | Skills/MCP can help agents use references or tracker operations | Cannot replace the multi-provider owner board, durable backend, review UI, remote host or browser controls |

Prefer the hybrid as a **proof of concept**, while keeping the fork operational and its state untouched. Extracting Project references is a useful first bounded slice; the full factory has deeper execution coupling. Keep a temporary thin fork if integrated navigation remains essential, and pursue a narrowly specified upstream URL/action result seam before requesting a large browser plugin SDK. These are recommendations, not authorized implementation or deployment.

A future iframe is not automatically the best seam: cross-origin auth, cookie isolation, navigation, phone sizing, focus, uploads, and untrusted HTML boundaries need an explicit contract. An external authenticated app plus verified links is the simpler initial experiment; the existing PDF iframe establishes no authority to embed arbitrary plugin applications.

## Concrete ownership, updates, and licenses

Herdr core is Apache-2.0; herdr-web-ui is MIT. Reusing its frontend/backend code requires retaining its copyright/license notice in copied substantial portions. Our skill bundle also retains its third-party notices and pin; packaging it separately does not remove those obligations. [Herdr license][herdr-license], [upstream MIT license][web-license], [fork notices][fork-notices]

The extracted plugin must own its executable dependencies, service supervision, distinct install/runtime/update identity, private state migration, and compatible remote protocol. Stable plugin IDs are per-user registry keys; an experimental ID and disposable registry avoid replacing the installed fork during proof work. Use a new owned port/state root and copied state for migration trials. Do not change updater origin or install over production as part of research. [Plugin registry][herdr-registry], [existing fork update configuration][fork-updater]

## Small proof-of-concept acceptance plan

No proof of concept was run. A separately authorized disposable experiment should establish:

1. **Packaging and action context:** register only in a test-owned Herdr config, use a distinct experimental ID, and observe correct selected workspace/pane/checkout/Machine context through unmodified v0.4.6. Verify local and remote actions do not use another Machine's focus.
2. **Launch/navigation:** startup/action calls are idempotent; a normal terminal launcher shows a reachable factory URL; desktop and phone can open it and return to the intended upstream pane. No native web-pane or automatic redirect claim is needed.
3. **First feature slice:** an owned Project reference can be created/versioned outside Git, prepared on an owned checkout, and read as text and picture by an eligible genuine Codex session. Restart retains records; existing sessions require explicit context delivery.
4. **Security and lifecycle:** own auth; watch-only and scoped-agent boundaries; clean service shutdown/Stop; correct socket binding across named sessions; no second browser terminal holder; no automatic reconnect send or launch replay. Test late responses against stopped leases.
5. **Remote/state compatibility:** a separately owned execution host receives verified revisions, survives disconnect/reconnect without redispatch, and fails visibly for an older protocol. Restore only into a disabled copy, with verified retained bytes; rollback leaves the original fork usable.
6. **Acceptance before extraction:** reuse meaningful public API/browser/native journeys for the migrated slice and identify remaining dependencies. Compare feature parity and maintenance burden; do not retire the fork until owner flows and recovery work on the replacement.

Unknowns are live navigation/auth behavior, cross-service input coordination, remote deployment, and operational parity. Their proof is more valuable than a calendar estimate before the first slice is isolated.

[herdr-tree]: https://github.com/herdrdev/herdr/tree/7b116c05bfda646af39d2524c54e70c751f57ee8
[herdr-plugin-doc]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/docs/next/website/src/content/docs/plugins.mdx
[herdr-manifest]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/plugins/manifest.rs
[herdr-plugin-schema]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/plugins.rs
[herdr-runtime]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/plugins/runtime.rs
[herdr-panes]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/plugins/panes.rs
[herdr-events]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/events.rs
[herdr-env]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/plugins/env.rs
[herdr-registry]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/plugins/mod.rs
[herdr-cli-spec]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/cli/spec.rs
[herdr-cli-plugin]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/cli/plugin.rs
[herdr-license]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/LICENSE
[web-release]: https://github.com/devswha/herdr-web-ui/releases/tag/v0.4.6
[web-protocol]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/shared/protocol.ts
[web-server]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/server/index.ts
[web-plugin-actions]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/server/plugin-actions.ts
[web-palette]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/src/components/CommandPalette.tsx
[web-settings]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/src/components/SettingsDialog.tsx
[web-app]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/src/App.tsx
[web-file-viewer]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/src/components/FileViewer.tsx
[web-vite]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/vite.config.ts
[web-terminal]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/src/components/PaneTerminal.tsx
[web-machine-api]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/server/machine-api.ts
[web-license]: https://github.com/devswha/herdr-web-ui/blob/7e12a892273b5d7a2f61c181c95a2bb0ad178309/LICENSE
[fork-tree]: https://github.com/usergood/herdr-web-ui/tree/f73998e06ef5457a58278ec9629500f7d28e14b5
[fork-manifest]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/herdr-plugin.toml
[fork-service]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory.ts
[fork-store]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory-store.ts
[fork-server]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/index.ts
[fork-native]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory-native.ts
[fork-references]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory-references.ts
[fork-reference-context]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory-reference-context.ts
[fork-runtime]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/factory-runtime.ts
[fork-panel]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/src/components/FactoryPanel.tsx
[fork-app]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/src/App.tsx
[fork-factory-api]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/src/lib/factoryApi.ts
[fork-bundles]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/scripts/build-remote-bundle.ts
[fork-updater]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/server/updater.ts
[fork-notices]: https://github.com/usergood/herdr-web-ui/blob/f73998e06ef5457a58278ec9629500f7d28e14b5/THIRD_PARTY_NOTICES.md
