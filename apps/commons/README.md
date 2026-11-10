# Commons (`apps/commons/`)

Commons is the guild's always-open room: voice, and a live whiteboard that's always up, with saved
boards to switch between. It's the guild desk's app in place of a Browser (task 21). The owner:

> "I don't think guild desks get browsers. Instead they get a whiteboarding/meeting app which is basically a Teams meeting or slack channel or discord channel that is always open that people can drop into that always has an active whiteboard and the ability to save and go to other whiteboards."
>
> "To me, the guild desk is like a LAN party or a server for a video game"
>
> "Lets not support video in the first release. I like Commons"

Task 48 made it the guild's real meeting and chat space on the Guild Desk, the guild's one shared server: members come
in through `deskd`'s relay with the identity their token proves, and Commons has **channels** (a main one and the
ones the Founder or an Officer with `manage_spaces` makes), each with its own voice, live board, saved boards, people
and **chat thread**, plus two settings, **join muted** and **how many channels**. The owner: "commons should have a
main channel and a certain number of extra channels that the guild officer can create"; join muted or unmuted
"should be a config for Commons". Task 21's status and the owner's decisions are in
[`docs/sub-status/commons.md`](../../docs/sub-status/commons.md); task 48's in the branch's `STATUS.md`.

| Folder | What it is |
|---|---|
| [`web/`](web/) | The UI module, laid out like `web/notebook/` (task 03): React 19, TypeScript, Yjs, a plain canvas. The Desk app imports `web/src/index.ts` as source. `web/demo/` is the standalone page |
| [`server/`](server/) | `commons-server`, in Go: deskd's relay socket, channels, boards, chat, settings, the voice forwarding server (SFU) on Pion, with listeners for voice that `desk-rtc` relays from port 443. With `-dev`, also the stand-in guild server for running locally. And `commons-load`, the load generator |
| [`deploy/`](deploy/) | Running it on a Guild Desk: the systemd unit, its env file, `run` and `health` |
| `release.sh` | Builds the release artifact `ma-update` installs |
| [`loadtest/`](loadtest/) | Running the load test on the build server, and its results |
| `run.sh` | Builds both and runs Commons locally, in `-dev` |

## On a guild desk: deskd's relay (contract, task 48)

Agreed with the Desk Engineer (`sub/deskd-guild-sessions`, `docs/sub-status/deskd-guild-sessions.md`, "Commons"). This
is what `commons-server` listens for in production; the WebSocket room link is for `-dev` only.

- **Socket:** `/run/desk-commons/commons.sock` (`-relay-socket`; deskd's `DESKD_COMMONS_SOCKET`). Directory
  `2750 commons:desk`, socket `0660`. User `commons`, uid 1110. `deskd` (uid 1100) connects; Commons listens.
- **Peer check:** Commons reads `SO_PEERCRED` on every connection and closes any whose uid isn't deskd's
  (`-relay-uid`, default 1100), since group `desk` is wider than deskd.
- **Framing,** as `notebook.sock`: `u32be` length of what follows, `u8` type, body; at most 4 MiB + 64 KiB.
  `0x01` is a JSON object with a `t`. `0x02` is one whole room-link message (Commons' `[type u8][length u32 LE]
  [payload]` records, as many as fit), at most 4 MiB. Commons keeps every message it sends under 1 MiB, and splits a
  record bigger than that into `Part` records (type 9) that the other end joins, both ways.
- **One connection per deskd session.** deskd's first frame is
  `{"t": "hello", "sessionId": "cs-…", "sub": "gm-…", "caller": {"kind": "guild_member", "memberId": "gm-…",
  "role": "lead"|"officer"|"member", "grants": [...], "name": "…", "badge": "officer"|"lead"|null, "teen": false}}`.
  `{"t": "caller", "caller": {…}}` follows a token refresh that changes it, and applies from the next frame: Commons
  updates that member's name, badge, role and grants at once (a lost grant stops the matching actions at once). A
  `caller` that changes `kind` or `memberId`, or a first frame that isn't a hello from a `guild_member`, closes the
  connection. `teen` is never shown or stored.
- **Identity comes only from the hello and caller frames.** Names, member numbers and roles inside room-link messages are
  ignored, the name in the client's own `hello` included.
- **Closing** is the only liveness. deskd closes a member's connections when they're removed or their session ends; the
  client then gets deskd's `{"t":"reset"}` and its next message opens a new connection with a new hello. Commons ends a
  member's room link by closing the socket connection.
- **Metering, Commons to deskd** (the owner's decision 4: a member's guild traffic counts to their own allowance, and
  voice is the bulk). On each member session's connection Commons sends a JSON frame (`0x01`)
  `{"t": "usage", "voiceBytesSent": n}`: `n` is the RTP bytes Commons' SFU has sent to that session's voice connection
  since it began (packets as written, before SRTP and UDP; the room link's own bytes are already in `desk-rtc`'s
  counts). Every 30 s while the voice connection lasts, and once more when it ends, with `"final": true`. A new voice
  connection (leaving and joining again, a restart of voice) starts again at 0; deskd sums per session: each final
  value, plus the latest value of the connection still open. Reports for a session come in order and never after its
  final. If the session's connection to Commons is already gone when its voice ends, the final report can't go, and
  the last 30-second one stands.
- **Voice** stays Commons' own Pion connection on its own UDP ports (draft T8), signalled over the room link
  (`rtc-offer`, `rtc-answer`, `rtc-ice`). Each voice connection is bound to the connection's verified `memberId`.
- **Browser side:** on a guild desk the Desk app's channel 4 is `commons`. Each room-link message is one DATA with BIN,
  sent whole; a non-BIN `{"t":"reset"}` means reconnect. `DataChannelLink` (`web/src/net/channelLink.ts`) takes that
  channel.

## Run it

```bash
apps/commons/run.sh        # needs Go (~/.local/go) and Node 24 (~/.local/node-v24)
```

On the shared machine, build under its lock first, then run:
`flock ~/work/.build.lock nice -n 10 apps/commons/run.sh --build-only`, then `apps/commons/run.sh`.

`run.sh` starts `commons-server -dev`. Open <http://127.0.0.1:8790/?name=Ana&role=lead&badge=lead> in one browser,
`?name=Ben&role=officer&badge=officer&grants=moderate` in another, `?name=Cy` in a third (or private windows; each needs
its own microphone permission). The server listens on 127.0.0.1 only: HTTP on 8790, voice on UDP 8791 and up, one port
per core, at most 8 (`COMMONS_ADDR`, `COMMONS_UDP` move them). Data is kept in `server/data/`.

URL options: `?theme=light|dusk|dark`, `?frame=0` (no window frame), `?guild=<name>` (the title), `?channels=0` and
`?chat=0` (start with either hidden), and who you are: `?role=lead|officer|member`, `?grants=moderate,manage_spaces`,
`?badge=officer|lead`, `?member=<id>` (default: one made from the name). The page's room link goes the way a guild desk
carries it: through `/dev/channel`, the server's stand-in for deskd's relay, which plays the guild desk's `commons` data
channel over a WebSocket and connects to the relay socket as deskd does. `?link=ws` uses the plain `-dev` WebSocket
instead (`?room=<id>` picks a room there). Never run `-dev` on a guild desk: it takes a member's name and role from the
URL.

## What's in it

- **Channels.** One main channel, and extra ones the Founder or an Officer with `manage_spaces` makes, renames and
  deletes (after a confirm: a channel's boards and chat go with it, and whoever is in it lands in the main one). The
  main channel can be renamed, never deleted. At most `maxChannels`, the main one included: 10 by default, which the
  Founder (or `manage_spaces`) can set lower, never above the roster's `maxCommonsChannels`. The list shows who's in
  each channel's voice, who's talking or muted, how many are only looking in, and a dot where there's chat you
  haven't read.
- **Each channel has its own voice, board, saved boards, people and chat.** A member is in one channel at a time:
  going to another while in the room takes their voice along, with nothing renegotiated. Joining from a second window
  takes them out of the room in the first, so a member is in one voice at a time.
- **Chat beside the board,** like a Slack or Discord channel that's always open. Messages get a number from the
  guild server, which keeps them on disk; older ones load as you scroll up. Write, edit and delete your own; the Founder
  and Officers with `moderate` can delete anyone's, and that's written to a local audit log (who, which message, when;
  never its words). Up to 4,000 characters. Links are plain links, never fetched or previewed. A message shows as
  "Sending" until the server has it, and goes again by itself after a drop; a refused one says why, with Try again.
  Two messages a second per member, after a burst of ten.
- **Voice through 443** when a member's network blocks the voice ports, relayed by the guild desk's `desk-rtc`. If
  nothing gets through, a calm line says "Your network blocks voice here. The board and chat still work." with Retry.
- **Settings,** read by everyone and set by the Founder or `manage_spaces`: **Join muted** (off by default: everyone
  joins talking, as Discord does) and **Channels** (how many).
- **Names and seals from the guild.** On a guild desk the name, role and grants come from the member's verified token
  through deskd, never from the page. Beside each name: the Founder seal or the Officer seal, as the Desk app draws them.
  Never anything about age.
- **One always-open room per channel.** Everyone with Commons open sees the board live and who's in
  the room. **Join** puts you in with one click: voice on, and the board becomes yours to draw on.
  **Mute** is one click or Ctrl/⌘+Shift+M; **Leave** is one click. The people list shows who's in
  the room, who's talking and who's muted, and also who's only looking in.
- **Voice only.** No camera is ever asked for, and the server's media engine knows only Opus, so no
  video can be negotiated. No screen sharing either, since that's video too.
- **A live whiteboard, always up,** with everyone's cursors and names. Pen (pressure on a pen,
  smoothed with perfect-freehand), sticky notes, text, rectangles, ellipses and arrows, an eraser,
  select and move, undo and redo of your own changes, pan and zoom (wheel, trackpad pinch, two
  fingers, Space-drag), six inks and three sizes. Colors are stored by name, so a board reads well
  in every theme: "Ink" is dark on Light and light on Dark.
- **Boards are kept on the guild server as you draw.** A new board is "Untitled board" with a
  **Save** button that names it. The **Boards** list shows every board, newest edit first; opening
  one puts it up for everyone in the room ("Ben opened Sprint plan"). Boards can be renamed and
  deleted. A blank, unnamed board is dropped when the room moves on from it.
- **Light, Dusk and Dark** from the Desk app's own tokens and Inter, as the app looks today (the
  brand kit switch, ADR 0065, is parked). Commons' own few colors are in `web/src/theme/tokens.ts`.
- **Shortcuts:** V select, H hand, P pen, N note, T text, R rectangle, O ellipse, A arrow, E eraser,
  Ctrl/⌘+Z and Shift+Ctrl/⌘+Z, Delete, Ctrl/⌘+A, +/−, Shift+1 to see the whole board, Shift+0 for
  100%, Escape.

## How it works

```
 member's browser                       Guild Desk
 ┌───────────────────────┐  desk's    ┌───────────┐  commons.sock  ┌──────────────────────────────────────┐
 │ Commons (web/src)     │  WebRTC,   │ desk-rtc  │  (Unix socket, │ commons-server                       │
 │  RoomClient ──────────┼─ channel 4 ┼▶ deskd ───┼─ caller from  ─┼▶ channels: members, boards, chat     │
 │  BoardEngine (canvas) │  `commons` │  (token)  │  the token)    │   board logs and chat logs on disk   │
 │  Voice ───────────────┼── WebRTC, DTLS-SRTP, audio only, UDP ───┼▶ SFU (Pion): forwards, never decodes │
 └───────────────────────┘   (UDP 8791 up; or 443, UDP or TCP,     │ 127.0.0.1:8799: voice desk-rtc relays│
                              relayed by desk-rtc when that's blocked)└──────────────────────────────────────┘
                                                                 └──────────────────────────────────────┘
```

**Identity.** On a guild desk the only way in is deskd's relay socket (above, "On a guild desk"): the member's id,
role, grants, name and badge come from deskd's hello and `caller` frames, from their verified token. Commons checks
roles itself: channels and settings need the Founder (role `lead`, who holds every grant) or `manage_spaces`; deleting
someone else's message needs `moderate`. A refreshed token that changes a member's grants applies to their next action.
With `-dev` the identity comes from the URL, and only then.

**The room link** carries records `[type u8][length u32][payload]`, several per message
(`server/internal/wire`, `web/src/net/protocol.ts`): control messages as JSON, and board updates,
cursors and work in progress as binary. The server packs whatever is queued for a member into one
message. A link carrying only cursors sends at most once a frame (16 ms), since a screen shows them
once a frame anyway; strokes in progress, board records and control messages never wait. On a guild desk the link is the Desk app's `commons` data
channel (channel 4), relayed by deskd to `commons.sock`: `DataChannelLink` (`web/src/net/channelLink.ts`) takes it.
A message is at most 1 MiB there (deskd takes 4); a bigger record, a big board's snapshot, goes as `Part` records
(type 9) the other end joins. The client only sees the `CommonsLink` interface; `WebSocketLink` stays for `-dev`.

**Channels** are kept in `<data>/commons/commons.json` with the settings. The main channel's boards stay where task 21
kept the room's (`room.json` and `boards/` at the room's root), so a room from before carries over as the main
channel; each other channel has `channels/<id>/` with its own. Each channel's voice is its own SFU room, so a member
hears only their channel; moving a member's voice is a change to which slots they're dealt, with no renegotiation.

**Rates, per member:** cursors and strokes in progress 240 a second (past it they're dropped, as they'll be replaced);
finished board updates and snapshots 120 a second after a burst of 480, and 2 MiB a second after 16 MiB (Security's
GDS-6): past it the member's link is slowed, not dropped, since a lost Yjs update would leave their board apart from the
room's, and a member who'd have to wait more than 5 s is cut off; chat 2 a second after 10. `/stats` counts the board
waits (`boardPaced`).

**A channel's budget** (Security's GDS-6, `store.ChannelBytes` and `store.MaxBoards`): a channel's boards hold at most
256 MiB together, by their logs, and it has at most 100 boards. A board that isn't up is never compacted, so the rate
alone let a member fill the disk. Past the budget an update is refused with `{"t":"error","code":"full","id"}`, stored
and relayed to no one, and if the board up has entries since its last snapshot, its client is asked to compact it,
which frees room; a compaction that would make a board bigger is taken only within the budget. A new board past the
cap gets the `boards` error. With each board's `.prev`, a channel's boards take at most 512 MiB on disk. The Commons
web client doesn't yet say anything for `full` (as for `too-big`), so the member's edit stays unsaved until a reload.

**Chat** is a log per channel (`chat.log`): posts, edits and deletes, each post numbered by the server. Only an index
(about 30 bytes a message) stays in memory; pages are read from the file. An edit or a delete overwrites the words it
replaces with zeros in place, so they don't stay on disk. A post carries a nonce from the client; a resend after a drop
gets the same message back, not a copy, across a restart too. Moderators' deletes, and channel and settings changes,
go to `audit.log` (append-only, who and what, never a message's words).

**Boards** are Yjs documents (MIT, as Notebook uses). Each item is a `Y.Map` in the map `items`, so
two people can move and recolor one item at once and both changes keep. The server never parses
Yjs: a board is a log of the updates members sent, each given a sequence number, replayed to
whoever opens it and relayed to everyone else as it arrives. When a log passes 400 entries or
512 KB, the server asks one member's client for its whole document and puts that in place of the
entries it covers (Yjs updates commute and repeat safely, so a snapshot that holds a little more
than it claims does no harm). The log before the last compaction is kept as `.prev`. Edits made
while the link is down are kept and sent once it's back. Strokes in progress, shapes being dragged
out and moves are sent as they happen but never stored; only the finished item is.

**Voice** is WebRTC to a forwarding server (an SFU) on Pion, the same library `desk-rtc` uses.
Each member has one connection to the guild server. Their offer carries one sendrecv audio line
(their microphone, and the first voice they hear) and nine recvonly lines: ten slots. The server
deals the room's talkers into those slots, rewriting SSRC, sequence numbers and timestamps so each
slot is one steady stream, and tells the member who is in which slot. So a member's connection
never renegotiates however many people come and go. When more people are unmuted than a member has
slots, the ones heard most recently keep them, judged by the RFC 6464 audio level each browser
already puts on its packets (the server reads that header; it never decodes audio). The same level
drives the green speaking ring. Muted members' packets are dropped at the server too. The server
offers Opus with `usedtx=1`, so a browser sends almost nothing while its member is silent, which
is most of the time in a big room. Members are spread over one UDP port per core (ICE-lite on a UDP
mux per port; 8791 up, locally), and sends go out with `sendmmsg`, many packets per system call:
the load test found that a single socket's sends serialize in the kernel, which at 100,000 packets
a second queued voice by hundreds of milliseconds.

**Why Pion, for footprint.** Commons' whole server (room link, boards and voice) is one static Go
binary of 17 MB that uses about 15 MB of memory idle (the load test has it at each size). It needs
no runtime on the guild server, and Pion is the library the desk already ships in `desk-rtc`, so
the System Engineer knows it. The other two candidates, not measured here:
- **mediasoup** (ISC) has the leanest forwarding core, in C++, but it needs Node plus a compiled
  C++ worker on the server and `mediasoup-client` in the browser, and its own signaling on top.
- **LiveKit server** (Apache-2.0) is built on Pion too, but it's a whole media product: rooms and
  their API, its own tokens, simulcast and video layers, TURN, and an egress service that records.
  Voice-only Commons would use little of it, and recording is something Commons must not have.

A plain SFU on Pion with slots does exactly voice and nothing else. The load test below says where
it stands.

## Privacy

- Voice goes only between each member's browser and the guild server, as DTLS-SRTP, the
  encryption every WebRTC call has. The guild server forwards packets; it never decodes, mixes or
  stores audio. There's no recording.
- Boards and cursors go only between members and the guild server, on the room link. On a desk,
  that's the desk's own WebRTC connection, DTLS end to end (ADR 0022).
- The platform carries none of it. When a member's network blocks the voice ports, the guild desk's own `desk-rtc`
  relays the same encrypted packets on 443 to Commons on the same machine; it can't read them either
  for a member whose network blocks UDP, and it can't read those.
- The people list shows who's looking in as well as who's in the room, so nobody watches unseen.
- The Guild Desk holds the boards and chat, on its own disk. Deleted and edited messages' old words are wiped from the
  file, not only hidden. The audit log keeps who deleted which message, never its words.
- Commons never shows anything about a member's age. deskd's caller has a `teen` field for services with age rules;
  Commons has none, and neither keeps nor shows it.

### Voice policing (Security's NET031-2)

The SFU holds each talker to what Opus voice needs, in `server/internal/voice/police.go`, before it forwards or counts
anything. A browser sends 20 ms frames: 50 packets a second, 32 to 64 kbit/s with the header, less in DTX silence. So
a packet is **dropped** if it is over **400 bytes** (header and extension included), or if the talker's token buckets
are empty: **128 kbit/s** and **100 packets a second**, each with a 500 ms burst (a stalled network delivering its
backlog at once). Dropped packets are never forwarded, so they are never in a listener's `voiceBytesSent` (the
metering, above) and never cost a listener's allowance; muted talkers are policed too. A second in which a talker
dropped 5 or more packets is "over"; after **5 seconds in a row** over, the SFU closes that talker's voice connection
and tells its room link `{"t":"rtc-down","reason":"policed"}`. The client reconnects as it does for any lost voice
connection and shows a notice; a fresh connection starts with full buckets, so a client that keeps flooding is still
held to the caps and closed again every few seconds. Silence for a whole second starts the count over.

| Setting | Flag | Env (`/etc/ma/commons-server.env`) | Default |
|---|---|---|---|
| Bytes a second, in kbit/s (negative: off) | `-police-kbps` | `COMMONS_POLICE_KBPS` | 128 |
| Packets a second | `-police-pps` | `COMMONS_POLICE_PPS` | 100 |
| Biggest RTP packet | `-police-max-bytes` | `COMMONS_POLICE_MAX_BYTES` | 400 |
| Seconds in a row over before the close | `-police-abuse-secs` | `COMMONS_POLICE_ABUSE_SECS` | 5 |

`/stats` adds `policedPackets`, `policedBytes` and `policedCloses`. Tests: `internal/voice/police_test.go`.

## Performance

`npm run perf` (`web/tests/perf/perf.mjs`) runs two members in headless Chromium at 1280x800,
DPR 1, against the stand-in server, with real input through CDP. Three runs on the build server
(EPYC 7402, in the Playwright container capped at 6 CPUs), all three alike:

| What | Result |
|---|---|
| Panning and zooming a board of 2,200 items (2,000 strokes, 100 notes, 100 rectangles), 60 wheel events a second for 3 s | 60 fps, no missed frames, worst frame 16.8 ms, no long tasks |
| Drawing on that board: pointer event to the frame that shows it | 14 to 15 ms at p50 and 15 to 16 ms at p95 (the rest of the frame the event lands in); 60 fps, no missed frames |
| Another member's stroke: sent to the frame that draws it | 16.5 ms p50, 17 ms worst: the next frame. The link and the server take about 0.5 ms (round trip 0.5 to 1.1 ms) |
| Voice: a tone in one member's audio to its arrival in another's | 121 to 126 ms p50, of which the jitter buffer is 35 to 39 ms. **The same tones over a plain WebRTC call between two connections in one page, with no server, take 114 to 123 ms**, so Commons adds a few milliseconds; the rest is the browser's own capture, 20 ms Opus frames, jitter buffer and playout with fake devices. The load test puts the server's share under 1 ms at p50 |
| Join: the click to voice connected | 130 to 160 ms |

**After task 48** (the channel list and chat beside the board, the room link through the stand-in for deskd's relay),
two runs on the build server, the same script: panning and zooming 60 fps with no missed frames (worst 16.8 ms, no long
tasks); drawing 60 fps, pointer to frame 14.2 to 14.3 ms at p50 and 15.6 to 15.9 ms at p95; another member's stroke
on the next frame at most (17.2 ms worst); voice 110.5 to 122.9 ms at p50 against 115.1 to 116.7 ms for a plain call;
join to voice 148 to 184 ms. The script now moves the pointer relative to the board, which has the channel list to
its left.

Indicative only: software compositing, fake audio devices, everything on one machine, and not a
member's device. Budgets B1 to B3 (design §2.2) are proven only on the reference devices.
Results go to `web/tests/perf/results/` (ignored by git).

## Load test (for task 20)

Simulated members in one room, on the build server, so task 20 can size the guild server.
`BUILD_HOST=user@host loadtest/run-build-server.sh all` (and `DOCKER=` the Docker CLI, if it isn't
`docker`); results in `loadtest/results/`; `python3 loadtest/table.py` makes this table.

| In the room | Talking | Board activity | Server CPU, cores (peak second) | Memory | Network in | Network out | Packets out/s | Voice through the server, p50 / p99 | Strokes through the server, p50 / p99 |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 10 | yes | 1.19 (1.37) | 50 MiB | 2.2 Mb/s | 34.4 Mb/s | 28,824 | 0.49 / 1.3 ms | 0.51 / 1.68 ms |
| 100 | 10 | yes | 2.04 (2.19) | 84 MiB | 3.6 Mb/s | 69.3 Mb/s | 57,885 | 0.82 / 3.33 ms | 0.85 / 3.44 ms |
| 200 | 10 | yes | 2.96 (3.21) | 151 MiB | 6.1 Mb/s | 138.7 Mb/s | 115,565 | 0.91 / 3.59 ms | 1.25 / 4.6 ms |
| 200 | 10 | no | 2.51 (2.78) | 158 MiB | 2.3 Mb/s | 121.1 Mb/s | 101,812 | 0.98 / 3.02 ms | – |
| 200 | 3 | yes | 2.00 (2.27) | 148 MiB | 5.7 Mb/s | 54.1 Mb/s | 44,293 | 1.35 / 3.79 ms | 1.35 / 4.36 ms |
| 200 | 20 (10 heard) | yes | 3.00 (3.20) | 152 MiB | 6.8 Mb/s | 139.1 Mb/s | 115,919 | 0.62 / 3.26 ms | 1.27 / 5.34 ms |
| 200 | 0, all muted | no | 0.17 (0.28) | 147 MiB | 1.6 Mb/s | 0.2 Mb/s | 321 | – | – |

**Where it ran:** the build server, an **AMD EPYC 7402** (24 cores, 48 threads, 2.8 GHz at most),
Ubuntu 24.04 with kernel 6.8, Docker 28.5. The server ran alone in `ma-sub-commons-server`, a
static binary built with Go 1.25.14; the simulated members in `ma-sub-commons-load-0` and `-1`
(100 each). Every container was capped at 6 CPUs and 5 GB, on a Docker bridge network of their
own with no published ports.

**How:** members join at 20 a second, settle for 10 s, then 60 s are measured. Each opens the
room link, joins, and opens a voice connection with ten slots (DTLS-SRTP, Pion as the client).
**Talkers talk the whole time:** an Opus-sized packet (80 bytes, about 32 kb/s) every 20 ms with an
audio level that says talking, so this is the worst case; real speech with Opus DTX sends almost
nothing between words. **Board activity** is 10 members moving a cursor 30 times a second and 2
drawing a one-second stroke every 2 to 4 s, then sending a real Yjs update of about 0.9 KB (from
`web/scripts/make-load-fixtures.mjs`). CPU (user plus system) and memory (RSS) are the server's own,
from `/proc` inside it; network in and out is its container's interface, so every header is
counted. `docker stats` agreed (`*.dockerstats`). "Through the server" is a talker's or drawer's
send time, stamped in the packet, to a listener's receipt, on one host's clock: both SRTP
contexts, the forwarding, the kernel and the bridge. Every run had all members joined and on
voice, no errors and no dropped packets at the server.

**Reading it for task 20:**
- **Network out ≈ members × voices heard × 60 kb/s,** plus about 18 Mb/s of cursors and strokes at
  200. A voice is about 60 kb/s on the wire (32 kb/s of Opus plus RTP, SRTP, UDP and IP headers, 50
  packets a second). Ten voices is the cap: 20 people talking at once cost the same as 10. In
  data: 138 Mb/s is about 62 GB an hour, the worst case at 200; three talking at once is 54 Mb/s,
  about 24 GB an hour. Network in is small: each talker sends one voice.
- **CPU ≈ 25 µs per forwarded packet here** (a quarter of a core per 10,000 packets a second, at
  200 with voice only), three fifths of it in the kernel. On this setup each send also pays for delivering the packet to
  the receiving container on the same host, which a real network card doesn't charge to the
  sender, so a cloud host should do somewhat better per packet; but its vCPUs may be slower, and
  instances have packets-per-second allowances. 200 members with 10 talking needed 3 cores of
  this EPYC; a quiet room of 200 (all muted) 0.17.
- **Memory** is about 0.7 MB per member (147 MB at 200, idle), plus a 17 MB binary.
- **Latency** stayed low at every size: voice through the server 0.5 to 1.4 ms at p50 and under
  4 ms at p99, strokes in progress 0.5 to 1.4 ms at p50 and under 6 ms at p99. Cursors wait at
  most one frame (16 ms), on purpose.

**What the load test changed.** The first run at 200 had voice queued by 163 ms at p50 and 430 ms
at p99, and cursors costing 1.4 cores. Two fixes, both measured: a single UDP socket's sends
serialize in the kernel, so the server now spreads members over one port per core (200 with 10
talking: 0.9 ms at p50); and cursors now go at most once a frame per member, which took board
activity at 200 from 1.4 cores to 0.45. `-udp-sockets` and the pacing are in the server.

### Task 48: channels, chat and the relay at 200

The same test, after task 48, on the same build server, 200 members in one channel (the worst case for one room):
`PREFIX=ma-sub-48-g5 RESULTS=results/48-guild loadtest/run-build-server.sh guild`; results in
`loadtest/results/48-guild/`. The chat row adds 20 members each posting a 100-character message every 5 to 15 s
(about 2 a second, each delivered to all 200), timed from send to every other member's receipt.

| In the room | Talking | Board activity | Server CPU, cores (peak second) | Memory | Network out | Packets out/s | Voice through the server, p50 / p99 | Strokes, p50 / p99 | Chat, p50 / p99 |
|---|---|---|---|---|---|---|---|---|---|
| 200, task 21 (above) | 10 | yes | 2.96 (3.21) | 151 MiB | 138.7 Mb/s | 115,565 | 0.91 / 3.59 ms | 1.25 / 4.6 ms | – |
| 200, task 21's code again, the same hour (`48-guild/task21-baseline/`) | 10 | yes | 2.86 (3.18) | 152 MiB | 139.0 Mb/s | 116,065 | 0.96 / 4.53 ms | 1.22 / 5.57 ms | – |
| 200, task 48 | 10 | yes | 2.87 (3.10) | 155 MiB | 138.7 Mb/s | 115,559 | 0.89 / 4.2 ms | 1.21 / 5.12 ms | – |
| 200, task 48 | 10 | yes, and chat | 2.86 (3.10) | 157 MiB | 139.7 Mb/s | 116,020 | 0.97 / 4.05 ms | 1.21 / 4.8 ms | 1.32 / 5.26 ms |
| 200, task 48 | 0, all muted | no | 0.18 (0.33) | 152 MiB | 0.2 Mb/s | 321 | – | – | – |

The same within the box's noise: the forwarding path didn't change, and channels, chat and identity cost nothing a
room of 200 notices. Chat at 2 messages a second added nothing measurable. The first runs of the two task 48 rows
(`*-run1.json`) overlapped other work on the build server and had p99 tails of 8.5 to 13.5 ms at the same p50; run
again alone, they're the rows above. The load generator connects over the `-dev` WebSocket room link; on a guild desk
the same records come through deskd's socket.

## Tests

| Where | Command | What it runs |
|---|---|---|
| `web/` | `npm run typecheck`, `npm run lint` | TypeScript; ESLint with the Desk app's color-literal rule, and the app's CSS color check |
| `web/` | `npm test` | Vitest, 42 tests: task 21's 27 (wire format, work in progress, items, hit tests, names, board sync against an in-memory stand-in for the server, contrast), and 15 for task 48: voice blocked after 8 s or when ICE fails before connecting, and Retry; `DataChannelLink` (whole messages, deskd's reset and the hello after it, backing off, a new channel for a new session, big messages in parts, a plain RTCDataChannel) and chat (pending until numbered, sent once after a drop, refused with a reason and tried again, a rate refusal retried, edits and deletes, a thread per channel and unread marks, older pages, join muted) |
| `web/` | `npm run e2e` | Playwright on the built page and the real server in `-dev`, Chromium with a fake microphone, every member through the stand-in for deskd's relay. `guild.spec.ts`: three members with roles and badges; only the Founder can make a channel; voice per channel, and voice following a member who moves; chat with a plain link, unread marks, editing your own, a moderator's delete; a refreshed token granting `manage_spaces` at once; join muted; deskd dropping a member's connection and the member coming back by themselves; deleting a channel. Chat kept across a server restart, and a message held until the server has it. `blocked.spec.ts`: a guild desk whose voice can't be reached shows "Your network blocks voice here. The board and chat still work." after 8 s, with Retry, while the board and chat keep working. `room.spec.ts`, task 21's three, unchanged. Fails on any console error or warning, and on any request off the page's own host. Needs `../server/bin/commons-server` |
| `web/` | `npm run perf` | `tests/perf/perf.mjs`, below |
| `web/` | `node tests/perf/guild-shots.mjs` | The guild screenshots in Light, Dusk and Dark (after `vite build`), to `$SHOTS` |
| `deploy/` | `./test-health.sh` | `health`: healthy on a member's desk (no `/run/ma/guild`) with nothing running; on a Guild Desk unhealthy until `/healthz` answers `ok` and the relay socket is there |
| `server/` | `go test ./...` | 26 tests: the board store and slots (task 21's 4); deskd's socket (`SO_PEERCRED` refuses other uids, framing up to 4 MiB, hello rules, a write deadline that doesn't stick); callers and grants; channels and who may make them (a grant gained or lost at a refresh), settings kept across a restart and capped by the ceiling, chat threads (numbers, nonces, edits, moderators' deletes and the audit log, the 4,000 limit, the rate, a thread per channel, kept across a restart), one voice per member, a caller frame that changes the member ends the connection, task 21's room carried over; the chat log (pages, reopen, words wiped on edit and delete, a torn tail); `Part` records; voice through 443 (every ufrag starts with `cmns` and is its own; answers name only the public address, direct UDP first, then UDP and TCP 443; a connection through each loopback relay listener, UDP and ICE-TCP; the relay gate refusing spoofed and unknown ufrags, wrong passwords, junk and silence, and its caps) |
| `loadtest/` | `BUILD_HOST=user@host ./run-build-server.sh all` (or `guild`) | The load test, on the build server |

On the shared machine, wrap heavy runs in `flock ~/work/.build.lock nice -n 10 …`. Task 48's Playwright runs were on
the build server in `mcr.microsoft.com/playwright:v1.64.1-noble` capped at 6 CPUs and 5 GB; Vitest, TypeScript and
ESLint on the second build box; Go here.

## Recording

`web/media/commons-three-browsers.mp4`: 25 s, 1920x720, H.264, 0.5 MB. Three members in one
room, each in their own browser context: Ana in Light, Ben in Dusk, Cy in Dark. They join; Ana
sketches while the others watch it arrive; Ben types a note; Cy adds an arrow, a box and a label;
Ana saves the board as "Sprint plan"; Ben puts up a new board and everyone follows; Cy opens
Sprint plan again from the list; Ana mutes, and Cy opens the people list. Made on the build server
with `node tests/perf/record.mjs` (Playwright's video of headless Chromium, 640x720 each) and
`scripts/compose.sh`, which puts the three side by side with `-map_metadata -1 -fflags +bitexact`.
ffprobe finds only the container's brand tags, a handler name and `encoder: Lavc libx264`; no
dates, names, paths or hosts. `web/media/shots/` has stills in each theme from
`tests/perf/shots.mjs`, checked to carry no text or time chunks.

## Adopting it in the Desk app

**For the UI/UX Engineer** (as task 03 lays out for Notebook):
1. Dependencies: `yjs` 13.6.33 (Notebook needs it too) and `perfect-freehand` 1.2.3, both MIT. Or make `web/` an npm
   workspace with `apps/commons/web` in it.
2. A lazy chunk for the Guild Desk's Commons window: the demo page is about 120 KB gzipped of JS, React included.
3. Vite: add `commonsThemesPlugin()` from `apps/commons/web/vite-plugins/commonsThemes.ts`, import
   `virtual:ma-commons-themes.css` and `apps/commons/web/src/ui/commons.css` once. Commons reads the app's `--ma-*`
   tokens (the seal ones included) and `--ma-font-ui`, follows `data-theme`, and keeps its own few colors as `--ma-cm-*`.
   Everything is under `.ma-cm`, so nothing leaks.
4. Wiring, from `apps/commons/web/src/index.ts`:
   ```ts
   import { Commons, DataChannelLink, RoomClient } from '../../apps/commons/web/src/index.ts';
   // On a guild desk: the session's `commons` channel (channel 4), shaped like deskLink's CollabChannel
   // (open, onOpen, onMessage, onEnd('reset' | 'ended'), send). A plain RTCDataChannel works too.
   const link = new DataChannelLink(session.commons());
   const client = new RoomClient(link, {});
   <Commons client={client} title={guildName} />   // fills its window
   // A new desk session: link.attach(newSession.commons()). Closing the window: client.close().
   ```
   The channel carries each room-link message as one DATA with BIN, whole, as `collab` does; deskd's non-BIN
   `{"t":"reset"}` is `onEnd('reset')`, after which the link says hello again on its own (0.5 s, backing off to 8 s
   while resets keep coming). Keys act only while focus is inside Commons.
5. Voice is Commons' own WebRTC connection to `commons-server`'s UDP ports (draft T8), or to 443 through `desk-rtc`
   when those are blocked; no ICE servers are needed. It asks for the microphone only when the member joins. If nothing
   connects within 8 s, the room says "Your network blocks voice here. The board and chat still work." with Retry.

## Running on a guild desk

`commons-server` runs as its own service, `commons-server.service` ([`deploy/`](deploy/)). For the System Engineer,
who adds it to the image recipe from these files:

- **User `commons`, uid 1110,** in no other group (as `notebook` is kept out of `desk`). `image/recipe/build.sh`'s user
  list gains `commons:1110`.
- **The relay socket's directory** `/run/desk-commons`, `2750 commons:desk`, and **the data directory**
  `/data/guild/commons`, `0700 commons:commons`. The unit makes both before it starts (`ExecStartPre=+install …`), so
  nothing else is needed; a line in `image/recipe/files/etc/tmpfiles.d/ma.conf`
  (`d /run/desk-commons 2750 commons desk -`) would do the first as well.
- **Only on guild desks** (`DeskKind=guild`), where `desk-xorg`, `desk-browser` and `desk-stream` stay off. The unit is
  skipped until a release is installed (`ConditionPathExists`).
- **Ports.** Voice: inbound UDP from 8791, one port per core, at most 8 (8791 to 8794 on a 4-vCPU `c7g.xlarge`). HTTP
  `127.0.0.1:8790` for `/healthz` and `/stats` (counts only), loopback only. `127.0.0.1:8799`, UDP and TCP, for voice
  `desk-rtc` relays from 443 (below).
- **The public IPv4** for voice: `COMMONS_ADVERTISE`, or else `/run/commons-server.address`, which
  `commons-server-address.service` (a root oneshot ordered before it, `deploy/address`) writes from the instance
  metadata service at boot. Commons itself is denied the metadata service (`IPAddressDeny=169.254.169.254
  fd00:ec2::254`, Security's GDS-4); the rest stays open on purpose, because members send voice from anywhere. The
  address changes only across a stop and start, which runs both again.
- **Memory:** `MA_APP_MEMORY_MAX=768` (MiB; Go's soft limit is 90% of it) and the unit's `MemoryMax=1G`. 200 members
  took about 155 MiB in the load test; boards are held in memory, so a guild with many big boards takes more.
- **Hardening:** `ProtectSystem=strict`, writes only to its data and socket directories, no new privileges, only
  no capabilities (every port is above 1024), no metadata service, no outbound connection, no telemetry.
  SIGTERM flushes and syncs every board and chat log.
- **The ceiling for channels,** the roster's `maxCommonsChannels`, comes from the env file (`COMMONS_MAX_CHANNELS`,
  default 10). If deskd ever passes the roster's settings in its hello (`"limits": {"maxCommonsChannels": n}`), Commons
  takes that at once instead.
- **Release:** `apps/commons/release.sh` builds `commons-server` for arm64 and amd64 and packs
  `dist/commons-server-<version>.tgz` (arm64) with `VERSION`, `run`, `health`, `address`, `commons-server.env` and the binary at
  its root, as `desk-rtc`'s build does, with its `.sha256`. Publishing (`scripts/desk-service-release.sh`) and pinning
  (`image/recipe/releases.pin`) are as for every component. `health` checks `/healthz` and the socket on a Guild Desk,
  and exits 0 at once on a member's desk (no `/run/ma/guild`), where the unit is skipped: `/opt/ma/smoke-test` runs every
  installed release's `health` on every desk, so a pinned `commons-server` must not roll back a member's update.

### Voice through 443

Members whose network blocks UDP 8791 and up reach voice through the guild desk's port 443, which `desk-rtc` holds
(the System Engineer's call: no extra ports, no TURN). Commons' side:

- **Every voice connection's ICE ufrag starts with `cmns`** (`voice.UfragPrefix`), and each connection has its own.
  `desk-rtc` (guild mode) reads the USERNAME of a STUN check on 443, and passes Commons' to Commons.
- **Commons listens for that relayed ICE on `127.0.0.1:8799`** (`-ice-relay`, `COMMONS_ICE_RELAY`; loopback only, or it
  won't start): UDP datagrams, and TCP as passive ICE-TCP (RFC 4571 framing). Every voice connection takes checks there
  as well as on its own UDP port.
- **A gate in front of both listeners** (`internal/voice/gate.go`): through 443 anyone can reach them, so they let in only
  a STUN binding request whose USERNAME names one of Commons' own live voice connections and whose MESSAGE-INTEGRITY is
  right for that connection's password; everything else is dropped before Pion sees it, with nothing kept for it and no
  reply of any kind (Security's GDS-3; the image's nftables keeps 8799 to `desk-rtc`). So a relayed check gets a binding
  success only for a live ufrag with the right password, which is what `desk-rtc` waits for before it keeps a mapping
  (GDS-1). On
  UDP an admitted client address then passes freely until its connection ends or it's quiet for 60 s, at most 4
  addresses a connection. On TCP the first RFC 4571 frame must be that request, within 5 s and at most 2 KiB; at most 2
  connections a voice connection and 64 waiting for a first frame at once. `/stats` counts refusals (`relayRefused`).
  **A check lets in one address or connection only** (Security's GDN-2): its transaction ID, which the signature
  covers, is kept against the address it let in (UDP) or the connection it came on (TCP), the last 64 a voice
  connection, gone with it. So a check someone watching the member's traffic captured and replays from addresses of
  their own gets nothing and takes none of the member's places; the member's own retransmission from the same
  address still goes. What's left: someone placed to get a captured check to the desk before the member's own can
  take one place a check, which is no more than dropping the member's packets would do.
- **Answers name the public address on 443** (`-ice-relay-port`, with `-advertise`), UDP and TCP passive, at lower
  priorities than the direct UDP port: a browser tries 8791 and up first, then UDP 443, then TCP 443. Loopback and
  private addresses never reach a member; each address and port is named once.
- **When nothing connects within 8 s** (or ICE fails before it ever connected), the room shows a calm line: "Your
  network blocks voice here. The board and chat still work." with Retry. A connection that worked and dropped still
  says "Voice didn't connect" with Try again.

Off in `-dev` unless `-ice-relay` is set. Tests: `internal/voice/relay_test.go` (the ufrag, the answer's candidates and
their order, a connection through each loopback listener with the direct port taken away), `internal/voice/gate_test.go`
(unknown ufrags, wrong passwords, junk, silence and oversized frames refused with nothing kept; the caps; an ended
connection let in no more; a replayed check let in from no other address or connection, GDN-2) and
`web/tests/e2e/blocked.spec.ts`.

## What's left

- **The Desk app's side** (UI/UX Engineer): the Guild Desk's Commons window, handing it the session's `commons` channel
  (above).
- **The image's side** (System Engineer): user `commons`, the unit, the release pin, the security group's UDP ports.
- **`desk-rtc`'s side** (G7): relaying `cmns` ICE from 443, UDP and TCP, to `127.0.0.1:8799`.
- **Boards:** thumbnails in the list, resize handles for shapes and notes, images and files, text styles, a lock for a
  board. Switching boards or channels sends the whole board; a client cache with Yjs state vectors would send only what
  each member lacks.
- **Chat:** reactions, threads, mentions and search are not in it; files go through the guild's Notebook today.
- **Compaction trusts the member it asks.** A modified client could hand back a damaged snapshot
  and lose a board's older history; the server keeps the log before the last compaction as
  `.prev`. Checking snapshots on the server would need Yjs there (a Node helper, or Yrs).
- **Voice:** per-member volume, push-to-talk, a device picker, and a check on real microphones and
  headsets. Echo cancellation is the browser's own.
- **Seen only in headless Chromium on Linux.** Safari, Firefox, phones and real Retina screens are
  task 01's kind of check.
- **Accessibility:** the board is a canvas with a label; items aren't reachable by keyboard yet. Chat, channels and
  settings are plain controls with names.
