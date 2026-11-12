# The shared-host image (`image/host/`)

The image for a machine that runs several members' desks at once, each in its own container behind the wall
(ADR 0072; task 46's packing: 6 desks per `m7g.xlarge`). It is separate from the desk image in `image/recipe/`,
which a desk of its own boots, and it reuses that recipe whole: the desk image becomes the template every slot's root
is copied from. Owner: the System Engineer. Platform launches and drives the hosts (ADR 0072 "Platform's side").

Status: **test bakes only** (`image/host/RELEASES.md`). Nothing places a member on a shared host before the Security
Analyst clears the wall as built and ADR 0072 is accepted (its section 14).

## How it's built

`bake.sh <version>` (from the workstation, under `flock ~/work/.aws-bake.lock`; `OWNER_TAG=<tag>`):

1. Checks the desk recipe's `releases.pin` as `image/bake.sh` does (each line against `meta.json`, `.sha256` and
   `passed-test.json`), builds `desk-agent-filter` from the recipe, and builds `desk-svc` here from `desk-svc/` with the
   pinned Go (`-trimpath`, no build ID: the same bytes for the same source). Checks the **template signing key** (ADR 0077 PU-9):
   `recipe/files/etc/desk-host/template-keys/` must be exactly the committed anchor, `recipe/template-keys.sha256`
   (`recipe/template-key-check`: the anchored names and nothing else, no link, the anchor's SHA-256, P-256), and the key must be
   `alias/ma-host-template`'s public half as KMS's `GetPublicKey` gives it (compared as DER). Either differing stops the bake before
   anything is launched. A role without `kms:GetPublicKey` stops the bake too: that compare is the one check that catches a key
   and its anchor changed together in git. `ALLOW_NO_KMS_COMPARE=1` bakes on the anchor alone, with a `WARNING` naming the
   permission. A **release bake** (`HOST_AMI_PREFIX=ma-shared-host-`) also needs a clean `image/` tree, no changed and no
   untracked file under it, so it's made from committed files only; a test bake may be dirty, and its SHA says `+dirty`
   (Security's ADR 0077 Lows 1 and 2, Nov 11).
2. Launches a `c7g.large` builder from Debian 13's arm64 AMI with two volumes: the root (16 GB) and the **slot store**
   (`/dev/sdf`, 12 GB).
3. Runs the **desk recipe** (`image/recipe/build.sh`) unchanged: the builder's root is then exactly a desk image.
4. Runs the **host recipe** (`recipe/build.sh`), which:
   - formats the slot store (ext4 with project quotas, a fresh UUID recorded in `/etc/desk-host/store.uuid`) and copies
     the root to `/srv/desk-host/template` (no Docker store, kernel, logs, cloud-init state, host keys or SSH; users
     `desk-x` 1107, `desk-snd` 1108, `desk-dns` 1109, `desk-data` 1112 and group `desk-audio` 1111 added;
     `NativeMessagingUserLevelHosts` off; `/etc/ma/desk-rtc.conf` a link to the host's `/run/desk-host/desk-rtc.conf`);
   - captures Docker's own spec for a default container (`docker-oci.json`, what every desk and sandbox spec starts from);
   - fills the **release store** with `desk-host-release` from the pinned artifacts only (below);
   - installs Debian's `linux-image-arm64` (zswap is built in; the cloud kernel has none) and removes the cloud kernel;
   - installs `runc` 1.5.2, upstream's static build, checked against its SHA-256 and upstream's signing key;
   - purges the desk's stack from the host (Docker, Debian's `runc`, Chromium, X, PulseAudio, GStreamer, zram), removes
     the desk recipe's files and users from the host's own root and masks every desk unit;
   - checks the staged template key against the anchor before it makes anything, and the installed one again before it pins
     it: `/usr/local/lib/desk-host/template-keys.sha256` is the anchor itself. No key, or any other, and the bake stops;
   - holds the host's batch key (`/etc/desk-host/batch-keys/`) to the desk image's own copy in the template
     (`/opt/ma/etc/batch-keys/`), and stops if they differ or the template has none (Security's ADR 0077 Low 3, Nov 11: the
     check used to compare with bake.sh's staged desk recipe, which the desk recipe removes as it ends, so it never ran);
   - installs the host's files (`recipe/files/`): `desk-host` and its helpers, the host's own ruleset, sysctls, the boot and
     shutdown units, `desk-host.conf`;
   - blacklists 64 protocol modules and every tty line discipline the kernel ships (`install <m> /bin/false`), and sets
     `dev.tty.ldisc_autoload=0` (`RC-02`, `WR2-02`);
   - reserves every slot's uid range (`desk-slot-1` to `-29` in `/etc/subuid` and `/etc/subgid`, nothing else in them);
   - cleans as the desk recipe's last step does, then checks what needs no boot.
5. Snapshots both volumes into one AMI named `ma-desk-test-host-<version>` (so `image/prune.sh delete <ami>` removes a
   test bake; a release would be `ma-shared-host-<version>` with `HOST_AMI_PREFIX`), tagged `HostKind=shared`,
   `HostKernel`, `ChromiumVersion`, `DeskTeenLock=1` and the baked releases, as a desk image is.

`verify.sh <ami> [m7g.xlarge]` boots the AMI as Platform would under SlotMode=address and proves it; `SLOT_MODE=port verify.sh`
(`verify-port.sh`) does the same under SlotMode=port (see "Verify"). Run both on every bake.

## What's on a host

| Path | What |
|---|---|
| `/` (16 GB) | Debian 13, the generic arm64 kernel, `runc` 1.5.2, the host's ruleset, `desk-host`. No Docker, no desk unit, no SSH |
| `/var/lib/desk-host/swap` | The 8 GB swap file zswap sits in front of, made at the first boot; never written (every desk has writeback 0) |
| `/srv/desk-host` | The slot store (the AMI's second volume): `templates/<gen>/` (each read-only bind; "Updates"), `releases/`, `slots/<k>/{rootfs,rel,svc}` |
| `/usr/local/lib/desk-host` | `desk-host` and its helpers, `desk-host-link` (the host's link to Platform, below), `desk-ice-demux` (SlotMode=port's TCP 443, below); `desk/` is mounted read-only at `/desk-host` in every desk (desk-init, desk-svc, desk-units) |
| `/etc/desk-host` | `desk-host.conf`, `classes.conf` (the size classes), `releases.pin` (the desk recipe's), `store.uuid` |
| `/var/lib/desk-host` | Slot records, `hosting.json` (DesksPerHost, SlotsPerHost, HostingVersion and SlotMode from the first boot's tags), the store's serial |
| `/run/desk-dmx` | SlotMode=port only: the demux's `env` (its listen address and slot count) and `slots/<k>`, desk-host's mark on each running slot |
| `/run/desk-host` | Per slot: what the host gives a desk (read-only in it: `slot.json`, `net.json`, `class.json`), the namespace binds, the `/run` shares' tmpfs, the locks; for the report, each slot's operation marker, fault, start record and counter epoch (`op/`, `fault/`, `slotstate/`, `net/`) |

At boot `desk-host-boot.service` turns on zswap (`lz4`, `zsmalloc`, 50% of RAM, no shrinker), the swap file, the slot
store (found by its baked UUID and, after the first boot, its NVMe serial; grown to the volume's size), the template's
read-only bind, the desks' cgroup (`+cpu +memory +pids +io`) and conntrack's size, and reads the hosting tags.
`desk-host-shutdown.service` stops every desk as a stop does when the host goes down (`IN-09`): its stop is `desk-host stop-all`,
its start `desk-host resume`. `desk-host-link.service` starts after it and stops before it (below), and a link's stop leaves
a start it had begun running (`KillMode=process`), so `stop-all` stops that desk too (below).

**Root and the desk users' folders (`slot-datadirs`, EXP-7's class).** A slot's `desk-init` runs as the desk's root (an unprivileged uid on the host, root of that member's own desk). It acts by name only in directories only root can change (`/data`, the desk's own `/run`, `/var`, `/`). Inside a desk user's own folder the user does it (`setpriv`, no new privileges): `kiosk` makes `/data/browser/profile`, `downloads` and `home`, `desk` copies the volume record to `/data/desk/volume.json`, `desk-snd` empties and makes `/run/desk-audio/pulse`. `units.sock`, in the slot's `/run/desk` (`rtc:desk` 0770), is bound with the thread's filesystem uid and gid set to `desk` and its mode set on the socket first, never chowned by name, and the profile's `Preferences` is read with `O_NOFOLLOW` at each step and `O_NONBLOCK`. Before this change (every host image to date: 0.1.11.1 on the 0.1.11 line), `os.makedirs`, `chown` and `chmod` by name followed a link `kiosk` put at `/data/browser/home` and gave it the directory it named at the next start. The host's own writes (nothing in a desk's root or volume after it has run but the format record on a blank volume, `mounts.py`) were audited with it: `docs/sub-status/slot-datadirs.md`.

## `desk-host`

| Command | What |
|---|---|
| `prepare <k>` | A fresh root for slot k: the template copied, shifted to the slot's uid range, under a project quota, with the services' releases copied from the store; record `fresh`. Refuses a slot whose desk is still there. The slot's old root is deleted before the copy; the copy runs in the host's copy turn, and only with room on the store (exit 75, "refused for room", nothing made); a copy that fails leaves no tree ("The store's room", below) |
| `up <k> <deskId> [<vol>] [<class> \| --class <class>] --public <address>` | Start a desk. `DeskSlot<k>` (below) must name it, and the volume if given; under SlotMode=address the slot's address is the tag's `privateIp` on whichever interface carries it, and IMDS must associate `<address>` (the slot's public address, from the link's hello) with it; under SlotMode=port the address is the host's own and `<address>` must be IMDS's `public-ipv4` now ("One address per host"); else the slot stays down and the report says why (`slotnet.py`). The class is the tag's unless given (no class is `standard`). Then the host's quick checks, the record (wake, claim a fresh root, or prepare again), the pre-read, the class's cgroup limits once admitted (exit 75 if the host is full), the per-slot AppArmor profile, `runc create` of the desk and its six sandboxes, the volume by `mounts.py`, the network from the host (the slot's own routing table when its interface isn't the default route's, the stand-in's DNAT, the byte counters from 0), `runc start` |
| `report` | The slot report the link carries (`report.py`): per slot `k`, `state` (`empty`, `prepared`, `starting`, `running`, `stopping`, `stopped`, `unmounted`), `deskId`, `epoch`, `net.bytesOut` and `net.bytesIn`, `shaper` for a running slot (its classes' rates and `tc` counters, `on`, `off` after `desk-host shaper <k> off`, and its budget: `slowed`, `clamped`, `profile`, `bucketGb`, `dayGb`, `monthGb`, `savedAgoS`; Platform ignores it), and `fault` when the slot was kept down; for a slot that's starting, running or stopping, its `class` (the slot's `class.json`, with `+pending` while a lower memory cap waits: contract 0.3.46); the host's `conntrack`. The same two counts go to the desk's `/run/desk-host/net.json` (`bytesOut`, `bytesIn`, `boot`). See "What the byte counters count". From the bake after 0.1.10 (S-119): before it the report had no `class`, so Platform sent no `set_class` |
| `class <k> [<class>] [--whole]` | A running desk's size class, changed in place (an upgrade in place): its cgroup rewritten, nothing restarted or entered. From the tag if not given. CPU weight, pids and the memory rule at once; a raise of memory and disk is admitted as a start is, and waits (75) while the host is full, finished by running `class` again; a lower memory cap the desk doesn't fit yet waits for its next start. **`--whole`** (the link's `set_class`, from the bake after 0.1.10): a raise the host has no room for changes nothing at all and exits 75, and nothing changes while the host is stopping (exit 1), so a class is never half applied |
| `stop <k>` / `stop-all` | `runc kill TERM`: deskd's sandbox, then the desk (its init thaws and closes Chromium over CDP, then SIGTERM), then the rest; then every per-slot state outside the root is reset. `stop-all` (a host stop) first marks the host halting (`/run/desk-host/halt`), then stops every slot with a container and every slot an `up` has marked `starting` (`stop` waits for that up's lock and stops what it left). An `up` checks the mark under its lock before it changes anything, before `runc create` and before `runc start`, and refuses with the fault `host_stopping` (kept in `/run/desk-host/fault/<k>`; not one the report carries), so no desk starts after a host stop has begun. Before the bake after 0.1.7, `stop-all` looked only for containers and skipped a start in flight, which then finished: its desk was killed with the host, not closed (ADR 0035) |
| `shaper <k> [show\|off\|on]` | Slot k's outbound shaper (ADR 0036 per container, "The outbound shaper" below). `show`: its classes' rates and `tc` counters and its budget, as the report carries them. `off`: the classes taken off its veth and its `desk-host-egress@<k>` stopped, as a bug would lose them (ADR 0036's test 1 on a shared host, row R5): only the guard's count (`out_<k>`) and stop stand, and `desk-host-check shaper` fails until `on`, or the slot's next start, puts both back. Takes the slot's lock |
| `resume` | Ends a `stop-all`'s halt: `desk-host-shutdown.service`'s start (at every boot, where `/run` is empty anyway). `desk-host-check boot` fails while the host is halted with that unit up |
| `reset`, `leftovers`, `state`, `ctlimit`, `check` | Recovery, connection limits, the host's checks |

One prepare, start, stop or class change per slot at a time: each takes the slot's lock (`/run/desk-host/lock/<k>`). Admission
(a start's or a class change's limits) takes the host's one lock (`/run/desk-host/lock/admit`) around its check and its write.

**The store's room** (from the bake after 0.1.12, `sub/prepare-space`; 0.1.11.1 on the 0.1.11 line; Platform's reclaim wave on staging, 2026-11-11: six slots prepared again at once filled two 0.1.9
hosts' 36 GB stores, and desks placed after it failed with "No space left on device"). The store is sized for one copy in flight beside
the slots (ADR 0077 section 4). So a prepare:
1. deletes the slot's old root before its copy, never after. It's orphaned once the prepare removes its record: nothing starts on a root
   no record names, and everything a desk keeps is on its `/data` (ADR 0072 sections 10 and 12). A prepare never holds two roots.
2. copies only in the host's copy turn (`/run/desk-host/lock/copy`, held from its room check to its rename), and under it only when the
   store holds one more root (the template and the release copies, measured once) beside what the other recorded slots' desks may
   still write (their quotas' room) and `PREP_SPARE_MB` (512). Otherwise it exits 75, "slot <k>: refused for room: ..., nothing
   copied", with nothing made. A `.<k>.new` or `.<k>.old` tree whose maker is gone (a SIGKILL) is removed then.
3. removes the tree it was making on every way out before its rename (a failed `tar`, `shift.py` or `cp`, SIGTERM), without following
   links, so a failure never leaves a partial that keeps other slots failing.

On this line a start's prepare (a member waiting) may take the turn from a background holder (SIGTERM to its process group, as before).
Platform's `prepare_slot` runs `desk-host prepare` in its own process group (`setsid`), so only it stops, and its tree is removed; until
this change it wrote the link's own group as the holder. The fresh `rel/` copies of a re-root's swap and of a switch cut off half way
take the turn too (in the foreground: they run under the slot's lock).

`verify-wave.sh` (both verify scripts' last step) runs the wave on a store filled until it holds one root more, and 0.1.11's prepare as
its mutation; `tests/test_prepare.py` has each fault on fake trees and the wave on a size-capped tmpfs.

**Per desk** (`desk-host.conf`), for a `standard` desk: `cpu.weight` 100; `memory.max` (MemTotal − 640 MiB) ÷ DesksPerHost;
the memory rule, proposed to the Security Analyst in place of `WALL-07`'s swap 0: `memory.swap.max` 2 GiB,
`memory.zswap.max` 1,000 MiB, `memory.zswap.writeback` 0 (compressed inside the desk's own cap, never written to the swap
file); `io.max` on its root's device and its volume's, 0.8 of the instance's EBS baseline ÷ DesksPerHost split four ways
(`IO_SPLIT`, root reads and writes, volume reads and writes: 40, 10, 25, 25; a class may have its own, the table's optional 8th column), so every desk at every cap sums to 0.8 of the
baseline (`RC-04`); `pids.max` 8,192; a project quota; 4,096 connections inside and 4,608 on the host; IPv6 off on both ends
of its veth and dropped by the host.

**What the byte counters count** (ADR 0072 section 8). `out_<k>` is every IP byte the desk sends out of the host and `rx_<k>` every IP byte it
receives, each counted after the wall's drops (a dropped packet is counted by the drop's own counter, never here), on the slot's own
interface (the slots' interface under `PF-03`). The forward chain jumps to `desk_src` (each slot's source check) and then to `desk_est`
before its established-and-related accept: `est_<k>` there counts both directions of every packet of an
established flow, with no verdict, and the accept follows as before (the fast path is kept for everything else). The first
packet of a new flow is counted where it is accepted (`slot_<k>` for out, `fwdin_<k>` for the DNAT'd inbound ones). Before the next bake only
those first packets were counted, so `bytesOut` was near zero for any desk that streamed. Each start counts from 0 (`desk-host` resets
both when it makes the slot's chains), a wake at the same epoch included; the report gives them only for the epoch they were started
at (`/run/desk-host/net/<k>.epoch`), and Platform takes a lower count as a restart. The count is the IP packet's length: the slot's veth counts 14 bytes more per packet.

**The outbound shaper** (ADR 0036 per container; ADR 0072 section 8; TD-223; from the bake after 0.1.10). `desk-host up` puts ADR
0036's HTB on the desk's end of its veth, `eth0` in its network namespace (entering only that namespace, before anything in the desk
runs), where the template's `classify` chain has already labelled each packet: 1:10 `desk-rtc` from 443 and, under SlotMode=port, the
slot's UDP port; 1:15 the desk's root and `deskd`; 1:20 everything else. Rate equals ceiling: 60, 2 and 100 Mbit for a `standard` desk,
times the class's `egress` (`free`: 30, 1 and 50). The host's end can't take them: forwarding sets a packet's priority again. The desk's
root has no `CAP_NET_ADMIN`, so nothing in the desk can change them. Then `desk-host-egress@<k>.service` runs the desk's own
`desk-egress` code for the slot (`egress.py`; `desk_egress.py` is the template's `desk-egress`, installed at bake): every
`tick_seconds` it reads the classes' counters and applies ADR 0036 section 5's budgets (the 30 GB bucket on 1:15 and 1:20, the
stream's `capped` and `deep` steps, the 135 GB clamp on 1:10), puts the classes back if they're gone, and saves the budget in
`/var/lib/desk-host/egress/<deskId>.json` (the host's, never the desk's `/data`; a move starts it over on the target, and old ones go
after 35 days). It re-reads the class each tick, so `desk-host class` changes the rates live. The stream's profile is the host's
`/run/desk-host/<k>/egress/profile`: `desk-stream`'s sandbox reads it at `/run/desk-egress` when it starts, and `desk-init` restarts a
running `desk-stream` when it changes. Settings: `/etc/desk-host/egress.conf` (`[egress]`, the desk's `egress.conf` values), and a
`[slot<k>]` section for one slot's lowered thresholds in a test (a member's host has none; the `shaper` check names one). It fails open
as on a desk of its own: a shaper that won't go on doesn't keep the desk from starting, no clamp outlives the unit (its
`ExecStopPost`) or 10 failed ticks, and the guard's count (`out_<k>`) and stop stand behind it. A stop stops the unit first, so its
last tick counts the last minute. `desk-host-check shaper` fails a running slot without its classes, its unit or a fresh state.

**A wake reads from the host's side first.** `desk-host up` starts `preread.py` beside the rest of its start: it reads the files and
byte ranges in `/etc/desk-host/preread.list` (what a cold wake read, made from a trace) from the slot's root and the host-owned release
copies, so the pages are in the host's page cache and charged to no desk. It runs in its own cgroup, `desk-host-pre`, beside `desk-host`,
with `io.max` at `PREREAD_SHARE` (0.2) of the instance's EBS baseline: the desks' caps sum to at most 0.8 of it, so the host's read
fits in the rest. The start waits for the list's first part (up to the `---` line); the rest is read beside the running desk, still
capped. `PREREAD=off` in `desk-host.conf` turns it off. It reads regular files only, resolved inside the root or the release copies.

**Size classes** (ADR 0072 section 16, "Container sizes by tier"; `classes.conf`, `classes.py`). A tier picks a class through
Platform's `DeskSlot<k>` tag (its optional 6th field, any name `classes.conf` has; none means `standard`), and the class multiplies each value above but the
connection limits and the quota: `cpu` (`cpu.weight`; 0 is `cpu.idle`, CPU only when no other desk wants it), `memory` (`memory.max`), `swap` and `zswap` (the memory rule; writeback
stays 0), `disk` (`io.max`), `pids` and `egress` (ADR 0036's rates, in the desk's `/run/desk-host/class.json`, enforced by the slot's
shaper from the bake after 0.1.10: "The outbound shaper"). `standard` is all 1s, so a host and tags without classes behave exactly as 0.1.4.
`DesksPerHost` stays the host's size in standard desks (the hello's `desksPerHost`); `SlotsPerHost` (a launch tag, contract 0.3.46
draft; DesksPerHost to 29, default DesksPerHost) is how many slots it has (`DeskSlot1` to `DeskSlot<SlotsPerHost>`, in the report and the
link's orders). A start or a raise is admitted only while the running desks' `memory.max` and disk
shares, read from their cgroups, fit `DesksPerHost` standard desks', so memory is never overcommitted between running desks and
no desk's peak reaches another's. The measured `free` row and the capacity table: `spikes/host-size-classes/README.md`.

**The slot tag** (ma-platform contract `shared-host.md` section 2, `PF-01`): `DeskSlot<k>` =
`<deskId|->/<volumeId|->/<privateIp>/<allocationId>/<epoch>[/<class>]`, written by Platform's placer, read through IMDS and
parsed strictly with Platform's own patterns (`hostmeta.py`): anything else means nothing. The optional sixth field is the
slot's size class, a name `classes.conf` has (`standard` or `free` today; missing means standard), so a new class needs only that
table; the link passes it to `desk-host up`. `desk-host class <k>` with no class reads the tag as strictly as `up` does
(`slotnet.py tag`, from the bake after 0.1.6; before, `classes.py tag`, which wasn't strict). Under SlotMode=address a slot is
mapped by the tag's address, never by order, and under `PF-03` a host has two interfaces, its own (device 0, no inbound rule) and
the slots' (device 1). Under SlotMode=port the two address fields are `-`, and the host has one interface ("One address per host").

**The host's ruleset, per slot:** a desk's packets meet its slot's source check before any flow is let through
(`src_<k>`, from the `forward` chain's `desk_src`: a source other than `10.98.<k>.2` is dropped, `IN-09`), and only then counted
(`desk_est`, above); nothing new reaches the host's own address, ping included (`PF-03`); TCP 80 to `169.254.169.254` from the slot's
own address is DNATed to its stand-in, and everything else to that address dropped (`IN-03`, `IN-04`).

## One address per host (`SlotMode=port`, the owner's choice B)

The owner, 2026-11-10 (about 3 am MT, relayed by the Lead): "OKay lets do it". One auto-assigned public IPv4 per host and no
Elastic IPs; a UDP port per slot; every slot's ICE-TCP on the host's one 443 through a demux; `turn.` the last resort (it
doesn't exist yet, so the demux is today's). ADR 0072 section 6's note; Platform's answer (contract `shared-host.md`): the
launch tag **`SlotMode=port`** selects it, `address` (or no tag) is choice A, and the host reads it once, at its first boot,
into `hosting.json`, as it reads DesksPerHost. Anything else is kept as refused, and no slot starts: a host never guesses.

| | SlotMode=address (A) | SlotMode=port (B) |
|---|---|---|
| Interfaces and addresses | The host's own and the slots' (PF-03); a private address and an Elastic IP per slot | One interface, its one private IPv4 and EC2's auto-assigned public IPv4. Nothing else (`desk-host-check addresses`) |
| `DeskSlot<k>` | `<desk>/<vol>/<privateIp>/<allocationId>/<epoch>[/<class>]` | `<desk>/<vol>/-/-/<epoch>[/<class>]`: `-` in fields 3 and 4, and only there; an address tag means nothing on a port host and a `-` tag nothing on an address host (`hostmeta.parse_slot_tag`) |
| The hello and slot-session | Each slot's private and public address and allocation | Contract 0.3.57: the hello says `slotMode: "port"` and the host's `publicIp` as EC2 has it now at its top and each slot's `udpPort` (4430 + k); a session names both. The link refuses a hello of the other mode, and takes a session only with the slot's port |
| In | UDP and TCP 443 on the slot's address DNATed to it | UDP 4430+k on the host's address, from its interface only, DNATed to slot k (`pre_<k>`, `fwdin_<k>`); TCP 443 is `desk-ice-demux`'s; nothing else (no TCP DNAT, no ping, no other port) |
| Out | From the slot's own address | SNATed from the host's address with the slot's own block of source ports (10,000 to 59,999 split by SlotsPerHost); the host's own ephemeral ports are moved above them (`ip_local_port_range` 60000 to 64999) |
| The slot's `desk-rtc` | 443, both candidates on the slot's public address | `port=4430+k`, `tcp_port=443`, `slot=k` (ufrags tagged `s<kk>`), `public_ipv4=` the host's (IMDS at each start), in the slot's own `desk-rtc.conf` (`desk-rtc` 0.5.0, its README's "Shared hosts") |

**`desk-ice-demux`** (`desk-ice-demux/`, Go, standard library only, built by `bake.sh` as `desk-svc` is): the host's TCP 443 on its
own address, never `0.0.0.0` and never a slot's side. For each connection, counted after the handshake under its client
network (an IPv4 /24): it reads the first RFC 4571 frame, which must be a STUN binding request with one USERNAME and a right
FINGERPRINT; takes the slot from the tag of the USERNAME's first ufrag; checks the slot is running (desk-host's mark,
`/run/desk-dmx/slots/<k>`, a regular file made once the slot's network is set and removed first at its stop); and opens a
connection to `10.98.<k>.2:443` **from the client's own address and port** (`IP_TRANSPARENT`; a busy port falls back to any
port of the client's address), writes the frame and splices both ways until either side closes. The slot's `desk-rtc` then
checks the frame's MESSAGE-INTEGRITY with the session's password and keeps or closes the connection, as on any desk.
- **Refused at once (a reset):** a length that can't be a first frame (TLS, HTTP and SSH fail at the second byte), a header
  that isn't a binding request, a bad attribute or FINGERPRINT, no USERNAME, a ufrag with no slot's tag (Commons' `cmns...`
  included), a slot past SlotsPerHost or not running, a dial that fails.
- **Silence:** 5 s to the whole frame, 3 s once half the waiting places are taken (desk-rtc's full wait, so a member on a slow
  link isn't cut short by the host before the desk would cut it).
- **Places, per client network, as `desk-rtc`'s gate counts them** (`gate.go`): 48 a network, 64 a slot in all (384 on a 6-slot
  host); past a network's places its address holding the most gives up its oldest to an address holding two fewer; with all
  taken the network holding the most gives up its oldest to one holding two fewer; only as many networks as there are places,
  one place each, can keep a new one out. Handed connections: 192 a network and 192 a slot in all, refused past either.
- **Sandbox:** its own system user `desk-dmx`, `CAP_NET_BIND_SERVICE` and `CAP_NET_RAW` (`IP_TRANSPARENT`) and nothing else, no
  new privileges, systemd's sandbox (`ProtectSystem=strict`, `RestrictAddressFamilies=AF_INET`, `@system-service`, no access to
  the slot store, the slot records or `/run/desk-host`), `MemoryMax=256M`, and **its own seccomp filter on every thread**:
  `socket()` makes IPv4 TCP sockets only, so the raw capability can't open a raw or packet socket (`seccomp_linux.go`). Its
  unit starts only when `/run/desk-dmx/env` exists, which `desk-host-boot` writes under SlotMode=port alone.
- **Logs** a line at most once a minute, only when it turned something away: its counts by reason, never an address.

**The ruleset's part** (`/etc/nftables.conf`, the same file under both modes). `divert` (prerouting, mangle) marks a slot's TCP
443 replies that belong to a transparent socket of the host's, and `desk-host-boot` routes that mark to the host
(`ip rule fwmark 0x4430 lookup 4430`, `local default dev lo` there), so they meet the input chain, never forward. In input, a
desk's packets meet its slot's source check (`desk_src`) before the established accept, as in forward; `desk_dmx` (`dmxi_<k>`)
counts the slot's side of the demux's connections into `out_<k>`, and in output `desk_dmxo` (`dmxo_<k>`) counts the demux's side
into `rx_<k>`, each with a counter of its own too; `host_in`, after `desk_in`, holds the demux's one accept, TCP 443 on the
host's own address and interface, which `desk-host-boot` adds under SlotMode=port only. Under address these match nothing.
**The byte counters stay exact:** in the lab, over the demux, `out_<k>` was 0.985 of the slot's veth (`dmxi_<k>` 0.999 of it),
the same 14-byte-header ratio as UDP's 0.985.

**Service sandboxes' resolver (from the bake after 0.1.8, Bug 8):** `svc-spec.py` binds the template's `/etc/resolv.conf` (the desk's own: the VPC resolver) read-only over the empty one a release root ships, for `deskd`, `desk-agent` and `desk-notebook`; the three on the template already have it. `desk-host-check svc-dns` (30th check) reads each running sandbox's file and looks up the region's STS endpoint from inside `deskd`, `desk-rtc` and `desk-agent`; `desk-agent` must still get only the filter's placeholder or nothing (nftables redirects uid 1103's port 53 to `desk-agent-filter` whatever the file says). `verify.sh` and `verify-port.sh` break it in a running slot (the bind unmounted, as 0.1.8 had it) and put it back.

**Checks:** four more in `desk-host-check` (30): `slotmode` (the divert, the routing, the source check and the demux's count ahead of
the established accept in input, `host_in`'s one accept, the env; under address none of them), `addresses` (one interface, one
private and one public IPv4, nothing beyond, by the OS and IMDS), `demux` (its user, exactly the two capabilities, no new
privileges, its seccomp filter, the binary `bake.sh` built, alone on the host's own 443; under address not running and nothing on
443) and `ports` (each running slot's one UDP DNAT from the host's interface, no TCP, its UDP accept, its SNAT block inside
10,000 to 59,999 and no other slot's, the demux's mark on running slots only); `counters` and `inbound` also check the demux's
half. `verify-port.sh` (or `SLOT_MODE=port verify.sh`) proves a bake under B; `verify.sh` keeps proving A. Lab results:
`spikes/host-shared-address/README.md`.

**Restarts and the kill order (from the bake after 0.1.9, reliability audit S1 and S2; contract: `docs/interfaces/desk-runtime.md` section 11).** `desk-svc` waits longer before each restart in a row (`-restart-sec` toward `-restart-max-sec` 300 in `-restart-steps` 8; the count starts over after a `-healthy-sec` 120 run or a `start`), `desk-init` does the same for what it supervises, and neither gives up. `svc-spec.py` gives each sandbox's process 1 an `oomScoreAdj` (`deskd` and `desk-rtc` -500, `desk-notebook` -200, `desk-stream` +100, `desk-agent` +200, `desk-data` 0); `desk-host-link`, `desk-ice-demux` and `desk-host-shutdown` run at -900. `desk-host-check oom` (31st check) reads every running slot's processes and the host's own from `/proc`. `verify-backoff.sh <desk-svc>` runs the real binary as a plain supervisor over a job that exits at once (`verify.sh` and `verify-port.sh` section 4d/4e, with two mutants that must fail). `lab/restart-oom/host-overlay.sh` and `VERIFY_OVERLAY=<dir> verify-port.sh <earlier ami>` run an unbaked tree against an earlier AMI in the lab; never a release proof.

**deskd's Files tree (from the bake after 0.1.10, free walk H5).** Up to 0.1.10 a slot's `deskd` had only the volume's `/data/desk`
in its sandbox, whose `/data` is a 1 MB root-owned tmpfs, so it couldn't make `/data/files`, logged `the Files tree can't be used:
AccessDeniedException` at every start, and answered every `files.*` `unavailable` `{reason: "tree"}`: no shared desk had Files.
Now `svc-spec.py` gives `deskd` a placeholder at `/data/files` as at `/data/desk`, and `mounts.py` moves the volume's own `files`
directory (1100:1100 `0700`) over it the same way (`openat2` in the volume's root, no links, no crossings, `open_tree`). It's
`deskd`'s optional directory: missing, a link or a file there skips only that mount, never followed, and `deskd` starts with the
placeholder (Files unavailable that run; `mounts.json` says `skipped`). A blank volume gets it when it's formatted; the desk's own
`desk-init` makes it at every start and replaces a link there, so **a volume from before 0.1.11 has Files from its second start on
a 0.1.11 host** (the first makes the directory). `desk-host-check files` (the 33rd check, with TD-223's `shaper` the 32nd): each running slot's `deskd` has the
volume's directory there as 1100:1100 `0700` and hasn't logged that line since its last start; a skip is said, not failed.

## Updates (ADR 0077's member-host half, `sub/u77-host`; not baked yet)

A shared host's desks get Debian's and Chromium's security fixes from **template generations**, built once per host-image version on a
builder (`tools/template/`, `sub/u77-builder`), signed, and fetched by each host, which only checks and seals them; the host's own
packages get a daily security-only apt run and a reboot on Platform's order. Nothing changes under a running desk. The Security
Analyst reads the signing, the fetch and unpack, and the host's apt before a host image carries this.

**Generations** (`templates.py`, the command `desk-host-template`). `/srv/desk-host/templates/<gen>/` (`g1` is the bake's; `g<n>` per
host-image version), each bound read-only. Its `.complete`, written last: `gen=`, `chromium=` (its `chromium` package's version),
`manifest=` (the SHA-256 of `/var/lib/desk-host/templates/<gen>.json`, on the host's root) and `host-version=`.
`/var/lib/desk-host/templates/state.json`: `current`, `previous`, `candidate`, `halted`, `maxGen`. A slot's record names its generation
(`template`), and everything that read the template reads that one: the prepare's copy, the desk's firewall, `svc-spec.py`'s roots
and resolver for `desk-rtc`, `desk-stream` and `desk-data`, `preread.py` (a file changed from `g1`, `<gen>.changed`, is read whole),
`desk-host-check`. A host from a bake before this turns its `/srv/desk-host/template` into `g1` at the first boot of this code
(`desk-host-template boot`, from `desk-host-boot`; 130 s on the lab's fresh volume, hashing 2.3 GB once).

**The fetch** (Platform's `template_target`, PU-2; `templates.fetch`, in `desk-host-upd`), failing closed at each step with the step
named in the report's `fetch`: the store's admission (the new template and a prepare on top of every slot's quota room; a third
generation only with room for one more), `header.json` and `header.sig` to `/var/lib/desk-host/dl/<gen>/`, the signature over the
header's exact bytes against `/etc/desk-host/template-keys/*.pem` (exactly the recipe's pins, `template-keys.sha256`, which is the
committed anchor `recipe/template-keys.sha256`: `alias/ma-host-template`'s public half, `ma-host-template-2026-11.pem`; a host baked
before the anchor, 0.1.12 and earlier, pins no key and refuses every artifact; a TEST host also trusts
`/var/lib/desk-host/test/template-keys/`), the header's rules (format, this host image, a `gen` above every one this host has had,
the order's SHA-256, `g1`'s manifest as its base), the root's room, the manifest, plan and archive hashed as they arrive, a streamed
checked unpack (each member against the manifest, nothing outside the tree, no link climbing out of it, no device file, no set-id bit,
nothing written through a link, each file hashed as written), the walk (every path's type, mode, owner, size, hash, link target and
capability, none missing or extra), `desk-host-check template` on the tree, Chromium only forward, then the seal: `.complete` last, the
manifest on the host's root, renamed to `templates/<gen>`, bound read-only, `candidate` set, the download removed. No apt, no dpkg,
nothing from the artifact runs. The artifact's format: `docs/sub-status/u77-host.md`'s questions, which `docs/sub-status/u77-builder.md` follows too.

**Re-roots** (`desk-host reroot <k>`): a fresh tree from the generation section 2 picks, copied outside the slot's lock in
`desk-host-upd` (`desk-host-template copy-tree`, paced), the slot's `rel/` moved in once its tree hash is the store's, then under the
lock and only if the slot is still stopped with the same record: the record removed, the new tree swapped in, the record written, the
old root deleted. It runs in the background after every `desk-host stop` (never a `stop-all`) when the slot isn't on its generation;
a start of that slot takes the slot at once and the copy is dropped (`abort_reroot`). **The choice** (`templates.choose`): the current
generation, unless the profile's `Last Version` (`mounts.py peek`: read-only, `norecovery`, never attached, nothing mounted with a
journal to replay) is newer than its Chromium; then the slot's own (a rolled-back generation it already ran) or any newer one; none
new enough is `chromiumBehind`. An unreadable `Last Version` keeps the slot where it is. **Idle restarts** (the link): a desk that
doesn't stop, once its generation has been current 3 days (1 hour urgent), or at once for the candidate's trial, restarted only while
idle by its own `idle.json` (`idlerule.py`, desk-batch's rule, `downloads` 0): `reroot --prebuild` beside the running root, then
`desk-host restart` (the slot's lock, idle again, the stop that closes Chromium over CDP, the swap, a start on the same epoch), with
`update.holdUntil` 15 minutes ahead. **The candidate** (1.6): one slot at a time, by an idle restart (a stop's re-root takes it only
after an hour); its start checks (every sandbox running, the desk alive 120 s after its start: `desk-host-template trial-check`), then
Platform's `template_promote`; a failed start halts it, and the slot is prepared again from the current generation and started.
`template_rollback`: no new root from it; each slot on it goes back at its next stop only if its `Last Version` allows. A root
being built from a generation when it's halted isn't swapped in (the re-root drops it; a prepare fails and the next one takes the current).

**The host's own apt** (`desk-host-apt.timer`, daily, through `desk-host-template upd`): `apt-get update`, `unattended-upgrade` with
`51desk-host-unattended` (the security archive only, `Automatic-Reboot "false"`, `nftables` and `apparmor` blacklisted and held),
`policy-rc.d` exiting 101 for the whole run, then the host's quick checks; `/var/lib/desk-host/host-apt.json`. A new kernel or
`/run/reboot-required` is `rebootPending`, and nothing else applies until **`desk-host reboot`** (Platform's `reboot_host`): refused
unless a reboot is pending, no slot is starting, no hold is ahead and every running desk is idle (or the order is urgent and its
clock allows); then `desk-host-upd`'s work is dropped and `systemctl reboot` (the link stops, `stop-all` closes every desk, `resume`).

**`desk-host-upd`** (`/sys/fs/cgroup/desk-host-upd`, made at boot): `cpu.idle` 1, `cpu.max` one CPU, `memory.max` 192 MiB, `io.max` on
the store's disk and the root's at 0.1 of the EBS baseline's bytes and 300 IOPS each way (15.6 MB/s on an `m7g.xlarge`), frozen while a
pre-read runs. **Every writer in it is paced** (`templates.Pacer`): it waits for each 16 MiB to reach the disk. io.max throttles pages
already under writeback, which the memory cgroup can't reclaim, and the first lab fetch, unpaced, was OOM-killed at 176 MB.

**Checks** (four of the 39): `templates` (quick: every generation sealed and read-only, `state.json` consistent, at most two or three with room,
every record on a sealed generation, every template sandbox rooted in its slot's; full: each generation walked against its manifest,
a file whose ctime moved since the seal hashed again), `template-sig`, `update-cgroup`, `host-apt`; each broken in `verify.sh`'s and
`verify-port.sh`'s mutation pass, with a second break each. **The link** (PU-1, PU-2): the report's per-slot `template`, `chromium`,
`lastVersion`, `behind`, `chromiumBehind`, `update.holdUntil`, and the host's `templates`, `fetch`, `hostApt`; the orders
`template_target`, `template_promote`, `template_rollback`, `reboot_host`, each once per ID; the reply's kill switch
`updates: {fetches, restarts, reboots}`. Tests: `tests/test_templates.py` (25, no root), `tests/test_link.py`'s `LinkUpdatesTest` (11).
Lab: `image/lab/u77-host/` (never a release proof).

## Service batches (ADR 0078, `sub/host-batches`; not baked yet, goes into host 0.1.12)

A shared desk takes the **same signed batches** as a desk of its own (`docs/interfaces/desk-runtime.md` §6.1): `ma-desk-batch/1`,
signed by `alias/ma-desk-batch`, the same `seq`. The host applies the components it runs from its store (`deskd`, `desk-agent`,
`desk-notebook`, `desk-rtc`, `desk-stream`); a batch's `desk-agent-filter` that isn't the template's is `templatePending`, an `image`
is `imagePending` (each needs a host image), `desk-egress` and `commons-server` are ignored. The Security Analyst reads the live
switch (ADR 0078 2.2) and the fetch and unpack (1.3) before members get it; until then Platform sends `liveSwitches: false` and the
host defaults to it.

**The key** (`batchsig.py`, desk-batch's own checks copied; `image/tests/test_batch_parity.py` runs the same vectors through both):
`/etc/desk-host/batch-keys/` holds exactly the batch key's public half (the desk image's `ma-desk-batch-2026-11.pem`), pinned by name
and SHA-256 in `/usr/local/lib/desk-host/batch-keys.sha256`; no drop-in directory. A TEST host also trusts
`/var/lib/desk-host/test/batch-keys/`. `/etc/desk-host/batch-baseline` (`{"seq": N}`, from `bake.sh`'s `BATCH_BASELINE`; none, 0) is
the floor a host is born with.

**The fetch** (Platform's `batch_target`, `desk-host-batch fetch`, in `desk-host-upd`; 1.3), failing closed with the step in the
report's `batchFetch`: the manifest's signature over its exact bytes before anything reads it, desk-batch's field rules, the order's
`sha256`, the arch, the floor (the highest promoted, halted or refused-after-signing `seq`, the candidate's, the baseline: no replay),
what to fetch (a store component whose version isn't in the store; the same version from another artifact refuses the whole batch),
the root's room, each `.tgz` hashed as it arrives (`/var/lib/desk-host/dl/batch-<seq>/`), the store's room (3.5 times the download
and one copy in flight), `desk-host-release install --manifest` for each, in the host's copy turn, then the manifest and signature
kept at `/var/lib/desk-host/batch/<seq>.json` and `.sig`, the `candidate` links and `state.json`'s `candidate`.

**A slot moves** (`batches.plan`): the candidate on one slot first (the canary: a desk's, the first idle or stopped, never a fresh
root), everything else onto `current`; the changed components in the manifest's order. A slot's record names what its `rel/` holds
(`releases`), its `batch` (`{seq, state}`) and `rolledBack` (never tried there again).
- **Live, at idle** (`desk-host switch <k>`, in `desk-host-upd`, started by the link while `liveSwitches` is on): idle by its own
  `idle.json` (desk-batch's rule; `downloads` don't hold it, Chromium keeps running), `cpu.pressure` some avg10 at most 25%, no
  re-root or pre-read, and room in the desk's cgroup (128 MiB under `memory.max`, 32 tasks under `pids.max`, no lower cap pending: a
  sandbox that can't start leaves its service down until the rollback's own start). Each changed component copied into `rel/.new-<svc>` (paced, tree-hash checked, deskd's `version.env` from the
  slot's generation) outside the slot's lock, in the copy turn; a start or stop drops the copy. Idle again, `update.holdUntil` 15
  minutes ahead, the slot's lock; then per component: its sandbox stopped (TERM, then KILL after its wait), the record's `switching`
  written, `rel/<svc>` renamed to `.old-<svc>` and `.new-<svc>` into place, the sandbox made again exactly as `up` makes it
  (`svc-spec.py`, `runc create`, the namespace bind, **`mounts.py svc`**: that service's `/data` directory alone from a fresh
  `fsmount` of the slot's volume in a private namespace, resolved with `openat2`, moved in), `runc start`, the smoke test. Chromium
  and every other sandbox keep running.
- **The smoke test** (`smoke.py`, from the host's side; 3.2): for up to 90 s (180 on a `free` slot) its sandbox running and its
  service (desk-svc's child) the same PID for 20 s; `deskd` also a fresh `idle.json` of its own; `desk-rtc` its UDP port and TCP 443
  listener in the slot's network namespace (the host's `/proc/<pid>/net`); `desk-stream` its desk-svc waiting. Frozen time (a
  pre-read) isn't counted.
- **A failure** rolls back: the failed component, then the switched ones in reverse, each by renames and a new sandbox, each
  smoke-tested. The slot is `rolled-back`, the `seq` is refused there after, and the batch is **halted on the host**: no other slot
  starts it and a candidate is never promoted.
- **At a stop** (`desk-host relroot <k>`, while `liveSwitches` is off): the changed copies made beside the old ones, swapped in
  under the lock only while the slot is still stopped with the same record; the old copies stay. Its first run is the next start,
  smoke-tested beside it (`desk-host switch <k> --verify`, outside `desk-host-upd`); a failure rolls back as above, with the member
  there. A stop runs a generation re-root first if one is due (`desk-host after-stop`). Fresh roots are copied again after a promote.
- **Cut off** (3.4): a slot that stopped mid-switch is put back by renames before its next start (`batch_cutoff`); one still running
  resumes at its next `switch`, smoke-testing what's switched, then finishing or rolling back. `CRASH_AT=switch-copy|switch-swap|switch-start`.
- **Promote and halt** (3.3): Platform's `batch_promote` (taken once the canary passed its smoke test here; ordered earlier, it
  waits for it) moves `previous` to the old `current` and `current` to the candidate; `batch_halt` halts a batch found bad elsewhere.
  Going back is a rollback batch (a higher `seq` naming older versions), which `previous` serves with no download.

**The link** (PB-1, PB-2): the hello's `updates: {batches: 1}` and `batchBaseline`; per slot `batch` and `releases`; per host
`batches`, `batchFetch`, `templatePending`, `imagePending`; the orders `batch_target`, `batch_promote`, `batch_halt`, each once per
ID; the kill switches `updates.batches` (true unless turned off) and `updates.liveSwitches` (only true turns it on), written to
`/run/desk-host/link/updates.json`. A batch and a template download take turns. **Checks:** `batch-sig`, `svc-spec` (every running
sandbox's `config.json` field by field against `svc-spec.py` now, and its process's bounding set, no_new_privs, seccomp and AppArmor;
`desk-rtc` and `desk-stream` see the stream profile read-only), `releases` (rewritten) and `update-cgroup` (widened to the batch's
workers); 39 in all, each broken in both verify scripts' mutation passes. **Tests:** `tests/test_batches.py`,
`tests/test_link.py`'s `LinkBatchTest`, `image/tests/test_batch_parity.py`. **Lab:** `image/lab/host-batches/` (never a release proof);
results in `docs/sub-status/host-batches.md`.

## The host link (`desk-host-link`)

The host's one outbound link to Platform (ma-platform contract `shared-host.md` sections 3 to 5; ADR 0072 section 7 and
"Platform's side" P5), a root service after `desk-host-boot`, Python's standard library only:

- **`POST /v1/host/hello`** at every boot and whenever a report's reply says `hello_required`: the instance ID, the boot's
  ID, `desksPerHost` and `hostingVersion` (the first boot's). The reply names each slot's private and public address.
- **`POST /v1/host/report`** every `reportSeconds` and at once on a change (it polls `desk-host report` every 5 s). Orders
  ride the reply and each runs once per order ID, a failed one again after 60 s: `prepare_slot` → `desk-host prepare`
  (only when the slot's tag is empty at that epoch), `start_slot` → slot-session, the stand-in, then `desk-host up ...
  --class <the tag's> --public <the hello's>` (only when the tag names that desk at that epoch and its addresses are the hello's), `stop_slot`
  → `desk-host stop` (only when the slot runs that desk at that epoch), and `set_class {k, deskId, epoch, class}` (S-119, contract
  0.3.46, from the bake after 0.1.10) → `desk-host class <k> --whole`, the running container's class changed in place and never a
  restart. The link refuses it, changing nothing, when the host is stopping (`host_stopping`: stop-all's mark), the class isn't in
  `classes.conf` (`class_unknown`), the slot isn't that desk's at that epoch (`not_this_desk`), the slot isn't running yet
  (`slot_starting`: an order that arrives mid-start runs once the desk is up) or the tag doesn't say that class (`tag_mismatch`:
  Platform writes the tag first); `desk-host` refuses a raise past the host's units (`host_full`, exit 75). The contract has no
  error field for an order: the result is the report's `class`, unchanged on a refusal, so Platform sends the order again and the
  link tries it again after 60 s; the code is in the link's log. An order the report already shows done (a repeat, or after a
  restart of the link) runs nothing.
- **`POST /v1/host/slot-session`** for each running slot at its start and every `refreshAfterSeconds`. The answer goes to
  that slot's **metadata stand-in** (`standin.py`), on `10.98.<k>.1:9254`, answering `10.98.<k>.2` only: an IMDSv2 token,
  `instance-id` (the desk ID), `placement/region`, `public-ipv4`, the tags `DeskId`, `UserId`, `DeskKind`, `Env`, and the
  role's credentials; everything else is 404. Nothing it holds is written anywhere (`IN-03`).
- Every slot with no root is prepared in turn after a boot's first hello (`LINK_PREPARE_EMPTY`).
- SigV4 (`sigv4.py`, service `execute-api`) with the instance role's IMDS credentials. The API is the Env tag's
  `host-api.<suffix>` (never `api.`, which is behind CloudFront and hides the host's address from Platform's check):
  `LINK_API_staging` or `LINK_API_prod` in `desk-host.conf`. `LINK_API` points a test host at a fake Platform on the
  loopback, and only there.
- The region it signs for is the API's, never the instance's: `LINK_API_REGION_staging` and `LINK_API_REGION_prod`, both
  `us-east-1` (the `host-api.` names are REGIONAL API Gateway domains there only; `ma-platform` `terraform/shared_hosts.tf`).
  A host in us-west-2 that signed for its own region was refused, 403 signature (S-120). `LINK_API_REGION` overrides both with
  a test fake only; a test fake on a host with no Env tag is signed as staging's. `desk-host-check link` pins both values.
  The stand-in still answers `placement/region` with the instance's region: a desk sees the region it runs in.
- Backs off 5 s doubling to 5 minutes. Logs slot numbers, epochs, operations and HTTP statuses, never a desk ID, a member's
  ID or a credential; `desk-host`'s own output for each operation goes to `/var/log/desk-host/link-<k>.log`.

Tests with no root and no AWS: `python3 -I image/host/tests/test_link.py` (77 tests, about 140 s, the signing region on a us-west-2 instance included, ADR 0077's orders and kill switch included, SlotMode=port's hello, sessions and tags included, and `set_class`: done once in place, both ways, a repeated ID and a restarted link running nothing, each refusal, an order mid-start and during the link's own start); `python3 -I image/tests/test_host_slotmode.py` (SlotMode=port's checks on fake output, each broken and failing); `python3 -I image/tests/test_host_stop_all.py` (the real `desk-host`'s `stop-all`, `up` and `resume` as root in a user and mount namespace with a fake `runc`: a start in flight is stopped, not left; skipped where unprivileged user namespaces are off); `python3 -I image/tests/test_host_files_slot.py` (H5: `mounts.py`'s optional `files` for `deskd`, missing, a link or a file skipped and never followed, `deskd` still started; the placeholder in `deskd`'s spec only; `desk-init` making `/data/files` and replacing a link; the `files` check on fake slots); `python3 -I image/tests/test_host_slot_links.py` (`slot-datadirs`: the slot's `desk-init` never acts on a name inside a desk user's folder: a link at `/data/browser/home`, deskd's `volume.json`, `units.sock` swapped for a link after its bind, desk-snd's `/run/desk-audio/pulse` raced, a FIFO or a link at the profile's `Preferences`; each fails on 0.1.11.1's `desk-init` with `DESK_INIT=`; its `AsRoot` cases, real users, `chown` and `setpriv`, run as root in a throwaway container with `SLOT_LINKS_ROOT=1`); `python3 -I image/tests/test_host_class_whole.py` (the real `desk-host class --whole` the same way, on a free desk's cgroup as files: no room changes nothing and exits 75, plain `class` still applies CPU and waits, a stopping host changes nothing, with room it's the class in place); `cd image/host/desk-ice-demux && go test -race ./...`: SigV4 against AWS's and
deskd's vectors, the tag's parse (its class against `classes.conf`), the report's states and counters, SlotsPerHost, and the link against `tests/fake_platform.py` (the three routes,
every signature checked) and `tests/fake_desk_host.py`.

## The release store

`/srv/desk-host/releases/<component>/<version>/`, for `deskd`, `desk-agent`, `desk-notebook`, `desk-rtc` and `desk-stream`, filled only
from artifacts whose SHA-256 the host trusts. **At the bake:** `desk-host-release install <component>-<version>.tgz` takes the hash
`/etc/desk-host/releases.pin` pins (the desk image's rule) and makes it `current`. **From a batch** (ADR 0078, below in "Service
batches"): `desk-host-release install --manifest <m> --signature <s> <tgz>` checks the batch's signature again against
`/etc/desk-host/batch-keys/` and takes the manifest's hash, and moves no link. A version already in the store from another artifact is
refused (exit 3) and never replaced; the same artifact again is left as it is. deskd, desk-agent and desk-notebook ship a Docker image:
the host has no Docker, so it unpacks the layers itself, **streamed** (ADR 0078 finding 1): the `.tgz` is read once as a stream, its
`image.tar` goes to the host's root beside the download (never the store), then each layer is read in 1 MiB pieces, its whiteouts
applied in a pass of its headers first, hashed as it's extracted against its own digest, every write paced for `desk-host-upd`'s
`io.max`; no layer is ever held whole. Each member goes through tarfile's `tar` filter (nothing outside the root, no set-id bits, no
device files); the image ID is the config blob's digest. **Every file and directory keeps its member's time** (`sub/host-up-norecord`): deskd's
and desk-agent's AppCDS archives (`/app/<name>.jsa`) record each app jar's size and time, and the JVM drops an archive whose jars differ,
saying nothing; the streamed unpack of 0.1.12 to 0.1.15 wrote every file at its unpack time, so both JVMs started without their archives
and a cold wake's hello came 7 to 12 s later (`docs/sub-status/host-up-norecord.md`; `verify.sh` section 9 checks the maps). desk-rtc and
desk-stream are kept as shipped. A release lands under a new name and is renamed into place. Each keeps `artifact.sha256` and
`tree.sha256` (no times in it).

**Links** (1.4): `current` (what every prepare and re-root copies, what the host has promoted), `previous` (the one before, kept so a
rollback batch needs no download) and `candidate` (installed, not yet promoted). A version is deleted only when no link, no slot's
record and no switch in flight names it (`desk-host-batch gc`). `desk-host-release verify` and `desk-host-check releases` follow the
host's batch state (`/var/lib/desk-host/batch/state.json`), or `releases.pin` until a batch is promoted; the store no longer has to
equal the template's `/opt/ma` (ADR 0078 finding 3). `prepare` copies `current` into each slot's `rel/` and its record names those
versions (`releases`); nothing a desk writes is read.

**Desk image 0.3.5 in a slot (`sub/host-parity-035`, from host 0.1.15).** A slot's root is the template, so it has 0.3.5's files, but no systemd runs there: what 0.3.5 does in a unit, the slot does its own way.
- **Links out** (runtime spec 8.11): `/run/desk-links` is one of the slot's `/run` shares (`wallspec.py`), `desk:kiosk` 2750 as the template's tmpfiles line says, made by the host on the slot's fresh tmpfs before any desk process and bound into the desk (where Chromium's `xdg-open` stand-in runs as `kiosk`, first on its `PATH`) and into `deskd`'s sandbox alone, where `deskd` binds `links.sock`. Up to 0.1.14 a slot had neither, so the stand-in exited 3 and links out did nothing.
- **The Browser's policy:** `desk-init` runs the template's `desk-browser-policy` as the desk's root (under the unit filter, as every helper) before every start of Chromium, crash restarts included, as `desk-browser.service`'s `ExecStartPre=+` does: a teen's lock, or an adult's allowlist of the three password managers (`ma-adult.json` only for exactly `adult\n` in `deskd`'s `/data/desk/age-band`), its lines in the desk's `/data/logs/desk-browser.log`. A helper that exits 1, can't run or takes over 30 s is no start (`units.sock` answers the error), and the start is tried again after the Browser's back-off (3 s to 30 s), as the unit's `Restart=` does, so a lock that can go on later clears by itself. Up to 0.1.14 a slot never ran it: a teen's slot had no lock and an adult's no allowlist.
- **JPEG XL off** comes with the template: the launcher runs the template's `desk-browser-start`, which has `--disable-features=JXLImageFormat`. **OpenRouter** in the Agent's egress too (`/etc/ma/agent-egress.conf`, read by the slot's own `desk-agent-filter`).
- **Not done here:** `desk-adblock render` (the unit's other `ExecStartPre`, the ad blocker's per-site off list, ADR 0076) doesn't run before a slot's Chromium starts, and `desk-adblock` isn't a unit `units.sock` takes in a slot, so a member's per-site switch doesn't apply on a shared host. The blocker itself is on there (the template's `ma-adblock.json`, rendered at bake with no list). From desk image 0.3.1, not 0.3.5; for a later host change.

## Verify

`verify.sh` boots on `m7g.xlarge` as Platform would under `PF-03` (the host's own interface and the slots', two slot
addresses) with the tags and launch settings above; the account's Elastic IP quota leaves it one, so the host's own
address is the launch's public one, the slots' interface is attached after boot, and the Elastic IP is slot 1's, then
slot 2's. Then: boot (time to SSH,
`systemd-analyze`, generic kernel, ENA, NVMe, IMDSv2 one hop with tags, no keys or SSH at boot); a fake Platform on the
host's loopback (`tests/fake_platform.py`) with the link pointed at it; every `desk-host-check` check (25); `WR2-02` on the
host (TIOCSETD refused, `/proc/modules` unchanged); **the link**: two desks placed by `DeskSlot` tags and started by
`start_slot` orders; from inside each slot, its stand-in answers its own desk only and nothing reaches the real IMDS or a
neighbour's stand-in; a slot leaves from the Elastic IP on its own address, and from nowhere once it's moved (`PF-01`); the host counts a slot's 4 MiB out (`IN-09`);
from outside, the host's own address answers nothing (`PF-03`); the wall's settings on a desk; `stop_slot` stops one slot
only; a slot whose Elastic IP is taken off its address stays down (`PF-01`); **the size classes**, by hand with the link
stopped (a desk started `free`, changed to `standard` in place with every process kept, back, a raise past the host's units
waiting with 75 (CPU and pids at once, memory and disk kept) and finishing once there's room, a stop leaving nothing);
**the byte counters** (a download's bytes in and its ACKs out against the slot's veth, `bytesIn` in the report and
`net.json`); and the **mutation pass**: each of the 25 checks is broken on purpose and must FAIL, then put back and must
PASS. Evidence: `evidence/verify-<ami>.txt`, addresses replaced. From the bake after 0.1.6 it runs 29 checks, SlotMode=port's four
included (under address they say there's no demux and nothing on the host's 443), each broken in the mutation pass. From the bake
after 0.1.10 both runs also prove each slot's outbound shaper (section 4f: the classes on slot 1's veth at 60, 2 and 100 Mbit, the
desk's own traffic counted in 1:15, the report's view, its unit and state; `desk-host shaper 1 off` fails the check and `on` passes
it), and the mutation pass breaks `shaper` by deleting slot 1's qdisc with its `desk-host-egress@1` frozen.

**The template key's trust anchor, section 2b** (both scripts, `verify-template-anchor.sh` on the host; from the bake after 0.1.13):
the host's `/usr/local/lib/desk-host/template-keys.sha256` must be the workstation's committed `recipe/template-keys.sha256` byte for
byte and `/etc/desk-host/template-keys/` exactly its keys. Its mutation is the substitution the anchor exists for: the key replaced by
another P-256 key and the pin rewritten to match, which `template-sig` alone passes (it compares the directory with the host's own pin);
the anchor check must fail it, and pass again once both are put back. Against an older AMI: 0.1.12 fails it (it pins no key, so it
takes no template generation); 0.1.11, 0.1.11.1 and earlier have no template path (no `desk-host-template`) and it's reported as `SKIP`, neither
a pass nor a fail.

**ADR 0078's section 4g** (both scripts, `verify-batches.sh` on the host): a test batch made on the host from its own `desk-rtc` and signed with a throwaway key trusted as a TEST key for that step only: the fetch installs a candidate and touches nothing else; no signature, another key, a template header, a seq at the floor and another format are refused before any download; one byte changed is refused as it's downloaded and the same version from another artifact is refused; no room refuses before writing. Each with its mutation (`DESK_HOST_BATCH_MUT`: `into-current`, `no-sig`, `no-floor`, `no-hash`, `no-room`, a TEST host's only) failing its step. The mutation pass breaks `batch-sig`, `svc-spec` (a sandbox remade by the switch's own steps with a capability added, `desk-host resandbox` on a TEST host), `releases` (a slot's copy and its record) and `update-cgroup` (a copy outside `desk-host-upd`) too.

`verify-port.sh` boots the AMI under SlotMode=port (one interface, its own public IPv4, no Elastic IP, `SlotMode=port`,
`SlotsPerHost` 6) and proves: the boot with the demux running; the link's hello naming each slot's `udpPort`; every check (33 from the bake after 0.1.10, `shaper` and `files` included);
the slot tag's `-` fields parsing under port only and an address tag under address only, on the host; a desk placed by
`DeskSlot1 = <desk>/<vol>/-/-/1` and started by `start_slot`, its `desk-rtc` on UDP 4431 and TCP 443 inside the slot; out from
the host's own address within the slot's port block; from outside, UDP 4431 DNATed to slot 1 alone and 4432 (no desk) nowhere,
nothing on ping, TCP 4431 or the stand-in's port; on 443 HTTP, TLS, a ufrag with no slot and a stopped slot's request closed at
once, silence and half a header within the wait, slot 1's request handed to slot 1 alone from this workstation's own address
(conntrack) and counted both ways; a stop taking the slot out of the demux; the counters over the SNAT path; a host stop
(`desk-host-shutdown`'s stop) while a start is in flight, leaving no desk and nothing of the slot, a start after it refused until
the unit starts again (from the bake after 0.1.7); **`set_class`** through the link on slot 1 while it runs (from the bake after
0.1.10, S-119; `tests/set_class_lab.py`): the Browser started as deskd starts it and a page's cookie set in it, then down to
`free`, the link's own refusals (an unknown class, another desk's order), a raise past the host's units and a stopping host
refused with nothing changed (the link's order and `desk-host class --whole` by hand), free to standard and back, each in place
(the class's cgroup values, `class-applied`, every process from before still there but Chromium's own children, no OOM kill,
deskd's JVM, Chromium's browser process and both containers' start the same, the cookie sent back by a new tab), and its mutation: `set_class` out of the link's `OPS`,
the upgrade ignored and the check failing, put back and passing; and the mutation pass, SlotMode=port's own breaks included, its `cgroup`
break after a host stop of the link and `desk-host-shutdown` in one transaction. From the bake after 0.1.10 both `verify.sh` and
`verify-port.sh` run `files` with a slot up (after `deskd` says it's ready) and break it in the mutation pass with 0.1.10's state, a
root-owned mode 000 tmpfs over `deskd`'s `/data/files`. Evidence: `evidence/verify-port-<ami>.txt`.

**Section 7, `slot-datadirs`** (both scripts, `verify-links.sh` on the host, last; from main's first host bake with this change, and 0.1.11.2 on the 0.1.11 line): slot 1 started by hand, the desk's root makes `/data/.verify-links` (0755) and the Browser's user (`kiosk`) puts a link to it at `/data/browser/home` (through the slot's host-owned mount namespace bind, as the desk's own uids: a test host's tools, never a member's desk); after a restart the target must still be the desk's root's 0755, `home` still the link, `desk-init` must say it couldn't make `home` as `kiosk`, and `units.sock` must be `desk:desk` 0600. Its mutation: the same start with 0.1.11.1's `desk-init` (from git, `OLD_INIT_REF` in each script) must fail it (the target handed to `kiosk`, 0700), and the real one, put back, passes again. Each run leaves slot 1 stopped and its `home` as it was.

**Section 8, desk image 0.3.5 in a slot** (both scripts, `verify-parity.sh` on the host, after section 7; from host 0.1.15): slot 1 started by hand, and through its host-owned mount namespace bind as the desk's own uids: **links out** (the share `desk:kiosk` 2750, `deskd`'s `links.sock` there as `kiosk`'s group 0660, the stand-in run as `kiosk` with a `tel:` link answered `dropped nobody` by `deskd`, which counts it in `/health`'s `browser.links`), **the policy** (Chromium started through `units.sock` as `deskd`'s uid with the band `teen`, `adult` and `Adult`: the lock, the template's bytes and the slot root's 0644, for teen and a band that isn't one, the allowlist and no lock for adult, each helper's line in the Browser's log; the template's lock made group-writable: the start refused, no Chromium, `LOCK NOT IN PLACE` logged, then put right and Chromium brought up by the start's own retry with the lock) and **`jxl`** (the running Chromium is the launcher's child, its last `--disable-features` naming `JXLImageFormat`). Its mutations: 0.1.14's `desk-init.py`, `wallspec.py` and `svc-spec.py` (from git, `OLD_PARITY_REF`) for one start must fail links out and the policy; the slot's own `desk-browser-start` without the switch must fail `jxl`; the real ones, put back, pass all three. Each run leaves slot 1 stopped, no band file, the policy files as they were and the script unchanged.

## Files

`bake.sh`, `verify.sh`, `verify-port.sh` (and the steps they run on the host: `verify-batches.sh`, `verify-wave.sh`, `verify-links.sh`,
`verify-parity.sh`, `verify-template-anchor.sh`), `recipe/build.sh`, `recipe/template-keys.sha256` (the template key's committed trust anchor) and
`recipe/template-key-check` (its check, `image/tests/test_host_template_anchor.py`), `recipe/files/` (the host's own), `desk-svc/` (process 1 of each sandbox, Go),
`desk-ice-demux/` (SlotMode=port's TCP 443, Go), `tests/` (the link's tests and fakes, and `demuxprobe.py`, one ordinary
connection to a host's 443; never on an image).
The proofs of the wall on this image and the six-desk measurements: `spikes/shared-host-wall-3/`.
