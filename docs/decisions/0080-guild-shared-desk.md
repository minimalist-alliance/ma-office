# 0080. A guild is one shared desk on its own server, up to 200 members

**Status:** Accepted (2026-11-07). The owner accepted every default of the draft on Nov 6 (Q12, Q16 closed; part of Q13 answered). Supersedes ADRs 0024 and 0025. Platform amends its ADRs 0019 and 0041 and its N12, N13, N14, N16 and N17 (done 2026-11-07). The draft was subcontractor task 20, updated 2026-11-06 with task 21's measured voice.
**Date:** 2026-11-06 (draft); accepted 2026-11-07
**Marks:** *(measured)* is from this task's probes in `spikes/guild-shared-desk/` or from another MA spike named beside it. *(model)* is arithmetic on stated inputs. *(guess)* is a judgement nobody has measured yet. Cost, price and margin figures are kept out of the public repository; this record keeps the engineering results.

## Accepted: the owner's decisions and the Guild Engineer's calls (2026-11-07)

**The owner's decisions.** On Nov 6 the owner accepted all of the draft's defaults below. In particular:
- **Up to 3 guilds per member and up to 200 members per guild.** Both are settings (`maxGuildsPerMember`, `maxGuildMembers`).
- **Commons settings:** joining muted or unmuted is a Commons setting (decision 2 of the Commons questions). A guild has one main channel, plus extra channels that guild Officers create, up to a configurable number (`maxCommonsChannels`, default 10). Everything else in Commons is as built.
- **Statistics, not addresses.** The owner, verbatim: "we will never show addresses, but we can show certain accumulated and calculated statistics for guilds". So the guild server sees connection addresses (decision 3) and the Founder and Officers never do. They see aggregates only: active members, busiest hours and Commons hours, as counts.
- **Price.** Keep $200 for any guild size (decision 13), and plan guild servers into a Savings Plan once solid membership passes 200.

**The Guild Engineer's calls (task 48, 2026-11-07).** They change the text below as follows, and where this ADR's body says otherwise, these calls win:
1. **Guild chat lives in Commons channels.** Each Commons channel has voice, a live whiteboard and a running chat thread, like a Discord channel. The desk's own Chat app stays member-to-member, so the guild desk's apps are **Commons, Notebook and Agent** (the body's "four apps" and its "Chat" on the guild server read as the chat thread inside Commons channels).
2. **Joining is by request or invite.** A guild is unlisted by default. A listed guild shows in Discover and in Forums recruiting posts. The default join policy is a request, approved by the Founder or an Officer with `invite`. An invite is a link or a handle.
3. **Grants.** The Founder grants Officers from a fixed list: `moderate`, `invite`, `remove_member`, `manage_spaces` and the new `manage_agents`, which covers the agent limits (section 7). `manage_spaces` covers Commons channels and Notebook spaces. Officers get `moderate` and `invite` by default.
4. **Settings row `guilds#current`** in the settings table: `open` (a kill switch, default on), `maxGuildsPerMember` 3, `maxGuildMembers` 200, `maxGuildsLedPerLead` 1, `maxCommonsChannels` 10. The older `alliance.maxGuilds` is read as a fallback.
5. **Age rules.** Where age rules are off (prod today), every member reads as an adult, since prod sign-up attests 18+. Teens join guilds wherever age rules are on, and never see 18+ guilds.
6. **Removal is at once.** A roster change bumps the guild's roster version and Platform pushes it to the guild server, which drops that member's sessions and relay connections and updates grants live. The member reconnects only if still allowed, with a fresh token. Leaving works the same way.
7. **Handing over and closing.** The Founder can hand the guild to another Founder who leads no guild (the old Founder becomes an Officer with every grant), or close it: the server stops and its data is deleted after 30 days.
8. **Where the contract lives.** Platform side: `ma-platform` `docs/contracts/guild-sharing.md`, `auth.md` §4.5 (the `ma-guild+jwt` token), `gateway.md`, `desks.md`. Desk side: `deskd`'s `guild.*` methods, Commons, `desk-rtc` guild mode.

## The answer

**Sizing.** A 200-member guild needs one 4-core, 8 GiB server (c7g.xlarge) *(model)*. Voice is why: with all 200 in Commons and 10 talking, forwarding takes about 3 cores (task 21, measured). Up to 50 members a 2-core server is enough. The guild's network traffic counts toward each member's own 100 GB allowance (decision 4): about 4.9 GB a member a month typically, including 10 loud hours a month, and about 15 GB for heavy voice users *(model)*. If a Graviton3 core forwards voice more than about 3% slower than the EPYC core task 21 measured on *(guess)*, 200 members need an 8-core server, unless voices heard are capped at 3. The guild server load gate on real Graviton settles it (Consequences).

**"Data fetching from officer guild desk to member guild desks can't be that insane can it?"** It isn't, and it never was. Today's design moves about 0.2 GB per member a month between desks, which is free inside one zone. What cost money was a machine for every member. With one shared server there's nothing to sync to: a member's browser fetches only what they open, about 0.8 GB a member a month for pages and files *(model)*. Voice is the bigger share (section 3).

**"Are we assuming that a member can only be a part of one guild?"** No longer. Up to 3, as decided (`maxGuildsPerMember`, default 3). With no machine per member, a second or third guild costs the member nothing (section 4).

## Your decisions, each with my default

1. **The guild has its own server, with no screen, and the Founder's desks never host it.** **Default: yes.** Section 2.
2. **No member gets a Guild Desk.** Members use the guild's desk in their own browser, like a shared doc. The small Browser goes; links open on the member's own Personal or Work desk. **Default: yes.** Section 1.
3. **Members' browsers connect straight to the guild server,** so that server sees their connection addresses, as any server does. It never shows them to the Founder or Officers, and the platform still sees no content. **Default: yes, and the guild screen says so.** Section 5.
4. **Who pays for the guild's network.** Each member's traffic from the guild server counts toward that member's 100 GB allowance, the same as their own desks' traffic. **Default: yes.** The alternative is that the Founder absorbs it: section 3 shows both.
5. **Members' agents run on the guild server, under limits the Founder sets,** with the guild's key by default. A member may use their own key if the Founder allows it. The guild key is the one the leader assigns today (Q13). **Default: yes.** Section 7.
6. **A member's own agent conversations on the guild server are private to that member.** The Founder and Officers see usage (runs and dollars), not content. **Default: yes.** The alternative is that the Founder and Officers can open them too, like every space (T9).
7. **No browser tool for agents on the guild server.** You said "I don't think guild desks get browsers". A run that needs the web hands off to the member's own desk's agent. Measured cost, for reference: about 160 MiB a run for an ordinary page and 0.65–0.95 GiB for a heavy one, plus 0.2–0.33 GiB for the shared browser. **Default: no browser tool.** Section 7.
8. **Guild size: up to 200 members** (`maxGuildMembers`, default 200, replacing 25). Guilds open only after the guild server load gate passes at 200 (Consequences). **Default: yes.** Above 200 is enterprise.
9. **A Founder leads one guild per Founder subscription** (`maxGuildsLedPerLead`, default 1). Each guild has its own server, so leading a second one needs a second Founder seat, or a price for an added guild later. A Founder can still be an Officer or member of other guilds, up to `maxGuildsPerMember`. **Default: 1.** Section 4.
10. **When the guild server goes down,** there's no standby desk any more, since nobody has a Guild Desk. Instead: the cloud's automatic recovery, hourly snapshots, and members' open pages re-sending their edits. A warm standby is an enterprise add-on. **Default: yes.** Section 6.
11. **The guild server follows the 24-hour rule** on guild activity. The first member who opens a sleeping guild wakes it, in about 35–60 s (ADR 0026). The Founder may give it Give Back downtime, which applies to the whole guild. **Default: yes.**
12. **Leaving a guild:** access ends at once. That member's agent conversations on the guild server are deleted, and nothing else of theirs is kept, since there's no Guild Desk to retain for 30 days. **Default: yes.**
13. **Guilds of 51 to 200 members need a 1-year Savings Plan on guild servers** (Q15). **Default: keep the Founder price for up to 200 members, and plan guild servers into the Savings Plan before guilds open.** The alternative is a large-guild add-on for 51 to 200 members.

`maxGuildsPerMember` = 3 is already decided, as a platform setting the owner can change. It replaces Platform N13's one guild.

---

## Context

The owner, verbatim:
- "I can foresee guilds, especially guilds formed by companies and corporations, needing 200 seats. Obviously, if MA grows to that extend we can charge enterprise pricing, but will it really take more than what a $200 officer subscription can afford to support 200 members in a guild? Data fetching from officer guild desk to member guild desks can't be that insane can it?"
- "Also, are we assuming that a member can only be a part of one guild?"
- "I think the cost for the guild desks for all members should be paid for and accounted to the officer's guild desk. network costs are a different story but I don't see why each member guild desk needs its own compute unit because all things on the guild desk are shared. The guild's notebook is a shared resource kind of like collaborating on a google doc."
- "To me, the guild desk is like a LAN party or a server for a video game"
- "But an agent is super light right? its just routing LLM requests and calling MCP tool requests that hit other apps on the desk. The officer can set limits and/or restrictions to the agent"
- "I don't think guild desks get browsers. Instead they get a whiteboarding/meeting app which is basically a Teams meeting or slack channel or discord channel that is always open that people can drop into that always has an active whiteboard and the ability to save and go to other whiteboards." And: "Lets not support video in the first release. I like Commons"
- On guilds per member: "Being a part of a guild should feel like its a big deal and significant. It should be like a family if people are opting into it. But it would probably be what I recommend to companies wanting to use Minimalist Alliance for their engineering teams or misc teams (not full companies in one guild). So I'm not sure that we limit a person to single guild. But it also shouldn't be unlimited." He agreed to 3, as a setting.

*Tier words, 2026-11-07 (task 45):* in the owner's quotes above, "officer" is what is now called the Founder, the tier that founds and leads a guild (id `lead`). "Officer" now names the tier that was Pro, and a guild's Officers are those the Founder makes officers.

Today's design (design §4.5 and §11.2, ADRs 0024 and 0025, Platform ADRs 0019, 0033 and 0041):
- Every member in a guild gets their own Guild Desk (t4g.small) holding a replica of the guild.
- The replica syncs with the guild host, which is the leader's own interactive Guild Desk, sized by member count.
- Guilds are capped at 25 members, and a member can be in one guild (N13).
- The host's memory, by the design's estimate, is 3.5 GiB for the leader's own desk + 0.4 GiB + 0.03 GiB per member + 0.35 GiB per guild agent run.

What makes that design expensive is the machine per member, not the data. Everything a member's Guild Desk holds is a copy of something shared.

## Decision

### 1. Members use the guild's desk from their own browser, like a shared doc

**The guild's desk** is what members see: one more desk in their office, in the Guild scope, with three apps: **Commons, Notebook and Agent** (guild chat is the thread in each Commons channel; call 1 above). It has no Browser. It runs on the **guild server**, one machine per guild. Public copy calls it the "Guild Desk", as the guild app, the Management Console and the Desk app do (the Product Designer, Nov 8). "Guild server" is the docs' word for the machine.

**How a member opens it.** It's the same path as their own desk (ADRs 0022, 0023), with one difference: the token.
- The Desk app asks Platform's gateway for a session to the guild server. It gets a `guild_member` token: `aud` is the guild server, `sub` is the guild-scoped `memberId`, and it carries `gid` and `grole`.
- The Desk app opens one WebRTC connection straight to the guild server, DTLS end to end. Platform only signals it.
- Data channels carry each app, framed as today (§4.2.4). Commons' voice is an audio track on the same connection (task 21).
- The gateway relays sealed SDPs, as the chat spike recommends (`spikes/chat/README.md` §4.7).

**The apps render in the member's browser,** and the data lives on the server, as with a Google Doc:
- **Notebook:** TipTap and Yjs in the browser, synced with the guild server's Notebook sync service over the channel. That's the same protocol as between a member's own desk and its client. Task 02 recommends Hocuspocus 4. History and the Temporal view are served from the server.
- **Chat:** guild channels are append-only logs on the server, ordered by `(epoch, seq)` (ADR 0024). Catch-up comes in batches. Direct messages between guildmates never touch the guild server: they go desk to desk between members' own desks (the chat spike's Q-C1).
- **Commons:** the always-open room, built in task 21. The board syncs with Yjs, and voice goes through a forwarding server (SFU) on the guild server.
- **Agent:** the member's agent seat on the guild server (section 7).
- **Files:** content-addressed blobs on the server, fetched when opened, 25 MB per file.

**Offline and flaky networks.** The browser holds what's open. Yjs keeps unsent edits and merges them on reconnect. A Chat post shows "pending" until the server gives it a `seq`. With "Trust this device" (design §4.3), recent pages and pending edits survive a closed tab in IndexedDB. That copy is purged on sign-out, and when the guild list no longer holds that guild.

**Never sluggish.** Typing, drawing and scrolling are local, and the server merges in under a millisecond (task 02, arm64). A member's round trip to the guild server is their own internet trip, the same as to their own desk. Today it's member → own Guild Desk → host, so this removes a hop from every live edit and from Commons.

**What becomes of the per-member things on today's Guild Desk:**

| Today, on a member's Guild Desk | Now |
|---|---|
| The replica of guild spaces | Gone. The server is the only copy; the browser holds what's open |
| The member's own agents | The member's agent seat on the guild server, acting with that member's access, under the Founder's limits (section 7) |
| The small Browser (minified only, design Q12) | Gone. A link in a guild page offers "Open on Personal" or "Open on Work". That desk's Browser and its session are untouched, and carry over as always (ADR 0035) |
| Private Guild-desk notes | Gone. Private notes belong on the member's own desks. Nothing on the guild server is private from its Founder and Officers except a member's own agent conversations (decision 6) |
| The Guild Desk's lifecycle: provisioning, the purge at boot, the 30-day retention and export (§4.5.1, N12) | Gone for members. Joining shows the guild's panel at once. Leaving ends access at once. There's nothing of the member's left to purge or retain |
| A Guild Desk's share of the member's vCPU quota (Platform ADR 0028) | Gone. A member uses 4 vCPU whether or not they're in a guild |

### 2. The guild server is its own machine, with no screen

**It's never the Founder's interactive desk.** The reasons:
- **The Founder's desk must never get sluggish.** The Founder's desk encodes 60 fps video while the Founder browses (1.5–1.7 cores, measured, `docs/benchmarks/2026-11-real-stack.md`). On the same two cores, a 200-person Commons room, Notebook sync and 8 agent runs would compete with it. The room alone takes about 3 cores with 10 talking (task 21). cgroup weights soften that, but they don't promise 60 fps. On separate machines, guild load can't touch the Founder's frame rate.
- **Privacy.** The Founder's desk runs a Browser with the Founder's cookies, and that Browser is the most attacked part of any desk (seven Chrome zero-days exploited in 2026 by September; task 12 §1). A booby-trapped site that escaped Chromium there would reach the whole guild's data. A server with no Browser has none of that surface. It also keeps Platform ADR 0019's rule, "no member's client connects to another member's desk", true: the guild server is nobody's desk.
- **It belongs to the guild, not to a person.** A leadership handover changes the roster, and no data moves. Today it means promoting a standby and switching hosts (§4.5.6).
- **Sized on its own.** It grows with the guild, and the Founder's desks keep their normal size. Founders' primaries match members' (Platform ADR 0033).
- **Cheaper.** The host no longer carries 3.5 GiB for an interactive desk, so a whole 200-member guild fits in about 1.5 GiB *(model, section 3)*. Voice needs 4 cores from 51 members up, CPU the Founder's desk couldn't spare either.

**What runs on it:** the desk image without a screen. It runs `desk-rtc` (ICE-lite, as on any desk), `deskd` in its guild role with Chat inside, the Notebook sync service, Commons, `desk-agent`, and the file store. There's no Xorg, encoder, PulseAudio or Chromium. These are the same core services as a desk's (ADR 0040), not a second stack. Its data is under `/data/guild/<guildId>/`.

**Who administers it:** the Founder and the guild's Officers, through the apps' own settings: members and roles, spaces and access lists, Commons boards, agent limits and the guild key. Nobody has a shell on it. MA's own access is the same audited break-glass path as for any desk, which members are told about (Q2).

### 3. Size at 10, 25, 50, 100 and 200 members

**Updated with task 21's measured voice** (2026-11-06, `sub/guild-cost-voice`). This section first sized Commons' voice from LiveKit's published benchmark, with half the guild in the room and at most 3 voices forwarded. Task 21 built Commons and load-tested it at 200 members. Its voice costs far more CPU than that estimate, so the 100- and 200-member tiers move from c7g.large to c7g.xlarge. Task 20's first figures stay beside the new ones below, and in `cost/config.json` under the keys ending in `Before`.

**The load model.** It uses this task's measurements, task 21's load test and other MA spikes, x86_64 numbers scaled to arm64 where marked. The full inputs, each marked measured, model or guess, are in `cost/config.json`.

| Part on the guild server | RAM | Basis |
|---|---|---|
| OS, SSM agent, journald, Docker | 300 MiB | *(guess)*: design §11 says ~200 MB, plus Docker |
| `deskd` in its guild role, with Chat | 116 MiB + 0.25 MiB a session | 116 *(measured, c7g.large, desk-agent README)*; per session *(guess)* |
| `desk-rtc`, one session per connected browser | 11 MiB + 0.8 MiB a session | **0.67–0.68 MiB a session at 200, 0.75–0.76 at 400** *(measured, `sessions/`, two runs, Pion v4.2.26 as desk-rtc, five data channels a session with traffic)* ×1.1 for arm64 *(guess)* |
| Notebook sync (Hocuspocus) | 70 MiB + 2 MiB per page open | 70 *(measured, arm64, task 02)*. A short page is far less and the 100-page page 9.2 MiB, so the 2 is *(guess)* |
| Commons: board and voice | 15 MiB + 0.68 MiB per person in the room, ×1.1 for arm64: 166 MiB with all 200 in | **50, 84 and 151 MiB with 50, 100 and 200 in the room and 10 talking, and 147 MiB with 200 all muted** *(measured, task 21, x86_64)*. ×1.1 for arm64 *(guess, as for desk-rtc)*. Commons' voice is its own Pion connection per member, beside desk-rtc's session, so both rows count. The first estimate was 50 MiB + 2 MiB a person, 250 MiB at 200 |
| `desk-agent`, with its HTTP client and TLS | 128 MiB + 3 MiB per run at once | 94 MiB idle and **+1.4 to 2.1 MiB a run** *(measured, x86_64, `agent-mem/`)* ×1.36 for arm64 (desk-agent README's own ratio) |
| Headroom for page cache and bursts | ×1.3 | *(guess)* |

**Commons' voice, as task 21 measured it.** `commons-server` is a forwarding server (SFU) on Pion, in Go. Each member hears up to 10 voices at once, in slots, and the most recently loud keep them. The load test ran it alone in a container capped at 6 CPUs and 5 GB on a build server, an AMD EPYC 7402. Every simulated member joined voice, and talkers sent a packet every 20 ms without a pause. That's the worst case: real speech with Opus DTX sends almost nothing between words. The board was busy too, with 10 cursors moving and 2 people drawing. Source: `apps/commons/README.md`, "Load test (for task 20)", and `loadtest/results/`, on `sub/commons` at `9f31cca`.

| What | Task 21, measured (EPYC 7402, everyone in the room) | In this model (Graviton) | Task 20's first estimate (LiveKit, half the guild in the room) |
|---|---|---|---|
| Commons CPU, 10 talking (10 heard) | 2.96 cores (3.21 in the peak second); voice only 2.51 | 2.96 vCPU on c7g, 3.70 on t4g | 0.20 vCPU with 3 forwarded and 100 in the room; 0.40 with all 200 |
| Commons CPU, 3 talking | 2.00 cores | 2.00 vCPU on c7g | 0.08 vCPU with 1.2 forwarded on average |
| Commons CPU, all 200 muted | 0.17 cores | 0.17 vCPU on c7g | — |
| Cost of a forwarded packet | 25 µs of a core (10 talking, voice only); 45 µs with 3 talking and the board | same, × 1 on c7g | 13.3 µs |
| Commons memory | 151 MiB at 10 talking, 147 all muted (x86_64) | 166 MiB (×1.1 for arm64) | 250 MiB |
| Network in / out, 10 talking | 6.1 / 138.7 Mb/s (115,565 packets/s out) | 62.4 GB an hour out | 8.2 Mb/s out for 50 in the room with 10 talking and 3 forwarded |
| Network out, 3 talking | 54.1 Mb/s | 24.3 GB an hour | — |
| A voice on the wire | 60.8 kb/s | same | 55 kb/s |
| Voices heard at once | up to 10 | same | at most 3 |

- **CPU: nearly 8 times the packets, and twice the cost a packet.** At 200 with 10 talking, the server sends 115,565 packets a second. The first estimate had 15,000: 100 listeners, 3 voices each, 50 packets a second. Each packet costs about 25 µs of a core, where LiveKit's benchmark implied 13.3. A room of 200, all muted, costs 0.17 cores.
- **CPU doesn't fall in step with talkers.** 3 talking cost 2.00 cores, against 2.96 for 10, because each packet costs more when fewer go out at once. For 3 talking at other sizes, the model takes the 10-heard curve × 2.00 / 2.96. It interpolates by members between 50, 100 and 200, and in proportion below 50, where nothing was measured *(model)*.
- **From an EPYC core to a Graviton vCPU.** The load test's cores are CPU time on an otherwise idle 24-core, 48-thread EPYC 7402 (Zen 2, at most 2.8 GHz by task 21's README). So each is close to a whole Zen 2 core. A Graviton vCPU is a whole core too. The model takes **one Graviton3 vCPU (c7g, Neoverse V1) for one EPYC core, and 1.25 Graviton2 vCPUs (t4g, Neoverse N1)**, from AWS's "up to 25% better compute performance" for Graviton3 over Graviton2 *(guess)*. Two effects are left to cancel:
  - Three fifths of the server's CPU is in the kernel. In the test each send also paid to deliver the packet into another container on the same host, which a real network card doesn't charge. That favours the cloud server.
  - EC2's virtual network card has its own cost a packet, and allowances on packets a second. That goes against it.
  - Task 02's merge timing is the one workload in the repo run on both: 0.73–0.77 ms on c7g.large, and 1.0–1.05 ms on a build box, which was under load. It doesn't argue for a higher ratio.
  - The guild server load gate on real Graviton replaces this guess (Consequences).
- **Network: a voice is 60.8 kb/s on the wire,** measured at the server container's interface: 121.1 Mb/s out for 1,990 forwarded voices. The first estimate's 55 kb/s counted from the IP header up, so the new figure errs high by up to a tenth. Ten voices heard is the most anyone gets, so 20 people talking cost what 10 cost (139.1 Mb/s against 138.7).

**Server size.** CPU in the busy hour is 0.05 base, 0.0005 a member for data and 0.05 per agent run *(guess)*, plus Commons from the table above, all in vCPU of that server. Every member is in the room *(guess: an all-hands or a guild event does that; the first estimate had half)*. **Busy** is 3 talking. **Worst** is 10 heard, with talkers never pausing. A tier fits when busy stays under the load gate's 70% line and worst under 90%, so voice never queues. Network is separate, in the next table.

| Members | Tier | Server | vCPU / GiB | RAM need, peak | Busy-hour CPU, 3 talking / 10 heard | Hours a day on credits | Agent runs at once | Disk (GB) |
|---|---|---|---|---|---|---|---|---|
| 10 | XS | t4g.small | 2 / 2 | 0.9 GiB | 0.36 (18%) / 0.45 (23%) | all day | 2 | 25 |
| 25 | S | t4g.small | 2 / 2 | 0.9 GiB | 0.71 (36%) / 0.95 (48%) | 11.9 h | 3 | 40 |
| 50 | M | t4g.medium | 2 / 4 | 1.0 GiB | 1.28 (64%) / 1.76 (88%) | 5.7 h | 4 | 55 |
| 100 | L | c7g.xlarge | 4 / 8 | 1.1 GiB | 1.77 (44%) / 2.44 (61%) | fixed | 6 | 75 |
| 200 | XL | c7g.xlarge | 4 / 8 | 1.5 GiB | 2.55 (64%) / 3.51 (88%) | fixed | 8 | 115 |

- **Tiers are settings** (`guildServerTiers`): member count, instance, agent runs at once and the guild's file quota (10, 25, 40, 60 and 100 GB). Disk is a 10 GB root plus the quota plus 5 GB for databases. Snapshots are hourly, keeping 24, plus daily, keeping 7, of the data volume only.
- **What changed: 100 and 200 members move from c7g.large (2 vCPU / 4 GiB) to c7g.xlarge (4 / 8 GiB).** With 200 in the room, even 3 talking needs 2.55 vCPU, more than c7g.large has. 10, 25 and 50 members keep their servers.
- **t4g tiers now run the busy case on CPU credits, not under the baseline.** This section first said the peak stays under the t4g baseline (0.4 vCPU) up to 50 members. With measured voice, that holds only up to 10 members.
  - t4g.small and t4g.medium earn credits at 20% of each vCPU (AWS). Averaged over a day, a guild server can run the busy case for the hours in the table at no extra cost: 11.9 h at 25 members and 5.7 h at 50 *(model)*.
  - That's enough for an always-open room where 3 people talk without a pause for only part of the day.
  - A day busier than that is billed as surplus in unlimited mode, rather than slowing voice. Platform's surplus guard never applies to a guild server (Consequences).
  - A 50-member guild that talks all day needs c7g.large. Tier M also holds only while a t4g vCPU needs at most about 1.28 EPYC cores' time.
- **The risk at 200 is now how fast Graviton is.** c7g.xlarge holds 200 with 10 heard at 88% *(model)*.
  - If a Graviton3 vCPU is more than about 3% slower than an EPYC 7402 core at this work, the worst case passes 90%. The fallback is c7g.2xlarge.
  - Capping voices heard at 3 in big rooms holds c7g.xlarge up to about 13% slower.
- **At 100 it's the other way round.** c7g.large is enough in either of two cases:
  - Graviton3 does the work in about 0.69 of an EPYC core's time.
  - At most about 62 people are in the room's voice at once.
- **Forward only the loudest speakers, and never forward silence.** Commons does both. The most recently loud keep the slots, muted members' packets are dropped at the server, and with Opus DTX a silent member sends almost nothing. Its cap is 10 voices heard, not the 3 this ADR first asked for.
  - Capping at 3 lets no tier use a smaller server in this model.
  - But it cuts the loud room's network by about three fifths: 54.1 Mb/s against 138.7 at 200.
  - It also gives the 200 tier its headroom against slower cores. That's team question T7.

**Network, shown separately.** This is internet egress from the guild server to members' browsers, about 5% of it relayed through TURN. Ingress, such as members' voice and edits going up, is free. Usage per member a month *(guess, `cost/config.json`)*:
- **Ordinary voice-hours:** an hour in Commons while someone is talking, with 1.2 voices heard on average. Light is 10, typical 30 and heavy 100, as before, now at 60.8 kb/s a voice.
- **Loud hours, new:** hours a month the whole guild is in the room at task 21's worst case, with 10 voices heard without a pause and the board busy. That's about 0.69 Mb/s a member, 312 MB a member-hour: **62.4 GB an hour at 200 members.**
  - **The model assumes 10 loud hours a month, typical:** about one loud two-and-a-half-hour event a week.
  - Light is 0. Heavy is 30, about one most weekday evenings.
  - Real speech pauses, so a real loud hour sends less than this.
- **App data and files,** as before: light 0.1 and 0.1 GB, typical 0.3 and 0.5, heavy 0.6 and 2.0.

| Members | Light, GB a month | Typical, GB a month | Heavy, GB a month | Typical, task 20's first estimate, GB |
|---|---|---|---|---|
| 10 | 5 | 49 | 152 | 17 |
| 25 | 13 | 122 | 379 | 42 |
| 50 | 26 | 244 | 758 | 85 |
| 100 | 53 | 490 | 1,523 | 169 |
| 200 | 106 | 981 | 3,049 | 338 |

Per member a month at 200: light 0.53 GB, typical 4.91 GB, heavy 15.25 GB. Typical is 30 ordinary voice-hours (0.98 GB) plus 10 loud hours (3.12 GB). Task 20's first estimate was 1.69 GB.

**An hour of the loud room** (everyone in, 10 heard, talkers never pausing, board busy):

| Members in the room | Out | GB an hour |
|---|---|---|
| 10 | 6.9 Mb/s | 3.1 |
| 25 | 17.2 Mb/s | 7.7 |
| 50 | 34.4 Mb/s | 15.5 |
| 100 | 69.3 Mb/s | 31.2 |
| 200 | 138.7 Mb/s | 62.4 |

Under decision 4, each member's share counts toward their own 100 GB allowance. That's typically about 4.9 GB of it, and about 15 GB for a heavy user at 200 *(model)*. Every member is already planned at the full allowance, so the planned worst case doesn't move. To meter it, Platform needs a byte count per
 session from `desk-rtc` and from Commons. That's a kind of metadata it already sees for desks (ADR 0041). Members whose network blocks UDP reach voice through TURN on 443. That's the 5% share above, and the relay's CPU is Platform's, not the guild server's.

**RAM at 200 members, by part** (MiB, before the 1.3 headroom; task 20's first estimate was 1,603 MiB with headroom):

| Part | MiB |
|---|---|
| os, Docker | 300 |
| deskd with Chat | 166 |
| desk-rtc sessions | 176 |
| Notebook sync | 190 |
| Commons | 166 |
| desk-agent and runs | 151 |
| **Total** / with headroom | **1,149** / 1,494 |

With a browser tool allowed for 2 runs at once, it would be 2.3 GiB on typical pages and 3.9 GiB on heavy ones.

### 4. Several guilds per member, and per Founder

- **Per member: up to 3** (`maxGuildsPerMember`, default 3, a platform setting, as decided). Leading and being an Officer both count. Platform checks it when an invite is accepted or a request approved, and refuses the fourth with "You're in 3 guilds, the most you can be in."
- **Each guild is its own panel** in the member's office, with its own connection, opened when the member opens that guild's desk (design §4.2.8 already handles several desks on the canvas). Three guilds cost the member nothing extra. Each guild server counts them as one member.
- **Per Founder: one guild led per Founder subscription** (`maxGuildsLedPerLead`, default 1, decision 9). Each guild has its own server, sized by its own members, so two groups of people never share a machine or a failure. A small guild's server is small, so allowing a second guild would cost little. But it should be a price you set, not a side effect. Platform's N16 already said multiple guilds need a price for the extra host.
- **Several guilds never share one server.** Packing them would save little, since each small server is already small. And it would put two groups of people behind one kernel, which task 12 advises against (its §1).

### 5. Privacy: what each party can see

| Who | Sees | Never sees |
|---|---|---|
| **The platform** (MA's control plane) | The roster and roles. Which server is the guild's, its size and state. When each member's browser connects to it and for how long, from signaling. Bytes per session, for the allowance. Wake requests. All the same as today | Content: pages, posts, boards, voice, files, agent prompts and replies, space names, titles, access lists |
| **The guild server** (a machine MA runs for the guild; nobody has a shell on it) | Everything in the guild, at rest on its encrypted volume. Voice, decrypted in memory to forward it, never stored or recorded. Members' connection addresses, which any server needs to reply | Members' Personal and Work desks, their keys, their own chats |
| **The Founder and Officers** | Every space (T9, the owner's ruling). The member list, who's in Commons, and agent usage per member in runs and dollars | Members' addresses. Members' own agent conversations (decision 6). Anything on members' own desks |
| **Members** | What their access lists allow, who's in Commons, and display names and roles under guild-scoped `memberId`s (Platform ADR 0019) | Each other's addresses, desks or accounts |
| **MA staff** | Only through the audited break-glass path that exists for any desk (Q2) | — |

**What changes, for you to decide (decision 3).** Today a member's client talks only to their own desk, so only that desk sees the member's address. Now the guild server sees it too. That's no change to "the platform sees nothing". The platform's gateway already sees addresses for signaling, and still sees no content. But it's a new place an address reaches, so the guild's screen says: "The Guild Desk runs on a server MA keeps for the guild. Its Founder and Officers can open every space. MA can't see what's in it."

**What doesn't change:**
- Content goes only between members' browsers and the guild server, DTLS end to end. The SDPs are sealed, so the gateway relays blobs it can't read (chat spike §4.7).
- The chat spike's key-pinning findings carry over: pin on first sight, re-check at each link setup, block on change. Here the pinned key is the guild server's.
- Members' Personal and Work data never reaches the guild server. The Desk app never moves data between desks by itself, and agents on a member's own desk have no tool that reaches a guild server, or the other way round. A member copying something across is a deliberate act, as between any two of their desks.

**Two notes for the Security Analyst:**
- **Posts are vouched for by the server.** With no member Guild Desks, a post is no longer signed by the author's desk key (ADR 0024). The guild server attests the author from the session's token, and signs its `(epoch, seq)` entries. A server MA runs could forge a post: that's the same trust the guild already places in it for content. Signing in the browser (WebCrypto Ed25519 per device) is possible later.
- **Voice can't be end-to-end encrypted with a forwarding server** unless it uses SFrame (insertable streams). That's task 21's to weigh. The platform can't hear it either way.

### 6. When the guild server is down

Today other Officers' Guild Desks stand by with full replicas (§4.5.6). With no Guild Desks there are no standbys, and the design leans on:
- **The cloud's automatic recovery.** A failed host moves the server to new hardware, with the same volumes and address, in minutes. Members' connections come back through signaling.
- **Hourly snapshots,** keeping 24, plus daily ones, keeping 7. They're incremental, so they stay small. After a restore, every open browser re-sends its Yjs state, and documents merge with nothing lost that any open page had seen. Chat posts the server had taken after the last snapshot come back only from browsers that still hold them. So the worst case, losing a zone, can lose up to an hour of posts *(model)*.
- **Planned restarts** (image updates, resizes) happen in the guild's quietest hour, which the server learns. They take about 1–2 minutes. A connected member sees "The Guild Desk is restarting, about a minute" (ADR 0031's waking screen). Open pages stay readable, edits queue in the browser, Commons reconnects by itself, and agent runs resume as durable runs (ADR 0020).
- **Asleep.** Under the 24-hour rule a busy guild never sleeps. A quiet one wakes when a member opens it. Wakes count only if they start a stopped server, at most 6 an hour per guild (chat spike Q-C6). A post made while it sleeps is sealed to the server's key and held in Platform's mailbox, ciphertext only, until it wakes (chat spike Q-C5).
- **A warm standby** (a second, small server in another zone, such as a t4g.small, replicating continuously) is the enterprise add-on.

### 7. Members' agents on the guild server

**The owner was right: an agent is light.** Measured in the real `desk-agent`, booted as its own main does, with its usage ledger, audit log and key ring doing their real work. A thin SSE adapter on the JDK's HttpClient over TLS talked to a local fake model (`spikes/guild-shared-desk/agent-mem/`, x86_64 on the build server, 2026-11-06):

| desk-agent | Peak RSS | Per run |
|---|---|---|
| Idle, after two warm-up runs (HTTP client and TLS loaded) | 94.3 MiB | — |
| 1 run at once | 95.8 MiB | +1.5 MiB |
| 2 at once | 97.1 MiB | +1.4 MiB |
| 8 at once | 111.7 MiB | +2.1 MiB |
| 16 at once | 122.7 MiB | +1.7 MiB |
| 32 at once | 143.2 MiB | +1.5 MiB |
| Live heap, 32 at once (after a GC) | 22.5 MiB, from 8.5 idle | 0.43 MiB |
| One 200,000-token run on its own (an 857 KB thread, 3 calls) | 99.3 MiB, from 93.9 idle | +5.4 MiB |

- Each run is 8 model calls with a 12 KB tool result after each answer. Its thread grows to 130 KB, about 33,000 tokens. Each reply is 600 tokens streamed at 150 a second.
- desk-agent's shipped 96 MiB heap held them too: 2 runs peaked at 97.6 MiB, 8 at 107.4 and 32 at 138.2, with no out-of-memory exit.
- On arm64, multiply by about 1.36 (desk-agent's own ratio): about 2–3 MiB a run.
- **The design's 0.35 GiB a run is about 120–180 times too high,** and even a 200,000-token run takes about 7 MiB on arm64.
- Not included: real tools (a tool result here is canned text, as `deskd` would return it), `deskd` itself, and a real provider's TLS stack. The last is the same JDK client.

**With a browser tool**, measured separately (`browser-tool/`). This is Chromium 156 headless from Playwright 1.64.1, the repo's version. Each run gets its own context and tab, opens a real page, reads its text and accessibility tree, and takes a screenshot. The sum is PSS over every Chromium process, two runs:
- **The browser itself:** 216 MiB fresh, about 330 MiB 
once used, shared by all runs.
- **Each run's tab:** about 157 MiB 
on ordinary pages (Wikipedia, MDN, GitHub, Hacker News and BBC News open at once; 210–380 MiB each alone, over the fresh browser). For a heavy, ad-laden page that never settled in 30 s (The Verge) it was 0.65–0.95 GiB.
- So the design's 0.6 GiB is high for an ordinary page and low for a heavy one.
- A guild server offering it for 2 runs at once would need about 2.4 GiB at 200 members on ordinary pages, and 4.0 GiB on heavy ones. That's c7g.large or m7g.large, not counting the CPU of loading pages.
- Hence decision 7: no browser tool on the guild server.

**Limits the Founder sets** (in the guild's Agent settings, stored on the server; Platform never sees them):
- **Per member:** runs a day (default 20), dollars a day (default $1) and a month (default $10).
- **Per guild:** dollars a month on the guild key (default $50), and runs at once (the tier's value: 2 up to 8).
- **Tools:** read, search, edit pages within the member's access, post to channels, read boards. All on by default; each can be turned off.
- **Keys:** whether members may use their own key (default no).
- **Approvals:** destructive actions always need the member's approval, as today (§4.5.2).

The Founder's limits sit on top of desk-agent's own (ADR 0020). Runs queue fairly by member. Guild content is untrusted input for every agent (taint U, §9.7). A member's own key, if the Founder allows it, reaches the guild server sealed to that server, as keys reach desks (ADR 0012). It's held in RAM only, and the Founder and Officers never see it.

### 8. Where this study stops: the boundary with task 12

Task 12 (`docs/research/shared-desk-hosts.md`) covers **one member's own Personal and Work desks sharing a machine**, each in a gVisor sandbox. This study covers **guilds**. They don't overlap:
- **No member's desk runs on a guild server, and no guild server shares a machine** with any member's desks or with another guild. Task 12's default "No pairing by guild" holds, and so does its reason: guildmates know each other, which gives them the most motive to snoop.
- A guild server is shared at the application layer, like any web app's server. Members share data on purpose, through the apps and their access lists. That's not isolation between neighbours, which is task 12's subject. Nothing here needs gVisor or containers between members.
- Task 12's "a member's light Guild Desk, about 1 GB, could later join their machine" is moot: member Guild Desks go away.
- Its gVisor results (`sub/gvisor-test`, still running) change nothing here.

## Consequences

**Simpler:**
- No member Guild Desks: no provisioning on join, no replica, no purge at boot, no 30-day retention or export.
- No desk-to-desk sync protocol (`guild.ydoc`, `guild.log` and `guild.blob` between desks), no standby role and no host handover.
- No guild subnets for members (Platform ADR 0041).
- Guilds go from 25 to 200 members, and a member can be in 3.

**Harder, or new work:**
- `desk-rtc` must accept many client sessions on one server: 0.7–0.8 MiB each, measured. Today it serves up to 4. That's System Engineer work; `desk-rtc` is off limits to this task.
- `desk-rtc` must count bytes per session for the allowance.
- One server is now the guild's single point of failure, softened by section 6.
- Commons at 200 people is a real SFU workload: about 3 cores and 139 Mb/s out with 10 talking (task 21, measured). It puts 100- and 200-member guilds on 4-core servers.

**Asks of Platform** (Platform Engineer; nothing here edits `ma-platform`):
1. A `guild_member` client token and gateway routing of members' browser sessions to the guild server. Up to `maxGuildMembers` × 3 devices, outside the 4-sessions-per-desk limit.
2. Settings: `maxGuildsPerMember` (3), `maxGuildsLedPerLead` (1), `maxGuildMembers` (200), `guildServerTiers`, and where guild network is metered (decision 4).
3. A guild server lifecycle: provision on guild creation, resize when the member count crosses a tier, the 24-hour rule on guild activity, snapshot and keep for 30 days when archived. Amend ADR 0033: `guild_desk_size_member` goes, and `guild_host_size_*` become `guildServerTiers`.
4. Platform's CPU surplus guard (ADR 0081) never applies to a guild server.
5. Retire N12, N14 and the member side of ADR 0041 (member Guild Desks and their sync sessions). Flip N17: members' clients do connect to the guild server, with no Browser streaming, so the 165 GB 
a member in N17 doesn't apply. Amend ADR 0019's "no member's client connects to another member's desk" to name the guild server, which is no member's desk.
6. Plan guild servers into the Savings Plan (Q15) before guilds open.

**Design docs** (System Engineer): §4.5, §4.2.15, §8.6 and §11.2 to §11.5 change. Q12 and Q16 close. Q13's guild key stays, with members' own keys optional. ADRs 0024 and 0025 are superseded. ADR 0017's guild fan-out stays on the server, and its relay stays for direct messages.

**The guild server load gate** replaces the host load gate (§11.2), and runs before guilds open:
- **Load:** 200 simulated members' browsers over WebRTC. Each makes 1 edit a second across 20 pages, and the guild posts 1 chat message a second. All 200 are in Commons, driven by task 21's `commons-load`: 3 talking, then 10 heard with talkers never pausing. 8 agent runs go at once, and files are pulled at 5 MB.
- **Where:** on the XL tier's server (c7g.xlarge), and once with 100 members on c7g.large.
- **Pass:** a guild operation's p95 ≤ 150 ms, voice packets forwarded within 20 ms p99, and no out-of-memory kills. CPU ≤ 70% with 3 talking and ≤ 
90% with 10 heard. The network card's allowance counters 
(`pps_allowance_exceeded`, `bw_out_allowance_exceeded` in `ethtool -S`) stay at zero.
- **Then:** its CPU per forwarded packet replaces the guessed EPYC-to-Graviton ratio (`cpu.vcpuPerX86Core` in `cost/config.json`), and `cost/model.py` reruns.
  - If c7g.large holds 100 members, tier L moves back there.
  - If c7g.xlarge doesn't hold 200 with 10 heard, cap voices heard at 3 above 100 members (T7) before moving to c7g.2xlarge.
- **Cost:** a c7g.xlarge, a c7g.large and a load generator for about an hour each, a few dollars, on AWS test resources with the owner's say-so.

## Team questions (not for the owner), each with my default

| # | Question | Default |
|---|---|---|
| T1 (System, Desk) | Does the guild server run the same image and `deskd` with a guild role, or a slimmer image? | The same image with the screen services off, as member Guild Desks would have been. One image to keep current |
| T2 (Desk) | Notebook sync on the guild server: Hocuspocus (Node) or Java with Yrs? | Hocuspocus, as task 02 recommends. One damaged update from any of 200 browsers mustn't take down every app |
| T3 (Security) | Signed posts from the browser? | Not in v1. The server attests authorship (section 5) |
| T4 (Platform) | Is guild egress metered per session from `desk-rtc`, or estimated from the server's total split by connected time? | Per session from `desk-rtc`. It's exact and costs one counter |
| T5 (UI/UX) | What do the Founder and Officers see of agent usage? | Per member: runs and dollars this day and month, against the limits. No content |
| T6 (System) | Should the guild server keep a public IPv4? | Yes, as every desk does, for direct WebRTC. Dropping it would mean TURN for everyone |
| T7 (System, Commons) | Cap voices heard at 3 in rooms over 100? Commons forwards up to 10 | No, keep 10 while c7g.xlarge holds 200 in the load gate. If it doesn't, cap at 3 above 100 members: that holds c7g.xlarge with cores up to 13% slower, and cuts a loud room's network by three fifths |
| T8 (System, Desk) | Commons' voice: its own Pion connection per member, as task 21 built it, or an audio track on `desk-rtc`'s connection, as section 1 first said? | Its own, as built. Its port-per-core sending is what kept voice under 1 ms at 200. The model counts both, 0.68 MiB a member more |

## Sources

**Measured for this study** (`spikes/guild-shared-desk/`, x86_64, a build server, Docker, each container capped at 6 CPUs and 5 GiB, 2026-11-06):
- `agent-mem/`: the agent-run probe on the real desk-agent. Results are in `results/agent-mem-x86-*.jsonl`.
- `browser-tool/`: Chromium per agent run, two runs. Results are in `results/browser-tool-x86-run*.jsonl`.
- `sessions/`: Pion sessions on one ICE-lite UDP port, two runs. Results are in `results/sessions-x86-run*.jsonl`.
- `cost/model.py` and `cost/config.json`: the sizing tables above.

**Task 21's Commons load test** (`ma-desk` `sub/commons` at `9f31cca`, the same build server, the same container caps): `apps/commons/README.md`, "Load test (for task 20)", and `apps/commons/loadtest/results/*.json`. Section 3's voice CPU, memory and network come from it.

**MA, read only:**
- `ma-desk`: design §4.5, §8.6, §9 and §11; ADRs 0012, 0017, 0020, 0022–0027, 0033, 0035, 0040; `services/desk-agent/README.md` (footprint); `spikes/chat/README.md` (`sub/chat-spike`); `spikes/notebook-sync/README.md` (`sub/notebook-sync-spike`); `docs/benchmarks/2026-11-real-stack.md`.
- `ma-platform`: `docs/platform-design.md` §0 (N12–N17) and §4; ADRs 0019, 0028, 0033, 0041, 0058, 0081.
- Task 12's study, `~/work/research/shared-desk-hosts.md` (also `ma-platform` `docs/research/`).

**Published:**
- [LiveKit, benchmarks](https://docs.livekit.io/home/self-hosting/benchmark/), read 2026-11-06. "Large audio rooms": 10 publishers, 3,000 subscribers, 959,156 packets/s out, 80% CPU on a 16-core `c2-standard-16`. No version or date is given.
- [mediasoup v3, scalability](https://mediasoup.org/documentation/v3/scalability/), read 2026-11-06: "a mediasoup C++ subprocess can typically handle over ~500 consumers in total", and one worker runs on one CPU core.
- AWS, [burstable instances' baselines](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html), read 2026-11-06: t4g.small and t4g.medium earn credits at 20% a vCPU, t4g.xlarge at 40%.
- AWS, [C7g instances](https://aws.amazon.com/ec2/instance-types/c7g/), read 2026-11-06: Graviton3 delivers "up to 25% better compute performance" than Graviton2.
- Opus: [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716) (20 ms frames) and [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587) (RTP payload, DTX). RTP, [RFC 3550](https://www.rfc-editor.org/rfc/rfc3550); SRTP, [RFC 3711](https://www.rfc-editor.org/rfc/rfc3711) (the 10-byte tag).

## Addendum, 2026-11-10: how leaving deletes a member's agent conversations (audit Z28, Desk Engineer)

Decision 12 says that when a member leaves, "that member's agent conversations on the guild server are deleted, and nothing else of theirs is kept". Until now `deskd` only closed their sessions, and `desk-agent` kept everything under the member's `gm-` id, which is the same id again if they rejoin (`sha256(guildId:sub)`). Leaving, being removed and deleting the account all reach the desk the same way: the member is missing from a newer roster. This addendum says how that becomes a deletion. Deletion can't be undone, so the first rule is that a wrong roster must never cause one. Branch `sub/guild-member-purge`, `docs/sub-status/guild-member-purge.md`.

**When a purge is owed.** `deskd` compares each roster it applies with the last one it applied, whether that was read or loaded from `/data/desk/guild-roster.json` (`guild/GuildPurges`):
- A purge is owed only when a roster whose `version` is newer than the last applied one doesn't list a member who was in the last one.
- "Listed" means any entry naming that `memberId`, even one that's malformed in some other way. A member whose entry is malformed is refused, but is never taken as gone. The kept roster now records these ids (`listed`), so this holds across a restart.
- Nothing is owed from the first roster a desk ever has 
(none read and none kept), from a read that fails or answers 503, from another guild's roster, from a malformed body, or from an older or same version. A member who just has no session owes nothing either: sessions are never compared.
- A closed guild (`closed: true`) owes nothing here. Its server and data go by decision 7 (30 days).

**The guard against a roster that suddenly lists almost no one.** All of a roster's drops are **held** instead of owed when that roster:
- lists no Founder (`lead`);
- has an entry whose member id can't be read; or
- drops more than half of the last roster's members at once.

Held purges are never sent. A held purge becomes owed only when a later roster, one with a higher version, still doesn't list the member, and is itself sound: it lists a Founder, every entry is readable, and it isn't closed. That later roster's own new drops face the same guard. `/health` shows `guildPurges: {owed, held, done}` as counts, with no member named. The log does the same, and says which rule held them.

**Coming back.** Any roster that lists the member again cancels their 
purge, whether it 
was owed or held, so they keep their data. A purge isn't sent for someone the current roster lists. There's also a **grace of 10 minutes**: an owed purge waits that long after the roster that made it owed. So a roster the Platform corrects at once deletes nothing. Access still ends at once, as before.

**The list.** `/data/desk/guild-purges.json` holds `{guildId, purges: [{memberId, state: owed|held, version, dueAtMs}], done}`. It's written whole (temporary file, fsync, rename) at `0600`, and **before** the roster that changed 
it is kept. If the list can't be written, the roster isn't kept either, so after a crash or a full disk the next start compares again instead of losing the purge. A list for another guild is ignored. An entry leaves the list when `desk-agent` answers.

**How deskd tells desk-agent.** `desk.member.purge {memberId}` goes on the agent socket as a plain `req` of deskd's own, with no caller, the same way `desk.prices.set` goes (`agent/AgentPurges`).
- **No client can send it.** It's not on `AgentMethods`' lists, so a client session gets `not_found` (the owner) or `forbidden` `scope` (a member) before anything reaches `desk-agent`. `desk-agent` also refuses it, `forbidden` `permission`, from any frame that carries a caller, which every request deskd relays for a client does, and from a member caller in any case (`desk.*`).
- **One at a time.** A purge goes once it's due and desk-agent is connected. One owed while desk-agent is down waits for the next connection. One whose answer was lost goes again, and that's harmless, because the purge is idempotent.
- **Retries.** An error answer is retried after 5 s, doubling up to 5 minutes. A `desk-agent` older than this one answers `not_found`, and is asked again only on the next connection.
- **Completion.** The answer is `{purged: true, agents, messages, files, 
usage, staged}`, all counts. deskd removes the entry, adds one to `done`, and logs the counts.

**What desk-agent deletes** (`AgentService.purgeMember`, `AgentStore.purgeMember`, `UsageLedger.forget`). It takes only a `gm-` id, so the owner's lead and staff agents can't be named.
1. The member's run is stopped first, and the purge waits up to 5 s for it to end. If it doesn't end, the answer is `conflict` `busy` with nothing deleted, and deskd retries.
2. In one `agent.db` transaction it deletes the agent's row, and with it the name, the key binding, the limits and the unseen count. It also deletes the thread's messages, the `message_files` notes of those messages, and every proposal, timer, link and agent message that names the agent. A member's agent never has those last ones, but they go anyway.
3. In memory it clears the member's runner and per-agent limits, wipes the files they had half attached in staging, and drops the subscriptions of their own views.
4. **Usage is kept as the guild's spend, not theirs.** Their `usage.db` rows get `agent_id` and `run_id` `guild:departed`, an id no agent can have, and lose the token breakdown. The time, key, model, tokens and dollars stay, so the guild's month (`desk_month`) and its key's month still count what was spent. The rows go after 100 days, as every row does. `guild.usage.get` lists only members who have an agent, so `guild:departed` never shows there. As a consequence, a member who leaves and is let back in starts their own day and month caps again, while the guild's cap still counts what they spent before.
5. **Nothing left in the files.** desk-agent now opens every SQLite file with `secure_delete` on, so a deleted row's bytes are zeroed, both in its page and in pages that are freed. After a purge, `agent.db` and `usage.db` are checkpointed with `wal_checkpoint(TRUNCATE)`, which empties the WAL. A purge whose WAL can't be emptied answers `unavailable`, and the retry does it. One limit: bytes that an older desk-agent freed, without `secure_delete`, can stay in a file's free space until SQLite reuses that space. That matters only for a Guild Desk that ran a desk-agent from before this one, and none hosts members yet outside the test desk.

**The hash-chained audit log keeps its rows.**
- Its rows hold no content: an 
actor, an action, a target id, a payload's hash, a decision and a cost, never a prompt, a reply, a file or a name.
- A row can't be removed or rewritten without breaking the chain, and catching changes is the reason the chain exists.
- The rows go after a year, as every row does.
- 
A purge adds one more row: `system member.purge agent:gm-…`.
- What the rows 
name is the guild's pseudonymous `gm-` id. A Founder or an Officer with `manage_agents` can read those rows in `agent.audit.list`. If the member rejoins, their old rows are under the same id again. We accept that: the rows hold activity counts, never content, so "nothing else of theirs is kept" still holds for content.

**What stays, on purpose.**
- Notebook text the member wrote 
stays. Other members built those pages with them, and decision 12 names only agent conversations. The same goes for Commons boards and chat threads.
- `/data/desk/guild-audit.jsonl` keeps its record of who changed the guild's settings, for the same reason as the agent's audit log.

**The owner's desk.** None of this runs there. Its roster is never read, so no purge is ever owed, nothing is sent, and `/health` has no `guildPurges`.

**Also from the audit:**
- 
**Z30.** Before any roster has been read or kept, a guild desk now answers every member `desk_not_ready`. Before, the token stood alone, so a removed member's unexpired token could get in on a fresh desk, or after a restart with no kept roster and a failed read.
- **Z29.** A SUB whose topic has a control character, a NUL included, is `bad_request`. No client's NUL can now reach the key under which deskd keeps a member's own subscription.
