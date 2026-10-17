# src/

- The auth token lives only in the HttpOnly cookie, never in localStorage or sessionStorage.
- A new setting needs its default and type check in `sanitizeSettings`, or it is silently dropped.
- Secret input stays in the DOM input only: never React state, a draft, a queue or a retry.
- Import only types from `shared/protocol.ts`: importing a value reads the server's environment.

- Status surfaces use `role="status"`; error text, including blocked approval and repair errors,
  uses `role="alert"`.
- Bind pane/workspace APIs through `useMachineApi()`. Async work captures its PC; remote pane
  storage uses `paneStorageId(machineId, paneId)`. MachineSessionsProvider owns each visited
  PC's socket and receipts; SlotSessions owns mirrored split views. Pane mounts own only their
  attach/watch and renderer subscriptions, so leaving a view cannot suspend pending proof.
- A receipt matches its request type, captured pane, pending ID and original connection. Held
  text needs explicit Send now after reconnect/reload; input is never replayed automatically.
- Components use `useT()`; helpers use module-level `t`. All five language catalogs must retain
  matching literal keys and placeholders. UI errors keep their accessible role after translation.
