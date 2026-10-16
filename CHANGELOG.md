# Changelog

herdr web ui is versioned with [semantic versioning](https://semver.org/). Each release is a
`vX.Y.Z` Git tag with a GitHub release. Installs update only to releases; commits on `main`
between releases do not reach them. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

### Fixed
- Approve checked Human Review candidates with an explicit, repeat-safe merge control, preserve stale/protected/denied outcomes, and verify merge or containing-release delivery before Done.
- Submit Human Review Decline with all saved comments, dispatch fresh repairs and independent validation, and return the updated PR to the same conversation awaiting explicit approval.
