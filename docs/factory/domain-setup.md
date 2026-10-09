# Proposed domain and tracker setup

This is a reviewed-setup proposal, not installed Matt skills configuration. The owner must explicitly invoke `setup-matt-pocock-skills` and confirm its tracker findings and proposed edits before they are applied. [Pinned setup skill](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/setup-matt-pocock-skills/SKILL.md)

## Domain layout

Propose a single-context root `GLOSSARY.md` and `docs/adr/` for this fork. There are no monorepo signals requiring separate domain contexts. Keep [GLOSSARY.md](GLOSSARY.md) as a proposal here until owner review; it does not establish API vocabulary yet. A root `GLOSSARY-MAP.md` should be introduced only if actual separate contexts need it, consistent with the pinned setup and domain-modeling skills.

Other registered projects are independent. Discover each repository's existing glossary, ADRs, CONTEXT documents and instructions. Existing CONTEXT projects need a reviewed migration or explicit compatibility choice. A factory-global decision is not an inherited project policy.

## Tracker proposal for this fork

Propose GitHub Issues in `usergood/herdr-web-ui`, matching the fork remote. No choice, issue creation, triage labels or external PR-request surface is approved yet. Upstream CONTRIBUTING links are reference process, not authorization to publish this fork's factory work to `devswha/herdr-web-ui`.

After the owner-invoked setup confirms the choice, record canonical tracker operations in `docs/agents/issue-tracker.md` and domain consumer rules in `docs/agents/domain.md`; add a brief pointer in the existing instruction file chosen by the skill. Configure triage-label documentation only if that workflow is installed and its vocabulary is confirmed. No setup files or instruction edits are applied in this pass.

## Tracker choices for factory projects

Reuse each project's configured GitHub, GitLab or local convention. App records retain stable external IDs and immutable snapshots; synchronization failure is visible. An app-native tracker is a proposed choice for new projects, requiring a real CLI/API for publication, dependency links and resolution, documented through the skills' Other-tracker option. It is new adapter work, not an upstream capability.

Projectless research remains app-owned. Factory execution that needs a tracker stays disabled until project setup is complete. Local tracker files must have one canonical source across worktrees; replicate immutable snapshots or use the configured interface rather than independent writable `.scratch` copies.
