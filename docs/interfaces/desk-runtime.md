# Desk runtime interfaces

**Status:** v0, 2026-11-05 · Owner: System Engineer

How the parts on one desk EC2 fit together. It adds what `docs/desk-design.md` §4.2 and Platform's `desk-endpoint.md` leave open, and it follows them everywhere else. Change it by asking the System Engineer.

## 1. Processes and users

| Unit | Runs as (fixed uid) | Packaging | Owner |
|---|---|---|---|
| `desk-rtc` | `rtc` (1101), `CAP_NET_BIND_SERVICE` only | Native Go binary, systemd | System Engineer |
| `desk-stream` (GStreamer capture and encode, §8) | `stream` (1104) | Python and GStreamer, release artifact, systemd | System Engineer |
| `desk-xorg`, `desk-audio`, `desk-browser` | `kiosk` (1102) | Debian packages, systemd | System Engineer |
| `desk-units` (§8.3) | root, per connection | Script in the image, socket-activated | System Engineer |
| `desk-batch` (§6.1, S-96, from the image after 0.3.1) | root: per connection on `batch.sock` (no network), and as `desk-batch.service` every 5 minutes from its timer | Python script in the image, socket-activated, and a timer | System Engineer |
| `desk-browser-policy` (§8.3) | root, as `desk-browser`'s `ExecStartPre=+`, before every start of Chromium | Python script in the image, from 0.2.8 | System Engineer |
| `desk-data` (§8.7, task 32) | root, per connection, `CAP_DAC_READ_SEARCH` only, no network, `/data` read-only | Python script in the image from 0.2.6 (`tools/desk-data/`), socket-activated | Desk Engineer writes it, System Engineer bakes it |
| `desk-egress` (§9, ADR 0036) | root, `CAP_NET_ADMIN` only | Python, release artifact baked from the recipe, systemd | System Engineer |
| `deskd` | `desk` (1100) | Spring Boot image in Docker, host network | Desk Engineer |
| `desk-agent` (baked from image 0.2.7) | `agent` (1103) | Spring Boot image in Docker, host network | Desk Engineer |
| `desk-notebook` (S-13, unit and release baked from image 0.2.8) | `notebook` (1105) | Node 24 and Hocuspocus image in Docker, **no network** (`--network none`) | Desk Engineer |
| `desk-agent-filter` (§9.1, ADR 0070, from 0.2.9) | `agent-filter` (1106), no capabilities | Go binary, baked from the recipe to `releases.pin`'s hash, systemd | System Engineer |
| `desk-kind` (§3.1, task 48) | root, no capabilities, IMDS only, once a boot | Python script in the image | System Engineer |
| `desk-guild-net` (§3.1, task 48) | root, `CAP_NET_ADMIN` only, a Guild Desk only | Shell script in the image | System Engineer |
| `desk-guild-rtc`, `commons-data` (§3.1, task 48) | root, oneshots, a Guild Desk only | Shell script and a unit in the image | System Engineer |
| `commons-server` (§3.1, task 48) | `commons` (1110), no capabilities, a Guild Desk only | Go binary, release artifact (`apps/commons`), optional line in `releases.pin`, systemd | Guild Engineer writes it, System Engineer bakes it |

- Containers use host networking and these uids. The IMDS hop limit (1) and the per-uid nftables rules then work as they do for native processes. `desk-notebook` is the exception: it has no network at all, so nftables has no rule for uid 1105, and `deskd` reaches it only over `notebook.sock`.
- IMDS (`169.254.169.254`) is open only to uid 0 and `desk`. `desk-rtc` can't read it, so `deskd` passes it the public IPv4 (§4.3).
- Nothing listens on a non-loopback interface except `desk-rtc` on UDP and TCP 443, and on a Guild Desk only, `commons-server` on UDP 8791 up (§3.1). Services talk over Unix sockets, because the `kiosk` and `agent` users could reach a loopback port. The exception is `desk-agent-filter`'s two loopback ports, TCP 14443 and TCP and UDP 14053, which nftables opens only to uid 1103.
- `deskd` refuses a listener on Chromium's debugging port 9222 unless its uid is `DESKD_CDP_UID` (default 1102, `kiosk`). nftables limits `127.0.0.1:9222` and, from image 0.2.3, `[::1]:9222`.

## 2. Paths

| Path | Holds | Writable by |
|---|---|---|
| `/opt/ma/<component>/releases/<version>/` | Unpacked release of one component | root |
| `/opt/ma/<component>/current`, `previous` | Symlinks to the live and the last release | root |
| `/opt/ma/<component>/prepared` | A symlink to a release a batch prepared and hasn't switched to yet (§6.1). `ma-update` keeps it, and its image, through every prune | root |
| `/opt/ma/etc/batch-keys/*.pem` | The public keys a batch may be signed with (§6.1): the image's, P-256. **From image 0.3.2, exactly Platform's release key** (`ma-desk-batch-2026-11.pem`, KMS `alias/ma-desk-batch`); an earlier image has none and refuses every batch | root, `0755` directory, `0644` files |
| `/etc/ma/batch-keys.d/*.pem` | An admin's drop-in of more trusted keys, empty in the image. Anyone who can write here is already root; the test desk uses it with a dev key | root, `0755`, `0644` |
| `/opt/ma/etc/batch-baseline` | Optional: the seq of the newest batch whose releases the image already holds, `{"seq": N}`. An offer at or below it is refused. Not written by any bake yet | root, `0644` |
| `/var/lib/ma/batch/state.json` | `desk-batch`'s state (§6.1), for `deskd`'s heartbeat. Directory `0755`, file `0644`, written atomically | root |
| `/var/lib/ma/batch/pending/<seq>/` | The pending batch: `manifest.json`, `manifest.sig` and `urls.json` (presigned URLs, bearer links). `0700`, files `0600` | root |
| `/run/desk/idle.json` | **`deskd`'s, built (in no `deskd` release yet):** whether the desk is idle (§6.1). `desk-batch` reads it as root and treats it as hostile; missing, stale or not uid 1100's means not idle | `desk` writes it, root reads it |
| `/opt/ma/bin/ma-update`, `/opt/ma/smoke-test` | Update tool and smoke test (§6) | root |
| `/data` | Data volume, label `ma-data`. Formatted only if blank. **Never wiped.** | see below |
| `/data/.ma-volume` | The volume's record, from image 0.2.3: `{volumeId, formattedAt, image}`, or `{volumeId, formattedAt: null, firstSeenAt}` for an older volume (ADR 0035) | root |
| `/data/desk` | `deskd`'s state | `desk` |
| `/data/desk/volume.json` | A copy of that record for `deskd`, rewritten at every boot | root writes it, `desk` reads it |
| `/data/desk/age-band` | The desk owner's band, exactly `teen\n` or `adult\n`, written atomically (§8.3). From image 0.2.8, `desk-browser-policy` reads it as root before every start of Chromium, and treats it as hostile. Anything else, or no file, means locked | `desk` writes it, root reads it |
| `/data/desk/adblock-off` | The sites where the member turned the Browser's ad blocker off (§8.9): one lowercase ASCII hostname a line, LF after each, written atomically, `0640` (the Desk Engineer's half of `T47S-3`). `desk-adblock` reads it as root before every start of Chromium and on `start desk-adblock`, and treats it as hostile. No file means blocking everywhere. A clear of history empties it. In the member's export, under "Desk settings and Chat" | `desk` writes it, root reads it |
| `/data/rtc` | DTLS identity, key mode `0600` | `rtc` |
| `/data/browser` | Chromium profile and tab snapshots | `kiosk` |
| `/run/ma/desk-kind` | **The desk's kind for this boot, and the one source of it** (§3.1): exactly `guild\n` or `member\n`, from the `DeskKind` tag. Directory `0755 root`, file `0644 root`. `deskd` reads it, never IMDS | root (`desk-kind`) |
| `/run/ma/guild` | There only on a Guild Desk, `DeskKind=guild\n`. What the units' conditions and `desk-units` test | root (`desk-kind`) |
| `/run/commons-server.address` | A Guild Desk with a `commons-server` release: the desk's public IPv4, one line, for `commons-server`'s `-advertise`. `commons-server-address.service` writes it as root from IMDS before `commons-server` starts, since `commons-server` is denied IMDS (Security's `GDS-4`) | root, `0644` |
| `/run/desk-commons/commons.sock` | `commons-server`'s relay socket for `deskd`. Directory `2750 commons:desk` on every desk (`desk-commons.conf`), socket `0660`; `commons-server` also checks `SO_PEERCRED` for uid 1100 | `commons` |
| `/data/guild/commons` | `commons-server`'s boards, chat threads, settings and audit log (`MA_APP_DATA`). `/data/guild` is `0755 root`, `commons` `0700 commons`, both made by `commons-data.service` on a Guild Desk only; `commons-server` sees nothing else of `/data` | `commons` |
| `/data/files` | The Files app's tree (ADR 0048): the member's files, `.uploads/` (partials, swept after a day) and `.trash/` (30 days). Directory `0700`, owner `desk` (uid 1100), made by `desk-datadirs` from the image after 0.3.1; mounted into `deskd`'s container as `-v /data/files:/data/files`. `deskd` is the only writer and reader: no root helper, and no other service or app sees it. Personal desks only | `desk` |
| `/data/notebook` | `desk-notebook`'s `notebook.db` and `readable/`. Directory `0700`, owner `notebook`, made by `desk-datadirs` from image 0.2.8 | `notebook` |
| `/data/.ma-export-tmp` | `desk-data`'s scratch copies of SQLite databases, unlinked as each is opened for sending, emptied of anything no live helper holds at each start (§8.7). Directory `0700`, made on the volume at boot by `/etc/tmpfiles.d/desk-data.conf`, from image 0.2.6 | root |
| `/data/desk-egress/state.json` | `desk-egress`'s budgets (§9). Directory `0700` | root |
| `/etc/ma/egress.conf` | `desk-egress`'s rates and budgets. The image's file, not a release's | root |
| `/etc/ma/guild.conf` | A Guild Desk's sizes: members by instance type, the voice class, `desk-rtc`'s class and the guild's day line a member, with its temporary 120 GB cap (§3.1, §9). Read only with `/run/ma/guild`. The image's file, mode `0644` | root |
| `/etc/ma/agent-egress.conf` | The names `desk-agent` may reach, exact, one a line (§9.1). The image's file, not a release's. Mode `0644` | root writes it, `agent-filter` reads it |
| `/etc/ma/chromium-teen.json` | The teen lock's Chromium policies, sharing no key with `ma.json`. The image's file, from 0.2.8 | root, `0644` |
| `/etc/chromium/policies/managed/ma-teen.json` | The teen lock: a copy of that file, in place only while the band isn't exactly `adult`. On the root, so a root swap takes it away and the next start puts it back. Not in the AMI | root, `0644`, written only by `desk-browser-policy` |
| `/etc/ma/chromium-adblock.json` | The ad blocker's policy template (ADR 0076): force-installs the image's own blocker from `file:///usr/share/ma/adblock/update.xml` and updates it only from there, `DeveloperToolsAvailability` 1, the blocker's settings (`noFiltering` empty, `off` false). Its id is written in by `build.sh`. Shares no key with `ma.json` or `chromium-teen.json`. The image's file | root, `0644` |
| `/etc/chromium/policies/managed/ma-adblock.json` | That template with the member's list as `noFiltering` and the kill switch as `off`. In the AMI with no site off, so a desk blocks before anything renders it. On the root, so a root swap brings back the AMI's and the next start of Chromium renders the list again | root:kiosk `0640` (`T47S-3`: Chromium reads it, no other user), written only by `desk-adblock` |
| `/usr/share/ma/adblock/` | The blocker (ADR 0076): `ma-blocker.crx`, `update.xml`, `blocker-id`, `blocker.json` (what went in), built at bake time from `image/recipe/adblock` | root, `0644` |
| `/data/.ma-adblock-off` | The ad blocker's kill switch: a regular file root owns. While it's there the blocker blocks nothing and stays installed. The Platform's, through SSM; not in the export | root |
| `/run/desk-egress/profile` | `normal`, `capped` or `deep`: which `stream*.conf` `desk-stream`'s `run` picks (§9). Directory `0755` | root writes it, `stream` reads it |
| `/run/desk/` | `rtc.sock` (`0660`, group `desk`), `deskd-admin.sock` (`0600`, owner `desk`), `units.sock` (`0600`, owner `desk`, §8.3), from image 0.2.6 `data.sock` (`0600`, owner `desk`, §8.7) and, from the image after 0.3.1, `batch.sock` (`0600`, owner `desk`, §6.1). Directory mode `0770`, owner `rtc`, group `desk` | `rtc`, `desk` |
| `/run/desk/chromium-refused` | `deskd`'s: empty, presence only. A refused start of Chromium (ADR 0035), kept across a `deskd` restart and cleared by a reboot | `desk` |
| `/run/desk/browser-frozen` | `deskd`'s: empty, presence only. A `deskd` may have left Chromium frozen (ADR 0045), so the next one thaws it before anything else. A reboot clears it, and no Chromium is frozen after one | `desk` |
| `/run/desk-media/` | `stream.sock` (§8.2). Directory mode `0750`, owner `rtc`, group `stream` | `rtc` |
| `/run/desk-notebook/` | `notebook.sock` (`0660`, group `desk`, by the directory's setgid bit). Directory mode `2750`, owner `notebook`, group `desk`, from image 0.2.8. `deskd` connects, and `kiosk` and `agent` can't enter | `notebook` |

## 3. Boot order

1. `desk-firstboot` and `data.mount` (design §10.3), then the directories above.
1a. `desk-egress` puts the shaper on `ens5` (§9). `desk-rtc` and `deskd` wait for it, up to 15 s, but only `Want` it, so they start whether it worked or not.
1b. `desk-agent-filter` listens, before `desk-agent` (§9.1). Nothing waits on it but `desk-agent`, and only by order.
2. `desk-rtc` loads or creates the DTLS identity, listens on `/run/desk/rtc.sock` and binds 443. It answers no STUN until it has sessions.
3. `deskd` connects to `rtc.sock` with backoff, sends `configure`, then runs `desk-endpoint.md` §5.3 steps 4–6: hello, gateway link and `ready`, heartbeat.
3a. `desk-notebook`, after Docker and the directories, once a release is installed; with none, its condition skips it. `deskd` and `desk-notebook` don't wait for each other: `deskd` connects to `notebook.sock` with backoff when a session wants it, and its health never needs it.
0. **cloud-init runs on a desk's first boot only** (§3.2). Every later boot has `/etc/cloud/cloud-init.disabled`, so none of its units run and nothing waits for them: `sysinit.target`, Docker and `deskd` start without them.
4. `desk-xorg`, `desk-audio`, `desk-browser` and `desk-stream` are installed but not enabled. On a desk's first boot they stay stopped until first Browser use (design §10.3); `deskd` starts them through `units.sock` (§8.3). On a later boot `desk-browser-prewarm` starts `desk-xorg`, `desk-audio` and `desk-browser` as soon as `deskd` answers its health check (§3.2), so the Browser is already up when the first session asks. `desk-stream` is always `deskd`'s to start. Nothing above waits for any of them.

### 3.1 The desk's kind: a member's desk or a Guild Desk (task 48)

A Guild Desk is the same AMI, launched by Platform with the EC2 tag `DeskKind=guild` and instance metadata tags on. It has no Browser: `desk-xorg`, `desk-audio`, `desk-browser`, `desk-stream`, `desk-browser-thaw`, `desk-adblock` and `desk-preread` never run there, and `commons-server` does.

- **`desk-kind.service`** runs once a boot, as root, after `network-online.target` and before `desk-rtc`, `deskd`, `desk-preread`, `desk-guild-net`, `desk-guild-rtc`, `commons-data` and `commons-server`. It reads `meta-data/tags/instance/DeskKind` over IMDSv2, asking again with backoff (0.5 s doubling to 4 s) for up to 30 s, and writes `/run/ma/desk-kind`. Only an exact `guild` writes `/run/ma/guild` too. No tag, metadata tags off, IMDS silent for 30 s, any other value (`Guild`, `guild `) or any error is a member's desk with its Browser, and the journal says why (`desk-kind: member (no DeskKind tag) in 12 ms`). It never fails a boot: nothing `Requires=` it.
- **One source (the Security Analyst's `GDS-5`).** `/run/ma/desk-kind` is the only place the desk's kind is decided. `deskd` must read it, not IMDS, so the two can't disagree after a slow IMDS: exactly `guild\n` is a Guild Desk, and `member\n`, anything else or no file is a member's desk. `deskd` is ordered after `desk-kind`, so the file is there when it starts. Its container needs `/run/ma` mounted read-only (`-v /run/ma:/run/ma:ro`); the directory is root's, so no other uid can replace the file. Reading it once at start is enough: it doesn't change during a boot.
- **The Browser's units** each have a drop-in, `<unit>.service.d/desk-kind.conf`, with `ConditionPathExists=!/run/ma/guild`. `desk-units` answers every verb with `err unsupported` there (§8.3).
- **`desk-guild-net`** puts nine rules in `inet ma` on a Guild Desk: in input, inbound UDP 8791 up to 8790 + cores, at most 8, which is what `commons-server` binds; first in output, UDP and TCP to `127.0.0.1:8799` and `[::1]:8799` refused to every uid but `rtc` (Commons' loopback relay port, which `desk-rtc` forwards 443's Commons ICE to), and new TCP connections to `127.0.0.1:8790` and `[::1]:8790` refused to every uid but root and `commons`; in classify, Commons' voice ports and the RTP `desk-rtc` relays from UDP 443 labelled for the voice class 1:30 (§9). Nothing on TCP 443 (§9.2). It runs at boot and after every start and reload of `nftables.service` (its drop-in), since those flush the ruleset. A member's desk never runs it, so its ruleset is exactly `nftables.conf`'s. Nothing is opened for TCP: `commons-server`'s room link is a Unix socket, and TCP and UDP 443 are already open on every desk, for `desk-rtc`.
- **`desk-guild-rtc.service`** gives `desk-rtc` `MemoryMax=512M` and `GOMEMLIMIT=384MiB` on a Guild Desk, by a runtime drop-in under `/run/systemd/system/desk-rtc.service.d/` written before `desk-rtc` starts. A member's desk keeps the image's unit as it is.
- **`commons-server.service`** needs `/run/ma/guild` and an installed release (`releases.pin`'s optional line, or a rollout). It runs as `commons` (1110) with no capabilities, `/data/guild/commons` its only view of `/data`, and its public address from `/run/commons-server.address`, which `commons-server-address.service` (Guild Desk only, root, IMDS its only address) writes first. No TURN: 443 stays `desk-rtc`'s, and nothing else is opened for it.
- **A restart of `desk-kind`** reads the tag again, but units already started or skipped stay as they are. A tag changed after launch takes effect at the next boot.

### 3.2 Faster wakes (TD-227, from the bake after 0.3.1)

A desk that stops and starts (an Alliance Member's, after 20 idle minutes) pays the boot at every wake, so two things are different after the first boot. Measured on a `t4g.medium`, 5 wakes each (`docs/benchmarks/2026-11-alliance-desk.md`): the kernel to `deskd`'s hello goes from a median 11.7 s to 8.8 s, and the office loading to Chromium's tabs from 31.1 s to 24.2 s.

- **cloud-init is off after the first boot.** A drop-in on `cloud-final.service` (`ExecStartPost`) writes `/etc/cloud/cloud-init.disabled` once the final stage has succeeded; cloud-init's generator then enables none of its units on any later boot. A first boot where cloud-init failed leaves it on. The marker is on the root, so a root replacement brings an image without it and cloud-init runs once more. The image never has the marker. `/etc/systemd/network/20-ma-dhcp.network` is the fallback if the card changes: netplan's file for the desk matches the card's MAC address, and cloud-init no longer re-renders it. Hostname, users and keys are whatever the first boot made.
- **`desk-browser-prewarm.service`** (Type=exec, After `deskd.service`) waits up to 30 s for `deskd`'s health, runs `desk-browser-start --check` as `kiosk`, and then starts `desk-xorg`, `desk-audio` and `desk-browser` with `--no-block`. It does nothing, and succeeds, with no `/data/desk/age-band` (a first boot: `deskd` hasn't written the band, and the teen lock is the default for anything but `adult`), on a Guild Desk, with `/data/desk/no-prewarm` (the kill switch), or when the check refuses (ADR 0035). It never starts `desk-stream`: `deskd` stops it at every boot until a viewer wants it. `deskd` doesn't need to know: `start desk-browser` of a running unit is `ok` (§8.3), and it freezes an unseen Chromium as it always did (ADR 0045).
- **Not changed:** the order of everything else in this section. A `docker.service` without `After=network-online.target` was measured and gave nothing once cloud-init was off.

## 4. `rtc.sock` protocol v1

### 4.1 Transport
- Unix stream socket at `/run/desk/rtc.sock`, mode `0660`, group `desk`. `desk-rtc` listens and `deskd` connects.
- One client at a time. A new connection replaces the old one.
- v1: when the connection drops, `desk-rtc` closes every session within 5 s. Clients reconnect and resume (design §4.2.7). Keeping sessions alive across a `deskd` restart is a later improvement.

### 4.2 Envelope
Every message: `u32be length` (of what follows), `u8 type`, then the body. Maximum 64 KiB.

| Type | Body |
|---|---|
| `0x01` JSON | UTF-8 JSON with a `t` field. §4.3 |
| `0x02` DATA | `u32be handle`, `u8 channelId` (0–5), then one design §4.2.4 frame unchanged. `desk-rtc` doesn't parse it |
| `0x03` CREDIT | `u32be handle`, `u8 channelId`, `u32be bytes`: the sender may now send that many more DATA bytes on that channel |

- **Credit runs both ways, per channel.** Each side starts with 256 KiB per channel and grants more as it drains, in steps of at least 32 KiB. This stops `bulk` from holding up `ctl` on the shared socket. It counts frame bytes, without the envelope or the 5-byte prefix. Overrunning it closes that session with reason `credit_violation`. `deskd`'s socket reader must never block.
- **Upload cap.** `deskd` keeps total upload credit at or below 2 MiB per session. SCTP's receive window is shared (4 MiB here), so more than that can stall the client's own `ctl` if `deskd` stops draining.
- `desk-rtc` applies the send priority in design §4.2.6. Its clipboard replies (§4.3) queue below all session data, in their own order, with one let through per 256 KiB of steady DATA so a paste can't starve.
- Channels 6 (`input`) and 7 (`keys`) never reach `deskd`. `desk-rtc` injects them, for sessions with `input: true`.
- `collab` (channel 3) is bridged the same way, whichever Notebook sync the Desk Engineer picks.

### 4.3 JSON messages

| From `deskd` | Reply from `desk-rtc` | Notes |
|---|---|---|
| `configure {publicIpv4, maxSessions}` | `configured {fingerprintsSha256, notAfter, version}` | Required first, and again after a public IP change. The fingerprints and `notAfter` go in hello |
| `session.create {sessionId, offer, expectedFingerprint, permissions: {video, input}}` | `session.answer {sessionId, handle, answer}` or `session.error {sessionId, code, message}` | `deskd` has already checked the token. An offer whose `a=fingerprint` differs gets `code: "identity_mismatch"` |
| `session.ice_restart {sessionId, offer}` | `session.answer {sessionId, handle, answer}` | |
| `session.permissions {sessionId, video, input}` | none | Takes effect at once. What the session may do, from its token |
| `session.video {sessionId, view}` | none | Whether this session wants media now (§8.4) |
| `session.close {sessionId, code, reason}` | `session.closed {sessionId, reason}` | |
| `stream.limit {level}` | none | The stream's quality ceiling: a level name, or null for none. Kept until the next one, and reset to none on each new connection (`stream-quality.md` §4, `desk-rtc` 0.3.3 on) |
| `stream.crop {crop: {epoch, x, y, w, h, outW, outH, keys}}` or `stream.crop {crop: null}` | none | A video island: the stream shows only that rectangle of the screen, and input carrying its epoch lands in it; null is the whole screen. Kept until the next one, and reset to none on each new connection (§8.8, `desk-rtc` 0.3.6 on) |
| `stats.get {}` | `stats {sessions: [{sessionId, transport, rttMs, bytesSent, bytesReceived}], bytesSent, bytesReceived, peerBytesSent}` | Totals are cumulative and include closed sessions. `transport` is `udp` or `tcp` for now; it can't report `relay` until TURN exists. Feeds the heartbeat |
| `clipboard.set {id, part, last, data}` | On the last part: `clipboard.ok {id}` or `clipboard.error {id, code}` | The desk's X `CLIPBOARD`, text only, never `PRIMARY` (TD-209). `data` is base64 of at most 45 KiB, and parts are bytes. One set at a time. `ok` means X has confirmed `desk-rtc` as the owner |
| `clipboard.get {id, maxBytes}` | `clipboard.text {id, part, last, data}`, `clipboard.text {id, part: 0, last: true, none: true}` or `clipboard.error {id, code}` | `maxBytes` of 0, or over 2 MiB, means 2 MiB |
| `clipboard.watch {on}` | none | Starts or stops `clipboard.changed`. Off again on every new connection, so send it on each |

| Sent unprompted by `desk-rtc` | Notes |
|---|---|
| `session.state {sessionId, state, transport}` | `connected`, `disconnected`, `failed` or `closed` |
| `session.closed {sessionId, reason}` | Also sent when `desk-rtc` closes a session itself, such as on a consent timeout |
| `input.activity {sessionId, at}` | At most once a second, for the heartbeat's `lastInputAt` |
| `stream.state {state}` | `down`, `warm` or `live`, on every change and once after `configure` (§8.4) |
| `island.blocked {epoch}` | A press on the island was dropped because another window was over it there (§8.8). At most once a second |
| `clipboard.changed {}` | While watching: something else on the desk took the clipboard. At most 4 a second, never for this desk's own set, and it carries nothing else |

Error codes: `not_configured`, `session_limit_reached`, `identity_mismatch`, `bad_offer`, `internal`.

**Clipboard fields and codes.** `id` is an integer from 0 to 2^53−1, and `part` and `maxBytes` are plain integers, with no fraction or exponent. A clipboard field of the wrong type never closes the link: the message gets `clipboard.error {id, internal}`, or nothing if `id` itself is wrong. Codes: `no_display`, `timeout`, `too_large`, `internal`. A new connection gets no reply meant for the old one. Limits, timeouts and what `deskd` must do are in `desk-rtc/README.md`, "The clipboard".

### 4.4 Fingerprints and offers
- **Formats differ:** the token's `cnf.x5t#S256` is base64url, SDP uses colon-separated hex, and `fingerprintsSha256` in hello is 64 lowercase hex chars. **Everyone decodes to bytes before comparing.** A string compare gives a false `identity_mismatch`.
- `expectedFingerprint` in `session.create` is 64 lowercase hex chars. `deskd` converts it from the token.
- An offer is valid only if **every** `a=fingerprint` line is SHA-256 and equals `expectedFingerprint`. Chrome writes one per section and Firefox one at session level, so don't require exactly one line.
- The client orders sections audio, video, data. `desk-rtc` never rejects audio, because the first section carries the BUNDLE tag, and may reject video alone if there's no shared codec. It answers both `sendonly` with idle tracks, because a browser won't play an `inactive` section, and starting video must not need a renegotiation (budget B13; §8.5).
- `deskd` never closes a session for missing client PINGs on `ctl`, since browsers throttle timers in hidden tabs. It goes by `session.state`.

### 4.5 Wire values
**`signal.data`:**
```
{"type":"offer","sdp":"…"}                  client to desk; add "restart":true for an ICE restart
{"type":"answer","sdp":"…"}                 desk to client
{"type":"refusal","code":"…","message":"…"} desk to client, followed by session.closed
```

**Frame `kind`** (design §4.2.4), numbered in that table's order: HELLO 1, AUTH 2, ACTIVITY 3, PING 4, PONG 5, CLOSE 6, REQ 7, RES 8, ERR 9, SUB 10, UNSUB 11, EVT 12, CANCEL 13, DATA 14, CHUNK 15, CREDIT 16.

**`session.closed` reasons from `desk-rtc`:** `consent_timeout`, `connect_timeout`, `dtls_failed`, `identity_mismatch`, `client_closed`, `frame_too_large`, `credit_violation`, `rtc_link_lost`. `deskd` maps any that aren't on the gateway's list (`gateway.md` §2.3) to `closed_by_desk`.

**Known limit:** `bulk` sends at most 64 KiB per round trip, because Pion counts bytes until they're acknowledged: 35.5, 8.8 and 4.5 Mbit/s at 10, 50 and 100 ms RTT (measured on a 200 Mbit/s link). That protects clicks while a download runs. Scaling it with RTT is a later improvement.

## 5. What each side delivers

| From | To | Delivers | Format |
|---|---|---|---|
| Desk Engineer | Platform Engineer | `deskd` release, built from its Dockerfile on an arm64 box | Release artifact, §6 |
| System Engineer | Desk Engineer | `desk-rtc`, `deskctl`, `gateway-shim` | Binaries from `desk-rtc/`; usage in its README. `desk-rtc` also as a release artifact, §6 |
| System Engineer | UI/UX Engineer | A running test desk or shim to point `DeskLink` at | Connection details by message |
| UI/UX Engineer | Platform Engineer | Desk app bundle | Vite `base: '/v/<version>/'`, with `ma-release.json` at the root (`hostnames.md`) |
| System Engineer | Platform Engineer | AMI ID and the `ma-update` interface | By message; history in `image/RELEASES.md` |
| Platform Engineer | everyone | Test desk, test account, `gw.`, `connect`, hello | Contract in `ma-platform/docs/contracts/` |

`deskd`'s `run` script (§6, Desk Engineer) must start the container with at least these settings, pinning the image by ID:
```
exec docker run --rm --name deskd --network host --user 1100:1100 --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges --log-driver=journald \
  --memory=512m --memory-swap=512m --cpu-shares=512 --pids-limit=256 --stop-timeout=60 \
  -v /run/desk:/run/desk -v /data/desk:/data/desk -v /data/files:/data/files --env-file "$RELEASE_DIR/deskd.env" \
  "$(cat "$RELEASE_DIR/image-id")"
```

## 6. Updates and health

**Who owns what:** the System Engineer owns `ma-update`, `/opt/ma/smoke-test`, the layout in §2 and the unit files, which are the same for Docker services and native binaries. Each component's owner writes its `run` and `health`, so flags and health rules can change without a new AMI.

**Release artifact:** `<component>-<version>.tgz` with a `.sha256` beside it, in `s3://ma-lambda-artifacts-<account-id>/desk/<component>/<version>/`. At its root:

| File | Required | Meaning |
|---|---|---|
| `VERSION` | Yes | The version string |
| `run` | Yes | Executable, the unit's `ExecStart`. It stays in the foreground and gets the release directory in `RELEASE_DIR` |
| `health` | Yes | Executable. Exit 0 means healthy. It gets `RELEASE_DIR` too |
| `image.tar` | Docker components | `docker save` output |
| `ON_DEMAND` | On-demand components | `ma-update` uses `try-restart`, so an update never starts the unit (`desk-stream`) |
| Anything else | Optional | Such as `deskd.env` or the `desk-rtc` binary |

**Release flow:** the Desk Engineer builds `deskd` from its Dockerfile on an arm64 box (for now Platform's test box over SSM, which also runs the CDS training) and packages it with `services/scripts/package-release.sh`. `desk-rtc` is built by `desk-rtc/build.sh`, and `desk-stream` by `image/package-desk-stream.sh`. Platform's `scripts/desk-service-release.sh` uploads the artifact, presigns it, and calls `ma-update` through SSM: test desk first, then the same SHA to the owner's, with a data volume snapshot before that. There's no ECR pull, so the desk role stays as `desk-endpoint.md` §5.4 defines it.

**Baked releases (from the launch image):** the AMI holds one release of each of `desk-rtc`, `desk-stream`, `deskd`, from 0.2.7 `desk-agent`, from 0.2.8 `desk-notebook` (the one optional line) and, from 0.2.9, `desk-agent-filter`, named with their sha256 in `image/recipe/releases.pin`, so a new desk says hello with nothing rolled onto it and no SSM command from an event. `bake.sh` takes only versions whose `meta.json` and `.sha256` match the pin and that have a `passed-test.json`, except `desk-agent-filter`, which it builds from the recipe to the pin's hash, and `build.sh` installs each with `ma-update` in install-only mode, with `deskd`'s image loaded, so the layout is a rollout's: `current` on that release, no `previous`. Nothing is started on the builder, so the DTLS identity, `deskd`'s state and Docker's engine ID are made on each desk's first boot. The AMI carries the versions as the tags `DeskRtcVersion`, `DeskStreamVersion`, `DeskdVersion`, `DeskAgentVersion`, from 0.2.8 `DeskNotebookVersion` and, from 0.2.9, `DeskAgentFilterVersion`.

**`ma-update <component> <url> <sha256>`**, run as root through SSM Run Command:
1. Downloads and checks the artifact. The URL is presigned, because the desk role has no S3 access.
2. Unpacks it to `releases/<version>`. If it has `image.tar`, runs `docker load`, writes the loaded image's ID to `image-id` (a loaded image has no repo digest), and deletes `image.tar`. It writes the artifact's sha256 to `artifact.sha256`. If that version is already `current` from the same artifact, such as the one the image bakes in, nothing changes: it runs only step 4 and exits 0 or 1. The same version from another artifact, or one that's `previous`, is refused with exit 2.
3. Moves `previous` to the old release and `current` to the new one, and restarts the unit.
4. Runs `/opt/ma/smoke-test`, retrying for up to 90 s.
5. Exits 0 if healthy, and prunes everything except `current` and `previous`, including unused images. Otherwise it puts the old release back, restarts, and exits 1.

**`ma-update <component> --rollback`** swaps back to `previous` in one step. It never touches `/data`.

**`ma-update <component> --prepare <url> <sha256>`** (desk batches, §6.1; from the image after 0.3.1) does steps 1 and 2 and switches nothing: the release goes to `releases/<version>` with its image loaded, and the link `prepared` points at it. `current` and `previous` stay, nothing restarts, and the smoke test doesn't run. An artifact that's already `current` needs nothing (exit 0, nothing prepared); one that's `previous`, or already prepared, is prepared from what's there with no download. Preparing another release drops the one prepared before. The same version as `current` or `previous` from another artifact is refused, exit 2. **`ma-update <component> --activate <version>`** needs `prepared` on that version and does steps 3 to 5 from it: `previous` to the old `current`, `current` to it, restart, the smoke test for up to 90 s, then prune, exit 0; on failure the old pair goes back, the prepared release is removed unless it was `previous`, and the exit is 1. Not prepared is exit 2 with nothing changed. **`ma-update <component> --unprepare`** drops the prepared release, unless it's `current` or `previous`. Every prune keeps `current`, `previous` and `prepared`, and every component's images for all three. The three-argument form and `--rollback` are unchanged; an install of the version a batch prepared replaces it and drops the link. **On a shared host** (ADR 0072 §2) only `load_image` changes, to unpacking the image into the release instead of `docker load`; the arguments, links and exit codes stay.

**Root replacement brings back the baked releases,** because `/opt/ma` lives on the root volume. After `CreateReplaceRootVolumeTask` a desk runs exactly what the new AMI baked in (its `Desk*Version` tags), with no `previous`, whatever it ran before. That can be older than what it ran. The DTLS identity and `deskd`'s data stay, on `/data`. Afterwards, roll forward with `ma-update` only the components where the last version that passed is newer than the baked one; a rollout of the baked version itself changes nothing. An AMI from before the launch image bakes in only `desk-stream`, so on it every other component has to be rolled on, or the desk can't say hello.

**`deskd` schema changes must be expand-then-contract,** so the previous `deskd` still starts on migrated data. Otherwise a rollback isn't safe.

**`/opt/ma/smoke-test`** exits 0 only when `current/health` exits 0 for every installed component.
- `desk-rtc`: the unit is active and holds UDP and TCP 443.
- `desk-stream`: its unit hasn't failed. Stopped is healthy.
- `desk-egress`: the unit is active and its three classes are on `ens5`. While the shaper is off, an update of any component rolls back.
- `desk-agent-filter`: the unit is active and holds its ports (§9.1). While it's down, an update of any component rolls back.
- `commons-server` (a release is on every desk once pinned): on a Guild Desk, `/healthz` answers `ok` on `127.0.0.1:8790` and `/run/desk-commons/commons.sock` is a socket. On a member's desk (no `/run/ma/guild`) its unit is skipped and `health` exits 0 at once.
- `deskd`: it's serving and its databases are open. Its links to `desk-rtc` and Platform are reported but don't fail health, so a Platform outage during a rollout can't trigger a rollback. Its `health` calls `GET /health` on `/run/desk/deskd-admin.sock`, never a TCP port.

### 6.1 Desk batches and Debian's updates (S-96, from the image after 0.3.1)

The desk half of "updates to members' desks are rare and never interrupt" (`docs/decisions/draft-desk-app-contract.md` section 13). The platform names a batch in the heartbeat response once the desk's wave is open; `deskd` fetches it from the agent route and hands it to `desk-batch`, a root helper outside `deskd` (nothing can supervise its own replacement), which checks the signature and applies it the next time the desk is idle. Test desks and the owner's desk still take single releases through `desk-service-release.sh`.

**The manifest, v1.** JSON, at most 64 KiB (`tools/batch/batch-build` keeps it within 4096 bytes, KMS's limit for a RAW message). A key that appears twice, NaN or Infinity is refused. Unknown fields are ignored: anything a desk must understand changes `format`.

| Field | Type | Meaning |
|---|---|---|
| `format` | `"ma-desk-batch/1"` | Anything else is refused |
| `seq` | integer, 1 to 2^53 | Strictly increasing across all batches. A rollback batch is a higher `seq` naming older versions |
| `id` | `[A-Za-z0-9._-]{1,64}` | A name for people, such as `2026-12` |
| `created` | UTC, `2026-11-09T18:00:00Z` | When it was built |
| `urgent` | boolean | Decision 17's urgent fix: 13.2's shorter idle after 24 and 72 hours (below) |
| `image` | optional, a version such as `0.3.2` | A batch that needs a root swap. Its services are applied, then `root-pending` is recorded; the swap is the platform's ask (13.6), not built |
| `components` | 1 to 16 of `{name, version, sha256}` | Activated in this order. `name` as `ma-update` takes it, never `bin` or `etc`; `sha256` of the published `.tgz` |
| `note` | plain text, at most 2000 characters, `\n` the only control character; may be `""` | 13.7's "what changed", for the Desk app |

**The signature.** A detached ECDSA P-256 SHA-256 signature over the manifest's exact bytes, DER (ANSI X9.62), which is what AWS KMS gives for `ECC_NIST_P256` with `ECDSA_SHA_256`, and what `openssl dgst -sha256 -verify` checks on the desk. Base64 of it is taken too. A batch verifies if any trusted key verifies it. Trusted keys are `*.pem` in `/opt/ma/etc/batch-keys/` (the image's) and `/etc/ma/batch-keys.d/` (an admin's drop-in): each a regular file root owns, not group- or world-writable, holding a P-256 public key, in a directory the same. Anything else is skipped and logged. **With no key every batch is refused** (`err untrusted no trusted key`), which is every desk until Platform's key is in an image. URLs are never signed or trusted: `ma-update` checks every artifact against the manifest's `sha256`.

**Sequence numbers.** An offer is refused when its `seq` is at or below the floor, the highest of: the last batch applied, the last one rolled back or given up on, and the image's `/opt/ma/etc/batch-baseline` (an unreadable baseline refuses everything). Below the pending batch's `seq` is refused too. The pending `seq` again with the same bytes only takes new URLs; with other bytes it's `conflict`. A higher `seq` replaces the pending batch (batches are cumulative), unless one is being applied (`busy`).

**`urls.json`**, what the route returns beside the manifest and signature: `{"expiresAt": "<UTC>", "components": {"<name>": "<url>", ...}}`, a URL for every component the manifest names and no other, each `https://` (or `file:///` on a lab box), at most 4096 characters. `expiresAt` is optional and only schedules: with less than 10 minutes left, `desk-batch` asks for new URLs (`pending.urlsWanted`) rather than starting a download that would fail. A batch that's all prepared needs none.

**`/run/desk/batch.sock`.** Mode `0600`, owner `desk`, in `deskd`'s `/run/desk` mount. `desk-batch.socket` (`Accept=yes`, `MaxConnections=4`) runs one root `desk-batch serve` per connection, no network, which refuses any uid but 1100 and 0 by `SO_PEERCRED`. One request line, at most 256 KiB, then one answer line:
```
status\n                     ok <state as one line of JSON, as below>\n
hold <0..15>\n               ok {"holdUntil": "<UTC>" | null}\n      0 clears a hold, unless a batch is being applied
offer <json>\n               ok {"seq": N, "id": "..."}\n
                             json: {"manifest": "<base64 of its exact bytes>", "signature": "<base64 of the DER>", "urls": <urls.json>}
any failure                  err <code> <text>\n
                             code: denied | bad_request | untrusted | seq | conflict | busy | failed
```
Root has the same verbs on the command line (`desk-batch offer <manifest> <sig> <urls.json>`, `status`, `hold <minutes>`), plus `tick` and `verify <manifest> <sig> [<key.pem>...]`, which needs no root.

**The state,** `/var/lib/ma/batch/state.json` (`0644`; `status` returns it with `holdUntil` only while it's ahead and `floorSeq` added):

| Field | Meaning |
|---|---|
| `phase` | `none` · `pending` (verified, waiting for idle) · `preparing` · `prepared` (all prepared, then the desk wasn't idle; it activates at the next idle) · `activating` · `rolling-back` · `applied` · `rolled-back` (never tried again) · `failed` (3 prepares failed, or the stored batch was unusable; never tried again) · `root-pending` · `broken` (`status` only: the state file can't be read; nothing runs until it's fixed over SSM) |
| `appliedSeq`, `failedSeq`, `floorSeq` | The last batch applied; the last rolled back or given up; what an offer must be above |
| `applied` | `{seq, id, created, at, note, image, components: [{name, version}]}` of the last batch applied: its `note` is what the Desk app shows |
| `pending` | `{seq, id, created, urgent, image, components, note, offeredAt, urlsExpireAt, urlsWanted, attempts, lastFailedAt}`, or `null` |
| `progress` | While applying: `{seq, toSwitch, switched, startedAt}` |
| `rootPending` | `{seq, image}` once a batch's services are on and its image isn't this desk's (`/etc/ma-release`) |
| `lastBatch` | `{seq, result, at}` and, when applied, `switched`, `seconds`, `prepareSeconds`, `activateSeconds` |
| `lastError` | `{at, seq, code, text}`: `code` `prepare`, `activate`, `stored` |
| `holdUntil` | While a batch or apt runs: 15 minutes ahead, renewed at each step, cleared at the end; or what `hold` set. For the heartbeat's `update.holdUntil` |
| `idle` | `{at, idle, reason}` from the last tick |
| `chromium` | `{installed, running, pending}`: `pending` when a running Chromium's binary was replaced by an upgrade (its `/proc/<pid>/exe` reads `(deleted)`), so the new version waits for its next start |
| `reboot` | `{running, installed, pending}`: `pending` when a newer kernel is in `/boot` or `/run/reboot-required` exists. Nothing reboots |
| `apt` | `{firstSeen, lastAttempt, lastOk, lastResult, seconds, forced}` |

**Idle, `/run/desk/idle.json` (built by the Desk Engineer on `sub/deskd-idle-json`, in no `deskd` release yet; the version goes here once released).** `deskd` writes it atomically (a temporary file in `/run/desk`, then a rename), mode `0644`, as uid 1100, at least every 15 s and at every change:
```
{"at": "2026-11-09T18:00:00Z",       when written; older than 60 s, or more than 60 s ahead, is not idle
 "sessions": 0,                      client sessions connected
 "agentTasks": 0,                    Agent runs going (agent.activeTasks)
 "exports": 0,                       data.* exports and moves going
 "downloads": 0,                     Browser downloads going (holds a Chromium close or a root swap, not a service batch)
 "idleSince": "2026-11-09T17:40:00Z" | null,   since when sessions, agentTasks and exports have all been 0; null while not
 "idleStopSeconds": 1200 | null,     the desk's idle-stop time, if deskd knows it
 "lastInputAt": "<UTC>" | null}      optional: the last input from any session, for an urgent batch
```
What the code does beyond or differently from the above: `downloads` is always 0, since only `desk-units` sees a Browser download, at a freeze (ADR 0045). `exports` counts an `export` session's live `data.read` transfers and sessions holding the Browser for a copy, not a hold a move kept past its session. A Files transfer always has an open session, so it counts in `sessions` only. The temporary file is `.idle.json.tmp` in the same directory, and `deskd` removes the file as it stops. `idleSince` is in memory, so a restart starts it fresh, and a session that opens and closes between two writes still moves it. `idleStopSeconds` is the config's `autoStop.autoStopMinutes` times 60, null when that is null or the config is not yet read.

Missing, unreadable, not a regular file uid 1100 owns, over 64 KiB, a field missing or of the wrong type, or stale: **not idle**. Idle means `sessions`, `agentTasks` and `exports` all 0 for `min(idleStopSeconds / 2, 3600)` seconds since `idleSince`, or 600 s without `idleStopSeconds`. **An urgent batch** that has waited 24 hours since it was offered takes 15 minutes with no input instead (sessions, Agent runs and exports aside), and after 72 hours 60 s, from `lastInputAt`, or from `idleSince` with no session. `updates.window` isn't read yet; it would only narrow idle.

**A tick** (`desk-batch.timer`: 2 minutes after boot, then 5 minutes after each tick ends):
1. A batch cut off mid-way (a reboot, a kill) is picked up first, idle or not: a cut-off prepare just goes back to pending; a cut-off activate runs the smoke test (up to 90 s) and finishes the rest, or rolls back what's on the batch's versions if unhealthy or a prepared release is gone; a cut-off rollback finishes.
2. With a pending batch and the desk idle: every component not already current at that version and hash is prepared (`ma-update --prepare`, at `nice 10`, best-effort I/O 7), in order. Any failure switches nothing: the batch stays pending, wants new URLs, waits an hour, and after 3 failed prepares it's `failed`, its prepared releases dropped. A component a superseded batch prepared is dropped first.
3. Idle is read again. Not idle: `prepared`, and it activates at the next idle with no download.
4. Each component is activated in the manifest's order (`ma-update --activate`). **Once switching starts it finishes:** a failure rolls the components already switched back, in reverse, with `ma-update --rollback` (the failed one put itself back), and the batch is `rolled-back` and its `seq` refused from then on. Success records `applied`, or `root-pending` when it names an image this desk doesn't run.
5. Only on a tick that did no batch work: Debian's updates, below.
`holdUntil` is kept 15 minutes ahead throughout. Nothing here reads or writes `/data/browser/profile`, restarts Chromium or reboots.

**Debian's updates.** `apt-daily.timer` and `apt-daily-upgrade.timer` are masked, so nothing runs apt at boot or on Debian's schedule. A tick runs `apt-get update`, `unattended-upgrade` and `apt-get clean` under `nice -n 19 ionice -c3`, once a day at most, only while idle (the plain rule, never the urgent one), or after 72 hours since the last success (a new desk: since its first tick) with no idle; a failure is tried again an hour later. `51ma-unattended` clears Debian's origins and allows only the security archive (`codename=trixie-security,label=Debian-Security`, and the old `codename=trixie,label=Debian-Security` form), never stable point releases. Chromium isn't closed to take an update: a new package waits for Chromium's next start (`chromium.pending`), and a newer kernel for the next boot (`reboot.pending`).

## 7. Skeleton RPC

The first app call, end to end. Method `desk.status.get` on channel 1 (`rpc`), after the `HELLO` exchange on `ctl`:

```
REQ {"m":"desk.status.get","p":{}}
RES {"deskId":"d-…","deskdVersion":"…","rtcVersion":"…","bootId":"…","uptimeSec":123,"javaVersion":"21.…","instanceType":"c7g.large"}
```

`deskctl` and the Desk app both use it, so the end-to-end test and the desk panel check the same path.

## 8. Milestone 2: stream and input

`desk-stream` captures `:99` and the Pulse sink and encodes once. `desk-rtc` forwards that RTP to each session that is viewing and injects input into `:99`. Design §6, §4.2.3, §4.2.10.

### 8.1 Changes to earlier decisions
- **`desk-stream` runs as a new user `stream` (1104),** not `kiosk`. Chromium is `kiosk`, so on the same uid a renderer sandbox escape could feed any bytes to every client's decoder. `desk-xorg` grants `stream` X access (`xhost +SI:localuser:stream`), as it does `rtc` and `kiosk`. From the next bake (DA-1) Xorg runs with `-auth` (a cookie made at each start, `0600 kiosk`, used only by `desk-xorg-ready`) and `-nolisten local`, so these three are the only uids X admits, by the socket's peer uid; root needs `XAUTHORITY=/run/desk-xorg/auth` (`image/README.md`).
- **`keys` also runs desk to client,** for `CURSOR` only (§8.6). Design §4.2.3 says client to desk.
- **Text insert isn't on `keys`.** It doesn't fit a fixed event, and design §6.3 already sends it through CDP `Input.insertText`, so it's the `deskd` RPC `browser.text.insert {text, tabId?}` (`services/deskd/docs/API.md`). The app calls it for composed text, dictation and a paste, with `tabId` left out so it goes to the tab on screen.
- **`units.sock` replaces the polkit rule** of design §10.3.

### 8.2 `desk-stream` to `desk-rtc`
**A Unix stream socket, `/run/desk-media/stream.sock`.** `desk-rtc` listens, `desk-stream` connects. A new accepted connection replaces the old one.

- **Why not a loopback port:** web content can send to loopback itself (`fetch`, ICE to `127.0.0.1`), from Chromium's network process, so nftables would be the only guard. A Unix path can't be named from web content at all.
- **Spoofing:** the directory is `0750 rtc:stream`, so only `rtc` and group `stream` can reach the socket. `desk-rtc` also checks `SO_PEERCRED` and closes any peer whose uid isn't 1104.
- **Reading:** RTP exists only inside `desk-stream` and this socket. `kiosk`, `agent` and `desk` can't open either.
- **No loss, no queue:** writes block. A leaky one-frame queue ahead of the encoder drops raw frames instead, so a stalled `desk-rtc` can't build up latency.
- **`desk-rtc` stays `CGO_ENABLED=0`.** GStreamer is only in `desk-stream`.

| Direction | Format |
|---|---|
| `desk-stream` to `desk-rtc` | RFC 4571: `u16be length`, then one RTP packet. PT 96 is H.264 constrained baseline, PT 111 is Opus. Any other PT closes the connection |
| `desk-rtc` to `desk-stream` | ASCII lines: `resume\n`, `pause\n`, `keyframe\n`, `level low\|medium\|high\|max\n` (the first line on every connection, then on a change at most every 500 ms: `stream-quality.md` §4 and §5), `crop X Y W H OUTW OUTH\n` and `crop none\n` (§8.8: after the level line on a new connection while an island is set, then on every change to its picture) |

`desk-stream` builds its pipeline paused and stays paused until `resume`. If the connection drops it exits, and systemd restarts it. Encoder settings live only in `stream.conf` in its release (§6), so tuning them is a release, not code or an AMI.

**From `desk-stream` 0.3.0 the stream is variable-rate by content** (ADR 0073). `deskcap`, a capture element in the release's `gst-plugins/<arch>/`, reads `:99` only where XDamage says it changed and sends a frame only when the screen changed, at most 60 a second. So `desk-rtc` sees:
- **On a still screen, a repeat at least once a second**, more often right after motion (about every 130 ms, tapering over about 15 s), so a browser neither counts a freeze nor asks for a keyframe. A screen that changes now and then sends only those changes, plus repeats where a gap would otherwise count as a freeze.
- **`keyframe`, `resume` and a `level` change send a frame at once**, the screen changed or not: `desk-stream` tells `deskcap` to (its `refresh` signal) with every keyframe it asks x264 for. A joining viewer or a PLI no longer waits for the screen to change.
- **Under contention the picture may get smaller, coarser, or 30 fps** (`[adapt]`, ADR 0073's lever 3): when this desk can't hold its frame rate, `desk-stream` lowers its resolution (900, 720, 540 lines), then its quality (quantizer +4), and only then caps at 30 fps, never lower; it climbs back when there's room. A size change keeps to §8.5's rule (the client reads `videoWidth` and `videoHeight`; input is normalized) and costs one keyframe, as a `level` does. The level `desk-rtc` asked for stays the ceiling: a step never raises it. `desk-rtc` isn't told; the desk's journal says `adapt: step N (...)` with why.
- **RTP timestamps are unchanged:** each frame's capture instant on CLOCK_MONOTONIC (ADR 0037), so the gaps between frames are real time.

`deskcap` shares its two capture buffers (SysV shared memory, for MIT-SHM) with the X server's group only, mode `0660`, read from the X socket's peer credentials; 0.2.4's `ximagesrc` made them `0777`. If `deskcap` won't load, `stream.conf`'s `fallback-capture` and `fallback-convert` lines (0.2.4's `ximagesrc` and `yuvconv`) run instead, at 0.2.4's cost.

**From `desk-stream` 0.3.3 sound flows only while something plays** (ADR 0073, addendum). With `[audio] gate = sink-input` and `gate-stops = sending` (all three confs), a valve right after the capture drops the sound while the desk's Pulse server has no playback stream (a sink-input: Chromium opens one while a page makes sound, closes it about 10 s after it stops, and keeps one while an `AudioContext` runs), until `gate-tail-ms` (3000) after the last one goes. The capture itself runs as before, so PulseAudio is never touched and a sound starts as soon as it did. `desk-stream` watches with `pactl subscribe` as user `stream`; if it can't, sound is sent all the time, as before 0.3.3. So `desk-rtc` sees no PT 111 packets on a quiet desk, then packets whose RTP timestamps jump by the silence, still capture time on CLOCK_MONOTONIC; a browser's jitter buffer treats the gap as silence, as with Opus DTX, and at most one 10 ms frame from before the gap comes first (`desk-rtc` drops it past 2 s). `stats.stream.audioPackets` stands still while the desk is quiet, and a client's `getStats` lists no inbound audio stream until the first sound. On arm64 only, `[video] x264-aarch64 = asm=NEON` is added to the encoder's option string: the same bytes for about a fifth less x264 CPU on Graviton. x86_64 desks never get it.

**RTP timestamps are capture time on CLOCK_MONOTONIC** (ADR 0037, `desk-stream` 0.2.3 on): the pipeline's base time is 0 with no start time, and both payloaders have `timestamp-offset=0`, so a timestamp is the capture instant in its track's rate (90 kHz, 48 kHz), mod 2^32, for sound and picture alike. `desk-rtc` reads the same clock for its sender reports, and drops the one stale audio packet the encoder sends after a resume. Anything new in the pipeline keeps to this, or the tracks can't be lined up. An older `desk-stream` (random offsets) still works, with Pion's send-time reports.

### 8.3 Unit control: `/run/desk/units.sock`
Mode `0600`, owner `desk`, reachable inside the `deskd` container through its `/run/desk` mount. `desk-units.socket` runs one root `desk-units` per connection. It checks `SO_PEERCRED` and refuses any uid but 1100. It runs `systemctl` directly, with no shell.

One request per connection, then `desk-units` closes it:
```
request   <verb> <unit>\n          at most 64 bytes
verb      start | stop | freeze | thaw     freeze and thaw only for desk-browser (ADR 0045, from the next image)
unit      desk-xorg | desk-audio | desk-browser | desk-stream | desk-adblock
reply     ok\n
          err <code> <text>\n     code: denied | bad_request | failed | timeout | busy | inactive | unsupported
```
- **On a Guild Desk** (§3.1) every allowed verb on every unit here is answered `err unsupported guild desk has no Browser: <verb> <unit>`, and systemd is never asked. The uid, request and unit refusals come first, as on any desk.
- The reply comes when the job is done, so allow 95 s on `deskd`'s side for a `stop` of `desk-browser`, `desk-xorg` or `desk-audio` (`desk-browser` is quit over CDP with up to 31 s, then stopped gracefully; see below), and 35 s for the rest. `start` of a running unit is `ok`.
- **`start desk-browser` can be refused** when the profile's `Last Version` is newer than the installed Chromium (ADR 0035): `err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: …`. `desk-units` runs `desk-browser-start --check` as `kiosk` first, since `systemctl start` of a `Type=simple` unit says `ok` regardless. The unit itself then exits 78 and doesn't restart.
- **`start desk-browser` puts the teen lock in place or takes it away first** (from image 0.2.8; `image/README.md`, "Teen Browser lock"). `desk-browser`'s `ExecStartPre=+` reads `/data/desk/age-band`: exactly `adult\n` removes `ma-teen.json`, and anything else, no file included, installs it. So `deskd` writes the band before it asks for a start, and a changed band means `stop` then `start`: a `start` of a running unit changes nothing. If the lock can't be put in place the reply is `err failed start desk-browser: Job for desk-browser.service failed because the control process exited with error code…`, at once, Chromium doesn't start, and systemd tries again every 3 s, so the Browser can come up by itself later. With the data volume gone it's `err timeout`, at 34 s, and the unit then fails on its dependency.
- `start desk-stream` also starts `desk-xorg` and `desk-audio`. `start desk-browser` starts those two as well. `stop desk-xorg` stops what needs it.
- **`freeze desk-browser`** (ADR 0045) holds every process of Chromium with the kernel's cgroup v2 freezer, in this order, each step bounded:
  1. `desk-browser` isn't active: `err inactive desk-browser isn't running`.
  2. **The lock** (the Security Analyst's T46L-1): an exclusive `flock` on desk-browser's cgroup directory, `/sys/fs/cgroup/system.slice/desk-browser.service`, held from here to the answer, so `desk-browser-thaw`'s thaw (below) waits for a freeze under way. Not had within 5 s: `err timeout freeze desk-browser waited over 5 s for its lock`. A thaw takes no lock and never waits.
  3. **A stop under way** (T46L-1): `systemctl list-jobs` shows a `stop`, `restart` or `try-restart` job, queued or running, for `desk-browser.service` or `desk-browser-thaw.service`: `err busy stopping`. `desk-browser` reads `active` until the end of its stop's quit, up to about 55 s, and a freeze in it would hold Chromium mid-quit until systemd killed it without its session (measured on main before this: SIGKILL, `Crashed`, a cookie set 8 s before lost). Asked while the network window below runs, so it adds no time; a list not had within 5 s, or a failed one, is `err timeout list-jobs took over 5 s, or failed`.
  4. **A download:** a `*.crdownload` directly in `/data/browser/downloads` written in the last 30 s: `err busy download`. Only names and times are read, with no link followed and nothing opened, and nothing under `/data/browser/profile` is looked at. No folder is no download; a folder that can't be read, is a link or holds over 4096 entries is `busy`.
  5. **The network:** the desk's outside interfaces (those with a default route in Chromium's network namespace, read from `/proc/<pid>/net/`) moved more than 16 KiB in and out over 0.5 s, which is 64 KiB in 2 s: `err busy network`. That holds off an upload, a call or a stream left running with nobody looking. Counters that can't be read are `busy`. The window runs while the download is looked at, so a freeze takes about 0.55 s; it's short because `deskd` makes every freeze and thaw on one thread, so a look that comes during a freeze waits for it.
  6. `1` into `/sys/fs/cgroup/system.slice/desk-browser.service/cgroup.freeze`, then `cgroup.events` must say `frozen 1` within 5 s, or it's thawed and `err timeout freeze desk-browser took over 5 s`. A cgroup that can't be written is thawed and `err failed freeze desk-browser: <error>, frozen <state>`.
  7. **Asked again** (T46L-1): `list-jobs` once more, started right after the write and read once the kernel says frozen. A stop that came after step 3's look is seen here: thawed, `err busy stopping`. A list not had: thawed, `err timeout`.
  8. `ok`.
  The busy reasons are `download`, `network` and `stopping`; `deskd` takes any `busy` as a clear no and asks again later.
- **No sound check.** `deskd` asks for a freeze only once no session has had the desk's media for 60 s, so a sound then is heard by nobody (the Desk and UI/UX Engineers, 2026-11-07).
- **`thaw desk-browser`:** `0` into `cgroup.freeze`, and `cgroup.events` must say `frozen 0` within 5 s: `ok`. No cgroup (Chromium isn't running) is `ok`. Otherwise `err failed thaw desk-browser: frozen <state>`.
- **Not `systemctl freeze`.** systemd 257 runs no job on a unit it froze: a stop fails with "Cannot stop frozen unit", a start of a running one says ok and leaves it frozen, and a thaw over D-Bus is refused while a job is pending, which at a shutdown it always is, so Chromium was killed without writing its session. A freeze in the cgroup leaves systemd's `FreezerState` at `running`, so its jobs run. Read `cgroup.events` to see whether Chromium is frozen. Never `systemctl freeze desk-browser`.
- **Every stop thaws first.** `desk-browser-thaw.service` is wanted by `desk-browser`, `PartOf=` it and ordered `After=` it, so it stops before `desk-browser` in every stop or restart, a shutdown's included, and its `ExecStop` writes `0` to `cgroup.freeze`. A frozen Chromium can't take SIGTERM, and would otherwise be killed at `TimeoutStopSec` without its session (ADR 0035). `desk-units` also thaws before a `stop` of `desk-browser`, `desk-xorg` or `desk-audio`, and before a `start` of `desk-browser`, and `desk-browser-close` thaws before it quits Chromium. Then `desk-browser-thaw`'s second `ExecStop` (`desk-browser-quit`, as root, which runs `desk-browser-close --quit`) quits Chromium over CDP (`Browser.close`) and gives it up to 31 s, so every stop writes the cookies it hasn't committed yet, and SIGTERM follows only for what's left. **So a `stop desk-browser` can take up to about 85 s** when Chromium doesn't answer (usually under a second): `desk-units` waits 90 s, and `deskd` must allow 95 s for it, a hold's included.
- **No freeze lands in a stop's quit** (the Security Analyst's T46L-1). Four parts, each tested and each seen to fail with it broken (`docs/sub-status/freeze-race.md`): `freeze` refuses while it sees a stop (step 3) and looks again after its write (step 7); `desk-browser-thaw`'s first `ExecStop` waits up to 5 s for step 2's lock before it writes `0`, so a freeze already under way when the stop is queued has answered, or died and let go, before the thaw and the quit; `desk-browser-close`'s wait writes `0` again every second, for anything that gets past both; and `desk-browser-thaw` is ordered `Before=deskd.service`, so when both stop, as at a shutdown, `deskd`, the only thing that asks for a freeze, has stopped before the thaw and the quit begin. During a shutdown `units.sock` takes no new requests anyway: a new `desk-units` can't start once the shutdown is queued, and the connection is reset (measured).
- **A shutdown reaches Chromium only through its units** (ADR 0035; found with T46L-1). `desk-browser.service` sets `DBUS_SYSTEM_BUS_ADDRESS` to a path that can't exist. On the system bus Chromium holds a logind shutdown inhibitor and ends its own session at `PrepareForShutdown`, before systemd stops anything, which leaves cookies under about 30 s old unwritten (measured: a reboot, `SessionEnded`, the quit never sent, a cookie set 8 s before lost). Off it, a reboot or an EC2 stop goes `deskd`, then `desk-browser-thaw`'s thaw and quit over CDP (`Normal`), then `desk-browser`. Chromium used the system bus for nothing else on a desk. **`desk-browser.service` must have no `ExecStop`, `ExecStopPost` or `ExecReload`:** systemd starts them inside its cgroup with `vfork`, and with the cgroup frozen PID 1 waits on the frozen child (measured: PID 1 in D state until a thaw).
- `desk-units` logs the verb and `ok`, `busy`, `inactive` or the code, with the time it took, never why a freeze was declined: `/health` and the heartbeat don't say either. `deskd` treats `busy` and `inactive` as a clear no, `bad_request` and `denied` as "this image can't", and anything else as a doubt, and thaws.
- **`start desk-adblock`** (from the image after 0.2.9, ADR 0076) puts `/data/desk/adblock-off` in effect now and answers when it is, or when nothing is running to take it (§8.9). It's a oneshot, so each `start` runs it again, and like `start desk-browser` it thaws Chromium first, since it confirms with Chromium over CDP; freeze it again afterwards if it should be. On an older image the reply is `err denied unit not allowed`. `start desk-browser` also renders the list first, and the blocker takes it by itself as Chromium starts, so a list written while Chromium is down applies at its next start.

### 8.4 What `deskd` sends `desk-rtc`
**`session.video {sessionId, view}`** is new. `session.permissions` stays what the token allows. Media flows to a session only while **`permissions.video` and `view`** are both true. `view` starts false, and revoking `video` stops media at once.

| Client asks (`rpc`, `browser.stream.set {state}`) | `deskd` does | Result |
|---|---|---|
| `live`: Browser visible, normal mode | `start desk-browser`, `start desk-stream`, then `session.video {view: true}` | First viewer: `resume` and `keyframe`. Later viewers: `keyframe` |
| `warm`: Browser visible, minified mode; also a tab hidden for more than 5 minutes (`HIDDEN_LIVE_MS` in the app), once the desk's sound has been quiet for a minute (ADR 0038), which comes back to `live` when it's visible again | `start desk-stream`, then `session.video {view: false}` | Last viewer gone: `pause`. Encoder initialized, about 0 CPU. Sound stops with the video |
| `off`: no Browser window visible | `session.video {view: false}`, then `stop desk-stream` if no session wants `live` or `warm` | Chromium and Xorg keep running; `deskd` freezes Chromium after 60 s with nothing working it (§8.3, ADR 0045) |

- **B13:** in `warm` the pipeline is up and paused, so `live` costs one frame of capture and encode plus the network. A `live` before the unit is up isn't lost: when `desk-stream` connects, `desk-rtc` sends it `resume` and `keyframe` if anyone is viewing.
- **`deskd` also sends `stop desk-browser`.** If Chromium came up on `::1` and `127.0.0.1` is free again, `deskd` stops and restarts it, at most every 5 minutes, which reloads the member's tabs. `/health` says `displaced` in that state.
- **`stream.state`:** `down` means no `desk-stream` is connected, `warm` connected and paused, `live` connected and sending. It's informational; `deskd` doesn't have to wait for it.
- **`stats`** adds `stream {state, viewers, videoPackets, videoBytes, audioPackets, keyframeRequests, level, limit}`, and per session `viewing`, `rtpDropped` and `quality`. `level` is the quality level in effect, `limit` the `stream.limit` or null, and `quality` the session's ask, absent until it asks (`stream-quality.md` §4, `desk-rtc` 0.3.3 on). From 0.3.6, `stream` also has `crop` (the island in effect, absent for none), `inputStale` and `islandBlocked` (§8.8).

### 8.5 What the app does for media
- Offer as today: recvonly audio, recvonly video, then the eight channels (§4.4). The answer has `a=sendonly` on both, so `ontrack` fires at `setRemoteDescription`. **Nothing renegotiates.** No RTP arrives until `browser.stream.set {state: "live"}`.
- Video is in stream `desk-video` and audio is in stream `desk-audio`. Tell them apart by stream id and `track.kind`: in a browser `track.id` is the browser's own UUID on a transceiver it made, so it can't be read. They're separate streams so the browser doesn't delay video to line it up with audio. **The app lines them up itself only while the member watches** (ADR 0037): with sound playing and no input for 3 s, it sends `HOLD` (§8.6) with the sound's buffering, and any input sends `HOLD 0` first. Play both with `new MediaStream([videoTrack, audioTrack])` in one `<video playsinline>`, and call `play()` from the click that opened the window, because a browser can block autoplay with sound.
- Set `receiver.jitterBufferTarget = 0` on the video receiver (design §6.5). The answer also carries the `playout-delay` extension at 0, 0 where the offer has it.
- **Video size:** read `videoWidth` and `videoHeight`. 1920x1080 for now, and it can change without signaling.
- An offer without constrained-baseline H.264 gets `m=video 0`, as in §4.4. Show that the browser can't play the stream.
- Keyframes are `desk-rtc`'s job: PLI and FIR from the browser reach `desk-stream`, and a new viewer starts on a keyframe.
- **Not in milestone 2:** congestion control. The bitrate in `stream.conf` is sent whatever the link. There's no transport-wide CC, no resolution ladder and no "reduced quality" chip yet. `bulk` is capped at 2 Mbps while a session views.

### 8.6 `input` and `keys`
**Every event is one message of exactly 16 bytes, big-endian,** on channel 6 (`MOVE` only) or channel 7 (everything else). A message of any other size or type is dropped and counted.

| Offset | Field | Meaning |
|---|---|---|
| 0 | `u8 type` | 1 `MOVE`, 2 `BUTTON`, 3 `WHEEL`, 4 `KEY`, 5 `RELEASE_ALL`, 6 `HOLD` (on `keys`; not input), 7 `QUALITY` (on `keys`; not input; see `stream-quality.md` §3) |
| 1 | `u8 down` | `BUTTON`, `KEY`: 1 down, 0 up. Otherwise 0 |
| 2 | `u8 button` | `BUTTON`: X button number, 1 left, 2 middle, 3 right, 8 back, 9 forward. Otherwise 0 |
| 3 | `u8 island` | The island's epoch the event is for (§8.8), 0 for the whole screen. `desk-rtc` 0.3.5 and older ignore it |
| 4 | `u32 seq` | See below |
| 8 | `u16 x` | `MOVE`, `BUTTON`, `WHEEL`: position. Otherwise 0 |
| 10 | `u16 y` | Same |
| 12 | `u32 keysym` | `KEY`: X keysym. Otherwise 0 |
| 12 | `i16 dx`, `i16 dy` at 14 | `WHEEL` instead of `keysym`: CSS pixels, positive right and down |
| 12 | `u16 ms` | `HOLD` instead of `keysym`: how long this session's picture should wait, 0 to let go |

- **Coordinates are normalized to the picture:** `x = round(65535 * px / contentWidth)`, with `px` measured from the left edge of the video's content box (without letterbox bars), clamped to 0–65535. `y` likewise. They stay correct when the remote size changes. `desk-rtc` scales them to the current X screen.
- **`seq`** is one counter per session across both channels, starting at 1 and adding 1 per event. `desk-rtc` drops a `MOVE` at or behind the newest `seq` it has applied (wrapping compare), so a late `MOVE` can't undo a later click. `keys` events always apply, in order.
- **`MOVE`:** at most one per display frame, and drop it rather than queue it if channel 6 has anything buffered (design §4.2.6).
- **`BUTTON` and `WHEEL`** carry their position. `desk-rtc` moves the pointer there first.
- **`HOLD`** (ADR 0037, `desk-rtc` 0.3.2 on) isn't input and never reaches X, needs no input permission and isn't `input.activity`. `desk-rtc` puts `ms`, capped at 500, rounded to 10 ms, in the playout-delay extension of this session's video as min and max both, where the offer has the extension; 0 is the usual 0, 0. It uses a `seq` like any event. Older `desk-rtc` drops it as an unknown type.
- **`WHEEL`:** coalesce per display frame. Multiply `deltaMode` 1 by 16 and `deltaMode` 2 by the picture height. `desk-rtc` keeps the remainder and sends one X wheel click per 120 px, which is what one click scrolls in the kiosk Chromium at scale 1, so N px sent scrolls N px to within one step. Under 120 px nothing moves yet, so slow trackpad movement arrives as 120 px steps, each animated by Chromium's smooth scrolling. One event sends at most 20 clicks (2400 px), and the rest of a larger one is dropped. It sends them 8 at a time, 25 ms apart, because Chromium caps one scroll update at the scroller's visible size and can merge clicks sent together.
- **`KEY`:**
  - The keysym comes from `KeyboardEvent.key`: a single character below U+0100 is its code point, any other character is `0x01000000 + code point`, and named keys are in the table below.
  - Remember it by `KeyboardEvent.code` at keydown, and send the same one at keyup, even if Shift changed in between.
  - Send every `keydown`, including `e.repeat`. `desk-rtc` turns X's own auto-repeat off, so a client that vanishes can't leave a key repeating.
  - Don't send CapsLock, NumLock, `Dead`, `Process` or `Unidentified`. `e.key` already has the right case, and `desk-rtc` adds Shift if the keymap needs it. A keysym missing from the desk's keymap goes on a spare keycode, so any character types (below).
- **Keymap:** X runs evdev keycodes, rules `evdev`, symbols `pc+us`, loaded by `desk-xorg-ready` before anyone else gets X access. Chromium reads keycodes as evdev+8 whatever X says, so this is what makes `e.code` and `e.key` right on named keys, printable ASCII and shifted characters. `inet(evdev)` is left out because no client sends its keysyms and its codes are needed as spares.
- **Spare keycodes:** `desk-rtc` uses only the codes in `chromiumFreeCodes` (`internal/xinput/spares.go`), measured keycode by keycode with `test/keyproof`: on them Chromium gives `e.code` `""` and `keyCode` 0, and the only effect is the text. `image/verify.sh` rechecks the list on every image. Any other code can act as a real key: 181 reloads, 166 goes back, 114 is ArrowRight.
  - A character stays on its code until the code is needed again, and the code reused is the one idle longest. 61 codes are free on this image. A code that's held is never reused.
  - Each new mapping waits 60 ms before the key: Chromium's text follows the keymap on its own time, so a press right after the remap types the code's previous letter, or nothing. A code also rests 500 ms after its last key event before it's reused. Both are in `spares.go`, with the measurements.
  - **`e.key` on a spare is NUL, and `e.code` is empty.** The text is right. Chromium reads `e.key` from a copy of the keymap it takes at its first key event and never updates. So a character already on a spare at that moment, such as after a Chromium restart with X still up, reports its own `e.key`, and keeps reporting it if the code is later reused for another character.
  - An update of `desk-rtc` with X still up keeps the characters already on spares: a code with one keysym on every level is taken as its own.
- **Cmd on a Mac:** `Meta` is sent as Control (FFE3, or FFE4 when `code` is `MetaRight`), so Cmd+C copies in the remote Linux browser. macOS sends no keyup for a key released while Cmd is down. When Cmd comes up, send a keyup for every key still remembered as held, then Cmd's own, or Cmd+C leaves C down for good. On other systems `Meta` is FFEB.
- **Keys that are never sent**, and the member's browser or the app acts on them instead (no event, no `preventDefault`): Ctrl+W, Ctrl+T and Ctrl+N (Cmd on a Mac), which the member's own browser won't give up; Ctrl+Tab, Ctrl+PageUp and Ctrl+PageDown; F11 and F12; developer tools (Ctrl+Shift+I, J and C, or Cmd+Option+I, J and C); on a Mac also Cmd+Q, H, M and `; on other systems Alt+F4; and Shift+Esc, which closes the Browser window. Plain Esc and Tab are sent.
- **Keys handled by the app, not sent:** Ctrl+L (Cmd+L) and, off a Mac, Alt+D move focus to the address bar, which is also the way out of the stream. Ctrl+V (Cmd+V) and Shift+Insert aren't sent as keys: the paste goes through `browser.text.insert`.
- **`RELEASE_ALL`:** send it when focus leaves the stream (the keys textarea loses focus, which a click elsewhere or Ctrl+L does), on window `blur` and when the tab is hidden. The app also forgets its held keys, buttons and pending wheel. `desk-rtc` does the same itself when the session closes or loses `input`.
- **`input: false`:** events are dropped and counted (`inputDropped`, `keysDropped` in `stats`). Any accepted event feeds `input.activity`.

| `key` | Keysym | `key` | Keysym | `key` | Keysym |
|---|---|---|---|---|---|
| Backspace | FF08 | Home | FF50 | Shift | FFE1 |
| Tab | FF09 | ArrowLeft | FF51 | Control | FFE3 |
| Enter | FF0D | ArrowUp | FF52 | Alt | FFE9 |
| Pause | FF13 | ArrowRight | FF53 | Meta | FFEB |
| ScrollLock | FF14 | ArrowDown | FF54 | AltGraph | FE03 |
| Escape | FF1B | PageUp | FF55 | ContextMenu | FF67 |
| Delete | FFFF | PageDown | FF56 | Insert | FF63 |
| F1–F12 | FFBE–FFC9 | End | FF57 | PrintScreen | FF61 |

Use FFE2, FFE4 and FFEA for Shift, Control and Alt when `code` says the right-hand key.

**The pointer is drawn locally (B12).** The video never contains it (`show-pointer=false`), so moving it has no latency. `desk-rtc` sends the remote cursor's shape on `keys` when it changes and when a session starts viewing:

| Offset | Field |
|---|---|
| 0 | `u8 type` = 0x81 `CURSOR` |
| 1 | `u8` 0 |
| 2, 4 | `u16 hotX`, `u16 hotY` |
| 6, 8 | `u16 width`, `u16 height`. 0 and 0 mean hidden: `cursor: none` |
| 10 | PNG, to the end of the message (at most 16 KiB in all). None when it wouldn't fit: use `auto` |

Apply it as `video.style.cursor = "url(data:image/png;base64,…) hotX hotY, auto"`.

`desk-rtc` 0.3.3 on also sends `0x82` `QUALITY` on `keys`, 16 bytes, to a session viewing: the stream's level, the limit and why (`stream-quality.md` §3). Tell the two apart by the first byte.

### 8.7 Data access: `/run/desk/data.sock` (from image 0.2.6)
Mode `0600`, owner `desk`, reachable inside the `deskd` container through its `/run/desk` mount, like `units.sock`. `desk-data.socket` (`Accept=yes`, `MaxConnections=24`) runs one root `desk-data` per connection, which refuses any uid but 1100 by `SO_PEERCRED`, reads `/data` and never writes there except its own scratch in `/data/.ma-export-tmp`. It's what `deskd`'s `data.*` methods (export and move, task 32) read through; without it they answer `unavailable` with `reason: helper`. The protocol (`parts`, `manifest`, `read`) is the appendix of `docs/decisions/draft-data-export-and-transfer.md`, and what the helper settles beyond it is in `tools/desk-data/README.md`. Images up to 0.2.5 don't have it: a desk on one gets it from `tools/desk-data/install.sh` over SSM, and a root swap takes it off again.

### 8.8 Video islands (ADR 0075; `desk-rtc` 0.3.6, `desk-stream` 0.3.2 on; 0.3.7 for T47S-1)
**On by default, with a kill switch only (the owner's standing rule, 2026-11-07: a finished feature ships on, and its switch is never an opt-in), once the Security Analyst clears T47S-1, fixed in `desk-rtc` 0.3.7, and `deskd`'s half of T47-4 is built.** Both releases are on `main` and pinned for the next image. Until then `deskd` sends no `stream.crop` on a member's desk and the office offers no island. Offer islands only with `desk-rtc` 0.3.7 or later: 0.3.6 lets a press through to a window over a small island (T47S-1).

An island is the simplified view's live video (design §7.4): the one encoder sends only the rectangle of `:99` where the page's player is, scaled to the size the office shows it at, at the stream's full frame rate, with the desk's sound, on the same `desk-video` and `desk-audio` tracks. There's no new track, channel or signaling, and nothing renegotiates. Numbers are in ADR 0075.

**The crop is the desk's, not a session's.** There's one encoder, so every session viewing gets the island. `deskd` sets one only while every session that's `live` wants that island; if any wants the whole screen, it sends `null`. One island at a time: the one under the pointer, else the largest in view (design §7.4).

**`desk-stream`** takes `crop X Y W H OUTW OUTH` (the rectangle in screen pixels, then the most its picture may be) and `crop none`, warm or live, in its running pipeline (`videocrop` ahead of the scaler):
- The rectangle is clipped to the screen, onto even pixels, at least 32 a side (`clip_crop`; `desk-rtc` maps input with the same rule, `xinput.ClipCrop`, and both are tested on one table). The picture is the rectangle scaled to fit `OUTW` x `OUTH`, aspect kept, never up, even sizes; a level's or a contention step's `max-height` caps it too.
- **A new picture size costs one keyframe** (x264 reopens on the new size: the first frame of the new size reaches `desk-rtc` 10 to 30 ms after the line). **A rectangle that only moved costs nothing**: the next frame shows it, with no keyframe. `deskcap` sends a frame at once either way, still screen or not.
- Bad lines are logged and change nothing. A conf without the scale chain (none ships) logs once and ignores crops.
- `[stats]` gains `crop`. `pause`, `resume` and `level` keep the crop; a new process starts on the whole screen, and `desk-rtc` sends the crop again after the level line.

**`desk-rtc`** (`stream.crop` in §4.3):
- `epoch` is 1 to 255; `x`, `y` 0 to 16383; `w`, `h`, `outW`, `outH` 32 to 16384. A bad `stream.crop` is logged and changes nothing. It sends `desk-stream` a crop line only when the picture would change: a new epoch or `keys` alone sends nothing.
- **Input:** byte 3 of every event (§8.6) names the island it was meant for, 0 for the whole screen. While an island is set, `MOVE`, `BUTTON`, `WHEEL` and `KEY` count only with its epoch, and their coordinates are normalized to the island's picture and mapped into its clipped rectangle; with no island, only 0 counts. Anything else is dropped and counted (`inputStale`), so a click meant for a picture that has since changed goes nowhere. `RELEASE_ALL`, and the release of a key or button the session holds, always go.
- **`KEY` reaches an island only while `keys` is true,** which `deskd` sets only while the page's focus is inside the island's element, **and X would send it to the kiosk's window** (0.3.7 on): the focus in that window, or on the root or PointerRoot with the kiosk's window under the pointer (on `:99` the focus falls back to the root when a `window.open` window closes, and Chromium doesn't take it back). A key down with the focus on another window is dropped and counted as `islandBlocked`, and `deskd` hears `island.blocked`; a held key's release still goes.
- **A press needs the kiosk's own window under it, and nothing over the island** (0.3.7 on; T47S-1). The kiosk's window is the lowest mapped top-level window with `WM_CLASS` class `Chromium` and `WM_WINDOW_ROLE` `browser`, which a page can't set (a `window.open` window is `pop-up`; menus, bubbles and a select's list are override-redirect, and each is mapped above the kiosk's). On a `BUTTON` down in an island the press goes only if that window is the top-level window at the pixel, holds the whole island, and no mapped window stacked above it crosses the island, however large: a popup, bubble, menu or `window.open` window anywhere over the island fails it, even beside the press. The press and its release are dropped (`islandBlocked`), and `deskd` hears `island.blocked {epoch}`, at most once a second. (0.3.6 only asked whether the window at the pixel held the whole island, which a popup bigger than a small island did.) JavaScript dialogs and tab-modal prompts are drawn inside the page's window, so X can't see them: that's `deskd`'s, below.

**What `deskd` does (the Desk Engineer's part).** Through CDP, in the walker's isolated world, for the tab on screen:
1. **The rectangle** is the element's `getBoundingClientRect()`, times `devicePixelRatio`, plus the viewport's origin on the X screen, intersected with the viewport. In the kiosk the viewport is the whole screen at (0, 0), 1920x1080 at ratio 1 (measured on image 0.2.9), so today that's the box itself; compute it anyway so a frame or a scale never misplaces it. If what's visible is under 32 px a side, the island isn't streamable: end it and show its last frame.
2. **Keep it in view.** `deskd` keeps the real page scrolled so the element is inside Chromium's viewport (`scrollIntoView({block: "nearest"})` when it leaves), since only what's on `:99` can be cropped.
3. **Send `stream.crop` on every change:** `scroll` (capture, passive) on the document and its scrollers, `resize` on the window, a `ResizeObserver` on the element, and the element's own layout changes, coalesced to one per animation frame and sent only when the rectangle changed. A moving island costs a line a frame and no keyframes.
4. **The epoch** is new for a different element (or a new island after one ended), cycling 1 to 255 and never 0. The same element moving or being resized keeps it: the client's coordinates are relative to the picture, which follows the element.
5. **`outW` and `outH`** are the island frame's size in the office, in device pixels, from the app. Asking for more than the element's size gains nothing: the picture is never scaled up.
6. **`keys`:** true only while the deep active element (through shadow roots and same-origin frames; a cross-origin frame counts as its `<iframe>`) is inside the island's element. Watch `focusin` and `focusout`, and send the same crop with `keys` changed.
7. **Order:** send `stream.crop` before telling the app the epoch, so the app's first event for it finds it set.
8. **End the island** (`stream.crop {crop: null}`, then whatever the app asks for) on `Page.javascriptDialogOpening`, `fullscreenchange`, a navigation, the element going away, the island's tab no longer being the one on screen (end it before activating another tab), `island.blocked` (show the element's last frame and offer the full page), and in minified mode turn `window.open` into a new tab rather than a placed window (Security's T47-4).
9. **States are the ones in §8.4.** An island in view in a visible Browser window: `live`. Scrolled out of view, or the window hidden: `warm`, keeping the crop, so coming back is one frame (B13). No Browser window visible: `off`. Normal mode again: `stream.crop null`, then `live`. **Sound follows the island:** it plays while the island is `live` and stops when it leaves the view, as `warm` always stops it. Whether a video the member is listening to should keep playing out of view, as ADR 0038 does for a hidden tab, is open (ADR 0075).
10. **The last frame** until the island is live: a CDP element screenshot (design §7.4), sent as MDoc data.

**What the office's island frame receives (the UI/UX Engineer's part):**
- **The same two tracks as normal mode.** The video track's frames are the island: `videoWidth` x `videoHeight` is its picture, at most `outW` x `outH`, at the element's aspect, even sizes, never scaled up. It changes on the first keyframe after a crop with a new size, without signaling: listen for `resize` on the `<video>`. Draw it `object-fit: contain` in the frame, which has the island block's aspect (MDoc's `w`, `h`).
- **Seamless:** show the last frame (MDoc data) until the first frame at the island's size arrives, then swap with no flash; after a move nothing changes size. Frame rate is the stream's: 60 when the desk can, never under 30 (ADR 0073).
- **Input:** the usual 16-byte events on `input` and `keys`, coordinates normalized to the picture's content box as in §8.6, and byte 3 set to the island's epoch from `deskd`. Events with any other epoch are dropped, and 0 is the whole screen, so set it on every event while the island has the pointer or focus. Keys reach the page only while `deskd` allows them (focus inside the element), so a player's own shortcuts work once it has focus.
- **Wheel over the island** scrolls the simplified view locally; send `WHEEL` to the island only for a widget that scrolls itself (a map). That's the app's choice; `desk-rtc` maps it like any positional event.
- **The pointer** is drawn locally from `CURSOR`, as in normal mode. `jitterBufferTarget = 0`, the playout-delay extension and `HOLD` (ADR 0037) apply as they do now.
- **Sound** plays from the same `<video>` element (or the island's own, holding both tracks), from the click that opened the page, because a browser can block autoplay with sound.
- **When `deskd` says the island was blocked or ended,** keep the last frame and offer "Open the full page", which is normal mode at that element.

**Not covered yet:** a `deskcap` that ignores damage outside the island (a page that changes elsewhere still makes frames, each a cheap repeat of the island); an island on a member Guild Desk (none: no Xorg or encoder, design Q12); two islands at once.

### 8.9 The ad blocker's per-site switch (ADR 0076)
The desk's Chromium blocks ads and trackers, on by default on every desk, with the image's own blocker: uBlock Origin Lite's pinned lists, network rules only, force-installed by policy, in both views (the simplified view is built from the same real tab). A member can turn it off for a site from the office, and on again; the Platform has a kill switch. `deskd` owns the list, the image's root helper `desk-adblock` turns it into Chromium policy, and the blocker applies the policy by itself whenever Chromium hands it a change.

**What `deskd` does to change a site:**
1. Work out the site from the tab's top-level URL: its registrable domain (eTLD+1, by the Public Suffix List), lowercase, an IDN as its `xn--` form. `edition.cnn.com` is `cnn.com`. The blocker treats a listed name as that host and every host under it, so one line covers the site.
2. Rewrite `/data/desk/adblock-off` whole and atomically (a temp file in `/data/desk`, then a rename), `desk:desk 0640`: one site a line, `\n` after each, no repeats, nothing else on a line. At most 1,000 sites and 64 KiB. A line that isn't a hostname with two labels or more (no scheme, port, path, wildcard, address, upper case or spaces) is dropped by the helper; a file that isn't a regular file of at most 64 KiB counts as empty, which means blocking everywhere.
3. `start desk-adblock` on `units.sock`, and wait for the reply (about 2 s measured; allow 35 s). One at a time: if the list changed while a call was out, call again after it answers.
   - `ok`: in effect. The blocker's own state was read back and shows exactly the list, or Chromium isn't running, or the blocker isn't installed yet (a new desk's first seconds), and then it applies when the blocker installs or at the next start.
   - `err failed start desk-adblock: …`: the policy couldn't be written (the journal says why), or Chromium is running with the blocker and the blocker didn't show the list within 20 s. In the second case the policy is written, so it applies at the next start of Chromium at the latest.
   - `err denied unit not allowed`: an image without the switch. Hide it.
4. Reload the member's tab (`Page.reload`), so the page loads under the new setting, and extract the simplified view again.

**When the member clears history:** empty `/data/desk/adblock-off` with the rest, then `start desk-adblock` as in step 3. Every start of Chromium renders the policy from that file too, so nothing of the old list survives either way (`T47S-3`).

**After starting the Browser** there's nothing `deskd` has to do: every start of Chromium renders the list first, and the blocker applies it a moment after the start (3 s measured for a list changed while Chromium was down).

**Never** drive the blocker over CDP, write its storage, or touch the policy files or the kill switch. `DeveloperToolsAvailability` 1 makes its service worker reachable on port 9222, for `desk-adblock`'s check (uid 1100 after it writes the policy as root) and `verify.sh`; that isn't an interface.

**For the app** (the Desk Engineer names the methods): the list as it stands, whether the switch exists on this desk, and set one site on or off. A teen's desk has the same switch: it's not the family filter, which stays whatever the list says. With the kill switch set, nothing is blocked anywhere and the list is kept; the app needn't show it.

**For the simplified view's walker:** blocked requests never load, and the blocker hides nothing (network rules only), so an ad's empty box or frame can stay: drop hidden nodes and frames that loaded nothing, as the prototype's `checkVisibility` already does. Fetch images through the tab, so the blocker's rules apply to them too.

## 9. Outbound throttle (ADR 0036)

`desk-egress`, as root, puts HTB on `ens5` and keeps ADR 0036's budgets. Image README, "Outbound throttle", has the operating detail and ADR 0036 section 8 the lab results.

| Class | Who | Rate and ceiling | Leaf |
|---|---|---|---|
| 1:10 | uid 1101 from UDP or TCP port 443 (`desk-rtc`) | 60 Mbit, 1 MB `burst` and `cburst`, prio 0. On a Guild Desk 0.75 Mbit a member of the tier, never under 60 (60, 60, 150 Mbit at 25, 50, 200) | `pfifo`; `fq_codel` on a Guild Desk |
| 1:15 | uid 0 and 1100 (root, `deskd`) | 2 Mbit, prio 0 | `fq_codel` |
| 1:20, the default | everyone else, including `desk-agent-filter` (uid 1106), which carries the agent's traffic | 100 Mbit, 256 KB, prio 1 | `fq_codel` |
| 1:30, a Guild Desk's only | uid 1110 from its voice ports (`commons-server`), and uid 1101 from UDP 443 when the first payload byte is 128 to 191: RTP or RTCP, which on a Guild Desk is only the voice it relays (its own sessions carry no media) | 0.8 Mbit a member of the tier (20, 40, 160 Mbit at 25, 50, 200), 1 MB, prio 0 | `fq_codel` |

- **Classification is nftables' `classify` chain** (output hook, priority -150), which sets `meta priority` and nothing else. There's no `tc filter`. Only root can change the chain, the qdiscs or a socket's priority above 6, so below root nothing can leave the stream's class or join it. Loopback isn't labelled.
- **Budgets** (`/etc/ma/egress.conf`): with 30 GB of 1:15 and 1:20 used, refilled at 1 Mbit, those two drop to 0.25 and 0.75 Mbit until 1 GB is back. Past 100 GB this UTC month or in 24 h the stream goes to `capped`, past 500 GB or 120 GB in 24 h to `deep`. Past 135 GB in 24 h 1:10 drops to 1 Mbit until under 120. Every class counts toward the month and the 24 h; only 1:15 and 1:20 draw on the bucket.
- **A Guild Desk's budgets** (`/etc/ma/guild.conf`, read only with `/run/ma/guild`): the bucket on 1:15 and 1:20 stays as on every desk. The stream steps and the 135 GB clamp on 1:10 don't apply: each member's bytes are metered to that member's own allowance (`guild-eng.md` §3.2), so a desk-wide allowance is the wrong rule, and 1:10 there is every member's data and ICE-TCP's relayed voice. In their place one day line for the guild: past 4 GB a member of the tier in any 24 h (100, 200, 800 GB), **capped at 120 GB for now** (release at most 105: 100, 120, 120 GB), since Platform's cost guard stops any instance past 150 GB in 24 h and doesn't know a Guild Desk yet (Security's `NET031-1`; `day_cap_gb`, 0 lifts it), 1:30 drops to 0.2 Mbit a member (3 voices heard) and 1:10 to 0.1 Mbit a member, until under 3.5 GB a member. The tier is the instance type the hypervisor reports (`/sys/devices/virtual/dmi/id/product_name`): `t4g.small` 25, `t4g.medium` 50, `c7g.xlarge` 200, any other 200. `desk-egress` reads the flag once, at start, and is ordered after `desk-kind`.
- **Profiles:** `desk-egress` writes `/run/desk-egress/profile` and runs `systemctl try-restart desk-stream`. `desk-stream`'s `run` reads it at start and picks `stream-<profile>.conf` from its own release, or `stream.conf` for anything else. A viewer gets a keyframe from the new process, as after any restart (§8.2).
- **For launch, nothing reports it.** `deskd` doesn't read `/run/desk/egress.json` yet (ADR 0036 section 6), the panel shows no line and the guard has no "slowed" flag. A slowdown shows only in `desk-egress`'s journal and its state file.

### 9.1 The agent's way out (ADR 0070)

`desk-agent` (1103) reaches a provider only through `desk-agent-filter` (1106), which allows the exact names in `/etc/ma/agent-egress.conf`. Image README, "desk-agent-filter", has the operating detail.

| Who | May reach |
|---|---|
| uid 1103 | Loopback. Its TCP 443 and its DNS (UDP and TCP 53, any destination) go to the filter by nftables' `agent_redirect` chain, whatever address they aimed at. Everything else is refused |
| uid 1106 | TCP 443 on public addresses, DNS at `127.0.0.53`, and answering on its own ports |
| Any other uid, root included | Not the filter's ports: `127.0.0.1:14443`, `127.0.0.1:14053` (TCP and UDP) and the same on `::1` |

- **Placeholder:** uid 1103's DNS gets `192.0.2.1` for a listed name's A, an empty AAAA and NXDOMAIN otherwise. It has no real DNS.
- **Throttle:** the filter's traffic on `ens5` is in class 1:20. Loopback isn't shaped, so nothing is counted twice. Self-hosted desks have no shaper, and nothing here needs one.
- **With it down:** uid 1103 gets connection refused, and `/opt/ma/smoke-test` fails.

### 9.2 TCP 443 per network: none (desk-net-031-sec)

TCP 443 is one `tcp dport 443 accept` after the established rule on every desk, as in 0.3.0 (`nftables.conf` byte for byte `92e3ef93`'s), and `desk-guild-net` adds nothing to it. desk-net-031's per-network limits (IPv4 /24, IPv6 /64) were taken out before any release: they counted a bare SYN, so forged SYNs claiming a member's network could shut it out of the ICE-TCP fallback (Security's `NET031-3`). `desk-rtc`'s ICE-TCP gate is the bound: from `desk-rtc` 0.4.1 it counts its waiting places per network itself, after the handshake, so forged SYNs never count: 64 places, 16 a /24 or /64, 3 s each, a full gate shared fairly between networks, and a Guild Desk's scaled to its members (`desk-rtc/README.md`, "The ICE-TCP gate"). Before 0.4.1 it held at most 64 connections that hadn't sent their first frame, 5 s each, first come. **From `desk-rtc` 0.4.2** (`GATE041-1`, `GATE041-2`): within a network an address holding two or more places over another's gives its oldest up, so one address in a member's /24 can't hold the network's 16; networks a live session is expected from (its offer's candidates, the source of a first frame signed with its password, its selected pair, and the last 32 verified networks) keep 4 reserved places a session outside the shared count; a first frame must verify with the session's ICE password; and past the gate at most 6 connections per session ufrag and 3 times a network's places per network are kept, each closed after the consent timeout without a byte. `desk-rtc` still gets no client address from the gateway (the contract has none), and the web app's offer carries no candidates, so a member's first connection from a network the desk has never verified gets no reserve (`docs/sub-status/desk-rtc-gate041.md`). Image README, "TCP 443 per network: taken out before release".


## 10. On a shared host: the container's size class (ADR 0072 section 16)

A desk on a shared host (`image/host/`) runs in a container whose size its tier sets. The host gives the desk, read-only, in
`/run/desk-host/class.json`:

```json
{"class": "free", "cpu.idle": 1, "cpu.weight": 1, "memory.max": 1051664384, "memory.swap.max": 2147483648, "memory.zswap.max": 524288000,
 "pids.max": 4096, "io": [3333333, 128, 833333, 32, 2083333, 80, 2083333, 80],
 "egress": {"stream_mbps": 30.0, "root_mbps": 1.0, "other_mbps": 50.0},
 "units": {"cpu": "0", "memory": "2/5", "swap": "1", "zswap": "1/2", "disk": "2/5", "pids": "1/2", "egress": "1/2"},
 "desksPerHost": 6, "instanceType": "m7g.xlarge", "at": "2026-11-10T00:01:02Z", "pending": null}
```

(the values above are an `m7g.xlarge`'s; `io` is the root's read bytes and IOPS, then its writes, then the volume's reads and
writes; `cpu.idle` 1 means the desk gets only CPU no other desk wants, and the kernel then shows `cpu.weight` 1). The host writes it at each start and at each class change (`desk-host class`), which takes effect at once with
nothing in the desk restarted; `pending` holds a `memory.max` still to come: a raise waiting for room on the host, or a lower
cap waiting for the next start. The file is the host's: a
desk reads it and can't change it. Nothing in the desk reads it yet. The tier's other limits (the Browser's minutes a day, the
idle stop, Files' size) are the Desk Engineer's and Platform's, from Platform's settings, not this file. On a desk of its own
there is no `/run/desk-host`.
