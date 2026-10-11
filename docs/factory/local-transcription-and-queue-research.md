# Local dictation and bounded work queues

Research date: 2026-10-11. Application baseline: `03c366ff04d6f21ddb74ecbc6f00a7b57bf85582`. Proposed features remain unimplemented. A bounded CPU benchmark downloaded tools/model and compiled source only in `/tmp`; no global installation, driver/service change, user recording, credential inspection or production session control occurred.

**Recommendation:** support a CPU pilot with multilingual Whisper and one transcription at a time. On this host, base Q5_1 transcribed a public 11-second English clip in **2.36–2.62 seconds**, including CLI startup, at about **198 MiB peak inference RSS**. This establishes a working local candidate; Swedish, browser codecs and combined factory load still need evaluation. Add the explicitly authorized Implementation queue separately. Dictation needs a speech recognition model rather than a general-purpose local chat LLM. [Whisper overview][whisper]

The companion [provider admission research](provider-admission-research.md) extends queue admission with explicit model/reasoning/permissions, per-account quota and API-dollar rules, and automatic resumption after a verified natural quota reset.

## What the application already does

The browser records short WebM/Opus, MP4 or Ogg clips, posts them to the connection server, and inserts returned text at the composer's caret. Dictation does not send a chat message or execute a terminal command. Late polishing respects edits and recording identity, and dictation cancels on disconnect/unmount. Without configured server transcription, the client can use browser `SpeechRecognition`. That fallback is not an assurance of offline recognition; the web platform's explicit `processLocally` setting is separate and has limited availability. [Browser implementation][client-voice], [insertion behavior][dictation], [MDN][browser-local]

`VoiceService` currently exposes `GET /api/voice`, `PUT /api/voice/config` and `POST /api/voice/transcribe`. Configuration includes a key, OpenAI-compatible API root, transcription model and polish model. Server responses use the existing NDJSON `delta`, `done`, `polished` and `error` events. Complete JSON `{ text }` responses are already supported. Keys remain on the server; an environment key cannot be redirected through browser configuration. [Service][voice-service], [wire contract][voice-contract]

There are important compatibility gaps: configuration still requires a key, the default transcription model is `gpt-transcribe`, and requests send `languages[]` and `keywords[]`. Optional polishing calls `/chat/completions` at the same root. An arbitrary local Whisper endpoint therefore cannot be treated as a verified drop-in replacement. The upload cap is 10 MiB; the browser stops recording at 120 seconds, while the server currently checks bytes rather than decoded duration. The outer server enforces authenticated access, same-origin mutations and watch-device restrictions. [Request/configuration behavior][voice-service], [limits][voice-contract], [access controls][server]

## Measured host capability

Pre-benchmark observations used `lscpu`, `/proc/meminfo`, `df -h`, PCI enumeration and executable/module checks. Values describe this host, not a future remote Machine.

| Resource | Observation | Interpretation |
| --- | --- | --- |
| CPU | Intel Core i5-1340P; 12 reported cores, 16 logical CPUs; process allowed CPUs 0–15 | Suitable CPU pilot candidate; logical CPUs are not interchangeable full cores |
| RAM | 30.34 GiB total; 18.85 GiB available at the sample; no swap | Available memory is volatile, not a reservation or safe concurrency limit |
| Persistent storage | About 979 GiB free on the checkout filesystem | Room for small model downloads; still require an explicit quota |
| `/tmp` | 16 GiB tmpfs; about 11 GiB free | Temporary uploads use RAM-backed storage; model caches belong on persistent storage |
| GPU | Intel Iris Xe integrated graphics reported by PCI | No verified CUDA device; shared graphics memory is not dedicated VRAM |
| Tools | Bun, Node, Python, Docker and C/C++ compiler available | Existing application runtime is present |
| Missing from inspected PATH/Python | `whisper-cli`, `whisper-server`, FFmpeg, CMake, `uv`, CUDA tools, `nvidia-smi`, `vulkaninfo`, Whisper/faster-whisper/PyTorch/CTranslate2 modules | Setup and codec handling remain necessary; absence from this environment is not proof of absence everywhere |

Visible root cgroup limit files were unavailable. Ancestor/container limits, drivers, thermals and sustained performance were not established. Rerun capability checks on the selected Machine, then evaluate representative agent/build load.

## Isolated CPU benchmark

The pilot used pinned whisper.cpp source `7e26d3b0d5bced6c8217ef09710ec2f969001241`, a native CPU Release build with OpenMP, four compiler jobs, and **base Q5_1 multilingual** weights. The 59,707,625-byte model came from the project's documented model host at revision `5359861c739e955e79d9a303bcbc70fb988958b1`; its LFS SHA256 was verified as `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`. Portable CMake 3.31.6 matched its upstream checksum manifest. Total downloads were 118.6 MiB; compilation took 89.9 seconds; setup and all three runs completed within five minutes. [Model source][model-file], [official download script][model-download], [CMake checksums][cmake-checksums]

Input was the upstream **public JFK sample**, not a user recording: 11.0 seconds, 16 kHz mono PCM16, SHA256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`. Arguments selected CPU (`-ng`), four threads (`-t 4`), one processor (`-p 1`), English (`-l en`), no timestamps, and default five-beam/best-of-five decoding. [Pinned sample][jfk-sample], [CLI implementation][cpp-cli]

| Fresh CLI invocation | Wall time, startup included | Real-time factor: wall/audio | Audio seconds per wall second | Peak RSS |
| --- | --- | --- | --- | --- |
| First | 2.617 s | 0.238 | 4.20 | 197.50 MiB |
| Repeat 1 | 2.363 s | 0.215 | 4.65 | 197.45 MiB |
| Repeat 2 | 2.465 s | 0.224 | 4.46 | 197.63 MiB |

Each invocation exited successfully and reproduced both expected country-related phrases. Wall time used a monotonic clock; Linux `wait4` measured the individual inference child's peak RSS, excluding compiler/Python memory. Each process reloaded its model. Filesystem cache was uncontrolled: **first/repeat CLI runs are not cold-cache/resident-service measurements**. No cache flushing, concurrent stress, HTTP/browser upload, Swedish accuracy, cancellation or long-clip test was performed. Temporary logs, command/hash receipts and JSON measurements remain in `/tmp/saurons-whisper-bench-3fncpe3m`; no daemon was launched.

## Engine choices and model sizing

| Candidate | Relevant capabilities | Recommendation |
| --- | --- | --- |
| **whisper.cpp** | CPU inference, integer-quantized models, native binary; optional CUDA, Vulkan and OpenVINO backends | Preferred app-owned engine pilot: narrow process interface and explicit model file |
| **faster-whisper** | Python/CTranslate2; CPU INT8 and CUDA inference; PyAV bundles audio-decoding libraries | Compare if browser codec conversion dominates the native-binary setup |
| **Speaches** | Existing local HTTP server, OpenAI-style transcription route, CPU/GPU support and model lifecycle settings | Useful external-service compatibility trial before building supervision |
| Original `openai/whisper` | Reference implementation with PyTorch and FFmpeg dependencies | Accuracy/reference comparison; avoid introducing this larger stack solely for the first pilot |

These are capabilities of the inspected projects, not measurements on our server. [whisper.cpp][whisper-cpp], [faster-whisper][faster-whisper], [Speaches route][speaches-route], [Speaches settings][speaches-config], [reference implementation][whisper]

The whisper.cpp documentation gives approximate unquantized footprints: tiny 75 MiB disk/~273 MB memory, base 142 MiB/~388 MB, small 466 MiB/~852 MB, medium 1.5 GiB/~2.1 GB, large 2.9 GiB/~3.9 GB. These are baseline estimates, not decoder/process peaks or quantized guarantees. Quantization can reduce footprint; measure its accuracy and actual resident memory. Start by comparing multilingual **base** and **small**, with a Q5 variant where the pinned engine supports it. Use `.en` only for an explicitly English-only profile; Swedish or mixed-language dictation needs a multilingual model. [Native model estimates][whisper-cpp], [language/model variants][whisper]

CUDA is not established here. A future NVIDIA Machine needs compatible device access, drivers and backend dependencies; faster-whisper's inspected guidance specifies CUDA 12/cuDNN 9 for recent CTranslate2. Its published benchmarks use other hardware and settings, so they do not predict this i5's latency. Intel GPU acceleration through OpenVINO or Vulkan is a later experiment, conditional on working drivers, rather than an automatic choice from the PCI name. [CUDA requirements/benchmark conditions][faster-whisper], [native GPU backends][whisper-cpp]

whisper.cpp's inspected server defaults to loopback and `/inference`, returns JSON text, serializes inference with a model mutex, and exposes a model-loading route. It does not establish the existing application's complete streaming contract. Browser containers also need decoding; the example's conversion option requires FFmpeg. Prefer a private adapter over exposing that example directly through Traefik. Speaches has `/v1/audio/transcriptions` and a standard `language` field, but our parser/event names, language hints, cancellation and polish behavior still need a compatibility test. [Native server source][cpp-server], [server usage][cpp-server-doc], [Speaches transcription implementation][speaches-route]

## Proposed local dictation slice

Keep recording, caret insertion and explicit Send behavior. Add a provider choice with capabilities: cloud, configured local service, or managed local engine. `configured` must mean that the selected provider is usable, rather than that an OpenAI key exists. Show engine/model/device, readiness, warm-up state, queue position and a concise failure reason. Local mode should not silently fall back to cloud or browser recognition.

Put provider adaptation behind `VoiceService`, preserving the external NDJSON response. Extend `shared/voice.ts` and relevant shared protocol contracts together, and give the website demo an answer for any new route. Separate transcription from optional polishing: default local dictation to polish off. Whisper cannot provide a general chat completion endpoint; cloud polishing sends transcript text upstream, while adding a local polishing LLM creates another resource and lifecycle budget. Make either choice explicit.

A managed setup action should first produce a capability result and an exact installation plan: engine version, model revision/checksum, download bytes, disk destination, decoder dependency and estimated budget. Only an explicitly selected setup starts downloads/builds. Use private persistent data outside Git and outside factory artifact quotas, staged downloads with checksum verification and atomic rename, bounded disk quotas and owned rollback. Pin binaries/container digests and model revisions; support pre-provisioned files for offline deployment. Do not automatically install system drivers, invoke `sudo`, restart Herdr or bundle multi-gigabyte models into every app release.

Run the owned service unprivileged on loopback or a private socket, with a readiness deadline, bounded restart attempts and verified process/model identity. Avoid browser-supplied executable/model paths, arbitrary download URLs and remote redirects. A configured service needs its own local shared credential where supported; never reuse the owner's OpenAI key. Native example servers need an explicit security review because uploads and conversion are part of their attack surface. [Example-server deployment guidance][cpp-server-doc]

Before decoding, enforce authenticated owner access, byte limits and bounded multipart overhead. After decoding, enforce duration, channel/sample limits and conversion deadlines; reject oversized decoded content even when compressed upload size fits. Use generated private temporary filenames and argument arrays rather than shell-interpolating upload names. Remove audio on success, error, cancel and deadline; disable transcript/audio logging by default. Cancellation must stop owned conversion/inference or retain its slot until work is known to have stopped. An aborted HTTP request alone is insufficient proof that a separate model process has stopped computing.

Start with one active transcription, at most two waiting clips, four inference threads and a provisional 8 GiB available-memory headroom floor for the host/factory. A decoded-clip deadline includes queue wait; reject excess work rather than hold unlimited uploads. These are benchmark settings, not production guarantees: calibrate them against model RSS, factory checks and bridge latency. Backend threading and worker parallelism are independent knobs that can oversubscribe CPU when multiplied. Charge STT, agents and builds to the same Machine budget, using separate capacity pools. [CTranslate2 parallelism][parallel]

Local inference avoids an inference-provider upload, but this deployment's recording still travels over the configured browser-to-server HTTPS/proxy route, including Cloudflare. It is not a claim of phone-only processing. Transcription is fallible, especially for identifiers and shell commands; retain editable text and explicit Send/Run. Whisper's model card documents repetition, uneven language performance and hallucination risks. [Model limitations][model-card]

## Automatic factory batches: existing limits and required change

Factory settings already contain `max_implementations`, `max_agents` and `max_builds`, initially **2/6/2**; the API currently caps Implementations at three. Runtime admission transactionally counts active Runs and children, including accepted, blocked, disconnected and interrupted ownership. Worker allocation and builds have their own reservations, and uncertain launches/checks keep capacity. Capacity exhaustion returns a conflict for a later manual start. There is no durable scheduler. [Settings][factory-service], [admission][runtime], [worker/build reservations][pipeline], [records][factory-contract]

The current specification F13 explicitly excludes automatic queue scheduling/dispatch, and F06 preserves skill/owner gates. The new request changes that scope: revise F13 and the exclusion list before implementation, permitting automatic dispatch **only of queued factory Implementations within an explicitly approved, versioned batch**. The owner confirmed this narrow scope. Keep existing Ticket worker/check controls, specification/seam/ticket approvals, owner questions, independent review, publication and deployment gates. Do not add an independent automatic Ticket scheduler. Ordinary manually opened Herdr panes and pending chat input remain outside scheduler control. [Current product contract](specification.md)

Propose a durable `Batch` and `QueueJob` in the existing private SQLite store. A job pins Project, Machine, checkout/base, provider and account-profile reference/version, specification, graph, skills/reference hashes, permissions and accepted action. Store secret references, never credential bytes in manifests/events or browser responses. Enqueue validates and records the scope; dispatch rechecks approvals, checkout identity, account availability and current resource limits. Changed scope becomes `needs_you`, not an automatic acceptance of new evidence. [Store seam][store], [existing frozen admission][runtime]

Use explicit states: `queued → claimed → dispatching → running → completed`, with `needs_you`, `paused`, `cancelled`, `failed` and `uncertain` branches. A transactional claim allocates capacity and a stable idempotency/dispatch identity before external launch. A duplicate request returns the same job. A crash during launch must reconcile the native Run/worktree/pane identity; do not release a reservation on a timer and replay a possibly successful launch. Existing uncertain Runs/workers retain ownership. [Current reconciliation behavior][runtime], [pipeline identity checks][pipeline]

“Batch size” should initially mean the maximum concurrently admitted Implementations, with the next ready Implementation starting when verified capacity returns. FIFO within a Project and round-robin across Projects can avoid starvation; show capacity/account wait reasons. Strict groups that all finish before the next group are a separate policy. Current caps aggregate work across Machines; add per-Machine resource admission, including each Implementation's existing worker/check reservations and a separate STT pool. Remote capacity is not inferred from this host's resources. Preserve single-writer worktrees/shared-path claims and ensure coordinators cannot consume every slot needed by their children or final reviewers. [Existing frontier/writer rules][pipeline]

A session count limits admitted contexts; it does not enforce CPU/RAM consumption or cap unmanaged manual workloads. Where supported, optional owned cgroup/container limits can bound CPU, memory and process counts, while reserve/headroom checks keep the bridge responsive. Herdr remains the process owner: enforcement needs a compatible launch arrangement covering descendants, never migration of unrelated live panes. Detect unsupported delegation and report it. Kernel cgroup controls provide enforcement mechanisms, but their availability here has not been verified. [Linux resource controls][cgroups]

Expose Enqueue approved Implementation, Start batch, Pause new dispatch, Cancel queued job and Stop active job separately. Pause does not imply killing running work. Owner questions, expired subscription logins or native permission requests remain visible and unanswered. Verified capacity release can start the next already-authorized Implementation while the browser is closed; an idle CLI or green review is not completion or owner acceptance. It must not send a draft, resume existing work, accept a changed spec, merge a PR or deploy. After server restart or recovery-copy restore, reconcile first; uncertain ownership is retained. Subscription-account selection must remain process-scoped throughout a job; a global CLI login switch is unsafe for concurrent jobs.

## Implementation order and acceptance evidence

1. **Extend the benchmark:** compare base/small and optionally faster-whisper on fictional/consented 5–120 second English/Swedish/mixed-code clips. Record model/decoder hashes, thread settings, cold/resident latency, real-time factor, RSS, identifier accuracy and simultaneous agent/build responsiveness. Establish a latency/headroom target before declaring broad host support.
2. **Configured local service adapter:** verify auth, codecs, JSON/SSE adaptation, language selection, cancellation/deadlines, polish-off behavior and explicit Send. Add Playwright coverage with owned fixture audio and temporary application state; screenshots should label fixtures rather than imply a real recognition benchmark.
3. **Managed optional setup:** test corrupt/partial downloads, disk shortage, incompatible binary/codec, failed readiness, restart loops, secret-safe errors, uninstall of only owned files and offline use after provisioning.
4. **Batch specification and scheduler:** pin account/profile scope first, then implement transactional jobs, resource admission and owner controls through the public API. Test duplicate enqueue, competing schedulers, cross-Project fairness, dependency frontiers, lowering limits during active work, blocked questions, auth expiry and cancellation races.
5. **Recovery and combined load:** inject crashes before/after launch acknowledgment, remote disconnects and uncertain child/check identities; prove no duplicate native launch or accidental capacity release. Prove drafts and disconnected pane leases receive no automatic input. Validate resource limits with a synthetic stress workload in an isolated Herdr test session, never the owner's live terminals.

The completed narrow benchmark supports a local-service adapter pilot. Automatic batches remain a substantial separate feature, with existing reservations/store as foundations and explicit scheduling authority, account scope and recovery semantics.

[whisper]: https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md
[model-card]: https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/model-card.md
[whisper-cpp]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/README.md
[cpp-server]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/examples/server/server.cpp
[cpp-server-doc]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/examples/server/README.md
[cpp-cli]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/examples/cli/cli.cpp
[model-download]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/models/download-ggml-model.sh
[model-file]: https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin
[jfk-sample]: https://github.com/ggml-org/whisper.cpp/blob/7e26d3b0d5bced6c8217ef09710ec2f969001241/samples/jfk.wav
[cmake-checksums]: https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-SHA-256.txt
[faster-whisper]: https://github.com/SYSTRAN/faster-whisper/blob/a52b026ac844c02117865e61968547639b60a6f8/README.md
[speaches-route]: https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/routers/stt.py
[speaches-config]: https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/config.py
[browser-local]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally
[parallel]: https://opennmt.net/CTranslate2/parallel.html
[cgroups]: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
[voice-service]: ../../server/voice.ts
[voice-contract]: ../../shared/voice.ts
[client-voice]: ../../src/lib/voice.ts
[dictation]: ../../src/components/VoiceInput.tsx
[server]: ../../server/index.ts
[factory-service]: ../../server/factory.ts
[runtime]: ../../server/factory-runtime.ts
[pipeline]: ../../server/factory-pipeline.ts
[factory-contract]: ../../shared/factory.ts
[store]: ../../server/factory-store.ts
