# Machine account profiles

The owner requested a complete account implementation in PR #9, including creating keys and
setting up another account on a Machine. Codex and Claude use subscription logins. The existing
public HTTP/API with temporary state and owned fixtures, plus real browser journeys, remain the
confirmed testing seams.

An account profile belongs to one Machine and selects one service: GitHub (Git/SSH and `gh`),
Codex, Claude, Cloudflare `cf`, or Wrangler. Profiles have an expected login/resource identity,
private native credential storage and a public verification status. Project bindings choose
profiles for a particular Machine; accepted Runs freeze profile identities and revisions.

## Required behavior

- Create, list, update, verify and disable profiles through authenticated owner controls. Private
  keys, tokens, native auth caches, private paths and raw command output never enter public
  profile responses, Project environments, Run context, transcripts imported by the factory or
  factory backups. Private files use 0600 and directories use 0700 with atomic state publication.
- Generate a fresh Ed25519 GitHub key on the selected Machine, show only its public key and
  fingerprint, and register it with the explicitly verified GitHub account only when requested.
  Preserve existing SSH configuration, keys and native active logins.
- Prepare native login storage and provide a supported owner login/setup flow. Native browser or
  device authorization remains an owner step. Missing CLI, unsupported auth/storage, cancellation
  and timeouts remain visible; they do not choose another account or install a global tool.
- Verify the actual login and, for Cloudflare, the selected account/resource scope. Codex/Claude
  require native subscription authentication. Conflicting API/cloud/provider credentials are
  excluded from selected subscription execution; expiry or identity mismatch fails closed.
- Configure Project bindings per Machine, preserve existing projects without bindings, and
  apply frozen profiles to managed Git, coordinators, workers and scoped check/publication
  commands. Profile changes cannot silently retarget an accepted Run. Native workflow readiness
  remains distinct from account authentication and must cover the selected provider context.
- Execute setup and credential resolution on its own Machine. The connection server receives
  public identity receipts and profile references, never remote credential material. An older
  bridge without the account contract cannot accept a new binding.
- Provide Project UI for creating/setting up/verifying accounts, generating/registering keys,
  selecting bindings and showing failures. Update shared contracts, the demo, translations,
  operator documentation and retained browser evidence.

## Acceptance

Owned API fixtures and browser journeys cover two distinct accounts, restart persistence,
authorization, key generation, safe login setup, wrong/expired identity, binding/version drift,
worker inheritance, a remote Machine and redaction. Actual owner OAuth authorization is not
performed by tests. Native tools available on a Machine are checked before declaring support;
fixture identity results cannot certify a real personal subscription or native factory workflow.
