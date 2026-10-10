# Project reference library

Research date: 2026-10-10. This is a research and design note; it does not describe an implemented Project library.

The user wants owner-managed documents and pictures available to every native CLI working on a Project, across worktrees and Machines, without committing those inputs to the code repository. The feasible common interface is a readable directory plus a small index explaining when to use each reference. Provider-specific launch context can advertise that directory. Existing sessions need explicit context delivery because availability on disk and inclusion in model context are separate operations.

## Research: native CLI capabilities

The table summarizes fetched primary documentation. Installed-version acceptance remains necessary: this host has Codex CLI 0.162.1; `claude` and `opencode` were not found on PATH. No authenticated provider or remote-host test was run for this research.

| Provider | Instruction and reference discovery | Documents and pictures | Read access boundary |
| --- | --- | --- | --- |
| Codex CLI | Global guidance plus one instruction file per directory from Git root to cwd, normally discovered once per launched session. A launch config can append `developer_instructions`. [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) | Prompt paths can direct inspection; `--image` attaches initial images, and resume supports follow-up image attachments. [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [image inputs](https://learn.chatgpt.com/docs/image-inputs) | Named permission profiles can grant an external path `read`. `--add-dir` grants **write** access and is unnecessary for a read-only library. [permissions](https://learn.chatgpt.com/docs/permissions), [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |
| Claude Code | `CLAUDE.local.md` can import external Markdown with `@path`; external project imports have a trust prompt. `--append-system-prompt-file` supplies additive launch guidance. [memory](https://code.claude.com/docs/en/memory), [CLI reference](https://code.claude.com/docs/en/cli-reference) | An explicit image path, paste, or attachment can give visual context; `@file` includes eligible text. [common workflows](https://code.claude.com/docs/en/common-workflows) | `Read`/`Edit` rules, read fencing, and OS sandbox controls are distinct. Additional working directories permit reading and editing under the active mode. [permissions](https://code.claude.com/docs/en/permissions), [sandbox](https://code.claude.com/docs/en/sandboxing) |
| OpenCode V1 | `AGENTS.md`, compatibility fallbacks, and `instructions[]` support guidance. Named `references` can advertise an external local directory with a description. [rules](https://opencode.ai/docs/rules/), [references](https://opencode.ai/docs/references) | TUI file references or `run --file` attach inputs. Image handling needs acceptance against the installed provider/model. [TUI](https://opencode.ai/docs/tui/), [CLI](https://opencode.ai/docs/cli/) | A configured Reference permits the external-directory boundary, while normal tool rules still apply. Deny library edits explicitly. [references](https://opencode.ai/docs/references), [permissions](https://opencode.ai/docs/permissions/) |
| OpenCode V2 | `AGENTS.md` only; `instructions[]` is accepted by configuration but currently **does not resolve** files, globs, or URLs. References expose aliases, paths, and descriptions. [instructions](https://opencode.ai/v2/docs/instructions/), [references](https://opencode.ai/v2/docs/references/) | PNG/JPEG/GIF/WebP can reach image-capable models. Unsupported binary prompt attachments need conversion; a directory attachment is only an immediate listing. [attachments](https://opencode.ai/v2/docs/attachments/) | References grant no extra tool permissions. Both external-directory and read rules must permit access; edit denial alone does not constrain shell subprocesses. [references](https://opencode.ai/v2/docs/references/), [permissions](https://opencode.ai/v2/docs/permissions) |

### Instruction delivery limits

Codex stops automatic project-document loading at a configurable aggregate byte limit, 32 KiB by default. An external library is outside that discovery chain; merely creating it does not inject its contents. Prefer an additive index in launch context or an explicit prompt. `model_instructions_file` replaces built-in instructions, so it is a poor default for adding project references. [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Claude's ignored `CLAUDE.local.md` exists only in the worktree where it was created. An external import can share content across worktrees, but each session still needs discovery or launch guidance. `--add-dir` does not load that directory's memory by default; an environment opt-in enables it. This is access plus instruction loading, rather than a read-only setting. [memory](https://code.claude.com/docs/en/memory)

Claude records the system prompt on the first request by default. Different append flags supplied on resume may not take effect until compaction or a new conversation. Explicit follow-up context is therefore preferable for a library revision in an existing session. [CLI reference](https://code.claude.com/docs/en/cli-reference)

OpenCode V2 detects changes to ambient instruction files before the next model request, but already-loaded nested files do not automatically update. These version-specific behaviors do not establish a common live-update contract for the three CLIs. [V2 instructions](https://opencode.ai/v2/docs/instructions/)

### File, image, and permission limits

The file must exist where the native process or server runs. OpenCode V2 explicitly requires local file attachments to be available to its server; an HTTP attachment URL is unsupported. A laptop path is consequently not a reference for an SSH-hosted CLI until the selected files are replicated or mounted there. That last conclusion is a deployment inference, not a provider synchronization feature. [V2 attachments](https://opencode.ai/v2/docs/attachments/)

OpenCode V2 distinguishes direct prompt attachments from tool reads: PDFs are excluded from binary prompt attachments, while its `read` tool documents PDF support. Image inputs also depend on provider/model capability and limits. Do not infer successful visual consumption merely from an accepted upload or readable path. [V2 attachments](https://opencode.ai/v2/docs/attachments/), [V2 tools](https://opencode.ai/v2/docs/tools/)

CLI permission rules alone do not always enforce immutability against arbitrary shell code. Claude's Bash sandbox governs shell commands; its file tools and MCP processes use separate boundaries. OpenCode V2 shell commands retain the host user's authority. Use a read-only mount or separate execution identity when the original library must be protected from every tool, alongside the narrow native read policy. The mount/identity recommendation is a design inference. [Claude sandbox](https://code.claude.com/docs/en/sandboxing), [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions)

OpenCode's mutable Git reference cache can refresh while an agent uses it; attachments and later reads can then differ. An immutable local revision is a better fit for reproducible Runs than a shared moving reference branch. [V2 references](https://opencode.ai/v2/docs/references/)

### MCP as an alternative access interface

All three CLIs document local stdio and remote HTTP MCP connections. Codex stores configuration in user `config.toml` or a trusted project layer. Claude's private project-specific MCP scope lives in `~/.claude.json`, outside the repository; an invocation can also supply configuration. OpenCode supports external configuration, but its V1 `mcp.<name>` and V2 `mcp.servers.<name>` schemas differ. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude MCP](https://code.claude.com/docs/en/mcp), [OpenCode V1 MCP](https://opencode.ai/docs/mcp-servers/), [OpenCode V2 MCP](https://opencode.ai/v2/docs/mcp-servers/), [OpenCode CLI configuration variables](https://opencode.ai/docs/cli/)

MCP tool results can carry text and image media; the protocol format does not establish whether a specific client/model consumes an image. A project reference service should prove visual delivery independently for each adapter. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

The following comparison is design inference:

| Interface | Advantages for this request | Additional work and limits |
| --- | --- | --- |
| Immutable local directory plus launch index | Ordinary filesystem tools can inspect it; works offline after replication; straightforward native picture paths; little provider configuration | Replicate selected revisions to SSH Machines, apply read policy, and supply discovery context to every session |
| Project-scoped read-only MCP service | A common list/search/read interface can reach the same central revisions from configured CLIs without cloning reference documents | Per-CLI installation/trust and project-scoped authorization; availability/network dependencies; explicit revision selection; verify image-result support; existing sessions still need setup and refresh |

A minimal MCP interface would expose only index/search/read operations, restrict reads to an authenticated Project/revision, and omit arbitrary filesystem paths and mutations. Read-only tools protect server-held originals without granting a CLI local write access. They do not make retrieved documents automatically known, and a globally installed connector must not grant every project access to every library. A local-directory fallback would still cover unsupported clients and offline work.

## Proposed direction, inferred from the capabilities

These are recommendations for Saurons eye, not claims about existing behavior:

- Store originals in private application state outside all Project checkouts. Give the Project a stable library identity, an owner-edited usage note, and versioned document/image entries.
- Publish a small Markdown index with titles, descriptions, revision IDs, hashes, and Machine-local paths. Advertise the index to every new Project session; read individual references when relevant rather than inserting the whole library into each prompt.
- Materialize the same immutable library revision on each selected Machine. Every worker worktree uses that revision by an absolute local path; the repository and worktree need no tracked reference files.
- Apply separate per-provider discovery and read policies. Preserve existing repository instructions and native permission controls. Do not widen writable directories merely to make reference inputs readable.
- Existing sessions get an explicit owner-triggered context message, with delivery/consumption tracking where supported. Attaching to a terminal cannot retroactively change its original launch flags. CLIs started outside Saurons eye need one-time launcher/wrapper or provider configuration and a context refresh; universal automatic discovery cannot be promised.
- Keep an image's original bytes plus an owner caption describing its purpose. Text/OCR and converted previews can be derived aids, with provenance; they do not replace the original or prove that a text-only model inspected it.
- Freeze the library revision for a factory Run and its children. Owner changes create a new revision for future work; applying it to active work is a visible context change.

A manual approximation is already possible: keep one external reference directory on each execution host, supply its index path in each CLI's prompt, and verify the CLI can read the selected files. Turning that into consistent Project-wide discovery, remote replication, lifecycle tracking, and protected immutable inputs requires application work.

## Current repository: reusable support and missing scope

Inspected at `07f5e3f5a546cee698710800cd8e0884370a4743`. These are source observations:

- `FactoryProject` has execution configuration and `shared_paths`, but no reference library. `FactoryArtifact` belongs to an Implementation and Chat. A Project library needs its own Project-scoped entries; a hidden dummy Implementation would encode the wrong ownership. [Wire records](../../shared/factory.ts)
- Existing attachments already use verified content-addressed blobs, version metadata, quotas and isolated preview responses. The current MIME allowlist covers text, Markdown, HTML, JSON, PNG, JPEG, GIF and WebP; it does not accept PDF or Office documents. PDF/Office support needs a deliberate format/preview/extraction addition. [Artifact storage](../../server/factory-artifacts.ts)
- Admission freezes selected Implementation artifacts into a Run. The execution host materializes their bytes into the Run's `notes` directory outside Git and writes a research index. Child workers receive the parent's research-directory path. Those mechanisms can be extended to a pinned Project reference snapshot. [Admission](../../server/factory-runtime.ts), [execution host](../../server/factory-execution-host.ts), [worker context](../../server/factory-worktrees.ts)
- `shared_paths` coordinates worker writes to repository documents. It does not distribute external documents or provide a shared read library. [Project settings](../../src/components/FactoryProjectSettings.tsx), [worker path claims](../../server/factory-worktrees.ts)
- Ordinary workspace/tab/worktree launch requests have an optional agent and arguments, but no explicit Project ID or library binding. Covering those sessions needs launch integration beyond the factory path. [Launch contract](../../shared/protocol.ts), [ordinary agent launcher](../../server/index.ts)
- Backups find retained blobs through artifact reachability. Project references and snapshots must join this reachability calculation, storage accounting and restore verification so a deleted library entry used by an old Run remains recoverable. [Retention](../../server/factory-artifacts.ts), [backup/restore](../../server/factory-backup.ts)

## Recommended owner experience

Add **Project → References**. This is a proposed feature, not an existing control.

1. Upload a document or picture once. Store it in application state outside the repository and retain its original name, type, hash and version.
2. Give it a title and usage note, such as “Payment rules — read before changing refunds” or “Settings screen — use as the visual reference.” Pictures should also have an owner-written caption.
3. Choose **Always read** for short project guidance or **Reference when relevant** for longer documents and pictures. Every session gets the small index; relevant contents are loaded separately.
4. New Project sessions receive the index and Machine-local paths automatically. This includes coordinators, implementers, independent reviewers and ordinary agent panes launched with that Project selected.
5. For a session already running, show its loaded library revision and an explicit **Refresh Project references** action. Owner edits create new revisions; no message is queued across an offline connection and an active factory contract is not silently changed.
6. An SSH Machine prepares a verified local snapshot before starting its agents. Cached references remain readable while the connection server is unavailable. Source documents, cache paths and any access capability stay out of Git.

An agent started directly from a shell outside Saurons eye needs one-time launcher/provider setup or an explicit reference-index prompt. That is required to make “all CLIs in the Project” meaningful; attaching the browser to an existing pane cannot install launch instructions retroactively. Preserve existing tracked `AGENTS.md`, `CLAUDE.md` and native configuration. Generated additive launch context must not replace repository guidance.

## Proposed storage and delivery

Reuse the existing blob store, with separate Project reference metadata and immutable library snapshots. A readable projection could look like this on each Machine; exact directory names remain an implementation choice:

```text
<application-state>/factory/
  records.sqlite                     # Project entries and immutable snapshots
  blobs/<sha256>                     # canonical retained bytes
  project-references/<project-id>/<revision>/
    index.md                         # titles, usage notes, versions and file paths
    documents/<reference-id>.md
    images/<reference-id>.png
```

“Global” means shared within one explicitly selected Project. It does not mean a user-global instruction file containing every Project's material. Machine preparation transfers only that Project snapshot through the authenticated bridge; native agents never open the central SQLite database or receive an unrestricted state-directory capability.

One Project References module should own upload/versioning, snapshot selection, Machine preparation and native-context binding. The owner UI and CLI adapters should use this interface rather than each implementing their own storage or synchronization. Ordinary sessions bind an explicit Project or a verified unique mapping; folder-name guesses must not select another Project's library.

Freeze the library snapshot ID, entry versions/hashes and usage notes into a factory Run, then reuse that exact snapshot in every child and review context. New work takes the latest owner-published snapshot. Applying an updated snapshot to an active Run is a visible context revision with consumption evidence, comparable to the existing answered-context flow.

Grant narrowly scoped read access, preserve native approval controls, and verify materialized hashes before launch or reuse. Native tool edit-denial is not an OS-wide read-only guarantee: the same host user may still modify local files through a shell. Keep canonical server-held blobs separate from execution projections, detect projection changes, and use a read-only mount or separate identity when strong local immutability is required. Agent-proposed edits should become reviewable proposals instead of replacing owner reference versions.

Start with the supported text/image formats and a small index rather than requiring an embedding database. PDF/Office inputs can later retain original bytes plus clearly labelled extracted text/preview derivatives. A native visual acceptance case must prove that a supported model read the picture; a title, OCR text or successful download alone is insufficient.

The read-only MCP interface is a useful later adapter for central search/read and CLIs launched outside the app. It can share the same Project/revision authorization and blob source. Local snapshots remain useful for native image tools, offline work and clients whose MCP image support has not been verified.

## Acceptance to carry into implementation

- Upload one guide and one image to Project A. A second Implementation in A, a Ticket worker, both review roles and an ordinary Project-bound CLI all discover the same snapshot. Project B receives none of A's references.
- Run native read/vision checks against the actual installed Codex, Claude Code and OpenCode versions/models. Denied reads are visible; unsupported visual consumption is not reported as successful. Record each provider/version rather than treating documentation as runtime proof.
- Prepare a cloned checkout on another Machine, verify local bytes against the manifest, disconnect, and read the cached references. No shared SQLite path or arbitrary remote directory import is involved.
- Publish a new guide version while a Run is active. The existing Run and its children retain their recorded version; new sessions get the new snapshot. Explicit refresh has an auditable delivery/consumption result and no reconnect replay.
- Check clean repository/worktree status and commits: uploaded documents, pictures, projected indexes, tokens and generated reference configuration do not enter source commits. Existing tracked native instruction files remain intact.
- Verify quotas, corrupt/traversal/symlink rejection, isolated previews and backup/restore reachability for references retained by historical Runs. Deleting a current entry does not remove bytes still needed by those snapshots.

These extend the existing public HTTP and real-browser testing interfaces. This note adds a researched proposal; it does not install provider configuration, publish files externally, change the product specification or implement the library.
