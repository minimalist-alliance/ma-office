# Shared-host image releases

Test bakes only (`ma-desk-test-host-*`): none is a release. Each is deleted with `image/prune.sh delete <ami>` once a later bake
replaces it.

## For the next bake, 0.1.7 (the System Engineer's; unreleased): the host link with the size classes and the counters together
`sub/host-link` (the link, below in 0.1.6's row and `docs/sub-status/host-link.md`) merged with `main`'s two entries below. Where
they met, and what changes from each entry:
- **One counting scheme, `main`'s:** the forward chain is the IPv6 drops, `desk_src` (each slot's `src_<k>`: a source other than
  `10.98.<k>.2` dropped, before any flow, IN-09; it no longer counts), `desk_est` (`est_<k>`: `out_<k>` and `rx_<k>`, no verdict), then
  the established accept. `est_<k>` counts on the slot's own interface (the slots' interface under PF-03), not the default route's.
  Both counters restart at each start (not only at a new epoch, as 0.1.6's did); the report gives them for the epoch the slot was
  started at, `net.bytesOut` and now `net.bytesIn`, and `net.json` carries both.
- **The report is the contract's** (`report.py`): `desk-host report`'s old per-slot lines, `class` included, are gone. It sends no
  `class` yet: a host that does gets `set_class` orders, which the link doesn't run.
- **The tag is read strictly:** 5 or 6 fields, the 6th any class `classes.conf` names (a new class needs only the table); 0.1.4's
  two-field tag means nothing (no host runs it). `up` takes the class from `--class` or after the volume, else the tag. `class <k>`
  with no class still reads the tag with `classes.py tag` (not strict): it must read it strictly before the link sends any
  `set_class` (an upgrade in place).
- **SlotsPerHost:** the link and the report cover `DeskSlot1` to `DeskSlot<SlotsPerHost>`; the hello's `desksPerHost` stays DesksPerHost.
- `desk-host-check`: 25 checks (19, then `classes`, `class-applied`, `counters`, `link`, `inbound`, `standin`); `verify.sh` must pass
  **42 of 42**: 0.1.6's 37 with 25 checks, plus the size classes and the byte counters (sections 4b and 4c), now run by hand with the
  link stopped and the Elastic IP back on slot 1. The bake reruns the counters mutation and the stream and download counter proof
  (0.985 and 0.999 before) on the merged rules, and must carry `host-api.<suffix>` (0.1.6 carries the old `api.` URLs).

## For the next bake (unreleased): container size classes (S-119, `sub/host-size-classes`)
- `/etc/desk-host/classes.conf` and `classes.py`: a slot's class sets its container's `cpu.weight` (or `cpu.idle`), `memory.max`, memory rule,
  `io.max`, `pids.max` and published egress rates, each a multiple of one standard desk's share (ADR 0072 section 16).
  `standard` (all 1s) is 0.1.4's share to the byte, and a slot without a class is `standard`. `free` is the free tier's:
  `cpu.idle` (CPU only when no other desk wants it), 0.4 of a standard desk's memory and disk, measured; a host should still
  run at most `DesksPerHost` desks at once, which is placement's (ADR 0072 section 16).
- `desk-host up <k> <deskId> [<vol> [<class>]]` takes the class from the argument or the slot tag's 6th field (proposed to
  Platform; 2- and 5-field tags parse as `standard`); `desk-host class <k> [<class>]` changes a running desk's class in place
  (an upgrade keeps every process and the Browser's session); both are admitted only while the running desks' memory and
  disk shares fit `DesksPerHost` standard desks' (a start is refused with 75 otherwise; a raise applies CPU and pids at once
  and its memory and disk wait, 75, until `class` runs again with room). The slot report carries each slot's class.
- `desk-host-boot` reads a `SlotsPerHost` launch tag (default `DesksPerHost`) and sizes conntrack to the slots; slots, not
  desks, set the slot range and each slot's source-port block.
- `desk-host-check` gains `classes` (the table, also a quick check before every start) and `class-applied` (every running
  desk's cgroup is its class's, and the sums fit), 21 checks; `verify.sh` gains the classes section and both mutations.
- Proven on a 0.1.5 host with these files copied on (no bake): `spikes/host-size-classes/README.md`. The bake after 0.1.5
  takes them; `verify.sh` must then pass 26 of 26 (the boot, 21 checks, `WR2-02`, the desk, the classes, the mutation pass).

## For the next bake (unreleased): slot byte counters and cold wakes (`sub/host-wake-counters`)
- **Fixed: a slot's byte counter missed almost everything a desk sent.** `/etc/nftables.conf`'s forward chain accepted
  `ct state established,related` before `jump desk_fwd`, so `out_<k>` counted only each new flow's first packet. The chain now jumps
  to `desk_est` first, where each slot's `est_<k>` counts both directions (`out_<k>`, and a new `rx_<k>`), with no verdict, and the
  same accept follows. `net.json` and `desk-host report` gain `bytesIn`; `bytesOut` now means what ADR 0072 section 8 says. Each start
  counts from 0. Also fixed: `grep -q "jump slot_1"` matched `slot_10`, so slot 1 started after slot 10 got no jump (now anchored).
  `desk-host-check counters` (22 checks) and its `verify.sh` mutation; `verify.sh` section 4c compares the counters with the veth's.
  **Needs the new `/etc/nftables.conf` too: files copied onto an old host without a ruleset reload keep the old behaviour, and the check fails.**
- **Cold wakes: `desk-host up` pre-reads** (`preread.py`, `/etc/desk-host/preread.list`) the files and byte ranges a cold wake reads
  (deskd, base libraries, the other services, then Chromium), from the host's side in a cgroup beside `desk-host` capped at 0.2 of the
  EBS baseline, before `runc start` (the start waits for the first 177 MB; Chromium's is read beside the running desk).
  `PREREAD=off`, `PREREAD_SHARE` in `desk-host.conf`.
- **A class's own `IO_SPLIT`** (`classes.conf`'s optional 8th column); `free` is `70,5,12.5,12.5`. Admission now sums every desk's four
  byte caps, not the root reads alone.
- Measured on a 0.1.5 host with these files copied on (no bake): cold hello 30.5 -> 19.2 s (standard) and 71.6 -> 23.7 s (free); a
  ready Browser 85 -> 35 s and 184 -> 42 s. `spikes/host-wake-counters/README.md`. The next bake must pass `verify.sh` with 22 checks.

| Version | AMI | Date (UTC) | Git SHA | Kernel | Chromium | Baked releases |
|---|---|---|---|---|---|---|
| 0.1.1 (deleted 2026-11-08: baked from an uncommitted tree, before the dev box's fixes) | <ami> | 2026-11-08 13:24 | f567a104+dirty | 6.12.115+deb13.1-arm64 | 156.0.8078.79 | desk-rtc 0.4.0, desk-stream 0.3.3, deskd 2026.11.07-98316db, desk-agent 2026.11.07-98316db, desk-agent-filter 0.1.1, desk-notebook 2026.11.07-98316db |
| 0.1.2 (first boot failed: `desk-host-boot` hit ENOENT turning on the desks' cgroup controllers while systemd was still realizing its own; fixed in 0.1.3. Deleted) | <ami> | 2026-11-08 13:59 | 40870038 | 6.12.115+deb13.1-arm64 | 156.0.8078.79 | desk-rtc 0.4.0, desk-stream 0.3.3, deskd 2026.11.07-98316db, desk-agent 2026.11.07-98316db, desk-agent-filter 0.1.1, desk-notebook 2026.11.07-98316db |
| 0.1.3 (never booted: before it finished, a rehearsal on 0.1.2 found port mode never connected and `reset` returned 1 on a clean slot; both fixed in 0.1.4. Deleted) | <ami> | 2026-11-08 14:32 | be7276da | 6.12.115+deb13.1-arm64 | 156.0.8078.79 | desk-rtc 0.4.0, desk-stream 0.3.3, deskd 2026.11.07-98316db, desk-agent 2026.11.07-98316db, desk-agent-filter 0.1.1, desk-notebook 2026.11.07-98316db |
| 0.1.4: **`verify.sh` 23 of 23** (`evidence/verify-<ami>.txt`; its first run failed the boot check on a bug in the check, kept as `-first-run.txt`); the six-desk runs and the wall's proofs ran on it | <ami> | 2026-11-08 14:53 | 62fb5981 (staged from 9ec4f8cf; `image/` is the same tree in both) | 6.12.115+deb13.1-arm64 | 156.0.8078.79 | desk-rtc 0.4.0, desk-stream 0.3.3, deskd 2026.11.07-98316db, desk-agent 2026.11.07-98316db, desk-agent-filter 0.1.1, desk-notebook 2026.11.07-98316db |
| 0.1.5: **`verify.sh` 23 of 23** (`evidence/verify-<ami>.txt`); a test bake, nobody's default, kept for the staging soak; baked with `ALLOW_UNPASSED=1` because `bake.sh` doesn't yet accept `commons-server`'s `passed-guild.json` (`docs/sub-status/host-proofs-1109.md`) | <ami> | 2026-11-09 23:33 | d6d9ea71 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.4.1, desk-stream 0.3.3, deskd 2026.11.08-f435ef9, desk-agent 2026.11.08-8d940bc, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
| 0.1.6, first bake (`verify.sh` 36 of 37, `evidence/verify-<ami>-first-0.1.6.txt`: the link ran a wake's `start_slot` only once per order ID, so a wake after a stop at the same epoch never started; fixed and baked again as 0.1.6. Deleted) | <ami> | 2026-11-10 00:02 | 4cc6cb1b | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.4.1, desk-stream 0.3.3, deskd 2026.11.08-f435ef9, desk-agent 2026.11.08-8d940bc, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
| 0.1.6: **`verify.sh` 37 of 37** (`evidence/verify-<ami>.txt`): the host link (sub/host-link) driven end to end by a fake Platform, 22 host checks, PF-01, PF-03, IN-09, the stand-in, the mutation pass. Kept for Platform's staging gates | <ami> | 2026-11-10 01:04 | 615a732c | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.4.1, desk-stream 0.3.3, deskd 2026.11.08-f435ef9, desk-agent 2026.11.08-8d940bc, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
