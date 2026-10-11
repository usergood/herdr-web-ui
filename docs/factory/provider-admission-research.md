# Provider settings and usage rules for queued Implementations

Research date: 2026-10-11. Inspected application baseline: `aff63a8f092af49a2f6dc5404a8732f3fa7163ef`. This extends the [Implementation-only queue proposal](local-transcription-and-queue-research.md); it does not implement a scheduler or activate account automation. The owner clarified that automatic reset handling means **resume after quota reset**, not replacing a conversation.

**Recommendation:** freeze each queued Implementation's provider, account, model, reasoning and native permission settings. Add account-specific admission rules that pause new Implementations when observed subscription usage or API spend reaches an owner-defined threshold. Resume only after a fresh reading confirms sufficient capacity. Codex has a documented interface suitable for this. Claude has documented session observations but a significant cold-start retrieval gap. OpenCode Zen requires dollar-budget handling distinct from Go subscription limits. Unsupported or stale readings must remain visible and block a rule that depends on them.

No model request, subscription quota request, login-status query, credential-cache inspection, billing change, reset-credit redemption or global CLI configuration change was performed. The only CLI exercise generated Codex protocol schemas in a disposable `CODEX_HOME` under `/tmp`.

## Existing application support

The existing [usage collector](../../server/usage.ts) lists multiple accounts for Claude and Codex, preserves last-known readings through failures, and reports percentages, reset times, problems and observation times through [the usage contract](../../shared/protocol.ts). It refreshes on browser requests rather than continuously: normally five minutes, forced requests at least thirty seconds apart, and provider `Retry-After` controls further requests. It deliberately does not rotate OAuth refresh tokens.

Its current adapters directly call `https://chatgpt.com/backend-api/wham/usage`, `https://api.anthropic.com/api/oauth/usage`, and `https://opencode.ai/zen/go/v1/usage`. These are existing implementation details, **not evidence of a documented public integration contract**. The OpenCode adapter reports Go subscription windows and treats a non-Go account's `403` as absent; it does not report Zen API dollars. Credential discovery includes conventional native directories and environment overrides, but does not explicitly enumerate the new app-owned account registry. A profile ID must not be matched to these readings by email alone.

[Factory launch arguments](../../server/factory-native.ts) currently select the CLI and broad access behavior, without explicit model or reasoning settings. [Factory records](../../shared/factory.ts) include a provider, free-text Project permissions and concurrency limits; they lack durable queue jobs, native permission presets, account usage policies, monetary reservations and reset-resume state. Free-text permissions are context for an agent, not an enforced CLI setting. Account-profile setup in PR #9 is a prerequisite for reliable scoped launch and usage retrieval; these queue changes should build on its final contract.

## Explicit launch settings

Use provider-specific configuration rather than claiming that one permission label means the same thing in every CLI. The accepted queue entry should contain both what the owner requested and the canonical native settings the adapter will apply.

| CLI | Model and reasoning | Permission selection | Compatibility requirement |
| --- | --- | --- | --- |
| Codex | Exact model ID; `--model gpt-6.1-sol`, `-c 'model_reasoning_effort="xhigh"'` | Approve for me: `--sandbox workspace-write --ask-for-approval on-request -c 'approvals_reviewer="auto_review"'` | Verify the selected account's model catalog and installed CLI's settings; managed requirements remain authoritative |
| Claude Code | `--model <exact-model-id> --effort <supported-level>` | Explicit native mode such as `default`, `acceptEdits`, `plan` or `auto` | Model, effort, auto-mode availability and organization restrictions vary; inspect effective settings |
| OpenCode V1 | `--model <provider/model> --variant <supported-variant>` for `run`; selected agent/config for interactive launches | `permission` rules: allow, ask or deny; `--auto` approves requests not explicitly denied | Feature and launch-mode detection required; auto-approval does not establish a Codex-style reviewer |
| OpenCode V2 | Model reference `<provider/model>#<variant>` | Ordered `permissions` rules with action/resource/effect | V2 names and variant syntax differ from V1; use a separate adapter |

The user's preferred preset is exactly **`gpt-6.1-sol` / Extra high (`xhigh`) / Approve for me**. OpenAI documents `low`, `medium`, `high`, `xhigh` and `max` for this model; API support alone does not establish subscription access. CLI flags and `-c` values override ordinary lower-priority configuration. Do not substitute another model if this account lacks access. [Model reference][sol], [per-run settings][codex-settings]

Approve for me keeps an enforceable sandbox and routes eligible approval requests to `auto_review` under `on-request`. It is different from `never` and Full Access. Managed settings can restrict it; automatic review adds model calls and therefore usage. Retain native denied/needs-owner outcomes rather than blindly answering prompts. [Auto-review][codex-review]

Claude's `--effort` applies for one session. Current levels depend on the model; `ultracode` also enables a workflow setting, so it is not a reasoning alias. Unsupported effort can fall back, and organization caps can silently clamp effort in structured-output/background runs. Record requested and effective settings and reject unavailable combinations before admission where capability discovery allows it. `manual` aliases `default` from v2.1.200. `--max-budget-usd` is a print-mode estimated-run cap, may overshoot, and is separate from subscription percentages; it is not applicable to our current interactive launch by merely adding a flag. [CLI reference][claude-cli], [effort behavior][claude-models]

Claude `auto` uses its own classifier, `dontAsk` denies actions needing approval, and `bypassPermissions` skips most prompts. These are distinct choices. Permission rules are enforced by the CLI; text in a prompt does not grant access. [Claude permissions][claude-permissions]

OpenCode V1 exposes model/variant CLI options and inline configuration variables. V1 permission rules use allow/ask/deny; auto mode preserves explicit denials. V2 instead uses `permissions`, `shell` and `subagent`, and takes variants from model metadata using `#variant`; unknown variants fail resolution. Detect the installed generation rather than sending V2 configuration to V1. These modes need their own owner-approved presets. [V1 CLI][opencode-cli], [V1 models][opencode-models], [V1 permissions][opencode-permissions], [V2 models][opencode-v2-models], [V2 permissions][opencode-v2-permissions]

The proposed accepted launch snapshot includes CLI family/version, model ID, reasoning/variant, native approval policy/reviewer, filesystem/network bounds or a resolved permission-profile revision, account profile ID/revision and authenticated subject, plus action/specification/graph/skill/reference revisions. Resolve defaults when enqueuing. Editing a Project preset later must not silently change an accepted job. Apply the snapshot to the coordinator and every app-managed implementer/reviewer it launches; stricter review permissions remain explicit. Do not rewrite the user's global CLI files or broaden permissions to make an unsupported preset work.

## Retrieving subscription usage and reset information

### Codex

The documented App Server provides `account/rateLimits/read` and update notifications. Each bucket has a `limitId`; quota windows expose `usedPercent`, `windowDurationMins` and reset epoch seconds. Prefer the multi-bucket view; a missing window is unknown. `account/usage/read` supplies token-activity statistics, not a dollar ledger or quota percentage. `model/list` supplies account/client-dependent model and effort options. [App Server][codex-server]

Earned reset credits are separate from waiting for a natural reset. Availability may be null; `availableCount` is authoritative when present. Optional `account/rateLimitResetCredit/consume` takes a persistent logical-attempt `idempotencyKey` and optional opaque `creditId`. Outcomes include `reset`, `alreadyRedeemed`, `nothingToReset` and `noCredit`. Refresh quota after redemption, including idempotent success. This feature must be disabled by default and require a separate explicit rule before spending credits. [App Server][codex-server]

A disposable local schema generation with installed **Codex 0.162.1** confirmed these methods, reset-credit fields, `ThreadStartParams.approvalsReviewer`, and `TurnStartParams.effort`. It did not establish account entitlement, current quota or live backend success. Generated evidence remains in `/tmp/saurons-codex-admission-docs-iFOU1X/schema`; it is not committed. Older CLI versions need a capability result of unsupported, not a fabricated zero reading.

Implement reads through a short-lived initialized native App Server using the selected private account profile, bounded output and a deadline. Let the native tool own authentication and refresh. Normalize only allowlisted quota fields and subject identity. Identify weekly windows by provider duration/identity, not a blanket assumption that `secondary` always means seven days. Preserve bucket IDs and model-specific applicability. The existing display's broad duration classification is insufficient for a strict weekly admission rule.

### Claude Code

Official status-line JSON includes `rate_limits.five_hour` and `rate_limits.seven_day` percentages and epoch reset times, only for eligible subscription/gateway sessions and only after the first API response. Windows may be independently absent and disappear after their reset time. Gateway spend fields have additional version requirements: percentages from v2.1.251; estimated dollars/limit/period from v2.1.284 on both CLI and gateway, with dollar readings potentially about five minutes older. [Status line][claude-statusline]

The first-party Python Agent SDK defines `RateLimitEvent` and optional `RateLimitInfo` fields for status, reset time, window type and utilization as a fraction from zero to one. A single optional event does not establish that all required windows were fetched. It can inform pauses for owned active sessions but cannot certify an unavailable weekly reading. [SDK types][claude-sdk-types]

`/usage` shows subscription bars and usage-credit spend. Its local session dollar estimate is not authoritative billing, and last-known bars can remain after a failed usage request. The fetched official documentation does not establish a stable zero-token JSON command for polling a personal Pro/Max quota before launching work. The existing OAuth endpoint adapter can remain an explicitly labeled compatibility path, with tests and failure handling; do not advertise it as a supported public API. [Usage documentation][claude-costs]

This creates a real feasibility limit: a strict fresh-weekly rule cannot automatically admit a first Claude job when no supported fresh observation is available. Report `usage_unavailable`, allow an explicitly labeled owner override if implemented, or defer admission until an owned source can supply a valid reading. Never send a dummy paid prompt to obtain percentages. Do not refresh tokens independently, scrape browser cookies, or infer that an elapsed reset timestamp means zero usage.

### OpenCode Zen, Go and V2 Console

**Zen** is an API gateway using credits and per-request charging. Its documented workspace/member monthly usage limits control consumption; automatic balance top-ups can produce cash charges above the consumption limit. BYOK usage is billed by the underlying provider. Keep Zen explicit as the billing provider. [Zen][opencode-zen]

**Go** is a separate subscription product. Its documentation defines five-hour, weekly and monthly allowances by model and allows extra usage from Zen credits. Go quota percentages do not tell us how many Zen API dollars have been spent. Record subscription and paid spillover meters separately; do not allow a subscription threshold to silently switch to paid credits. [Go][opencode-go]

**V2 Console** documents `GET /api/v1/budgets/members`. Results include member ID, limit, spend, exceeded status and reset time for the UTC calendar month. Monetary fields are decimal microcent strings: **100,000,000 microcents = USD 1**. Access requires an All-permissions service account key; an inference-only key cannot read budgets. The documented list is member-level, so do not claim it also supplies workspace totals, legacy Zen balances or all service-account totals. Capability and identity matching are required. [Budgets API][opencode-budget-api], [API authentication][opencode-console-api]

Console budgets reset at 00:00 UTC on the month's first day. Requests already in progress finish, so spend can exceed a budget slightly; reached budgets reject new requests with `429`. Provider-side controls are stronger than our Implementation admission gate, but still do not guarantee an exact final bill. [Console budgets][opencode-budgets]

OpenCode `stats` reports local session token/cost statistics. It does not establish an authoritative account-wide Zen ledger across machines. Prefer documented account reporting when available; label local totals as estimates and define whether the rule covers app-managed work or all account spend. A legacy Zen inference key alone has no quota/balance read API established by these sources. [CLI statistics][opencode-cli]

## API-dollar rules

OpenAI provides an organization Costs endpoint with Admin API authentication, daily buckets and filtering/grouping including project and API-key IDs. Current OpenAI documentation distinguishes alerts from enforceable organization/project monthly hard spend limits; hard-limit enforcement can still lag tracked spend. A subscription login cannot be assumed to authorize these API billing operations. [Costs endpoint][openai-costs], [Admin credentials][openai-admin], [spend controls][openai-spend]

Anthropic's Usage and Cost Admin APIs report token usage and USD costs, with daily cost buckets and workspace grouping. They require eligible administrative credentials; personal subscription usage is a different product, and Enterprise analytics use separate credentials/APIs. Priority Tier costs are excluded from the cost endpoint. Do not treat a Console API key or these reports as a personal Pro/Max weekly meter. [Usage and Cost API][claude-api-costs]

Proposed budget accounting should use integer monetary units serialized as decimal strings, currency, billing subject, interval start/end, provider observation time and completeness. Reconcile provider-account totals with an app ledger without double-counting settled requests. Reserve configured headroom for admitted jobs and unsettled charges. Cross-machine/manual activity and late billing can consume headroom after a check. Therefore the local gate promises **stop admitting new Implementations at the observed threshold**, not an exact invoice ceiling or instant cancellation of running work. Configure provider-side budgets separately through an explicit owner action; this research authorizes no billing writes.

Match the requested budget period to available evidence. A current-month member total cannot establish a complete weekly or per-batch account-wide total. Offer an explicitly scoped app-managed ledger for those intervals, or require a provider report that covers the requested interval and every billed source. Show whether paid spillover, hosted tools, BYOK and other machines are included. Preserve percentages above 100 where a spend meter reports them; display rounding/clamping must not erase an over-limit admission decision.

## Proposed policy and scheduler contract

This is an implementable design proposal, not a statement of existing behavior.

| Record | Required content |
| --- | --- |
| `ExecutionPreset` | Version, Machine/account binding, CLI, exact model and reasoning/variant, native permission fields, effective capability evidence |
| `UsageObservation` | Account/billing subject and Machine provenance, provider/bucket/window IDs, percent or integer USD units, reset/interval times, fetched time, source and completeness/problem |
| `AdmissionRule` | Provider/account scope, window/model selector, percent or USD stop threshold, freshness bound, resume threshold, automatic-resume setting, policy revision |
| `AdmissionDecision` | Queue job, matched rule revisions and observation IDs, reservation, allow/wait/needs-owner reason and next eligible recheck |
| `ResetAttempt` | Optional explicitly enabled earned-credit rule, subject, credit ID, persistent idempotency key, outcome/uncertain state and post-attempt observation |

Proposed routes should follow the existing authenticated factory/Machine contract: read preset capabilities and scoped usage on the selected execution host; create/update versioned presets and admission rules; enqueue an already approved Implementation into a batch; read decisions/wait reasons; pause or resume new batch dispatch; cancel a queued entry separately. An explicit usage refresh can be a bounded POST, with the existing same-origin and Machine mutation headers where native account work occurs. Remote hosts advertise a provider-policy protocol version and return sanitized observations; old hosts fail as unsupported. The existing `/api/usage` display request must not arm a queue or enable automatic resume. Mirror every added route in the fictional demo transport and keep watch-device mutations denied.

Example owner preset: Codex `gpt-6.1-sol`, `xhigh`, Approve for me; pause this account's new Implementations at 80% weekly consumption; automatically reconsider after its provider-reported reset. An 80% threshold is an illustration, not a recommended default or a currently enabled rule. A separate Zen rule could pause at USD 25 in a defined month or app-managed batch. Units and scopes must be shown beside every limit.

1. **Enqueue:** capture the accepted immutable execution/specification scope and selected account. Reject unsupported models, reasoning settings or permission modes; surface managed restrictions. Queue capacity and provider eligibility are independent waits.
2. **Observe:** fetch only accounts needed by enabled rules or queued jobs, through each Machine's scoped provider adapter. Bound output/deadlines, coalesce simultaneous requests, honor `Retry-After`, and use backoff with jitter. Keep secrets and private directories out of HTTP responses, events and manifests. A source's old numbers remain useful for display but cannot count as a fresh success after an error.
3. **Decide:** require all applicable short/weekly/model/dollar rules to pass. Missing account identity, required bucket, reset metadata or complete spend coverage means unknown. Deduplicate observations of the same provider-account bucket across Machines; do not sum percentages from two copies of one account. Prefer a shared admission authority for a shared account; disconnected independent schedulers cannot certify a global cap.
4. **Claim:** transactionally reserve capacity and monetary headroom with a durable dispatch identity. Recheck profile revision, accepted scope, observations and rule revision at the launch boundary. A competing claim must see reservations already granted. Unknown native launch ownership retains its reservation until reconciliation.
5. **Pause:** apply the rule to new queued Implementation admission. Already running Implementations, their accepted pipelines and manually opened terminal sessions keep their existing ownership. Display that continued work can increase usage. Lowering a threshold or changing a preset does not authorize silently terminating, switching provider/account/model, replying to a prompt, or sending pending input.
6. **Resume:** when automatic resume is enabled, the reset time schedules a bounded fresh read. All rules, accepted scope and capacity must pass again before dispatch. If the reset moved, a percentage stayed high, readings failed or authentication changed, remain paused with the new reason. A manual pause takes precedence. Below-threshold recovery can use configurable hysteresis; avoid repeated launch/pause flapping.
7. **Recover:** persist decisions, pauses, observations and reservations. On server restart or recovery-copy restoration, reconcile owned jobs/native runs before rechecking usage and claiming new work. Never reinterpret a restored queue as permission to change a specification, merge a PR, publish or deploy.

Natural quota resets need no remote mutation. Optional earned-credit redemption must have explicit per-account enablement, a maximum count per interval, cooldown, retained-credit reserve and eligible-window condition. Persist an attempt before sending it; retry an uncertain response with the same idempotency key. `noCredit` and `nothingToReset` stop retries until materially new evidence. If resumed work would violate another dollar/window rule, keep it paused even after a successful reset. Do not automatically buy credits, enable paid overage, send a billing-owner email or clear conversations.

## UI and acceptance evidence

The enqueue screen should show an execution preset with provider/account, model, reasoning, native permission summary and per-role review restrictions. The rule editor should show weekly/session/model scopes, USD periods, data source/freshness, automatic resume and the effect on new work. Queue cards need concrete reasons such as “Codex weekly usage 82% / stop at 80%”, “Usage reading unavailable”, or “Waiting for reset verification”; show the provider reset time in the owner's timezone while retaining UTC internally. Keep pause-new-work, cancel-queued-job and stop-active-run separate controls.

Use the already confirmed public HTTP/API seam with temporary state and owned fixtures, plus real browser journeys. Meaningful acceptance tests should establish:

- Exact model/reasoning/permission arguments reach the coordinator and owned workers; queued defaults remain unchanged after a Project edit. Codex automatic review preserves sandboxing, and unsupported provider modes never fall back to broad access.
- Two profiles on one Machine and one profile on a remote Machine get only their own identity/usage. Ambient credentials, malformed responses and leaked provider fields cannot substitute a different account or expose secrets.
- Weekly/model/short-window and USD rules compose; equality at the threshold pauses. Missing/null windows, percent-versus-fraction conversion, microcent precision, stale data and incomplete monetary reporting cannot produce a false allow.
- Two simultaneous claims cannot over-allocate reservations; duplicate enqueue/retry cannot launch twice. A claimed job losing eligibility before external launch waits without native allocation.
- Reaching a quota pauses new Implementations while an owned active Run and an unrelated manually created pane remain untouched. Manual pause persists even after fresh low usage.
- A natural reset triggers a fresh query and resumes once only when all gates pass. Clock changes, moved resets, continued high usage, `429`, expired login, server restart and remote disconnect retain the pause/reservation correctly.
- Optional earned-credit use stays disabled by default; enabled rules preserve an idempotency key through lost acknowledgments, honor reserve/cooldown/count limits, and verify usage after every success.
- Playwright can enqueue with the requested Codex preset, inspect rule provenance/wait reasons, edit policy, pause/resume and observe fictional reset recovery on desktop and mobile. Screenshots must identify fixture data, not claim a real subscription redemption or provider acceptance test.

Implementation should proceed after account-profile scope lands: first immutable native launch settings, then normalized scoped observations and rule UI, then transactional Implementation-only admission/reset recovery. Claude cold-start polling and legacy Zen account-wide dollar retrieval remain explicit capability gaps until a supported path or owner-approved compatibility mode is established. Do not postpone honest unknown-state behavior to make every provider appear supported.

[sol]: https://developers.openai.com/api/docs/models/gpt-6.1-sol
[codex-settings]: https://learn.chatgpt.com/docs/developer-settings
[codex-review]: https://learn.chatgpt.com/docs/sandboxing/auto-review
[codex-server]: https://learn.chatgpt.com/docs/app-server
[claude-cli]: https://code.claude.com/docs/en/cli-reference
[claude-models]: https://code.claude.com/docs/en/model-config
[claude-permissions]: https://code.claude.com/docs/en/permissions
[claude-statusline]: https://code.claude.com/docs/en/statusline
[claude-sdk-types]: https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
[claude-costs]: https://code.claude.com/docs/en/costs
[claude-api-costs]: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
[opencode-cli]: https://opencode.ai/docs/cli/
[opencode-models]: https://opencode.ai/docs/models/
[opencode-permissions]: https://opencode.ai/docs/permissions/
[opencode-v2-models]: https://opencode.ai/v2/docs/models/
[opencode-v2-permissions]: https://opencode.ai/v2/docs/permissions/
[opencode-zen]: https://opencode.ai/docs/zen/
[opencode-go]: https://opencode.ai/docs/go/
[opencode-budget-api]: https://opencode.ai/v2/docs/console/api/budgets/
[opencode-console-api]: https://opencode.ai/v2/docs/console/api/
[opencode-budgets]: https://opencode.ai/v2/docs/console/budgets/
[openai-costs]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
[openai-admin]: https://developers.openai.com/api/docs/guides/admin-apis
[openai-spend]: https://developers.openai.com/api/docs/guides/spend-limits
