# Many agents on a desk: the interface (task 49, ADR 0047)

The client's side of task 49's `agent.*` additions, as desk-agent serves them and deskd relays them one to one
(`services/deskd/docs/API.md` section 11). The Agent app (`web/agent/`) and the Desk app's agent tiles build against
this file. Every name here is a wire name. Everything an agent or a member wrote (names, purposes, rules, prompts, file
contents, messages) is untrusted text and renders as text only.

## 1. Agents

The desk's first agent, id `manager`, is the **lead**. It can't be deleted. Its wire `role` stays `manager`, so older
clients and deskd keep working; `lead: true` marks it, and the UI calls it the lead. Its default name is `Lead` (a desk
whose manager still has the old default name `Manager` is renamed `Lead` once, by the migration). Other agents are
`role: staff`, with ids `ag-` and 12 lowercase base32 characters.

### Agent, as `agent.list`, `agent.get`, `agent.create` and `agent.update` answer it

```json
{
  "id": "ag-3k9x0d2m4q1z", "name": "Researcher", "role": "staff", "lead": false,
  "status": "online", "statusDetail": null,
  "binding": { "keyId": "…", "provider": "anthropic", "providerName": "Anthropic", "model": "claude-sonnet-4-5" },
  "badgeHidden": false, "badgeNotice": false, "unseen": 0,
  "purpose": "Find sources for the member's questions and keep notes in the workspace.",
  "look": { "icon": "compass", "tone": "teal", "png": null },
  "solo": false,
  "links": [ { "to": "ag-7m2…", "rules": "Ask only for summaries. Never forward the member's notes." } ],
  "workspace": { "quotaBytes": 52428800, "usedBytes": 18233, "sharedWith": [] },
  "timers": 1,
  "createdAt": 1762600000000
}
```

| Field | Meaning |
|---|---|
| `purpose` | The agent's instructions, up to 4000 characters. `""` uses the built-in default for its role |
| `status`, `statusDetail` | `online`, `offline`, and so on as before; `paused` with `statusDetail: "agent_cap"` for an agent over the desk's cap (section 2) |
| `look.icon` | One of the 24 icon ids (section 7), or `png` when the member uploaded one. Default `spark` |
| `look.tone` | One of the 12 tone ids (section 7). Unknown ids render as the neutral tone. Default: see "Names and looks" |
| `look.png` | The upload's version, a counter, or `null`: a client refetches `agent.icon.get` when it changes |
| `solo` | `true` (the default): the agent **sends** no messages to other agents. It still receives from any agent whose link names it, under that link's rules |
| `links` | Which agents this one may message, each with the member's rules of engagement, 1 to 500 characters, in the order the member gave them |
| `incoming` | `agent.get` only: `[{from, rules}]`, the links into this agent from other agents |
| `workspace` | Its folder's quota and use, in bytes, and the agents the member shared it with, read only. The quota is the one in force: stored at create, held to the tier's `workspaceMaxMb` |
| `timers` | How many timers it has |

`agent.state`'s snapshot is smaller, so it fits one event (64 KiB) with many agents: each agent without `purpose`,
`workspace` or the rules' text (`links` is `[{to}]`), plus `caps` (section 2).

### Names and looks

- **Names are unique on a desk.** They are compared after NFKC, case folding, trimming and removing format characters,
  with Cyrillic and Greek look-alikes mapped to Latin. A name may not equal any agent's id. A clash is `bad_request`,
  `detail: "name"`, `reason: "name_taken"`, at `agent.create`, `agent.update` and when the lead proposes.
- **Hidden characters** (Unicode format and bidi controls, also Hangul fillers; a zero-width joiner between two emoji is
  allowed) are refused in names, purposes, rules, timer labels and prompts, and in workspace paths: `bad_request`,
  `detail` the field, `reason: "hidden_chars"` (paths: `detail: "path"`).
- **Without a `tone`,** a create takes the first tone in wheel order that no agent on the desk uses, skipping `graphite`;
  when all are used, the least used one (wheel order breaks ties). Without an `icon`: `spark`.
- **Retired ids** are mapped wherever one comes in (create, update, proposals) and migrated once at open: tones
  `moss` to `green`, `sky` to `blue`; icons `globe` to `plane`, `chat` to `person`, `heart` to `wallet`, `star` to
  `bulb`, `puzzle` to `terminal`, `briefcase` to `document`.
- **Team methods refuse a guild member's agent id** (`gm-*`) everywhere; for guild members deskd refuses every team
  method but `agent.get` (`forbidden`, `reason: permission`).

### Methods

| Method | Params | Answer | Refusals |
|---|---|---|---|
| `agent.get` | `{agentId}` | `{agent}` | `not_found` |
| `agent.create` | `{name, purpose?, icon?, tone?, keyId?, model?, solo?, workspaceMb?}` | `{agent}` | `precondition_failed` `reason: agent_cap`, `disk_budget`, `disk_low`; `bad_request` with `detail` the field, `name_taken`, `hidden_chars` |
| `agent.update` | `{agentId, name?, purpose?, icon?, tone?, solo?, workspaceMb?, badgeHidden?, dismissBadgeNotice?}` | `{agent}` | `bad_request` with `detail`, `name_taken`, `hidden_chars`; `precondition_failed` `reason: workspace_full` when a smaller quota is under its use, `disk_budget` when a larger one passes the desk's budget (section 5) |
| `agent.delete` | `{agentId}` | `{}` | `bad_request` `detail: lead`; `conflict` `reason: busy` while it runs |
| `agent.links.set` | `{agentId, solo, links: [{to, rules}]}` | `{agent}` | `bad_request` `detail: links` (self, unknown agent, duplicate, rules empty or over 500) |
| `agent.caps` | `{}` | `{caps}` | |

`agent.bind`, `agent.message.send`, `agent.thread.get`, `agent.seen`, `agent.run.stop` and the limits now work for
every agent, not only the manager. Deleting an agent removes its thread, workspace, timers, icon, its links both ways
and its limits; the audit log and the agent-message log keep their rows.

## 2. Caps: the tier's defaults, as the desk applies them

`agent.caps` answers, and `agent.state` carries:

```json
{ "agentCap": 10, "agents": 3, "workspaceMb": 50, "workspaceMaxMb": 200, "timersPerAgent": 5,
  "timerMinMinutes": 15, "a2aPerHour": 20, "a2aDeskPerHour": 80, "a2aDepth": 3, "a2aSpendPct": 25, "runsAtOnce": 4,
  "workspaceTotalMb": 150, "workspaceBudgetMb": 40000,
  "rulesMax": 500, "purposeMax": 4000, "promptMax": 2000, "iconMaxBytes": 262144, "iconMaxPx": 512 }
```

The tier's values come from the Platform (`agentDefaults.tier` in the desk's config; ma-platform `tiers.md`), set in
the Management Console's Prices/limits per tier. deskd hands them over in `desk.account.set` as `tier`. The example
shows **Alliance's** values, which are also the built-in defaults: desk-agent holds them until it is told a tier. The
last tier received is kept in `agent.db` (setting `account.tier`) and used when deskd sends none; a missing or null tier
changes nothing. deskd likewise keeps the last tier when the Platform's config has none. `agentCap` counts every agent,
the lead included. `a2aDeskPerHour` is 4 times `a2aPerHour`. `workspaceTotalMb` is the sum of every agent's quota and
`workspaceBudgetMb` is 50% of `/data`'s size (section 5).

**Paused agents.** If the cap falls below the number of agents, the oldest keep running (the lead is never counted out).
The rest show `status: "paused"`, `statusDetail: "agent_cap"`, and their runs are refused `precondition_failed`,
`reason: "agent_cap"`. Nothing is deleted; raising the cap or removing agents brings them back.

**The member's age band.** deskd sends `band` (`adult`, `teen`, `unknown`) in `desk.account.set`, on every settle.
desk-agent assumes `adult` until told otherwise (deskd always tells it at start). While the band is not `adult`, no timer
fires (due timers wait, `lastState: "paused"`; when it is adult again a one-shot under a day late runs once and a
repeat skips to its next time) and message-started runs are refused `age_band`. The last band is kept in `agent.db`
(`account.band`).

**Run slots.** The desk runs 4 runs at once. Timer-started and message-started runs stop at 3 of the 4, so one slot is
always free for the member. On a Guild Desk, guild members' runs never count against the owner's.

## 3. The lead sets agents up: proposals

The lead has tools to read the desk's agents and the choices (icons, tones, models on the member's keys, the caps), and
to **propose** changes. A proposal never applies itself: it shows in the lead's thread as a card on the reply that made
it, and applies only when the member says yes.

A reply's `proposals`:
```json
{ "id": "pr-…", "action": "agent.create", "summary": "Create “Researcher”, compass on teal, Claude Sonnet",
  "payload": { … }, "sha256": "hex of the payload's canonical JSON", "state": "pending",
  "origin": { "kind": "member" }, "before": null,
  "detail": null, "answeredAt": null, "expiresAt": 1762686400000, "result": null }
```

| `action` | `payload` |
|---|---|
| `agent.create` | `{name, purpose, icon, tone, keyId?, model?, solo?, workspaceMb?, links?: [{to, rules}], timers?: [timer]}` |
| `agent.update` | `{agentId, name?, purpose?, icon?, tone?, keyId?, model?, workspaceMb?}` |
| `agent.delete` | `{agentId}` |
| `agent.links` | `{agentId, solo, links: [{to, rules}]}` |
| `timer.set` | `{agentId, timer}` (section 6; with `id` to change one) |
| `timer.delete` | `{agentId, timerId}` |

- **`origin`** says what started the lead's run that made the proposal: `{"kind":"member"}`,
  `{"kind":"agent","agentId","name"}` or `{"kind":"timer","agentId","timerId","label"}`. The Agent app stamps a
  non-member card "Suggested while answering {name}" or "Suggested by the timer {label}". Rows from before the fix show
  `{"kind":"member"}`.
- **`before`** is the state of what the proposal changes, read when it was made (not part of the hash): `agent.update`,
  the current values of the payload's fields, plus `usedBytes` when `workspaceMb` is there; `agent.links`,
  `{solo, links}`; `timer.set` with an id and `timer.delete`, `{timer}` (the full timer view); `agent.delete`,
  `{name, look: {icon, tone, png}, usedBytes, timers: [timer views], links: [{to, rules}], incoming: [{from, rules}]}`;
  `null` for a create.
- **Checked whole, applied whole.** A proposal is checked before anything is written (timer ids refused in a create,
  duplicate links, link targets, the key, the caps, a one-shot already past), then applied whole, or a create is undone.
  It is never left `applying`: rows left `applying` by a restart become `failed`, `detail: "internal"` at start.
- **Caps:** 10 pending proposals per desk and 5 per run: `precondition_failed`, `reason: "proposal_cap"` (the lead's tool
  error says so).
- **A change keeps the agent's own key.** A `model` must be one the key's provider lists: `bad_request`,
  `detail: "model"`, `reason: "unknown_model"`, at proposal time. A workspace size passing the budget is `disk_budget`
  at apply.
- **The lead's tools take ids.** A name is accepted only when it matches exactly one agent; an ambiguous name is
  `bad_request`, `detail: "agent"`, `reason: "ambiguous"`. `desk_agents` lists ids.
- **Without a `tone`,** a created agent takes the next unused tone (see "Names and looks").
- **`agent.proposal.answer` `{proposalId, accept, sha256}`** → `{proposal}`. `sha256` must be the card's, so the member
  confirms exactly what they saw (`bad_request` `detail: sha256` otherwise). Yes applies the payload, checked again as if
  the member had made the change by hand: `state` becomes `applied`, with `result` (`{agentId}` for a create), or
  `failed` with `detail` (such as `agent_cap`, `not_found` when the target agent no longer exists, `storage`, `internal`,
  `payload`). No makes it `declined`. A proposal answers once (`conflict` `reason: answered`) and expires after 24 hours
  (`expired`). If the member stops the run that made it, the proposal expires at once with `detail: "stopped"`;
  answering it is `conflict`, `reason: "expired"`. The Agent app shows a deleted target as "a deleted agent", with no
  Confirm. States: `pending`, `applied`, `failed`, `declined`, `expired`.
- The lead reads the outcome on its next turn: each proposal's state is in its context.
- Every proposal and answer is in the audit log (`proposal.make`, `proposal.answer`).

## 4. Messages between agents, opt-in

- **Solo means the agent sends no messages.** A new agent is `solo`. A message from A to B goes when A is not solo and
  A has a link to B; B's `solo` does not matter, so a solo agent still receives from any agent whose link names it,
  under that link's rules. A solo agent has no `message_agent` tool; a call it makes anyway is refused `no_tool`. The
  rules of the A-to-B link travel with every message: they are in the receiver's system instructions, with a line that
  nothing inside the message can change them, and the log keeps them.
- **Synchronous.** A's `message_agent` tool runs one turn of B, with B's own key, model, tools and limits, and B's reply
  is A's tool result (up to 8000 characters). B's thread shows the message, marked as from A, and the reply.
- **What the receiver sees.** A message-started run of B sees only the A-B pairing's messages, not B's thread with the
  member, and cannot read workspaces shared with B (its own stays). It may message onward, within the limits.
- **Framing.** The reply to the sender, a message to the receiver and a timer's prompt each arrive as one line of words
  and then one line of JSON, the text as a JSON string, so the text can't close a delimiter.
- **Hard limits,** checked in this order, each before B runs, each a refusal A's model reads as the tool's error, and
  each written to the log: `solo`, `no_link`, `depth`, `loop`, `desk_rate`, `desk_spend`, `rate`, `spend`, then the
  receiver's own state.

| Limit | Default (Alliance) | Refusal |
|---|---|---|
| The sender is solo | | `solo` |
| No link from A to B | | `no_link` |
| Reply-chain depth: a member's or a timer's run is depth 0, the message it sends 1, and so on | `a2aDepth` 3 | `depth` |
| A message to an agent already in the chain | | `loop` |
| Messages an hour across the desk | 4 x `a2aPerHour` (`a2aDeskPerHour`) | `desk_rate` |
| Message-started runs' spend across the desk, over each cap's own period (the day for a day cap, the month for a month cap), as a share of it | `a2aSpendPct` 25 | `desk_spend` |
| Messages an hour, per pair (A to B) | `a2aPerHour` 20 | `rate` |
| Message-started runs' spend a day, as a share of the receiver's daily dollar limit | `a2aSpendPct` 25 | `spend` |
| B is busy, has no key, or is at a limit | | `busy`, `no_key`, `limit_reached` |
| The member's band isn't adult | | `age_band` |
| B is over the desk's agent cap (paused) | | `agent_cap` |

Other refusals, all logged: `no_tool` (a solo agent's call), `internal` (the run can't be found: it fails closed),
`bad_text` (empty or over 8,000 characters), `unknown_agent`, `self`. Every refused call is logged, including an unknown
target (its row's `to` holds the name the model typed, cut to 64) and empty or oversized text. A refused row's `text`
is cut to 500 characters plus "…".

- **The spend share** with no dollar day cap is taken of the next dollar scope that exists: the receiver's week, then
  month, then the desk's day, then month. With no dollar scope at all, `spend` refuses. The message-started run is
  reserved against what is left of the share and capped at it; stopped and failed runs count.
- **After 3 refused `message_agent` calls in a row,** the tool closes for the rest of that run (no more log rows); the
  run itself goes on.
- **`agent.a2a.list` `{agentId?, before?}`** → `{messages, older}`, newest first, 100 a page, every message to or from
  that agent (or all), each `{id, from, to, chainId, depth, text, rules, at, state, reason, reply, costMicroUsd}`.
  `state` is `delivered`, `replied`, `failed` or `refused` with `reason`. Kept 100 days; the log is pruned daily.

## 5. A workspace per agent

`/data/agent/workspaces/<agentId>/`, with a quota per agent. Private to its agent; the member can share it, read only,
with chosen agents. An agent's tools reach only its own folder and those shared with it, and an agent may name its own
workspace by name or id. Paths are relative, `/`-separated, with no `.` or `..` component, no NUL, no Unicode format or
bidi character (`bad_request` `detail: path`), at most 16 deep and 1024 bytes; every component is checked as a real
directory or file with symbolic links not followed, so a link placed in a workspace leads nowhere. A file with more than
one hard link is refused on read and write (`bad_request` `detail: path`) and left out of listings. Text files only,
UTF-8.

**Size and space.**
- **The quota** is stored when the agent is created: the member's `workspaceMb`, or with none, the smaller of the tier's
  default and what is left of the budget, at least 10 MB. It is held to the tier's `workspaceMaxMb` at every use, and
  views show the held value; lowering the tier's default never shrinks an agent that exists.
- **The budget:** the sum of every agent's quota may not pass **50% of `/data`'s size**. A create, a raise (also clearing
  an agent's own size back to the tier default) and a proposal's apply that would pass it are refused
  `precondition_failed`, `reason: "disk_budget"`; under 10 MB left is `disk_budget` too. `agent.caps` carries
  `workspaceTotalMb` and `workspaceBudgetMb`.
- **The floor:** writes (and a create) are refused below **1.5 GiB free** on `/data`: `precondition_failed`,
  `reason: "disk_low"`. (This replaces the earlier `disk_full` and its 512 MiB floor.)
- **Counting:** every file and folder counts at least 4 KiB in `usedBytes`; at most 2,000 folders a workspace
  (`precondition_failed`, `reason: "too_many_folders"`), 10,000 files (`too_many_files`).

| Method | Params | Answer |
|---|---|---|
| `agent.workspace.get` | `{agentId, path?}` | `{quotaBytes, usedBytes, sharedWith, entries: [{path, dir, bytes, modifiedAt}], more?}` (a folder's entries, 500 at most; `more: true` when there are more) |
| `agent.workspace.read` | `{agentId, path, offset?, length?}` | `{path, text, bytes, truncated, offset, remaining}` |
| `agent.workspace.delete` | `{agentId, path}` | `{usedBytes}` |
| `agent.workspace.share` | `{agentId, with: [agentId]}` | `{agent}` |

`offset` and `length` count characters. A page is 128 Ki characters by default and at most; `remaining` is how many
characters are left after it, and `truncated` is true while some are.

Refusals: `bad_request` `detail: path`, `not_found` `detail: path`.

**Refused writes reach the thread.** A `workspace_write` that is refused for space puts `{path, reason}` on the reply's
chip, and the message view carries `workspaceRefused: [{path, reason}]`, the reasons being `workspace_full`, `disk_low`,
`too_many_files`, `too_many_folders`. The Agent app shows "Couldn’t save {file}: the workspace is full."

## 6. Timers

A timer is one-shot or repeating, in the member's time zone (the zone the limits use), and starts a run of its agent
with its prompt. Its runs count toward every spending limit, as any run does.

```json
{ "id": "tm-…", "label": "Morning brief", "kind": "repeat",
  "days": [1, 2, 3, 4, 5], "time": "08:00", "everyMinutes": null, "at": null,
  "prompt": "Summarise yesterday's notes in the workspace.", "enabled": true,
  "zone": "America/Denver", "nextAt": 1762610400000, "lastAt": null, "lastState": null,
  "spentMicroUsd": 0, "createdAt": 1762600000000 }
```

- `kind: "once"` takes `at` (epoch ms, within a year) or, when setting, `inMinutes`. `kind: "repeat"` takes either
  `days` (1 Monday to 7 Sunday; days outside 1 to 7 are refused) and `time` (`HH:MM`, 24-hour, the member's zone), or
  `everyMinutes`. A time a clock change skips runs at the first instant after it.
- **Limits at fire time.** An interval under the tier's `timerMinMinutes` runs at the minimum. Timers beyond
  `timersPerAgent` (oldest kept) don't fire: `lastState: "over_cap"`. The desk as a whole may hold `agentCap` x
  `timersPerAgent` timers. Fire, end, set and delete re-read the timer's row under one lock.
- **`lastState`** is `null` (never run), `ok`, `failed`, `busy`, `no_key`, `limit_reached`, `missed`, `paused` (the
  member's band isn't adult) or `over_cap`.
- **Methods:** `agent.timer.list` `{agentId}` → `{timers, zone}`; `agent.timer.set` `{agentId, timer}` → `{timer}` (with
  `timer.id`, a change); `agent.timer.delete` `{agentId, timerId}` → `{}`. Refusals: `bad_request` `detail` the field;
  `precondition_failed` `reason: timer_cap`; `hidden_chars` in a label or prompt.
- **A change of zone** (the member's, or the account's that deskd sends after desk-agent starts) moves the next time of a
  days-and-time timer to the same clock time in the new zone, at once; an interval timer has no zone.
- **Kept in `agent.db`,** so they survive restarts. A one-shot timer missed while desk-agent was down (or held while the band wasn't adult) runs once at start if it's
  under a day late, else ends `missed`. A repeating one skips to its next time.
- **When it fires** the agent's thread gets the prompt as a message marked from the timer, then the reply. Busy, no key
  or a limit: `lastState` says so (`busy` retries a minute later, up to 10 times), and a one-shot timer ends. A timer's
  run stops at 3 of the desk's 4 run slots (section 2).

## 7. Looks: icons, tones and uploads

- **Tones,** 12 ids in wheel order: `graphite, rose, clay, amber, olive, green, teal, cyan, blue, indigo, violet, plum`.
  `graphite` is the neutral default.
- **Icons,** 24 ids in this order: `spark, compass, book, pen, calendar, clock, chart, code, mail, person, search, leaf,
  flask, document, music, camera, plane, shield, wallet, bulb, home, bell, list, terminal`. The drawings and tone values
  are in `web/agent/src/look/`; `LookIdsTest` keeps the Java and web lists equal.
- **Library:** `agent.update {icon: "<id>"}`.
- **Upload:** `agent.icon.upload` `{agentId, png}`, `png` in base64. desk-agent decodes it as a PNG (every chunk's CRC,
  the image data inflated and unfiltered), refuses one over 256 KiB or 512 by 512 pixels, and keeps only a mask. The
  mask's coverage comes from alpha, or for an image with no transparency from the distance of each pixel from the median
  brightness of the border; coverage under 24 is 0; levels are stretched so the 98th percentile is full; the shape is
  trimmed and centred in a **square** with an 8% margin (smaller for a shape over about 430 px), at most 512 px. It is
  re-encoded as a new PNG (white, with that coverage as alpha) with no other chunks, so no metadata survives. Refusals:
  `bad_request` `detail: png` with `reason` `not_png`, `too_large`, `too_many_pixels`, `corrupt`, `no_shape` (nothing
  left after trimming) or `too_thin`. The Agent app scales a PNG over 512 px down to 512 before sending.
- **`agent.icon.get`** `{agentId}` → `{png, version}`. Like every `agent.*` method, deskd answers it for the desk's
  owner only. The client fits the mask into a square and renders it in the standard foreground on the agent's tone.

## 8. Tools the agents have

| Tool | Who | What |
|---|---|---|
| `workspace_list`, `workspace_read`, `workspace_write` | Every agent | Its own workspace, and read-only those shared with it (`workspace`: the owner agent's id or name). `workspace_read` takes `offset` and `length` (64 Ki characters by default, 128 Ki at most) and says how many characters remain. A run started by a message sees only its own workspace |
| `message_agent` | An agent with links that is not solo | Section 4. The tool's description lists whom it may message and each pairing's rules |
| `desk_agents`, `desk_choices` | The lead | The agents (no keys, threads or workspaces), and the icons, tones, models on the member's keys and the caps |
| `propose_agent`, `propose_agent_change`, `propose_agent_removal`, `propose_links`, `propose_timer`, `propose_timer_removal` | The lead | Section 3 |

The lead's instructions say: the desk is the member's at Minimalist Alliance; tools take ids; names and looks are unique
(with the caps and the card's origin); a change keeps the agent's key; solo sends no messages; and spending limits,
workspace sharing and uploaded icons are the member's to set in each agent's settings, so tell them where.

Tool calling works with every provider desk-agent has: Anthropic's Messages API (`tool_use`, `tool_result`) and the
Responses API for OpenAI and xAI (`function_call`, `function_call_output`). A run's steps (model calls) are capped by the
run limit (50 by default), and each step reserves against every limit before it goes.

### Runs: how they end, and the provider details that show

- **Cut off or refused.** A step that stops on the output cap (`max_tokens`, `incomplete`, the context limit; an empty
  reply that used its whole cap counts too) ends the run `failed` with `error: "cut_off"` before any tool runs. A model
  refusal (including OpenAI's refusal part, `response.refusal.*` and `content_filter`) ends it `failed` with
  `error: "refused"`. Both keep the text said so far, and `errorDetail` is null. The Agent app says "The reply was cut
  off at its length limit." and "The model declined to answer."
- **Later turns** read "[Done: …]" (tool names and outcomes only) after a reply that used tools. Text is cut by code
  point, never in the middle of a character.
- **Cost.** A failed step's kept reservation is added to the run's cost. xAI reserves 4 times the output cap and settles
  on the larger of `output_tokens`, `total_tokens` less input, and output plus reasoning; reasoning is never clamped to the
  output.
- **Responses API** (OpenAI, xAI): `store: false`, encrypted reasoning replayed before the call it led to; reasoning
  effort `medium` by default, set per model, and no `reasoning` field to a model that doesn't reason. **Anthropic:** one
  cache breakpoint on the last system block (or the last tool).
- **Idle watchdog:** 10 minutes while a reasoning model hasn't started text or a call, 90 seconds otherwise.
- **After 3 refused `message_agent` calls in a row** the tool closes (section 4).
