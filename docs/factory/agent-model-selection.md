# Agent model selection

Inbox work and planning must offer model and reasoning dropdowns before Start.
Project Workflow settings save the usual selection; a task can override it for
one launch. Reasoning options belong to the selected model, not the CLI family.
Keep a visible native-default choice for existing projects and unsupported CLIs.

Read catalogs on the execution Machine with the Project's selected account and
checkout. Use Codex app-server model/list, Claude's SDK initialization catalog,
and OpenCode's native catalog metadata. Reads have bounded processes/output and
never send a user prompt or start paid inference. Native errors remain sanitized.
Refresh is explicit; an unavailable catalog must not replace a saved selection.

Validate explicit selections before accepting work. Reject unavailable models or
unsupported reasoning, and never silently substitute another model. Freeze the
explicit selection in the Run; coordinators and owned workers inherit it even after the
Project changes. Existing live agents keep their own settings.

Verify at the confirmed public HTTP, owned CLI fixture and browser seams. Cover
catalog scope, Project save, task override, native launch arguments, child
inheritance, invalid/stale selections, default compatibility, remote hosts and
desktop/mobile dropdowns. No paid models run in tests.

Native Codex acceptance on this server returned seven models, including the
owner's `gpt-6.1-sol` with `xhigh`. The read sent no prompts and started no agents.
Claude and OpenCode adapters are exercised with owned protocol/server fixtures;
their CLIs are not installed on this server. Automatic quota rules and queue
dispatch remain separate work.

Primary interfaces: [Codex model/list](https://learn.chatgpt.com/docs/app-server),
[Claude's published SDK model types](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
[Claude model/effort flags](https://code.claude.com/docs/en/cli-reference),
[OpenCode V2 models](https://opencode.ai/v2/docs/api/model/v2-model-list/), and
[OpenCode V1 agent variant support](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/agent/agent.ts).
