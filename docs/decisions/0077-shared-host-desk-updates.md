# 0077. Shared-host desks take Debian's security updates from template generations built once and fetched, signed, by each host

**Status:** Proposed. The System Engineer's design; nothing is built. It closes the gap in ADR 0072 section 13 and the last item of `draft-desk-app-contract.md` 13.9 for Debian's packages, Chromium's included, on shared hosts. Section 6 lists what it asks of the Platform Engineer, none of it agreed yet. The Security Analyst reads three things before any of it is built: the artifact's signing (1.2), the member host's fetch and unpack (1.4), and the host's own apt (section 3). Shared hosts may take members before it's built (Platform's prod start, Nov 13): a host's template is as new as its bake, and until this is built a security fix for Chromium, the kernel or `runc` reaches shared desks by option A, a new host image and a drain, so it has to be built before the first such fix needs it (about one to two weeks; an estimate). **Revised 2026-11-10, at the coordinator's request:** each generation is built once, centrally, on a builder, and a member host only fetches a signed artifact and checks it. The first draft had every member host run apt (option B, section 1).
**Date:** 2026-11-10

## Context
The owner, 2026-11-06, on updates to members' desks (S-96): "I want to make sure that this gets done so that updates to real users desks are infrequent because we don't want to frustrate the founding users and never grow". The bar is rare updates that never interrupt (contract 13.1, 13.2).

**A desk on its own EC2** takes Debian's updates itself. `desk-batch`'s `tick` runs `apt-get update`, `unattended-upgrade` and `apt-get clean`:
- at `nice 19` in the idle I/O class, once a day at most;
- only while idle, or after 72 hours with no idle;
- from `trixie-security` only (`51ma-unattended`; runtime spec §6.1).

A replaced Chromium waits for its next start (`chromium.pending`) and a new kernel for a reboot (`reboot.pending`), and nothing reboots. On a lab box the first run installed a kernel, apt and vim in 19.9 s (`docs/sub-status/desk-batch.md`).

**A desk in a slot can't, and nothing does it for it today.** This comes from reading the code, not from a run:
- `desk-init` runs no `desk-batch` and no apt. Its units are the display, the sound, the Agent filter and its resolver, and the six sandboxes. ADR 0072 section 2 lists `unattended-upgrades` in a container as new, and section 13 says "never run inside the wall".
- The desks have no apt egress inside the wall as built (`docs/sub-status/host-proofs-1109.md`: `fio` had to be copied in).
- A root's writes are capped at 2.08 MB/s on `standard` and 0.42 MB/s on `free`, and the cap stays. Apt of a 105 MB package took 274 s on a standard desk; on a free desk it would take about 10 minutes (`spikes/host-wake-counters/README.md` section 4).
- A slot's root is a copy of the host's template, made at `prepare` (a tar of it, `shift.py`, a project quota) and kept through its desk's wakes. So it is only as new as the template, and the template is only as new as the host image's bake.
- `desk-rtc`'s, `desk-stream`'s and `desk-data`'s sandboxes run on the template itself, read-only (`svc-spec.py`), so its libraries are theirs too.
- **The host takes no updates either.** Its root is the desk recipe's builder turned into the host. The desk recipe masks `apt-daily.timer` and `apt-daily-upgrade.timer`, and `desk-batch` and `51ma-unattended` leave with the desk recipe's files (`image/host/recipe/build.sh`).

So a shared-host desk gets OS and Chromium fixes only when the host image is rebuilt and the desk is moved (ADR 0072 sections 12 and 13; Platform's mover isn't built). The kernel, which is the wall, gets its fixes the same way. Contract 13.1 says "Chromium fixes can't wait a month". Members can't share hosts until this is answered.

**Numbers used below** (measured unless marked as an estimate):
- **The slot store.** The template is 2.3 GB and the release store 1.0 GB. Each slot has a 2.3 GB root copy (quota 3.3 GB) and 1.0 GB of release copies. The store is sized ⌈(6.7 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB, 36 GB at 6 slots. That leaves about 8% free at full quota with one prepare in flight (`docs/sub-status/shared-host-wall-3.md`, `host-size-classes.md`). The host's own 16 GB root had 9.6 GB used, the 8 GB swap file included (same source).
- **A prepare:** 21 to 24 s on a quiet `c7g.xlarge` and 44 to 49 s beside running desks (a 3.0 GB root then; `spikes/shared-host-wall/README.md`). 50 to 55 s for a freshly launched host's first prepare (3 `verify.sh` runs, `image/host/evidence/`). 11 s warm, 80 s with the page cache dropped, and 6.5 minutes for a fresh host's first copy while its volume loads (`image/host/RELEASES.md`, 0.1.8).
- **Disk shares** on an `m7g.xlarge` at 6 desks (EBS baseline 156.25 MB/s and 6,000 IOPS): the desks' `io.max` caps sum to 0.8 of it, and the six roots' 2,400 IOPS sit inside the slot store's 3,000. The pre-read's cgroup takes 0.2: 31.25 MB/s, measured 31.23 (ADR 0072 sections 3 and 10; `host-wake-counters`).
- **A cold wake with the pre-read:** a standard desk's hello in 19.1 to 19.4 s and its Browser in 34.9 to 35.8 s; a free desk's in 23.5 to 23.8 s and 42.1 to 42.3 s (3 samples each; ADR 0072 section 10).
- **A stop with Chromium running:** 4 s, `quit=cdp`, `exit_type Normal`, with a cookie set 8 s before kept (`RC-05`, run 2). The worst case is 31 s for CDP, then 30 s after SIGTERM.
- **A host's first boot:** 30 to 51 s to systemd's "Startup finished" (10 `verify.sh` boots, `image/host/evidence/`). A reboot isn't measured.
- **A host bake and its `verify.sh`:** about 40 minutes each (ADR 0072, "The build"). An `m7g.xlarge` costs $0.1632 an hour on demand, and gp3 costs $0.08 a GB-month (`spikes/host-size-classes/README.md`).
- **A `deskd` restart:** about 1.7 CPU-seconds (`docs/benchmarks/2026-11-real-stack.md`).

## Decision

### 1. Where updates apply: generations of the template, built once and signed, which each host fetches and each slot moves to at its own stop

| Option | How a fix arrives | Work on each member host, per generation | What members see | What waves rest on | Spend | Verdict |
|---|---|---|---|---|---|---|
| **A.** Host-image rolls only, desks moved to new hosts | A bake and `verify.sh` (about 40 minutes each), then Platform drains each host by moving every desk at its idle (ADR 0072 section 12) | A drain: every desk stopped, snapshotted, detached, attached elsewhere and started cold | One move per desk per fix. Its downtime is unmeasured (section 12 guesses 30 to 90 s) | The AMI | A bake per fix, plus a spare host for each drain | Not rare enough and not prompt enough. Chromium ships security fixes about every one to two weeks (an estimate from outside this repo). So it's either monthly, a month late (13.1 refuses that), or every desk moves weekly. It also needs a mover that isn't built. **Kept** for the host's own image (section 3) and as the drain of last resort |
| **B.** Each host builds its own generation (this ADR's first draft) | The host's own apt fetches `trixie-security` into a copy of the template, then checks and seals it | 7 to 10 min at the update cap and 3 to 5 CPU-minutes (estimates). apt and Debian's maintainer scripts run there, in a new user-namespace sandbox on an idmapped tree, beside paying desks, with up to 384 MiB taken from a 640 MiB reserve nobody has measured | Nothing | A plan hash: each host makes its own bytes from the same package versions | No AWS spend, but N builds of the same packages | **Rejected.** It runs package code on every member host and needs a Security read of that sandbox. It does the same work N times, and its waves rest on matching plans, not matching bytes |
| **D.** One build per host-image version, on a builder; each host fetches the signed artifact | A temporary builder, launched from the host AMI, does all of B's steps and every check, then signs a tar, its manifest and its plan (1.2, 1.3) | Fetch, verify, unpack and seal (1.4): about 3.5 to 4 min at the update cap, 1 to 2 CPU-minutes, about 128 MiB (estimates). No apt, no `dpkg` and no maintainer script | Nothing | The same signed bytes on every host, proven once on the builder and again on the test host | A builder of 40 to 60 min, a small cost a build (estimate). About 0.9 GB of S3 per artifact. One KMS key. Section 8 has the totals | **Chosen** |
| **C.** Changing the slot layout | C1: an overlay on a shared lower, where an update is a new lower. C2: the changed files written into a stopped slot's root. C3: reflinked copies on XFS | | | | | C1 rejected: desks would share the lower's page cache, which ADR 0072 section 10 refuses (Flush+Reload). A file a desk has copied up hides the updated lower file forever. The kernel doesn't allow a lower to change under a mounted overlay. And overlayfs is more kernel surface within a desk root's reach. C2 rejected: the host would write into a tree a desk has run on, which WALL-03 refuses. C3: page caches stay apart (they're per inode), and copies would become nearly free. But it's a new store filesystem with its own quota and masking work, so it's a later spike, not a need |

**Why D wins over B:**
- Package code never runs on a member host, so there's no new sandbox beside paying desks for the Security Analyst to clear.
- A member host's work shrinks to a capped download, a checked unpack and a seal, in about a third of B's memory.
- Every host in every wave runs the bytes that passed on the builder and on the test host.

**What D costs that B didn't:**
- a builder pipeline;
- a signing key;
- bucket space;
- a dependency on S3. If the builder is down, no host can make a fix on its own. An urgent fix waits about an hour for a build (section 5).

D takes two layout changes from C's list, and neither needs a new filesystem:
- **A wake never waits for a copy:** a re-root is built outside the slot's lock.
- **A re-root keeps the slot's `rel/`:** the host-owned release copies, which no desk can write (they reach the sandboxes read-only, outside the desk's root). They're kept after a tree-hash check against the store, so a re-root copies 2.3 GB, not 3.3 GB.

#### 1.1 A generation and its artifact
- **On a host:** `/srv/desk-host/templates/<gen>/` on the slot store, where `<gen>` is `g<n>`, numbered per host-image version. The baked template is `g1`. Each sealed generation is bound read-only, as the template is today.
- **Its `.complete`,** still written last, gains four fields: `gen=`, `chromium=` (the generation's `chromium` package version), `manifest=` (the SHA-256 of its manifest) and the existing `host-version=`.
- **The manifest** lists every path's type, mode, owner and size, a regular file's SHA-256, a link's target, and `security.capability` where a file has one. On a host it lives on the host's root, at `/var/lib/desk-host/templates/<gen>.json`, so no write to the store can change both a file and its manifest. The bake writes `g1`'s.
- **`/var/lib/desk-host/templates/state.json`** (on the host's root) holds `current`, `previous`, `candidate` (sealed but not yet trusted on this host, 1.6) and `halted` (never used again), with each one's target and dates.
- **At most two sealed generations at once:** current and previous, or current and candidate. A third is allowed only when the store has room for it (section 4). The previous one is deleted, without following links as a slot's old root is, only once no slot's record names it and no running sandbox roots in it.
- **Everything that reads the template today reads the slot's own generation instead** (the record's `template`):
  - the prepare's copy;
  - the desk's firewall, which is loaded into its namespace;
  - the resolver file bound into three sandboxes;
  - the roots of the `desk-rtc`, `desk-stream` and `desk-data` sandboxes;
  - the pre-read's paths;
  - `desk-host-check template`.
- **Nothing changes under a running desk.** A running slot keeps its generation until its next start. So no library or Chromium binary is ever replaced under a running process, which a desk of its own can't avoid (its `chromium.pending`).
- **The artifact** sits in the release bucket beside the components, under `desk/host-template/<host-image version>/<gen>/`:
  - `template.tar.zst`: the generation's tree, numeric owners, set-id bits cleared (below);
  - `manifest.json`;
  - `plan.txt`: the `name=version` lines of every package that differs from `g1`;
  - `header.json`, the one signed file: `format` `ma-host-template/1`, `gen`, `hostImage`, `created`, `urgent`, `chromium`, the SHA-256 of `g1`'s manifest (its base), and each of the other three files' size and SHA-256. It's within 4 KiB, so KMS can sign it raw, as `tools/batch/` keeps a batch manifest;
  - `header.sig`;
  - `passed-build.json`, the builder's pass record;
  - `passed-test.json`, written once the staging test host has passed it, as for components.
- **Set-id bits.** The member host's extractor is `desk-host-release`'s, through tarfile's `tar` filter, which strips set-id bits. So the builder packs with them cleared. Slots never had them, since `shift.py`'s chown clears them, and `no_new_privs` makes them meaningless in every sandbox. The manifest records the modes as packed.

#### 1.2 Built once per host-image version, on a builder
A generation depends on its host image's own additions to the template: users 1107 to 1112, the policy, the `desk-rtc.conf` link, the resolver and the empty `machine-id`. So one is built per host-image version still in the fleet.

**The builder** is driven from the workstation by `image/host/template-build.sh`, as `bake.sh` drives a bake:
- **The machine:** a temporary `m7g.xlarge`, tagged `Purpose=desk-image-build` with an `Owner` tag, launched from the host AMI the generation is for, with a small test volume for one slot. It's terminated on exit, even on failure, and checked by tag.
- **What it carries:** the script copies the build's tools onto it, as `verify.sh` copies its fixtures, so a member host never carries them; `no-test` fails a host that does. It's a test host (desk-host's `TEST` mode), with a fake Platform on its loopback, as `verify.sh` runs one.
- **Its permissions:** no KMS permission and no role for the bucket. It uploads through presigned PUT URLs that the workstation makes, each with the archive's SHA-256 as an `x-amz-checksum-sha256` header, so S3 refuses bytes that don't match.

**On the builder, in order.** Each step fails closed: nothing is signed or uploaded, and the run's log says which step failed and why.
1. **Prove the base.** `g1`, the AMI's own template, is checked against the manifest the bake wrote.
2. **Fetch the fleet's current generation** for this host image, if there is one, through the member host's own path (1.4). That proves the path and gives step 6 the current Chromium.
3. **Copy `g1`** to `templates/.build-<gen>/`, as the template was made (tar with numeric owners), and record the time the copy ended. Every generation is `g1` plus the security archive at build time. So each one can be rebuilt from its AMI and the archive alone, and none chains on an earlier artifact.
4. **Download, with no package code run.** The builder's own `apt-get` does this, with:
   - `Dir::State`, `Dir::State::status` and `Dir::Cache` pointed at the build tree, and `Dir::Bin::Methods` the builder's own;
   - one source file naming exactly Debian's security archive (`trixie-security`), `Signed-By` the host's `debian-archive-keyring`. The desk image's own lists were cleared at bake, so none are read.

   It then runs:
   - **`apt-get update`.** apt refuses a Release file the key doesn't sign.
   - **`apt-get -s upgrade`,** which gives the plan. The template never boots its own kernel and has no `/boot`, so kernel, bootloader and initramfs packages are pinned −1 and never enter it. `upgrade` adds no packages. Whatever is kept back is reported: a package that needs a stable point release waits for a host image.
   - **`--download-only`.** apt checks each `.deb` against the signed `Packages`.
5. **Install, in a sandbox, with no network.** The build tree's own `apt-get --no-download upgrade` runs with dpkg's `--force-confold` and `--force-confdef` and the same one-source file. The sandbox is a runc container like a slot's service sandboxes, all of it the builder's own and terminated with it:
   - Docker's seccomp profile and the unit filter;
   - `no_new_privs`;
   - its own user namespace, with the tree bound through an idmapped mount so files keep their on-disk owners;
   - an empty network namespace;
   - `policy-rc.d` exiting 101.

   A Docker build does the same with `RUN apt-get upgrade`.
6. **The checks** in 1.3, every one, on the sealed tree. The tree is sealed on the builder as a member host seals one, then a slot is started on it.
7. **Pack:**
   - `tar` with numeric owners and `security.capability`, set-id bits cleared, then `zstd` at a middle level (no long window, so decompressing needs little memory);
   - the manifest, the plan, the header and `passed-build.json`, which lists every check with its result;
   - **the round trip:** the packed artifact goes through the member host's fetch path (1.4) on the builder, into a second tree whose manifest must equal the sealed one's;
   - then the upload.
8. **Sign, on the workstation.**
   - It checks first that S3's stored SHA-256 of each file equals the header's, read from S3 without downloading the archive, and that `passed-build.json` passes.
   - `tools/template/template-sign` (from `batch-sign`'s code) signs `header.json` with KMS, ECDSA P-256 SHA-256 over its exact bytes, DER, as a desk batch is signed. It uses the System Engineer's credentials; the builder never holds a signing permission.

**The key is a new one, `alias/ma-host-template`, not `alias/ma-desk-batch`:**
- **One key, one verifier.** A template signature puts root content under every slot of every shared host, and a batch signature puts services on desks of their own. With separate keys, a mistake or a misuse in one signing path can't produce a signature the other accepts. Each verifier's `format` check is then a second layer, not the only one.
- **Each image carries only its own key.** The host image bakes only the template key, in `/etc/desk-host/template-keys/`. The batch key isn't on a host's root at all; it's in the template only, for desks of their own.
- **Its own grants and rotation.** `kms:Sign` on the template key can go to a later automated builder without that pipeline ever being able to sign a desk batch.

The cost is a second key, about $1 a month (Platform's to create, PU-9).

#### 1.3 How a generation is proven whole, on the builder, before anything is signed
1. **dpkg's own state.** `dpkg --audit` is silent, every package is `ii` and `apt-get check` is clean. The installed set equals the plan, name and version, and every new version is the security archive's, from its signed lists.
2. **Nothing else changed from `g1`.**
   - Every path whose ctime is later than the copy's end, and every path added or removed, must belong to an upgraded package (`dpkg -L`) or to a short list of what dpkg and its triggers write: `/var/lib/dpkg/`; `/var/lib/apt/` and `/var/cache/apt/`, both emptied after; `/var/cache/debconf/`; `/etc/ld.so.cache`; `/etc/alternatives/`; the MIME, icon, GDK pixbuf and fontconfig caches; and `__pycache__` directories. Anything else fails the build.
   - These must stay byte-identical:
     - desk-host's additions: users 1107 to 1112, the policy's `NativeMessagingUserLevelHosts`, `/etc/ma/desk-rtc.conf`'s link, `/etc/resolv.conf` and the empty `machine-id`;
     - `/etc/ma/`, `/usr/local/`, `/opt/ma/`, `/usr/share/ma/` and `/etc/chromium/policies/`;
     - `/etc/nftables.conf`, which every slot's firewall is loaded from.
   - A Debian conffile left as ours (a `.dpkg-dist` beside it) is reported, and fails the build when it's under one of those paths.
3. **`dpkg --verify`** passes for each upgraded package.
4. **`desk-host-check template`'s checks** pass on the new tree.
5. **Chromium goes forward.** The new `chromium` is at least the fleet's current generation's; a lower one is refused outright (section 2). `chromium --version` runs.
6. **The profile carry, both ways (ADR 0035), whenever Chromium changed,** on a throwaway profile in a tmpfs with no network:
   - the current generation's Chromium (headless, `--password-store=basic`, the desk's policies) sets a cookie and `localStorage` over CDP and exits cleanly;
   - the new one opens that profile and reads both back;
   - the current generation's `desk-browser-start --check` must then exit 78, with the profile's hash unchanged.
7. **GStreamer.** If a `gstreamer1.0-*` package changed, the registry `/usr/local/lib/ma/gst-registry.bin` is regenerated as the bake does, and `gst-inspect-1.0` runs on every element `stream.conf` names.
8. **The template-relevant parts of `verify.sh`, with a slot running on the new generation:**
   - the host checks that read the template or a running slot: `template`, `svc-dns`, `standin`, `counters`, `class-applied` and `apparmor`;
   - the wall's settings on the desk's processes;
   - `WR2-02` inside the desk;
   - a stream that sends video.
9. **A real slot start on a carried profile.**
   - A slot is started on the current generation by the fake Platform's `start_slot`.
   - `e2e/`'s `browser-session.spec.ts` seeds it with test data only (cookies, a saved password, tabs, history; `SESSION_KEEP=1`), in a slot mode the spec gains (below).
   - The desk is stopped, re-rooted to the new generation by 1.5's own path, and started.
   - The spec reads everything back (`SESSION_CHECK=stop-wake`).
   - When Chromium changed, a forced re-root back to the current generation (test hosts only) must leave the guard refusing, exit 78, with the profile's hash unchanged.

   **The spec's slot mode:** today it reaches only the staging test desk over SSM (`e2e/tests/lib.ts`, `onDesk`). It gains `SESSION_SLOT=<k>`, which runs its commands on the builder and reaches the slot's Chromium through a test host's CDP forward (WR2-01: test hosts only). It still never addresses any other instance.
10. **The round trip** (1.2 step 7), after the pack.

#### 1.4 Taken by a member host: fetch, check, seal
A member host only fetches and checks. No apt, no `dpkg`, no maintainer script and nothing from the artifact runs. On Platform's `template_target` (PU-2), in `desk-host-upd` (section 4), and failing closed at every step (nothing sealed, the current generation and every slot untouched, the download removed, the report naming the step):
1. **Store admission** (section 4).
2. **Download** `header.json`, then `header.sig`, to the host's root (`/var/lib/desk-host/dl/<gen>/`), through the presigned URLs in the order.
3. **Verify the signature** against the keys baked into the host image, `/etc/desk-host/template-keys/*.pem`: root-owned, P-256 only, with no drop-in directory. With no valid key, every artifact is refused. The header must also pass:
   - at most 4 KiB, JSON with no repeated key, `format` exactly `ma-host-template/1`;
   - `hostImage` equal to this host's own version, which `g1`'s `.complete` records (`host-version=`);
   - `gen` above every generation this host has had (current, previous, candidate or halted), so an old artifact can't be replayed;
   - its SHA-256 equal to the order's, so Platform and the signer agree on what was meant.
4. **Download** the manifest, the plan and the archive. Each is hashed as it arrives, and its size and SHA-256 must equal the header's. Only then is the archive opened.
5. **Unpack** into `templates/.build-<gen>/` with `desk-host-release`'s checked extraction (tarfile's `tar` filter, numeric owners). It refuses:
   - any member outside the tree, or a link that points out of it;
   - a device file;
   - a member the manifest doesn't list.

   Each file is hashed as it's written, so nothing is read back.
6. **Walk the tree:** every path in it is in the manifest, with the right type, mode, owner, size, hash, link target and capability, and every manifest entry is in the tree. Then `desk-host-check template` runs on it, and Chromium must go forward against the host's current generation.
7. **Seal:**
   - `chown 0:0`;
   - `.complete` written last, and the manifest copied to the host's root;
   - the tree renamed to `templates/<gen>` and bound read-only;
   - `state.json`'s `candidate` set;
   - the download removed.

A new host builds nothing. At its first hello it fetches the fleet's current artifact for its host-image version.

#### 1.5 How a slot moves: a re-root
A re-root is a prepare for the same desk:
- a fresh tree from the target generation, built beside the old root;
- the slot's `rel/` moved in, once its tree hash matches the store's;
- then, under the slot's lock: the record removed, the new tree swapped in by rename, the record written (`desk`, the same desk ID, the new `template`), and the old root deleted without following links.

A crash during the copy leaves the old root and its record as they were, and the next re-root or prepare removes the half-built tree. A crash in the few milliseconds of the swap leaves no record, and the next start prepares again. WALL-03 holds, as for any prepare: the host writes only into a tree it has just made, and only deletes the desk's old one.

Slots move in four ways:
- **At a stop.** After every stop except a host's `stop-all` before a reboot, `desk-host reroot <k>` runs in the background in `desk-host-upd` if the slot isn't on the generation section 2 picks for it.
  - It doesn't hold the slot's lock while it copies, and swaps only if the slot is still stopped with the same record and epoch.
  - A wake that comes first takes the lock at once and starts on the old root, because contract 13.2 does the slow step "never at wake". The copy is dropped and tried again at the next stop.
  - It takes about 2.5 minutes at the update cap (2.3 GB at 15.6 MB/s; estimate), and an idle stop lasts hours. Platform's idle stops are the common case, so most slots move without anyone noticing.
- **Fresh slots** on the old generation are prepared again in the background as soon as a new one becomes current, before any start claims them. Otherwise `up` would refuse to claim them and prepare each one with a member waiting.
- **An idle restart, for a desk that doesn't stop.** Some desks don't stop within 3 days of a generation becoming current (1 hour for an urgent target; both estimates, Platform's settings). Such a desk is restarted when idle.
  - **How idle is read:** from the desk's own `/run/desk/idle.json`, on the host's side of the slot's `/run` share, under RC-06's rules: a regular file of at most 64 KiB, owned by the slot's uid 1100, opened `O_NONBLOCK` with no links and under a timeout.
  - **When it may run:** only when desk-batch's rule says idle (runtime spec §6.1: sessions, Agent runs and exports all 0 for `min(idleStopSeconds / 2, 3600)` s, or 600 s without `idleStopSeconds`). `downloads` must also be 0, since Chromium closes, and the file must be fresh. Nothing may hold the slot (section 5), and Platform mustn't have turned restarts off.
  - **What it is:** the re-root built beforehand beside the running root, then a stop (section 2's close), the swap and a start on the same epoch. So the gap between the stop and the start is the swap, not the copy. Throughout, the report carries the slot's `update.holdUntil`, 15 minutes ahead.
  - **Who never gets one:** a desk whose member stays connected, except under the urgent clock (section 5). Desks that stop every day, such as Alliance desks after 20 minutes or free desks, never need one.
- **Never at a wake.** `up` never copies a root to change its generation. A desk moving in from elsewhere, whose slot record doesn't name it, is prepared from the generation section 2 picks, as any start on another desk's slot is today.

**At a re-root a slot loses nothing of the member's.** Its root is a copy, not an overlay, so nothing it wrote can hide an updated file. Everything it wrote into the root goes, as at any move to another slot or host: ADR 0072 sections 10 and 12, and run 2 moved a desk between slots with its cookies kept. On a shared host the root holds only these:
- the teen lock and the ad blocker's policy, which `desk-browser-policy` and `desk-adblock` write again before every start of Chromium;
- the pre-read's stamp, which the host puts back;
- `/tmp` and `/var/tmp`.

What a member keeps is on `/data`: the profile, `deskd`'s state, the DTLS identity, the Notebook and Files, and `desk-init`'s logs.

#### 1.6 Rollback
- **Before any slot has used it:** a build that fails is never signed, and an artifact that fails a host's checks is never sealed, so there's nothing to roll back.
- **A candidate first.** A sealed generation stays this host's `candidate` until two things have happened:
  - one slot has started on it and passed the host's own start checks: every sandbox running, and the desk's container alive 120 s after `runc start` (estimate);
  - Platform has sent `template_promote`. It sends it once it has seen that desk's hello and, after a session opens the Browser, no refused or crash-looping Chromium in the desk's heartbeat.

  Until then, slots move onto the candidate one at a time and only at a stop or an idle restart, preferring an idle restart, where nobody is waiting. Wakes and fresh slots stay on the current generation.
- **A failed start on a candidate** halts it on that host. It's marked `halted` and never used again. If the slot's Chromium can't have run there (section 2's read: `Last Version` no newer than the current generation's Chromium, the one before the candidate), the slot is prepared again from the current generation and started at once. That's a foreground prepare of 21 to 49 s (measured), which the member who woke the desk waits through, once. Otherwise the slot stays where it is, its Browser waits, and the report says so.
- **Platform's `template_rollback {gen}`,** for an artifact found bad on another host or a problem seen in heartbeats. Platform also stops naming it in targets.
  - No new root is made from that generation.
  - Each slot on it goes back to the previous generation at its next stop or idle restart, **but only if** its profile's `Last Version` is no newer than that generation's Chromium.
  - A slot whose Chromium has already run on the bad generation stays on it until a newer generation fixes it forward. An older Chromium would raze `Cookies` (ADR 0035; contract 13.5, "Where rollback can't be simple").

  Nobody edits `Last Version` or restores a volume to get round this.

### 2. Chromium, per slot
- **The guard stays the last line.** In each slot, `desk-browser-start` reads the slot root's own dpkg database and the profile's `Last Version`, and refuses to start an older Chromium (exit 78, the profile untouched). Every slot has its own root, so the guard is already per slot, and nothing here changes it.
- **The host picks each slot's generation so that the guard never has to refuse.**
  - **When it reads `Last Version`:** at a re-root, and at a start whose record doesn't name the desk. `mounts.py peek` then mounts the volume read-only in a private mount namespace (`nosuid,nodev,noexec`, as `mounts.py vol` does), and reads `browser/profile/Last Version` under RC-06's rules. ADR 0072 section 3 already lists this read. A stopped desk's `Last Version` can't move, so a wake on a root its record names needs no read.
  - **The choice:** the current generation, unless it's rolled back (1.6), and never a generation whose Chromium is older than `Last Version`. No profile, or no readable version, means a new profile with no constraint.
  - **If no generation on this host is new enough** (a desk placed here from a host with a newer one, which PU-4 should prevent): the desk starts on the current generation and the guard refuses its Browser. The report says `chromiumBehind`, so Platform moves the desk or names this host the target's artifact. A wrong choice costs a Browser that waits, never a session (ADR 0072 section 12).
- **Where it's reported:** each slot's record and report carry its generation, that generation's Chromium and the last `Last Version` read. ADR 0072 section 12's preflight for a move then uses the host's own read, not the AMI's `ChromiumVersion` tag, which stops describing a host once it has a later generation.
- **Closing Chromium for a new version** is the container's own stop, at idle only (1.5):
  - `desk-init` stops `deskd`'s sandbox first, so nothing can start Chromium again;
  - it thaws Chromium (ADR 0045) and asks it to quit over CDP (`Browser.close`), which commits the cookies the 30 s timer hasn't;
  - it waits up to 31 s, then sends SIGTERM and allows 30 s more;
  - then `sync -f /data`.

  Proven: 4 s, `quit=cdp`, `exit_type Normal`, with a cookie set 8 s before and `localStorage` kept (`RC-05`, run 2; run 3 with the browser frozen first). The next start restores the tabs (`RestoreOnStartup` and `--restore-last-session`).
  - It's never `kill -9`.
  - It's never done while a member is connected, except under section 5's urgent clock.
  - It's never done while `downloads` isn't 0.

  A half-typed form in a background tab may come back empty, but no session was open, so nobody was typing.
- **A newer Chromium opening a carried profile** is proven per build three times, all with test data:
  - on the builder: 1.3 item 6's throwaway profile, then item 9's real slot start with `browser-session.spec.ts`;
  - on the staging test host (PU-3);
  - by each host's candidate (1.6).

  Every image and `trixie-security` have 156.0.8078.79 today, so nobody has run it with a real newer version (contract 13.9).

### 3. The kernel and the host's own packages
The kernel is the wall and every slot shares it, and a host reboot stops every slot. This is the host's root, not the template, so it stays on the host.
- **The host's own apt.** A new `desk-host-apt.timer` runs at most once a day, in `desk-host-upd`:
  - `apt-get update` and `unattended-upgrade`, with the host's own `51desk-host-unattended`. Its rule is the desk's: `#clear` first, the security archive only, `Automatic-Reboot false`.
  - `policy-rc.d` exits 101 for the whole run, so no service restarts under the desks.
  - `nftables` and `apparmor` are held, and their updates come with a host image. A restart of `nftables.service` would flush every slot's chains, and a reload of AppArmor's profiles would touch every slot's profile.
  - Afterwards `desk-host-check --quick` runs again, and a failure is reported at once. As today, every `up` refuses until it's fixed.
  - A new kernel, or `/run/reboot-required`, is reported as `rebootPending`. Nothing else applies until the reboot, which is when replaced libraries take effect.
- **When it reboots.** Only on Platform's `reboot_host` order, which Platform sends when every desk on the host is idle by its own view.
  - **The host refuses the order unless all of these hold:** `rebootPending` is set; no slot is `starting`; no slot's `update.holdUntil` is ahead; and every running slot is idle by its own `idle.json` (1.5's rule), or the order is urgent and its clock allows (section 5).
  - **A host with no running desk** reboots at once. When every desk is stopped, Platform's own stop of the host boots the new kernel too, at no cost. Under `SlotMode=port` that stop changes the host's address and an OS reboot doesn't; either way `desk-rtc` reads it at each start.
  - **A fetch or re-root in flight** is stopped and dropped first, and restarts from scratch later.
- **How it reboots, on the existing path:** `systemctl reboot`.
  1. `desk-host-link` stops first.
  2. `desk-host-shutdown.service`'s stop runs `desk-host stop-all`. It marks the host halting before it looks, stops every running slot and every slot an `up` has marked `starting`, and makes any later `up` refuse with `host_stopping` (from the bake after 0.1.7; `verify-port.sh` 4d). Each desk closes as in section 2.
  3. At boot, `desk-host-boot` runs, and `desk-host-shutdown.service`'s start is `desk-host resume`.
  4. The link says hello with a new boot ID, and Platform sends `start_slot` for every desk the order named as running before it. Each start is a wake on the desk's own root.
- **What a member sees:**
  - **Routinely, nothing:** nobody was connected. The next open is a cold one (the Browser in about 35 s for a standard desk and 42 s for a free one, with the pre-read), unless the start after the boot has already warmed it.
  - **The timing:** six slots waking at once share the pre-read's 0.2 of the baseline, and 6 × 450 MB at 31 MB/s is about 90 s. So the last desk is ready about 2 to 2.5 minutes after the order: a boot of 30 to 51 s (first boots; a reboot should be shorter), then the wakes (estimate).
  - **Under the urgent clock (section 5):** a member who is connected sees the desk drop and the connecting state for that long, then the same tabs, and one line afterwards (contract 13.7).
- **A host that's never all idle at once.** After 30 days of `rebootPending` (72 hours when urgent), Platform drains it by moving its desks one at a time, each at its own idle (ADR 0072 section 12), then reboots or replaces it. That's option A, kept as the last resort.
- **A host image change** (`desk-host` itself, the release store's pins, `nftables`, `apparmor`, `runc`) stays option A, and Platform drains for it (ADR 0072 section 13).

### 4. Disk and I/O budget
- **The store has to grow by one template.** A second generation adds 2.6 GB: the template's 2.3 GB, plus 0.3 GB allowed for growth. The download goes to the host's root, not the store: at most 1.2 GB (estimate), deleted at the seal, against the root's 6.4 GB free. Today the store keeps about 8% free at full quota with a prepare in flight, 2.9 GB of 36 GB, so a second generation would leave almost nothing. **The new size is ⌈(9.3 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB:** 39 GB at 6 slots (from 36) and 78 GB at 14 (from 75). That's PU-6.
- **Store admission.**
  - A fetch starts only when two things fit: the new template and one prepare on the store, on top of its existing headroom; and the download on the host's root. A third generation is allowed only when one more template fits too.
  - Every copy on the host (an unpack, a re-root, a slot's prepare) waits its turn, so the formula's "one prepare in flight" still holds.
  - A start that must prepare, with a member waiting, takes the turn from a background re-root or unpack, which is dropped and retried.
- **The quota.** Each root's project quota is set at prepare from the size of its copy, so a bigger template brings bigger quotas. An artifact whose manifest is more than 0.3 GB bigger than the store's allowance is refused: the store wasn't sized for it.
- **The update's I/O stays off the paid slots' shares.** Every fetch, re-root and host apt run goes in `desk-host-upd`, a cgroup beside `desk-host-pre` and outside `desk-host` and every desk's share. It has:
  - `cpu.idle` 1, and `cpu.max` of one CPU;
  - **`memory.max` 192 MiB (estimate), down from the first draft's 384.** An unpack (the extractor, `zstd` with no long window, hashing as it writes) needs about 128 MiB, and the host's own `unattended-upgrade` (python3-apt's cache) sets the rest. They never run at once. It still comes out of the host's 640 MiB reserve, whose free room beside the link and the demux is unmeasured;
  - `io.max` on the store and the host's root: 0.1 of the EBS baseline's bytes for reads and 0.1 for writes, and 300 IOPS each way. On an `m7g.xlarge` that's 15.6 MB/s each way. The 300 IOPS keep the store inside its own 3,000 next to the six roots' 2,400.

  The cgroup is frozen (`cgroup.freeze`) while a pre-read runs. A fetch's steps run one after another: the download writes the root, then the unpack reads the root and writes the store. So the host's own I/O never exceeds 0.2 of the baseline, the room the desks' 0.8 leaves (ADR 0072 section 10). No desk's `io.max` is touched, so a free desk's 0.42 MB/s of root writes doesn't matter: the host does the writing.

### 5. Rarity and timing
- **Routinely, at most one generation a week.** That's an estimate, set by Platform as `hostUpdates.routineDays`, default 7, and a generation is only built when the archive has something new for the template since the last one. Each slot changes at most once per generation, almost always at an idle stop it was having anyway. Builders run at any hour. A host fetches at any hour too, because a fetch touches no desk: it's capped, at `cpu.idle`, and frozen during pre-reads.
- **What counts as urgent:** decision 17's fixes (a hole that is actively exploited, such as a Chromium fix, or one reachable remotely), plus ADR 0072 section 13's two for shared hosts (a kernel escalation reachable from a desk, and a `runc` escape). For those:
  - a build starts at once (40 to 60 minutes);
  - Platform opens the target with 1-hour holds;
  - idle restarts begin after 1 hour instead of 3 days;
  - the host reboots as soon as every desk is idle.

  The urgent clock is contract 13.2's. After 24 hours of waiting, a connected desk with no input for 15 minutes (`lastInputAt`) counts as idle; after 72 hours, any 60 s with no input does. Only then can a member see a reconnect.
- **How desk-batch's idle rule and `holdUntil` fit:**
  - Unchanged from desk-batch: the same `idle.json`, the same definition of idle and the same urgent clock, failing closed (a missing or stale file isn't idle). `desk-batch` itself doesn't run in a slot.
  - The host keeps a slot's `update.holdUntil` 15 minutes ahead in its report while that slot's swap or idle restart runs, and Platform's sweep doesn't stop the slot meanwhile.
  - The 3-day wait is what lets Platform's own idle stop come first: a desk that stops at all in those 3 days moves then, at no cost.
- **There's no fixed window.** Contract 13.6 dropped the 02:00 to 05:00 window, and idle is the rule. A member's `updates.window` (not built) would only narrow idle restarts and reboots.

### 6. What the platform must add (for the Platform Engineer)
- **PU-1: the host's report, its heartbeat** (`shared-host.md` section 4). Every field is additive.
  - **Per slot:**
    - `template` (its generation) and `chromium` (that generation's);
    - `lastVersion` (the host's last read, or null);
    - `behind` (not on its target generation) and `chromiumBehind`;
    - `update.holdUntil`.
  - **Per host:**
    - `templates`: `current`, `previous` and `candidate`, each `{gen, chromium, sealedAt, target}`, plus `halted`;
    - `fetch`: `{target, gen, state, at, step, error}`, where `state` is one of `downloading`, `verifying`, `unpacking`, `checking`, `sealed`, `failed`, `refused` (a signature, hash or header refusal) or `urlsWanted`;
    - `hostApt`: `{lastOk, lastResult, rebootPending: {since, kernel}}`.
- **PU-2: orders.** Each runs once per ID, as orders do.
  - `template_target {targetId, gen, hostImage, sha256, urls: {header, signature, manifest, plan, archive}, expiresAt, urgent}`: fetch it. `sha256` is the header's. The URLs are presigned GETs, as a desk batch's are, so the host role stays as ADR 0072 P5 has it. With less than 10 minutes left on them, the host asks for new ones (`urlsWanted`).
  - `template_promote {gen}`.
  - `template_rollback {gen}`.
  - `reboot_host {id, urgent, restart: [k…]}`.
  - A kill switch in the reply, `updates: {fetches, restarts, reboots}`, each true unless turned off.
- **PU-3: targets and waves: the same artifact everywhere.** A target names one artifact, by `gen`, host-image version and `sha256`.
  1. With `passed-build.json`, the staging test host takes it first. Its slots run `e2e/` with a real profile carried (`browser-session.spec.ts`), and a pass writes `passed-test.json`.
  2. Then 10% of the hosts on that host-image version, at least one.
  3. Then the rest.

  Platform names an artifact beyond the test host only when it has both pass records, as `bake.sh` refuses a release without `passed-test.json`. The holds are contract 13.5's: 48 h for the first group, then 24 h a wave, and 1 hour each when urgent. So are its halts. A new host fetches the fleet's current artifact for its host-image version at its first hello.
- **PU-4: placement.** Place a desk only on a host whose current generation's Chromium is at least the desk's `Last Version`. Take that from its last host's report, or from the heartbeat field in ADR 0072 section 12, never from the AMI's `ChromiumVersion`. A new host from an older AMI is placeable for such desks only once it has fetched and sealed the target.
- **PU-5: alarms, to the System Engineer, who owns the template.**
  - A fetch `failed` twice in a row, or not sealed within 2 hours.
  - At once: any `refused`, since a valid target that fails its signature or hash means tampering or a signing bug.
  - A host's current generation behind the fleet's target by more than 7 days, or 24 hours when urgent.
  - A slot `behind` for more than 14 days.
  - At once: any `chromiumBehind`.
  - At once: a halted candidate, and the artifact halted across the fleet by contract 13.5's rules.
  - `rebootPending` for more than 30 days, or 72 hours when urgent.
  - `hostApt.lastResult` failed twice, or the host's checks failing after it, at once.
  - The builder's own failures go to its log and the System Engineer's status file, not to Platform.
- **PU-6: the store's size** in the launch template, ⌈(9.3 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB (section 4).
- **PU-7: where a host's update state shows.** In the admin console's row for the host: its generations and their Chromium, the fetch's state, the slots behind and since when, a pending reboot and since when, and the host's apt. A fleet view groups hosts by host-image version and generation. Members see none of it (contract 13.7).
- **PU-8: the sweep.** Honour a slot's `update.holdUntil`. After a `reboot_host`, start the desks it named once the host's hello arrives.
- **PU-9: the key and the bucket.**
  - The KMS key `alias/ma-host-template`: `ECC_NIST_P256`, `SIGN_VERIFY`. Its public half goes into `image/host/recipe/files/etc/desk-host/template-keys/`, and `kms:Sign` goes to the System Engineer's role only.
    - **2026-11-11:** the key exists and its public half is committed (`ma-host-template-2026-11.pem`), with a committed trust anchor, `image/host/recipe/template-keys.sha256` (its name and SHA-256). `build.sh` stops unless the staged and the installed key are exactly the anchor's (P-256, no link, nothing else) and pins the anchor itself; `bake.sh` first compares the key with KMS's `GetPublicKey`; both verify scripts hold a booted host's pin to the anchor, with a mutation. Before this the recipe pinned whatever `.pem` was staged (the Security Analyst's Medium on the ADR 0077/0078 read). `image/host/RELEASES.md`.
  - The release bucket's prefix `desk/host-template/`, with a lifecycle rule that keeps the four newest artifacts per host-image version, and every artifact of a host-image version until it leaves the fleet.
  - Presigned GETs for the host's order, made by Platform's API, which reads that prefix.
- **No new host permission.** The fetch is a presigned in-region GET, and S3 to EC2 within a region carries no transfer charge. The bytes come in, so the cost guard, which reads `NetworkOut`, doesn't count them.

### 7. Checks for the build
**On a member host.** `desk-host-check` gains four checks, each broken in `verify.sh`'s and `verify-port.sh`'s mutation passes and seen to fail:

| Check | What it proves | The mutation it must catch |
|---|---|---|
| `templates` (a quick check) | Every sealed generation is read-only, with `.complete` written last and its manifest's hash. There are at most two (three with room), and `state.json` is consistent. Every slot record names a sealed generation, and every running sandbox roots in its slot's generation | A byte changed in a file of the current generation through the store's writable path (the manifest catches it). A slot record naming a generation that doesn't exist |
| `template-sig` (new) | `/etc/desk-host/template-keys/` holds exactly the keys the host recipe pins (from 2026-11-11, the committed anchor: PU-9's note), by name and SHA-256: P-256, root-owned, not group- or world-writable, with no drop-in directory. The fetch code verifies the signature before it reads anything else | The pinned key replaced by another P-256 key. A drop-in directory added |
| `update-cgroup` | `desk-host-upd` has `cpu.idle`, `cpu.max`, `memory.max` and both `io.max` lines (0.1 of the baseline's bytes and 300 IOPS each way). Every fetch, re-root and host apt process is in it, and it's frozen while a pre-read runs | A re-root's process moved into `desk-host`'s cgroup. Its `io.max` cleared |
| `host-apt` | The host's `unattended-upgrade` takes only the security archive and never reboots. `nftables` and `apparmor` are held, `policy-rc.d` exits 101 during its runs, and its timer runs in the update cgroup | The hold removed. `Automatic-Reboot "true"` |

`verify.sh` also gains host steps on every host bake. They run only on a test host (desk-host's `TEST` mode, which `no-test` fails on a member's host), with test artifacts signed by a throwaway key that only a test host trusts:

| Step | What it proves | The mutation it must catch |
|---|---|---|
| Fetch | A test artifact is fetched, verified, unpacked, walked and sealed as a candidate, its manifest equal to the signed one | — (every refusal below is this step's mutation) |
| Refused unsigned or wrongly signed | An artifact with no signature, or one signed by a key the host doesn't pin, is refused at step 3, with nothing written to the store | Signature checking turned off: the artifact gets past step 3, and the step fails |
| Refused on its bytes | An archive with one byte changed after signing is refused at step 4, before it's opened | — |
| Refused on its header | Another host image's artifact, an older `gen`, or a header whose SHA-256 isn't the order's is refused | — |
| Refused at unpack | A validly signed test artifact with a member the manifest doesn't list, or a link pointing out of the tree, is refused, with nothing sealed | — |
| Re-root at a stop | ADR 0035's cookie (one set 8 s before the stop), `localStorage`, tabs and a saved password survive a stop, a re-root and a start. The volume's format record is unchanged, the record and every sandbox are on the new generation, and the old root is gone. An `strace -f` of the re-root shows 0 calls on a kept tree that a link could redirect (run 4's audit; configuration review only) | `CRASH_AT=reroot-copy` and `CRASH_AT=reroot-swap`. The next start must prepare again and never claim a half-built tree |
| A wake during a re-root | The start begins within 2 s and runs on the old root, and the copy is dropped | A test flag that holds the slot's lock through the copy. The start then waits for the copy, and the step fails on time |
| Idle restart | A running slot that's idle by its `idle.json` is restarted onto the new generation, with `quit=cdp`, `exit_type Normal`, and its cookie and tabs kept. A slot with a session, an Agent run, a download or a stale file isn't | `idle.json` with `sessions: 1`. A restart then fails the step |
| Rollback | After the new generation's Chromium has run in slot 1 (`Last Version` faked), `template_rollback` leaves slot 1 on it and moves slot 2, which never ran it, back. No Browser is refused | The host's read of `Last Version` turned off. Slot 1 then goes back and its guard refuses (exit 78, profile hash unchanged), and the step fails on the refusal |
| Store room | A fetch without room on the store or the root refuses before writing, and the current generation is untouched | The room check turned off. The step fails |
| Reboot | With `rebootPending` (a test `/run/reboot-required`) and two idle desks, `reboot_host` closes both (`quit=cdp`, `exit_type Normal`). The host comes back and `resume`s, both desks start again, and their cookies are kept. The order is refused when a slot isn't idle or a hold is ahead | A slot's `idle.json` with a session. A reboot then fails the step |

**On the builder.** Every check in 1.3 runs on every build. The builder's own tooling has a mutation pass, run whenever that tooling changes, as `verify.sh`'s runs on each bake. It runs on a test build from a local archive signed by a throwaway key, with a small package the template has, repacked from its own `.deb` at a higher version:

| Check | What it proves | The mutation it must catch |
|---|---|---|
| `template-apt` (moved here from the host) | The build's source file is one line, the security archive, `Signed-By` the Debian keyring. Kernel, bootloader and initramfs are pinned at −1, `--force-confold` is set, and the sandbox's `policy-rc.d` exits 101 | A stable line added. The kernel pin removed |
| Debian's signature | apt refuses an archive its key doesn't sign | The test archive signed again by another key. It must fail at `apt-get update`, with nothing packed |
| Nothing else changed | 1.3 item 2 | The repacked package's `postinst` also writes `/etc/ma/egress.conf`. The build must fail, with nothing packed |
| Chromium forward and carry | 1.3 items 5 and 6. The refusal half uses a faked newer `Last Version`, as ADR 0035's run did, while no newer Chromium exists | A test generation whose `desk-browser-start` lacks the guard. The carry check must fail |
| The slot start | 1.3 items 8 and 9, `browser-session.spec.ts` in slot mode | Chromium's cookies database removed from the seeded profile before the re-root. The read-back must fail |
| The round trip | 1.2 step 7's second unpack equals the sealed tree | One byte of the packed archive changed after the header was written. The round trip must refuse it |
| The upload | S3's stored SHA-256 equals the header's before `template-sign` signs | The header's SHA-256 edited. `template-sign` must refuse |

No check or step probes the wall: isolation is checked by configuration review and standard audit tools only.

### 8. What it costs
Every figure below is an estimate from the measured rates above; none has been run.

**Per member host at 6 slots:**

| | Per generation | Per month (4.3 weekly generations) |
|---|---|---|
| Fetch: download about 0.9 GB to the host's root, then unpack 2.3 GB onto the store, walk and seal | About 3.5 to 4 min at the update cap (0.9 GB plus 2.3 GB written at 15.6 MB/s); 1 to 2 CPU-minutes; about 128 MiB | 15 to 17 min; 4 to 9 CPU-minutes |
| Re-roots: 6 × 2.3 GB written, with `rel/` kept | About 2.5 min each, 15 min in all, spread over each slot's own stop; 3 to 6 CPU-minutes | About 65 min; 13 to 26 CPU-minutes |
| Idle restarts, only for desks that never stop | Up to 6, each a stop (4 s) and a start (19 s to hello). Under 1 CPU-minute each, in the desk's own share while nobody's there | 0 to 26 |
| I/O | About 17 GB written and 1 to 5 GB read, all within 0.2 of the baseline and no desk's share | About 73 GB written |
| Download, in-region and inbound | About 0.9 GB: 2.3 GB raw, compressed by `zstd` at about 2.5 to 1 (estimate; 0.8 to 1.2 GB) | About 4 GB, with no transfer charge |
| Store | +2.6 GB (39 GB, from 36) | |
| The host's apt | | 30 runs, a few CPU-minutes |
| Host reboots | | About one, for Debian's kernel updates (estimate). The desks are down 2 to 2.5 minutes while nobody's on them |
| CPU in all | | 20 to 65 CPU-minutes of the host's 175,200 (4 vCPUs), at most 0.04%, at `cpu.idle` |
| What members see | Nothing, routinely. Under the urgent clock, at most one reconnect a fix | |

**For the whole fleet, at weekly generations, with one or two host-image versions:**

| | Per build | Per month |
|---|---|---|
| The builder: an `m7g.xlarge` with a 16 GB root, a 39 GB store and a small test volume | 40 to 60 min, like a host bake and its `verify.sh`: boot, the store's first read from its snapshot, the fetch of the current artifact, apt, 1.3's checks, the slot start, the pack. $0.16 an hour plus about $0.01 of volumes: **$0.11 to $0.17** | 4.3 builds per version, plus a quarter more for urgent builds and retries: **about $0.60 to $0.95 with one version, $1.20 to $1.90 with two** |
| S3, Standard at $0.023 a GB-month | About 0.9 GB per artifact | The four newest per version: 3.6 to 7.2 GB, **$0.08 to $0.17**. Each host's GETs cost under a cent |
| KMS | A few signatures a month, nothing per host (hosts verify with the baked public key) | The new key, **about $1** |
| **Total** | | **About $1.70 to $3.10 a month**, within the shared AWS cap |

## The build
One branch, `sub/host-updates`. Agent hours are estimated from this repo's pace.
1. **Generations on the store (2 to 3 h).**
   - `templates/<gen>/`, `state.json` and the manifest.
   - `g1` comes from the bake: `build.sh` writes it at `templates/g1` with its manifest, and `desk-host-boot` binds every sealed generation read-only.
   - Every reader of `$T` takes the slot's generation instead: `desk-host`'s prepare, the firewall and the resolver's source; `svc-spec.py`; `preread.py`, which reads a changed file whole because its traced ranges are stale; `desk-host-check template`; `report.py`.
   - On a host from an older bake, the template becomes `g1` at the first boot of the new code.
2. **The member host's fetch (2 to 3 h).**
   - `desk-host-template fetch`: the download with hashing, the signature and header rules, `desk-host-release`'s checked extraction, the walk, the seal, and the store's and root's admission with the host-wide turn for copies.
   - `/etc/desk-host/template-keys/`, and the `template-sig` check.
   - Tests on temporary trees with throwaway keys and bad artifacts, needing no root.
3. **The builder (4 to 5 h).**
   - `image/host/template-build.sh`: launch, tag, terminate on exit, under the bake lock.
   - The builder's tools: 1.2's steps and 1.3's checks, the install sandbox, the pack and the round trip.
   - `browser-session.spec.ts`'s slot mode, `SESSION_SLOT`.
   - Presigned PUTs with the checksum, and `passed-build.json`.
4. **Signing and records (1 to 1.5 h).** `tools/template/template-sign` (from `batch-sign`'s code, for the new key) and `template-verify` (the host's own check, needing no root), with S3's stored checksum and the pass record checked first.
5. **Re-roots and the choice of generation (2 to 3 h).**
   - `mounts.py peek`.
   - `desk-host reroot <k>`: it copies outside the slot's lock, swaps under it, and reuses `rel/` after a tree-hash check.
   - Scheduling after a stop, and fresh slots prepared again.
   - `CRASH_AT=reroot-copy|reroot-swap`, and unit tests for the choice rule.
6. **Idle restarts, the candidate and rollback (2 h).**
   - The read of `idle.json`, with desk-batch's rule in a shared module, and `update.holdUntil`.
   - The candidate's start checks, `halted`, `template_promote` and `template_rollback`.
7. **The host's own apt and the reboot (1.5 h).** `51desk-host-unattended`, the timer and service in the update cgroup, `policy-rc.d`, the holds, `rebootPending`, and `desk-host reboot` with its refusals.
8. **The link (1.5 h).** PU-1's fields, PU-2's orders and the kill switch, tested in `test_link.py` against `fake_platform.py`.
9. **Checks (2 to 3 h).** The host checks, `verify.sh`'s and `verify-port.sh`'s host steps and mutations, and the builder's mutation pass with its local test archive.
10. **Docs (1 h).**
    - `image/host/README.md` gains an "Updates" section, plus `image/host/RELEASES.md`.
    - `desk-runtime.md` gets a section on a shared host's updates, the counterpart of §6.1.
    - A runbook for a build.
    - Pointers in ADR 0072 section 13 and in contract 13.9's last item.
    - The status file, and the asks sent to Platform.
11. **The floors:**
    - a host bake and both `verify` runs, about 40 minutes each;
    - one real builder run for that bake (40 to 60 minutes), producing `g2`;
    - then a lab host with two desks that fetches `g2`, re-roots six slots and reboots, to measure section 8's numbers.

In all, about 19 to 25 agent hours plus those floors. Not part of this build: the Security Analyst's read of the artifact's signing, the host's fetch and unpack, and the host's own apt; and Platform's PU-1 to PU-9.

**One dependency:** idle restarts need a `deskd` that writes `idle.json`, from `2026.11.10-7e809cb`, in the host's release pin. Until then the file is missing, which isn't idle, so slots move only at their stops.

## What stays unproven until it runs on a real host
- **A newer Chromium opening a member's real profile.** None exists yet: it's 156.0.8078.79 everywhere. The builder carries test profiles only, and the first newer version is proven on the test host's slots (PU-3).
- **Every number in section 8:**
  - the builder's 40 to 60 minutes, and so its spend;
  - the compressed size, and so the download and S3 figures;
  - the fetch's and the re-roots' times at the cap, and their CPU;
  - the 128 MiB for an unpack, the 192 MiB with the host's apt, and whether the reserve has room for them;
  - whether 15.6 MB/s of writes beside six busy desks disturbs them. Their caps say it can't, but the six-desk I/O test (`RC-04`) never ran.
- **`apt-get --no-download upgrade` in the builder's sandbox on an idmapped tree.** It now runs only on a throwaway builder, never on a member host, but it hasn't run. Also unknown: how often a security update is kept back for want of a stable dependency.
- **`browser-session.spec.ts`'s slot mode,** which isn't written: the spec reaches only the staging test desk over SSM today.
- **S3 holding the uploaded archive's SHA-256** (a presigned single PUT with `x-amz-checksum-sha256`) for an object of about 1 GB. It's S3's documented behaviour, not run here.
- **The idle restart on a real always-on desk.** What share of desks ever reach idle is unknown (contract 13.9), and so is what happens when a member arrives during one.
- **The reboot:** its own time (only first boots are measured), six cold wakes at once, and Platform restarting the desks.
- **The host's apt on a live host:** whether holding two packages and `policy-rc.d` covers every `postinst` that could disturb a running slot.
- **`mounts.py peek`:** what it costs at a start, and what it does with a volume whose journal needs replaying.

## Alternatives rejected
- **Option A alone,** host-image rolls and moves: see section 1's table. Kept for the host's own image and as the drain of last resort.
- **Option B, each host building its own generation** (this ADR's first draft): see section 1's table. It ran package code beside paying desks on every host and took up to 384 MiB from an unmeasured reserve. It did the same work N times, and its waves rested on matching plans, not on identical bytes.
- **Signing templates with `alias/ma-desk-batch`:** see 1.2. A separate key keeps a template signature and a batch signature from ever verifying for each other, and keeps each image carrying only the key it needs.
- **A delta artifact, only the changed files.** It would shrink the download, but a host would still write the whole tree (a copy of its current generation plus the changes). In-region downloads cost nothing, and a new host needs the full artifact anyway. A later option if a download ever matters.
- **Each desk updating its own root.** It would need apt egress inside the wall and maintainer scripts run as the desk's root inside it. It would write through the root's 2.08 MB/s share (274 s for 105 MB; about 10 minutes on a free desk), six times over for the same packages, charged to members.
- **An overlay on a shared lower, a delta written into a stopped root, or a shared read-only `/usr`:** see section 1's table. Each shares page caches between desks, hides an updated lower file, or breaks WALL-03.
- **The host deciding reboots alone.** A desk claiming it's never idle could hold back every neighbour's kernel fix. So it takes Platform's order plus each desk's own idle, with the urgent clock and the drain behind them.

## Consequences
- Shared-host desks take Debian's security fixes, Chromium's included, about weekly, at their own idle stops, and nothing changes under a running desk. Members see nothing.
- No member host runs apt, `dpkg` or a maintainer script for its slots' roots. Every host in a wave runs the same signed bytes, built and proven once per host-image version.
- The System Engineer runs a builder about weekly per host-image version still in the fleet. A new host-image version needs its own artifacts until the old version leaves the fleet.
- This replaces ADR 0072 section 13's line "Chromium's own updates reach each slot by `unattended-upgrades` inside the desk", and answers contract 13.9's last item for Debian's packages. ADR 0035's rule holds, per slot.
- The host AMI's `ChromiumVersion` now describes only `g1`, so Platform reads a host's Chromium from its report (PU-4).
- **Still open, and not this ADR's: service batches on shared hosts.** A slot runs `deskd`, `desk-agent` and `desk-notebook` from the host's release store. Their own OS layers, the bases of their Docker images, get fixes only through new releases and pins, which today arrive only with a host image (`image/host/README.md`, "The release store"). A batch would use the same two mechanisms built here, a signed artifact fetched by the host and a re-root at each slot's stop, but it needs its own design with Platform.
- The slot store grows by one template per host (PU-6), and a host image's bake now sets only the first generation.
