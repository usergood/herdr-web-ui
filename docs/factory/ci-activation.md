# CI-only activation and repository rename

The owner approved all findings in the Actions/plugin audit and chose the repository name
`usergood/saurons-eye`. Keep the GitHub repository public and activate only CI after the
implementation is verified. Website redesign and publication remain later work.

## Accepted behavior

- Automatic PR/main CI uses standard Linux runners for fast checks; full Linux integration,
  browser, native Windows and macOS validation requires explicit manual dispatch. Full checks
  remain required before merging application changes and are forced for publication calls.
  An unrequested full run must not report the required Integration and browser check as passed.
- Cancel superseded validation runs, cap worker concurrency and timeouts, and upload only
  failure evidence with one-day retention. Public standard hosted compute does not consume
  private-repository Free-plan minutes; artifact/cache storage still has separate allowances.
- Pin every external Action to an official immutable commit. Keep test tokens read-only,
  checkout credentials unpersisted, and publishing authority confined to publishing jobs.
- Give each owned Herdr test configuration disabled binary-version and detector refresh checks.
  Preserve the owner's configuration and test detector availability; validate against pinned Herdr.
- Pin and verify executable Windows prerequisite downloads. Fresh installation of a reviewed
  commit must work without release history. Update acceptance selects an explicit previous/current
  fork release pair, rejects incompatible inherited plugin IDs, and requests discovery explicitly.
- Keep Release, Website, Remote PC bundles and Windows install disabled in GitHub. Remote bundles
  become manual with publication off by default; publishing requires main, version checks,
  full CI and a protected publication environment. No tag, release, installation or deployment
  is authorized by this task.
- Rename the GitHub repository to `saurons-eye`, update canonical fork repository/install links
  and local origin, and preserve original `devswha/herdr-web-ui` attribution. Keep stable plugin
  identity, runtime/config namespaces and existing state compatibility. Document inherited tags
  and require a deliberate fork release before relying on release-based installation/update tests.
- Record the later website scope: Saurons eye identity, added-feature showcases, and prominent
  credit/link to the original project. Do not redesign or deploy it here.

## Confirmed test seams

The owner confirmed public CLI entry points using disposable configuration and owned fixture
downloads, in addition to the previously confirmed public HTTP/API and real browser seams.
Exercise decision/output behavior, download integrity, fresh install/update selection and
isolated configuration through those interfaces. Use existing full local checks before merging;
validate CI-only activation through GitHub's workflow/settings APIs and one lean CI run.

## Publication and storage

Renaming does not detach the GitHub fork or qualify it for Herdr's marketplace. The app remains
directly installable at a reviewed fork revision. Old repository URLs are redirected by GitHub;
do not reuse the old name for another repository. GitHub Pages remains disabled for the later
redesign. Do not raise paid storage limits or add production credentials to CI.
