# Draft. The Agent's tools and approvals at launch

**Status:** Proposed (draft; the System Engineer assigns a number, as the Desk range 0041 to 0049 is full)
**Date:** 2026-11-11
**Decision:** the owner, about 2:35 am MT Nov 11, through the Lead, asked whether the Agent at launch has tools,
approvals and memory, not just chat: "Yes, all three".
**Builds on:** [0018](0018-agent-framework-ai-sdk.md) (as amended by 0040),
[0019](0019-agent-safety-policy-point.md), [0020](0020-agent-runs-and-usage-limits.md),
[0035](0035-browser-session-is-carried-over.md), 0043, [0045](0045-unseen-desks-freeze.md), 0046 (the walker and action
proxy), 0047 (many agents, proposals), 0080 (Guild Desk), 0090 (free tier); design §9.6, §9.7, §9.10.
**Contract:** `services/deskd/docs/API.md` §18, "Agent tools and approvals" (draft protocol).

## Context
- **Built:** desk-agent's run loop (`manager/ManagerAgent`: 50 steps and $2 a run, 16 calls a step, results cut at
  20,000 characters, chips `{name, summary, ok}`); tools for the agent's own workspace, `message_agent` under the
  member's links, and the lead's `desk_*` and `propose_*` (`team/TeamTools`); proposals, a card bound to the SHA-256 of
  its payload's canonical JSON that applies only on the member's yes (`services/desk-agent/docs/multi-agent.md` §3), the
  pattern approvals reuse; the hash-chained audit log (`audit/AuditLog`); deskd's walker and action proxy for the
  simplified view (task 47, `API.md` §14), which design §7 says the Agent's browser tools share.
- **Not built** (desk-agent `README.md`, "Not built"): approvals, taint, durable runs, Browser, Files and Notebook tools.
  desk-notebook doesn't expose an agent edit path yet (`services/notebook/README.md`).
- Design §9.6 and §9.7 had classes and the Rule of Two before the Java rewrite and before deskd drove CDP itself. This
  fixes them against what's built.

## Decisions

### 1. A tool is a declaration in code
Every tool is one `ToolDecl` in one registry. A setting may switch a tool off; nothing may lower its class, widen its
scope or remove an approval (the rule Maia's tool registry has).

| Field | What |
|---|---|
| `name` | Wire name, `snake_case`, as the existing tools |
| `words` | The member-facing template, filled from the arguments by the desk, never by the model: "Save {path} in your Files" |
| `schema` | JSON Schema of the input; anything else is an error result before the policy looks |
| `scope` | One narrow scope from a closed list: `workspace:self`, `files:read`, `files:write`, `files:trash`, `notebook:read`, `notebook:write`, `notebook:trash`, `browser:agent`, `browser:member:<site>`, `agents:linked`, `timer:self`, `plan:self`, `memory:self` |
| `risk` | The class below; the floor for every call |
| `taints` | What its result adds to the run: `U` (untrusted), `S` (the member's private data), or nothing |
| `host` | `desk-agent` (runs in-process) or `deskd` (runs over the agent socket, §11) |

| Class | Means | Approval |
|---|---|---|
| `read` | Looks; changes nothing. Browsing in the agent's own signed-out context counts here (§5) | Never |
| `own` | The agent's own things: its workspace, its plan, its memory, messages to agents the member linked it to | Never, but the taint travels (§6); a memory under `U` asks |
| `write` | Changes the member's things: Files, Notebook, a timer, anything in their signed-in session | Always |
| `delete` | Moves the member's things to a trash. There is no permanent delete tool | Always |
| `send` | Delivers something to someone else: a form submitted, a post | Always |
| `spend` | May cost the member money | Always, each on its own card, never from an unattended run |
| `egress` | The member's data may reach a site, or the run gets the member's signed-in session | Always |

- **The class can rise per call, never fall.** `ToolPolicy` classifies each call: a click on a form's submit control is
  `send`; a click that looks like paying is `spend`; any browse action while the run holds both `U` and `S` is `egress`.
- **`own` is a seventh class, on purpose.** The owner's "writes" means the member's things. Asking before every note an
  agent keeps in its own workspace would turn every research task into a stream of cards, and a member trained to click
  yes is the attack. Its safety comes from the taint following the data instead (§6). If Security rejects this, `own`
  becomes `write` with one line in the registry.

### 2. The launch tools

**Files.** The member's Files (`/data/files`, through deskd's `files.*`), kept apart from the agent's workspace
(`/data/agent/workspaces/<agentId>`), which stays the agent's own. Never `.trash` or `.uploads`, never
`files.trash.empty` or `permanent`.

| Tool | Risk | Taints | Notes | Exists |
|---|---|---|---|---|
| `files_list {path}`, `files_search {q, under?}` | read | S | Names only | No |
| `files_read {path, offset?}` | read | S, U | Text, 128 Ki characters a page; PDF and Office through desk-agent's attachment parsers. A file's content came from somewhere else, so it's untrusted | No |
| `files_write {path, text, replace?}` | write | | UTF-8 text, 256 Ki characters at most. `replace` binds the old file's SHA-256 at ask time, and the old file goes to the trash, so it's undoable | No |
| `files_mkdir {path}`, `files_move {from, to}` | write | | A move never replaces | No |
| `files_trash {path}` | delete | | To the trash only | No |
| `workspace_list`, `workspace_read`, `workspace_write` | own | U if the file is marked (§6) | As today | **Yes** |
| `workspace_delete {path}` | own | | Its own workspace only | No |

**Browser.** Reads through the walker (the MDoc as text with refs); clicks and typing through the action proxy, with all
of its checks (`API.md` §14, `browser.minified.act`). In the agent's own context unless the member grants their session
(§5). None exists yet; the walker and action proxy exist for the member's simplified view.

| Tool | Risk | Taints | Notes |
|---|---|---|---|
| `browser_open {url, tabId?}` | read; `egress` with `U`+`S` | U | `http` and `https` only, by deskd's URL rules (`API.md` §10) |
| `browser_read {tabId, from?}` | read | U | The MDoc as text: blocks and refs (`fp` and block key), 20,000 characters a page |
| `browser_click {tabId, ref}` | read; `send` on a submit control; `spend` if it looks like paying, or on any page with a payment provider's frame; `egress` for a link in the member's session; `egress` with `U`+`S` | U | |
| `browser_type {tabId, ref, text}` | read; `egress` with `U`+`S` | | Never a sensitive field (below) |
| `browser_press {tabId, ref, key}` | as a click; `Enter` in a form is `send` | U | `Enter`, `Escape`, `Tab`, arrows, `Backspace` |
| `browser_back {tabId}`, `browser_close {tabId}`, `browser_tabs {}` | read | | The agent's own tabs only |
| `browser_use_my_session {site}` | egress | S | §5. In that tab every click, typing and press is at least `write`, and every navigation the agent starts (`browser_open`, `browser_back`, a click on a link) is `egress` (Security, below). Refused `origin` in a run a timer or another agent started (Security, S-14) |

Clicks and keys are deskd's own script in deskd's isolated world, never the page's: an untrusted `el.click()` or key
events on the element the card showed, its node, `fp`, block and document checked again in the same call as the act
(`API.md` §14). Trusted input never reaches the Agent's hidden tabs on a desk's Chromium, and no Agent path sends any.
Where a click or Enter would navigate is checked before it's done (`off_site` in the member's session, `blocked` for a
local host), and what a page starts anyway is cancelled at the request.

**Notebook.** Through deskd to desk-notebook, as the member. None exists; desk-notebook needs Markdown read and an agent
edit method (§11).

| Tool | Risk | Taints | Notes |
|---|---|---|---|
| `notebook_search {query, …}`, `notebook_read {pageId, from?}` | read | S (and U on a Guild Desk) | Pages as Markdown |
| `notebook_write {pageId \| new: {tabId, title}, op, markdown, find?}` | write | | `op`: `create`, `append`, `replace_text` (fails on a missing or ambiguous `find`). A `pre_agent` version first; "Edited by {agent}" |
| `notebook_trash {pageId}` | delete | | Trash only; restoring stays the member's |

**Running steps.** What exists is the run loop itself: up to 50 model steps a run, each with up to 16 tool calls. Added:

| Tool | Risk | Notes |
|---|---|---|
| `plan_update {steps: [{text, state}]}` | own | A checklist the reply shows, 20 steps at most. Not a scheduler: it only shows where the run is |
| `follow_up {inMinutes \| at, prompt}` | write | A one-shot timer on the agent itself, within 7 days and `timersPerAgent`. A timer starts future spending, so it asks |

No shell, scripts, code execution or processes at launch.

**Sending.** `message_agent` exists and stays `own`: the member's links and their rules are the standing permission, and
the receiver's run starts with `U`. Beyond the desk, the only way out at launch is the Browser (`send` on a submit). No
email, Chat send, desk-to-desk or outbound API.

**Spending.**
- **The agent never types payment details, even with approval.** The action proxy already refuses sensitive fields:
  passwords, one-time codes, card fields, masked fields and payment providers' frames are never fields (ADR 0046, T47-1).
  The member types them on the stream.
- **`spend`** is a click or press in the member's signed-in session whose target or page looks like paying: a control
  labelled buy, pay, place order, checkout, subscribe, donate or confirm purchase, or a payment provider's frame on the
  page. Every action there asks anyway, so a miss still asks as `write` or `send`; `spend` adds the red card, no batch and
  no unattended run. In the agent's own context a purchase can't complete: no sign-in, no saved card, no card field.
- **Model calls spend the member's key** under the limits (ADR 0043), not approvals. `message_agent` spends the
  receiver's under `a2aSpendPct`.

**Memory.** The memory runner's `memory_save` and `memory_forget` are `own`, so no card, except in a run holding `U`:
then saving asks, because a memory made from injected text would be in every later prompt. Pinned memories don't set `S`
(they're short and the member chose them); Security may want to revisit that (§10).

### 3. The approval flow
- **The run state.** A reply's `state` gains `awaiting_approval`, between `streaming` and its end. The agent shows
  `status: "working"`, `statusDetail: "awaiting_approval"` and `approvalsPending`. This is ADR 0020's `waiting_approval`;
  its other states and checkpoints are still not built.
- **One step at a time.** When a model step returns its calls, `ToolPolicy` classifies all of them first; every call that
  needs approval is asked at once, each as its own approval; the run waits until each is decided or expired; then the
  step's calls run in their order: approved and automatic ones run, the rest get their result. So a read never runs
  ahead of a write the model put before it.
- **The request:** `{id, agentId, runId, messageId, tool, risk, title, target, payload, before, sha256, untrusted,
  origin, state, detail, createdAt, expiresAt, decidedAt, result}` (`API.md` §18). `title` is the declaration's `words`
  filled in by the desk; the model's prose is never on the card. `payload` is the exact arguments, shown as data.
  `before` is what the change replaces, read at ask time (a file's SHA-256 and size, a page's title), and isn't hashed.
- **Bound to a hash.** `sha256` is the SHA-256 of the canonical JSON (`team/Canonical`, the proposals' encoding, which
  the Agent app already computes) of `{v: 1, agentId, runId, tool, context, payload}`, `context` being `agent` or
  `member:<site>`. The app computes it from what it shows and sends it with the decision; a mismatch is `bad_request`.
  The tool then runs with exactly the stored payload, once. A changed call from the model is a new approval.
- **deskd checks again.** For the tools deskd runs (Browser, Files, Notebook), desk-agent's call carries
  `{approvalId, sha256}`. deskd runs it only if it relayed `approve: true` for that id from a session of the agent's
  owner within the last 10 minutes, the hash over the arguments it received matches, and it wasn't used before. A wrong
  or compromised desk-agent can't approve itself. deskd keeps this in RAM; a deskd restart in between fails the call
  `approval_unknown`, and the model asks again.
- **Decisions.**

| Outcome | State | What the model reads as the tool's result |
|---|---|---|
| Approved, ran | `done` | The tool's result, after "Approved by the member." |
| Approved, failed | `failed` | "Approved by the member, but it failed: {reason}." |
| Declined | `declined` | "The member declined this; nothing was done. Don't ask for the same thing again in this run." Then, if they wrote one, "Their note:" and the note as one JSON string line, framed as timers' prompts are |
| Expired | `expired` | "The member didn't answer by {time}; nothing was done. Say what you were going to do, so they can ask you again." |
| Refused before asking | (no approval) | "Not allowed: {reason}." (`ask_cap`, `unattended_spend`, `origin`, `declined_before`, `declined`, `sensitive`) |

- **Asking again.** The same hash declined in this run is refused at once (`declined_before`). After 3 declines in a run,
  nothing more in it is asked: each such call is refused `declined`. The run goes on and ends with text.
- **Several pending.** Each has its own card. Approve all is offered for one run's pending cards when none is `spend` and
  the run doesn't hold `U`; it sends one decision per card, each with its own hash.
- **The member away.** `expiresAt` is 1 hour for a run the member started and 24 hours for one a timer or another agent
  started (the proposals' 24 hours). The card is in the agent's thread, stamped with its origin ("Asked by the timer
  {label}", "Asked while answering {agent}"), and in `agent.approvals.list`; the tile shows the count. A waiting run keeps
  its run slot, and unattended runs still stop at 3 of the desk's 4. A sender waiting on `message_agent` waits with it. A
  member's message to an agent that's waiting gets `conflict`, `reason: "awaiting_approval"`. Stopping the run expires
  its approvals, `detail: "stopped"`. Waiting doesn't keep the desk awake (design §9.10).
- **A desk-agent restart while waiting, honestly.** Runs aren't durable, so a waiting run ends with the process, as any
  run does today. At open: its reply becomes `failed`, `unavailable`, `interrupted`, as `streaming` ones do now; `pending`
  approvals become `expired`, `detail: "restart"`; an approved one whose tool was running becomes `interrupted`, which
  the card shows as "may have happened: check {target}", because deskd finishes a call it already started. Nothing is
  re-run. A timer's `lastState` is `failed`. The member asks again. A rollout of desk-agent, a desk stop and a free
  desk's idle stop all do this.
- **Limits.**

| Limit | Value | When passed |
|---|---|---|
| Tool calls a run | 100, tier value `toolCallsPerRun` | The call's result says so; the run goes on |
| Calls a step | 16, as today | As today |
| Approvals asked a run | 10 | `ask_cap` |
| Pending per agent | 5 | `ask_cap` |
| Pending on the desk | 20 | `ask_cap` |
| Declines a run before it stops asking | 3 | `declined` |
| Agent tabs on the desk | 2; 1 on a free desk | `tab_cap` |
| Signed-in sites a run | 2 | `ask_cap` |

### 4. Who may approve
- **Only the member who owns the agent, through their own session.** deskd stamps the caller; desk-agent compares it with
  the agent's owner: the desk's owner for their agents; on a Guild Desk, the member whose id is the agent's id.
- **A session that may act.** deskd refuses a decision from a token without input (`forbidden`, `permission`), from an
  `export` session (`scope`), and from any support session once those exist.
- **Never** another agent, a message, a timer's prompt, a tool result, page or file text, or anything the model writes.
  The only path to `approved` is `agent.approval.decide`. On a Guild Desk, never the Founder or an Officer for a member's
  agent: they can't see its thread (ADR 0080).

### 5. The Browser and the member's signed-in session (ADR 0035)
- **By default the agent browses in a context of its own.** deskd makes one off-the-record `BrowserContext` per run in
  the desk's one Chromium (`Target.createBrowserContext`), opens the run's tabs there, and disposes of it when the run
  ends. It has no cookies, sign-ins or saved cards, and writes nothing to `/data/browser/profile`. Its tabs aren't in
  `browser.tabs` and never become the tab on screen.
- **The member's session only by approval.** `browser_use_my_session {site}` (site: the registrable domain) asks: "Let
  {agent} use your signed-in {site} for this task. It can read pages there as you, and asks before each click, typing or
  sending." On yes, deskd opens one background tab in the member's own context, hidden from `browser.tabs`, for the rest
  of that run. A main-frame navigation off that site in it is cancelled (CDP `Fetch` on that target's document requests)
  and the tool answers `off_site`. Reads there set `S` and `U`. Every click, typing and press there asks, as `write`,
  `send` or `spend`. **Every main-frame navigation the agent starts there (`browser_open`, `browser_back`) asks as
  `egress`, always, whatever the run's taint** (Security's priority finding on the protocol, 2026-11-11: otherwise
  injected text could steer the signed-in session to a side-effecting address, such as `/delete?confirm=1`, with no
  card). The tab closes when the run ends.
- **Never clears or rewrites the profile.** On every agent path deskd sends only methods from an allow-list, and never
  one that clears or writes storage, cookies or history (`Storage.clear*`, `Storage.setCookies`,
  `Network.clearBrowserCookies`, `Network.deleteCookies`, `Network.setCookie(s)`, `Page.resetNavigationHistory`, and the
  like). A test pins the list. Browsing in the member's session adds history and cookies as the member's own browsing
  would; nothing is removed.
- **A frozen Chromium** (ADR 0045): an agent's Browser call is work, so it thaws Chromium and holds the grace, as a
  `browser.minified.*` call does.
- **Typing never reaches a sensitive field** in either context, approved or not.

### 6. Untrusted content is data
- **Each run carries two flags,** set by the declarations' `taints` and never cleared during the run: `U`, untrusted
  content read; `S`, the member's private data read. desk-agent keeps them on the run. deskd keeps its own copy per run
  for the tools it hosts, from its own results plus desk-agent's flags on each call, and can only add to it.
- **`U` comes from** pages, files from Files, the member's attachments, another agent's message (the run it starts),
  Notebook on a Guild Desk, a workspace file a `U` run wrote (marked in `agent.db`), and a thread whose earlier reply came
  from a `U` run (the reply row keeps `untrusted`). **`S` comes from** Files and Notebook reads, and the member's
  signed-in pages.
- **The rule holds by construction:** every `write`, `delete`, `send`, `spend` and `egress` asks in every run. `U` adds
  four things: a memory save asks; with `S` too, every browse action is `egress` and asks (the Rule of Two); no Approve
  all; and the card says "This agent has read web pages, files or messages in this task".
- **Prompts:** the preamble already says tool output, files, other agents and timers are data. Untrusted results come in
  a fence labelled with their origin, as attachments do today.

### 7. Audit
Every tool call, request, decision, expiry and result goes in the hash-chained log, ids only, as today:
- `tool.call`: actor `agent:<id>`; target `tool:<name> run:<id>`, plus `approval:<id>` when there is one; the payload
  hash of the arguments; decision `ok`, `error:<code>` or `refused:<reason>`.
- `approval.ask`, `approval.decide` (actor `user`, or the guild member's actor), `approval.expire` (decision `timeout`,
  `stopped`, `restart`, `age_band`), `browser.session.grant`.

Never page text, file content, typed text, a Notebook page, a URL beyond its origin, or a path. The approval row in
`agent.db` holds the payload for the card as long as the thread holds the reply, and goes with it.

### 8. Teens, the free tier and a Guild Desk
- **Teens:** nothing new. The Agent is off for a teen's desk and a teen member (`age_band`). A band that stops being
  adult stops runs, as today, and expires their approvals, `detail: "age_band"`.
- **Free tier:** the same tools and approvals. Agent browsing sends no video, so it isn't Browser time (ADR 0090 never
  limits the Agent by time). One agent tab. A waiting run doesn't keep a free desk up, so its 30-minute idle stop ends
  the wait (the restart case above).
- **Guild Desk:** a member's own agent gets the Notebook tools only, under that member's grants, checked by desk-notebook
  as for the member's own edits; no Browser, no Files (a Guild Desk has none), no `message_agent`, no `follow_up` (timers
  are team methods). Guild content is `U`. Approvals are the member's alone.

### 9. Not at launch
- "Always allow", per-site trust or any auto-approve; grants beyond one run.
- Durable runs that survive a restart, and the rest of ADR 0020's states.
- Watching or taking over the agent's tab; agent tabs in the Browser's tab list; the agent reading or driving the
  member's own open tabs.
- Uploads, downloads and file pickers in the Browser.
- Email, Chat send, desk-to-desk messages, outbound APIs, MCP or third-party tools, desk apps' own tools.
- Shell, scripts, code execution.
- Permanent delete, emptying a trash, files outside `/data/files`.
- Image generation; guild-owned agents; the Browser on a Guild Desk.
- A browse-only sub-run with `S` clear (design §9.7).
- Spending from a timer- or agent-started run; anything scheduled that buys.
- Approving from a notification outside the Desk app; pending counts in the heartbeat.

### 10. For Security
**Trusted:** the member's own messages and decisions over their own session; deskd's caller stamp; the declarations and
the card templates (both code). **Everything else is data:** pages, files, Notebook text, other agents, timer output,
tool results and the model's own text.

| # | Threat | Checked | Open |
|---|---|---|---|
| 1 | Injected text gets a write or send approved | Exact payload shown as data; desk-written title; risk colour; no Approve all under `U` | Members approving without reading |
| 2 | Private data leaves by browsing (URL, typing) | `U`+`S` makes every browse action `egress` | Low-bandwidth channels: which link it clicks, timing |
| 3 | desk-agent approves itself | deskd's own check: a relayed decision, the hash, single use | desk-agent's in-process tools (`own`) have no second check |
| 4 | Another agent, a message or a page claims the member approved | Only `agent.approval.decide` from the owner's session with input | |
| 5 | A spoofed card | Templates from code; untrusted strings (titles, labels, names) as plain text, cut, bidi and hidden characters removed | |
| 6 | The target changes between yes and run | Hash binding; the action proxy's `fp`, block and `rev` (`changed`); a file write's `before` SHA-256 | |
| 7 | The member's session misused | One site, one run, each action and each navigation the agent starts asked (`egress`), off-site navigation cancelled, a CDP allow-list with no storage methods and a test that fails if one is added; only a run the member started may ask for it (`origin`, S-14) | A page's own scripts or redirects on load, within the granted site |
| 8 | Persistent injection | Memory under `U` asks; a workspace file a `U` run wrote is marked (`workspace_marks`) and a run that reads it holds `U`; replies carry `U` forward | |
| 9 | Card flooding | Caps per run, agent and desk; 3 declines stop the asking | |
| 10 | Double execution after a restart | Approved-and-running becomes `interrupted`, never re-run | The member may need to check by hand |
| 11 | Payment details | Sensitive fields are never fields; `spend` one at a time and never unattended; a payment provider's frame anywhere on the page makes every click or submit there `spend`, bound in the approved payload (S-14) | One-click buying the `spend` heuristic misses still asks, as `write` or `send` |
| 12 | Audit rewritten | Hash chain | Root can rewrite it, as today |
| 13 | Script injection through the model's values | A ref, typed text or a key goes to the page only as a JSON argument of deskd's own function; the CDP allow-list takes script only from deskd's constants, into deskd's own world, never an `objectId` (S-14) | |
| 14 | A local address reached from a frame of another site | Every out-of-process frame of an Agent tab is held at its start until its own document requests stop at deskd (S-14) | A public name that resolves to a local address |

### 11. Build split
**The interface,** in desk-agent, landed first by the approvals builder as stubs that both build against:
```java
enum Risk { READ, OWN, WRITE, DELETE, SEND, SPEND, EGRESS }
enum Taint { U, S }
record ToolDecl(String name, String words, Map<String, Object> schema, String scope, Risk risk, Set<Taint> taints,
        Host host) {}
record RunContext(String runId, String agentId, Caller owner, Map<String, Object> origin, Set<Taint> taint) {}
record Classified(ToolCall call, ToolDecl decl, Risk risk, String context, Map<String, Object> target,
        Map<String, Object> payload, Map<String, Object> before) {}
interface ToolPolicy {                       // the tools builder
    Classified classify(ToolCall call, RunContext run);
}
sealed interface Verdict { /* Auto, Approved(String approvalId, String sha256), Declined(String note),
                              Expired(String detail), Refused(String reason) */ }
interface ApprovalGate {                     // the approvals builder
    List<Verdict> admit(RunContext run, List<Classified> step) throws InterruptedException; // blocks while waiting
    void settle(Verdict verdict, ToolResult result);
}
```
The loop in `ManagerAgent.complete` becomes: classify the step, `admit`, run each call with its verdict (`Tools.call`
gains the verdict, so a deskd-hosted tool passes `{approvalId, sha256}`), `settle`, then add the declared taints.

**The tools builder:**
- `ToolDecl` for every tool, the registry, and `ToolPolicy` (classification, `words`, `target`, `before`).
- The new tools in §2, and declarations for the existing tools and the memory runner's.
- Reverse calls on the agent socket: desk-agent sends `tcall {id, runId, agentId, tool, args, approval?, taint}`; deskd
  answers `tres {id, r, taint}` or `terr {id, code, details}`. deskd's `ToolHost` serves `tool.browser.*`,
  `tool.files.*` and `tool.notebook.*` as the agent's owner. No client can reach them, as the client relay lists only
  `agent.*`.
- deskd's agent browsing: the per-run off-the-record context, the member-session tab and its off-site cancel, the CDP
  allow-list and its test, the tab caps, the thaw.
- With desk-notebook's owner: Markdown read and an agent edit method with the `pre_agent` version.
- The chips' new fields and `untrusted` on replies.

**The approvals builder:**
- `ApprovalGate`, the `approvals` table in `agent.db`, states, expiry, the caps and the restart handling at open.
- The run loop change, `awaiting_approval`, `statusDetail`, `approvalsPending`, and `conflict` `awaiting_approval` on
  `agent.message.send`.
- `agent.approval.decide`, `agent.approval.get`, `agent.approvals.list` and the `approval` event (`API.md` §18).
- The run's taint and the `U` rules (memory, `U`+`S` browsing, no Approve all, workspace and reply marks).
- deskd: the relay entries, the RAM ledger of relayed decisions, and `ApprovalTickets.redeem`, which `ToolHost` calls
  before a gated tool.
- The audit rows.

**The UI/UX Engineer:**
- The approval card in the thread, under the waiting reply: a template per `tool` from `payload`, never the model's text;
  risk colour and label; the untrusted line; the origin stamp; Approve and Decline with an optional note; the time left;
  then its outcome (done, failed, declined, expired and why, interrupted).
- The pending list (`agent.approvals.list`), the count on the agent's tile, and Approve all where §3 allows it.
- The run's waiting state: "Waiting for you" on the reply, Stop still there, the composer's answer to
  `awaiting_approval`; the session-grant card; the chips' risk, decision and target.

## Consequences
- The Agent can act on the desk at launch, and nothing that matters happens without the member's yes, checked twice.
- Approvals end at a restart until durable runs come; the member asks again.
- desk-notebook needs a new method before the Notebook tools can write.
- Alternatives rejected: approvals held in deskd alone (desk-agent holds the run and the thread, and the proposals
  pattern already works there; deskd's check covers the gap); auto-approve for low-risk writes (the owner's rule says
  writes ask); the agent in the member's session by default (ADR 0035's session is the member's, and a signed-out
  context makes most injection harmless); typing payment details with approval (one bad yes costs real money).
