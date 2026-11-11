# 0078. Shared-host desks take the same signed service batches as desks of their own: unpacked once into each host's release store, switched live in each slot at idle

**Status:** Proposed. The System Engineer's design. **Built on `sub/host-batches` (2026-11-11; lab evidence only, not baked; `docs/sub-status/host-batches.md`), with the live switch behind Platform's `liveSwitches`, off until the Security Analyst's read.** It closes the gap ADR 0077 leaves open at its end (service batches on shared hosts) and, for `deskd`, `desk-agent`, `desk-notebook`, `desk-rtc` and `desk-stream`, the shared-machine item of `draft-desk-app-contract.md` 13.9. Section 6 lists what it asks of the Platform Engineer and the Desk Engineer, none of it agreed yet. The Security Analyst reads two things before it reaches members: a sandbox made inside a running slot (2.2), and the host's fetch and unpack of a batch as root (1.3). It builds on ADR 0077's host half (`sub/u77-host`, being built): its fetch, update cgroup, idle read, candidate state, link fields and re-roots. Until both are built, a service release reaches a shared desk only with a new host image and a move (ADR 0072 sections 12 and 13): shared hosts reach prod on Nov 13 running the releases their host image baked.
**Date:** 2026-11-11

## Context
The owner, 2026-11-06, on updates to members' desks (S-96): "I want to make sure that this gets done so that updates to real users desks are infrequent because we don't want to frustrate the founding users and never grow". The bar is rare updates that never interrupt (contract 13.1, 13.2).

**A desk of its own** takes service releases by signed batches (runtime spec §6.1; `docs/sub-status/desk-batch.md`):
- Platform names a batch in the heartbeat once the desk's wave is open. `deskd` fetches the manifest, its signature and presigned URLs, and offers them to `desk-batch`, a root helper outside `deskd`.
- `desk-batch` checks the signature (`ma-desk-batch/1`, ECDSA P-256 over the manifest's exact bytes, key `alias/ma-desk-batch`) and the sequence floor. At idle it prepares every component (`ma-update --prepare`: download, sha256 against the manifest, unpack, `docker load`), then activates them in the manifest's order (`--activate`: switch, restart, the smoke test for up to 90 s). A failure rolls the switched ones back in reverse, and the batch is never tried again.
- Measured on a lab box, one sample each: a cold batch of all five services in 32.6 s (20.8 s to prepare, 11.8 s to activate), `deskd` ready 450 ms after its restart, Chromium running throughout.

**A desk in a slot can't, and nothing does it for it.** This comes from reading the code, not from a run:
- **Its services don't run from the desk's own `/opt/ma`.** Since RC-01 (run 2), `deskd`, `desk-agent` and `desk-notebook` run on a read-only copy of the host's release store (`slots/<k>/rel/<svc>/rootfs`), and `desk-rtc` and `desk-stream` on the template with their release bound in (`svc-spec.py`). So ADR 0072 section 13's "Service batches stay per desk, inside its container" can't work: a batch inside the container would change files nothing runs. `desk-batch` doesn't run in a slot either (ADR 0077).
- **The store takes only the host image's pins.** `desk-host-release install` refuses any artifact whose hash isn't in the image's `releases.pin`. `prepare` copies each component's `current` into the slot's `rel/`, and a wake keeps it. `desk-host-check releases` fails unless the store's `current` is the template's own `/opt/ma` release.
- So a slot runs the releases its host image baked until it's prepared again on a newer host image. That takes a bake and `verify.sh` (about 40 minutes each), then a move (ADR 0072 section 12; Platform's mover isn't built).

**Releases are frequent.**
- The release bucket holds 31 `deskd` releases published from Nov 5 to Nov 10 (3 to 7 a day), 30 of them passed on the test desk, plus 13 of `desk-agent` and 15 of `desk-rtc`.
- Members need some of them on shared desks: the free tier's rules live in `deskd` (ADR 0090), and shared hosts take members in prod from Nov 13.
- This ADR is sized for about 3 service batches a week (an estimate; the Desk Engineer's pace). Contract 13.1 says one batch a month at most (decision 16). Which pace holds for members is the owner's call, not this ADR's; the design works at either.

ADR 0077 names this gap at its end and suggests its two mechanisms: a signed artifact each host fetches, and a re-root at each slot's stop.

**Numbers used below** (measured unless marked as an estimate):
- **Release sizes.**
  - Published `.tgz`, the Nov 10 builds: `deskd` 127 MB, `desk-agent` 141 MB, `desk-notebook` 80 MB, `desk-rtc` 4.2 MB and `desk-stream` 0.07 MB, 352 MB together.
  - Unpacked, the five fill 1.0 GB of the store, and each slot's `rel/` is a 1.0 GB copy (`docs/sub-status/shared-host-wall-3.md`).
  - Per component unpacked, about 0.36, 0.40, 0.23, 0.01 and 0.001 GB (estimates, from the total and the compressed sizes).
- **The store** (ADR 0077 section 4): ⌈(9.3 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB with 0077's second template, 39 GB at 6 slots. The 4.4 GB per slot is a root at full quota (3.3 GB) and its `rel/` (1.0 GB), rounded up; the constant includes one copy in flight (3.4 GB). The host's root has 6.4 GB free.
- **The update cap:** `desk-host-upd`'s `io.max`, 0.1 of the EBS baseline each way: 15.6 MB/s on an `m7g.xlarge`. Its `memory.max` is 192 MiB (ADR 0077 section 4; both estimates there).
- **A slot's start:** `deskd`'s hello 3 to 5 s after `runc start` (ADR 0072 section 7, run 1). A `deskd` restart is about 1.7 CPU-seconds (ADR 0077's figure).
- **Idle** (runtime spec §6.1): sessions, Agent runs and exports at 0 for `min(idleStopSeconds / 2, 3600)` s. That's 10 minutes on an Alliance desk (stopped after 20), 15 on a free desk (stopped after 30, ADR 0090) and 1 hour on a desk with the 24-hour stop (ADR 0072 P6).
- **Prices:** gp3 at $0.08 a GB-month. An `m7g.xlarge` has 175,200 CPU-minutes a month (4 vCPUs).

## Decision

### 1. Where a release lands and how it's checked: the desk's own signed batch, into the host's release store

| Option | What a host trusts | Verdict |
|---|---|---|
| **A. The batch as it is:** the manifest, signature and key `alias/ma-desk-batch` that desks of their own take | Each component's sha256 in the manifest, checked against the batch key baked into the host image | **Chosen** |
| **B. A host artifact under the template key** (`alias/ma-host-template`, ADR 0077's header) | A header naming the releases | Rejected. The key that puts root content under every slot would also choose services, and every batch would be signed twice |
| **C. A third key,** `alias/ma-host-batch` | A second manifest of the same releases | Rejected. It signs the same statement twice and keeps two records of which batch is which, and it refuses nothing A doesn't (1.1). About $1 a month more |
| **D. Pins Platform delivers, unsigned** (`image/host/README.md`'s "a pin Platform delivers (not built)") | Platform's API | Rejected. A bug or breach in Platform's API alone would put code on every shared desk, which contract 13.6's signature exists to prevent |

#### 1.1 Why the batch key, though ADR 0077 gave templates their own
ADR 0077 separated its key because a template signature puts root content under every slot of every host, while a batch signature puts services on desks of their own. A batch on a shared host says the same thing it says on a desk of its own:
- **The same services, run the same way:** as their own non-root uids, each in its sandbox inside the desk's wall (ADR 0072 section 2).
- **The host runs nothing from a release.** It hashes, unpacks and copies, as it already does for the pinned releases at every bake: tarfile's `tar` filter, numeric owners, no device files or set-id bits, each image layer checked against its digest.
- So trusting the batch key on hosts gives it no new power. The worst a bad batch does on a host is what it does on a desk of its own: one desk at a time, inside the wall.

**What keeps the two keys apart is kept:**
- Each verifier trusts one key and one `format`. A host's batch verifier takes `ma-desk-batch/1` against `/etc/desk-host/batch-keys/`, and its template verifier takes `ma-host-template/1` against `template-keys/`. Neither signature passes the other's check.
- Both keys are pinned by name and SHA-256 in the host recipe, root-owned, with no drop-in directory. A desk of its own has `/etc/ma/batch-keys.d/` for an admin; a host has none.

So one batch means one thing everywhere: one signing, one `seq`, one note, and one record of what passed. Platform's waves read the same batch for desks of their own and for hosts.

#### 1.2 The batch, unchanged
- **The format** is `ma-desk-batch/1` (runtime spec §6.1), with nothing added for hosts. Unknown fields are ignored, so a later host-only field wouldn't need a new format.
- **A host applies the components it runs from its store:** `deskd`, `desk-agent`, `desk-notebook`, `desk-rtc` and `desk-stream`.
- **What a host can't apply:**
  - **`desk-agent-filter`** runs in the desk's container from the template's `/opt/ma` (`desk-init`). It's the template's, and ADR 0077's generations keep `/opt/ma/` byte-identical to `g1`. A batch naming a filter whose sha256 isn't the template's is applied without it, and the host reports `templatePending` until a host image carries that filter.
  - **`desk-egress` and `commons-server`** don't run in a slot. They're ignored.
  - **A batch naming an `image`** is applied for its services, and the host reports `imagePending` (the counterpart of `root-pending`). A new desk image reaches a host only as a new host image (ADR 0077 section 3).
- **Batches stay cumulative,** so a host never needs one it skipped.

So a host runs the batch's store components beside the template's own `desk-agent-filter`. That set is what the staging test host proves (section 4), so "tested as a set" holds for each kind of desk.

#### 1.3 Taken by a host: verify, fetch, install as a candidate
On Platform's `batch_target` (PB-2), in `desk-host-upd` (ADR 0077 section 4). Each step fails closed: nothing is installed, `current` and every slot are untouched, the download is removed, and the report names the step.
1. **Verify the manifest and its signature** before anything is downloaded. Both come in the order.
   - desk-batch's own checks apply: at most 64 KiB, no repeated key or NaN, `format` exactly `ma-desk-batch/1`, 1 to 16 components, names and versions as `ma-update` takes them.
   - The signature is checked against `/etc/desk-host/batch-keys/*.pem`.
   - The order's `sha256` must equal the manifest's, so Platform and the signer agree on what was meant.
2. **Check the floor.** `seq` must be above the host's floor: the highest of the batch it has promoted, any it has halted or refused, and the host image's `/etc/desk-host/batch-baseline`. The baseline is the newest batch whose releases the image's pin holds, written by the bake as desk-batch's design note 2 has it for a desk (none means 0). So no old batch can be replayed onto a host.
3. **Choose what to fetch:** each component the host runs whose `{version, sha256}` isn't already in the store. The same version from another artifact refuses the whole batch, as `ma-update` does, and never replaces a release.
4. **Store admission** (ADR 0077 section 4): room for the new releases plus one copy in flight on the store, and for the download on the host's root.
5. **Download** each component through its presigned URL to `/var/lib/desk-host/dl/batch-<seq>/` on the host's root, hashed as it arrives. Its size and sha256 must equal the manifest's before it's opened. With less than 10 minutes left on the URLs, the host asks for new ones (`urlsWanted`).
6. **Install** with `desk-host-release`'s checked unpack, taking the hash from the verified manifest instead of `releases.pin`. Each release lands under a new name and is renamed into place, with its `artifact.sha256`, `image-id` and `tree.sha256`, as today.
   - **One change it needs: the unpack must stream.** Today it reads each image layer whole into memory (`blob()`), so it needs about the largest layer's size.
   - A JVM release's largest layer is probably 100 to 200 MB (an estimate), more than `desk-host-upd`'s 192 MiB.
   - Instead, the `.tgz`'s `image.tar` is unpacked onto the host's root beside the download, then each layer is hashed and extracted in 1 MiB reads.
7. **Keep the batch.**
   - The manifest and its signature go to `/var/lib/desk-host/batch/<seq>.json` and `.sig` on the host's root, so `desk-host-check` can verify them again at any time.
   - The store's `candidate` link is set for each component, and so is `state.json`'s `candidate`.

**A new host fetches nothing at its first boot.** It starts on its baked releases, and Platform names the fleet's current batch for its host-image version at its first hello.

#### 1.4 The store keeps the old release for rollback
- **Each component** keeps `releases/<svc>/<version>/`, as today, with three links like `ma-update`'s:
  - `current`: what every prepare and re-root copies, and what the host has promoted;
  - `previous`: the one before, kept so a rollback batch needs no download;
  - `candidate`: installed but not yet promoted (3.3).
- **A promote** moves `previous` to the old `current`, and `current` to the candidate.
- **A version is deleted** only when no link and no slot record names it.
- **`desk-host-release verify` and `desk-host-check releases` follow the host's state** (or `releases.pin` until a batch has been applied), instead of requiring the store to equal the template's `/opt/ma`.
- **The host's state** is `/var/lib/desk-host/batch/state.json` on its root, beside ADR 0077's `templates/state.json`. It holds `floor`, `current`, `previous`, `candidate` and `halted`, each `{seq, id, at, components}`, and `pending` while a fetch runs.

### 2. How a slot moves to a batch

#### 2.1 The choice: live, at idle, as a desk of its own does

| Way | When the new code first runs | What stops | How soon after the member leaves | New wall surface | Verdict |
|---|---|---|---|---|---|
| **At a stop** (ADR 0077's re-root, `rel/` only) | At the next wake, with the member waiting | Nothing extra: the copy and the swap run after the stop | At the desk's stop: up to 24 hours on a paid desk, never on one that doesn't stop | None | **The fallback (2.3)** |
| **An idle restart** (ADR 0077's) | Right after it, with nobody connected | The whole desk: Chromium closed over CDP and started again, and every sandbox | Once idle, but 0077 waits 3 days for a natural stop first | None | **Only in the fallback,** for a desk that never stops. At about 3 batches a week it would close every always-on desk's Chromium that often, for services that don't need it. 0077 keeps it for generations |
| **A live switch** (the counterpart of `ma-update --activate`) | Right after it, with nobody connected, smoke-tested before anyone returns | Only the changed services' sandboxes, a few seconds each. Chromium and every other sandbox keep running | Once idle: 10 minutes on an Alliance desk, 15 on a free desk, 1 hour on a paid one | A sandbox made inside a running slot (2.2), for the Security Analyst | **Chosen** |

**Is a sandbox restart at idle "never interrupt"? Yes, by the contract's own meaning.**
- Contract 13.2 lets a service batch restart services at idle, with Chromium kept running. A member who arrives part way through sees the normal connecting state.
- That's exactly what a desk of its own does under `desk-batch` today, so one rule holds for every member.
- A switch takes a few seconds per service (an estimate: a stop, `runc create`, then `deskd`'s hello 3 to 5 s after `runc start`). An idle restart takes 4 s to close Chromium and 19 s to a standard desk's hello.

**Why live beats the stop:**
- **The new code first runs with nobody waiting.** It's smoke-tested at idle and rolled back if it fails, before anyone is back. After a swap at a stop, its first run is a wake, with a member waiting through any rollback.
- **Every idle stop passes through the batch's idle window first,** since idle is half the idle-stop time. So every desk that Platform's sweep stops gets the batch before it stops.
- **It's lighter.** Only the changed components are copied and restarted, and Chromium and the member's tabs stay as they are.

#### 2.2 The live switch
`desk-host switch <k>` runs in the background in `desk-host-upd`, for a running slot whose record is behind the host's `current`, or behind the `candidate` while the slot is this host's canary (3.3).
1. **Wait for idle.**
   - Idle is read from the desk's `/run/desk/idle.json` on the host's side of the slot's share, by ADR 0077's shared module under RC-06's rules.
   - The rule is desk-batch's for a service batch: sessions, Agent runs and exports at 0 for the idle time, and the file fresh. `downloads` doesn't hold it, since Chromium keeps running, as on a desk of its own.
   - It also waits while the host's `cpu.pressure` `some avg10` is above 25% (the level ADR 0090 holds at), so a switch never runs starved, and while the slot's lock, a re-root or a pre-read is held.
2. **Copy** each changed component from the store into `rel/.new-<svc>`, with `version.env` for `deskd`, checked against the store's tree hash.
   - `rel/` is host-owned and outside the desk's root, so WALL-03 isn't touched.
   - The copy takes the host's copy turn (ADR 0077 section 4) and runs outside the slot's lock. A start or stop takes the lock at once, and the copy is dropped.
3. **Read idle again.** If the desk isn't idle, the copies wait for the next idle. Otherwise the report's `update.holdUntil` goes 15 minutes ahead and is renewed at each step.
4. **Switch each component in the manifest's order,** one at a time, under the slot's lock:
   - `runc kill TERM` its sandbox and wait (its `desk-svc` stop timeout, then KILL), then `runc delete`;
   - write the record's `switching`, then rename `rel/<svc>` to `rel/.old-<svc>` and `rel/.new-<svc>` to `rel/<svc>`. The record comes first so a cut-off is seen (3.4);
   - make the sandbox again exactly as `up` does: `svc-spec.py`, `runc create`, the mount-namespace bind from the pid runc names, `mounts.py svc <k> <svc>`, `runc start`. `mounts.py svc` is new: it puts that service's `/data` directory alone into the sandbox, from a fresh `fsmount` of the slot's volume in a private namespace, resolved with `openat2` as `vol` does;
   - the smoke test (3.2). A failure rolls back (3.1).
5. **Finish:** the record's `releases` and `batch` are written, the `.old-` copies are deleted without following links, and the hold is cleared.

`desk-stream` comes back in its on-demand state, as `ma-update`'s `try-restart` leaves it: at idle nobody is streaming. `desk-rtc`'s settings, the demux's mark and the slot's network aren't touched.

**What's new for the wall.** Today every sandbox is made before any of the desk's processes run. A switch makes one beside a running desk.
- What the new sandbox joins is the same and host-owned: the desk's user and network namespaces through the binds made at the desk's create (never `/proc/<pid>/ns`), its root from `rel/` or the template, the `/run` share directories by path in the host's tmpfs, and `/data` through a fresh clone.
- A desk's processes can't see the new sandbox's PID namespace, can't `setns` or `mount` (the unit filter, and AppArmor's `deny mount`), and have no `sys_ptrace` (the slot's profile). `runc init` runs under runc's own profile, not the slot's, and is non-dumpable until it execs.

This reasoning is the Security Analyst's to check before members get it. It's configuration review, and section 7's checks prove a switched sandbox's spec is the same as one made at a start.

#### 2.3 Without live switches: the stop path
Until the Security Analyst has read 2.2, or whenever Platform turns `liveSwitches` off, batches still reach slots through ADR 0077's machinery, with one more trigger:
- **A re-root at a stop** also runs when a slot's releases are behind the host's `current`. If its generation is current, the re-root touches `rel/` only:
  - the changed components are copied beside the old ones, outside the lock;
  - they're swapped in under the lock, only if the slot is still stopped with the same record and epoch;
  - the old ones are deleted.

  A wake that comes first starts on the old releases.
- **ADR 0077's idle restart** covers a desk that never stops, after the same wait (3 days, or 1 hour when urgent).
- **The new code then first runs at a wake,** and the member waits through any rollback (3.1): a few seconds per component, once (estimate).

#### 2.4 Prepares, fresh slots, wakes and moves
- **A prepare** copies the store's `current`, as today.
- **A re-root** (ADR 0077) keeps a component's `rel/` copy only when it's the store's `current` by tree hash, and copies the rest. So a slot re-rooted for a generation also catches up on its batch, with one interruption, not two.
- **Fresh slots** are copied again in the background after each promote, `rel/` only, before a start claims them.
- **`up` never copies to change releases.** It claims a fresh root whatever its releases (its generation must still match, per ADR 0077), and the slot switches at its next idle. A wake keeps its releases.
- **A stopped slot with a batch waiting** wakes on its old releases and switches at its next idle. That's contract 13.2's rule for a desk of its own: it "updates when its member next leaves".
- **A desk moved in** from another slot, host or instance gets the host's `current` at its prepare. Placement keeps that from being older than what the desk last ran (PB-5).

#### 2.5 What `idle.json` and `holdUntil` mean here
- **`idle.json` is `deskd`'s, unchanged.** The host reads it, not `desk-batch`, from the host's side of `/run/desk`, and only for its own decisions: when to switch, and ADR 0077's idle restarts and reboots.
- **The urgent clock is desk-batch's:** 24 hours of waiting, then 15 minutes with no input counts as idle, and after 72 hours, 60 s. A member who is connected under that clock sees a reconnect of a few seconds.
- **Once switching starts, it finishes,** whatever `idle.json` then says. `deskd` removes the file as it stops, and its `idleSince` starts fresh at its restart because it's held in memory. After a switch the file must come back, fresh and written after the switch began: that's part of `deskd`'s smoke test (3.2).
- **`holdUntil` comes from the host.** A shared desk has no `batch.sock`, so `deskd`'s heartbeat carries no batch state. The host's report carries the slot's `update.holdUntil` (ADR 0077's PU-1 field), 15 minutes ahead while a switch runs, and Platform's sweep doesn't stop the slot meanwhile (PB-4).

### 3. Ordering and rollback

#### 3.1 In a slot: the batch's rules
- **Copy everything, then switch in order.** Every changed component is copied (2.2 step 2) before the first switch.
  - A copy that fails switches nothing, and is tried again at the next idle.
  - After 3 failures at least an hour apart, as desk-batch allows, the slot reports the batch `failed`.
- **Once switching starts, it finishes.**
  - A component whose smoke test fails goes back to its `.old-` copy, and its sandbox is made again.
  - Then each component already switched goes back, in reverse order, each smoke-tested.
  - Every old copy stays until the slot's whole batch passes, so a rollback is renames and restarts, never a copy.
- **A rolled-back batch is never retried in that slot.** The slot's record says `rolled-back` for that `seq`. A later `seq` may still apply.
- **Data:** `deskd` and `desk-agent` stay expand-then-contract (runtime spec §6), so the previous release starts on data the new one migrated, as on a desk of its own.

#### 3.2 The smoke test, from the host's side
A release's own `health` can't run here. The host never runs release code outside the wall, and never enters a desk (WALL-02). So the host watches, for up to 90 s per component (180 s on a `free` slot, whose CPU is `cpu.idle`; both estimates):
- **Every component:** its sandbox is `running` (`runc state`), and its service, `desk-svc`'s child, keeps the same PID for 20 s, found from the host's own `/proc`. `desk-svc` restarts a service that exits, so a crashing release shows up as a new PID.
- **`deskd`:** also a fresh `idle.json` written by uid 1100 after the switch began (2.5).
- **`desk-rtc`:** its UDP and TCP listeners in the slot's network namespace, read from the host's `/proc/<pid>/net/`. These are the kernel's tables; nothing is entered.
- **`desk-stream`:** its `desk-svc` running and waiting. Stopped is healthy, as its own `health` says.

This is weaker than a desk's own `health`, which checks, for one, that `deskd`'s databases are open. Platform covers that: a canary is promoted only after `deskd`'s heartbeat shows the new version and its health (3.3, PB-3).

#### 3.3 On the host: a canary, then a promote or a halt
- **One slot goes first.** A batch installed as `candidate` goes to one slot, the first to be idle, and to no other until Platform sends `batch_promote`. Platform sends it once that desk's heartbeat names the new `deskd` and reports itself healthy, and has done so for 10 minutes. That wait is an estimate; it's no wait at all on the test host and for an urgent batch.
- **After a promote:**
  - the store's links move (1.4);
  - every running slot switches at its own idle;
  - fresh slots are copied again (2.4).
- **A slot that rolls back halts the batch on its host.**
  - The batch goes into `halted`: no other slot starts it, a candidate is never promoted, and the report says so at once.
  - Slots already on it stay, as desks that passed stay (contract 13.5).
  - Platform's fleet rules decide the rest. A halted canary counts as a rollback in its wave.
- **`batch_halt {seq}`** from Platform does the same on a host that's fine, for a batch found bad elsewhere.

#### 3.4 A switch cut off
A host reboot, a crash of `desk-host` or a kill can stop a switch part way. The record's `switching` names the component and both versions, and every old copy is still there.
- **If the slot stopped** (a reboot stops every slot): before its next start, each of the batch's components goes back to its old copy by rename, and the record names the old set again. The next idle tries again. A cut-off isn't the release's failure.
- **If the slot is still running** (only `desk-host`'s own process died): the next `desk-host switch` smoke-tests what's running, then finishes or rolls back as in 3.1, as desk-batch's `resume` does.

Either way, `desk-host-check releases` then finds every slot's `rel/` equal, by tree hash, to the set its record names.

#### 3.5 Going back
There's no rollback order, as for desks of their own. The System Engineer signs a rollback batch: a higher `seq` naming the older versions (contract 13.5). The store still holds them as `previous`, so nothing is downloaded, and each slot copies and switches at its idle as for any batch.

### 4. Waves, and ADR 0077's generations: one pipeline, two artifacts

**One mechanism on the host:**
- the order's shape, presigned GETs and `urlsWanted`;
- the download hashed as it arrives;
- store and root admission, and one copy at a time on the host, all in `desk-host-upd`, frozen during pre-reads;
- the candidate, the promote, the halt and Platform's kill switches;
- the idle read, `update.holdUntil` and the urgent clock;
- the report's fields and the alarms.

**Two artifacts and two ways a slot moves,** because they differ where it matters:

| | Template generation (ADR 0077) | Service batch (this ADR) |
|---|---|---|
| What it changes | Each slot's root: Debian's packages, Chromium among them | The services' release copies, outside the root |
| How it's made | On a builder, from `g1` and the security archive, about weekly per host-image version | From releases already published and passed; about 3 a week (estimate), the same batch for every host-image version |
| Signed with | `alias/ma-host-template`, format `ma-host-template/1` | `alias/ma-desk-batch`, format `ma-desk-batch/1`, the same signature desks of their own take |
| Ordered by | `gen`, per host-image version | `seq`, one sequence for every desk |
| How a slot moves | At a stop or an idle restart, so no library or Chromium changes under a running process | Live at idle: only the changed sandboxes restart |
| Going back | `template_rollback`, under `Last Version`'s rule | A rollback batch, with a higher `seq` |

**Waves (PB-3)** use contract 13.5's rings, with a host as the unit, since a host's slots share its store:
1. **Test.** The staging test host (ADR 0077's PU-3) takes the batch through its link. Every slot switches, and `e2e/` runs on a slot, `browser-session.spec.ts` included. A pass writes the batch's pass record for that host-image version, naming the generation it ran on.
2. **The owner's step** is the owner's own desk, a desk of its own, as today. No shared host waits on it beyond the batch's own hold.
3. **First group:** 10% of the shared hosts on each host-image version, at least one. Their desks count toward the batch's first group (10% of member desks, at least 5).
4. **Everyone else,** in the batch's waves.

The holds are 13.5's: 48 hours, then 24 hours a wave, and 1 hour each when urgent. So are the halts.

**The two artifacts never meet untested.**
- A batch's pass record names the generation it passed on, and a generation's pass record (ADR 0077) names the batch.
- Platform names a batch to a host only where the host's current generation is one the batch passed with, and a generation only where the host's current batch is one the generation passed with.
- When both roll at once, the test host passes the newest pair before the second one's waves open.
- A slot due for both at once takes both in one re-root (2.4).

### 5. Disk and I/O
- **Per slot,** `rel/` stays one set: 1.0 GB.
  - A switch holds the changed components twice, old and new, until the slot's batch passes: at most 1.0 GB more.
  - Only one slot copies at a time, because copies take turns. So this fits the store's existing allowance for one copy in flight (3.4 GB).
- **The store** keeps up to three versions of each component (`current`, `previous`, `candidate`).
  - That's at most 2.0 GB more than today's one set, when a batch changes all five twice running.
  - A `deskd` and `desk-agent` batch adds about 0.8 GB (an estimate).
- **The new size is ⌈(11.3 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB:** 41 GB at 6 slots (39 with ADR 0077, 36 today), and 80 GB at 14 (78 with 0077). That's PB-8, which replaces 0077's PU-6 formula.
- **The host's root:**
  - a download is at most 0.35 GB (the five `.tgz`, measured);
  - the streamed unpack keeps the image tars there too: about 1.4 GB in all at most (estimate), against 6.4 GB free;
  - a batch and 0077's template download (up to 1.2 GB) take turns, so they're never there together.
- **I/O stays in `desk-host-upd`,** at 0.1 of the baseline each way and frozen during a pre-read. So the host's own I/O stays within the 0.2 the desks' 0.8 leaves (ADR 0072 section 10), and no desk's share pays for a copy.
  - The restarted services read their new files through the desk's own share, as at any wake.
  - The pre-read reads a changed file whole, since its traced ranges are stale (ADR 0077 build step 1).
- **Memory:** a streamed unpack needs well under 0077's 128 MiB (estimate), and copies need little. Neither runs beside 0077's host apt.

### 6. What the platform must add (for the Platform Engineer)
- **PB-1: the host's hello and report** (`shared-host.md` sections 3 and 4). Every field is additive.
  - **The hello:** `updates.batches: 1`, meaning this host takes `batch_target`, and its `batchBaseline`.
  - **Per slot:**
    - `batch: {seq, state}`, with `state` one of `current`, `behind`, `copying`, `switching`, `rolled-back` or `failed`;
    - `releases`: each component's version;
    - ADR 0077's `update.holdUntil`.
  - **Per host:**
    - `batches`: `current`, `previous`, `candidate`, `halted` and `floor`, each `{seq, id, at}`;
    - `batchFetch: {seq, state, step, at, error}`, where `state` is like 0077's `fetch`: `downloading`, `verifying`, `installing`, `installed`, `failed`, `refused` or `urlsWanted`;
    - `templatePending: [{name, version}]` and `imagePending: {seq, image}`.
- **PB-2: orders.** Each runs once per ID, as orders do.
  - **`batch_target {targetId, seq, sha256, manifest, signature, urls: {<component>: <url>}, expiresAt, urgent}`.**
    - `manifest` is the base64 of its exact bytes, `signature` the base64 of the DER, and `sha256` the manifest's.
    - `urls` has a presigned GET for every store component the manifest names; the host fetches only what it lacks. With less than 10 minutes left, the host asks for new ones (`urlsWanted`).
    - The manifest travels in the order because it's at most 4 KiB, as the agent route returns it inline to `deskd`.
  - **`batch_promote {seq}`** and **`batch_halt {seq}`.**
  - **Two kill switches** in the reply's `updates` (ADR 0077's):
    - `batches` covers fetches and switches;
    - `liveSwitches` covers 2.2; when it's off, batches take the stop path (2.3).

    Each is true unless turned off. Platform sends `liveSwitches: false` until the Security Analyst has read 2.2.
- **PB-3: targets and waves** (section 4).
  - A target names one batch, by `seq` and the manifest's `sha256`, per host-image version.
  - The test host goes first. Its pass record is kept with Platform's batch record (contract 13.6), keyed by `{seq, hostImage, gen}`.
  - Then 10% of hosts, then the rest, with 13.5's holds and halts, and the promote rule in 3.3.
  - Never a `seq` at or below the host's floor. A new host gets the fleet's current batch at its first hello.
- **PB-4: the sweep.**
  - Honour a slot's `update.holdUntil` (ADR 0077's PU-8).
  - A `deskd` hello after a switch isn't activity, so a batch never pushes back a desk's idle stop. Desks of their own need the same.
- **PB-5: placement.** Place a desk only on a host whose `current` batch is at least the one the desk last ran.
  - Take that from its last slot's report, or from `appliedSeq` in the heartbeat of a desk of its own.
  - If no host qualifies, a host one batch behind may take the desk, since expand-then-contract makes one step back safe (contract 13.4). Never more than one.
- **PB-6: one path per desk.**
  - Never name a batch in a shared desk's own heartbeat. It has no `batch.sock`; take its update state from the host's report.
  - The office's "what changed" note (contract 13.7) comes from the batch record once the desk's slot reports the new `seq`.
  - Contract 13.4's oldest-batch rule (a contract step ships only when no cloud desk runs an older batch) counts every slot by its reported `seq`.
- **PB-7: alarms, to the System Engineer.**
  - At once: any `refused` (a signature, the floor, a hash or a version conflict), a slot `rolled-back`, or a halted candidate.
  - A fetch `failed` twice, or not installed within 2 hours.
  - A host's `current` behind the fleet's target by more than 2 days (1 hour when urgent), or a running slot `behind` for more than 7 days.
  - `templatePending` or `imagePending` for more than 7 days: a host image is due.
- **PB-8: the store's size,** ⌈(11.3 + SlotsPerHost × 4.4) ÷ 0.92⌉ GB, in place of ADR 0077's PU-6 formula.
- **PB-9: the admin console** shows each host's batches, its canary, and slots behind and since when. Members see none of it (contract 13.7).
- **No new key or permission.**
  - The batch key already exists for desks of their own. Its public half also goes into the host recipe, at `image/host/recipe/files/etc/desk-host/batch-keys/`.
  - The fetch is a presigned in-region GET, as for ADR 0077, so the host role doesn't change.

**For the Desk Engineer:**
- **DE-1:** on a shared desk, where `/run/desk/batch.sock` doesn't exist, make no batch offer and report no batch error. The heartbeat leaves `update` out.
- **DE-2:** if the heartbeat doesn't already carry `deskd`'s own version and its `/health` result (databases open), add them. Platform's promote reads them (3.3).
- Nothing else changes: `idle.json` as specified, expand-then-contract data, and a release that starts on its own in its sandbox, as today.

### 7. Checks for the build
**On a host.** `desk-host-check` gains or changes four checks. Each is broken in `verify.sh`'s and `verify-port.sh`'s mutation passes and seen to fail:

| Check | What it proves | The mutation it must catch |
|---|---|---|
| `batch-sig` (new) | `/etc/desk-host/batch-keys/` holds exactly the key the recipe pins, by name and SHA-256: P-256, root-owned, not group- or world-writable, with no drop-in directory. `batch-baseline` is readable. Every kept manifest still verifies | The pinned key replaced by another P-256 key. A drop-in directory added. One byte of a kept manifest changed |
| `releases` (rewritten) | The store's `current`, `previous` and `candidate` agree with `state.json` (or with the pin before any batch), and each release's tree hash is as installed. Every slot's `rel/<svc>` equals, by tree hash, the store's release its record names. Every running sandbox roots in its slot's `rel/<svc>` | One byte changed in a slot's `rel/deskd` copy. A record naming a version the store doesn't have |
| `svc-spec` (new) | Every running sandbox's `config.json` is what `svc-spec.py` makes for its slot now, field by field (namespaces by path, capabilities, seccomp, AppArmor profile, mounts, cgroup), whether `up` or a switch made it | A switch that adds a capability (a test flag) |
| `update-cgroup` (ADR 0077's, widened) | Batch fetches, unpacks and copies run in `desk-host-upd` | A copy's process moved into `desk-host`'s cgroup |

`verify.sh` and `verify-port.sh` also gain these steps. They run only on a test host (desk-host's `TEST` mode, which `no-test` fails on a member's host), with test batches signed by a throwaway key that only a test host trusts:

| Step | What it proves | The mutation it must catch |
|---|---|---|
| Fetch | A test batch of two published, passed releases of `deskd` and `desk-agent` is verified, downloaded, hashed, unpacked and installed as `candidate`. `current` and every slot are untouched | Installing straight into `current`, skipping the candidate. The step fails on the moved link |
| Refused before any download | A batch with no signature, another key's signature, a template header signed with the template test key and offered as a batch, a `seq` at or below the floor, or another `format` is refused, with nothing written | Signature checking turned off. The floor check turned off |
| Refused on its bytes | An artifact with one byte changed after signing is refused before it's opened, with nothing installed. The same version from another artifact is refused | Hash checking turned off |
| Memory | The largest test release unpacks within `desk-host-upd`'s `memory.max` (`memory.peak` read) | The whole-layer read put back. The unpack then goes over the cap and the step fails |
| Live switch | Slot 1, idle, is copied and switched in the manifest's order. Chromium's PID, a cookie set 8 s before and its tabs are unchanged, and so are the other sandboxes' PIDs. Slot 2's processes and cgroups are untouched. `deskd`'s fresh `idle.json` and its hello carry the new version. The record, the report and `releases` are right, the old copies are gone, and `holdUntil` was ahead throughout | `idle.json` with `sessions: 1`. A switch then fails the step |
| Not while busy | A switch waits while `cpu.pressure` is held, a session is open, or a re-root holds the copy turn | The pressure rule turned off |
| Smoke failure | A test release whose service exits at once is put back, then the component before it, in reverse, each smoke-tested. The slot is `rolled-back`, the `seq` is refused after, the batch is halted on the host, and slot 2 never starts it | Rollback turned off |
| Canary and promote | Before `batch_promote`, only one slot switches. After it, slot 2 switches at its idle, a fresh slot is copied again, and `current` moves | The canary limit turned off |
| A wake during a copy | The start begins within 2 s on the old releases, and the copy is dropped | A test flag that holds the slot's lock through the copy |
| Cut off | `CRASH_AT=switch-swap`, then a stop: the next start runs the old set, its tree hashes matching the record. `CRASH_AT=switch-start` with the slot left running: the next switch finishes or rolls back | The record's `switching` written after the renames instead of before. The next start then runs a mixed set and the step fails |
| The stop path | With `liveSwitches` off, a `rel/`-only re-root runs at a stop, and the next start runs the new releases with ADR 0035's cookie, tabs and saved password kept | A re-root that keeps a `rel/` copy without its tree-hash check, with one byte changed in it |
| Store room | A fetch without room on the store or the root refuses before writing | The room check turned off |
| The switch's file use | An `strace -f` of a switch shows no call on a path a desk can write that a link could redirect (run 4's audit; configuration review only) | A test flag that writes `version.env` through the desk's root. The audit then finds the call |

**On the workstation:** `tools/batch/` is unchanged. A parity test runs desk-batch's test vectors through the host's copy of its checks, so the two can't drift.

No check or step probes the wall. Isolation is checked by configuration review and standard audit tools only.

### 8. What it costs
Every figure here is an estimate from the measured sizes and rates above; none has been run.

**Per batch, on one host with 6 slots:**

| | `deskd` alone | `deskd` and `desk-agent` (typical) | All five |
|---|---|---|---|
| Download to the host's root | 0.13 GB, about 8 s | 0.27 GB, about 17 s | 0.35 GB, about 23 s |
| Unpack into the store | About 0.36 GB, 25 s | About 0.76 GB, 50 s | 1.0 GB, about 65 s |
| Copies into 6 slots, one at a time, each at its slot's idle | 0.36 GB each, about 23 s | 0.76 GB each, about 49 s | 1.0 GB each, about 64 s |
| Switches, each at its slot's idle | One sandbox, about 5 to 10 s | Two, about 10 to 20 s | Five, about 20 to 40 s |
| Written in all | About 3.0 GB | About 6.4 GB | About 8.4 GB |
| CPU, in `desk-host-upd` at `cpu.idle`, plus the services' starts in each desk's own share | Under 1 CPU-minute | 1 to 2 CPU-minutes | 2 to 4 CPU-minutes |

**Per host per month, at about 13 batches (3 a week), mostly the typical case:**
- **I/O:** about 80 GB written, all within the update cap and no desk's share. gp3 charges nothing per I/O within its baseline.
- **CPU:** 15 to 30 CPU-minutes of 175,200, at most 0.02%.
- **Downloads:** about 3.5 GB, in-region and inbound, with no transfer charge. The S3 GETs come to under a cent.
- **Disk:** the store's 2.0 GB more, **about $0.16 a month.**
- **What members see:** nothing, routinely. Under the urgent clock, a reconnect of a few seconds per batch.

**For the whole fleet:**
- No builder, since batches use releases already built and tested.
- No new key, since the batch key already exists for desks of their own (about $1 a month, not new).
- The test host's runs, if it runs only for them: about 13 a month × 30 minutes × $0.1632 an hour, about $1.06.

The option this replaces, a host image per batch, would cost a bake and `verify.sh` (about 80 minutes) and a move of every desk, 13 times a month.

## The build
One branch, `sub/host-batches`. Agent hours are estimated from this repo's pace.
1. **The verifier and the key (1 to 1.5 h).**
   - `batchsig.py` in the host's lib: desk-batch's `strict_json`, `check_manifest`, `decode_signature`, `is_p256` and `verify_signature`, copied, not imported, because desk-batch belongs to the desk image and isn't on a host's root.
   - `image/tests/test_batch_parity.py`, which runs the same vectors through both.
   - `/etc/desk-host/batch-keys/` holding the batch key's public half, pinned in the host recipe; `batch-baseline` written by `bake.sh`; the `batch-sig` check.
2. **The fetch and the store (2 to 2.5 h; less on ADR 0077's fetch).**
   - `desk-host-batch fetch`, on 0077's download with hashing, its admission and its copy turn.
   - `desk-host-release install --manifest <seq>`, with the streamed unpack.
   - The `previous` and `candidate` links, the refusal of a version from another artifact, and retention.
   - `verify` and the `releases` check following `state.json`, plus `templatePending` and `imagePending`.
3. **The live switch (3 to 4 h).**
   - `desk-host switch <k>`, and `mounts.py svc`.
   - The record's `releases`, `batch` and `switching`, and the cut-off rule.
   - `CRASH_AT=switch-copy|switch-swap|switch-start`, and `update.holdUntil`.
4. **The smoke test (1 to 1.5 h).** 3.2's host-side signals as a module, with unit tests on fake `/proc` trees.
5. **The canary, promote, halt and the link (1.5 to 2 h).** PB-1's fields and PB-2's orders and switches, in `desk-host-link` and `report.py`, tested in `test_link.py` against `fake_platform.py`.
6. **Prepares, re-roots and fresh slots (1 h).**
   - Copies from `current`, and a re-root that keeps only `current` copies.
   - The `rel/`-only re-root for 2.3.
   - Fresh slots copied again after a promote.
7. **Checks (2 to 3 h).** Section 7's host checks and steps in `verify.sh` and `verify-port.sh`, with their mutations.
8. **Docs (1 h).**
   - `image/host/README.md` ("The release store" and "Updates") and `image/host/RELEASES.md`.
   - `docs/interfaces/desk-runtime.md` §6 and §6.1: a shared desk takes batches through its host, and §6's line that on a shared host "only `load_image` changes" is replaced.
   - Pointers in contract 13.9's last item and ADR 0072 section 13.
   - A runbook section for a batch on the test host, the status file, and the asks sent to Platform and Desk.
9. **The floors:**
   - a lab host from the current host AMI with the branch laid over it (`VERIFY_OVERLAY`, as `sub/u77-host` does), with two slots running real desks;
   - a real batch of two published, passed releases, signed with a dev key: the fetch, the canary, a promote, the second slot, a forced smoke failure and a wake during a copy;
   - section 8's numbers measured: about 1 to 2 hours, under $1;
   - then a host bake and both `verify` runs, about 40 minutes each.

In all, about 13 to 17 agent hours plus those floors. Not part of this build: the Security Analyst's read of 2.2 and 1.3, Platform's PB-1 to PB-9, and the Desk Engineer's DE-1 and DE-2.

**Files shared with ADR 0077's host half (`sub/u77-host`):**

| File | ADR 0077's host half | This build |
|---|---|---|
| `desk-host` | Generations, re-roots, idle restarts, the reboot, `$T` per slot | `switch`; prepare and re-root copying `current`; the record's new fields |
| `desk-host-link`, `tests/fake_platform.py`, `tests/test_link.py` | PU-1's fields, PU-2's orders | PB-1's fields, PB-2's orders |
| `report.py` | Per-slot and per-host template fields | Batch fields |
| `desk-host-check` | `templates`, `template-sig`, `update-cgroup`, `host-apt` | `batch-sig`, `releases`, `svc-spec`; `update-cgroup` widened |
| `desk-host-release` | Its checked extraction, reused for templates | `install --manifest`, the streamed unpack, links, retention |
| `mounts.py` | `peek` | `svc` |
| `preread.py` | Reads a changed file whole | Uses that |
| `svc-spec.py` | The slot's generation in place of `$T` | Nothing: `rel/<svc>` keeps its path |
| The update cgroup's units, the idle module, the fetch module | Made | Used |
| `recipe/build.sh`, `bake.sh` | `template-keys/`, `g1` | `batch-keys/`, `batch-baseline` |
| `verify.sh`, `verify-port.sh` | Its steps | Its steps |
| `image/host/README.md`, `image/host/RELEASES.md`, `desk-runtime.md` | "Updates" | The release store, and batches in "Updates" |

**Sequence:** build this after `sub/u77-host` merges, rebased on it. It reuses the fetch, the admission, the update cgroup, the idle module, the candidate state and the link's shape, and both rewrite `desk-host`'s re-root and the link. Four pieces touch nothing 0077 changes heavily, and can start at once:
- step 1, the verifier;
- step 2's store half, in step with 0077's reuse of the extractor;
- step 4, the smoke module;
- `mounts.py svc`.

## What stays unproven
- **A sandbox made inside a running slot.** It has never run, and the wall's reasoning (2.2) waits for the Security Analyst. So does a second `fsmount` of an already mounted volume in a private namespace: the kernel should hand back the same superblock, but it hasn't been run here.
- **The switch's times.** A few seconds per service is an estimate from a whole start (`deskd`'s hello 3 to 5 s after `runc start`), not from one sandbox.
- **What the host-side smoke test misses.** A `deskd` that runs but can't open its databases passes it. Platform's promote catches that, and only on the canary.
- **Section 5's and 8's figures:** the per-component unpacked sizes, the streamed unpack's memory, and whether the largest layer really exceeds 192 MiB.
- **What share of shared desks reach idle** (contract 13.9), and what a member arriving part way through a switch sees.
- **`desk-agent`'s in-RAM LLM key.** A switch loses it, as a stop does (contract 13.8). The key envelopes must come before any batch restarts `desk-agent` on members' desks of either kind.
- **A JVM's start on a `free` slot when the host is busy.** The 180 s smoke window is a guess.
- **Platform's and Desk's halves:** PB-1 to PB-9, DE-1 and DE-2. None is built, and the test host's pass records per `{seq, hostImage, gen}` don't exist yet.
- **A real KMS signature from `alias/ma-desk-batch` checked on a host.** The desk's own proof applies, since the code is the same.

## Alternatives rejected
- **Running `desk-batch` and `ma-update` inside each slot** (ADR 0072 section 13's line). Since RC-01 the services run from the host's store, so it would change nothing that runs. It would also need egress, Docker and root inside the wall, and would download and unpack each release six times, through each desk's root-write share (2.08 MB/s; 0.42 MB/s on a free desk).
- **Releases inside ADR 0077's generations.** Every batch would cost a builder run (40 to 60 minutes, $0.11 to $0.17) and a 2.3 GB re-root per slot, at stops only. Services would ride the key for root content. And a generation is `g1` plus the security archive by design, so that each can be rebuilt from its AMI alone.
- **A host image per batch** (option A): a bake and `verify.sh` (about 80 minutes) and a move of every desk, a few times a week.
- **One shared read-only release tree for all slots.** Desks would share its page cache, which ADR 0072 section 10 refuses (Flush+Reload).
- **Starting the new service beside the old one, then cutting over.** That's twice the memory inside the desk's cap (`deskd` alone has 512 MiB), clashing sockets in the shared `/run/desk`, and nothing gained at idle.
- **A second key, or a host-only manifest:** see section 1's table.
- **Unsigned pins from Platform:** see section 1's table.
- **A swap at every stop instead of a live switch:** see 2.1. It's kept as the fallback.

## Consequences
- **Shared desks take the same signed batches as desks of their own,** in the same waves and under the same idle rule: within an hour of their member leaving, 10 minutes on an Alliance desk, 15 on a free one. Chromium keeps running, and routinely members see nothing.
- **A host runs no release code outside the wall,** and needs no new key or permission. Its image bakes one more public key and a baseline.
- **`deskd` fixes reach shared desks without a host image,** the free tier's among them. A host image is still needed for the template's own components (`desk-agent-filter`), for a new desk image, and in ADR 0077's cases.
- **This replaces two lines:** ADR 0072 section 13's "Service batches stay per desk, inside its container", and the runtime spec §6's "On a shared host ... only `load_image` changes". On a shared host, `ma-update` doesn't run; the host's store takes the batch.
- **The slot store grows by 2.0 GB a host** (PB-8).
- **Until this and ADR 0077's host half are built,** shared hosts in prod run the releases their host image baked, and a fix reaches them only with a new host image and a drain.
