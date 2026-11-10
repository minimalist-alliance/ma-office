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
   pinned Go (`-trimpath`, no build ID: the same bytes for the same source).
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
   - installs the host's files (`recipe/files/`): `desk-host` and its helpers, the host's own ruleset, sysctls, the boot and
     shutdown units, `desk-host.conf`;
   - blacklists 64 protocol modules and every tty line discipline the kernel ships (`install <m> /bin/false`), and sets
     `dev.tty.ldisc_autoload=0` (`RC-02`, `WR2-02`);
   - reserves every slot's uid range (`desk-slot-1` to `-29` in `/etc/subuid` and `/etc/subgid`, nothing else in them);
   - cleans as the desk recipe's last step does, then checks what needs no boot.
5. Snapshots both volumes into one AMI named `ma-desk-test-host-<version>` (so `image/prune.sh delete <ami>` removes a
   test bake; a release would be `ma-shared-host-<version>` with `HOST_AMI_PREFIX`), tagged `HostKind=shared`,
   `HostKernel`, `ChromiumVersion`, `DeskTeenLock=1` and the baked releases, as a desk image is.

`verify.sh <ami> [m7g.xlarge]` boots the AMI as Platform would and proves it (see "Verify"). Run it on every bake.

## What's on a host

| Path | What |
|---|---|
| `/` (16 GB) | Debian 13, the generic arm64 kernel, `runc` 1.5.2, the host's ruleset, `desk-host`. No Docker, no desk unit, no SSH |
| `/var/lib/desk-host/swap` | The 8 GB swap file zswap sits in front of, made at the first boot; never written (every desk has writeback 0) |
| `/srv/desk-host` | The slot store (the AMI's second volume): `template/` (read-only bind), `releases/`, `slots/<k>/{rootfs,rel,svc}` |
| `/usr/local/lib/desk-host` | `desk-host` and its helpers, `desk-host-link` (the host's link to Platform, below); `desk/` is mounted read-only at `/desk-host` in every desk (desk-init, desk-svc, desk-units) |
| `/etc/desk-host` | `desk-host.conf`, `classes.conf` (the size classes), `releases.pin` (the desk recipe's), `store.uuid` |
| `/var/lib/desk-host` | Slot records, `hosting.json` (DesksPerHost, SlotsPerHost and HostingVersion from the first boot's tags), the store's serial |
| `/run/desk-host` | Per slot: what the host gives a desk (read-only in it: `slot.json`, `net.json`, `class.json`), the namespace binds, the `/run` shares' tmpfs, the locks; for the report, each slot's operation marker, fault, start record and counter epoch (`op/`, `fault/`, `slotstate/`, `net/`) |

At boot `desk-host-boot.service` turns on zswap (`lz4`, `zsmalloc`, 50% of RAM, no shrinker), the swap file, the slot
store (found by its baked UUID and, after the first boot, its NVMe serial; grown to the volume's size), the template's
read-only bind, the desks' cgroup (`+cpu +memory +pids +io`) and conntrack's size, and reads the hosting tags.
`desk-host-shutdown.service` stops every desk as a stop does when the host goes down (`IN-09`). `desk-host-link.service`
starts after it and stops before it (below).

## `desk-host`

| Command | What |
|---|---|
| `prepare <k>` | A fresh root for slot k: the template copied, shifted to the slot's uid range, under a project quota, with the services' releases copied from the store; record `fresh`. Refuses a slot whose desk is still there |
| `up <k> <deskId> [<vol>] [<class> \| --class <class>] --public <address>` | Start a desk. `DeskSlot<k>` (below) must name it, and the volume if given; the slot's address is the tag's `privateIp` on whichever interface carries it, and IMDS must associate `<address>` (the slot's public address, from the link's hello) with it, else the slot stays down and the report says why (`slotnet.py`). The class is the tag's unless given (no class is `standard`). Then the host's quick checks, the record (wake, claim a fresh root, or prepare again), the pre-read, the class's cgroup limits once admitted (exit 75 if the host is full), the per-slot AppArmor profile, `runc create` of the desk and its six sandboxes, the volume by `mounts.py`, the network from the host (the slot's own routing table when its interface isn't the default route's, the stand-in's DNAT, the byte counters from 0), `runc start` |
| `report` | The slot report the link carries (`report.py`): per slot `k`, `state` (`empty`, `prepared`, `starting`, `running`, `stopping`, `stopped`, `unmounted`), `deskId`, `epoch`, `net.bytesOut` and `net.bytesIn`, and `fault` when the slot was kept down; the host's `conntrack`. The same two counts go to the desk's `/run/desk-host/net.json` (`bytesOut`, `bytesIn`, `boot`). See "What the byte counters count". No `class` yet: a report with one gets `set_class` orders, which the link doesn't run |
| `class <k> [<class>]` | A running desk's size class, changed in place (an upgrade in place): its cgroup rewritten, nothing restarted or entered. From the tag if not given. CPU weight, pids and the memory rule at once; a raise of memory and disk is admitted as a start is, and waits (75) while the host is full, finished by running `class` again; a lower memory cap the desk doesn't fit yet waits for its next start |
| `stop <k>` / `stop-all` | `runc kill TERM`: deskd's sandbox, then the desk (its init thaws and closes Chromium over CDP, then SIGTERM), then the rest; then every per-slot state outside the root is reset |
| `reset`, `leftovers`, `state`, `ctlimit`, `check` | Recovery, connection limits, the host's checks |

One prepare, start, stop or class change per slot at a time: each takes the slot's lock (`/run/desk-host/lock/<k>`). Admission
(a start's or a class change's limits) takes the host's one lock (`/run/desk-host/lock/admit`) around its check and its write.

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

**A wake reads from the host's side first.** `desk-host up` starts `preread.py` beside the rest of its start: it reads the files and
byte ranges in `/etc/desk-host/preread.list` (what a cold wake read, made from a trace) from the slot's root and the host-owned release
copies, so the pages are in the host's page cache and charged to no desk. It runs in its own cgroup, `desk-host-pre`, beside `desk-host`,
with `io.max` at `PREREAD_SHARE` (0.2) of the instance's EBS baseline: the desks' caps sum to at most 0.8 of it, so the host's read
fits in the rest. The start waits for the list's first part (up to the `---` line); the rest is read beside the running desk, still
capped. `PREREAD=off` in `desk-host.conf` turns it off. It reads regular files only, resolved inside the root or the release copies.

**Size classes** (ADR 0072 section 16, "Container sizes by tier"; `classes.conf`, `classes.py`). A tier picks a class through
Platform's `DeskSlot<k>` tag (its optional 6th field, any name `classes.conf` has; none means `standard`), and the class multiplies each value above but the
connection limits and the quota: `cpu` (`cpu.weight`; 0 is `cpu.idle`, CPU only when no other desk wants it), `memory` (`memory.max`), `swap` and `zswap` (the memory rule; writeback
stays 0), `disk` (`io.max`), `pids` and `egress` (ADR 0036's rates, in the desk's `/run/desk-host/class.json`, for the
per-container shaper, which isn't built). `standard` is all 1s, so a host and tags without classes behave exactly as 0.1.4.
`DesksPerHost` stays the host's size in standard desks (the hello's `desksPerHost`); `SlotsPerHost` (a launch tag, contract 0.3.46
draft; DesksPerHost to 29, default DesksPerHost) is how many slots it has (`DeskSlot1` to `DeskSlot<SlotsPerHost>`, in the report and the
link's orders). A start or a raise is admitted only while the running desks' `memory.max` and disk
shares, read from their cgroups, fit `DesksPerHost` standard desks', so memory is never overcommitted between running desks and
no desk's peak reaches another's. The measured `free` row and the capacity table: `spikes/host-size-classes/README.md`.

**The slot tag** (ma-platform contract `shared-host.md` section 2, `PF-01`): `DeskSlot<k>` =
`<deskId|->/<volumeId|->/<privateIp>/<allocationId>/<epoch>[/<class>]`, written by Platform's placer, read through IMDS and
parsed strictly with Platform's own patterns (`hostmeta.py`): anything else means nothing. The optional sixth field is the
slot's size class, a name `classes.conf` has (`standard` or `free` today; missing means standard), so a new class needs only that
table; the link passes it to `desk-host up`. `desk-host class <k>` with no class still reads the tag with `classes.py tag`, which isn't
strict: it must read it as `up` does before the link runs any `set_class` (see `docs/sub-status/host-link.md`). A slot is mapped by the tag's address,
never by order. Under `PF-03` a host has two interfaces, its own (device 0, no inbound rule) and the slots' (device 1).

**The host's ruleset, per slot:** a desk's packets meet its slot's source check before any flow is let through
(`src_<k>`, from the `forward` chain's `desk_src`: a source other than `10.98.<k>.2` is dropped, `IN-09`), and only then counted
(`desk_est`, above); nothing new reaches the host's own address, ping included (`PF-03`); TCP 80 to `169.254.169.254` from the slot's
own address is DNATed to its stand-in, and everything else to that address dropped (`IN-03`, `IN-04`).

## The host link (`desk-host-link`)

The host's one outbound link to Platform (ma-platform contract `shared-host.md` sections 3 to 5; ADR 0072 section 7 and
"Platform's side" P5), a root service after `desk-host-boot`, Python's standard library only:

- **`POST /v1/host/hello`** at every boot and whenever a report's reply says `hello_required`: the instance ID, the boot's
  ID, `desksPerHost` and `hostingVersion` (the first boot's). The reply names each slot's private and public address.
- **`POST /v1/host/report`** every `reportSeconds` and at once on a change (it polls `desk-host report` every 5 s). Orders
  ride the reply and each runs once per order ID, a failed one again after 60 s: `prepare_slot` → `desk-host prepare`
  (only when the slot's tag is empty at that epoch), `start_slot` → slot-session, the stand-in, then `desk-host up ...
  --class <the tag's> --public <the hello's>` (only when the tag names that desk at that epoch and its addresses are the hello's), `stop_slot`
  → `desk-host stop` (only when the slot runs that desk at that epoch).
- **`POST /v1/host/slot-session`** for each running slot at its start and every `refreshAfterSeconds`. The answer goes to
  that slot's **metadata stand-in** (`standin.py`), on `10.98.<k>.1:9254`, answering `10.98.<k>.2` only: an IMDSv2 token,
  `instance-id` (the desk ID), `placement/region`, `public-ipv4`, the tags `DeskId`, `UserId`, `DeskKind`, `Env`, and the
  role's credentials; everything else is 404. Nothing it holds is written anywhere (`IN-03`).
- Every slot with no root is prepared in turn after a boot's first hello (`LINK_PREPARE_EMPTY`).
- SigV4 (`sigv4.py`, service `execute-api`) with the instance role's IMDS credentials. The API is the Env tag's
  `host-api.<suffix>` (never `api.`, which is behind CloudFront and hides the host's address from Platform's check):
  `LINK_API_staging` or `LINK_API_prod` in `desk-host.conf`. `LINK_API` points a test host at a fake Platform on the
  loopback, and only there.
- Backs off 5 s doubling to 5 minutes. Logs slot numbers, epochs, operations and HTTP statuses, never a desk ID, a member's
  ID or a credential; `desk-host`'s own output for each operation goes to `/var/log/desk-host/link-<k>.log`.

Tests with no root and no AWS: `python3 -I image/host/tests/test_link.py` (34 tests, about 40 s): SigV4 against AWS's and
deskd's vectors, the tag's parse (its class against `classes.conf`), the report's states and counters, SlotsPerHost, and the link against `tests/fake_platform.py` (the three routes,
every signature checked) and `tests/fake_desk_host.py`.

## The release store

`desk-host-release install <component>-<version>.tgz` takes an artifact only if its SHA-256 is the one
`/etc/desk-host/releases.pin` pins for that component and version (the desk image's rule). deskd, desk-agent and
desk-notebook ship a Docker image: the host has no Docker, so it unpacks the layers itself, each checked against its own
digest, with whiteouts, through tarfile's `tar` filter; the image ID is the config blob's digest, which must equal the
template's (`desk-host-check releases`). desk-rtc and desk-stream are kept as shipped. A release lands under a new name and
is renamed into place; `current` is swapped by rename. `verify` recomputes each release's tree hash. `prepare` copies
`current` into each slot; nothing a desk writes is read. A host takes a new release only with a new pin: the next image,
or a pin Platform delivers (not built).

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
PASS. Evidence: `evidence/verify-<ami>.txt`, addresses replaced.

## Files

`bake.sh`, `verify.sh`, `recipe/build.sh`, `recipe/files/` (the host's own), `desk-svc/` (process 1 of each sandbox, Go),
`tests/` (the link's tests and fakes; never on an image).
The proofs of the wall on this image and the six-desk measurements: `spikes/shared-host-wall-3/`.
