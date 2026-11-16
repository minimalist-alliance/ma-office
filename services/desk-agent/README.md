# desk-agent

The runtime behind the desk's Agent app (design section 9): a Java 21 Spring Boot service in Docker on each desk, in
`deskd`'s style (ADR 0040). It runs the desk's agents, calls the member's LLM provider with the member's own key,
enforces the usage limits and keeps the audit log. It keeps keys sealed on the desk's own disk, and in RAM while it runs
(ADR 0042). A client reaches it only through deskd,
which relays task 07's `agent.*` interface over a local socket. The Agent window's UI is task 07's; this is the
backend.

**State: milestone 2.** desk-agent serves all of task 07's `agent.*` methods and topics on its agent socket, and talks
to Anthropic (Messages API), OpenAI and xAI (Responses API), and OpenRouter, Google (Gemini) and Moonshot AI (Kimi)
(Chat Completions) with thin adapters on the
JDK's HTTP client, streamed. They are tested against a local stand-in only: no real key has touched them. deskd
relays the interface to it (`services/deskd`, package `agent`, `API.md` section 11, from `sub/deskd-agent-relay`), and the image gives it its unit,
directories and egress rule (`image/README.md`, "desk-agent", from `sub/desk-agent-image`). Its first release,
`2026.11.06-60828be`, is baked into the image from 0.2.7 (task 42), so every new desk runs it. No tools yet: see "Not built".
`STATUS.md` in this folder has the questions and what the weekend lead can ship.

**Task 49, many agents (ADR 0047, `sub/multi-agent`, merged to main, in no release yet).** A desk holds many agents, up to its
tier's cap; the manager is the **lead**, which sets the others up with the member through proposals the member
confirms; agents have tools on every provider (their workspace, messages to linked agents, and the lead's), opt-in
messaging with hard limits, a workspace and timers each. The client's interface is `docs/multi-agent.md`; "Many
agents" below is how it works here. **S-14, memory** (`sub/agent-launch-left`): agents remember across conversations
and long threads are summarized; "Memory" below.

## A guild desk (task 48)
deskd adds the verified caller to every `req`, KEY frame and `sub` (`service/Caller`: `owner`, `guild_member` or deskd's own `system`; none means the owner, and a malformed one is `forbidden`, `reason: caller`). On a guild desk each member has one agent of their own, whose id is their member id, made the first time they look, and sees and uses only it: any other agent is `not_found`, and the Founder's view has no member's thread (draft decision 6). Its calls reserve against `service/GuildLimits`, from deskd's `desk.guild.set`: the member's dollars a day and month as the agent's, and the guild's month as the desk's, so both bind; runs a day (`member_runs_day`) and runs at once across the guild (`guild_runs`) are checked before a run starts. A teen member is refused (`age_band`), the guild's keys, limits and audit need `manage_agents`, and `agent.guild.usage` (each member's runs and spend, counts only) the Founder's or an Officer's role. `agent.state` has one view per member, the owner's and deskd's own (`AgentService.hubTopic`). No schema change: a member agent is a `manager` row whose id is a member id. A member who leaves is purged by deskd's `desk.member.purge` (ADR 0080's addendum of 2026-11-10, `docs/proposals.md` §5): their agent, thread, files' notes, limits and staged files go, their usage stays only as the guild's (`guild:departed`), and every SQLite file is opened with `secure_delete`, its WAL emptied after a purge. deskd's `API.md` §15 has the client's side.
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
| `socket` | `AgentSocketServer`: the agent socket, deskd's only way in (`docs/proposals.md` section 5), and desk-agent's way to the tools deskd runs (`tcall`, after deskd's hello). `PeerCheck`: deskd's uid only, by `SO_PEERCRED` |
| `service` | `AgentService`: every `agent.*` method, and the `agent.state` and `agent.conversation:<agentId>` topics. `TopicHub` (snapshot then events, in order, per subscription), `Deltas` (text deltas at 30 Hz at most), `RpcError` (deskd's codes) |
| `store` | `AgentStore`: `agent.db`, with the agents, their threads, key metadata (never keys) and the desk's limits. `TeamSchema`: task 49's tables and columns, additive, applied at every open, with `user_version` still 1. `TeamStore`: their rows (each agent's look, purpose, solo flag, quota and shares; links; proposals; the agent-message log; timers) |
| `team` | Task 49 (ADR 0047). `Team`: every new `agent.*` method of `docs/multi-agent.md`, the agent view's new fields, proposals and their answers, and `Host`, the way back into `AgentService` for runs a timer or another agent starts. `TeamTools`: each run's system prompt and tools, and the tools themselves (`message_agent` with its limits, the lead's `desk_*` and `propose_*`). `Timers`: the timers' RPCs and the thread that fires them. `Schedule`: the next fire in the member's zone. `TierCaps`: the tier's values from `desk.account.set`, with Alliance's as the defaults (the last tier and band are kept in `agent.db`). `Canonical`: a proposal's canonical JSON and SHA-256, as the Agent app computes them |
| `provider` | `ChatProvider`, the interface every adapter implements, and its values: `ChatRequest`, `ChatResult`, `Usage`, `DeltaSink`, `ProviderId`, `ProviderInfo`, `ModelInfo`, `ProviderException`. `ProviderRegistry` |
| `provider.anthropic` | `AnthropicProvider`: Messages API, streamed, and the model list that checks a key |
| `provider.openai` | `OpenAiResponsesProvider`: Responses API, streamed, with `store: false`. OpenAI's and xAI's, which serve the same API |
| `provider.openrouter` | `OpenRouterProvider`: OpenRouter's Chat Completions, streamed, its key check (`/api/v1/key`) and its free models from the public catalog ("OpenRouter", below) |
| `provider.chat` | `ChatCompletions`: the OpenAI-compatible Chat Completions shape the three share, a thread as `messages` (with and without tools) and the stream read back, usage and stream errors. `ChatCompletionsProvider`: Google's and Moonshot AI's own endpoints ("Google and Moonshot AI", below) |
| `provider.http` | `HttpTransport` (the one HTTP/1.1 client, the idle watchdog JDK 21 lacks, https-or-loopback base URLs), `SseReader` (bounded server-sent events), `Messages` |
| `key` | `KeyVault` (keys sealed at rest in `/data/agent/keys`), `KeyRing` (keys in RAM, in direct buffers, zeroed on drop) and `KeyLease` (one call's heap copy, zeroed on close) |
| `limits` | `UsageLedger` (SQLite: reserve, settle, release, keep, and each scope's use, in the member's zone), `LimitSettings` (the agent's scopes per agent, the desk's once, and the layers of ADR 0043), `PriceTable` (the table in use, swapped whole), `Pricing` (one table, and what an unlisted model counts at), `LimitPolicy`, `Limit`, `Scope`, `LimitReachedException` |
| `audit` | `AuditLog`: append-only, hash-chained, in its own SQLite file |
| `llm` | `LlmGateway`: the only way to a model. `reserve` (every check and the limits, nothing sent), then `complete` (lend the key, call, settle, audit) |
| `manager` | `ManagerAgent`: one per agent since task 49 (`forAgent`), with the tool loop (`RunSetup`, `Tools`). Dormant until bound to a key it holds, one run at a time, badge on every answer. `start` refuses only `no_key`, `busy` and `limit_reached`; the `Run` then ends `done`, `stopped` or `failed` on its own thread |
| `attach` | Files on a message (ADR 0049). `Staging`: files being attached, in memory only, 10 minutes, zeroed. `Caps`: the owner's limits within ceilings. `Sniff`: what a file is, by content. `Preparer`: staged files to attachments, applying the caps. `Parsers` and `worker/*` (`ParseWorker`, `ParseRequest`, `Input`, `PdfText`, `OfficeText`, `PlainText`): reading in the parse sidecar (ADR 0097), or in a child JVM on an image without one, one at a time. `Vision`: which models take pictures. `ImageBudget`: picture bytes with model calls at once. `AttachException`: a reason word, a file's name, a limit, never content. `provider.Attachment` is what a run holds and wipes |
| `sqlite` | `SqliteDatabase`: one file, one platform thread, WAL, migrations by `user_version` |
| `json` | `Json`, a copy of deskd's jackson-jr helper |
| `icon` | `PngMark`: an uploaded icon decoded as a strict, real PNG with `java.util.zip` only (no ImageIO, no AWT) and re-encoded as a new gray+alpha mask with no metadata (`docs/multi-agent.md` section 7). `IconException`: `not_png`, `too_large`, `too_many_pixels`, `corrupt`, `no_shape`, `too_thin`, never any content. The mask is trimmed and centred in a square (section 7 of the doc) |
| `memory` | S-14. `Memories`: what an agent remembers (`memory_save`, `memory_forget`, the pinned block, `agent.memory.*`, the line's checks, the run's taint from memory). `MemoryStore`: the `memories` and `thread_summaries` rows. `Compactor`: what a run sends of a long thread, and the summary that folds the rest |
| `tool` | The shared interface of the tools and approvals (draft ADR "the Agent's tools and approvals", §11): `ToolDecl` (one tool, declared in code: wire name, the card's `words`, schema, one narrow scope, `Risk`, `Taint`s, host), `Risk` (`read`, `own`, `write`, `delete`, `send`, `spend`, `egress`; a call's class rises, never falls), `Taint` (`U`, `S`), `RunContext` (one run: its owner, origin, reply and grow-only flags, passed on to the run upstream that reads its reply), `Classified` (a call as the policy saw it, with its card's title and an optional refusal before asking), `ToolPolicy`. The tools themselves ("Tools" below): `ToolRegistry` (every declaration), `RegistryPolicy` (the policy in use), `Schemas`, `AgentTools` (the launch tools around each run's own), `DeskLink` (to the tools deskd runs), `Plans` |
| `run` | Durable runs (Design 1, Phase 0): `RunRecords` (what a run writes down as it goes) and `RunCalls`, the desk's: a `run_calls` row for each call before it's sent (`store.RunSchema`, `store.RunCallStore`; ids, names, classes and one-word states only), its key for deskd, each step's reply text and chips; `RunCheckpoints` (each step's plan, verdicts and results, the start context and the run's book, in `runs`, `run_steps` and `run_results` through `store.RunStore`, and what a restart reads back), `Resume` (where a run picks up), `RunWaits` and `Waits` (a call's wait on something outside the run, kept in `run_waits`); at open, what a kill left resumes or ends (below, "Restarts") |
| `approval` | `Approvals`, the `ApprovalGate`: a step's calls that need the member wait here, the `approvals` and `run_marks` rows (`ApprovalStore`, `store.ApprovalSchema`), `agent.approvals.list`, `agent.approval.get`, `agent.approval.decide`, the `approval` event, the caps, expiry and the restart sweep. `Verdict`: what a call came to (`Auto`, `Approved`, `Declined`, `Expired`, `Refused`) |
| `workspace` | `Workspaces`: a folder per agent under `<dataDir>/workspaces/` (section 5), with quotas, a cached use (every file and folder counts at least 4 KiB), 10,000 files, 2,000 folders, 1 MiB a write and a free-space floor of 1.5 GiB. Files with more than one hard link are refused. Paths are walked a component at a time with links never followed; a link at a file's name is replaced on write; `deleteAll` and `remove` delete links, not what they point at. `WorkspaceException`: `path`, `not_found`, `quota`, `not_text`, `too_large`, `disk_low`, `disk_budget`, `too_many_files`, `too_many_folders`. Wired in through `team.Team` (task 49); the class comment lists the limits that remain (hard links, a swap between check and use) |
| `training` | `CdsTraining`, the AppCDS training run, with `TrainingAnthropic` (a stand-in on a loopback port) and `TrainingClient` (the socket's client side). Nothing else refers to it |

Tests use stand-ins on real sockets: `FakeLlmServer` (Anthropic's and OpenAI's APIs on the JDK's HTTP server, every
request recorded), `FakeOpenRouter` (OpenRouter's key check, catalog and Chat Completions, with scripted refusals and
headers), `AgentSocketClient` (deskd's side of the agent socket, KEY frames included) and a scripted
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
| `DESK_AGENT_ANTHROPIC_URL`, `DESK_AGENT_OPENAI_URL`, `DESK_AGENT_XAI_URL`, `DESK_AGENT_OPENROUTER_URL`, `DESK_AGENT_GOOGLE_URL`, `DESK_AGENT_MOONSHOT_URL` | `https://api.anthropic.com`, `https://api.openai.com`, `https://api.x.ai`, `https://openrouter.ai`, `https://generativelanguage.googleapis.com/v1beta/openai`, `https://api.moonshot.ai/v1` | Base URLs: `https`, or `http` only to loopback, so a key never goes anywhere else in clear text. OpenRouter's paths are under `/api/v1` of its URL; Google's and Moonshot's are the Chat Completions base itself. `off` for Google or Moonshot leaves that provider out (a kill switch) |
| `DESK_AGENT_EGRESS_PROXY` | none | deskd's egress proxy (design 9.8) as `host:port`, once it exists |
| `DESK_AGENT_VERSION` | From `/app/desk-agent.properties`, which the image writes from its `VERSION` build arg | `/health`'s `version`. Leave it unset |
| `DESK_AGENT_PARSE_DIR` | `/run/desk-parse` | The parse sidecar's directory (ADR 0097): its marker `required` and its socket `sock/parse.sock`. Once either has been seen, documents are read there and never in desk-agent's own child; `run` mounts it read-only only where the image made it |
| `DESK_AGENT_MAIA` | none | `on` lists this desk for Desk Maia, as `<dataDir>/maia-switch` saying `on` does; `off` turns it off at once (the kill switch), and `off` wins. Unset, with no file saying `on`, the desk refuses Desk Maia (`not_listed`; deskd `API.md` §23) |

A new setting goes in `docker/desk-agent.env` too, which `test-release-scripts.sh` checks. `/health` answers
`{"status", "version", "data", "audit", "usage", "agents", "deskd", "manager", "keys", "parse"}`: whether deskd is
connected, the manager's status, the number of keys held and `parse` (`sidecar` or `child`, ADR 0097) are
informational. Where the sidecar's marker exists, the image's smoke test requires `parse: sidecar`.

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
  with `provider_error` and the kind, or `unavailable`. Each call sends the thread's summary and the newest messages
  after it, within a budget ("Memory", below).
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
  loosely. OpenRouter's free models are $0 by their id, not by the table (Limits, below).

## Maia Mode: Desk Maia (Phase 1, `sub/mm-maia-runtime`)
Maia Mode's Maia on the member's home desk (the draft ADR [Desk Maia](../../docs/decisions/draft-desk-maia.md); deskd `API.md` §23 is the contract). Support Maia, "Account help", is ma-platform's (`docs/maia.md`) and unchanged. **Dark by default:** nothing here runs until the member turns it on, and only on a listed desk: `<dataDir>/maia-switch` saying `on` (or `DESK_AGENT_MAIA=on`); saying `off` (or `DESK_AGENT_MAIA=off`) turns it off at once. Her chats go at 90 days.

**She runs on Minimalist Alliance's AI service, never a member's key** (the owner, Nov 14: "Maia ALWAYS runs on the company account"; ma-platform `docs/contracts/desk-maia.md`). Her binding is the desk's own: `KeyRing.COMPANY` (`ma-maia`, lent as an empty lease, in no key list), provider `ma` (`ProviderId.MA`, in no `agent.providers` list), task `turn`; it's set when her row is made and at every start, and `agent.bind` for her is `forbidden` `company`. `provider/ma/MaiaServiceProvider` sends each call as one `maia_model` tcall through deskd, which relays it to her service as the desk role (deskd `API.md` §23, "Her model"): the task (`turn`, `step` after tool results, `notes` for the note-taker), the desk's dynamic context and the thread, never a model; files go as a line naming them. Her service picks the model and owns her Maia Mode instructions. `MaiaProfile` sends a **context** that's byte-stable across a session (the choice rule, her desks and grants; memory and the desk's tool rules join it) and a **note** with what changes on every call (the time, her choice weight, briefs left, the member's Maia credits as the service last reported them, never money: what's left of the month's and their renewal, a pace line when today's share is used, top-up credits, the lighter model; without credits the share left; a line for a day cap in credits the member set): the note goes as the contract's `note` (0.4.6), after the thread and outside every cached prefix (`RunSetup.note`, `ChatRequest.note`). **Credits, never money (contract 0.4.8, the owner, Nov 15):** her calls are the company's, so the gateway reserves and settles no dollars for them (no price row, no `costMicroUsd` kept: her reply's cost is null), the ledger leaves them out of the desk's and a key's scopes and counts any dollars on them as none (`UsageLedger.MEMBER_USD`), and no dollar limit of the member's binds her, only her run's step count. Every request asks for credits (`units: "credits"`, contract 0.4.8), so no answer carries `costMicroUsd`. Each answer's `costCredits` is counted a day on the desk (`MaiaMode.creditsSpent`, `maia_counts` kind `credits`) for the one cap of the desk's on her: the member's own `caps.coordinatorDailyCredits` (none by default), which refuses her turns `limit` `limit_cap` once reached (`MaiaServiceProvider.cap`). `coordinatorDailyUsd` is retired. On the member path `AnthropicProvider` caches the thread too: a second breakpoint on its last block (a note, if any, after it). A refusal before the call (`limit`, `rate_limited`, `forbidden`, `bad_request`, `too_large`) settles nothing. After a `429 limit` nothing is sent until it resets, and her reply carries `limit: {reason, window, resetsAt}` for the room's one line. Until deskd's hello offers `maia.model`, her sends are `unavailable` `no_service`; while the desk holds only the v1 disclosure, `precondition_failed` `disclosure` (`MaiaMode.DISCLOSURE` is `maia-mode-v2`). Her memory has her own rules (`memory/MaiaMemory`, Support Maia's: how the member likes answers, how to help, what they've set up, never anything private, checked in code); lines from before that fail the check are never pinned.

| Class (`maia/`) | Holds |
|---|---|
| `MaiaAgent` | Her id, `maia`, and `plain`: another desk's text as the room shows it (one line, hidden and bidi characters out, cut) |
| `MaiaMode` | On, off, the kill switch, the disclosure, her settings and caps, her grants, the list's snoozes, every `agent.maia.*` method, her choices on a reply |
| `MaiaStore` | Her tables in `agent.db` (additive): `maia_grants`, `maia_counts`, `maia_replies`, `maia_notes` (a note's text only while it's held), `maia_pages`, `maia_items`, `maia_todo_jobs`; her settings and choice counts are `settings` rows |
| `Attention` | The list's rules, a pure function: at most 3, one Now, urgency by the fixed rules, merging, batching, typing, the interrupt's rate, templates |
| `Room` | What the office last observed (RAM only), typing, what was shown, the last interrupt and batch, her last show; publishes topic `agent.maia`; one timer for the next moment a rule changes |
| `Choices` | The member's weight for choices (counts only), the asks for more or fewer read in code, the shape of `ask_member`'s choices |
| `MaiaProfile`, `MaiaTools` | Her run's stable context and her note (her instructions are her service's) and her tools; her guard on `desk_message` (`HostedGuard`): a live `brief` grant, her caps, "keeps to itself" (a floor of `send`), `D:` flags for deskd |
| `Notes` | The note-taker (a side call on her service's `notes` task that reads only the member's own messages, its rules as the context), code's checks and routing, filing by code (`CodeCalls`, never a card), the chips, the unsure question |
| `TodoFiler` | To-dos from Courier: `courier_new`, the reader with no tools, code's checks, `todo_add` with a Courier source; once when switched on, then every 30 minutes and at start |
| `TeamView` | `agent.usage.summary`: per agent per day, from the ledger, replies and approvals; each agent's headroom (its limits less the ledger, what a brief from another desk may spend, its usual task), what her briefs cost on this desk (`maiaBriefs`), and on the home desk her briefs across the desks (`maia`) |
| `Wallet` | Her briefs and the member's wallet (Nov 15): the estimate (the answering agent's usual task times the brief's size), the member's daily budget for her briefs, ask line and "Always OK", the guard's hold (`maia_limit` at an agent's own limit, `maia_held` past the budget or for an unusual cost), code's card (`kind: "budget"`) and its taps, her note's money lines, the room's and team view's `briefs`. Never a limit: the desks' caps stay as they are |
| `CodeCalls`, `CodeResults`, `SmallModels` | How her code calls deskd's tools (the policy, `Approvals.admitUnasked`, `AgentTools.codeCall`) and a small job: hers the service's `notes` task, the to-do reader the inbox agent's small model on its own key |

**Helpers on the member's MA credits** (deskd `API.md` §24; ma-platform `desk-helpers.md`, ADR 0142): provider `ma-credits` (`provider/ma/HelperServiceProvider`, one `helpers_model` tcall per call through deskd, task `agent` or `small`, never a model), key `KeyRing.CREDITS` (no key material), model `auto`. Any of the member's own agents may bind it, never Desk Maia (`LlmGateway`); no dollars are kept for it on the desk. It's a first row of `agent.key.list` while deskd offers it, and a new agent with no key goes on it when the member has credits.

**Hooks outside the package**, each small and named: `AgentService` (`MaiaHooks`: her setup, her send's counts and notes, her replies' extras, the topic, `agent.usage.summary`, the undo of a note, refusals for team methods and `agent.desks.answer`; her company binding, the disclosure and `no_service` checks, the `limit` extra, compaction after `too_large`), `KeyRing.COMPANY`, `LlmGateway`'s `ma` path, `DeskLink.maiaModel` and `Reply.details`, `AgentSocketServer`'s hello `maia`, `Memories` (her rules), `Team.teamAgents` and `agentId` (not a team agent), `AgentTools.maia`/`codeCall`, `RegistryPolicy`'s `HostedGuard`, `Approvals.admitUnasked`, `DeskMessages.inRunAnswers`, `ManagerAgent.sideCall(model, …)`, `UsageLedger.daily` and `spendOfRuns`, `Team.briefCap` (`TeamTools.deskCap`, read only), `MaiaHooks.answeringAgent` (her send half's accepted agent), `Memories.cleanNote`, `ToolRegistry` (her declarations) and `ToolDecl.SCOPES` (`office:read`, `office:show`, `maia:self`). Tests: `src/test/.../maia/` (and `eval/`); the real-socket ITs are deskd's `RealDeskAgentMaiaIT` and `RealDeskAgentMaiaBriefsIT`. The evals and the real-model plan: [`docs/maia-evals.md`](docs/maia-evals.md).

## A new agent's model: Sonnet 5.5 by default (2026-11-14)
`agent.key.models` lists a key's models with its default first (deskd `API.md` §11), and the New agent form, the key
screen and a key added or replaced for an agent whose model it doesn't list all take the first. For an Anthropic key
that's `claude-sonnet-5-5` (`AnthropicProvider.DEFAULT_FIRST`; an older Sonnet stands in for a key without it, then the
first model that isn't a Fable model); the rest keep Anthropic's order. Anthropic lists its models newest first, so
before this the newest and dearest one, `claude-fable-5-2`, became every new agent's model: the staging fleet desks'
Leads, and Maia through "Use Lead's key", ran on it from Nov 13 to 14 though the owner had stopped Fable on Nov 11. A
member may still pick a Fable model; it's never the default. The Agent app also passes over an unpriced first model
(`defaultModel`), so an older desk-agent can't land a new agent on it either. Tests:
`AnthropicProviderTest` (`sonnet55IsTheDefaultNotTheNewestModel` and the two after it), web/agent `agents.test.ts`.

## OpenRouter: the $0 first Agent run (2026-11-11)
The owner approved it as a launch feature: a member connects OpenRouter with one click and uses its free models, so
the first agent run needs no card or key anywhere. `OpenRouterProvider`, registered fourth, `openrouter` / "OpenRouter".
- **The key** comes the way every key does: the Agent app runs OpenRouter's PKCE flow in the member's browser and sends
  the key it gets over the desk session with `agent.key.add`, `provider: "openrouter"` (deskd `API.md` §11). It never
  touches the platform 
(TD-66). Pasting one works the same. Its prefix is `sk-or-`, longer than OpenAI's `sk-`, so an
  OpenRouter key picked as OpenAI's is `provider_mismatch` before anything leaves the desk, and so is an OpenAI or
  Anthropic key picked as OpenRouter's.
- **The key check** is `GET /api/v1/key` with the key (OpenRouter's model list is public, so it would prove nothing). A
  401 or 403 is `key_refused`; a management or provisioning key, which makes keys and can't chat, is refused the same.
- **The models:** `agent.key.models` lists OpenRouter's free models only, from its public catalog
  (`GET /api/v1/models`, no key, kept an hour, its `links.next` pages followed on its own host only, 16 MiB at most).
  First come the picks, in order, when the catalog has them: `nvidia/nemotron-3.5-super-vl:free`,
  `cohere/north-mini-code:free`, `nvidia/nemotron-3-ultra-550b-a55b:free` (each answered every request and passed
  every tool call in a public run of all free models from Oct 28 to Nov 6, and was still free); then
  `openrouter/free`, OpenRouter's router across its free models, which never goes away; then the other free models
  that take tools, then those that take none. A client binds the first by default. Free models come and go within
  days, so the list is whatever is free now; with none in the catalog it's `openrouter/free` alone. Each model has
  `free` and `tools`. Paid OpenRouter models aren't listed at launch (STATUS.md).
- **Without tools,** a model still chats. The catalog's `supported_parameters` says which take `tools`. One that takes
  none is sent no tools and no tool turns, and the agent's instructions end with a line saying it has no tools, so it
  answers from the thread, its instructions and its pinned memory alone, and says so when asked for something that
  needs one. It can't use its workspace, message agents, set timers, save or forget memory lines, or (the lead)
  propose changes, and no approval comes up. A long thread is still summarized, which is a plain call. A model the
  catalog lists with tools, for which OpenRouter answers that no endpoint supports tool use, is asked once more
  without them, and remembered until a restart.
- **Requests:** `POST /api/v1/chat/completions` with `model`, `messages` (the instructions as a `system` message, a
  call's turn as `tool_calls`, results as `tool` messages, files as `text` and `image_url` parts), `tools` as
  `function` tools when sent, `max_tokens` and `stream: true`. No app attribution headers, no provider preferences: the
  member's own OpenRouter settings apply. Streamed `delta.content` is the text; `delta.tool_calls` are put together by
  `index`, with an id made up for a call that came without one. `: OPENROUTER PROCESSING` comments keep the 90 s
  watchdog fed.
- **Usage and cost:** the last chunk's `usage`: `prompt_tokens` less `cached_tokens` and `cache_write_tokens` is the
  input, and output is the most of `completion_tokens` and `total_tokens` less the prompt. `usage.cost`, in dollars,
  is `ChatResult.providerMicroUsd`, which `LlmGateway` charges when it's more than the table's price for the usage. A
  stream with no `usage` counts as the gateway estimates, bytes over 3.
- **Errors**, kinds only and never OpenRouter's words (the body is read for them, 64 KiB at most, and kept nowhere):
  the free models' daily limit (50 requests, or 1000 for an account that ever bought 10 credits) is `free_limit`, by
  its `free-models-per-day` message or, on a free model, a 429 whose `X-RateLimit-Limit` is 50 or more with nothing
  remaining; the per-minute limit (20) and a 402 for credits are `rate_limited`; a 404 because the account's privacy
  settings allow no endpoint for the model is `data_policy`; a 403 for moderation is `bad_request`, any other 401 or
  403 `auth`. A failed reply carries them as `provider_error` and `errorDetail`, and the agent stays `online`. An
  error inside a started stream may have been billed, as for every provider.
- **Egress:** desk-agent's name filter (ADR 0070) allows only the names in `/etc/ma/agent-egress.conf`, which is the
  image's. `openrouter.ai` has to be added there before the adapter can reach it on a desk (STATUS.md, the ask).

## Google and Moonshot AI: a member's own keys, direct (2026-11-15)
The owner asked for it (Nov 15): his own Gemini and Kimi keys on a desk agent, not through OpenRouter. Both serve the
OpenAI-compatible Chat Completions API, so one class, `provider/chat/ChatCompletionsProvider`, registered fifth and
sixth with each one's base URL, key prefix and dialect; the thread and the stream are `provider/chat/ChatCompletions`,
which `OpenRouterProvider` shares (moved from `provider.openrouter`, its behaviour unchanged).
- **`google` / "Google":** `https://generativelanguage.googleapis.com/v1beta/openai`, keys from `aistudio.google.com`,
  prefix `AIza`. **`moonshot` / "Moonshot AI":** `https://api.moonshot.ai/v1`, keys from `platform.kimi.ai` (the Kimi
  API Platform), prefix `sk-`, the same as OpenAI's: the longest prefix decides, so a Moonshot key picked as Moonshot's
  or OpenAI's goes on to that provider's check, and an OpenRouter (`sk-or-`) or Anthropic (`sk-ant-`) key picked as
  Moonshot's is `provider_mismatch`. A Gemini key picked as anyone else's is too. OpenAI's own longer prefixes
  (`ProviderInfo.ownPrefixes`: `sk-proj-`, `sk-svcacct-`, `sk-admin-`) also count in the check, so a modern OpenAI key
  picked as Moonshot's never leaves the desk (Security's PC-L1); they aren't sent in `agent.providers`.
- **The key check and the models:** `GET {base}/models` with the key as `Bearer`. 401 or 403 is `key_refused`, and so
  is Gemini's 400 for a key it doesn't know (`API_KEY_INVALID`, its body read for that, possibly as Gemini's
  `[{"error": ...}]`); any other 400 isn't. Gemini's `models/gemini-...` ids are listed without `models/`, as the chat
  endpoint takes them. Models that don't chat (embeddings, speech, live audio, pictures, video, `aqa`) are left out, and
  the provider's family comes first, newest version first, a preview after its version's release (`gemini-4...`, then
  `gemini-3.8...`; `kimi-k3.1...`, then `kimi-k3`), the rest in the provider's order: a client binds the first. Every
  listed model takes tools. Gemini's chat models take pictures (`Vision`); Moonshot's are text only here.
- **Requests:** `POST {base}/chat/completions` with `model`, `messages`, `tools` when the step has any, the output cap
  (`max_tokens` for Gemini, `max_completion_tokens` for Moonshot, whose `max_tokens` is deprecated), `stream: true` and
  `stream_options: {include_usage: true}`. No reasoning effort: both families think by default, so a stream may be quiet
  for 10 minutes before the watchdog ends it. Moonshot's tools say `strict: false`, as it checks schemas strictly by
  default. Tool-call deltas are put together by `index`; without one (Gemini may send each call whole with none), a
  new id, or a name while the last call has one, starts a call. A step of calls that Gemini finishes with `stop` is
  `tool_calls`.
- **What goes back:** Gemini 3 and 4 sign their reasoning and refuse the next step of a turn without the signature, so
  each call's `extra_content` (`google.thought_signature`) is kept on the call (`ToolCall.reasoning`, one `chat_extra`
  item tagged `google`, kept by a run's checkpoint) and sent back on it; a step whose first call has none gets Google's
  documented stand-in, `skip_thought_signature_validator`. Moonshot's thinking models want the step's
  `reasoning_content` back with its calls, so it's kept the same way (at most 512 KiB) and sent on the call's turn,
  with `content: ""` rather than `null` when the step said nothing. Neither goes to any other provider; the Responses
  API's adapter and Maia's service adapter skip these items (`Messages.responsesReasoning`). A plain answer's
  reasoning isn't kept: the thread has no place for it. The shared reader cuts a call's id and name at 128 characters
  and refuses a step whose text passes 8 Mi characters (`UNAVAILABLE`), for every Chat Completions provider.
- **Usage:** the last chunk's top-level `usage`, or the choice's, as Moonshot's older streams had it. Cached input is
  `prompt_tokens_details.cached_tokens` or Moonshot's top-level `cached_tokens`, whichever is more, and comes out of the
  input with `cache_write_tokens`; output is the most of `completion_tokens` and `total_tokens` less the prompt, as
  Gemini counts its thinking only in the total. No usage counts as the gateway estimates.
- **Prices:** neither provider is in `pricing.json` yet, so every call counts at the whole table's highest price
  (ADR 0043) until the Platform's table lists them: a dollar limit binds early, never late.
- **Errors,** kinds only (the body read for them, 64 KiB at most, kept nowhere): 401, 403 and a key 400 are `auth`; 429
  and 402 `rate_limited`; 408 and 504 `timeout`; other 4xx `bad_request`; 5xx `unavailable`. An error object in a
  started stream goes by its numeric code or its words (`rate_limit`, `RESOURCE_EXHAUSTED`, `quota`, `auth`,
  `permission`, `invalid`, `not_found`) and may have been billed.
- **Egress:** `generativelanguage.googleapis.com` and `api.moonshot.ai` are in the image's
  `/etc/ma/agent-egress.conf` from the next bake (ADR 0070's addendum of Nov 15); until a desk has them, a key check
  there is `unavailable`.
- **Tests:** `ChatCompletionsProviderTest` (stand-in `testing/FakeChatServer`: Gemini's stream with usage, its calls
  without index and its signature going back, the stand-in signature, Moonshot's reasoning and top-level cached
  tokens, its older usage, both model lists, refused keys including Gemini's 400, stream errors, a cut stream) and
  `OwnKeyChatSocketTest` (both keys through the real socket: listed, prefix-checked, checked, their models, a bound run).

## Files on a message (S-118, ADR 0049)
The owner's rule: files uploaded to an agent are not retained; as soon as they are processed through the LLM, they are removed. So a file only ever exists in desk-agent's memory.

- **Methods** (deskd relays them): `agent.attach.put {agentId, uploadId, name, size, index, data}` (one chunk of at most 512 KiB, base64, in order), `agent.attach.remove {agentId, uploadId}`, `agent.attach.caps {agentId?}`, `agent.attach.caps.set` (the desk owner's), and `agent.message.send` takes `attachments: [uploadId]` with `text` possibly empty. Refusals are `too_large` or `bad_request` with `details: {reason, name?, limit?}` (the reasons are in `AttachException`), `conflict` + `busy`, and `precondition_failed` + `no_key` before anything is taken (the files stay staged).
- **The path of a file:** chunks into `Staging` (zeroed after 10 minutes, on remove, on send, on stop) → `Preparer` (caps, `Sniff`, the reader for documents; pictures stay as bytes) → an `Attachment` on the user turn of this run's request only → wiped when the run's result completes, or at once if the run is refused. The thread keeps `message_files` (name, type, size, note) and nothing else.
- **Where a document is read (ADR 0049's addendum, ADR 0097).** `Parsers` sends it to the **parse sidecar**: a sandbox on this image with uid 1113, no network, no `/data` and no capabilities, which runs `ParseWorker --from-stream` (`java @/app/parse.options`) once per connection. desk-agent writes `parse1 <kind> <maxChars> <maxPages>` and the file to `/run/desk-parse/sock/parse.sock`, half-closes and reads today's answer, one file at a time within 30 s. **Once it has seen the marker (`/run/desk-parse/required`) or the socket it never starts its own child again in that process.** Then `err busy` is tried again every 50 ms within the 15 s busy window; no socket, a refused connection, `err denied` or any first line that isn't `OK` or `ERR <word>` (`ERR bad_request` included) is `unavailable`; a stream that ends before a line (a worker out of memory or killed) is `too_complex`; the deadline is `timeout`. `unavailable` keeps the RPC code `bad_request`, since the staged files are gone by then. Only where neither has ever been seen (an image before the sidecar) does the in-container child read, as before; it goes with the move to JDK 24. The worker sends the JVM's own output to stderr (discarded), so its stdout is only the answer. The way is logged once and the counts at most hourly, never a name or content. Tests: `ParseRequestTest`, `ParseWorkerStreamTest` (every kind at 20 MiB), `ParsersSidecarTest`, `ParseOptionsTest`, `worker/InputTest`, `worker/PlainTextTest`; for real on Docker, `scripts/test-parse-sidecar.sh`; timing, `scripts/measure-attach.sh --timing-only`; memory by kind and size, `scripts/measure-attach.sh --sizes`.
- **Documents' mode (deskd `API.md` §25), for deskd's sandbox.** `attach/worker/DocsMode` is a `courier-parse` `WorkerMode` (registered in `META-INF/services`), so deskd's Courier sandbox (`java @/app/courier-parse.options`) also answers `docs1 read` (`PdfPages`: a PDF's text page by page with each line's box and its empty signature and form fields; Office files and text through `ParseWorker.read` as a reading view) and `docs1 render` (`PdfRender`: one page as a JPEG, PDFBox's bundled fonts only, at most 4 megapixels). `MiniJson` writes its answers without a library. Tests: `worker/DocsModeTest`, `DocsWorkerProcessTest` (the real worker JVM with the sandbox's flags and security manager: a 100-page read about 0.6 s, a page about 0.55 s on the x86 build box), and `DocsCorpusExport` (`-Ddocs.corpus.out=DIR`) writes the synthetic corpus deskd's corpus run reads.
- **Documents' reader** (`maia/DocReader`, deskd's `desk.docs.read`, never relayed for a client): one tool-less call on Desk Maia's service, task `read`, for a document deskd is about to show; every field checked by code (closed words, a real date, pages that exist, a plain line of at most 90 characters with no link, address, markup or hidden character). Only while Desk Maia is active here. Tests: `DocReaderTest`, `eval/DocReaderInjectionEvalTest` (49 hostile documents), `eval/DocReaderFakeModelEvalTest`, `eval/DocReaderRealModelCheck` (off unless `-Ddocs.reader.real=true`).
- **Documents' write-ups** (`desk.docs.writeups`, deskd's own, never relayed for a client: refused with any caller): the write-ups kept on this desk for Desk Maia's briefs (`desk_writeups`), by cursor, one by id, or the ids kept and those marked readable, so deskd indexes them for the member's Documents; a write-up whose answer held this desk's private data is marked so and never goes to the reader. Test: `socket/DocWriteupsSocketTest`.
- **Files to the 20 MiB ceiling read in the worker's 72 MiB heap,** every kind (the default cap is 8 MiB; the owner can raise it to 20). The worker holds a file once (`worker/Input`): a PDF or a zip in 64 KiB chunks, which PDFBox reads as its `RandomAccessRead` (its streams are views, its stream cache memory only) and the zip readers as a stream from the start each pass; text is decoded as it streams and the rest only counted. It used to end out of memory (`too_complex`) past about 16 MiB, when its input buffer doubled to 32 MiB and was copied. At 20 MiB with `files_read`'s ask, the smallest heap that reads is 24 MiB (text) to 48 MiB (a 500-page text PDF, an xlsx of data rows); what still ends a worker is the parse itself (a content stream that inflates past the heap), or the 120 MiB inflate budget a pass for a zip (`too_complex` either way). The 40 MiB guard stays: past it, `unreadable`. Measured with `scripts/measure-attach.sh --sizes`; numbers in `docs/sub-status/desk-parse-sidecar.md` item 7.
- **A document from Files** (`files_read`) asks for 2,000,000 characters and 500 pages. The sidecar's contract allows exactly that (ADR 0097 section 2), so it is read whole through the sidecar and through the child alike.
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
  takes header values only as strings. It joins the prefix and the key as bytes in an array it zeroes, so a call makes
  one such `String`, not two (ISS-20). That string, held by the request for the call, and the client's own copies on
  the way to TLS, stay in the heap, unreachable, until the collector reuses the memory. Spring AI would hold the key as a `String` for the client's
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
  desk-agent never makes a `String` of one but in `headerValue`. deskd does, as jackson-jr parses the client's JSON,
  but its `rtc.sock` read buffer zeroes what it has handled, its request parse has buffers of its own rather than the
  shared pool's, and its link writes the KEY frame from a direct buffer it zeroes, so NIO keeps no copy (ISS-20,
  `docs/sub-status/iss20-key-zeroing-finding.md`). `scripts/test-release-scripts.sh` fails if anything a desk runs
  turns on the HTTP client's or TLS's logging, which would write the header.
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
- **The one way a model is free** (2026-11-11): its provider serves it free, by its id (`ProviderId.servesFree`:
  OpenRouter's `:free` variants and `openrouter/free`). `Pricing.price` gives `Pricing.FREE`, $0, whatever the table
  says of it, so no dollar limit refuses it; token limits still bind, and `agent.key.models` gives it 0 prices and
  `free: true`. If OpenRouter reports a cost for a call anyway, the gateway charges it (`LlmGateway.complete`: the
  provider's reported cost when it's more than the table's).
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
- **`/app/parse.options`** is the parse sidecar's whole command (ADR 0097): `Parsers.WORKER_FLAGS`, the image's
  classpath, the worker and `--from-stream`. `ParseOptionsTest` compares it with the child's flags, and the
  Dockerfile's last step reads a line through it, so a build whose sidecar can't read fails.
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
- 
**Timers.** `Timers` keeps them 
in `agent.db` and one virtual thread sleeps until the soonest (a minute at most).
  A fire starts a run with the timer's origin; `busy` retries a minute later up to ten times; `no_key` and
  `limit_reached` are kept as `lastState`. A run's end sets `ok` or `failed` and adds its cost. At start, one-shot
  timers missed by over a day end `missed`, and repeating ones skip ahead. While the member's band isn't adult, due timers wait (`paused`). At fire, an interval under the tier's minimum runs at the minimum and timers over `timersPerAgent` get `over_cap`. Timer and message-started runs stop at 3 of the 4 run slots. Day-and-time timers follow a changed zone.
- **Workspaces and icons.** `workspace/Workspaces` (above) under `<dataDir>/workspaces/`, with a free-space floor of 1.5
  GiB and a budget (all quotas together at most 50% of `/data`); the agent's quota is stored at create (its own `workspace_mb` or what the tier's `workspaceMb` and the budget allow) and held to `workspaceMaxMb` at use. Uploaded icons are `PngMark` 
masks in
  `<dataDir>/icons/<agentId>.png`, written atomically, with a version the client caches by.
- **Tier settings.** `desk.account.set` may carry `tier` (`agentCap`, `workspaceMb`, `workspaceMaxMb`,
  `timersPerAgent`, `timerMinMinutes`, `a2aPerHour`, `a2aDepth`, `a2aSpendPct`), from the Platform's config through
  deskd; a value missing or out of range takes `TierCaps.DEFAULTS`' (Alliance's) alone, and a missing tier keeps the last one received. `band` (`adult`, `teen`, `unknown`) also comes in `desk.account.set`; when it stops being `adult`, every run of the owner's agents already going stops (its reply `stopped`), and while it isn't, no run of the owner's starts, whoever asks (`age_band`; Security's `T49K-2`). A guild member's own agent goes by that member's flag. Agents over `agentCap` (oldest kept, the lead never counted out) are `paused`, never deleted.
- **Audit.** New actions: `agent.create`, `agent.update`, `agent.delete`, `links.set`, `workspace.share`,
  `workspace.delete`, `icon.upload`, `timer.set`, `timer.delete`, `timer.fire`, `a2a.send`, `proposal.make`,
  `proposal.answer`. Targets are ids only.
- **Rollback.** `agent.db` keeps `user_version` 1, so an older desk-agent opens it, lists staff agents and refuses to
  run them (`not_found`); the new tables are ignored.

## Memory 
(S-14)
The owner, Nov 11, on tools, approvals and memory at launch: "Yes, all three". Memory is two things: lines an agent
remembers about its member across conversations, and the summary of a thread too long to send whole. Both are per agent,
so on a guild desk per member. In the way of Maia's quiet memory (`ma-platform docs/maia.md` §16).

- **Lines.** `memory_save {text}` keeps one line at once, no card: at most 300 characters, 3 a run, 50 an agent
  (nothing is evicted; a save past it is refused `full`). The same line again is `already`. Refused: a line shaped like a
  secret (password and PIN words, card and account numbers, key-shaped strings), one that reads as an order (Maia's
  `looksLikeInstruction`), hidden or control characters. A desk agent may remember private things, unlike Maia: the desk
  is the member's own. `memory_forget {id}` removes one of its own lines. Every run but one answering another agent gets
  both tools, and its system part ends with the lines (design 9.10 pins them there), oldest first, each with its id,
  under a header that says they're data. A run answering another agent sees none, as it sees only the pairing.
- **Taint** (the tools and approvals draft §6, and Security's two rules). A run that loads a line, or the summary,
  holds `S`; one that loads a line or summary marked `untrusted` holds `U`. A save in a run holding `U` (the member's
  attached files, a marked line or summary, and whatever the loop adds) runs only with `Verdict.Approved` and keeps the
  mark; otherwise it's refused `untrusted`. `ManagerAgent.RunSetup.taint()` is the run's live set, for the loop's
  `RunContext`; `Memories.declarations()` has the two tools' `ToolDecl`s.
- **Compaction.** A member's or a timer's run sends the summary, then the newest messages after it within 48,000
  estimated tokens (the gateway's UTF-8 bytes over 3) and 200 messages; with no summary and more behind, a line says the
  earlier part isn't shown. When the messages after the summary pass either, a run that ended `done` starts a
  compaction on its own thread: one call on the agent's own key and model (`ManagerAgent.sideCall`), through the
  gateway, reserved under that run (so the limits and the audit log count it, and it isn't a run of its own), folds the
  old summary and all but the newest 16,000 tokens (from a member's turn, 40 messages at most) into a new summary of at
  most 12,000 characters, with key-shaped strings replaced. It never holds the agent: a send meanwhile uses the summary
  as it was. A failure or a limit leaves the thread within the budget, and the next run's end tries again. A run
  answering another agent reads its pairing's newest messages within the same budget, and starts none.
- **The member's.** `agent.memory.list {agentId}` → `{agentId, memories: [{id, text, createdAt, untrusted}], summary:
  {id, text, messages, throughId, at, untrusted} | null, limits: {items, chars}}`; `agent.memory.delete {agentId,
  memoryId}` (a line, or the summary by its id) → `{deleted: true}`, or `not_found` `detail: memory`;
  `agent.memory.clear {agentId}` → `{deleted: n}` (every line, and the summary). A deleted summary keeps its place, so
  what it held is never sent or summarized again, and a compaction that read it before the delete writes nothing. A
  guild member reaches only their own agent's; the Founder's view has none of a member's. The WAL is emptied after a
  delete.
- **House rules.** Teens: none is ever made, as no run of a teen's starts (`age_band`), and a save checks the band
  again. A guild member's purge takes their lines and summary (`desk.member.purge` answers `memories`), and rows whose
  agent is gone go at every open, so a rolled-back desk-agent's purge leaves nothing once this one runs. The export
  carries both in `agent.db` (the `agent` part). The audit log has `memory.save`, `memory.forget`, `memory.delete`,
  `memory.clear` and `thread.compact`, ids and decisions only; no line or summary is ever logged.
- **Rollback.** Two new tables and nothing else in the schema; `user_version` stays 1. An older desk-agent ignores
  them and sends the last 100 messages again.
- **Tests:** `memory/MemoryTest`, `memory/CompactionTest`, and `GuildMemberPurgeTest.aMembersMemoryIsTheirsAloneAndGoesWithThem`.

## Approvals and taint (S-14)
The approvals half of `docs/decisions/draft-agent-tools-approvals.md` and deskd's `API.md` §18. Nothing that matters
happens without the member's yes, and deskd checks the yes again for the tools it runs.

- **The loop** (`ManagerAgent.gatedStep`, every run through `AgentService.withGating`): a step's calls are classified
  first (`ToolPolicy`, with the flags the run held when the step began, as the model wrote them all before any
  result), then admitted at once; every call that asks gets its own card and the run waits until each is decided or
  past its time; then the calls run in their order, approved ones with exactly the hashed payload, the rest answered
  with the verdict's words; each is settled and audited, and its declared taints join the run's.
- **What asks:** every `write`, `delete`, `send`, `spend` and `egress`, in every run; a memory save (`memory:self`) in
  a run holding `U`. Whatever the policy says, the loop raises a browse action (`browser_open`, `_click`, `_type`,
  `_press`, `_back`) to `egress` in a run holding both `U` and `S`, and in the member's signed-in session to at least
  `write`, a navigation there (`browser_open`, `browser_back`) to `egress`; `browser_read`, `_tabs` and `_close` stay
  `read`, and reading a session tab still sets `S`; a `spend` stays `spend`; and `browser_use_my_session` is refused
  `origin` in a run a timer or another agent started (Security's S-14 rule) (`Classified.backstopped(RunContext)`). `spend` is never asked from a run a timer or another agent started (`unattended_spend`) and only
  one is asked a step. Refused before asking, with no card: the policy's own refusal (`Classified.refusal`), the same
  hash declined or expired earlier in the run (`declined_before`), anything after 3 declines or expiries in a run
  (`declined`), past 10 asked a run, 5 pending for the agent, 20 on the desk or 2 signed-in sites a run (`ask_cap`),
  past 100 tool calls a run (`tool_cap`), a payload over 900 KiB of JSON (`too_large`) or one the canonical JSON
  can't carry (`payload`).
- **Done without asking** (`ApprovalPolicy`, `LowRisk`; the owner's decision of Nov 12: auto-approve for low-risk
  writes, chosen per agent at setup, ask by default; the draft ADR's §15, built as its W3 on `sub/mm-auto-approve`;
  `services/deskd/docs/API.md` §18, "Done without asking"). The member turns a switch on per agent (setup, settings, or
  a card's "Don't ask again", always through `agent.access.set` from their session). The gate asks the policy about a
  call that would make a card only after every refusal before asking and after the run's declines (a payload the member
  declined in the run is `declined_before`, never done unasked: Security's AAW-L1), and only within the counts, 20 a
  run and 100 an agent a day by the member's midnight (ADR 0043's zone; seeded from `agent.db` at a restart). The policy
  wired is `ApprovalPolicy.perAgentWithPlaces(access::switches, LowRisk.ADR)`: the groups on for that agent with their
  places. `LowRisk.ADR` maps `notebook_write` (a new page, or an append; 8,000 characters with a new page's title) to
  `notebook`, and `files_write` (no replace; 64 Ki characters) and `files_mkdir` to `files`; `todos` is declared and its
  tools are W4's, which add them with their own rule. Whatever a map says, `LowRisk` takes only a deskd-hosted tool
  (AAW-I5) of class `write` declared `write`, in the agent's own context, in a run with no `U`, with a rule of its own
  that it only adds (a tool with none never does: AAW-L4), never `follow_up`, a memory save, a guild member's agent or a
  refused call; nothing on a Guild Desk (deskd's hello says so: AAW-L3). **The place** (`LowRisk.inPlace`): a new page's
  `new.tabId`, or the tab deskd's look found for an append's page (`target.tabId`), equal to the switch's tab; a Files
  path inside the switch's folder part by part, at least one part below it. Such a call runs as
  `Verdict.Allowed(group, approvalId)` with exactly the payload the policy judged. **Its row:** an approval in
  `approvals`, `decided_by` `auto`, `auto_group` and `auto_place`, kept `approved` before it runs (so a restart makes it
  `interrupted` or `expired`, as a card's) and settled `done` or `failed`; in `agent.approvals.list`, never a card. The
  reply lists it in `auto: [{approvalId, tool, target, group, state, undoneAt}]` and in `approvals` (decided by
  `auto`, never a card); in a run the member didn't start it counts on the agent's `autoUnseen` until `agent.seen`; its chip has
  `auto` and `approval: {id, decision: "auto"}`; the model reads "Done without asking, under the member's setting for
  this agent."; audit `tool.call` with `auto:<group>` and `approval.auto` with the id and the payload's hash. Its `tcall`
  carries `auto` and `autoApprovalId` (the row's id), which deskd checks again from its own record, class, place, taint,
  counts and ledger before it runs anything; when deskd refuses it (`approval_unknown`, `approval_used`, `place`), the
  same payload asks on a card if the model tries again in that run. **Undo** (`agent.approval.undo`): deskd takes the
  call back itself from its own ledger and relays `{approvalId, outcome}`; desk-agent stamps the row once
  (`undone_at`, `undone_by`) for `ok`, audits `approval.undo` either way, and publishes it. **The gate checks
  `LowRisk.ADR` itself** for every group a policy names, so however a policy is wired it only narrows the class
  (Security's ATC-L1; tests use `LowRisk.forTest` with `lowRiskForTest`). `follow_up` runs only on `Verdict.Approved`.
  A call after one in the same step that runs, isn't itself unasked and has a result that can add `U` asks (ATC-I1);
  after one whose result never can (`Approvals.NEVER_ADDS_UNTRUSTED`: a Files listing, the plan, the agent's workspace
  listing, a write's receipt), the switch decides as for a clean run (release 3's bug E, `sub/mm-fix-bundle-2`). An unasked call's row is a
  card's in a restart: its `run_calls` record (with its approval id and `auto` group) settles it at open, or it ends
  `interrupted`; one whose key deskd couldn't confirm after a lost link ends `interrupted`, never `failed`.
- **Restarts** (durable runs' seam, the draft ADR's §3, "Restarts"; `run/RunCalls`, `tool/Restart`): every
  `ToolDecl` says what a restart or a lost link does to a call of it in flight: `retry_by_key` (what deskd runs that
  changes something), `interrupt` (what desk-agent runs that changes something) or `safe` (reads and the plan); a
  call whose class rose to one that asks is never `safe`, and a declaration that names none is never `safe`
  (`ToolRegistryTest` pins every tool, and deskd's `HostedDecls` to it). Each call that runs has a `run_calls` row,
  `started` before it's sent and `done`, `failed` or `interrupted` after, keyed by a UUIDv7 that its `tcall` carries
  as `key`. A call deskd got and didn't answer (the link went, the 60 s ran out, deskd stopped mid-call) is asked
  again with `retry: true` on the next link that says `keys`, for up to 2 minutes: it takes deskd's real result, or
  ends `interrupted` ("Interrupted: <word>. It may or may not have happened: check before you do it again.") for a
  key deskd no longer holds, no link, or a deskd that keeps no keys; a `safe` call fails as before. An approved call
  that ends `interrupted` interrupts its card, never fails it; a retry deskd was too busy for (`rate_limited`) is
  asked again, never taken as the outcome. Each step writes its reply's text and chips so far, after the run's marks
  (`Approvals.stepMarks`), so a kill keeps them and a later run never reads them unmarked. **At open**, before the approvals' sweep: a call that came back settles its approval from its
  record (`tool.call`); a call still `started` ends `interrupted` (`failed` if `safe`), `detail: "restart"`, audited
  `tool.interrupt` with its tool, run, key and approval or switch, so an unasked or `own` call in flight leaves a
  trace; a timer left `running` ends `interrupted`. A run's end interrupts what it left `started` (`ended`).
  Records go with their agent, and a week after they settle. **That is for a run that can't resume; a run that can
  picks up** (durable runs' resume, below).
- **The resume** (`run/RunCheckpoints`, `run/Resume`, `AgentService`'s "durable runs: pause and resume", the
  draft ADR's §3): each run's start context (`Resume.Start`: instructions, thread, origin, chain, cap) is kept as it
  starts; each step's plan (`Resume.Plan`) once its model call is back and before anything of it runs; the gate's
  verdicts; each call's result and chip in one transaction with its record. The run's book (`Approvals.book`: calls,
  asks, declines, declined hashes, sites, egress, admits) and taint go with each and whenever they change between them
  (`Approvals.bookChanged`). At most 2 MiB a run (`RunCheckpoints.CAP`); a run past it can't resume. At open
  (`AgentService.restore`), a run whose reply is still `streaming` and whose checkpoint reads whole keeps its calls,
  cards (`Approvals.resume`: live and answerable at once) and timer (`Timers.resuming`); once deskd says hello (30 s at
  most) it picks up (`ManagerAgent.resume`): before a model call it asks the model again, inside a step its settled
  calls keep their results, a step not admitted is admitted again (`Approvals.admit` finds a card asked before by its
  hash), and a call left in flight follows its rule (`retry_by_key` again by its key with `retry: true`,
  `RunCalls.resending` and `AgentTools.retrying`; `interrupt` ends `interrupted`; `safe` ends `failed`). The reply's
  view gets `resumed` (`messages.resumed`), and `run.resume` is audited. **SIGTERM pauses** (`stopAll`: `Run.pause`,
  `Approvals.pausing`): nothing expires, nothing is interrupted, and the run is `paused`. A run that can't resume ends
  as the seam ends one (`abandon`), audited `run.interrupt`. **The kill switch:** `/data/agent/resume-switch` saying
  `off` (read at start, `AgentService.switchedOff`) keeps no checkpoints and ends every run a restart left.
  **Waits** (`run/RunWaits`): a tool that waits on an answer from elsewhere calls `await(run, callKey, kind, ref,
  max)` once what it waits for is on its way, and again with the same key after a restart: the kept wait with its
  first deadline, or the answer that came meanwhile; `answer(kind, ref, answer)` delivers one, and says whether a wait
  took it; while it waits, `statusDetail` is `waiting_<kind>`.
- **A resend binds what the first sending bound** (Nov 14, `sub/mm-release-fixes`): deskd keys a call's reply to its run,
  agent, tool, arguments, approval, switch and `context` (`ToolHost.fingerprint`). The `context` comes from the look,
  which `RegistryPolicy` remembers until the call is sent; a step picked up after a restart isn't classified again, so
  `ManagerAgent.gatedStep` hands the checkpointed calls to `ToolPolicy.resumed`, which puts each context back. A resend
  deskd still refuses `key_mismatch` ends `interrupted` (`AgentTools.KEY_REFUSALS`), never `failed`. The tests' deskds
  keep replies with that fingerprint (`testing/KeyFingerprint`), so a resend that binds anything else fails
  `ResumeKillTest`'s oracle and `DeskMessagesFlowTest`'s kill of a sending desk.
- **A page's approvals** (§18): `agent.thread.get` and the conversation snapshot carry `approvals`, every approval of
  the page's messages, beside each reply's own list (`AgentService.page`, which counts both copies).
- **A card** (`approvals` in `agent.db`): `ap-` and 20 base32 characters; the desk's title from the declaration's
  `words`; the exact payload as canonical JSON; `sha256` of the canonical JSON of `{v: 1, agentId, runId, tool,
  context, payload}`; `untrusted` when the run held `U`; the run's origin; 1 hour in a run the member started, 24 in
  one a timer or another agent started. `agent.approval.decide` needs the stored hash from the caller (`bad_request`,
  `sha256`), moves a card once (`conflict` `answered` or `expired`), and only the agent's owner sees or decides it
  (`Caller.sees`: the owner the desk's agents, a guild member their own, else `not_found`). A note only with a
  decline, 1 to 500 characters, no hidden characters.
- **While a run waits** its reply reads `awaiting_approval` with `pendingApprovals`, the agent `working` with
  `statusDetail: "awaiting_approval"` and `approvalsPending`, and a member's message to it is `conflict`
  `awaiting_approval`. A stop expires its cards (`stopped`), the owner's band leaving adult (`age_band`), desk-agent
  stopping (`restart`). An approved call whose tool never started is `expired` too; one that started and never ended
  is `interrupted`. At open, `Approvals.restore` sweeps what a crash left the same way. Nothing re-runs.
- **Taint** (`RunContext`, never cleared): `U` from another agent's message (the run it starts), the member's
  attachments, a reply in the run's context whose run held `U`, a memory line or summary with the mark, and whatever
  a tool's declaration (or the tool itself, `run.add`) says; `S` from the member's attachments (their own file, as a
  Files read of it is: Security's ATA-L2), a reply's mark and memory. A run
  another agent's message started passes its flags on to the sender's run, which reads its reply. At its end a run's
  flags and its count of `egress` calls are kept on its reply (`run_marks`): the reply shows `untrusted` and
  `egressCount`, a later run reading it starts with them, and a thread summary that folds it is marked.
- **Audit:** `approval.ask` (with the hash), `approval.decide` (actor `user` or `member`), `approval.expire`
  (`timeout`, `stopped`, `restart`, `age_band`), `approval.interrupt`, `tool.call` for every call with its arguments'
  hash and `ok`, `error:<word>`, `interrupted:<word>` or `refused:<reason>`, `tool.interrupt` (a call in flight at a
  restart or a run's end), `browser.session.grant`. Ids, tools and words only: never a
  path, a page, a file or typed text. The approvals and marks go with their agent's thread (`agent.delete`, a purge).
- **For the tools:** a gated run calls `Tools.call(call, RunContext, Verdict)`; a deskd-hosted tool sends
  `{approvalId, sha256}` and `run.taint()`, and deskd redeems the ticket (`ApprovalTickets` in deskd). A failed
  tool's text starts "Refused: <word>." or "Failed: <word>.", which becomes the card's `result.error`.
- Tests: `approval/ApprovalsTest` (approve, decline and its note, expiry at an hour and at a day, a wrong hash, the
  caps, spend, an unattended run, the marks and memory, egress, stop, a restart while waiting and while running, a
  guild member, a large payload, the audit, the event), `approval/ApprovalRulesTest` (the interface's rules, the
  hash, the restart sweep, a member's card), `approval/ApprovalHardeningTest` (a hash over anything but the stored
  payload, 16 answers to one card at once, three runs waiting at once, an answer at the moment a card's time is up, a
  restart mid-approval and the audit chain after it, a switch on for one agent and not another, what a switch never
  reaches, a policy that fails, text claiming the member approved, the chain across every outcome) and
  `approval/ApprovalPolicyTest` (the class's rules, which no list widens, and deskd's copy of the list). Measured, with
  `-Dtest=ApprovalRoundTripPerf -Dperf=true`: the round trip from the decide to the run's end. Restarts:
  `tool/DurableSeamKillTest` (killed mid-call and at settle, an unasked and an `own` call in flight, the link dropped
  and the call asked again by key, a deskd that no longer holds it, an older deskd, a link that never comes back, a
  read, a timer's run), `run/RunCallsTest` (the records, each step's reply, a run's end, the open after a kill, the
  week), `tool/RestartTest`, `socket/ToolKeysSocketTest` (the link dropped over the real socket of the real
  application) and `ToolRegistryTest`'s pin of every tool's rule; `DurableSeamKillTest` runs with the resume's kill
  switch off, the path of a run that can't resume. The resume: `tool/ResumeKillTest` (176 cases: a read, an approved
  write, `send`, `spend`, an unasked write and the agent's own, each with desk-agent killed or paused at a model call,
  the plan, a pending card, the verdicts, a record started and not sent, deskd running the call and the result, with
  deskd keeping its keys or restarting), `tool/ResumePropertyTest` (1,000 seeded runs with random steps, decisions and
  one or two faults; `-Dresume.runs=N -Dresume.seed=S`), `tool/ResumeTest` (a card's time passing while the desk is
  down, the cap, a checkpoint that doesn't read whole, a timer's run, a wait across a kill, a rollback's leftovers, the
  audit), all on `tool/ResumeRig`, the in-process fault rig (a counting deskd that keeps replies by key and tickets
  once, and restarts; kill points by name), shaped as W7's harness so it can move there.
  **The shared harness** (W7, `harness/`;
  `docs/sub-status/mm-harness.md`): `FaultMatrixTest` (kill points × faults × kinds of call against `CountingDeskd`,
  with its known failures by owner), `AuditCanaryTest`, `ThreatsTest` (one per §10 row), `InjectionFixturesTest` (design
  §9.7's pages in `src/test/resources/harness/injection/`). **A new tool adds one line to `harness/ToolCases`**, or
  `HarnessCoverageTest` fails.

## Tools (S-14)
The tools half of `docs/decisions/draft-agent-tools-approvals.md` (sections 1, 2, 5, 6 and 11) and deskd's `API.md`
§18. Package `tool`; deskd's side is `services/deskd`'s package `tools`.

- **The registry** (`ToolRegistry`): every tool's `ToolDecl` in code: wire name, the card's words, schema, one scope,
  class, taints and host. The team's tools and memory's (`Memories.declarations()`) are declared there too, so no tool
  a run can have is undeclared (`ToolRegistryTest`). `DESK_AGENT_TOOLS_OFF` switches tools off by name, and does
  nothing else: no setting lowers a class, widens a scope or removes an approval. deskd keeps its own copy of the
  tools it runs (`HostedDecls`), and a test pins the two to the same classes and taints.
- **The policy** (`RegistryPolicy`, `AgentService.toolPolicy`): classifies each call before the step runs. Input its
  schema doesn't take is refused `input` (`Schemas`). For a tool deskd runs it asks deskd for a look
  (`tcall` with `phase: "look"`, nothing done), which gives the class it rises to (a submit control `send`, a
  pay-looking one `spend`, any navigation in the member's signed-in session `egress`), the context (`agent` or
  `member:<site>`), target, exact payload (a Browser element's `label`, `role` and `origin` added), `before`, and a
  refusal decided before asking (a sensitive field, `off_site`, a file already there), so nobody gets a card for
  something that would be refused. The class never falls below the declaration's, and the Rule of Two makes a browse
  action `egress` in a run holding both `U` and `S` (a `spend` stays one), here, in deskd and in the loop's backstop.
  `browser_use_my_session` is refused `origin`, before deskd hears of it, in a run a timer or another agent started.
- **Clicks and keys** (`browser_click`, `browser_press`): deskd's half does them in deskd's own isolated world, never
  the page's, with an untrusted `el.click()` or key events, as trusted input never reaches the Agent's hidden tabs on a
  desk's Chromium (deskd's `API.md` §14, "The Agent's walker"). deskd's look classes them before anything is done: a
  submit or Enter that sends `send`; anything that looks like paying, or any click or submit on a page with a payment
  provider's frame anywhere in it, `spend` (its payload says `spend: true`); a click on a link in the member's
  session `egress`, any other click or key there at least `write`; a link off the granted site `off_site` and a
  sensitive field `sensitive`, refused before asking.
- **The tools** (`AgentTools`, around each run's own in `AgentService.begin`): Files (`files_list`, `_search`,
  `_read`, `_write`, `_mkdir`, `_move`, `_trash`), the Browser (`browser_open`, `_read`, `_click`, `_type`, `_press`,
  `_back`, `_close`, `_tabs`, `_use_my_session`), Notebook (`notebook_search`, `_list`, `_read`, `_write`, `_trash`) and
  To-do (`todo_list`, `_get`, `_add`, `_update`, `_close`) and Courier, read only (`courier_list`, `_search`, `_read`,
  `_new`), which deskd runs; and `plan_update` (`own`, a checklist on the reply, `Plans`, kept in `run_plans`), `follow_up` (`write`,
  a one-shot timer on the agent within 7 days, `Team.followUp`) and `workspace_delete` (`own`, its own workspace only),
  which run here. A run is offered deskd's tools only once deskd's hello has named them; a guild member's own agent
  gets Notebook and `plan_update` only. A document from Files is read here with the attachment readers, a page at a
  time.
- **To deskd** (`DeskLink`, `AgentSocketServer`; `docs/proposals.md` §5, "Tool calls"): `tcall {runId, agentId, tool,
  args, taint}`, plus `{approval: {approvalId, sha256}, context}` for an approved call, answered `tres` or `terr`. deskd
  redeems the approval itself before it runs anything that asks. A refusal reads "Refused: <word>." and a failure
  "Failed: <word>."; the run's flags take what deskd's result adds (`S` from the member's session, `U` on a guild
  desk). At a run's end desk-agent sends `run_end` (`args: {state: "done" | "ended", courier?}`), and deskd lets go
  of its browser context and any signed-in tab, and stores a `done` run's Courier cursor.
- **Untrusted results** reach the model as one line of JSON behind a label saying it's data, so nothing in a page,
  file or note can close a frame and pass as the desk's or the member's words. A tool whose declaration taints `U`
  (`files_read`, `browser_open`, `_read`, `_click`, `_press`) is fenced whatever deskd's reply says.
- **Paged reads** (`files_read`, `browser_read`, `notebook_read`; `AgentTools.fitPage`): a page reaches the model within
  the run loop's cut of 20,000 characters (`ManagerAgent.MAX_RESULT_CHARS`), fenced or not, with its fields before its
  text, and when the text doesn't fit it's cut at the end and `next` moved back to just after the last character kept
  (in a text file's UTF-8 bytes, or a document's, page's or note's characters), with a note to read on. Before, the cut
  took a full page's tail and its `next` with it, so nothing past a file's, page's or note's first 20,000 characters
  could be read. deskd still sends up to 128 Ki characters of a file a page; the model reads about 19,000 of them a call.
- **Workspace marks** (Security's finding 3, `workspace_marks` in `agent.db`, as memory marks a line): a workspace
  file a run holding `U` wrote is marked; a run that reads it, from its own workspace or a shared one, holds `U`. A
  whole new file from a clean run clears the mark, an append keeps it, and a delete takes it.
- **Notebook marks** (Security's ATN-M1, kept by desk-notebook, checked by deskd): a `notebook_write` from a run holding
  `U` is marked, and deskd's result for a read, a search hit or a tab's list of a page still holding that text carries
  `U`, which the run takes as it takes any result's taints, so a browse after it asks. The fence names it "a Notebook
  page with untrusted text in it" (`AgentTools.source`). The member's own change to that text ends the mark.
- **To-do** (`todo_list`, `todo_get`, `todo_add`, `todo_update`, `todo_close`; deskd's `API.md` §22, the draft ADR's
  §13; `sub/mm-todo-store`): deskd's own store, `todo:read` and `todo:write`, the app switch `todos`. deskd decides
  each call from its own facts (the item's maker and run, its taint copy, whether the member started the run) and says
  in its look `group: "todos"` when the call is in §15's To-do group; `RegistryPolicy` keeps it on `Classified.group`,
  and `LowRisk` admits a To-do call unasked only on that group and the member's switch, never from a guild member's
  agent or another context, so an add after `U` passes only when deskd's look said so (Security's ATA-L1).
  `todo_close`'s floor is `own`: a suggestion ("Looks done?") runs with no card; only a close deskd rises to `write`
  asks or goes through the group. A To-do read that returns an untrusted item adds `U`, fenced as "the member's To-do,
  holding to-dos made from untrusted content". Chips: "Looked at your to-dos", "Added a to-do", "Merged into a to-do",
  "Already on your to-dos", "Changed a to-do", "Marked a to-do done" or "Marked a to-do not needed" (by the close's `as`),
  "Asked if a to-do is done" or "Asked if a to-do is still needed" (a suggestion, by its `as`).
- **Courier, read only** (`courier_list`, `courier_search`, `courier_read`, `courier_new`; deskd's `API.md` §21, "The
  agent's Courier tools"; the draft ADR's §12; `sub/mm-courier-read`): scope `courier:read`, the app switch `courier`,
  off until the member switches it on. Every result is `U` and `S` (the declarations', so fenced whatever deskd says,
  as "Courier, the member's messages and email, written by other people"); the run guide adds a line that messages
  are other people's words and that it can't send. There's no send tool. `courier_new` goes by key (`RETRY_BY_KEY`:
  it moves the run's place in deskd, so a lost reply is asked again for the same messages); `AgentTools` keeps the
  last `cursor` each run got from it, and `run_end` names it in `args: {state: "done", courier}` only when the run
  ended `done` (`AgentService.finish`) and no `courier_new` of the run was interrupted (Security's CR-L2), so deskd
  stores the agent's cursor only for messages a finished run had.
  Chips: "Looked at your messages", "Searched your messages", "Read your messages", "Checked for new messages".
- **Chips:** `summary` is the desk's few words per tool, never content; the gate adds `risk`, `approval`, `target`,
  `untrusted` and `session`.
- Tests: `tool/ToolRegistryTest`, `tool/RegistryPolicyTest`, `tool/AgentToolsFlowTest` (through a real service, its
  gate and a scripted deskd, `FakeDeskLink`), `tool/HostedApprovalFlowTest` (every refusal of deskd's second check
  reaching the card and the model as one word, a call done without asking going to deskd with its group and deskd's
  payload, a switch never reaching a delete or a write after a file was read, the declaration's fence),
  `tool/PagedReadFitTest` (a full page fitted under the run loop's cut with `next` moved back, read on to the end),
  `tool/CourierToolsFlowTest` (Courier offered only with its switch, the fence, the chips, `run_end`'s cursor on `done`
  only) and `socket/ToolCallSocketTest` (the hello and `tcall` on the real socket).

## Access and the setup gate (draft ADR "the Agent's tools and approvals", section 16; `sub/lsub-agent-tools-setup`)
`access/AccessBook` keeps what the member chose for each agent on its setup screen: apps, "without asking" switches, and the
send halves of grants to the member's other desks (`store/AccessSchema`: `agent_access`, `desk_grants`, additive).
- **The gate:** `AgentService.begin` refuses every run of an agent not set up, `precondition_failed` `setup` (`no_key` first
  for one with no key), before anything reaches the thread: the member's, a timer's and another agent's.
- **Revocable mid-run:** `tool/ToolAccess` is read at every step and every call. `AgentTools` offers only the hosted tools of
  apps that are on, `RegistryPolicy` refuses a call of an app that's off `scope` before deskd's look, and the memory wrapper
  re-reads the step's tools. `message_agent` to an agent not set up tells the lead it's waiting for the member.
- **The upgrade:** the first open that makes `agent_access` gives every agent already there a `legacy` row: `setup:
  "upgrade"`, its next run waits for the screen, which starts from Notebook, Files and Browser.
- **Fails closed:** a row whose SHA-256 (over the agent's id and the choice) doesn't match, or that doesn't parse, is nothing
  chosen (`setup: "confirm"`), audited once (`access.tampered`); a grant row likewise is no grant. deskd's hello naming the
  agents it holds, or deskd refusing a call `setup`, makes any other agent wait for the member to confirm, its choice kept.
- **Only the member:** `agent.access.set` and `agent.desks.revoke` (deskd relays them only from a session that may act); no
  proposal, timer, tool or model reaches them. Audited: `access.set`, `desks.offer`, `desks.revoke`, `access.confirm`.
- **Seams for the gate:** `switches(agentId)`, the groups switched on with each one's place (all off on a Guild Desk),
  is the argument of `ApprovalPolicy.perAgentWithPlaces(switches, LowRisk.ADR)` and of the rows of calls done without
  asking; `switchedOn(agentId)` the groups alone; `activeGrants(agentId)` for `desk_message`.
- Tests: `access/AccessBookTest`, `tool/AccessToolsFlowTest`; and deskd's `RealDeskAgentAccessIT` against this jar.

## Messages between the member's desks (draft ADR "the Agent's tools and approvals", section 14; `sub/mm-desk-messages`)
An agent on one of the member's desks messages an agent on another, carried by the member's office (deskd `API.md` §18,
"Messages between the member's desks"). deskd keeps the keys and its own record of the halves and makes and opens every
envelope; the package `desks` keeps the rest:
- **`DeskBook`** (`store/DeskSchema`, additive): `desk_answers` (offers waiting here and this desk's answer halves, each
  row with its SHA-256), `desk_outbox` (deskd's sealed envelopes until the office took them, 7 days at most),
  `desk_inbox` (every envelope taken in, by id: a second delivery is `duplicate`) and `desk_seq` (the last `seq` per
  grant: an older one is `stale`), and `desk_grants` gains the other desk's answering agent. Each delivery is one
  transaction with what it changes. Its own second check of the half: a message only on an active answer half from the
  agent the offer named, an answer only on a live send half, 20 a grant a day.
- **`DeskMessages`**: `agent.desks.list`, `.answer`, `.take`, `.done` and an answer half's `agent.desks.revoke`; deskd's
  `desk.desks.queue` and `desk.desks.deliver` (refused from any frame with a caller); `desk_message`'s outbox and its
  wait (the envelope queued, its grant's use counted and `desks.sent` audited once per envelope, `DeskBook.queueSent`,
  so a call asked again by its key after a restart neither sends nor counts it twice); the answering run (origin `desk`: the pairing only, `U`, no memory, no `desk_message` or `message_agent`,
  unattended, a spend cap from `a2aSpendPct`), whose reply goes back as the run's closing call (`ManagerAgent.Closing`,
  `desk_answer`, through the gate: `send` and a 24-hour card when the run holds `S`); a failure word in place of an
  answer for a run that can't start, fails, is stopped, is declined or is cut off by a restart; the thread's rows
  (`origin.kind: "desk"`, `role` `message`, `answer` or `notice`); the sweep (expiry, and messages waiting for their
  agent to be free).
- **`DeskWaits`**: `desk_message`'s 120 s wait for the answer, one answer to exactly one place (the call, or the
  thread). In RAM today; durable runs keep it in `run_waits` (kind `desk`, ref the message's envelope id, the deadline).
- **Seams:** `tool/DeskHook` (a desk's name to its id, the card's names, the outbox after deskd's tool, and whether a
  call is a run's own closing call: `desk_answer` runs only so, under an id desk-agent made, never as a model's call,
  Security's DM-I1), `RunSetup.closing`, `AgentAccess`'s `incoming`, and `waiting_desk` on `agent.state`, with
  `deskOffers`.
- **To-do's source kind `desk`:** every call of a run another desk's message started, look and run, carries `origin:
  {kind: "desk", envelopeId}` (`RegistryPolicy.putOrigin`), and `desk.desks.deliver` answers `taken: true` for an answer
  the waiting call took, so deskd can give the run that message by its own record (`API.md` §18). `todo_add`'s `source`
  takes `desk` with `{}`.

## Not built
- Google's adapter (Phase 2). Paid OpenRouter models priced and listed, pictures on OpenRouter's models, and
  OpenRouter's `reasoning_details` kept across a tool run's steps (STATUS.md).
- Image generation,
  the usage report to Platform, and a signed `pricing.json`. The tier's `toolCallsPerRun` (100 on every tier for now).
- Timers that wake a stopped desk (they fire while desk-agent runs).
- The egress proxy (deskd's), which `DESK_AGENT_EGRESS_PROXY` will name.
- Memory recalled by search (FTS5) beyond the pinned lines; a member writing a line themselves.
- Auto-approve's to-do tools (W4) and the agent's tile counting unasked calls of a run the member didn't start until
  they're seen (the draft ADR's §15).
- `STATUS.md`, "Launch scope", sorts these for launch.
