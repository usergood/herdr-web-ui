# Workflow conversation history

Assignment details and the Project sidebar show stable Specifications, Orchestrator and Human Review entries. Their identities belong to the Assignment. A handoff can replace the native context without replacing the logical entry: interview and to-spec Runs remain together in Specifications, and planning and implementation Runs remain in Orchestrator.

Implementation entries use the Ticket title frozen in the Run contract. Reviewer is a display group with separate Standards and Spec histories; it does not allocate a third reviewer. Each repair worker has its own Review-fixes entry. Automatic repairs stay under Orchestrator, while owner-feedback repairs stay under Human Review. Existing request-changes workers without explicit origin are owner-feedback history. Later work does not move earlier repairs.

Select an entry to inspect its retained native pages and Run, worker, Machine, workspace and pane provenance. The selected entry is included in the URL and survives reload. Open agent is available only when the Machine roster still matches that context's pane, workspace and checkout. An unavailable pane does not hide retained history. Missing captures are identified explicitly; the view does not invent transcript contents.

The owner API returns `conversations` on Assignment details and the factory overview. The demo uses the same read-only projection. IDs derive from durable Assignment, Ticket and worker identities, so no extra native coordinator, reservation or planning allowance is created by navigation or server restart. Worker snapshots can carry `worker_id`; historical captures without it belong to the coordinator. Owned workflow creation records `conversation_kind: "human_review"` for a Human Review context and freezes a repair worker's `review_origin` as `automatic` or `human`.

This view renders existing and fixture-backed records. Automatic startup, context handoff execution, assistant-backed Human Review, approval and feedback execution are separate workflow capabilities. Existing native history import controls remain available under Advanced controls.

The public API contracts are in `server/api.contract.test.ts`. The desktop/mobile browser journey is `scripts/workflow-conversations-browser-regression.ts`, registered in the browser lane. Both use disposable owned records; they never launch a paid agent.
