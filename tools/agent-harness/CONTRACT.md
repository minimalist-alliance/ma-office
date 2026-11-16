# The Agent tools harness: its contracts (W7, Maia Mode Phase 0)

The rig, the stand-in, the task format and the driver that the capability and soak runners and the real-desk scripts
share. The rig is `services/deskd/src/test/java/.../agent/HarnessRig.java`, started by `rig.sh`.

## 1. The local rig (Java)
A real deskd (`AgentRig`: relay, `ToolHost`, tickets, `AccessRecord`), deskd's real Files tools on a real tree, deskd's
real Notebook tools over the real desk-notebook service (Node, its own socket and data dir), and the real desk-agent jar
as a child process, whose Anthropic URL points at the stand-in model (or a real one). Started by
`tools/agent-harness/rig.sh` (prints `RIG http://127.0.0.1:<port>/<token>` on one line when ready). Its deskd clock is a fixed test
clock, so a yes never passes its 10 minutes there; desk-agent's clock is real. A `/agent` deletes the agent the last one
made, as a desk holds only a few (`agent_cap`). `restart-deskd` saves each agent's setup again from the owner's session,
as the rig keeps deskd's record in memory (a desk keeps it on `/data/desk`). Every tool deskd runs is
wrapped in a counting host that records each execution.

HTTP on 127.0.0.1 only, JSON in and out. Every reply has `ok`; a failure is `{ok:false, code, reason}`.

| Endpoint | Body | Answer |
|---|---|---|
| `GET /health` | | `{ok, deskAgent: bool, notebook: bool, model: "stand-in" \| "real", modelUrl}` |
| `POST /reset` | `{files?: {"Harness/a.md": "text", "Harness/dir/": null}, notebook?: [{tab, title, markdown}]}` | `{ok, tabs: {name: tabId}, pages: [{pageId, tab, title}]}`. Empties `Harness/` in Files and the notebook tabs it made before, then lays the world down. Paths are under `Harness/`; a key ending `/` is a folder. Also forgets the execution log |
| `POST /agent` | `{name}` | `{ok, agentId}`: a new staff agent on the rig's key and model, setup saved with the defaults (Notebook, Files, Browser on; Courier off; To-dos on; no auto switches) |
| `POST /access` | `{agentId, apps?, auto?}` | `{ok, access}`: `agent.access.set` from the owner's session (to switch auto-approve on for a test) |
| `POST /call` | `{method, params}` | `{ok, result}`: any `agent.*` method relayed by deskd from the owner's session with input |
| `POST /decide` | `{approvalId, approve, note?}` | `{ok, state}`: reads the card, computes its hash as the app does, relays `agent.approval.decide` |
| `GET /files` | | `{ok, files: {"Harness/a.md": "text", "Harness/dir/": null}, trash: ["a.md", ...]}` (everything under `Harness/`, and the names in Files' trash) |
| `GET /notebook` | | `{ok, pages: [{pageId, tab, title, markdown, trashed}]}` (every page the rig's tabs hold, Markdown exact) |
| `GET /executions` | | `{ok, executions: [{seq, tool, agentId, runId, approvalId, auto, autoApprovalId, key, ok, code, at}]}` since the last reset; one row per call deskd actually ran (run phase only, after its checks passed); `key` is the hash a card of that call would carry, `ok` and `code` its outcome |
| `POST /fault` | `{kind}` | `{ok}`. `kill-desk-agent` (SIGKILL, then started again on the same data), `restart-deskd` (deskd's RAM state, its tickets, lost; the agent link drops and reconnects), `notebook-down`, `notebook-up`, `files-away` (the Files root renamed away: deskd keeps the tree it opened, as after a lazy unmount), `files-back` |
| `GET /audit-verify` | | `{ok, intact, rows, brokenAt}`: desk-agent's hash chain checked from its file |
| `GET /logs` | | `{ok, deskAgent: "<the child's whole stdout and stderr so far>"}` |
| `POST /stop` | | `{ok}` and the rig exits |

`/call`'s methods are `API.md` §18's: `agent.message.send {agentId, text}` → `{runId, messageId}`;
`agent.thread.get {agentId}` → `{messages: [{id, role, state, text, tools: [chips], untrusted, ...}]}` (a reply's
`state` is `streaming`, `done`, `failed`, `stopped`); `agent.approvals.list {agentId?, state?}` → `{approvals: [card]}`;
a card is `{id, agentId, runId, messageId, tool, risk, title, target, payload, before, sha256, untrusted, origin, state,
detail, createdAt, expiresAt, decidedAt, result}`; `agent.audit.list {beforeSeq?, limit?}` → `{entries, headHash, nextBeforeSeq}`, newest first (read `services/deskd/docs/API.md` §18 for the exact
shapes before relying on a field).

## 2. The stand-in model (Node, `standin/standin.mjs`)
A stand-in for Anthropic's Messages API, `POST /v1/messages` with `stream: true`, answering in SSE exactly as
`services/deskd/src/test/java/com/minimalistalliance/desk/deskd/agent/RealDeskAgentToolsIT.java` does (`message_start`,
`content_block_start/delta/stop` for text and `tool_use` with `input_json_delta`, `message_delta` with `stop_reason`,
`message_stop`). Also `GET /v1/models` (desk-agent checks a key with it). It is stateless: the request's first user
message's text names the task (exact prompt match), and the number of assistant turns in the request is the step.

## 3. A task (JSON, one file each, `capability/tasks/<area>/`)
```json
{
  "id": "files-001",
  "area": "files",
  "title": "short words",
  "prompt": "what the member types; unique across all tasks",
  "setup": {"files": {"Harness/trips/2026.md": "..."}, "notebook": [{"tab": "Harness", "title": "Plan", "markdown": "# Plan\n..."}]},
  "approve": "all",                     // or "none", or {"decline": ["files_trash"]}, or {"declineNote": "..."}
  "checks": [
    {"kind": "file", "path": "Harness/packing.md", "equals": "...", "contains": ["tent"]},
    {"kind": "noFile", "path": "Harness/old.md"},
    {"kind": "trashed", "name": "old.md"},
    {"kind": "page", "tab": "Harness", "title": "Plan", "contains": ["..."], "notContains": ["..."]},
    {"kind": "noPage", "tab": "Harness", "title": "Draft"},
    {"kind": "reply", "contains": ["..."], "state": "done"},
    {"kind": "cards", "tools": ["files_write"]},          // exactly these cards were asked, in order
    {"kind": "untrusted", "value": true}
  ],
  "policy": {"tools": ["files_list", "files_write"]},     // tools the run may call; anything else is a violation
  "standIn": [
    {"calls": [{"name": "files_list", "input": {"path": "Harness"}}]},
    {"calls": [{"name": "files_write", "input": {"path": "Harness/packing.md", "text": "tent\n"}}]},
    {"text": "Saved Harness/packing.md."}
  ]
}
```
A stand-in input value may be `{"$re": {"step": 1, "call": 0, "pattern": "\"tabId\":\"([^\"]+)\""}}`: the first capture
group of that regex over the text of the tool result for that earlier step's call (steps count from 0).

**Policy violations** (any one fails the run, whatever its checks say): a call the member wasn't asked for executed for
a gated tool (an execution with neither an approved card nor an auto group the runner switched on); two executions of
one approval or one auto approval id; a tool outside `policy.tools` executed; a card whose `title` or `payload` differs
from what the tool ran with; an untrusted run whose card doesn't say `untrusted: true`; the audit chain not verifying (local: the
rig's `GET /audit-verify`; on a desk: skipped, noted); the run's canary in an audit row or the desk-agent log. The runner
makes one canary per run, `mmcanary-<16 hex>`, puts it on its own last line of every world text (file contents and page
Markdown), and the stand-in appends `\n<canary>` to every `text` and `markdown` input it writes; checks compare text with
lines that are exactly the canary removed. So a leak of any content or written argument shows.

## 4. The driver (the runners and the real-desk scripts)
```js
export interface Driver {
  name: 'local' | 'desk';
  start(): Promise<void>; stop(): Promise<void>;
  reset(world): Promise<{tabs, pages}>;
  newAgent(name): Promise<string>;
  send(agentId, text): Promise<{runId}>;
  cards(agentId, state = 'pending'): Promise<Card[]>;
  decide(card, approve, note?): Promise<void>;
  reply(agentId, {timeoutMs}): Promise<Reply>;      // waits until the newest reply isn't streaming and no card is pending
  files(): Promise<{files, trash}>;
  notebook(): Promise<Page[]>;
  audit(): Promise<{entries, headHash}>;              // every row, oldest first
  executions?(): Promise<Exec[]>;                    // local only
  fault?(kind): Promise<void>;                       // local only
}
```
The desk driver (`web/tests/real-desk/agent-tools/driver-desk.mjs`) works only through the Agent window's UI on the real test desk, plus the client methods the
Files and Notebook apps already call; it keeps its world under a Files folder `Harness` and a Notebook tab `Harness`.
