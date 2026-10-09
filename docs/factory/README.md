# Saurons eye factory planning

**Saurons eye** (`saurons-eye`) is the owner's specification-driven factory plugin, built on the `usergood/herdr-web-ui` fork while preserving the existing Herdr installation. The owner chose this display name and slug. This pass prepares planning and specifications only, as the owner confirmed on 9 October 2026. Implementation, skill activation, tracker publication, production service changes, deployment and merges have not been authorized by this pass.

## Read in this order

1. [Owner handoff](handoff.md): the retained requirements and server kickoff instruction.
2. [Baseline and extension points](baseline.md): facts verified in this checkout and facts still needed from the installed server.
3. [Proposed glossary](GLOSSARY.md): Implementation, Ticket and Run vocabulary for owner review.
4. [Draft specification](specification.md): the complete intended product and proposed testing seams.
5. [Dependency plan](implementation-plan.md): bounded, observable slices and a draft ticket graph.
6. [Skills and provider contract](skills-and-providers.md): pinned sources, invocation gates and compatibility evidence.
7. [Server kickoff](server-kickoff.md): the first bounded slice and unresolved owner decisions.

## Current status

| Item | Status |
| --- | --- |
| Plugin display name | **Saurons eye** — owner-confirmed |
| Plugin slug | `saurons-eye` — owner-confirmed |
| Fork | `https://github.com/usergood/herdr-web-ui` |
| Checkout baseline | `b87d9d50019cdb87422415f7650ad29285a832cc`, package `0.4.3` |
| Planning branch | `docs/factory-planning` |
| Scope | Planning and specifications only |
| Specification | Draft; acceptance and testing-seam approval pending |
| Ticket graph | Draft; granularity/dependency approval and tracker setup pending |
| Skills source | `mattpocock/skills` `v1.3.1`, resolved commit `24fe0ef7737efae15c87225755e9f6f5965e4888` |
| Source lock | [skills.lock.json](skills.lock.json); source tree identities recorded, local bundle not materialized or installed |
| Server deployment | Owner reports a working installation; its version, paths and service configuration remain unverified |
| Provider/machine verification | No factory capability pass claimed for any installed provider or remote machine |

The source lock records the complete pinned tree so support files and possible transitive dependencies cannot float independently. It does not certify skill installation or provider compatibility. A normal source clone from this agent's sandbox failed with `Could not resolve host: github.com`; further download workarounds were not attempted.

## Scope and approvals

Manual starts are fixed first-version scope. Maintain an ordered backlog and support two or three explicitly started independent Implementations, subject to a shared resource cap. There is no application scheduler, dispatch on reconnect, automatic failover or migration. Dependency scheduling within an explicitly invoked `implement-spec` Run remains required.

These documents are local review drafts, not published `to-spec` / `to-tickets` outputs or an invocation of `implement-spec`. Each user-invoked skill requires its own clearly scoped owner action. Preserve its internal confirmation gates. [Pinned invocation rules](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/.agents/invocation.md)

Proposed defaults are identified as proposals. The existing repository instructions continue to apply; the planning records do not weaken them or change application behavior. There is no Conteo work in this plan.

## Next bounded action

Slice 0 is read-only deployment inventory, verified skill-bundle materialization and a reviewed project/tracker setup proposal. Its completion evidence is in [server-kickoff.md](server-kickoff.md). Reading these records does not start that slice or the factory.
