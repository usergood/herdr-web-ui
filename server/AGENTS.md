# server/

- Never let an attachment outlive its last client, and never resize from an attach that asked to
  `keep_size` or from an observer.
- Never refresh an OAuth token in `usage.ts`: the CLIs rotate refresh tokens, so our refresh signs
  the user's CLI out. Report `expired` and leave it to the CLI.
- Revoking every paired device must never reopen the LAN, and a `devices.json` that will not parse
  is not a first installation.
- Only proof says herdr is gone: on Windows a dead daemon's pid is reused by the next process.
- The user's API keys go upstream only; no response or error message carries one.
- Only Vite's fingerprinted `/assets/` may be cached long; `sw.js`, the manifest and the app shell
  must revalidate, or an installed PWA is pinned to an old build.

- Keep factory state and retained authority private. Factory mutations pass the existing owner,
  origin and revision guards; a reconnect or a retry never manufactures a new approval.
- Before changing Machine RPCs or factory lifecycle, read the domain pointers in root AGENTS.md
  and [factory runtime](../docs/factory/runtime.md). Uncertain native outcomes retain ownership
  until public reconciliation proves completion or rest.
