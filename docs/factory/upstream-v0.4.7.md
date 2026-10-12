# Upstream v0.4.7 integration

The owner approved and requested merging account-profile PR #9, followed by the newly released
original project. PR #9 is merged at `6f7ad6609d727396f7f945499de5c121f3869f3a`.
Integrate [herdr-web-ui v0.4.7](https://github.com/devswha/herdr-web-ui/releases/tag/v0.4.7)
at `d92df49c53d4f51ace871629ea7c5567ed416a71`, excluding later unreleased upstream commits.

## Scope

- Retain the release's deep links and navigation, native Claude/Codex plan views, Mermaid and
  Markdown rendering, recent workspace folders, Forest colors, Turkish language, mobile sheets,
  terminal cursor/pinch/arrow controls, native Grok/Antigravity/Hermes/OpenCode 1.x readers,
  transcript watching, usage pacing, push-presence behavior and input/security fixes.
- Preserve the fork's Inbox, Projects, references, specification/Ticket workflows, account/key
  setup, frozen execution scopes, scoped provider readiness, retained evidence and recovery.
  Factory prompt delivery retains its authorization guard and cannot fall back to typing into
  a terminal after a native refusal. Upstream's explicit draft-clearing journey remains available
  to ordinary chat sends.
- Preserve Saurons eye names/icons, the authenticated installation manifest, fork-owned plugin
  and update/runtime sources, disabled telemetry, owner-configured external services and bridge
  auto-updates off by default. New Turkish strings and documentation include the fork features.
- Keep both upstream and fork browser journeys in the serial and parallel lane. Verify the demo
  handles changed contracts. Keep third-party licenses and upstream changelog links/credits.
- Package/plugin version becomes 0.4.7 and the remote runtime becomes 26. Merging does not publish
  a release tag/runtime bundle, deploy the application or modify a running service.

## Recorded baseline

PR #4 already integrated v0.4.6 (`7e12a892273b5d7a2f61c181c95a2bb0ad178309`), but its squash
merge omitted upstream ancestry. This preparation branch records that release with an unchanged
tree merge before merging v0.4.7. The resulting PR remains squash merged. Future integrations
must use this release pin when selecting their baseline.

## Validation

Use the previously confirmed public HTTP/API seam with temporary state and owned fixtures,
plus real browser journeys. Run typechecks, generated-type freshness, unit tests, integration
and all registered browser checks locally with disposable herdr configuration. Actions stays
disabled at the owner's request. Also build the fictional demo and a local remote runtime bundle.
Review Standards and Spec against fork main and this scope before merging.

Actual provider subscription authorization, live deployment and cross-platform native acceptance
remain distinct from local fixture results. Existing queue/usage-rule proposals are not activated
by upstream's usage pacing display.
