# Agent app UI (`web/agent/`)

The Agent app's front end, as a standalone module: chat with the desk's lead agent and the other agents, bring-your-own provider key, usage limits, provider badges and the audit log (design §9, ADRs 0012, 0018 to 0020; backlog S-14's UI, TD-74's Agent part), and since task 49 many agents on a desk: the lead's proposals, each agent's settings, messages between agents, workspaces, timers and icons (see "Many agents"). It's the partner to task 04's `desk-agent` service. The Desk app's Agent windows render it over the real link (see "How it's wired in"), and it still runs alone, on its mock, for its own demo and tests.

It looks and behaves like the Agent in `prototype/`: agents on the left with badges and a usage meter, the thread and composer in the middle, "Show provider badges" in the rail. It adds what design §9.1 asks for: a drawer with Usage, Keys and Activity, the key screen for an agent with no key, and per-reply cost. Where it differs from the prototype: the rail is headed "Desk team" (ADR 0063), each agent shows its status word (design §9.1) rather than a role, and badges are the neutral monogram the Desk canvas already draws (the `mark` tokens), not the prototype's colored discs, until the providers' own marks are cleared.

## Run it

Node 24 (`export PATH=$HOME/.local/node-v24/bin:$PATH`), from `web/agent/`:

| Command | What it does |
|---|---|
| `npm ci` | Install exact versions |
| `npm run dev` | The demo on `http://localhost:5183/`, against the mock. No network, no model, no real keys |
| `npm run typecheck`, `npm run lint`, `npm test` | TypeScript, ESLint (the Desk's rules plus `no-console`) and the Desk's CSS color check, Vitest |
| `npm run e2e` | Builds, then Playwright against the bundle under a CSP with `connect-src 'none'` |
| `npm run record` | Builds, then records the walkthrough to `recording/agent-ui.webm` |
| `npm run check` | All but `record` |

Demo URL options: `?fixture=fresh` (no key yet), `ready` (two agents, two keys), `limit` (the next message passes today's limit); `?theme=light|dusk|dark`; `?size=small` (a 420 px window); `?speed=fast` (the tests); `?focus=researcher` (one agent's own window, as the Desk opens it from that agent's tile); any cap from multi-agent.md §2 by name, such as `?agentCap=3` or `?timersPerAgent=2`. The bar at the top switches the first four. In the demo, ask the lead "Set up two agents" (the first chip), then "let Writer message Scout"; ask a linked agent to "ask <name> …" for a message between agents; `window.__maAgentMock.fireTimer(agentId, timerId)` runs a timer now (ones due within ten minutes run by themselves).

Playwright here needs Chromium 1248 in `~/.cache/ms-playwright`. On a busy machine, run it in the official image instead: `docker run --rm --ipc=host -v <web>:/w -w /w/agent mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'npm ci && npm run check'`, with `web/src/theme/`, `web/eslint-rules/` and `web/scripts/check-css-literals.mjs` alongside, as below.

## Layout

| Path | Holds |
|---|---|
| `src/index.ts` | What the Desk app imports: `AgentApp`, the client interface, `RpcAgentClient`, `KeySecret`, the types, and the CSS |
| `src/client/types.ts` | The wire shapes, in task 04's words where it has them |
| `src/client/agentClient.ts` | `AgentClient`, the only way the UI reaches the desk, and `AgentError` |
| `src/client/rpcAgentClient.ts` | `AgentClient` over deskd's RPC and subscriptions: the proposed mapping, as code |
| `src/client/keySecret.ts` | The key on its way to the desk, unprintable |
| `src/mock/` | `MockAgentClient`, fixtures, canned replies and a ledger after task 04's. Never imported by `src/index.ts` |
| `src/model/` | Pure rules, unit tested: limits and the limits form, badges and status, money, the thread reducer; and task 49's timers in the member's zone (`timers.ts`), proposals' canonical JSON and what a card shows (`proposals.ts`), links and the agent-message log's words (`links.ts`), workspace paths and sizes (`workspace.ts`), the PNG checks (`png.ts`) |
| `src/look/` | Icons, tones, the foreground color and the mark components (see "The look") |
| `src/ui/` | React: `AgentApp` and its parts, `agent.css`. Task 49's: `Settings.tsx` (with `Look.tsx`, `Links.tsx`, `Workspace.tsx`, `Timers.tsx`), `Proposals.tsx`, `AgentMessages.tsx` |
| `src/demo/` | The demo page around it |
| `tests/e2e/` | Playwright: the key flow, limits, the rest. `watch.ts` fails any test on a console error, a page error, or a request that isn't a same-origin GET |

It reuses the Desk's own colors: `vite.config.ts` turns `web/src/theme/tokens.ts` into CSS with the Desk's `themeCss()`, and `agent.css` uses only `--ma-*` properties, so inside the Desk app it follows the Desk's theme with nothing more. Classes are prefixed `ag-` so nothing collides with `web/src/styles/app.css`. It reads, never edits, `web/src/theme/`, `web/eslint-rules/` and `web/scripts/check-css-literals.mjs`.

## The key

The key screen takes the key in a hidden field and hands it to the desk. It never logs it, stores it in the browser or sends it anywhere else:
- The field is `type="password"`, `autocomplete="off"`, no spellcheck or autocorrect, with the opt-out attributes 1Password, LastPass and Bitwarden read. It's uncontrolled, so the key is never in React state, props or a store.
- Submitting moves the key out of the field into a `KeySecret` and empties the field in the same task (`KeySecret.takeFrom`). The plaintext sits in a module-private `WeakMap`, so `String()`, JSON, `console.log`, Node's inspector, `structuredClone` and React DevTools all see `[redacted]`.
- A key that's plainly wrong (task 04's rule: 8 to 1024 printable ASCII, no spaces, and the provider's prefix) is refused here and never sent.
- So is another provider's key (`keyOwner` in `client/keySecret.ts`): the longest `keyPrefix` from `agent.providers` that it starts with says whose it is, as desk-agent decides it, so `sk-ant-…` under OpenAI is Anthropic's. One line names that provider. The desk's own `bad_request`, `key_malformed`, `provider_mismatch` says the same line without a name, since the form would have caught one it could name.
- `RpcAgentClient.addKey` is the only reader of the plaintext. It goes in `agent.key.add`'s params, on the desk's `rpc` data channel, end to end (design §9.5). The caller wipes the secret when the desk answers, success or not, and the field is emptied on unmount too.
- The desk keeps it; what comes back is metadata: label, provider, last 4.
- `no-console` is an ESLint error in `src/`.
- `MockDeskLink`'s record shows `secret` as `[redacted]`, and `peer.ts` keeps and logs no params. `web/src/desk/rtc/peer.test.ts` and `web/tests/e2e/agent.shell.spec.ts` fail if a key reaches a log, a record or storage, and `web/tests/real-desk/rt-agent.mjs` checks a made-up one on the real desk, its journal included.

**Whether a key lasts.** A `desk-agent` before `2026.11.07-0e1fb6c` keeps keys in memory, so a restart drops them, and it can't say so before it happens. From that release (ADR 0042, on `main` and on the test desk) it seals them on the desk and adds `available` to each key in `agent.key.list`. The rule is in `model/agents.ts`:
- `keysLast`: true where any key carries `available`, either way, or `agent.limits.get` has a `timeZone` property, even null. Both came with the store in `0e1fb6c`, so a desk with no keys yet still says it. Only a desk with neither, an older `desk-agent`, gets `KEY_RESTART_LINE`, once on the key screen and once in the Keys tab; until both reads have answered, neither shows. **A stopgap** (the coordinator's ruling, 2026-11-07) until the Desk Engineer offers an explicit field. Once every desk has the store, delete the line.
- **Activity at a restart** (`shownInActivity` in `ui/Activity.tsx`): on a desk where `keysLast` is true, the stop's `key.drop` on `keys:all` (`zeroed:<n>`, the keys leaving memory, their sealed files kept) isn't shown, and nor is a start's `key.restore` that read every key, since a member would read either as a lost key. A `key.restore` with `unreadable:<n>` above 0 is one row: "After a restart, 1 key couldn’t be read" (or "2 keys"), with "Add it again in Keys." (or "them", `nextStep`) in place of its target. On an older desk the drop shows, as "A restart cleared 1 key" (or "2 keys"), because there it was a loss. The export keeps every row.
- `keyLost`: `available: false`, or with no such field, an agent still bound to the key and showing `no_key`. The row gets a quiet "Add this key again", the key isn't offered to bind, and the agent's key screen names the key and says it needs adding again, with its thread and limits still here. Its status word is "add key again", not "no key".
- `takeOver` in `ui/Keys.tsx`: the same key added again (provider and last 4) takes the dead row's place, on the same model, with no decision to make.

Tested in `src/client/*.test.ts` and `tests/e2e/key.spec.ts`. After a key is entered, the e2e test searches the DOM, every input's value, Web Storage, cookies, IndexedDB, Cache Storage, the URL, every console message and every request for it, and finds nothing. The page is served with `connect-src 'none'`.

**Honest limits.** A JavaScript string can't be zeroed: wiping drops the reference, and the engine frees it when it likes. A browser's password manager can still offer to save the field; the opt-out attributes stop the common ones, and the member can say no. The Desk's own link must not log or record RPC params (see "Wiring it in").

## Limits

Design §9.9, task 04's `LimitPolicy` and ADR 0043 (deskd API.md §11): per agent per day, week and month, the whole desk per day and per month, the key per month, and per run ($ and steps). The desk enforces them; this shows them and edits them. The rail shows the fullest limit's meter (warning at 80%). The Usage tab shows every set limit with when it resets, and the member's form, in dollars, where blank means no limit; token caps the desk holds are kept as they are. A refused message says which limit, keeps the typed text in the composer and adds nothing to the thread, because the desk refuses before any call (task 04's gateway).

**The whole desk's values layer** (ADR 0043, the owner's rule in `~/ma-coord/HANDOFF.md` §4): `deskDay`, `deskMonth` and the time zone are this desk's own where it sets one, else the account's, else the default (no day cap, $20 a month, UTC). `agent.limits.get` says what each layer sets (`desk`, `account`), and `model/limits.ts` turns that into the form:
- **The form leads with the whole desk team's** "Each day" and "Each month" and its time zone, then the agent's own fields as before.
- **Only what the member changed is sent** (`parseDraft`). A whole-desk field left alone, or typed back to what it was, isn't sent, so the desk keeps following its account; sending what's in force would pin it to this desk. The agent's own fields go with any policy, since the desk requires them. A save that changed nothing sends nothing.
- **Where a value comes from:** "From your account" where the desk sets nothing and the account does; where neither does, the desk's built-in value: "No limit" for the day and "$20 · built in" for the month (from `DESK_DEFAULTS`), and "Default" for the zone until the window sets this browser's; nothing where the desk sets its own. There, "Use my account’s" (or, when the account sets nothing, "Remove the limit" for the day and "Use the built-in $20" for the month) puts the account's value, or the built-in one, in the box, and the save sends `null`, which clears this desk's. Typing again takes it back. The zone offers it only when the account has a zone: clearing it would only have this browser's set again.
- **The zone is set once, with no question** (`needsZone` in `AgentApp`): on a layered desk where neither the desk nor the account has one, the first read sends this browser's (`Intl.DateTimeFormat().resolvedOptions().timeZone`), alone, once per client. Any name for UTC goes as `UTC`, and a fixed offset (`Etc/GMT+5`) isn't sent, since the desk refuses it. A failure leaves it, and the next session asks again. The member changes it in the form, from the browser's list of zones; one the desk doesn't know (`bad_request`, `reason: time_zone`) or that plainly isn't one says "That isn’t a time zone your desk knows. Pick one from the list, like Europe/Paris." under the box.
- **Activity says "Time zone set to {zone}"** for that set, not "Changed limits", which the member didn't do. A current `desk-agent` (deskd `ad82b2e`, API §11) audits a call of only `timeZone` as `limits.timezone` (actor `user`, target `agent:<id>`), so that row reads "Time zone set" for good, across reloads and browsers. The row holds only a hash, not the zone, so the zone is added ("Time zone set to {zone}") only on the page that sent it: the window takes the newest `limits.timezone` row after its answer and remembers its hash (`noteZoneSet` in `ui/Activity.tsx`). **Older desks** audit it as any `limits.set`, so the same hash memory is all there is: after a reload it reads "Changed limits". That `limits.set` fallback (in `actionText` and the lookup in `ui/AgentApp.tsx`) can go once every desk runs the `desk-agent` with `limits.timezone`. The mock does it with `?zoneAudit=1`.
- **Resets** read in the desk's zone: "Resets at midnight", "Resets Monday", "Resets Dec 1", with the zone named after them when it isn't this browser's ("Resets at midnight (Asia/Tokyo)").
- **Prices:** the note under the form says "Prices as of Nov 6, 2026." from `pricesAsOf`. A model the price table doesn't list has null prices in `agent.key.models`, and Keys says "No listed price, so it counts at this provider’s highest." under it.
- **An older desk** (no `desk` or `account`) sees the form as before: no day, no zone, no source lines, and `deskMonth` with every policy, which its `desk-agent` requires.

Tested in `src/model/limits.test.ts` (the draft logic: untouched fields not sent, `null` to follow, the zone once), `src/mock/mockAgentClient.test.ts`, `tests/e2e/limits.spec.ts`, `tests/e2e/limits-layered.spec.ts`, and in the Desk's `agent.shell.spec.ts` and `tests/real-desk/rt-agent.mjs`. The mock layers the same way with `keysLast` (demo `?keysLast=1`, with `accountDay`, `accountMonth` in dollars or `none`, and `accountZone` for the account's), and counts periods in the desk's zone.

## Interface

The UI calls `AgentClient` (`src/client/agentClient.ts`). On a desk, each method is one deskd RPC, relayed by deskd to `desk-agent` over its local socket, since deskd is the only policy point (design §9, ADR 0019). Mutations carry `idem` (one member action, one key, deskd API.md §4). Shapes are in `src/client/types.ts`.

| `AgentClient` | deskd method | Mutation | Params | Result |
|---|---|---|---|---|
| `providers()` | `agent.providers` | No | | `{providers: [{id, name, console, keyPrefix}]}` |
| `listAgents()` | `agent.list` | No | | `{agents: Agent[]}` |
| `watchAgents()` | topic `agent.state` | | | each EVT's data `{agents, caps?}`, a whole snapshot, each agent the smaller one (no purpose, workspace or rules' text) |
| `createAgent()` | `agent.create` | Yes | `{name, purpose?, icon?, tone?, keyId?, model?, solo?, workspaceMb?}` | `{agent}`, or `precondition_failed`, `agent_cap` at the desk's cap |
| `updateAgent()` | `agent.update` | Yes | `{agentId, name?, purpose?, icon?, tone?, solo?, workspaceMb?, badgeHidden?, dismissBadgeNotice?}` | `{agent}` |
| `bindAgent()` | `agent.bind` | Yes | `{agentId, keyId, model}` | `{agent}` |
| `getThread()` | `agent.thread.get` | No | `{agentId}` | `{agentId, messages, seq}` |
| `watchConversation()` | topic `agent.conversation:<agentId>` | | | EVT `snapshot` with data `{messages, omitted?}`, `message` with `{message}` (add or replace by id), `delta` with `{messageId, runId, text}`. An EVT is at most 64 KiB, so where `omitted` is set or a message has `truncated`, the client also reads `agent.thread.get`, which has them all |
| `sendMessage()` | `agent.message.send` | Yes | `{agentId, text, attachments?}` | `{messageId, runId}`; the reply streams on the topic. `attachments` is upload ids (below); `text` may be empty with files. The user message in the thread carries `attachments: [{name, type, size, note?}]` and never a file's content |
| `attachFile()` | `agent.attach.put` | Yes | `{agentId, uploadId, name, size, index, data}` | `{uploadId, received, complete}`; one chunk of at most `chunkBytes` (512 KiB) of the file, base64, in order. The desk holds it in memory for 10 minutes at most and deletes it as soon as the model has answered (ADR 0049) |
| `removeAttachment()` | `agent.attach.remove` | Yes | `{agentId, uploadId}` | `{}` |
| `attachCaps()` | `agent.attach.caps` | No | `{agentId?}` | `{caps, ceiling, chunkBytes, vision?}`; `vision` says whether the agent's model takes pictures |
| `setAttachCaps()` | `agent.attach.caps.set` | Yes | the `caps` fields to change | `{caps, ceiling}`; the desk owner's only; no screen in the Agent app sets it yet |
| `stopRun()` | `agent.run.stop` | Yes | `{runId}` | `{}` |
| `markSeen()` | `agent.seen` | No | `{agentId}` | `{}` |
| `listKeys()` | `agent.key.list` | No | | `{keys: KeyMeta[]}`, each with `available` on a desk whose keys last |
| `addKey()` | `agent.key.add` | Yes | `{provider, label, secret}` | `{key: KeyMeta}`; the only call with a key |
| `deleteKey()` | `agent.key.delete` | Yes | `{keyId}` | `{}`, or `step_up_required` |
| `listModels()` | `agent.key.models` | No | `{keyId}` | `{models: [{id, label, inputMicroUsdPerMTok, outputMicroUsdPerMTok}]}` |
| `getLimits()` | `agent.limits.get` | No | `{agentId}` | `{agentId, policy: LimitPolicy, usage: [{scope, spentMicroUsd, spentTokens, resetsAt}], timeZone, pricesAsOf, desk, account}`; the last four from ADR 0043's desks |
| `setLimits()` | `agent.limits.set` | Yes | `{agentId, policy?, timeZone?}`: in `policy`, `deskDay` and `deskMonth` absent, `null` (follow the account) or a `Limit` | the same as `get` |
| `listAudit()` | `agent.audit.list` | No | `{beforeSeq?, limit?}` | `{entries: AuditEntry[], headHash, nextBeforeSeq}`, newest first |
| `getAgent()` | `agent.get` | No | `{agentId}` | `{agent}`, whole: purpose, workspace and the rules' text, which `agent.state` leaves out |
| `caps()` | `agent.caps` | No | | `{caps}`; `agent.state` carries the same, and `watchAgents` hands it on |
| `deleteAgent()` | `agent.delete` | Yes | `{agentId}` | `{}`; never the lead (`bad_request`, `detail: lead`) |
| `setLinks()` | `agent.links.set` | Yes | `{agentId, solo, links: [{to, rules}]}` | `{agent}` |
| `answerProposal()` | `agent.proposal.answer` | Yes | `{proposalId, accept, sha256}` | `{proposal}` |
| `listA2a()` | `agent.a2a.list` | No | `{agentId?, before?}` | `{messages, older}`, newest first, 100 a page |
| `getWorkspace()`, `readWorkspace()` | `agent.workspace.get`, `.read` | No | `{agentId, path?}`, `{agentId, path}` | a folder's entries with the quota and use; a file's text |
| `deleteWorkspaceEntry()`, `shareWorkspace()` | `agent.workspace.delete`, `.share` | Yes | `{agentId, path}`, `{agentId, with}` | `{usedBytes}`, `{agent}` |
| `listTimers()` | `agent.timer.list` | No | `{agentId}` | `{timers, zone}` |
| `setTimer()`, `deleteTimer()` | `agent.timer.set`, `.delete` | Yes | `{agentId, timer}`, `{agentId, timerId}` | `{timer}`, `{}` |
| `uploadIcon()` | `agent.icon.upload` | Yes | `{agentId, png}` (base64) | `{agent}` where the desk sends it, else null and `agent.state` brings it |
| `getIcon()` | `agent.icon.get` | No | `{agentId}` | `{png, version}`: the mask, shown only through a `blob:` URL in this page |

`createAgent()` and `updateAgent()` take task 49's fields too (purpose, icon, tone, solo, workspaceMb); every new shape is in `src/client/types.ts`, in multi-agent.md's words.

Words and units are task 04's: provider ids `anthropic`, `openai`, `google`, `xai` with a display name; status `no_key`, `online`, `working`, `limit_reached`, `error` (plus `needs_you` for approvals later); scopes `agent_day` … `run_steps`; money as integer µ$; `Usage` as task 04's record; an assistant message's `badge` is `{provider, providerName, model}` (task 04's `Badge`); `AuditEntry` is task 04's audit row camelCased, with hashes in hex.

**Errors** are deskd's codes, with `details.reason` from task 04's `AgentException.Code` and the key checks: `precondition_failed` + `no_key`; `conflict` + `busy`; `precondition_failed` + `limit_reached` + `details.scope`; `bad_request` + `key_malformed` + `details.detail` (the problem); `precondition_failed` + `key_refused` + `details.detail: "auth"`; `precondition_failed` + `agent_cap`. A provider failure during a run ends the reply's message with `state: "failed"`, `error: "provider_error"` and `errorDetail` as `ProviderException.Kind` lowercased. No error ever carries content.

## How it's wired in

- **`web/src/agent/AgentWindow.tsx`** is the window, and all of this that's in the Desk's initial chunk. It says what's wrong until the desk can answer: asleep, waking, opening, held, setting up, refused, parked. **`AgentBody.tsx`** is the lazy chunk (about 15 KB gzipped), with `<AgentApp>` over `new RpcAgentClient(transport)` on that desk's link. So one window's client talks to its desk alone, and a new session makes a new client so every read runs again. The window stays mounted once it's opened, through a parked desk and a dropped link, so a draft or a half-typed key is never lost.
- **Props the Desk passes:** `client`, `deskName`, `showBadges` and `onShowBadgesChange` (the layout document's `prefs.showProviderBadges`, `shell/layoutPrefs.ts`), `offline` (the link isn't open: the box takes what's typed, nothing goes), `parked` (nothing counts as seen, and events wait), `focusAgentId` (an agent's own window: `agentIdOf` its app, null for the lead's `agent` tile, which has the whole team), `onOpenAgent` (a proposal card's "Open Scout" opens that agent's own window, `openAgentWindow` in `AgentBody.tsx`), and `canAddAgents={!guild}`. On a Guild Desk, `guild`, a `GuildMode` (task 48): "Your agent"; no Keys tab and no desk limits form for anyone; `guild.limits` is the guild's limits panel, given only to the Founder and an Officer with `manage_agents`, shown as "Guild limits" under the guild's key (`GuildKeyPanel`: name, last 4, Replace, Remove), with Activity; `noKey` and `keyLost` are what a member's agent with no key says instead of the key screen, `addKey`, `addKeyAgain` and `restartLine` the key screen's words for those who add the guild's key, `caps` the guild's caps on each member for the sidebar's meter, and `openLimits` a count that opens the drawer. `guild.addKey`, for the Founder and `manage_agents`, replaces the key screen's first heading and line (KeySetup's `intro`), since the key they add is the guild's, for every member's agent. The sidebar says the agent stops at the guild's limit, and the tab group isn't drawn when there are no tabs. Task 49's Settings and Agent messages tabs and "New agent" are a member's own desk's: a Guild Desk's agent is one seat on the guild's key. It passes no `suggestions`: chips stay in the demo until tools make them real.
- **Every agent is its own app on the desk** (task 49 item 6, `web/CLAUDE.md`, "Agent tiles"): the lead keeps the `agent` tile; each other agent is an item with app `agent:<agentId>`, added and removed as the desk's `agent.state` says, drawing its mark and wearing its name. Its window is this app with `focusAgentId`: no rail, its thread and its settings.
- **What `AgentApp` handles itself:** `not_found` says the desk's Agent isn't ready yet, and asks no more. `forbidden` says the session can't view it. Anything else on the first reads, which is what `desk-agent` not running looks like, says "Your desk team isn't running right now", reads again at 5, 10, 20 and then every 30 s, and comes back at once on `agent.state`'s fresh snapshot. A send that fails keeps its words, and one whose answer was lost keeps its `idem`, so a second press lands once.
- **`DeskRpc` and `LinkTopics`** list the `agent.*` methods and topics (`web/src/desk/deskLink.ts`). `web/agent` is imported as source: `resolve.dedupe` in the Desk's `vite.config.ts` keeps it on one React, `cssCodeSplit: false` puts `agent.css` in the one stylesheet, and `build-release.mjs` fails a bundle with any of `MockAgentClient`, `k-anthropic-1` or the mock's replies in it.
- **The mock on a desk:** `web/src/desk/mockDeskAgent.ts` puts `MockAgentClient` behind `MockDeskLink`'s wire, with the real `Subscriptions`, so `npm run dev` and the `shell` tests run `RpcAgentClient` for real. `?agentFixture=fresh|ready|limit`, `?keysLast=1` and `?speed=fast`, and `window.__maDeskMock.agent` steers it (`setDown`, `restart`, `dropLink`, and `desks[id].client.loseKey`).
- **The tile and status line:** `liveStore.ts` also subscribes to `agent.state`, and `activityOfAgents` in `desk/agentStatus.ts` turns its words (`no_key`, `limit_reached`) into the panel's (`no-key`, `paused-limit`). Once deskd's `summary` speaks for the agents, it wins.
- The component inherits the host's font, and its weights are the Desk's today, for Inter. The demo loads Inter too, so it looks as it will in the Desk. When ADR 0065 moves the Desk to Nunito, `agent.css` takes Nunito's weights with the rest of `web/` (`docs/assets/brand/ui/type.txt`).

## The look (`src/look/`)

What makes one agent's tile differ from another's (task 49, `services/desk-agent/docs/multi-agent.md` §7): a line icon, a tone and one standard foreground. All of it is in four files the Product Designer can edit, each with notes at its top on how:

| File | Holds |
|---|---|
| `icons.ts` | 24 role icons as SVG path data on a 24 grid, stroke only, 2.0 weight, round caps and joins (the Desk's own icon style); under 32 px the glyph draws at 70% with a stroke floor of 1.3 px. Six icons were swapped (`globe`, `chat`, `heart`, `star`, `puzzle`, `briefcase` to `plane`, `person`, `wallet`, `bulb`, `terminal`, `document`: `RETIRED_ICONS`, `currentIcon`) |
| `tones.ts` | 12 tones in wheel order (`graphite`, the neutral default, then 11 hues), each with a value per theme in LCh. Retired ids (`moss`, `sky`) map to `green` and `blue` (`RETIRED_TONES`, `currentTone`) |
| `foreground.ts` | The one foreground color, `#fafafa` (Dusk's white text), used for every mark on every tone in every theme, and why |
| `AgentMark.tsx`, `Pickers.tsx`, `draw.ts`, `look.css` | `AgentMark` (a rounded square in the tone, glyph at 56%, radius 24% like the Desk's tiles), `IconPicker`, `ToneWheel` (both radio groups with arrow keys, Home and End), and `drawAgentMark` for canvas tiles (`draw.ts` fits a stored mask into a square) |

`icon: 'png'` with a `pngUrl` (or a `mask` on the canvas) draws the uploaded picture as a mask: only its alpha is used, tinted in the foreground color, never its own colors. Exported from `src/index.ts`: `AGENT_ICONS`, `DEFAULT_ICON`, `iconById`, `TONES`, `DEFAULT_TONE`, `toneColor`, `FOREGROUND`, `AgentMark`, `IconPicker`, `ToneWheel`, `drawAgentMark`, `PNG_ICON`.

**The tests (`look.test.ts`)** fail if the foreground is under 4.5:1 (WCAG 2) on any tone in any theme, if two tones in a theme are closer than a CIEDE2000 difference of 9, or if an icon's path doesn't parse. Changing a tone's lightness or the foreground means rerunning them. Tones must stay mid-dark (relative luminance 0.17 or lower) for a near-white mark to read; that is the price of one foreground color. In Dusk the darkest hues (olive, green, teal) sit close to the ground's own lightness, and are told apart by hue.

See it: `npm run dev`, then the **Look** button in the demo bar (`?view=look`): the pickers, and every icon on every tone, in the theme you pick.

## Many agents (task 49)

The interface is `services/desk-agent/docs/multi-agent.md`; every wire name here is its. The lead is the desk's first agent (`manager` on the wire, `lead: true`, named "Lead" by default) and can't be deleted; every other agent starts solo (it sends no messages but still receives under a link's rules), with the first tone no agent on the desk uses (not `graphite`) and the `spark` icon. The lead's tile stays the Agent app's and Look is hidden in the lead's settings.

- **The rail** lists every agent with its mark (`look/`, an upload through a `blob:` URL, `useMaskUrl`) and its status. "New agent" makes one by name and key and opens its settings; at the desk's cap (`caps.agentCap`, the lead counted) it's off and says so ("This desk has 10 agents, the most it can hold." on Alliance).
- **Settings** (the drawer's first tab, `ui/Settings.tsx`), everything the lead can set up, by hand: name and purpose (counter, `caps.purposeMax`); key and model (`BindingPicker`); the look (`IconPicker`, `ToneWheel`, saved after a 400 ms pause so arrowing through sends one change; or a PNG checked here for type and `iconMaxBytes`, and scaled to 512 px in the browser when larger, `iconMaxPx`, with the desk's own refusal in the same words, `model/png.ts`); messages with other agents (the "Messages other agents" switch, off by default, with its hint; incoming links read only with their rules and "Change in {sender}’s settings"; and for each other agent whether it may message it, with its rules of engagement, required, counted, `rulesMax`; refused here with words first, `linkProblems`); the workspace (size up to `workspaceMaxMb`, use against it and the desk-wide total, "Nearly full…"/"Full…", paging past 500 entries, its files as a list with folders, a file read as text, delete, and which agents may read it); timers (list, add, change, switch, delete; once in so many minutes or hours, or at a date and time in the member's zone, or repeating on days at a time, or every so many minutes, at least `timerMinMinutes`; the next run in the member's zone, the last result and the spend); the way to its limits; and delete (never the lead; confirmed inline). It reads the whole agent with `agent.get`, again whenever `agent.state` changes it, and a form someone else changed under it takes the new value unless the member is mid-change.
- **The lead's proposals** (`ui/Proposals.tsx`, `model/proposals.ts`): a reply's `proposals` render under it as cards with every field of the payload (an unknown field still shows, by name), links with their rules, timers in words, Confirm and Decline. The card shows old and new from `before`, the origin when it isn't the member (dashed, "Suggested while answering {name}"), a cost-and-undo note, a removal as "Remove {name}" with what goes with it, and a purpose change as a diff to open first. Nothing applies without the member's yes. Confirm sends the card's own `sha256`, and is offered only once the card has checked that its payload's canonical JSON hashes to that `sha256` (keys sorted by UTF-16 unit, no whitespace, JSON.stringify's strings and numbers: RFC 8785 for what a payload holds); a mismatch says the card can't be confirmed. Afterwards the card collapses and says Done (with "Open <name>"), Declined, "Not done:" with the reason from `detail`, "Partly done" or Expired, which a card past its `expiresAt` says by itself.
- **Messages in threads:** a `user` message with `origin` (task 49, see "Proposed to the lead" below) shows who it's from ("From Researcher", or "Timer: Morning brief") and, for another agent's, "Rules for this pairing", collapsed. **Agent messages** (the drawer's last tab, `ui/AgentMessages.tsx`) lists `agent.a2a.list` for this agent or every agent: from, to, the text, the rules (collapsed), what came of it (`a2aStateText`: "Replied", "Refused: too many this hour"), the depth and the cost, with "Show older".
- **The mock** does all of it as the doc says: caps over the built-in defaults, `ag-` ids, the smaller `agent.state`, links checked as the desk does, proposals with the real `sha256` and every state (applied, declined, failed with `detail`, expired, answered twice is `conflict`), messages between agents with every limit (solo, no link, loop, depth, desk and pair rates an hour, the spend shares, busy, no key, a limit, age band, agent cap) logged, workspaces with paths checked and the quota held (`writeFile` for tests), timers validated with the per-agent cap and `nextAt` in the member's zone, an upload checked and kept as a mask (in a browser it makes the same white-alpha mask desk-agent does), and the audit rows (`proposal.make`, `proposal.answer`, `links.set`, `timer.set`, `timer.fire`, `a2a.send`, `a2a.refuse`, `icon.upload`, …), which Activity words.

**Proposed to the lead** (the doc doesn't name these yet; desk-agent should send them or say what it sends instead):
- A thread message's origin: `origin: {kind: "agent", agentId, rules, chainId, depth}` or `{kind: "timer", timerId, label}` on the `user` message that starts a run.
- `agent.a2a.list`'s `older` as a boolean, and `before` as the oldest row's `at` (epoch ms).
- `agent.icon.upload` answering `{agent}`; with nothing, `agent.state` brings the new `look.png`.
- `timer.lastState` words: `ok`, `busy`, `no_key`, `limit_reached`, `failed`, `missed`, `paused`, `over_cap` (the state table shows all of them).
- The audit actions' names besides `proposal.make` and `proposal.answer`: the ones the mock writes, listed above.
- Canonical JSON for `sha256` exactly as above. If desk-agent canonicalises differently, every card says it can't be confirmed: that's the safe way to fail, and the first real-desk test shows it.

Tested in `src/model/multiAgent.test.ts`, `src/model/proposals.test.ts`, `src/look/look.test.ts` (12 tones, the retired ids, the 9 ΔE00 gap), `src/mock/mockAgentClient.test.ts`, `src/client/rpcAgentClient.test.ts` and `tests/e2e/agents.spec.ts` (a new agent and the cap, the lead's proposals confirmed and declined, links with rules and the message they allow in the thread and the log, a timer and its run, an icon from the keyboard and an upload with its refusals, the workspace, one agent's own window, every theme and the small size).

## Files on a message (S-118b, ADR 0049)
The composer has an attach button, drag and drop, and paste. A file goes up as it is added, a chunk at a time (`client/attachUpload.ts`: 512 KiB raw, base64, one `agent.attach.put` each, in order, each with its own key; a chunk whose answer never came is sent once more with the same key). The desk holds it in memory for 10 minutes at most. Each file is a chip with its name and size and a Remove button. Sending with files and no words works.
- **Caps** come from `agent.attach.caps` when the thread opens (and again when the agent's model changes). They are checked before anything goes up and said once, plainly: the count, the total, the file size (the picture size for a picture), an empty file, and "can't read pictures" when `vision` is false. What a file is, is the desk's to judge by content, so the client doesn't refuse by extension. A desk without the method answers `not_found` and the composer shows no attach button.
- **Refusals** (`model/attachments.ts`, `attachErrorText`) name the file and the limit from `details.name` and `details.limit`. A `busy` desk keeps the files staged: the words and the chips stay, and the same send works in a moment. A refusal after the desk has read the files (an unreadable file, a limit, an agent cap) has already deleted them, so the chips go too, with a line saying so. `missing` (10 minutes passed) clears them the same way.
- **Nothing is kept in the browser.** `useStagedFiles` holds a name, a size and an upload id per file, never bytes. A file is read a slice at a time from its `File`, and each slice and its base64 text are dropped when the call that carried it answers. No IndexedDB, Web Storage or Cache Storage, and the mock keeps sizes only. Closing the thread, or removing a chip, aborts what's going up and sends `agent.attach.remove`.
- **In the thread**, a member's message shows "attached" chips (name, size, the desk's note) from the metadata `agent.thread.get` returns, and no content.
- **Keyboard and screen reader:** the attach button is a real button with a name; the picker opens from Enter or Space; each chip's Remove is a named button; the status line (`role="status"`) says what was left out, what was removed and "Drop to attach."; sent chips are a labelled list.
- **In the demo:** a file named with `encrypted` or `scanned` is refused as the desk would refuse it (`encrypted`, `no_text`); the mock reads no file.
Tested in `src/client/attachUpload.test.ts`, `src/model/attachments.test.ts`, `src/client/rpcAgentClient.test.ts`, `src/mock/mockAgentClient.test.ts` and, over the real client and link in all three themes with axe, `web/tests/e2e/agent.attach.shell.spec.ts`.

## Not built

Markdown in replies (plain text for now; design §9.1 wants react-markdown and remark-gfm, sanitized), tool-call chips (the lead's proposals are cards; other tool calls show nothing yet), a screen for the owner's file caps (`setAttachCaps()` is in the client), a model picker in the composer (it's in Keys), regenerate and edit-and-resend, background tasks and the Tasks tab, step-up for deleting a key or sharing it with other desks, checking the audit chain in the client (needs task 04's exact encoding), and the official provider marks (a neutral monogram until they're cleared).

## Screen recording

`media/agent-ui-walkthrough.mp4` (44 s, 1280x800, 624 KB, no metadata): the key flow on a new desk, a reply and a stopped one, Keys and the badges switch, Dusk and Dark, a refused message and the raised limit, Activity, and a small window in Dusk.

To make a new one: `npm run record` writes `recording/agent-ui.webm` (ignored by git), which carries a creation time. Strip it before it goes anywhere: `ffmpeg -i recording/agent-ui.webm -map 0:v:0 -map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact -c:v libx264 -preset slow -crf 30 -tune animation -pix_fmt yuv420p -movflags +faststart -an media/agent-ui-walkthrough.mp4`, then check with `ffprobe -show_format -show_streams` that no date, title or location tag is left.
