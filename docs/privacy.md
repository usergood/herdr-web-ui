# Saurons eye external connections

Saurons eye has no install/update telemetry or analytics receiver. The owner requested removal of upstream tracking and external defaults, while retaining services that the owner explicitly enables or configures. This is a separately authorized prerequisite; the factory itself remains in planning.

## Removed upstream behavior

- The install/update sender, generated installation ID, persisted telemetry state, timers and reporting endpoint.
- Telemetry notice, Settings switch, client requests, shared types and receiver deployment/database code. The former `/api/telemetry` endpoint returns 404 and cannot enable reporting.
- Google Fonts preconnects/stylesheet loads and CDN font fallbacks. The app's existing bundled fonts remain local; media recordings require locally supplied fonts.
- Website-build queries for upstream GitHub statistics and the Herdr plugin catalog, plus automatic downloads of upstream demonstration videos. Missing local recordings are omitted.
- Installer GitHub account/star queries and prompts. Installers require an owner-selected reviewed ref before starting installation and use the owner's fork/plugin identity.
- The upstream public-site/search-verification defaults and optional CodeRabbit configuration. Source, license and historical attribution references are retained.
- The remote runtime fallback to upstream release bundles. Use a locally built manifest or explicitly configure `HERDR_WEB_BUNDLE_MANIFEST`; missing configuration fails before a download.

The plugin identity is `usergood.saurons-eye`, its display name is Saurons eye, and its repository is `usergood/herdr-web-ui`. Default host config/state lives under Saurons eye directories so the fork does not inherit upstream service settings. Remote runtime/socket namespaces still require reconciliation before deployment. No installed plugin or service has been changed by this source cleanup.

## Owner-enabled connections that remain

| Connection | Trigger and configuration |
| --- | --- |
| App update Git remote | Manual Check for updates; periodic checks/install require `HERDR_WEB_AUTO_UPDATE=1`. The source checkout's configured origin selects the repository. Use the owner's fork and audit release/tag provenance before promotion. |
| Remote runtime manifest/assets | Owner-approved machine setup/update with a local manifest or explicit `HERDR_WEB_BUNDLE_MANIFEST`. Version and checksum checks remain enforced. Automatic bridge updates default off. |
| CLI usage meters | Settings Show plan limits, off by default. Only an enabled client asks the server to read account/provider usage. Providers include Anthropic, OpenAI/ChatGPT, Cursor, Google, GitHub, OpenCode and Grok. These are account-service requests, not an upstream analytics feed. |
| Voice transcription/polishing | Owner-configured provider key/base URL and an explicit microphone action. Browser-native speech recognition, if selected, follows the browser's service/privacy behavior. |
| Web push | Owner-enabled browser notification subscription and alerts; delivery goes to that device's supplied push endpoint. VAPID contact defaults to the owner's repository and can be set with `HERDR_WEB_PUSH_SUBJECT`. |
| Herdr update | Explicit Update herdr action; Herdr's own installer/update behavior is unchanged. |
| Build/install dependencies | Explicit install, CI, check or remote-bundle build commands can fetch pinned/locked dependencies and official Bun/Node/Herdr tooling. They are not background app analytics. |
| Source/help links | Owner navigation to the fork, provider/framework documentation or license/source references. URLs in documentation, fixtures and namespace identifiers do not execute requests by themselves. |

`SAURONS_EYE_SITE_URL` optionally supplies the owner's public site URL for sitemap output; no upstream domain is inherited. Site builds use local assets. There are no automatic website statistics or font requests to opt out of. Publishing the website requires an explicit workflow dispatch.

Native CLI agents' model connections, owner-entered commands and third-party GitHub App/account settings are outside this repository's network controls. Removing a repository config does not uninstall a GitHub App from the account. No changes were made to global CLI settings, installed software, credentials or the working deployment.

## Validation

Local source checks on Bun 1.4.2 / Node 22.22.1 passed: generated-type freshness, TypeScript, production build, nine installer/runtime tests and five plugin-settings/saved-port tests. Translation coverage and unused-key checks passed within the broader unit run.

The broader unit run was not green: this sandbox denies socket/listener operations with `EPERM`. It also exposed a saved-port namespace mismatch, which was corrected and checked with the five focused plugin tests. Live API/browser acceptance and native Windows installer checks remain unverified; rerun the required checks in the implementation sandbox before promotion. Local check logs are kept under the ignored `.ci/privacy/` directory.

Focused installer and remote-bundle tests cover missing configuration, no account queries, owner ref/identity, retained local runtime selection, checksums and corruption refusal. The server contract retains a negative test for attempts to re-enable the removed telemetry API; real managed-start browser QA checks that no telemetry identity is created.

Before promotion, run generated-type freshness, typecheck, build, unit checks, affected API/managed-start and browser acceptance in isolated resources. Check actual browser requests on initial load and the Settings/owner-enabled flows. Static URL auditing supplements those behavior checks; it does not certify configured services or native CLIs as offline.
