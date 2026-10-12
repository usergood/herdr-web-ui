# Codex Project references

Status: first Codex slice implemented on 2026-10-10. This follows the [Project reference library](project-reference-library.md) research; validation evidence and remaining provider limits are recorded below.

## Delivery

Owners manage documents and pictures under Project References. Canonical bytes stay in private application state outside Git. Each reference has a title, usage note, read policy, caption, hash and immutable version. Upload/update/delete use the displayed library revision to reject stale changes.

A Markdown guide template explains purpose, applicability, required guidance, workflow, examples, verification and related pictures. Owners can edit it before saving, preview or download references, and prepare a Codex context for a verified Machine checkout. Preparation returns a local index path and a prompt that can be copied into a new or existing manually started Codex; it does not send input or restart agents.

New Codex factory Runs freeze the Project library revision and materialize verified files outside their worktrees. All Codex workers and independent reviewers discover that same index through their context and startup prompt. Updates affect future Runs and prepared contexts. Other providers are not certified by this slice; a nonempty library must not silently disappear from their factory context.

Historical Run/context snapshots keep referenced versions in backup reachability. HTML uses the existing isolated preview policy. Machine preparation uses authenticated bridge transport and explicit Project checkout identity. No global CLI configuration, tracked AGENTS.md, primary checkout or existing session is modified.

## Verification

Reuse the owner's confirmed public HTTP/API seam with temporary state and owned Git/Herdr fixtures, and the real browser seam. Verify Project isolation, restart/versioning/stale writes, private outside-Git materialization, frozen root/worker context, corrupt or unsafe inputs, retained backup restore, and desktop/mobile template/upload/prepare flows. A genuine installed Codex read check is separate from fixture adapter tests; image understanding remains model-dependent.

Implementation base: `defd5d0` on the documentation branch. Jev remains research only. Actions was disabled at that baseline; the fork now runs lean CI, while publication workflows remain disabled. See [CI controls](ci-activation.md).

## Use it

Open the settings button beside a registered Project, then select **Project references**. There, choose Use guide template, fill the title and usage note, edit the text, and save. Upload reference accepts text, Markdown, JSON, HTML and PNG/JPEG/GIF/WebP pictures. Add a caption explaining the picture's purpose. Edit reference creates an immutable new version; Remove from library hides the current entry while preserving version history.

The downloadable starting guide is [project-reference.md](../templates/project-reference.md). The application template is defined in [shared/project-references.ts](../../shared/project-references.ts); the Markdown file is an exported example from this first version.

Prepare Codex references verifies the selected Machine checkout and returns a local index plus a prompt. Copy that prompt into a manually started Codex session to read the prepared snapshot. The app sends no terminal input. New Codex factory Runs and every worker/reviewer receive their frozen snapshot automatically; existing Runs retain their original versions. Other providers with a nonempty Project library are refused rather than silently starting without references.

Reference bytes and projected indexes stay outside the repository and native write-directory additions. Preparation verifies cache contents and preserves unexpected changes. This is not an OS-wide immutable mount against every process owned by the same host user. Existing Codex read restrictions remain active; an owner may need to grant read access to the specific index directory in their native setup. The app adds no writable library directory and replaces no AGENTS.md or global native configuration.

The materialization budget is 64 MiB, including Implementation attachments for a Run. Library metadata is bounded to 2 MiB/1,000 current entries during preparation. Canonical reference versions count toward the existing blob quota; Machine projections occupy additional storage. Backup includes retained versions, while restore creates a disabled copy. The browser demo supports fictional library management and explicitly refuses real Machine preparation.

## Evidence

The HTTP contracts cover retention/restart, Project isolation, immutable updates/stale writes, outside-Git preparation, frozen Run/review-worker context, unsafe inputs, cache changes, copied restore and an authenticated bridge fixture. A bridge without `project_reference_protocol: 1` cannot admit a Run with references. A live external SSH host remains separate acceptance evidence.

The real browser runner exercises template/create/read/edit, picture upload/preview, Codex preparation, restart and mobile. The optional genuine Codex 0.162.1 read proof passed: its native transcript reported a marker present only in the external guide, and Git status remained clean.

```sh
bun run check run bun scripts/project-references-native.ts
```

That proof confirms native text discovery/read, not visual understanding for every model. PDF/Office conversion, other-provider adapters, MCP access and active factory-Run context revision/consumption are future slices. Preparing a newer manual prompt does not change a frozen factory contract.
