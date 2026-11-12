# desk-agent: changes proposed outside its folder

Task 04 may change only `services/desk-agent/`, its `STATUS.md` included. These are the changes it would want
elsewhere, each with its owner. Nothing here is built outside this folder. Each is written so the owner can apply it
as is or say no.

## 1. `services/pom.xml` (Desk Engineer)
**Done on `sub/deskd-agent-relay`,** with the Dockerfile's build step moved to `-pl desk-agent -am`.

Add the module, so `./mvnw verify` from `services/` builds both:
```xml
  <modules>
    <module>deskd</module>
    <module>desk-agent</module>
  </modules>
```
Nothing else changes in the parent. `desk-agent/pom.xml` already names it as parent. After this, the Dockerfile's
build step can be `./mvnw -q -DskipTests -pl desk-agent -am package`, as deskd's is.

## 2. `services/scripts/` (Desk Engineer)
**`build-on-box.sh`'s service argument: done on `sub/deskd-agent-relay`.** `desk-common` isn't.

- `build-image.sh` and `package-release.sh` need no change: both work for `desk-agent` as they are
  (`desk-agent/scripts/test-release-scripts.sh` checks them with the stub docker).
- `build-on-box.sh` has `SERVICE=deskd` fixed. Take it as a second argument, `build-on-box.sh <git-sha> [service]`,
  defaulting to `deskd`, and check `services/$SERVICE/Dockerfile` as it already does.
- Shared code: `AdminServer`, `Json` and `ReadinessReporter` are copies of deskd's here. A `services/desk-common` module
  holding them (and later the SQLite helper) would stop them drifting. Default: copy until a third service needs them.

## 3. `docs/interfaces/desk-runtime.md` (System Engineer)
- **Section 1:** the `desk-agent` row stays as it is (`agent`, 1103, Docker, host network). Add: "`desk-agent` reaches
  nothing but loopback: nftables limits uid 1103 to `127.0.0.1` (deskd's egress proxy, design 9.8)."
- **Section 2, paths:**

  | Path | Holds | Writable by |
  |---|---|---|
  | `/data/agent` | `desk-agent`'s agents, ledger and audit log (`agent.db`, `usage.db`, `audit.db`), and its sealed keys (`keys/`, ADR 0042). Mode `0700` | `agent` |
  | `/run/desk-agent/` | `agent-admin.sock` (`0600`, owner `agent`) and `agent.sock` (`0660`, group `desk`). Directory mode `2750`, owner `agent`, group `desk`: the setgid bit gives the socket group `desk` | `agent` |

  `/run/desk-agent` and not `/run/desk`: `rtc.sock` is group `desk`, so `agent` must never be in that group.
- **Section 3, boot order:** `desk-agent` starts after `data.mount`, independently of `deskd`. It holds no key until
  deskd hands one over, and answers health without one.
- **Section 5:** `desk-agent`'s `run` (in `services/desk-agent/docker/run`) with at least:
  ```
  exec docker run --rm --name desk-agent --network host --user 1103:1103 --read-only --tmpfs /tmp \
    --cap-drop=ALL --security-opt=no-new-privileges --log-driver=journald --log-opt tag=desk-agent \
    --memory=320m --memory-swap=320m --cpu-shares=256 --pids-limit=128 --stop-timeout=30 --ulimit core=0 \
    -v /run/desk-agent:/run/desk-agent -v /data/agent:/data/agent --env-file "$RELEASE_DIR/desk-agent.env" \
    "$(cat "$RELEASE_DIR/image-id")"
  ```
- **Section 6, health:** "`desk-agent`: it answers on `/run/desk-agent/agent-admin.sock`, and its data directory, ledger
  and audit log are open. No key bound is healthy."

## 4. The image (System Engineer)
**Done on `sub/desk-agent-image`** (`image/README.md`, "desk-agent"), with the egress rule as an allow-list of the
providers' addresses that `desk-agent-egress` keeps from DNS, until deskd's proxy exists.

Exactly what a desk needs before `desk-service-release.sh` can roll `desk-agent` out. Without it, `ma-update` installs
the release, finds no unit, and `/opt/ma/smoke-test` fails on desk-agent's `health` and rolls it back; and a
release left installed with no unit would fail every later component's smoke test, deskd's included.
- `image/recipe/files/etc/systemd/system/desk-agent.service`, the same shape as `deskd.service`:
  ```ini
  [Unit]
  Description=desk-agent (Spring Boot in Docker; runs as root to call the Docker CLI)
  ConditionPathExists=/opt/ma/desk-agent/current/run
  Requires=docker.service desk-datadirs.service
  After=docker.service desk-datadirs.service network-online.target
  Wants=network-online.target

  [Service]
  Environment=RELEASE_DIR=/opt/ma/desk-agent/current
  ExecStartPre=-/usr/bin/docker rm -f desk-agent
  ExecStart=/opt/ma/desk-agent/current/run
  ExecStop=/usr/bin/docker stop -t 30 desk-agent
  TimeoutStopSec=40
  Restart=always
  RestartSec=3

  [Install]
  WantedBy=multi-user.target
  ```
  `ConditionPathExists` skips it cleanly until a release is installed, as deskd's does.
- `image/recipe/files/etc/tmpfiles.d/ma.conf`: `d /run/desk-agent 2750 agent desk -`. The setgid bit gives the agent
  socket group `desk` without `agent` being in that group, which would open `rtc.sock`.
- `image/recipe/files/usr/local/lib/ma/desk-datadirs`: `mk /data/agent agent agent 0700`.
- nftables: uid 1103 may reach only `127.0.0.1`, once deskd's egress proxy exists. Today the rules only block it from
  IMDS and port 9222 (`image/verify.sh` checks both). Until the proxy exists, the provider hosts (`api.anthropic.com`,
  `api.openai.com`, `api.x.ai`) on 443 would need an allow-list for uid 1103 instead.
- `image/verify.sh`: `desk-agent.service` is installed and inactive with no release; `/run/desk-agent` is `2750
  agent:desk`; `/data/agent` is `0700 agent:agent`.
- `ma-update` needs nothing new: `desk-agent` is a Docker component like `deskd`.

## 5. The agent socket: deskd relays `agent.*` to desk-agent, one to one (Desk Engineer, then `desk-runtime.md`)
Design 9.8 has deskd and desk-agent talk over "a unix socket (tools RPC + events)", unspecified. This is desk-agent's
side of it, which milestone 2 builds, and the exact change deskd needs is in section 8.

**Who holds what.** The client's `agent.*` interface (section 6) is served by desk-agent, through deskd: agents,
threads, runs, key metadata, limits and the audit log live in desk-agent's `/data/agent/agent.db` and `audit.db`,
which deskd can't read and doesn't need to. deskd stays the only door from a client and the only policy point for
tools (ADR 0019): it checks the session and relays. Its one piece of real work is the key: it takes the secret out of
the JSON before relaying. desk-agent seals it and keeps it (ADR 0042), so deskd stores nothing of it.

**Transport.**
- `desk-agent` listens on `/run/desk-agent/agent.sock`, mode `0660`, group `desk`, and accepts only a peer whose
  `SO_PEERCRED` uid is 1100. One connection at a time; a new one replaces the old. The other direction would need
  `agent` in group `desk`, which opens `rtc.sock`.
- Framed like `rtc.sock` (section 4.2): `u32be length` of what follows, `u8 type`, the body, at most 4 MiB (a thread's
  snapshot can pass 64 KiB).
  - `0x01` JSON, an object with a `t` field.
  - `0x02` KEY: `u32be id`, `u16be` length and a JSON object `{"m": "agent.key.add", "p": {"provider", "label"}}`,
    then `u16be` length and the key's bytes. desk-agent reads the key into a direct buffer and zeroes its read
    buffer; the key never becomes a `String` there. The reply is a normal `res` or `err` with that `id`.

**Messages.**

| From | `t` | Fields | Meaning |
|---|---|---|---|
| deskd | `req` | `id`, `m`, `p` | One client RPC, `m` and `p` exactly as the client sent them |
| deskd | `cancel` | `id` | The client cancelled, or its session ended |
| deskd | `sub` | `sid`, `topic` | One client SUB. desk-agent answers with a `snapshot` event for that `sid`, then every later event |
| deskd | `unsub` | `sid` | One client UNSUB, or its session ended |
| desk-agent | `res` | `id`, `r` | The RPC's result, which deskd sends as the RES |
| desk-agent | `err` | `id`, `code`, `details` | A deskd error code (API.md section 4) and `details.reason` etc., which deskd sends as the ERR unchanged |
| desk-agent | `evt` | `sid`, `topic`, `seq`, `type`, `data` | One EVT for that subscription |

A run doesn't depend on the connection (design 4.2.7): a drop ends every `sid`, and deskd subscribes again for its
clients after it reconnects. Requests in flight on a dropped connection get `unavailable` from deskd.

**What deskd pushes (ADR 0043).** Two more `req`s, which no client can send, as deskd's relay lists only `agent.*`.
deskd sends each on every connection, once it knows the value, and when it changes. desk-agent keeps neither on disk.

| `m` | `p` | `r` | Meaning |
|---|---|---|---|
| `desk.prices.set` | `{table}`: the Platform's table as text, in `pricing.json`'s format, at most 1 MiB | `{applied, pricesAsOf}` | The table for new calls. As text, so nothing in it can break the frame. One that can't be used is ignored: `applied: false`, one log line, and the table in use stays |
| `desk.account.set` | `{deskDay, deskMonth, timeZone}`, each a `Limit` or a zone, or null | `{}` | The account's values, from the config's `agentDefaults`. One that can't be used counts as not set, with one log line |
| `desk.member.purge` | `{memberId}`, a `gm-` id; refused (`forbidden`, `permission`) from any frame carrying a `caller` | `{purged, agents, messages, files, usage, staged}`, counts | A guild member left, was removed or deleted their account (ADR 0080's addendum of 2026-11-10). Their run is stopped and awaited (else `conflict` `busy`, nothing deleted); their agent, thread, files' notes and limits go from `agent.db`, their staged files are wiped, their usage rows become the guild's (`guild:departed`), and both files' WALs are emptied. Idempotent: again, it's all zeros. deskd keeps its own list and sends it until answered |

**Tool calls (S-14, the tools and approvals draft, section 11).** The other way round: desk-agent asks deskd to run a
tool for a run (Files, the Browser, Notebook), and deskd answers. deskd serves them in its package `tools`
(`ToolHost`), as the agent's owner by its own stamp from the agent's id, never anything in the frame.

| From | `t` or `m` | Fields | Meaning |
|---|---|---|---|
| deskd | `req` `desk.tools.hello` | `{v: 1, tools: [names]}`, no `caller` | On each connection: the tools deskd runs now (Notebook only on a guild desk). desk-agent answers `{}`, and sends no `tcall` before it; an older desk-agent answers `not_found` and the link stays. A hello with a `caller` is refused |
| desk-agent | `tcall` | `id`, `runId`, `agentId`, `tool`, `args`, `taint`, and `phase: "look"`, or `approval: {approvalId, sha256}` and `context` | One call. `look` classifies it with nothing done. `taint` is the run's flags (`U`, `S`); deskd adds them to its own copy and never removes any. `tool: "run_end"` says a run ended |
| deskd | `tres` | `id`, `r`, `taint` | A look: `r` is `{risk, context, target, payload, before, refusal}`. A run: `{content, taints, risk}` and the area's chip words (`session`). `taint` is the run's flags as deskd now holds them |
| deskd | `terr` | `id`, `code`, `details: {reason}` | A deskd error code and one word: `approval_required`, `approval_unknown`, `approval_used`, `approval_mismatch`, `scope`, `age_band`, `member`, `run`, `tool`, `changed`, `gone`, `exists`, `off_site`, `sensitive`, `no_space`, … Never content |

- **What deskd checks** before an area runs anything (`ToolHost`): the tool is one it declares (`HostedDecls`), the
  area is there and allowed (a guild desk has Notebook only), the desk's owner or the member is an adult, the run is
  that agent's; its own class for the call (never below the declaration's, raised by what the area finds, and the
  Rule of Two); and for a class that asks, the approval: the SHA-256 of the canonical JSON of `{v: 1, agentId, runId,
  tool, context, payload}` over the arguments it received and its own context, equal to the call's, redeemed once
  against the decisions deskd relayed (`ApprovalTickets`).
- **Waits:** a look 15 s, a call 60 s; then desk-agent answers the model "Failed: unavailable." A call waiting when
  the connection goes gets the same. At most 16 calls run at once in deskd (`rate_limited` past that) and 32 wait per
  connection in desk-agent.

**Version skew.** Both sides drop the link on a `t` they don't know (`AgentSocketServer.onJson`, `AgentLink.dispatch`),
so neither can announce anything with a new one. desk-agent answers `not_found` to a method it doesn't know, and that's
why these are `req`s: an older desk-agent answers that, the link stays up, and deskd sends no more until the next
connection. An older deskd sends none, and desk-agent stays on its bundled table with no account values.

**The mapping, method by method.** Every `agent.*` method relays as `req` with the same `m` and `p`. The second
column is all deskd does besides checking the session, `idem` and the rate limit as for any RPC.

| Client | deskd, besides relaying | desk-agent |
|---|---|---|
| `agent.providers` | | Its adapters: id, name, console, key prefix |
| `agent.list` | | Agents with live status, badge and unseen count |
| `agent.create` (mutation) | `beginEffect()` | `precondition_failed` + `agent_cap` in Phase 1, which has the manager only (design 9.2) |
| `agent.update` (mutation) | `beginEffect()` | Name, `badgeHidden`, `dismissBadgeNotice` |
| `agent.bind` (mutation) | `beginEffect()` | Checks the key exists and is that provider's; sets `badgeNotice` if the provider changed while hidden |
| `agent.thread.get` | | A page of the thread, the newest or with `before` older ones, `older`, and the topic's `seq` |
| `agent.message.send` (mutation) | `beginEffect()` | Refuses only `no_key`, `busy`, `limit_reached`; else stores the member's message and a `streaming` reply, returns `{messageId, runId}`, and streams on the topic |
| `agent.run.stop` (mutation) | `beginEffect()` | Stops the call; the reply ends `stopped` |
| `agent.seen` | | Clears the agent's unseen count |
| `agent.key.list` | | Key metadata, with `available`: never the key |
| `agent.key.add` (mutation) | Takes `secret` out of `p`, checks it's 8 to 1024 printable ASCII with no space (else `bad_request` + `key_malformed`), `beginEffect()`, sends the KEY frame | The free model-list call: `precondition_failed` + `key_refused` + `auth` if refused; else seals the key durably (`unavailable` + `storage` if it can't, keeping nothing), adds its metadata row, holds it in RAM, returns `{key}` |
| `agent.key.delete` (mutation) | Later: `step_up_required` | Drops its metadata and unbinds agents on it, zeroes the key, unlinks its sealed file, then answers |
| `agent.key.models` | | The provider's model list, with listed prices from the table in use, null for a model it doesn't list |
| `agent.limits.get`, `agent.limits.set` (mutation) | `beginEffect()` for set. Params go as they came, explicit nulls included | `LimitSettings` and the ledger's use this period, in the member's zone (`API.md` §11) |
| `agent.audit.list` | | A page of the audit log, newest first, and the chain's head |
| SUB `agent.state` | `sub` | A snapshot of every agent on each change |
| SUB `agent.conversation:<agentId>` | `sub` | `snapshot`, then `message` and `delta` |

- **Heartbeat:** deskd subscribes to `agent.state` itself (its own `sid`) for the heartbeat's `agent.status`,
  `agent.activeTasks` and badges, which it reports as `offline` today.
- **A key lasts** (ADR 0042, which replaces the KMS envelopes this section once planned): desk-agent seals it on the
  desk's own disk and unseals it at each start, so deskd sends nothing back after a reconnect, and there's no
  `agent.key.restore` frame.
- **The key in deskd** arrives in the client's JSON, so jackson-jr makes it a `String` before deskd sees it. ADR 0040
  accepts that; a binary RPC part would remove it. What deskd can do it does: the request's parse keeps no pooled
  buffer, and the KEY frame goes out from a direct buffer zeroed after, not NIO's cached one (ISS-20,
  `docs/sub-status/iss20-key-zeroing-finding.md`).

## 6. The client's interface, TD-68 (UI/UX Engineer, with task 07)
**Adopted as task 07 proposed it** (`sub/agent-ui`, `web/agent/README.md`, "Interface", and `web/agent/src/client/
types.ts`), with no changes. It already uses this code's words and units: provider ids, `ManagerAgent.Status`,
`Scope` wire names, µ$, `Usage`, `Badge`, `AgentException.Code` and the audit row camelCased. Its two asks:
- **Ask 2, limits:** `deskMonth` and `keyMonth` are per desk. `LimitSettings` keeps the agent's five values per agent
  and those two once; every agent's `LimitPolicy` shows the desk's, and `agent.limits.set` on any agent sets the
  desk's two for all.
- **Ask 3, failed runs:** `agent.message.send` fails only with `no_key` (`precondition_failed`), `busy` (`conflict`)
  and `limit_reached` (`precondition_failed` with `details.scope`), all before anything is added to the thread. Once
  it has returned, the reply message ends `done`, `stopped` or `failed`. A provider's failure is `failed` with
  `error: "provider_error"` and `errorDetail` its kind (`auth`, `rate_limited`, `unavailable`, `bad_request`,
  `timeout`, `cancelled`, and OpenRouter's `free_limit` and `data_policy`, 2026-11-11). What isn't the member's to fix (no adapter for the provider, the records failing) is
  `failed` with `error: "unavailable"` and a word in `errorDetail`, which 07's `AgentErrorReason` already has.

## 7. Design and ADRs (System Engineer, Desk Engineer)
`STATUS.md` lists each conflict between the older ADRs and ADR 0040 with its default. The replacement for ADR 0018 is
the Desk Engineer's to write (`CLAUDE.md`, Stack). This milestone's evidence for it: the spike in
`spikes/spring-ai-footprint/`.

## 8. deskd's relay of `agent.*` (Desk Engineer)
**Done on `sub/deskd-agent-relay`** (`services/deskd`, package `agent`; `API.md` section 11), as below, with these
differences. deskd holds one desk-agent subscription per topic and fans it out through its event hub, rather than one
per client SUB, since deskd's topics publish by topic. A link drop sends clients a fresh `snapshot` once it's back, not
`resync`. Events too large for an EVT are split or cut (`EventFit`). Badges aren't reported yet.

The change in `services/deskd` that section 5's mapping needs. desk-agent's side is built and tested on this branch
(`socket/AgentSocketServer`, `DeskAgentSocketTests`); two clients of it exist to copy from, `training/TrainingClient`
(synchronous, 100 lines) and the tests' `testing/AgentSocketClient`.
- **A new package `agent` in deskd:**
  - `AgentLink`: the client of `deskd.agent.socket` (default `/run/desk-agent/agent.sock`). Section 5's framing: write
    `u32be length (of what follows) | u8 0x01 | JSON`; read the same. One reader thread that only queues, as
    `RtcClient`'s, reconnect with backoff from 250 ms to 5 s, a request id per call (`id`, a JSON number) and a
    subscription id per client SUB (`sid`). A call with no link answers `unavailable`, `details.reason:
    "unavailable"`. A drop ends every relayed subscription with deskd's `resync`, so clients subscribe again.
  - `AgentMethods`: section 5's table, registered in `DataPlaneConfiguration`. Reads with `dispatcher.register`,
    mutations with `registerMutation`, calling `context.beginEffect()` right before the `req` goes out. Each sends
    `{"t":"req","id":n,"m":"<method>","p":<params as received>}` and answers the client with `r` as the RES, or with
    `code` and `details` as the ERR, unchanged. A client CANCEL sends `{"t":"cancel","id":n}`. Deadlines: 30 s for
    `agent.key.add` and `agent.key.models` (they call the provider), 10 s for the rest.
  - `agent.key.add` is the one that differs: it takes `secret` out of the params, checks it is 8 to 1024 bytes of
    printable ASCII with no space (else ERR `bad_request` with `details: {reason: "key_malformed", detail:
    "format"}`), and sends the KEY frame: `u32be length | u8 0x02 | u32be id | u16be n | JSON {"m":"agent.key.add",
    "p":{"provider","label","deskId"}} (n bytes) | u16be k | the key (k bytes)`. `deskId` is this desk's id, which
    desk-agent can't know. It zeroes its own copy of the bytes after the write.
  - `AgentTopics`: `topicRegistry.register` for `agent.state` and the prefix `agent.conversation:`. A client's SUB
    sends `{"t":"sub","sid":n,"topic":"..."}`; each `{"t":"evt","sid":n,"topic","seq","type","data"}` goes to that
    session as an EVT of that `type` (`snapshot`, `message`, `delta`), with `data`'s fields and `seq`, as task 07's
    `RpcAgentClient.watchConversation` reads them; UNSUB or the session's end sends `{"t":"unsub","sid":n}`. These
    topics serve no `since`: a SUB always gets a snapshot, as `browser.tabs` does. An `evt` of type `error` (an
    unknown topic) ends that subscription with `not_found`.
- **Permissions:** every `agent.*` call needs an `owner` token, as today's tokens are. Support sessions get none
  until design 4.2.12's grants exist.
- **Settings:** `DESKD_AGENT_SOCKET` in `deskd.env` and `services/CLAUDE.md`'s table, and
  `-v /run/desk-agent:/run/desk-agent` in deskd's `run` (and the flag list in `desk-runtime.md` section 5).
- **Heartbeat:** `HeartbeatLoop` takes `agent.status` and `agent.activeTasks` from deskd's own `agent.state`
  subscription (a `sid` of its own) instead of `offline`: the manager's `status`, and 1 task while it's `working`.
- **Tests:** a fake agent socket in `testing/`, as `FakeDeskRtc` is for `rtc.sock`, and one `RealDeskAgentIT` that
  runs the real desk-agent jar, as `RealDeskRtcIT` runs the real `desk-rtc`.
- **Docs:** `API.md` gains a section with task 07's table (`web/agent/README.md`, "Interface").
