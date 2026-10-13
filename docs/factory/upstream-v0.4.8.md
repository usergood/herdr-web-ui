# Upstream v0.4.8 integration

Original release: [herdr-web-ui v0.4.8](https://github.com/devswha/herdr-web-ui/releases/tag/v0.4.8), published 2026-10-12. Exact source commit: `cb65ecb9d1d251b42a6875427b6c7d0958150796`. Previous imported release: v0.4.7, `d92df49c53d4f51ace871629ea7c5567ed416a71`.

Apply the release delta through a three-way integration, preserving Saurons eye's stable plugin ID, account/reference/factory/GitHub workflows, bundled icons, credentials, explicit service/update configuration and CI-only publication controls. Original release notes, PR links and contributor credits remain in the changelog. Inherited upstream tags are not fork releases.

The release adds explicitly held queued messages, compressed JavaScript/CSS sidecars and negotiation, a standalone file reader, Markdown improvements, combined plan/background-task views, phone navigation/long-press/split-grid fixes, and prompt/input corrections. Remote bundle protocol is version 27; no runtime bundle is published by this merge.

Preserve the fork's existing header plan count, optional dependency flow/list dialog, responsive layout and phone swipe dismissal alongside the upstream combined plan/task list. Keep its settings, helper, stylesheet and browser regression; do not delete the modified dialog during import. The standalone reader uses Saurons eye's title. The fork's removed telemetry helper and related appearance-reporting test stay excluded, as do upstream telemetry server/shared/worker changes.

Apply the new phone Back behavior to the retained plan dialog and clear its open state on pane/Machine changes. Hide pane actions whose canvas owner is unmounted while Inbox is open. A requested hold on an older bridge is refused with its text retained; it cannot silently authorize automatic queue delivery. Update older bridges before using the new hold behavior.

Project GitHub controls use the existing same-origin helper, including HTTPS terminated by the owner's reverse proxy. A public API fixture verifies that proxy requests pass while foreign origins are rejected.

Confirmed validation seams remain the public HTTP/API with owned temporary fixtures, public CLI fixtures and real browser journeys. Validate the complete merged application through full local checks, the retained plan regression, new upstream phone/asset regressions and the existing GitHub account-to-ticket/PR journey. Standards and specification reviews must clear before merging. Actual deployment and Android acceptance are owner work, using the final pinned installation guide.

## Subsequent main integration

Upstream main through `5a9fe391e8239c5f038c129e885b7cec15a68b99` adds 15 commits after this
release: split tabs across PCs, shared browser preferences, Portal controls, file preview/source
improvements, paging, saved-PC discovery and input fixes. Reconcile against the imported v0.4.8
content while recording upstream ancestry in the merge, preserving the fork decisions above.
The telemetry expansion remains excluded. App updates now select only origin-advertised release
tags carrying the fork plugin identity; inherited upstream tags cannot become fork updates.
Release, runtime-bundle and website publication remain separate owner actions.
