# Local inventory, 2026-10-09

Read-only inventory performed during implementation. No service, socket, credential, updater or deployment setting was changed.

| Item | Observed |
| --- | --- |
| Development checkout | `/home/kurri/Personal/herdr-web-ui` |
| Branch/base | `main`, starting at `afe3fb96948a7a31f4527f1d9ef652cebdfe8cdd` |
| Fork origin | `usergood/herdr-web-ui` |
| Bun / Node | 1.4.2 / 22.22.1 |
| Herdr | 0.9.3 |
| Codex | 0.162.1; native CLI reports signed in with ChatGPT |
| Claude / OpenCode | Not installed on this host at the initial capability inventory |
| Local user service | `herdr.service`, enabled, currently inactive/dead, MainPID 0 |
| Service definition | `/home/kurri/.config/systemd/user/herdr.service` |
| Web UI deployment | No deployment checkout/service supplied or selected |
| External execution host | No live SSH address supplied; onboarding supports ordinary host addresses without aliases |

Acceptance runs use fresh `check` sessions, private temporary configuration/state and ephemeral web ports. The native probe uses only its owned workspace and the installed CLI's normal authentication; it does not clone credentials or alter global skill configuration. The Matt source is pinned to v1.3.1 commit `24fe0ef7737efae15c87225755e9f6f5965e4888`, all 159 locked files are verified and its MIT notice is included.

Deployment remains a separate operation. Before choosing a production base, inspect the actual deployed web service's commit, state/socket/proxy/auth configuration and fork update/runtime sources on the selected host. This local inventory does not assert that the inactive local Herdr service is the owner's existing web deployment.
