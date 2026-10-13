# Factory issue tracker

The app-native Other tracker owns factory record identities, Specifications, Tickets, dependencies, questions, approvals and execution evidence. In an app-owned Run, use its `.saurons-eye-tracker.mjs` adapter and read `contract` for the allowed operations and frozen scope. Use only the operations permitted for that action.

GitHub issues are the planned external intake and publication surface. One independently deliverable issue corresponds to one Assignment; Tickets remain internal bounded work within an Assignment. An approved batch can be published explicitly, retaining stable links back to its plan. The automatic intake and publication behavior is proposed in `docs/factory/interface-cleanup-design.md`; use it only when implemented and enabled for the Project.

Retain owner answers through the app's question flow and consume the exact answered revision. Native conversation replies alone do not create tracker answer receipts. Pending synchronization must remain visible rather than inventing an answer or approval. Workers and checks use the app's reservations; shared document writes require the applicable ownership claim. The backend merger owns integration during implementation.

Issue publication, PR publication, merging and deployment retain their respective scopes. GitHub synchronization does not replace app approval records or authorize unrelated work. For branch and PR conventions, follow `CONTRIBUTING.md`; the fork remote is not authority to publish to its upstream.
