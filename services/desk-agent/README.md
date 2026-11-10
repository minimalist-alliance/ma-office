# desk-agent

The runtime behind the desk's Agent app (design section 9): a Java 21 Spring Boot service in Docker on each desk, in
`deskd`'s style (ADR 0040). It runs the desk's agents, calls the member's LLM provider with the member's own key,
enforces the usage limits and keeps the audit log. It keeps keys sealed on the desk's own disk, and in RAM while it runs
(ADR 0042). A client reaches it only through deskd,
which relays task 07's `agent.*` interface over a local socket. The Agent window's UI is task 07's; this is the
backend.

**State: milestone 2.** desk-agent serves all of task 07's `agent.*` methods and topics on its agent socket, and talks
to Anthropic (Messages API), OpenAI and xAI (Responses API) with thin adapters on the JDK's HTTP client, streamed. They
are tested against a local stand-in only: no real key has touched them. deskd relays the interface to it
(`services/deskd`, package `agent`, `API.md` section 11, from `sub/deskd-agent-relay`), and the image gives it its unit,
directories and egress rule (`image/README.md`, "desk-agent", from `sub/desk-agent-image`). Its first release,
`2026.11.06-60828be`, is baked into the image from 0.2.7 (task 42), so every new desk runs it. No tools yet: see "Not built".
`STATUS.md` in this folder has the questions and what the weekend lead can ship.

**Task 49, many agents (ADR 0047, `sub/multi-agent`, merged to main, in no release yet).** A desk holds many agents, up to its
tier's cap; the manager is the **lead**, which sets the others up with the member through proposals the member
confirms; agents have tools on every provider (their workspace, messages to linked agents, and the lead's), opt-in
messaging with hard limits, a workspace and timers each. The client's interface is `docs/multi-agent.md`; "Many
agents" below is how it works here.

## A guild desk (task 48)
deskd adds the verified caller to every `req`, KEY frame and `sub` (`service/Caller`: `owner`, `guild_member` or deskd's own `system`; none means the owner, and a malformed one is `forbidden`, `reason: caller`). On a guild desk each member has one agent of their own, whose id is their member id, made the first time they look, and sees and uses only it: any other agent is `not_found`, and the Founder's view has no member's thread (draft decision 6). Its calls reserve against `service/GuildLimits`, from deskd's `desk.guild.set`: the member's dollars a day and month as the agent's, and the guild's month as the desk's, so both bind; runs a day (`member_runs_day`) and runs at once across the guild (`guild_runs`) are checked before a run starts. A teen member is refused (`age_band`), the guild's keys, limits and audit need `manage_agents`, and `agent.guild.usage` (each member's runs and spend, counts only) the Founder's or an Officer's role. `agent.state` has one view per member, the owner's and deskd's own (`AgentService.hubTopic`). No schema change: a member agent is a `manager` row whose id is a member id. deskd's `API.md` §15 has the client's side.
On a guild desk the team (task 49) is the owner's: a member's own agent has no team tools, isn't counted toward the agent cap, and can't be linked or shared with; every new `agent.*` method but `agent.get` is `forbidden`, `reason: permission`, for a member.

## Layout
| Path | Holds |
|---|---|
| `pom.xml` | A module of `services/pom.xml`: `./mvnw -pl desk-agent verify` from `services/`, or `-f desk-agent/pom.xml` |
| `Dockerfile` | The image: deskd's Temurin bases by digest, Spring's unpacked layout, SQLite's library extracted at build, AppCDS training. Build context is `services/` |
| `docker/` | `jvm.options` (each flag with its reason), `desk-agent.env` (every setting, commented out), and the release's `run` and `health` |
| `src/main/resources/pricing.json` | Every Phase 1 model's price, from the providers' pages on 2026-11-06: the seed until deskd pushes the Platform's table |
| `scripts/test-release-scripts.sh` | Packaging tests without Docker: the shared `build-image.sh` and `package-release.sh` against a stub docker, `run`'s flags, `health`, the env file, the Dockerfile's rules, then the image's JVM steps and entrypoint with the local JDK |
| `scripts/test-image.sh` | The real image with whatever Docker is reachable: build with the legacy builder, run as `run` does, health and one `agent.list` over the agent socket, RSS and startup, then removes exactly what it made |
| `scripts/test-on-box.sh` | `test-image.sh` on the arm64 test box, over SSM, as `services/scripts/build-on-box.sh` does it |
| `scripts/measure.sh` | Startup and memory from the unpacked jar with `jvm.options` and the trained archive, no container, and the answer path through `FootprintProbe`; `measure.sh team` runs `TeamFootprintProbe` (many agents, task 49) |
| `docs/proposals.md` | Changes proposed outside this folder: the parent pom, `desk-runtime.md`, the image, the agent socket and deskd's relay, the client interface |
| `spikes/spring-ai-footprint/` | The measurement behind "thin clients, not Spring AI" |

## Packages
`com.minimalistalliance.desk.agent`:

| Package | Holds |
|---|---|
| (root) | `DeskAgentApplication` (explicit imports, no scanning), `AgentConfiguration` (every bean by hand), `DeskAgentLifecycle` (health socket, records, agents, then the agent socket; on SIGTERM the reverse, with runs stopped and keys zeroed), `DeskAgentHealth`, `ReadinessReporter`, `DataDirectory` |
| `socket` | `AgentSocketServer`: the agent socket, deskd's only way in (`docs/proposals.md` section 5). `PeerCheck`: deskd's uid only, by `SO_PEERCRED` |
| `service` | `AgentService`: every `agent.*` method, and the `agent.state` and `agent.conversation:<agentId>` topics. `TopicHub` (snapshot then events, in order, per subscription), `Deltas` (text deltas at 30 Hz at most), `RpcError` (deskd's codes) |
| `store` | `AgentStore`: `agent.db`, with the agents, their threads, key metadata (never keys) and the desk's limits. `TeamSchema`: task 49's tables and columns, additive, applied at every open, with `user_version` still 1. `TeamStore`: their rows (each agent's look, purpose, solo flag, quota and shares; links; proposals; the agent-message log; timers) |
| `team` | Task 49 (ADR 0047). `Team`: every new `agent.*` method of `docs/multi-agent.md`, the agent view's new fields, proposals and their answers, and `Host`, the way back into `AgentService` for runs a timer or another agent starts. `TeamTools`: each run's system prompt and tools, and the tools themselves (`message_agent` with its limits, the lead's `desk_*` and `propose_*`). `Timers`: the timers' RPCs and the thread that fires them. `Schedule`: the next fire in the member's zone. `TierCaps`: the tier's values from `desk.account.set`, with Alliance's as the defaults (the last tier and band are kept in `agent.db`). `Canonical`: a proposal's canonical JSON and SHA-256, as the Agent app computes them |
| `provider` | `ChatProvider`, the interface every adapter implements, and its values: `ChatRequest`, `ChatResult`, `Usage`, `DeltaSink`, `ProviderId`, `ProviderInfo`, `ModelInfo`, `ProviderException`. `ProviderRegistry` |
| `provider.anthropic` | `AnthropicProvider`: Messages API, streamed, and the model list that checks a key |
| `provider.openai` | `OpenAiResponsesProvider`: Responses API, streamed, with `store: false`. OpenAI's and xAI's, which serve the same API |
| `provider.http` | `HttpTransport` (the one HTTP/1.1 client, the idle watchdog JDK 21 lacks, https-or-loopback base URLs), `SseReader` (bounded server-sent events), `Messages` |
| `key` | `KeyVault` (keys sealed at rest in `/data/agent/keys`), `KeyRing` (keys in RAM, in direct buffers, zeroed on drop) and `KeyLease` (one call's heap copy, zeroed on close) |
| `limits` | `UsageLedger` (SQLite: reserve, settle, release, keep, and each scope's use, in the member's zone), `LimitSettings` (the agent's scopes per agent, the desk's once, and the layers of ADR 0043), `PriceTable` (the table in use, swapped whole), `Pricing` (one table, and what an unlisted model counts at), `LimitPolicy`, `Limit`, `Scope`, `LimitReachedException` |
| `audit` | `AuditLog`: append-only, hash-chained, in its own SQLite file |
| `llm` | `LlmGateway`: the only way to a model. `reserve` (every check and the limits, nothing sent), then `complete` (lend the key, call, settle, audit) |
| `manager` | `ManagerAgent`: one per agent since task 49 (`forAgent`), with the tool loop (`RunSetup`, `Tools`). Dormant until bound to a key it holds, one run at a time, badge on every answer. `start` refuses only `no_key`, `busy` and `limit_reached`; the `Run` then ends `done`, `stopped` or `failed` on its own thread |
| `attach` | Files on a message (ADR 0049). `Staging`: files being attached, in memory only, 10 minutes, zeroed. `Caps`: the owner's limits within ceilings. `Sniff`: what a file is, by content. `Preparer`: staged files to attachments, applying the caps. `Parsers` and `worker/*` (`ParseWorker`, `PdfText`, `OfficeText`, `PlainText`): reading in a child JVM, one at a time. `Vision`: which models take pictures. `ImageBudget`: picture bytes with model calls at once. `AttachException`: a reason word, a file's name, a limit, never content. `provider.Attachment` is what a run holds and wipes |
| `sqlite` | `SqliteDatabase`: one file, one platform thread, WAL, migrations by `user_version` |
| `json` | `Json`, a copy of deskd's jackson-jr helper |
| `icon` | `PngMark`: an uploaded icon decoded as a strict, real PNG with `java.util.zip` only (no ImageIO, no AWT) and re-encoded as a new gray+alpha mask with no metadata (`docs/multi-agent.md` section 7). `IconException`: `not_png`, `too_large`, `too_many_pixels`, `corrupt`, `no_shape`, `too_thin`, never any content. The mask is trimmed and centred in a square (section 7 of the doc) |
| `workspace` | `Workspaces`: a folder per agent under `<dataDir>/workspaces/` (section 5), with quotas, a cached use (every file and folder counts at least 4 KiB), 10,000 files, 2,000 folders, 1 MiB a write and a free-space floor of 1.5 GiB. Files with more than one hard link are refused. Paths are walked a component at a time with links never followed; a link at a file's name is replaced on write; `deleteAll` and `remove` delete links, not what they point at. `WorkspaceException`: `path`, `not_found`, `quota`, `not_text`, `too_large`, `disk_low`, `disk_budget`, `too_many_files`, `too_many_folders`. Wired in through `team.Team` (task 49); the class comment lists the limits that remain (hard links, a swap between check and use) |
| `training` | `CdsTraining`, the AppCDS training run, with `TrainingAnthropic` (a stand-in on a loopback port) and `TrainingClient` (the socket's client side). Nothing else refers to it |

Tests use stand-ins on real sockets: `FakeLlmServer` (Anthropic's and OpenAI's APIs on the JDK's HTTP server, every
request recorded), `AgentSocketClient` (deskd's side of the agent socket, KEY frames included) and a scripted
`FakeProvider`, with real SQLite files in temporary directories and a `MutableClock` (`testing/`). `Rig` wires the
gateway as the configuration does. `DeskAgentSocketTests` drives the real application through its socket and the
real adapters, as deskd and task 07's app will: the whole flow, every refusal, a restart. `icon/PngMarkTest` writes its own PNGs (every colour type and depth, Adam7, all filters, a bomb) and checks refusals and masks, with ImageIO only in the test to cross-check; `workspace/WorkspacesTest` makes real symlinks to prove nothing escapes. `key/KeyVaultTest` and
`service/AgentServiceKeysTest` take the vault apart and restart the service on its files. `DeskAgentApplicationTests`
boots it as `main` does, and `DeskAgentAotIT` the same from the AOT-generated classes. `CdsTrainingIT` runs the
training from the jar in a JVM of its own. `measure/FootprintProbe` is a main, not a test.

The many-agents tests (task 49, `team/`) run a real `AgentService` and `Team` through `testing/TeamDesk` on temporary
files, a scripted `FakeProvider` (a `Step` may return tool calls: `Step.calls`) and a `MutableClock`; closing a
`TeamDesk` and opening another on the same files is a restart. They cover the cap and the agents' CRUD, links, the
lead's proposals and their hashes (`Canonical` against vectors made by `JSON.stringify`), messages between agents
and every refusal, timers (`Schedule` across a weekend and both clock changes, restarts, missed and busy fires),
workspaces through the tools, icons, and the tool loop's limits. `LookIdsTest` compares the icon and tone ids with the
Agent app's `web/agent/src/look/` when the web sources are beside the module, and `store/TeamSchemaTest` that
`agent.db` stays at schema version 1. The fix pass added `team/DoneMeansTest` (the spec's "done means" as one story on the real service with the fake provider), `team/TierEnforcementTest`, and many cases in `AgentMessagesTest`, `ProposalsTest`, `AgentsTest`, `WorkspacesTest`, `PngMarkTest`, `TimersTest` and the provider tests; deskd has `AgentAgeBandTest` and `GuildAgentRelayTest`.

## Settings
As properties or as variables in `desk-agent.env` (root-owned). There's no dev mode: only paths, deskd's uid and the
providers' endpoints vary, so a stand-in can take a provider's place.

| Variable | Default | Meaning |
|---|---|---|
| `DESK_AGENT_DATA_DIR` | `/data/agent` | `agent.db`, `usage.db`, `audit.db`, `keys/`, and since task 49 `workspaces/` (a folder per agent) and `icons/` (uploaded masks). `/health` is 503 if it's missing or unwritable, or a database can't open. A bad `keys/` doesn't change `/health` |
| `DESK_AGENT_ADMIN_SOCKET` | `/run/desk-agent/agent-admin.sock` | The health socket, `0600`. At most 107 bytes |
| `DESK_AGENT_SOCKET` | `/run/desk-agent/agent.sock` | The agent socket, `0660`. desk-agent won't start without it |
| `DESK_AGENT_PEER_UID` | `1100` | The one uid the agent socket accepts: deskd's |
| `DESK_AGENT_ANTHROPIC_URL`, `DESK_AGENT_OPENAI_URL`, `DESK_AGENT_XAI_URL` | `https://api.anthropic.com`, `https://api.openai.com`, `https://api.x.ai` | Base URLs: `https`, or `http` only to loopback, so a key never goes anywhere else in clear text |
| `DESK_AGENT_EGRESS_PROXY` | none | deskd's egress proxy (design 9.8) as `host:port`, once it exists |
| `DESK_AGENT_VERSION` | From `/app/desk-agent.properties`, which the image writes from its `VERSION` build arg | `/health`'s `version`. Leave it unset |

A new setting goes in `docker/desk-agent.env` too, which `test-release-scripts.sh` checks. `/health` answers
`{"status", "version", "data", "audit", "usage", "agents", "deskd", "manager", "keys"}`: whether deskd is connected,
the manager's status and the number of keys held are informational.

## The agent socket and the providers
- **Tool calling at the adapter level** (ADR 0047, task 49): `ChatRequest.tools()` goes out as Anthropic's `tools`
  (`name`, `description`, `input_schema`) or the Responses API's `function` tools (`strict: false`), only when there are
  some. A thread's tool turns map through `Messages.anthropic` (same-role turns merge their `text`, `tool_use` and
  `tool_result` blocks) and `Messages.responses` (`function_call` and `function_call_output` items with the call's id
  and no item id, as `store: false` keeps nothing). The stream's calls come back in `ChatResult.toolCalls()`, in order:
  from `tool_use` blocks and their `input_json_delta`s, or `response.output_item.done` with `response.completed`'s
  output as a fallback. Arguments that aren't a JSON object give a `malformed` call with an empty input. A turn of more
  than 64 calls or a call of more than 256 KiB of arguments fails as the provider's malformed reply (`UNAVAILABLE`,
  may have billed). The agent loop that runs them isn't in the adapters.
- **The socket** (`docs/proposals.md` section 5 has the frames and the method-by-method mapping): every `agent.*`
  method of task 07's interface is a `req` with the same name and params, answered `res` or `err` in deskd's codes,
  and each client subscription is a `sub` with its own `sid`, answered by a `snapshot` and then every event. deskd
  relays them one to one. Keys come in the one binary frame, `0x02`, read into a direct buffer.
- **Threads live here,** in `agent.db`, so the relay is a pass-through. `agent.message.send` refuses only `no_key`,
  `busy` and `limit_reached`, before anything is added. Then the member's message and a `streaming` reply go to the
  topic, deltas follow at 30 Hz at most, and the reply's final message replaces it: `done`, `stopped`, or `failed`
  with `provider_error` and the kind, or `unavailable`. Each call sends the last 100 messages, done replies only.
- **A thread comes in pages** (`AgentService.page`): the newest messages that fit in `PAGE_BYTES`, about 960 KiB of
  JSON, up to 1000, read 50 rows at a time, with `older` when there are more. `agent.thread.get` takes `before`, a
  message's id, to page back, and a conversation's snapshot is the newest page, so neither outgrows deskd's RES or a
  frame. A newest message too long for a page alone keeps the start of its text, with `truncated: true`.
- **A key is checked before it's kept,** with the provider's free model list: `key_refused` if the provider refuses
  it. Before that, and before anything leaves the desk, a key that starts with another registered provider's prefix
  rather than the one picked is `key_malformed` with `provider_mismatch`, so an Anthropic key picked as OpenAI's never
  reaches `api.openai.com`. The longest prefix that fits decides, as `sk-ant-` starts with OpenAI's `sk-`. Its metadata (provider, label, last four characters, when, which desk) goes in `agent.db`; the key itself is
  sealed in `/data/agent/keys` and held in `KeyRing` ("Keys").
- **Adapters** are about 150 lines each, on one HTTP/1.1 client (no HTTP/2, whose header table would keep the key).
  Requests carry a 120 s timeout to the headers and a 90 s watchdog between bytes, since JDK 21's timeout stops at
  the headers; a stopped run interrupts the read. Refusals before generating (4xx, 5xx) cost nothing; a stream cut or
  stalled after it started keeps its reservation, as the provider may have billed it. OpenAI's and xAI's calls send
  `store: false`, so the provider keeps no copy for later.
- **Prices** for every Phase 1 model are in `pricing.json`, with Haiku 5.5's and xAI's length tiers, until deskd pushes
  the Platform's table (Limits, below). A dated model id takes its undated entry's price; nothing else is matched
  loosely.

## Files on a message (S-118, ADR 0049)
The owner's rule: files uploaded to an agent are not retained; as soon as they are processed through the LLM, they are removed. So a file only ever exists in desk-agent's memory.

- **Methods** (deskd relays them): `agent.attach.put {agentId, uploadId, name, size, index, data}` (one chunk of at most 512 KiB, base64, in order), `agent.attach.remove {agentId, uploadId}`, `agent.attach.caps {agentId?}`, `agent.attach.caps.set` (the desk owner's), and `agent.message.send` takes `attachments: [uploadId]` with `text` possibly empty. Refusals are `too_large` or `bad_request` with `details: {reason, name?, limit?}` (the reasons are in `AttachException`), `conflict` + `busy`, and `precondition_failed` + `no_key` before anything is taken (the files stay staged).
- **The path of a file:** chunks into `Staging` (zeroed after 10 minutes, on remove, on send, on stop) → `Preparer` (caps, `Sniff`, the child JVM for documents; pictures stay as bytes) → an `Attachment` on the user turn of this run's request only → wiped when the run's result completes, or at once if the run is refused. The thread keeps `message_files` (name, type, size, note) and nothing else.
- **No retention is tested everywhere a file could land** (`service/AgentAttachmentsTest`): the SQLite files including the WAL, the audit table, events published to subscribers, captured logs, `agent.thread.get`, staging and the `Attachment`, after an answer, a provider failure, a stop, an expiry and a refusal. Hostile files (an order to ignore instructions, a forged closing line, a forged tool result) stay inside the one real fence (same test); the Anthropic and Responses bodies are in `provider/http/AttachmentBodiesTest`.
- **Honest limits.** A Java `String` can't be zeroed: a document's text, the decoded chunk and the request's JSON are dropped for the collector, and may sit in the heap until it runs. The bytes of a file and a picture are zeroed. A heap dump or a crash report could hold them: `jvm.options` writes neither to a disk, and attach is disabled. The provider keeps what it keeps, under the member's own key.
- **Footprint** (`scripts/measure-attach.sh`, a build box, x86_64, no container, `jvm.options` as shipped but `-Xmx128m`; `AttachFootprintProbe` drives the real application over its agent socket with the provider stand-in in another JVM; peaks sampled every 20 ms from /proc, RSS and anonymous, of desk-agent plus its parse child): idle 85 MiB RSS (60 anonymous). Five PDFs of 100 pages, 12 MiB in all: peak 220 to 229 MiB together (child 76 of it), heap 59 to 69 MiB, 2.0 s to read. Three pictures, 12 MiB: peak 169 to 175, heap 81 to 82, no child. Two pictures and three PDFs: 209 to 211, heap 79. Two agents at once, 12 MiB of pictures each: 204, heap 114, the second asked to wait (`ImageBudget`). Two agents at once, 12 MiB of PDFs each: 254 (209 anonymous), heap 84. At `-Xmx96m` the two-agents picture case ended the process with an out-of-memory error, hence 128. The container's `--memory=320m` holds with 66 MiB of headroom; a limit of 384m would add margin and is not needed.

## Keys (ADR 0042)
A key lasts: it survives restarts, updates and reboots, moves with an export or a move, and goes with the desk. No
Platform key is involved, so a self-hosted desk works the same.

**On disk, sealed.** `/data/agent/keys/`, mode `0700`, owner `agent`:

| File | Holds |
|---|---|
| `master.key` | 32 random bytes, mode `0600`, made once. In memory only while sealing or opening |
| `<keyId>.sealed` | One per key, immutable, mode `0600`: `MAKV`, version byte 1, a random 12-byte nonce, then AES-256-GCM ciphertext and tag. The AAD is the magic and version, then the key id and the provider, each after its `u16be` length |
| `master.key.bad-<n>` | A `master.key` that wasn't 32 bytes in a regular file, kept rather than overwritten |

Each is written to a temporary file, fsynced, renamed atomically, and then the directory is fsynced. `agent.db`'s `keys`
row is the commit point, and no schema changed, so a rollback to an older `desk-agent` just sees `no_key`:
- **Add:** format, the provider's check, seal, then the row. A failed seal answers `unavailable` with `reason: storage`
  and keeps nothing in RAM or on disk. A failed insert removes the sealed file. RAM only is never a fallback.
- **Delete:** the row, which unbinds agents; `KeyRing`; the file, with the directory fsynced; only then the answer. A
  failed unlink answers `reason: storage`, and the same call or the next start finishes it.
- **Start:** tighten the modes, remove temporary files, unseal each row into `KeyRing`, and write one `key.restore` audit
  row. A file with no row is an orphan from a crash, and goes. A row whose file is missing or won't open stays listed
  with `available: false`, sends get `no_key`, and its file stays until the member deletes the key.
- **A bad vault never stops a start.** A missing `master.key` is made again, and old files then fail their tag. A
  wrong-length one is renamed aside. One that's there but unreadable is left alone, since fixing its owner brings every
  key back, and adds answer `reason: storage` until then.

**The limit:** `master.key` sits beside what it seals. No Platform service or API can read a key, but root on the
machine or whoever holds the volume can, as with everything else on a desk. ADR 0042 lists what that covers.

**In RAM,** what holds, and where the JVM stops it:
- **At rest in RAM, one copy, zeroed.** `KeyRing` keeps each key in a direct buffer of its own: native memory the
  collector never moves or copies. A drop, a replacement, `dropAll` and SIGTERM zero it, and a start brings it back from
  `KeyVault`. No key is logged, or put in an exception or a `toString`, and `agent.db` holds none.
- **Coming in, as bytes.** `put` takes a `byte[]` and zeroes it before returning, whether the key was accepted or not.
  A key must be 8 to 1024 printable ASCII characters with no space, as it goes into a header, so a CR or LF can't add
  one. Adding is recorded in the audit log first, and refused if it can't be.
- **In use, a lease.** A call borrows a heap copy (`KeyLease`), zeroed when the lease closes.
- **Where it becomes a `String`, which can't be zeroed:** `KeyLease.headerValue`, because the JDK's `HttpClient`
  takes header values only as strings. That string, and the client's own copies on the way to TLS, stay in the heap,
  unreachable, until the collector reuses the memory. Spring AI would hold the key as a `String` for the client's
  whole life (`spikes/spring-ai-footprint/`). Writing HTTP/1.1 by hand over an `SSLSocket` would remove the
  `String`, not JSSE's buffers.
- **Copies the collector made.** A heap `byte[]` or `char[]` can be copied by SerialGC before it's zeroed, and the old
  copy isn't. The lease's copy is short-lived, so it's usually still in eden when zeroed, but nothing guarantees it.
  HotSpot has no product flag that clears freed heap.
- **While sealing or opening.** The vault's arrays are zeroed straight after, and `master.key` goes through a direct
  buffer of its own, not NIO's cached one. `SecretKeySpec` and `Cipher` keep their own copies of the master key, which
  can't be zeroed, until the collector reuses the memory.
- **On the way in from deskd.** The agent socket carries a key in its own binary frame, read straight into a direct
  buffer and handed to `KeyRing` without a heap copy, then zeroed (`AgentSocketServer`, `KeyRing.put(ByteBuffer)`).
  desk-agent never makes a `String` of one but in `headerValue`. deskd will, as jackson-jr parses the client's JSON.
- **Its last four characters** are kept, as Platform's metadata does (design 9.5), so the member can tell keys apart.
- **Around it:** `-XX:+DisableAttachMechanism`, no heap dump on OOM, no core file (`-XX:-CreateCoredumpOnCrash` and
  `--ulimit core=0`), a crash report only in the container's `/tmp` (RAM), and the image's zram-only swap (ADR 0007).
- **A key only goes to its provider.** The gateway refuses a binding whose key belongs to another provider, so one
  provider's key can't be sent to another's host.

## Limits (design 9.9, ADR 0020)
- **Scopes:** per agent a day, a week (from Monday) and a month; per desk a day and a month; per key on this desk a
  month; per run in dollars and in steps. Each is a cap in estimated micro-dollars (µ$), in tokens, or both. Defaults:
  agent $5 a day, desk $20 a month and no cap on its day, run $2 or 50 steps (`LimitPolicy.DEFAULTS`). `LimitSettings`
  keeps the agent's scopes per agent and the desk and key scopes once for the desk: every agent's policy shows them,
  and setting any agent's sets them for all (task 07's ask 2). They're saved in `agent.db`.
- **Desk, then account, then default (ADR 0043):** `deskDay`, `deskMonth` and the time zone layer. The desk's layer is
  what the member set and nothing else, in setting `limits.desk`, so a desk that set nothing follows its account. The
  account's comes from deskd on each connection (`desk.account.set`) and isn't saved. Null in a layer says nothing, and
  a `Limit` with both caps null is "no limit, set here", which beats the layers under it. `limits.desk` keeps the old
  top-level `deskMonth` and `keyMonth` beside its new `own`, as a release from before this fails to start without them;
  a row with no `own` is an older one's, and its `deskMonth` counts as this desk's own.
- **Periods are the member's (ADR 0043):** days, weeks from Monday and months begin at midnight in the zone in force, an
  IANA region the JDK knows or `UTC`, read for each call. `UsageLedger` keeps `at_ms` and no period, so a changed zone
  just windows the same rows differently, with no schema change. `LocalDate.atStartOfDay` handles the days clocks
  change, midnight gaps included. With no zone set they're UTC.
- **Reserve, then settle.** Before a call the gateway estimates the worst case, input as UTF-8 bytes over 3 plus the
  output cap, and `UsageLedger.reserve` checks every scope and writes the reservation in one `BEGIN IMMEDIATE`
  transaction, so concurrent runs can't fit into one remainder (`LlmGatewayTest.concurrentRunsCantOverspend`: ten
  runs, room for three, exactly three go out). After it, the row becomes what the provider reported. A refusal before
  generating costs nothing; a failure that may have been billed keeps its reservation; reservations a crash left are
  kept as spent at the next start. A limit is passed by at most one call's excess over its estimate.
- **Kept 100 days (review finding 22).** A finished row (settled, released or kept) older than `UsageLedger.KEEP` goes,
  at each start and then once a day, as the audit log's year does at start. That's past the longest period any limit
  reads, a month, with room for a changed zone, so no limit reads differently; a run's own limits read all its rows, and
  no run lasts that long. A reservation still out is never pruned. Without it `usage.db` grew about 200 bytes a call.
- **Prices** are the Platform's (ADR 0043): deskd fetches its table and pushes it (`desk.prices.set`), and `PriceTable`
  holds the one in use, a single volatile read on the way to every call. The bundled `pricing.json` is the seed, and all
  there is with an older deskd or before the first table comes (µ$ exact, every rounding up; every Phase 1 model as of
  2026-11-06, with long-prompt tiers where a provider has them; not signed yet). A table that can't be used is ignored,
  with one log line and none of its content, and a price past $100,000 a million tokens makes it unusable, as a sum at
  one could overflow. A call takes its price when it's reserved, so a settled cost stays as it was charged.
- **An unlisted model counts at the highest listed price** (`Pricing.chargedPrice`, ADR 0043), so dollar limits always
  bind. A dated id takes its undated entry first. Any other model counts at its provider's highest listed price by
  `output`, or the whole table's if it lists nothing for that provider, in the reservation and in what's settled.
  `agent.key.models` keeps such a model's prices null, so a client can say it has no listed price. A model a table
  lists at `input` 0 and `output` 0, in either length tier, is one it doesn't list: a table never makes a model free,
  and one with nothing else priced isn't taken.
- A refusal writes a `limit.hit` row and turns the manager's status to `limit_reached` until a call fits again.
- **What fails where (task 07's ask 3):** `ManagerAgent.start`, which `agent.message.send` calls, throws only for
  `no_key`, `busy` and `limit_reached`, all before anything is sent or added to the thread. Everything later ends the
  run: `done`; `stopped` when the member stopped it; `failed` with `error` `provider_error` and the provider's error
  kind in `errorDetail` (`auth` also turns the status to `error`); or `failed` with `unavailable` and a word when
  desk-agent couldn't make or record the call (no adapter for the provider, the records failing).

## Audit log (design 9.11, ADR 0019)
- `audit.db`, table `audit`: `seq`, `at_ms`, `actor` (`user`, `system`, `support`, `agent:<id>`, `desk:<id>`),
  `action`, `target` (ids only, 256 chars, no control characters), `payload_sha256`, `decision`, `cost_microusd`,
  `prev_hash`, `hash`. Never a prompt, a reply or a key.
- What's recorded now: `service.start`, `service.stop`, `key.add`, `key.drop` (`not_held` for a deleted key that
  wasn't in RAM), `key.restore` (one per start with any key: target `keys:all`, decision
  `restored:<n>:unreadable:<n>`), `usage.orphaned`, `run.interrupted`,
  `limits.set` and `limits.timezone` (a zone set alone; actor `user`), `limit.hit`, and one
  `llm.call` per call that went out (the key's use: target `key:<id> model:<provider>/<model>`, decision `ok` or
  `error:<kind>`, the payload hash over model, instructions and thread). Tool calls, approvals, support sessions and
  grants come with tools. `agent.audit.list` pages it newest first, with the chain's head.
- **The chain:** `hash = SHA-256(prev_hash || encoding)`, starting from 32 zero bytes. The encoding is big-endian:
  u64 `seq`, u64 `at_ms`, then `actor`, `action` and `target` each as u32 length and UTF-8, u8 payload-hash length
  (0 or 32) and its bytes, `decision` as u32 length and UTF-8, then u8 1 and i64 cost, or u8 0.
  `AuditLogTest.theHashIsTheDocumentedEncoding` computes it by hand.
- **Append-only, kept a year:** triggers refuse every UPDATE, and every DELETE except of the oldest row once it's over
  365 days old and isn't the newest. At each start, rows past 366 days go, oldest first. The first row left keeps
  its `prev_hash`, so `AuditLog.verify` checks the chain from there. Root can still rewrite the file and its chain;
  anchoring the head in Platform (design 9.11, "Later") is what would show that.
- With the log not open, the gateway sends nothing (fail closed).

## Footprint
Three sets, kept apart. Only the box's are on desk hardware, and even those had no Browser stream running beside them.
All are milestone 2: the agent socket open, `agent.db` open, the JDK's HTTP client built. Milestone 1's are at the
end, for comparison.

**arm64, the test box: c7g.large, the size of the owner's desk, in the container as `run` starts it**
(`test-on-box.sh` on `39b1335`, 2026-11-06, Docker 26.1.5, box load 0.0 before and 0.3 after, nothing else running
on it). The build took 26 s, its AppCDS training went through the agent socket, a key, an answer, a limit and the
audit chain with SQLite's aarch64 library, and the image is 386 MB. Five runs:

| `docker run` to the ready line | Ready, desk-agent's own | RSS at ready | Anon / file | CPU ticks to ready | Idle, 5 s | cgroup | `docker stop` |
|---|---|---|---|---|---|---|---|
| 650 to 691 ms, median 681 | 530 to 540 ms, median 540 | 105 MiB | 82 to 83 / 22 MiB | 67 to 68 | 0 ticks, RSS flat | 84.2 to 84.6 MiB | 0.4 s, exit 143 |

Health answered 200 every time, as uid 1103 with `/` read-only and `/tmp` a `noexec` tmpfs, and `agent.list` over the
agent socket answered with the manager, from inside the container as uid 1103. The run removed all it made
(`test-image: cleanup: 0 of 20 images and containers this made are left`), the S3 object and the box's temporary
directory, and stopped the box, which had been stopped. RSS is about 1.3 times x86_64's, as deskd's is. The answer
path wasn't measured there, as nothing on the box speaks HTTP like a provider; on x86_64 it adds 2 MiB, and 10 more
over 200 answers.

**x86_64, this build machine, no container** (`scripts/measure.sh`, 2026-11-06, Temurin 21.0.13, `jvm.options` as
shipped with the trained 20.8 MB archive, under the build lock at load average 2.6 before and 2.0 after, eight
runs). Ticks are 10 ms of CPU from `/proc`:

| Ready | Health answering | RSS at ready | Anon / file | CPU ticks to ready | Idle, 5 s | SIGTERM to exit |
|---|---|---|---|---|---|---|
| 330 to 380 ms, median 350 | 286 to 326 ms from launch | 80 to 82 MiB | 57 / 24 MiB | 50 to 55, median 51 | 0 to 1 ticks, RSS flat | 330 to 344 ms |

The answer path (`FootprintProbe`: the real application driven through its agent socket, a key, a binding, then
answers through the real Anthropic adapter against a fake HTTP server on loopback), three runs: RSS 84 MiB at ready,
86 after the first answer, which took 57 to 63 ms and 6 or 7 ticks, and 94 after 200 more, at about 57 ms each end
to end. Milestone 1's path, three SQLite commits and no HTTP, took 5 ms; where the rest goes now isn't broken down.

**x86_64, a build server (an EPYC with Docker 28.5), in the container.** Not desk numbers: it
proves the Dockerfile and the container on a real Docker. `test-image.sh`, three runs: the build took 39 s with the
training in it, image 364 MB. Ready 590 to 600 ms by desk-agent's own line, 1.44 to 1.46 s from `docker run` to that
line through SSH; RSS 78 MiB at ready and after 5 s idle (anon 54, file 24), 100 to 104 ticks to ready, 0 idle; the
container's cgroup counted 56 MiB; `docker stop` 0.7 s, exit 143. Health 200 and `agent.list` over the agent socket
as uid 1103, with `/` read-only and `/tmp` a `tmpfs` mounted `noexec`, which is why SQLite's library is extracted at
build.

**Milestone 1, for comparison** (no agent socket, no HTTP client): the box, eight runs, ready 450 to 490 ms (median
465), RSS 94 MiB (73 anon, 21 file), 54 to 59 ticks, image 380 MB; this machine, ready median 255 ms, RSS 69 MiB, 39 to
42 ticks; the build server, ready 460 to 540 ms, RSS 68 MiB. So the agent socket, `agent.db` and the JDK's HTTP client added
about 11 MiB and 75 ms at ready on the box, and the trained archive grew from 14.8 to 20.8 MB here.

**Against the design:** design 9.8 estimated 200 to 400 MB for a Node runtime and gave it `MemoryMax=768M`; ADR 0040
estimated +200 to 400 MB per desk for Java. desk-agent idles at 105 MiB on the c7g.large and 82 on x86_64, so `run`
caps it at 320 MiB, which is `jvm.options`' worst case with room. TLS sessions to a real provider weren't measured:
the fake speaks plain HTTP on loopback. deskd is 116 MiB after a session on a c7g.large, so on the 4 GiB desk the two
services together are about 220 MiB. Spring AI would add about 50 MiB and 350 ms to the first call
(`spikes/spring-ai-footprint/`).

### Footprint, many agents (task 49)
**Setup.** `scripts/measure.sh team 3` on a build box (x86_64, 32 CPUs, Temurin 21.0.13, 2026-11-08, no container), three
repetitions, each a fresh JVM: the real jar unpacked as the image has it, `jvm.options` as shipped and the trained
archive. `TeamFootprintProbe` (a main, like `FootprintProbe`) drives the real application through its agent socket:
`desk.account.set` with `tier: {agentCap: 100}`, one key, then `agent.create` and `agent.bind` for each agent, so each
has its row, its binding and its workspace folder (100 in all with the lead, which is the cap: 99 made). It reads
`/proc/self` after a 4 s settle, and the CPU ticks (10 ms each, user plus system, every thread, the timers thread
included) over 10 s with every agent idle. The runs come after the 100 agents exist, the worst case: each streams
about 4 KB (50 pieces) from the fake provider over about a second, and RSS is polled every 10 ms for the peak. The tool
run is one reply of three `workspace_write` calls of 2 KB each, then an answer. The fake provider and the socket client
share the process, as in `FootprintProbe`, so these numbers lean a little high. Box load: 1.4 (1 min) before the first
repetition and 0.7 after; ten minutes of this probe is the only load it added.

**Idle agents.** Medians, with the range over the three in brackets when it moved:

| Agents (with the lead) | RSS | Anon | CPU ticks to make them, in total | Idle CPU, 10 s |
|---|---|---|---|---|
| 1 (at ready) | 84 MiB | 59 MiB | 64 (63 to 70) | |
| 2 | 86 (86 to 87) | 61 | 74 | 1 tick (0 to 2) |
| 11 | 88 | 63 | 93 | 1 (0 to 1) |
| 51 | 90 | 65 | 132 (129 to 135) | 0 (0 to 1) |
| 100 | 91 | 66 | 181 (173 to 184) | 0 (0 to 1) |

An idle agent costs about 0.07 MiB of RSS (7 MiB for 99; where it goes isn't broken down) and about 1.1 ticks to make (create, bind, workspace folder). The timers thread, which wakes for the next
fire, added nothing measurable: 0 or 1 tick in 10 s with 100 agents, the same as with 2. 100 workspaces were 100 empty
folders (4 KiB each on disk; quotas are ceilings, not allocations).

**Runs.** Medians over three, against 100 agents (against 5 agents in brackets); "peak" is the polled RSS, "base"
the RSS just before:

| At once | Base RSS | Peak RSS | After, 4 s later | CPU ticks per run | End to end |
|---|---|---|---|---|---|
| 1 run | 91 (87) | 92 (89) | 92 (89) | 17 (25) | 1.16 s |
| 2 runs | 92 (90) | 93 (91) | 93 (91) | 9 (14) | 1.15 s |
| 4 runs (the cap) | 93 (91) | 96 (95) | 94 (94) | 6.5 (7) | 1.17 s |
| 1 tool run, 3 writes | 94 (95) | 94 (95) | 94 (95) | 9 (9) | 1.10 s |

All times are mostly the fake's 20 ms pause between pieces. Ticks per run include the run's share of the fake provider
and the client in the same process, and the first run on a fresh JVM pays class loading and the JIT (17 to 25 ticks
against 6 to 9 once warm). RSS only grows: it does not fall back after a run (the heap pages stay), so "after" is the
new floor. Each of four runs at once added about 1 MiB of peak, 5 MiB over the idle desk in all, and the whole
test (100 agents, 4 runs, a tool loop) ended at 94 MiB RSS, 66 MiB anon.

**What this says.**
- Memory does not set the cap. A hundred idle agents cost 7 MiB on top of the 84 MiB at ready, and what bounds the
  heap is the four runs at once (`TierCaps.RUNS_AT_ONCE`), not the agents: peak was 96 MiB against the 320 MiB container
  (`jvm.options`' own worst case is about 300 MiB). Real runs hold bigger requests
  than the fake's (up to 100 messages, about 2 MiB of UTF-16 at 200k tokens, twice over while built, so up to
  16 MiB for four), which fits in the 96 MiB heap; TLS and real context sizes were not measured.
- CPU does not either: idle, no measurable cost; a run is about 6 to 9 ticks (60 to 90 ms of CPU) over its second of
  streaming.
- So an agent is a database row and a workspace folder, and the cap is a question for the **disk** (the workspace quota
  times the cap: 200 MB x 24 was 4.8 GB if every agent filled it, at the first pass's defaults; Alliance's default is now 50 MB, and the quotas together may not pass half of `/data`, so the desk's disk matters, not its RAM) and for the
  **member's spending** (every agent has its own limits and the desk's day and month caps still apply) and for what a
  member can keep track of in the Agent app.

**Recommended default caps.** The numbers support at least the current ones and allow much more; so these are about
disk and people, not memory. (As measured in the first pass; the tiers now ship as **Alliance 10, Officer 32, Founder 50**, with the budget above bounding the disk.) The first pass recommended Alliance 8 (1.6 GB of workspaces at a 200 MB quota), Officer 24 (4.8 GB at most) and Founder 50, so the tier differs: 10 GB at most at the default quota (the cap times the quota, and a member lowering
quotas lowers it), 91 MiB or so of RSS. `TierCaps` accepts up to 100, and nothing measured here breaks at 100; the
Platform sets the tier's real value in `desk.account.set`, so this is a default, not a limit in code.

## Release rules
- The Dockerfile follows deskd's: bases by digest (the same two, so a desk shares their layers), no BuildKit-only
  syntax, Spring's unpacked layout, version from a build arg into `/app/desk-agent.properties`.
- **SQLite's native library is extracted at build** for the build machine's architecture (`uname -m`, so `aarch64` on
  the box) into `/app/native`, and `jvm.options` points sqlite-jdbc there. Otherwise sqlite-jdbc extracts it into
  `/tmp` at every start, and in the container `/tmp` is a tmpfs Docker mounts `noexec`, where it can't be loaded.
  The training fails if sqlite-jdbc extracted anything, and `test-release-scripts.sh` checks the entrypoint's
  `/tmp` stays empty. The sqlite-jdbc jar carries every platform's library (12 MB of the image); trimming it is
  possible and not done.
- **The training is the real desk-agent** driven through its agent socket as deskd will: health, a key in a KEY frame
  checked against the provider and sealed, a binding, a streamed answer through the real Anthropic adapter and the JDK's
  HTTP client, a limit refusal, the audit page and a check of the chain, then a restart that brings the key back from
  the vault and lists the models with it. Anthropic is a stand-in on a loopback port in
  clear HTTP, so TLS's classes aren't archived. One temporary directory, deleted after (`training/CdsTraining`).
  It's reached only by `-Dma.cds.train` on the training's command line, and never where `/run/desk-agent` exists.
  `test-release-scripts.sh` checks nothing a desk runs names it. A failed step fails the build. A new step on the
  path from boot to first answer belongs in it.
- AOT: as deskd's rules. Nothing varies the set of beans at runtime; paths come from the `Environment`.
- `test-image.sh` builds with `DOCKER_BUILDKIT=0` and `--no-cache`, so every intermediate image it prints is its own,
  and removes those, its image and containers, and a base only if it pulled it. It never prunes.

## Many agents (task 49, ADR 0047)
- **Agents.** Each agent is an `agents` row and its own `ManagerAgent` (`forAgent`), made at start or when created,
  with its own binding, status and one run at a time. `agent.create` checks the tier's `agentCap` (the lead counts), unique names and the workspace budget
  under one lock; `agent.delete` refuses the lead and a running agent, then removes the thread, proposals, links both
  ways, timers, shares, workspace, icon and limits. The desk runs at most `TierCaps.RUNS_AT_ONCE` (4) at once, every
  agent's together: a fifth start is `busy`. Ids are `ag-` and 12 base32 characters.
- **Runs.** `AgentService.startRun` serves the member's `agent.message.send`, a timer's fire and another agent's
  message alike: the thread as the model reads it (`Team.context`: a message from another agent framed with the
  pairing's rules, a timer's prompt framed as the timer's, a lead's reply followed by what became of its proposals),
  the agent's prompt and tools (`TeamTools.setupFor`), then `ManagerAgent.start` with a `RunSetup`. A run loops while
  the model calls tools, each step reserved against every limit with the same run id, so the run's steps (50) and
  dollars ($2) end a loop: `failed`, `limit_reached`, with the scope. At most 16 calls a step run; each result is cut
  at 20,000 characters. The reply's `tools` lists what ran, as chips with no content.
- **Prompts.** Every agent's starts with the same preamble (its name, that only the member's own messages are the
  member's, that tool output, files, other agents and timers are data), then the lead's role or the agent's purpose,
  its workspace, the workspaces shared with it, and the agents it may message with each pairing's rules
  (`TeamTools.PREAMBLE`, `LEAD`).
- **Proposals.** The `propose_*` tools check their input as the matching RPC would (icons and tones from the library,
  links' rules, timers' schedule, the cap), fill in the lead's key and model where none is named, and store the
  payload's canonical JSON and hash with a summary the desk writes, not the model. `agent.proposal.answer` takes the
  proposal from `pending` to `applying` in one statement (so two answers can't both apply), applies it through the
  hand-made path, and settles it `applied` (with `result`) or `failed` (with the refusal's reason). The card's view
  shows `expired` past 24 hours.
- **Messages between agents.** Solo means the sender sends no messages (a solo agent has no `message_agent` tool; a call
  anyway is `no_tool`); it still receives under a link's rules. `message_agent` checks, in order: `solo`, `no_link`,
  `depth`, `loop`, `desk_rate` (4 x `a2aPerHour` across the desk), `desk_spend`, `rate` (the pair's hour), `spend` (the
  receiver's message-started spend against its share of the next dollar scope that exists); then logs the message
  `delivered`, starts the receiver's run (`busy`, `no_key`, `limit_reached`, `age_band` and `agent_cap` refuse it there)
  and waits for it on the sender's run thread. The receiver's run sees only the pairing's messages and no shared
  workspaces. Every refusal is logged (`bad_text`, `unknown_agent`, `self`, `internal` too), and after 3 refused calls in
  a row the tool closes for the run. A stop of the sender stops the receiver. The log row ends `replied` with the reply
  (8,000 characters at most) and the receiver run's cost, or `failed`. The log is pruned daily at 100 days.
- **Timers.** `Timers` keeps them in `agent.db` and one virtual thread sleeps until the soonest (a minute at most).
  A fire starts a run with the timer's origin; `busy` retries a minute later up to ten times; `no_key` and
  `limit_reached` are kept as `lastState`. A run's end sets `ok` or `failed` and adds its cost. At start, one-shot
  timers missed by over a day end `missed`, and repeating ones skip ahead. While the member's band isn't adult, due timers wait (`paused`). At fire, an interval under the tier's minimum runs at the minimum and timers over `timersPerAgent` get `over_cap`. Timer and message-started runs stop at 3 of the 4 run slots. Day-and-time timers follow a changed zone.
- **Workspaces and icons.** `workspace/Workspaces` (above) under `<dataDir>/workspaces/`, with a free-space floor of 1.5
  GiB and a budget (all quotas together at most 50% of `/data`); the agent's quota is stored at create (its own `workspace_mb` or what the tier's `workspaceMb` and the budget allow) and held to `workspaceMaxMb` at use. Uploaded icons are `PngMark` masks in
  `<dataDir>/icons/<agentId>.png`, written atomically, with a version the client caches by.
- **Tier settings.** `desk.account.set` may carry `tier` (`agentCap`, `workspaceMb`, `workspaceMaxMb`,
  `timersPerAgent`, `timerMinMinutes`, `a2aPerHour`, `a2aDepth`, `a2aSpendPct`), from the Platform's config through
  deskd; a value missing or out of range takes `TierCaps.DEFAULTS`' (Alliance's) alone, and a missing tier keeps the last one received. `band` (`adult`, `teen`, `unknown`) also comes in `desk.account.set`; when it stops being `adult`, every run of the owner's agents already going stops (its reply `stopped`), and while it isn't, no run of the owner's starts, whoever asks (`age_band`; Security's `T49K-2`). A guild member's own agent goes by that member's flag. Agents over `agentCap` (oldest kept, the lead never counted out) are `paused`, never deleted.
- **Audit.** New actions: `agent.create`, `agent.update`, `agent.delete`, `links.set`, `workspace.share`,
  `workspace.delete`, `icon.upload`, `timer.set`, `timer.delete`, `timer.fire`, `a2a.send`, `proposal.make`,
  `proposal.answer`. Targets are ids only.
- **Rollback.** `agent.db` keeps `user_version` 1, so an older desk-agent opens it, lists staff agents and refuses to
  run them (`not_found`); the new tables are ignored.

## Not built
- Google's adapter (Phase 2).
- Approvals for destructive or egress tools (none exist yet), taint, durable runs that resume (ADR 0020's state
  machine), memory and compaction, image generation, the usage report to Platform, and a signed `pricing.json`.
- Timers that wake a stopped desk (they fire while desk-agent runs), browser and notebook tools for agents, and
  agents deleting workspace files.
- The egress proxy (deskd's), which `DESK_AGENT_EGRESS_PROXY` will name.
