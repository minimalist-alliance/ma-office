# Shared-host image releases

Test bakes only (`ma-desk-test-host-*`): none is a release. Each is deleted with `image/prune.sh delete <ami>` once a later bake
replaces it.

## For the next host bake (unreleased): a start on a slot with no record, and the JVMs' archives in a slot (`sub/host-up-norecord`)

*Not a released row; nothing baked.* Two faults host 0.1.15's bake found (`docs/sub-status/host-up-norecord.md`), on the main line only:
- **`desk-host up` on a slot with no record exited 1 with no message** (0.1.12 to 0.1.15): `batch_cutoff`'s read of the record had no
  fallback, so `set -e` ended `desk-host` before `up` could prepare the slot, and a prepare refused for room (it removes the record first)
  left a slot every later start failed on. A slot with no record has no cut-off to put back (ADR 0072 WALL-04, ADR 0078 3.4), so `up`
  prepares it; a cut-off that can't be put back refuses, saying why, and one cut between its two renames is now put back. Every refusal on
  that path says why on stderr (up's after a prepare names the exit, 75 for room; `prepare`'s eight silent steps say which). The other
  reads `set -e` could end silently, each fixed or judged in the status doc's table: `conf()` with no `desk-host.conf` (both scripts),
  `reroot` on a slot with no record, a record gone under `reroot` or `relroot`, `desk-host-boot`'s port mode with no default route.
- **Cold wakes 7.4 s (standard) and 12.3 s (free) slower to hello than the 0.1.11 line** (3 wakes per class per image): ADR 0078's
  streamed release unpack (0.1.12 on) wrote every file at its unpack time, so deskd's and desk-agent's AppCDS archives, which record each
  jar's time, were refused at every start, silently. `desk-host-release` keeps each member's time now (`tree.sha256` unchanged).
- **Tests:** `tests/test_up_norecord.py` (10; 8 fail on 0.1.15's scripts), `tests/test_batches.py` `test_every_file_keeps_its_layers_mtime`
  (fails on 0.1.15's), `tests/test_prepare.py` (a refused prepare leaves no record). `verify.sh` and `verify-port.sh` section 9
  (`verify-wake.sh`): a start with the record moved aside, and both JVMs mapping their archives, each with its mutation (0.1.15's
  `desk-host`; the slot's jars touched to now).
- **Found, not fixed:** `templates.py`'s `copy_tree` (re-roots) and `unpack` (fetched generations) drop file times too (unmeasured; `g1`
  is copied by `tar -p`).

## For host 0.1.15 (baked as 0.1.15, `<ami>`, below): desk image 0.3.5's asks in a slot (`sub/host-parity-035`)

*Not a released row.* A slot's root is the template (the desk image's root), but `desk-init.py` and `svc-spec.py` start its services, not systemd, so two of 0.3.5's asks did nothing in a slot (`docs/sub-status/host-parity-035.md`):
- **Links out:** `/run/desk-links` is a slot share (`wallspec.py`, `desk:kiosk` 2750 as the template's tmpfiles line), made by the host before any desk process and bound into the desk and `deskd`'s sandbox (`svc-spec.py`), so `deskd` binds `links.sock` and Chromium's stand-in reaches it. Before: neither, and the stand-in exited 3.
- **The Browser's policy:** `desk-init` runs the template's `desk-browser-policy` as the desk's root before every start of Chromium (crash restarts too), as `desk-browser.service`'s `ExecStartPre=+`; a helper that fails, can't run or doesn't end in 30 s is no start, tried again after the Browser's back-off. Before: never run, so a teen's slot had no lock and an adult's no allowlist.
- JPEG XL off and OpenRouter come with the template (confirmed, unchanged). Not done: `desk-adblock render` and `apply` in a slot (a member's per-site switch, from desk 0.3.1).
- Tests: `image/tests/test_host_slot_parity.py`, 15; 11 fail on 0.1.14's host files (the 4 that pass confirm the template's parts). `verify.sh` and `verify-port.sh` section 8 (`verify-parity.sh`) with its mutations. Needs a template with desk 0.3.5's files and a `deskd` with links out (`2026.11.11-90528b5` or later).

## For the next host bake (unreleased): the slot's init never acts on a name inside a desk user's folder (`sub/slot-datadirs`; on the 0.1.11 line as 0.1.11.2)

*Not a released row.* EXP-7's class (the desk image's `desk-datadirs`, `3db49997`) in a shared host's slot init, `desk-init.py`, which runs as the desk's root in its slot (an unprivileged uid on the host: root of that member's own desk, not of the host). `datadirs()` made `/data/browser/profile`, `downloads` and `home` with `os.makedirs`, then `chown` and `chmod` by name, so a link the Browser's user (`kiosk`) put at one of them was followed at the slot's next start and `kiosk` got the directory it named (one of the desk's root's). The same pattern was in three more places: deskd's copy of the volume record (`install -o desk` as root into deskd's `/data/desk`), `units.sock` (bound, then chowned and chmodded by name in the slot's `/run/desk`, `rtc:desk` 0770) and desk-audio's `/run/desk-audio/pulse` (removed, then made by name in desk-snd's share); the profile's `Preferences` was read by name at every stop (a FIFO held the stop, a link was read through). Now: inside a user's folder that user acts (`as_user`: `setpriv`, no new privileges); `units.sock` is bound with the thread's filesystem uid and gid set to `desk` and its mode set on the socket first; `Preferences` is read `O_NOFOLLOW` at each step, `O_NONBLOCK`, a regular file of at most 16 MiB. Owners and modes on a normal volume are as before; a folder `kiosk` can't make is said in the desk's log and never stops the start. The audit of every other root write in `desk-init.py`, `mounts.py`, `svc-spec.py` and the host's own scripts that touch a slot's volume or `/run/desk-host/<k>`: `docs/sub-status/slot-datadirs.md` (no other fix needed). Tests: `image/tests/test_host_slot_links.py` (9 without root, 8 of which fail on 0.1.11.1's `desk-init`; 7 as root in a throwaway container, 5 of which fail there: kiosk, desk-snd and deskd each handed a root directory or file, and the FIFO holding the stop); verify's section 7 (`verify-links.sh`) with its mutation, 0.1.11.1's `desk-init`.

## For host 0.1.14 (baked as 0.1.14, `<ami>`, superseded by 0.1.15): `/run/desk-host` stays 711 through a host stop, and the link signs for the API's region (`sub/host-dirs`)

*Not a released row.* Two fixes, each with its own commit and tests (`docs/sub-status/host-dirs.md`):
- **The `dirs` mutation's failed restore on 0.1.13 (`5c8734d4`):** `desk-host stop-all` (`desk-host-shutdown`'s stop) ran
  `install -d -m 755 /run/desk-host`. GNU `install -d -m` sets the mode of a directory that already exists (unlike `mkdir -p`), so
  the stop turned the recipe's 711 into 755, and `resume` (the unit's start) left it. On a host whose `desk-host-shutdown` was stopped
  and started without a reboot (verify's `boot` mutation, just before `dirs`; verify-port's step 4d), `dirs` then failed, and because
  `dirs` is in `--quick`, `desk-host up` refused every start ("the host's own checks fail"): the cause of 0.1.13's two `svc-spec`
  "broken -> PASS" lines too (slot 1 never started, so nothing was broken). Now `stop-all` and `resume` set 711; `up` sets
  `/run/desk-host/share` 711 directly (it went 755 for an instant between two lines, which another slot's `dirs` could read); and
  `desk-host-boot` sets every directory `dirs` requires (`/srv/desk-host/releases`, `templates` and `/var/lib/desk-host/batch` added),
  so a host whose mode drifted is put right by its boot. The `dirs` check and its mutation are unchanged. Tests:
  `image/tests/test_host_stop_all.py` (stop-all and resume keep 711 and resume puts a drift right; fails on 0.1.13's `desk-host`),
  `image/tests/test_host_dirs.py` (every recipe line that sets a checked directory sets `dirs`'s mode, the boot sets each required one,
  and `install -d -m` changes an existing mode; fails on 0.1.13's scripts at the two lines and the boot's three gaps).
- **The link's signing region (`3e7828da`, S-120):** `desk-host-link` signed SigV4 for the instance's region, but Platform's `host-api.`
  names are REGIONAL API Gateway domains in us-east-1 only, so a us-west-2 copy of 0.1.11 was refused every hello (403 signature). It now
  signs for `LINK_API_REGION_staging` / `LINK_API_REGION_prod` (both `us-east-1`, `desk-host.conf`); `LINK_API_REGION` overrides them
  with a test fake only; `desk-host-check link` pins both, with a second break in both verify scripts. The stand-in still says the
  instance's region. Tests: `tests/test_link.py` (a us-west-2 host's hello accepted by the fake, which checks us-east-1; fails on the old
  link). The audit of the host's other regional calls is in the status doc: none other signs or assumes a region.

## For host 0.1.13 (unreleased): a prepare never fills the slot store (`sub/prepare-space`; on the 0.1.11 line as 0.1.11.1)

*Not a released row; nothing baked from this line.* Platform's reclaim wave on staging (2026-11-11): six slots prepared again at once
filled two 0.1.9 hosts' 36 GB stores, and desks placed after it failed with "No space left on device". Three faults in `desk-host`
`prepare`, all fixed (`image/host/README.md`, "The store's room"):
- **The old root went last:** each prepare copied its new root beside the old one (about 3.3 GB each with `rel/`). Now the old root, which
  no record names once the prepare removes the record, is deleted before the copy.
- **Only a per-slot lock:** N prepares at once held N extra roots, while the store is sized for one. Now every copy onto the store holds
  the host's copy turn: a prepare's from its room check to its rename (the turn `main` already had covered the copy alone), and the fresh
  `rel/` copies of a re-root's swap and of a cut-off switch, which had none. In the turn a prepare copies only when the store holds one
  more root beside the other slots' quota room and `PREP_SPARE_MB` (512, `desk-host.conf`); else exit 75, "refused for room", nothing
  made (`desk-host-template room`, `templates.prepare_room`). A dead prepare's tree is removed in the turn.
- **A failure kept its partial:** an ENOSPC in `tar`, `shift.py` or `cp` returned without removing the tree. Now `prep_drop` removes it on
  every way out (and on SIGTERM), never following links.
- **Also:** Platform's `prepare_slot` ran `desk-host prepare` in the link's process group, which it then wrote as the copy turn's holder,
  so a start that took the turn from it would have sent SIGTERM to the link itself. It now runs in its own group (`setsid`).
- **The room check counts each inode once** (`releases_once`): tar and `cp -a` keep hard links, and deskd's and desk-agent's releases have
  116 each, so `sizes()["releases"]` reads 3.5 GB for 1.1 GB. `store_admission` still uses it (conservative by about 2.4 GB).
- **Tests:** `tests/test_prepare.py` (11: each fault on fake trees, the room estimate, a start taking the turn, and the wave on a
  size-capped tmpfs, with 0.1.11's prepare failing it); `verify-wave.sh`, both verify scripts' last step, with the same mutation. Baked and proven on the 0.1.11
  line as 0.1.11.1 (below); this line's own verify runs at its next bake.

## For the next bake (unreleased): the template key pinned (ADR 0077, PU-9)

*Not a released row.* Platform's `alias/ma-host-template` (KMS, `ECC_NIST_P256`, `SIGN_VERIFY`; `kms:Sign` for the operator user only) exists. Its public half is `files/etc/desk-host/template-keys/ma-host-template-2026-11.pem` (sha256 `d8929c31…c0ec`), so `build.sh` pins it and a host built from this tree takes only generations it signed (`desk-host-check template-sig`). A probe signed by the key verified against this file (2026-11-11). Until a host image carries it, every artifact is refused.

**The key's trust anchor (`sub/template-key-anchor`, 2026-11-11; the Security Analyst's Medium on the ADR 0077/0078 read):** until
this, `build.sh` pinned whatever `.pem` was staged, so a wrong key at bake would have been baked in and trusted, and `template-sig`,
which compares the directory only with that self-made pin, couldn't see it. Now:
- **The anchor is committed:** `recipe/template-keys.sha256`, `d8929c31…c0ec  ma-host-template-2026-11.pem`.
- **`build.sh` stops** unless the staged `template-keys/` (before it makes anything) and the installed `/etc/desk-host/template-keys/`
  (before it pins) hold exactly the anchor's names, each a regular file (no link), with its SHA-256, P-256 (`recipe/template-key-check`).
  The pin is the anchor itself. The "none until Platform's key exists" path is gone: a bake with no template key fails.
- **`bake.sh` stops** before launching anything unless the committed key is the anchor's and is `alias/ma-host-template`'s public half
  by KMS `GetPublicKey` (DER compared). The agent role can call it, and it matched (DER sha256 `df959ad6…`, 2026-11-11). Without
  `kms:GetPublicKey` it skips only that half, with a `WARNING` naming the permission.
- **Both verify scripts, step 2b** (`verify-template-anchor.sh`): the host's pin must be the committed anchor and its keys exactly the
  anchor's; the mutation (the key and pin swapped together for another P-256 key, which `template-sig` alone passes) must fail it.
  0.1.12 fails it (no key pinned); 0.1.11, 0.1.11.1 and earlier are a `SKIP` (no template path). 0.1.13's bake pinned `ma-host-template-2026-11.pem`
  from the same commit's file, so it should pass, unproven until a verify from this tree runs.
- **Tests:** `image/tests/test_host_template_anchor.py` (31, no root, no AWS): the check on fake staged directories (the right key
  passes; a wrong key, an extra file, a dot file, a directory, a missing file or directory, a link, a linked directory, a P-384 key, a
  private key, a bad or empty anchor each fail), `build.sh`'s order, `bake.sh`'s KMS step with a fake `aws` (match, mismatch, denied,
  another error), and the verify step on fake hosts shaped as 0.1.13, 0.1.12 and 0.1.11 with its mutation.
- **Not done:** baked or run on a host (the next host bake carries it). The batch key's `cmp` still skips when the desk recipe isn't
  staged (the Analyst's Low; `bake.sh` always stages it).

## For host 0.1.13 (unreleased): a check on the host's own directories (`sub/host-dir-modes`)

*Not a released row; nothing baked.* **`desk-host-check dirs`** (also in `--quick`, so `desk-host up` runs it before every start) judges
the owner, group and mode of every directory desk-host and runc need, each taken from the line that sets it: `/srv/desk-host` 711,
its `slots`, `releases`, `templates` 711; `/var/lib/desk-host` 711, `slots` 700, `batch` 755, `egress` 700 (if present); `/var/log/desk-host`
755; `/run/desk-host` 711, `lock` 700; where they exist, `share` 711, `ns`, `net`, `slotstate`, `batch`, `reroot` 700, `/run/desk-dmx` 755 and
`slots` 750 root:desk-dmx; each numbered slot's `slots/<k>` and `svc` 711, `/run/desk-host/<k>` 755 and `share/<k>` 711. All root:root.
Why: a mutation left `/srv/desk-host` at 700 and every `runc create` was refused (`docs/sub-status/host-batches.md`, finding 6), and nothing
watched it. Both verify scripts' mutation passes gain `m dirs "chmod 700 /srv/desk-host"` (one more check and mutation each).
Unit tests only: `image/tests/test_host_dirs.py`. **Unproven on a booted host:** a real host's modes could differ from the recipe's
somewhere I read only in the code (the optional run-time directories), which the next `verify.sh` would show.

## Host 0.1.13 (2026-11-11, TEST bake): 0.1.12 superseded; the first bake with everything on `main` in one piece

`<ami>` (`ma-desk-test-host-0.1.13`), baked from `main` `bac256ef`. **A TEST bake: not for staging or prod** until the Security Analyst's reads of ADR 0077 and 0078 and Platform's PU and PB asks. 0.1.11 (then 0.1.11.1 once recorded) stays the image to use. It carries 0.1.12's content (ADR 0078, `liveSwitches` off by default, the batch key `.pem`) plus ADR 0077's host half with the template key pinned, `desk-host-check dirs`, the `prepare` space fix and the wave step. **0.1.12's AMI (`<ami>`) is superseded by it** and its verify runs, which failed on script bugs since fixed, stand as history. Tags: 0.1.11's keys including `DeskSizeClasses=1`.
**`verify.sh`: 63 passed, 1 failed (exit 1).** The failing step is the mutation pass (40 mutations, 40 checks): `dirs` read "broken -> FAIL, restored -> FAIL" and `svc-spec` (both breaks) "broken -> PASS" because slot 1 would not start ("the host's own checks fail: refused"), which follows from `dirs` still failing. At the end, `FAIL host dirs: /run/desk-host is 0:0 mode 755, not 0:0 mode 711`. `desk-host-boot` runs `install -d -m 711 /run/desk-host`, which does not change the mode of a directory that already exists. Who made it 755 during the run is unproven. `verify-port.sh` was not run (a failure stops the bake's proof). Details and what is unproven: `docs/sub-status/host-0.1.13.md`.

## For host 0.1.12 (unreleased): service batches on shared hosts (`sub/host-batches`, ADR 0078), and desk-rtc's stream profile

*Not a released row; nothing baked.* A host image carrying the live switch waits for the Security Analyst's read of ADR 0078 2.2 (a
sandbox made inside a running slot) and 1.3 (the host's fetch and unpack as root); until then Platform sends `liveSwitches: false`,
and the host takes batches only at a stop. `README.md` "Service batches" and "The release store", `docs/interfaces/desk-runtime.md`
section 13, runbook `docs/runbooks/host-batches.md`, `docs/sub-status/host-batches.md`.
- **The same signed batch as a desk of its own:** `/etc/desk-host/batch-keys/ma-desk-batch-2026-11.pem` (alias/ma-desk-batch's public
  half, the desk image's), pinned in `batch-keys.sha256`; `batch-baseline` from `bake.sh`'s `BATCH_BASELINE`. `batchsig.py` (desk-batch's
  checks, copied), `batches.py`, `smoke.py`, the command `desk-host-batch`.
- **The store** keeps `current`, `previous` and `candidate`; `desk-host-release install --manifest` (a batch's, the hash from the
  signed manifest, checked again here), a **streamed unpack** (no image layer read whole; the image tar on the host's root), the same
  version from another artifact refused and never replaced; `verify` and `desk-host-check releases` follow the host's batch state, not
  the template's `/opt/ma` (ADR 0078's three code findings).
- **`desk-host switch <k>`** (live at idle, in `desk-host-upd`, the changed services' sandboxes only, `mounts.py svc`), **`relroot <k>`**
  (at a stop), `switch --verify` (the first run after it), the cut-off rule, the canary, promote and halt; `after-stop`.
- **The link:** PB-1's hello and report fields, PB-2's `batch_target`, `batch_promote`, `batch_halt`, the kill switches `batches` and
  `liveSwitches` (off unless Platform says true).
- **Checks:** `batch-sig` and `svc-spec` (new), `releases` (rewritten), `update-cgroup` (widened): 39 in all, each broken in both verify
  scripts' mutation passes, with second breaks. `desk-host resandbox` (a TEST host's) remakes one sandbox by the switch's own steps.
- **`desk-rtc` sees the stream profile:** `/run/desk-host/<k>/egress` read-only at `/run/desk-egress` in its sandbox too (S-29's
  follow-up), so `desk-rtc` 0.5.1 says a member's level is held on a capped slot; `svc-spec` checks it.
- **Verify's `tmut` (both scripts, from 0.1.11's work)** no longer chmods the slot store's root to 700 at its restore (it ran
  `install -d` on its own bind of `/srv/desk-host`), which left every later `runc create` on the host refused.
- **Tests:** `tests/test_batches.py` (28), `tests/test_link.py`'s `LinkBatchTest` (11), `image/tests/test_batch_parity.py` (5).
  **Lab** (host 0.1.10's AMI with this tree laid over it, `image/lab/host-batches/`, never a release proof): the status doc.
  **Overlay verify** (the same AMI, `VERIFY_OVERLAY`, lab only): `verify-port.sh` 63 of 63, its mutation pass 39 of 39
  (`evidence/verify-port-overlay-hb78-<ami>.txt`); `verify.sh` not run. A bake of 0.1.12 runs both on its own AMI.

## For the next bake, 0.1.11 (unreleased): template generations, the signed fetch, re-roots, idle restarts, the host's apt and reboot (`sub/u77-host`, ADR 0077's member-host half)

*Not a released row; nothing baked.* A host image carrying this waits for the Security Analyst's read of the signing, the fetch and
unpack, and the host's apt (ADR 0077). `README.md` "Updates", `docs/interfaces/desk-runtime.md` section 12, `docs/sub-status/u77-host.md`.
- **Generations** on the store, `templates/<gen>/`, each read-only, `.complete` with `gen`, `chromium`, `manifest`, `host-version`; the
  manifest and `state.json` on the host's root; the bake writes `g1` (`build.sh`: `desk-host-template bake-g1`), and a host from an
  older bake turns its template into `g1` at its first boot of this code. Every reader of the template reads the slot's generation.
- **The fetch, check and seal** of a signed artifact (`desk-host-template fetch`, Platform's `template_target`), against
  `/etc/desk-host/template-keys/` (exactly `template-keys.sha256`'s pins; none until Platform's `alias/ma-host-template`: every
  artifact refused). Streamed, checked unpack; no apt, dpkg or maintainer script on the host.
- **Re-roots** at a stop (background, outside the slot's lock; a wake takes the slot at once and the copy is dropped), **idle restarts**
  for desks that never stop, **the candidate** (one slot's trial, then Platform's promote), **halt and rollback** by the profile's
  `Last Version` (`mounts.py peek`).
- **The host's own apt** (`desk-host-apt.timer`, `51desk-host-unattended`, `nftables` and `apparmor` held, `policy-rc.d` 101 during runs)
  and **`desk-host reboot`** on Platform's `reboot_host`, refused unless every desk is idle.
- **`desk-host-upd`**, the update cgroup (`cpu.idle`, one CPU, 192 MiB, 0.1 of the EBS baseline each way and 300 IOPS), with **paced
  writes**: an unpaced fetch was OOM-killed there in the lab (writeback pages stuck behind `io.max` can't be reclaimed).
- **Four checks** (37 in all, with TD-223's `shaper` and H5's `files`): `templates` (quick, before every start), `template-sig`, `update-cgroup`, `host-apt`; `verify.sh` and
  `verify-port.sh` break each, with a second break each. The recipe installs `zstd`, `openssl` and `unattended-upgrades` explicitly.
- **The link:** PU-1's fields and PU-2's orders (`template_target`, `template_promote`, `template_rollback`, `reboot_host`) and the
  kill switch `updates`. Tests: `tests/test_templates.py` (25), `tests/test_link.py` (64 with S-119's, 11 new: `LinkUpdatesTest`).
- **Lab** (`image/lab/u77-host/`, host 0.1.10's AMI with this tree laid over it, never a release proof): see the status doc.

## Template generations, the builder half (ADR 0077 1.2 and 1.3; unreleased, `sub/u77-builder`)
*No host image changes: nothing here is baked or on a host.* The System Engineer's tools to make a template generation once per
host-image version and sign it (runbook `docs/runbooks/host-template-build.md`; status `docs/sub-status/u77-builder.md`).
- **`image/host/template-build.sh <host AMI>`** launches a temporary `m7g.xlarge` builder from the host AMI itself (`Purpose=desk-image-build`,
  no role, a power-off of its own), runs 1.2's steps and every 1.3 check there (`image/host/template-builder/tb.py`, `slot.sh`), packs
  the artifact, round-trips it through the host's checks, and uploads it through presigned PUTs that carry each file's SHA-256.
- **`tools/template/`:** `tmpl.py` (1.1's artifact: manifest, header, pack and checked unpack, the contract with the host half),
  `template-sign` (KMS `alias/ma-host-template`, or `--key` for a dev key; S3's stored checksums and `passed-build.json` first) and
  `template-verify` (a host's checks, no root).
- **`e2e/tests/browser-session.spec.ts`** gains `SESSION_SLOT=<k>`: a builder's slot through a test host's CDP forward.
- **First real build, host 0.1.10 (`<ami>`), g2, 2026-11-11:** 8 packages from `trixie-security` (apt 3.0.4, vim
  2:9.1.1230-2+deb13u2, libopenexr 3.2.12), every check passed or skipped with a reason, 15 minutes launch to upload, a 0.739 GB
  archive of a 2.34 GB tree (3.17 to 1); section 7's builder mutations 8 of 8 caught. Under the test prefix, signed with a dev key:
  no release (the KMS key is Platform's PU-9). `image/host/evidence/template-build-<ami>-g2/`.

## 0.1.15 (baked, `<ami>`): desk image 0.3.5 on a shared host, with its asks in every slot; the template key's anchor

*Baked 2026-11-11 (MT) from `main` `c06c04e1`; **the main-line candidate for staging shared hosts after 0.1.11.3** (the maintenance line's
candidate), pending the Security Analyst's short read of the template key's anchor and Platform's PU and PB asks; the System Engineer
decides; no `host_image` setting changed. **0.1.14 (`<ami>`) is superseded by it.*** The first host AMI carrying together:
desk image 0.3.5's template (`releases.pin`: `deskd`, `desk-agent`, `desk-notebook` `2026.11.11-90528b5`, `desk-rtc` 0.5.1, `desk-stream`
0.3.5), the slot parity with it (links out and `desk-browser-policy` before every Chromium start in a slot, `sub/host-parity-035`), the
template key's trust anchor (TD-282, `d6d3a83d`: `bake.sh` matched the committed key with KMS `alias/ma-host-template`, `build.sh` pinned
exactly the anchor), the link signing for the API's region (S-120), the slot `datadirs` fix (`23e84afe`), the `dirs` fix (`af80cf83`), and
ADRs 0077 and 0078's host halves. Status: `docs/sub-status/host-0.1.15.md`.
- **Verified** (one run each, from `c06c04e1`): **`verify.sh` 70 of 70**, exit 0, its mutation pass 50 breaks over 40 host checks, each
  failing and passing again; **`verify-port.sh` 72 of 72**, exit 0, its mutation pass 50 breaks over 40 host checks, each failing and passing again. Both include step 2b (the anchor, `ANCHOR PASS`, its mutation failing), section 7 (`verify-links.sh`)
  and section 8 (`verify-parity.sh`: links out, the policy per band and failing closed, JPEG XL off; 0.1.14's host files and the slot's
  `desk-browser-start` without the switch fail it). Evidence: `evidence/verify-<ami>.txt`,
  `evidence/verify-port-<ami>.txt`.
- **Lab** (`evidence/host-0.1.15-lab.txt`, `m7g.xlarge`, SlotMode=port, a standard and a free slot): Chrome over UDP, slot 1 page 59.3 fps
  (59 bins), input 74.9 / 82.9 ms p50 / p95 (13 samples); Files on both slots; `set_class` free to standard to free under scroll, 0.4 s
  each, page 59.0 to 59.4 fps, input 70.5 / 76.7 ms (29 samples); cold wakes `standard` hello 28.2 s and `free` 36.5 s (8 to 12 s later
  than the 0.1.11 line's, one wake each, not looked into); `template-sig` and step 2b name the anchored key; the link's hello to a fake
  that checks us-east-1 only: 200 as baked, 403 `signature` with a us-west-2 override. In a slot: a `tel:` click counted by `deskd`
  (`dropped nobody` 1), `chrome://policy` with the teen lock for band teen and no band and the adult allowlist for adult (the same after a
  crash restart), no `image/jxl` in an image request's `Accept`, OpenRouter reachable from the Agent's uid.
- **Found, not fixed:** on the main line (`batch_cutoff`, ADR 0078), `desk-host up` on a slot with no record exits 1 with no message
  before `up_one` can prepare it; a prepare refused for room leaves such a slot (the status doc).
- Tags: 0.1.11.3's keys (`DeskTeenLock=1`, `DeskSizeClasses=1`, `HostKind=shared`, `HostKernel` 6.12.116+deb13-arm64, `ChromiumVersion`
  156.0.8078.79) with this template's versions.

## 0.1.11.3 (baked, `<ami>`): the teen lock in every slot

*Baked 2026-11-11 from `d60a09c5` (`sub/host-0.1.11.3`, merged to `maint/host-0.1.11` as `fb155ad7`); **handed to Platform as staging's and prod's shared-host image in place of 0.1.11.1 and 0.1.11.2** (2026-11-11); Platform sets `host_image`.* 0.1.11.2 exactly (the same recipe, pins and tag keys), plus one fix (`docs/sub-status/host-0.1.11.3.md`): a slot's `desk-init` runs the template's `desk-browser-policy` as the desk's root before every start of Chromium, crash restarts included, as `desk-browser.service`'s `ExecStartPre=+` does on a desk of its own (ADR 0072 section 9). **No slot ran it before**, on any host image: a teen's desk on a shared host had Chromium with no lock (no SafeSearch, no YouTube restriction, no family DNS, extensions allowed), though every host AMI carries `DeskTeenLock=1`, which Platform places teens by. A helper that fails is no start, tried again after the Browser's back-off. Ported from `main`'s `fd578818` (its policy part only: not links out, nothing of ADRs 0077 or 0078). Tests: `image/tests/test_host_slot_teen_lock.py`, 9; 8 fail on 0.1.11.2's `desk-init`. `verify.sh` and `verify-port.sh` section 8 (`verify-teenlock.sh`) with its mutation.
- **Verified** (one run each, from `d60a09c5`): **`verify.sh` 60 of 60** and **`verify-port.sh` 62 of 62**, exit 0, each with its whole mutation pass (33 of 33), section 8 and its mutation (0.1.11.2's `desk-init` fails it) included. Evidence: `evidence/verify-<ami>.txt`, `evidence/verify-port-<ami>.txt`.
- **Lab** (`evidence/host-0.1.11.3-lab.txt`, `m7g.xlarge`, SlotMode=port, three slots): each slot's own Chromium's `chrome://policy` had the teen lock's six keys set for band teen and for no band file and none for adult, the same after a SIGKILL crash restart of each; Chrome over UDP, slot 1 page 59.3 fps (59 bins), input 75.3 / 124.8 ms p50 / p95 (10 samples); a cold wake (standard) up 8.1 s, hello 20.3 s.
- Tags: 0.1.11.2's (`DeskTeenLock=1`, `DeskSizeClasses=1`, the same versions). **0.1.11.1 and 0.1.11.2 are superseded for any host that may hold a teen's desk.**

## 0.1.11.2 (baked, `<ami>`): the slot's init never acts on a name inside a desk user's folder, and the link signs for the API's region

*Baked 2026-11-11 from `159f06cf`; passed, but **superseded by 0.1.11.3** (it has no teen lock in a slot); no `host_image` setting changed.* 0.1.11.1 exactly (S-119, TD-223, H5 and 0.1.11.1's prepare; the same recipe, pins and tag keys), plus two fixes, both on `main` too. Nothing from ADRs 0077 or 0078.
- **`slot-datadirs` (EXP-7's class in the slot's init, `desk-init.py`):** as the desk's root in its slot, `datadirs()` made `/data/browser/profile`, `downloads` and `home` with `os.makedirs`, then `chown` and `chmod` by name, so a link the Browser's user put at one of them was followed at the slot's next start and gave `kiosk` the directory it named (one of the desk's root's; the desk's root maps to an unprivileged host uid, so this is root of that member's own desk, not of the host). Now inside a user's folder that user acts (`setpriv`, no new privileges): `kiosk` makes the three, `desk` copies the volume record to `/data/desk/volume.json`, `desk-snd` empties and makes `/run/desk-audio/pulse`; `units.sock` is bound as `desk` with its mode set before the bind (never chowned by name in the slot's `/run/desk`, `rtc:desk` 0770); the profile's `Preferences` is read `O_NOFOLLOW` at each step and `O_NONBLOCK`. Every other root write in `desk-init.py`, `mounts.py`, `svc-spec.py` and the host's scripts that touch a slot's volume or `/run/desk-host/<k>` was audited (`docs/sub-status/slot-datadirs.md`): no other fix needed; `preread.py`'s reads of a slot's own root are a follow-up. Tests: `image/tests/test_host_slot_links.py`; verify's section 7, `verify-links.sh`, with 0.1.11.1's `desk-init` as its mutation.
- **The link's signing region (`3e7828da`, S-120), ported:** `desk-host-link` signed SigV4 for the instance's region; Platform's `host-api.` names are REGIONAL API Gateway domains in us-east-1 only, so a us-west-2 copy of 0.1.11 was refused every hello (403 signature). It signs for `LINK_API_REGION_staging` / `LINK_API_REGION_prod` (both `us-east-1`, `desk-host.conf`); `LINK_API_REGION` overrides them with a test fake only; `desk-host-check link` pins both, with a second break in both verify scripts (`m2`, brought over from `main` for it). The stand-in still says the instance's region. Tests: `tests/test_link.py`, 55 (two new).
- **Verified** (one run each, from `159f06cf`): **`verify.sh` 58 of 58** and **`verify-port.sh` 60 of 60**, each with its whole mutation pass (34 breaks in the script, the pass line PASS in both), including section 7, the planted link (`verify-links.sh`) and its mutation (0.1.11.1's desk-init fails it). Evidence: `evidence/verify-<ami>.txt`, `evidence/verify-port-<ami>.txt`. The bake was cut off after the image became available: the IMDSv2 image attribute was set by hand afterwards (`v2.0`); tags and snapshots were already right; this row is written by hand.
- **Lab** (`evidence/host-0.1.11.2-lab.txt`, `m7g.xlarge`, SlotMode=port): Chrome over UDP, slot 1 page 59.4 fps (59 bins), stream 59.41 fps (1079 decode samples), input 71.9 / 90.3 ms p50 / p95 (13 samples); `set_class` standard and back to free under scroll: page 60 fps throughout, input 74.6 / 88.6 ms (27 samples); Files works on both slots; cold wake hello 20.1 s (standard) and 24.5 s (free); the planted link at `/data/browser/home` was not followed. The link's hello signing for `us-east-1` is proven by the verify fake (check and `m2` break), not by a live call to the API.

## 0.1.11.1 (baked, `<ami>`): a prepare never fills the slot store (`maint/host-0.1.11`, from 0.1.11's `b7cb1421`)

**Meant to replace 0.1.11 for staging and prod shared hosts; not recorded as such yet: `verify-port.sh` failed one result, in the new step's
harness** (below). Nobody's default until Platform sets it (no `host_image` setting changed here). 0.1.11 exactly (S-119, TD-223, H5; the same recipe,
pins and tag keys), plus `desk-host prepare` only (`README.md`, "The store's room"; Platform's reclaim wave on staging filled two 0.1.9 hosts'
36 GB stores with six prepares at once):
- the slot's old root, which no record names once the prepare removes the record, is deleted before the copy, never after;
- one prepare's copy at a time on the host (a `flock` on `/run/desk-host/lock/copy`, from a room check to the rename), and only when the store
  holds one more root (the template and the release copies, each inode once) beside the other slots' quota room and `PREP_SPARE_MB` (512): else
  exit 75, "refused for room", nothing made; a dead prepare's tree is removed in the turn;
- the tree an unfinished prepare was making is removed on every way out (`prep_drop`), SIGTERM included.
- **Results:** `verify.sh` **56 of 56**, mutation pass **33 of 33**, exit 0. `verify-port.sh`, **second run (after the harness fix, 2026-11-11): 58 of 58, mutation pass 33 of 33, exit 0**, once, whole, no check changed. Its **first run** (below) was 57 of 58, mutation 33 of 33, exit 1:
  each with its whole mutation pass (**33 of 33**), each run once
  (`evidence/verify-<ami>.txt`, `evidence/verify-port-<ami>.txt`). The new two in each are `verify-wave.sh`'s: the
  wave passed in both; its mutation (0.1.11's prepare) failed the wave in both, as it must, but `verify-port.sh`'s restore met two desks its fake
  Platform had started (the link's in-flight starts ran on after the step stopped it), and the real prepare refused those slots. The harness now
  waits for the link's own runs (`docs/sub-status/host-0.1.11.1.md`); the second run passed 58 of 58 (the evidence file is that run's).
- **Lab** (`evidence/host-0.1.11.1-lab.txt`; `m7g.xlarge`, SlotMode=port, Platform's 36 GiB store): six desks running, then stopped; the six
  slots prepared again at once: all six prepared in turn, the store's peak use 24.85 of 37.93 GB, no partial. 0.1.11's prepare on the same store
  and wave: 37.91 GB used, all six ENOSPC, six partials. Then two desks, one streamed over UDP: page 59.3 fps, stream 59.28 fps (1,072 decode
  samples), input to frame 76.3 / 88.0 ms p50 / p95 (14 samples).
- A first 0.1.11.1 bake (`<ami>`, `cf2b0700`) counted release hard links once per name (6.0 GB for a 3.55 GB root) and was
  deleted before any verify.

## 0.1.11 (baked, `<ami>`): set_class in place, the per-slot shaper, Files in a slot (`sub/host-0.1.11`)

**The image for staging and prod shared hosts** until 0.1.11.1 (above) passes `verify-port.sh` whole (its prepare can fill the slot store when many slots are prepared at once); **supersedes 0.1.10; nobody's default until Platform sets it** (no `host_image` or `desk_image` setting changed here). Baked from `main` `b7cb1421`
(`ma-desk-test-host-0.1.11`, like every test-named bake until a release prefix is used). It carries three changes, each described in the sections below:
S-119 (the link runs `set_class` in place, the report carries `class`), TD-223 (the outbound shaper and the `shaper` check) and H5 (`/data/files` in `deskd`'s sandbox and the `files` check).
- **Not in it: ADR 0077's host half (`sub/u77-host`)** had not merged to `main` at the bake. The builder half (`template-build.sh`, `tools/template`) is on `main` and changes nothing on a host.
- **Pins moved since 0.1.10's `730d555b`:** `desk-rtc` 0.5.0 to **0.5.1** and `desk-stream` 0.3.3 to **0.3.5** (S-29, `main`'s `image/recipe/releases.pin`); `deskd`, `desk-agent`, `desk-notebook` and `desk-agent-filter` are 0.1.10's.
  The slot template is built from the same recipe. AMI tags: 0.1.10's keys (`DeskRtcVersion` 0.5.1, `DeskStreamVersion` 0.3.5), `DeskSizeClasses=1`, `Owner=syseng-host0111`.
- **Results on the baked AMI:** `verify.sh` **54 of 54** and `verify-port.sh` **56 of 56**, each run once with its whole mutation pass (**33 of 33**), exit 0, no failure, no check changed
  (`evidence/verify-<ami>.txt`, `evidence/verify-port-<ami>.txt`). 0.1.10 had 51 and 45 (31 mutations); the new results are `shaper`, `files`, the `set_class` section 4b (port) and the rest of the 33.
- **Lab on the baked AMI** (`evidence/host-0.1.11-lab.txt`; one `m7g.xlarge`, `SlotMode=port`, a `c7i.xlarge` client at 31 ms RTT): Chrome over UDP, `scroll` 60 s: stream 59.2 fps (1,083 decode samples), page 59.2 fps, input to frame 70.8 / 88.0 ms p50 / p95 (12 samples), 0 freezes.
  `set_class` free to standard and back on a running slot, a 120 s scroll watched across both: page fps 59.3 before, 59.2 in the five seconds of the raise, 59.3 standard, 60.0 in the five of the lower, 59.3 after; 0 freezes, 0 lost; input 72.8 / 87.0 ms (29 samples); each change took 0.4 s.
  Files through `deskd`: a fresh volume works at its first start; a volume without `files/` skips the mount at its first start (unavailable, by design) and works at its second. Cold wakes: `standard` hello 19.7 s, CDP 31.4 s; `free` hello 24.2 s, CDP 38.5 s (one each; 0.1.10: 19.1 / 31.8 and 23.9 / 39.7).
- **A fresh slot's first start and a staging free desk's older volume:** an existing volume gets Files from its second start on this image (H5 status doc).
- Detail: `docs/sub-status/host-0.1.11.md`.

## 0.1.11, carried (baked): ADR 0036's outbound shaper on every slot (`sub/td223-shaper`, TD-223)

*Baked in 0.1.11.* ADR 0072 section 8, README "The outbound shaper", `docs/interfaces/desk-runtime.md` 9.3,
`docs/sub-status/td223-shaper.md`. Until this a shared host counted each slot's bytes and slowed nothing, so the guard's stop was the only brake.
- **`desk-host up`** puts ADR 0036's HTB on the desk's end of its veth (`eth0` in its network namespace) before `runc start`: 1:10, 1:15 and
  1:20 at 60, 2 and 100 Mbit for `standard`, times the class's `egress` (`free` half), each rate equal to its ceiling, the desk's own leaves
  and bursts. Then **`desk-host-egress@<k>.service`** (new, never enabled) runs `egress.py run <k>`: the desk's own `desk-egress`
  (`desk_egress.py`, which `recipe/build.sh` now installs from the template's baked release) on the slot, every `tick_seconds`, with
  `/etc/desk-host/egress.conf` (new; `[slot<k>]` for a test) and state in `/var/lib/desk-host/egress/<deskId>.json`. A stop stops it first.
- **The stream's profile:** `/run/desk-host/<k>/egress/profile` (the host's), bound read-only at `/run/desk-egress` in `desk-stream`'s
  sandbox (`svc-spec.py`); `desk-init` restarts a running `desk-stream` when it changes.
- **`desk-host shaper <k> show|off|on`** (new): the slot's classes and budget; `off` drops its shaper and budgets (test 1's R5), `on` puts them back.
- **`desk-host report`** carries `shaper` for each running slot (classes' rates and `tc` counters, the budget); Platform ignores it.
- **`desk-host-check shaper`** (the 32nd check; not a quick one). `verify.sh` and `verify-port.sh`: section 4f (one more result each) and the
  `shaper` mutation (slot 1's qdisc deleted with its unit frozen).
- **Needs `tc`** on the host (iproute2, already there; `build.sh` asserts it) and `sch_htb` and `sch_fq_codel` (not blacklisted).
- **Tests:** `image/tests/test_host_shaper.py` (31). **Lab** (0.1.10's AMI plus these files, `m7g.xlarge`, `SlotMode=port`, two slots, `evidence/td223-lab-2026-11-11/`): a neighbour's `kiosk` upload held at 100.0 to 100.07 Mbit/s in 1:20, then slowed to 0.75 at the tick after a lowered bucket emptied, while slot 1's video held 59.6 page fps and input to frame 56.1 to 58.3 ms p50 (R0 55.9 and 56.2), 0 lost, 0 drops on its 1:10, 7 runs of 120 s; `desk-host shaper 2 off` let a 300 Mbit/s upload through, counted by `out_2` to 0.9996 of the veth; a profile change restarted a viewed `desk-stream` on `stream-capped.conf`; 4f and the mutation passed by hand; stop and wake kept the budget. Not a release proof; the bake's `verify.sh` and `verify-port.sh` are.

## 0.1.11, carried (baked): the host link runs `set_class`, an upgrade in place (`sub/s119-set-class`, S-119)

*Baked in 0.1.11.* `docs/sub-status/s119-set-class.md`; ADR 0072 section 16; `image/host/README.md`, "The host link".
- **`desk-host-link`** takes Platform's `set_class {k, deskId, epoch, class}` (contract `shared-host.md` 0.3.46, `id`
  `set_class:<k>:<epoch>:<class>`) and runs it once per order ID as `desk-host class <k> --whole`: the running container's class
  changed in place, never a restart. Done once the report says the order's class; one the report already shows (a repeat, a
  restarted link) runs nothing. Refused with nothing changed, and tried again after 60 s while Platform sends it: `host_stopping`
  (stop-all's mark), `class_unknown` (not in `classes.conf`), `not_this_desk`, `slot_starting` (mid-start: it runs once the desk
  is up), `tag_mismatch` (the tag doesn't say the class yet), `host_full` (`desk-host`'s 75). The contract has no error field
  for an order, so the codes are in the link's log, and the report's unchanged `class` is what Platform sees. A report goes at
  once when a slot's class changes.
- **`desk-host class <k> --whole`:** a raise the host has no room for (its units) changes nothing and exits 75, where plain
  `class` applies CPU and pids and leaves memory waiting; the contract counts `+pending` as done, so a half raise would have
  waited for the desk's next start. Nothing changes while the host is stopping (exit 1). Plain `class` is as before.
- **`desk-host report`** (`report.py`) carries `class` for a slot that's starting, running or stopping, from its `class.json`,
  with `+pending` while a lower memory cap waits. Before, the report had none, so Platform never ordered `set_class`.
- **Tests:** `test_link.py` 53 (11 new: done once in place, both ways, a repeated ID and a restarted link running nothing,
  each refusal, an order mid-start and one during the link's own start, the report's class, malformed orders ignored);
  removing `set_class` from `OPS` fails all 10 of the link's `set_class` tests. `image/tests/test_host_class_whole.py` (5, new):
  the real `desk-host class` as root in a user, mount and network namespace with a fake `runc` and desk-1's cgroup as files:
  `--whole` with no room changes nothing (75), plain `class` still applies CPU and waits, a stopping host changes nothing, with
  room it's the class in place; without the `whole_refused` call, or without the halt line, its test fails. **`verify-port.sh`** gains section 4b (8 results,
  `tests/set_class_lab.py`) with its own mutation.
- **Lab run** (host 0.1.10's AMI plus `lab/s119-set-class/host-overlay.sh`, m7g.xlarge, SlotMode=port; never a release proof):
  `verify-port.sh` **53 of 53** (0.1.10's 45 with the overlay, its mutation pass 31 of 31, and 4b's 8): free to standard in place
  in 0.4 s with 33 of 33 processes kept, deskd's JVM, Chromium's browser process and both containers' start the same, the cookie
  sent back, no OOM kill; no room and a stopping host refused with nothing changed; with `set_class` out of `OPS` the upgrade
  is ignored and 4b's check fails. Run 1 (49 of 53) failed 4b on a harness bug, fixed. Detail: the status doc.

## 0.1.11, carried (baked), also: Files on a shared desk (`sub/h5-files-slot`, free walk H5)

*Baked in 0.1.11.* `docs/sub-status/h5-files-slot.md`; ADR 0072's 2026-11-11 amendment (`WALL-05`); `image/host/README.md`,
"deskd's Files tree". **Up to 0.1.10 no shared desk had Files:** `deskd`'s sandbox had only the volume's `/data/desk`, its `/data`
a 1 MB root-owned tmpfs, so it couldn't make `/data/files` (`the Files tree can't be used: AccessDeniedException` at each start) and
answered every `files.*` `unavailable` `{reason: "tree"}` ("Your desk couldn't open that just now").
- **`svc-spec.py`** gives `deskd` a placeholder at `/data/files` as at `/data/desk`. **`mounts.py`** moves the volume's own `files`
  (1100:1100 `0700`) over it, resolved and cloned as the others are; it's `deskd`'s optional directory (`SERVICES` maps a service to
  its directories, the first required): missing, a link or a file skips only that mount, never followed, and `deskd` starts with
  its placeholder (`mounts.json` `skipped`). A blank volume gets `files` at its format.
- **`desk-init.py`** makes `/data/files` (desk:desk `0700`) at every start and replaces a link there, as for its other
  directories. The host still writes nothing on a volume a desk has run on, so **a volume from before has Files from its second
  start on a 0.1.11 host**: staging's free desks need two starts there (a stop and wake after the first).
- **`desk-host-check files`** (the 33rd check, after TD-223's `shaper`): each running slot's `deskd` has the volume's directory as 1100:1100 `0700` and
  hasn't logged that line since desk-svc last started it; a skip is said, not failed. Not in `--quick`. `verify.sh` and
  `verify-port.sh` run it with a slot up and break it in the mutation pass (0.1.10's state: a mode 000 tmpfs over `deskd`'s
  `/data/files`), so 33 mutations with the shaper's. The lab's `verify-port.sh` ran before TD-223 merged: 32 of 32 there.
- **Tests:** `image/tests/test_host_files_slot.py` (15): `mounts.py`'s policy with the volume faked, the placeholders, `datadirs()`,
  the check; each of seven mutations of the change fails one.
- **Lab** (0.1.10's AMI with the overlay, `lab/h5-files/lab.sh`, `deskctl --call` through `gateway-shim`): see the status doc.

## 0.1.10 (baked, `<ami>`): restarts back off, and a kill order inside each desk (`sub/host-0.1.10`; reliability audit S1 and S2)

**A test bake for Platform's staging soak, nobody's prod default; supersedes 0.1.9 for the soak.** Baked from `main` `730d555b`: it also carries the `DeskSizeClasses=1` tag (set by `bake.sh`) and the slot template of `ma-desk-0.3.3`'s recipe and pins (`deskd` `ff58751`, `desk-agent` `7e809cb`, `desk-notebook` `c472928`, `desk-rtc` 0.5.0). `docs/interfaces/desk-runtime.md` section 11, `docs/sub-status/sub-restart-oom.md`, `docs/sub-status/host-0.1.10.md`.
- **`desk-svc`** (process 1 of every sandbox) waits longer before each restart in a row, from `-restart-sec` to `-restart-max-sec` (300) in `-restart-steps` (8), starts the count over after a
  `-healthy-sec` (120) run or a `start` from `desk-init`, and logs `restarting in 5.3 s (restart 2 in a row)`; it never gives up. `desk-init` does the same for what it supervises (the Agent's filter and
  resolver to 5 minutes, Xorg, the audio server and the Browser to 30 s). `desk-svc/main_test.go` (2 tests, `go test`).
- **A kill order in each desk:** `svc-spec.py` gives each sandbox's process 1 an `oomScoreAdj` (`deskd` and `desk-rtc` -500, `desk-notebook` -200, `desk-stream` +100, `desk-agent` +200, `desk-data` 0);
  `desk-init`'s children keep the desk's 0 (a desk has no `CAP_SYS_RESOURCE`); Chromium's renderers are 300. `desk-host-link`, `desk-ice-demux` and `desk-host-shutdown` are -900.
- **`desk-host-check oom`** (the 31st check) reads all of it from `/proc` for every running slot; the mutation pass breaks it (slot 1's `deskd` at 0) and requires the FAIL, then the PASS.
- **`verify.sh` and `verify-port.sh`** gain a back-off section (`verify-backoff.sh`, the baked `desk-svc` run as a plain supervisor: waits of 1, 2, 4, 8 and 16 s, 1 s after a healthy run, 2 s next; and two
  mutants that must fail: steps off, no run healthy), so **3 more results**, plus the `oom` check (31 mutations). `verify-port.sh` takes `VERIFY_OVERLAY=<dir>` for a lab run of an unbaked tree against an
  earlier AMI (never a release proof; `lab/restart-oom/host-overlay.sh`), and waits 12 s before its final all-checks run (the link drops a stopped slot's stand-in at its next look; that run failed `standin` once without the wait).
- **Results on the baked AMI:** `verify.sh` 51 of 51, `verify-port.sh` 45 of 45 (the three back-off results and `oom` included), both mutation passes 31 of 31. The earlier lab run (0.1.9 plus an overlay, `verify-port.sh` 45 of 45) was never a release proof. Lab on the baked AMI, RC-04 at six slots, cold wakes: `evidence/host-0.1.10-lab.txt`, `evidence/hostproofs-0.1.10-rc04-six-slots.txt`, the status doc.
- **The desk image's new units** (`desk-restart-reset.service` and `.timer`) are in `DESK_UNITS`, masked on the host, which has no systemd in a desk.

## 0.1.9 (baked, `<ami>`): the service sandboxes can look names up (`sub/host-0.1.9`)
**The staging soak's host image, nobody's prod default; supersedes 0.1.8** (Platform's Bug 8, `shared-host-soak.md`). On 0.1.8 `deskd`
in a slot never said hello: its sandbox ran on the release's own root, whose `/etc/resolv.conf` is empty, so every lookup of the
Platform API failed (`ConnectException` every 30 s) and no shared desk reached `ready`. The labs used a fake Platform on the
loopback, so no name was ever looked up, and no check asked. A host bug, not Platform's.
- **`svc-spec.py`:** `deskd`, `desk-agent` and `desk-notebook` (the three on a release root) get the template's `/etc/resolv.conf`
  (the desk's own: `nameserver 169.254.169.253`, which the slot's firewall lets through on 53) bound over the release's, read-only,
  `noexec`, host-owned source. Nothing else of `/etc` and no other mount, capability or namespace changes. `desk-rtc`, `desk-stream`
  and `desk-data` run on the template and have it already. **The Agent's filter (ADR 0070) is unchanged:** nftables redirects uid
  1103's port 53 (and 443) to `desk-agent-filter` whatever address or file it uses, and the filter asks `desk-dns`.
- **`desk-host-check svc-dns`** (the 30th check): per running slot, each sandbox's `/etc/resolv.conf` as it sees it is the desk's, and
  from inside `deskd`, `desk-rtc` and `desk-agent` as their own uids, `getent ahostsv4 sts.<region>.amazonaws.com` (an ordinary lookup)
  resolves, except `desk-agent`, which must get only the filter's placeholder or nothing, never a real address.
- **Tests:** `image/tests/test_host_svc_resolver.py` (5; the spec's resolver mount; the rootfs test fails on 0.1.8's spec: the
  three rootfs services have no `/etc/resolv.conf` mount there) and `test_host_svc_dns.py` (10; the check against fake output,
  with the empty-file break, no lookup, a real address for the agent, a missing sandbox).
- **Harness:** `verify.sh` and `verify-port.sh` run `svc-dns` with a slot up and require its sandboxes and lookups counted
  (`6 sandbox(es)`, `3 lookups`), and **break it in a running slot**: the bind unmounted in `deskd`'s mount namespace (0.1.8's state:
  the empty file), the check FAILs (`its /etc/resolv.conf is '', ... sts.us-east-1.amazonaws.com did not resolve`), the bind put back
  with `open_tree` and `move_mount`, it passes. (The first `verify.sh` run failed only here: my first restore used a `/proc/self/fd`
  bind that does not work in the sandbox; evidence `verify-<ami>-first-run.txt`. The AMI was not changed.)
- **Results on the baked AMI:** `verify.sh` **47 of 47** (`evidence/verify-<ami>.txt`),
  mutation pass **30 of 30**; `verify-port.sh` **41 of 41** (`evidence/verify-port-<ami>.txt`), mutation pass 30 of 30.
- **On a lab box under SlotMode=port, one slot and a client** (`evidence/host-0.1.9-lab.txt`): as `deskd`'s uid in its sandbox
  `curl https://sts.us-east-1.amazonaws.com/` gets HTTP 302 (DNS 16 ms, TLS 52 ms); with the bind unmounted (0.1.8's state) the same
  command says `Could not resolve host`; put back, 302 again. A Chrome session over UDP 4431 (31 ms RTT, `scroll` 60 s): stream 59.2 fps,
  page 59.3 fps, input to frame 74.1 / 78.6 ms p50 / p95.
- Not run on this bake: Platform's own hello against the staging API (the labs have no staging credentials; the soak does that),
  the JVM's own client (the sandbox's JRE has no compiler to run a probe in it), TCP 443 through the demux (0.1.8's lab, unchanged).

## 0.1.8 (baked, `<ami>`): a host stop leaves no desk running, a start in flight included (`sub/host-0.1.8`)
0.1.7's `verify-port.sh` run 5 found a desk still running after `desk-host stop-all`. **A host bug, not the harness.** `stop-all`
looked only for running containers. At a host stop the link stops first (`desk-host-link.service` is ordered after
`desk-host-shutdown.service`) and `KillMode=process` leaves a `desk-host up` it began running, in the link's cgroup; `stop-all`
skipped that slot (no container yet), said "every desk stopped", and the up then started the desk, which the host's power-off
would kill rather than close (ADR 0035). Not port mode's: any start in flight. In run 5 the harness's own order made one (the link,
told the desks were wanted, restarted them after the `boot` break; the harness then stopped the link and ran `stop-all`).
Reproduced on a lab host from 0.1.7 (`spikes/host-0.1.7/results/repro/`): `stop-all` 1 s into an up returned in 0.1 s and the desk
came up 389 s later; through the shutdown path (`systemctl stop desk-host-link desk-host-shutdown`, one transaction, the link's
start_slot in flight) the unit's stop returned in 4.7 s and the desk came up 11 s later. With Chromium running, both paths closed
it cleanly on 0.1.7 too (`quit=cdp`, `exit_type Normal`, 2 desks each): only the start in flight was missed.
- **`desk-host`:** `stop-all` marks the host halting (`/run/desk-host/halt`) first, then stops every slot with a container or one an
  `up` has marked `starting` (`stop` waits for that up's lock). `up` checks the mark under its lock before it changes anything,
  before `runc create` and before `runc start`, and refuses with the fault `host_stopping` (in `/run/desk-host/fault/<k>`, not in
  the report's list), resetting what it made, so no desk starts once a host stop has begun. `desk-host resume` ends the halt.
  A slot whose lock a prepare holds (no start) isn't waited for.
- **`desk-host-shutdown.service`:** its start is `desk-host resume` (was `/bin/true`).
- **`desk-host-check boot`:** fails while the host is halted with `desk-host-shutdown` up (every start would be refused).
- **Tests:** `image/tests/test_host_stop_all.py` (4; the real `desk-host` in a user and mount namespace with a fake `runc`; its
  first test fails on 0.1.7's). `verify-port.sh` 4d: a host stop while a start is in flight (no desk, nothing of the slot left; a
  start after it refused until the unit starts again), and the `cgroup` break after a host stop of the link and
  `desk-host-shutdown` in one transaction rather than the link stopped and `stop-all` run by hand. `verify-port.sh` is then 40 steps,
  and on 0.1.8 it passed 40 of 40: 4d's start was refused at its next check (`host_stopping`), nothing left, and the `cgroup` break
  failed as it must with no desk left after the host stop.
- On the lab host with the fix copied on: the direct `stop-all` waited 11.8 s for the up's prepare, which then refused
  (`host_stopping`), nothing left; the shutdown path waited 79.5 s (a prepare with the page cache dropped), refused it the same way,
  and closed slot 1's running Chromium over CDP (`exit_type Normal`). A start that is re-preparing a root holds a host stop for
  that copy (11 s warm, 80 s cold here, 6.5 minutes on a fresh host's first copy while its volume loads), within the unit's 300 s;
  past that systemd ends the wait and the up, still refused at its next check, never starts the desk.

## For the next bake, 0.1.7 (unreleased): one public IPv4 per host, `SlotMode=port` (`sub/host-shared-address`)
The owner's choice B (2026-11-10, "OKay lets do it"; ADR 0072 section 6's note; README "One address per host";
`docs/sub-status/host-shared-address.md`). Platform's launch tag `SlotMode=port` selects it; no tag, or `address`, is A, as
every host so far.
- **`desk-ice-demux`** (`desk-ice-demux/`, Go, built by `bake.sh` with the pinned Go as `desk-svc` is; its `.sha256` beside it):
  the host's TCP 443 under SlotMode=port, routing each ICE-TCP connection to its slot by the ufrag's tag, from the client's own
  address. Its own user `desk-dmx` (made by `recipe/build.sh`), unit `desk-ice-demux.service` (enabled, but starts only when
  `desk-host-boot` wrote `/run/desk-dmx/env`, i.e. under SlotMode=port).
- **`desk-rtc` 0.5.0** in `releases.pin` (published; on the staging test desk, `e2e/` there: see the status doc), for its
  slot settings (`port`, `tcp_port`, `slot`, `public_ipv4`). Nothing changes for a desk of its own or A's slots.
- `desk-host-boot` reads `SlotMode` at the first boot into `hosting.json` (a later boot keeps it); under port it lays the
  demux's ground at every boot. `desk-host up` under port: UDP 4430+k DNATed from the host's interface only, no TCP DNAT, the
  slot's `desk-rtc.conf`, its port in the desk's input and `classify` chains, the demux's mark and counting chains (`dmxi_<k>`,
  `dmxo_<k>`); every stop removes them. `slotnet.py`: the host's mode, `-` addresses under port only, the hello's public address
  must be IMDS's now; `tag <k>` reads a tag strictly, and `desk-host class <k>` with no class uses it (the set_class
  prerequisite in the entry below, closed).
- `desk-host-link`: B's hello as contract 0.3.57 shapes it (`slotMode` and the host's `publicIp` at the top, `udpPort` per slot;
  a reply of the other mode refused), the session's `udpPort` checked; under address as before.
- `/etc/nftables.conf`: `divert`, the source check ahead of input's established accept, `desk_dmx`, `desk_dmxo`, `host_in` (empty
  under address). Sysctl `net.ipv4.ip_local_port_range = 60000 64999` (the host's own ports above every slot's SNAT block).
  **Needs the new ruleset loaded:** these files copied onto an older host without `nft -f /etc/nftables.conf` (with no desk up)
  and `desk-host-boot` run again fail `slotmode`, which is a quick check, so every `up` refuses until then.
- `desk-host-check` 29 checks (`slotmode`, `addresses`, `demux`, `ports`; `counters` and `inbound` widened; `sysctl` checks the
  port range). **`verify.sh` (A) must then pass 46 of 46** (0.1.6's 37 with 29 checks rather than 25, the classes and counters
  sections, and the mutation pass with the four new breaks) **and `SLOT_MODE=port verify.sh` (`verify-port.sh`, B) 39 of 39**
  (its boot, link, 29 checks, the tag, the desk on slot 1, out, the UDP ports, the demux, the stop, the counters, the mutation pass).
  Neither has run on a bake: the files ran on a lab host from 0.1.6 (`spikes/host-shared-address/README.md`), every new check
  broken there and failing, and `verify-port.sh`'s UDP, demux, conntrack and egress steps run by hand there.
- Fixed on the way: `desk-host up`'s log line named the wrong CPU setting (the pre-read wait reused `w`); the cgroup was right.

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
| 0.1.7: **dirty, superseded by 0.1.8.** Baked with `recipe/build.sh`'s ruleset fix uncommitted (its first bake failed in the host recipe, nothing made). `verify.sh` **46 of 46** (`evidence/verify-<ami>.txt`); `verify-port.sh` **38 of 39** in its fifth run (`evidence/verify-port-<ami>.txt`, the four before it `-first-run` to `-fourth-run`: harness fixes): its `cgroup` mutation couldn't be broken because `stop-all` had left a desk whose start was in flight, a host bug fixed in 0.1.8. Nobody's default; for nothing now, `image/prune.sh delete` once 0.1.8 is Platform's | <ami> | 2026-11-10 09:59 | 067fa540+dirty | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.0, desk-stream 0.3.3, deskd 2026.11.10-5535d52, desk-agent 2026.11.10-35df59e, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
| 0.1.8 (superseded by 0.1.9): **`verify.sh` 46 of 46** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 40 of 40** (`evidence/verify-port-<ami>.txt`), each with its whole mutation pass (29 of 29, `cgroup` included); baked clean from `sub/host-0.1.8` on `main`. A test bake, nobody's default, for Platform's staging soak. On a lab box under SlotMode=port: both slots over UDP and over TCP 443, counters, one cold wake per class (`docs/sub-status/host-0.1.8.md`) | <ami> | 2026-11-10 11:43 | 3bf2dc5d | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.0, desk-stream 0.3.3, deskd 2026.11.10-5535d52, desk-agent 2026.11.10-35df59e, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
| 0.1.9: **`verify.sh` 47 of 47** and **`verify-port.sh` 41 of 41**, each with its whole mutation pass (30 of 30, `svc-dns` included); the staging soak's host image, nobody's prod default; supersedes 0.1.8 (Bug 8: the service sandboxes' resolver) | <ami> | 2026-11-10 17:45 | f2253f67 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.0, desk-stream 0.3.3, deskd 2026.11.10-5535d52, desk-agent 2026.11.10-35df59e, desk-agent-filter 0.1.1, desk-notebook 2026.11.08-f435ef9 |
| 0.1.10: **`verify.sh` 51 of 51** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 45 of 45** (`evidence/verify-port-<ami>.txt`), each with its whole mutation pass (31 of 31, `oom` and `svc-dns` included); a test bake for Platform's staging soak, nobody's prod default; supersedes 0.1.9 for the soak (restart back-off, the kill order, the 0.3.3 slot template) | <ami> | 2026-11-11 00:22 | 730d555b | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.0, desk-stream 0.3.3, deskd 2026.11.10-ff58751, desk-agent 2026.11.10-7e809cb, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-c472928 |
| 0.1.11: **`verify.sh` 54 of 54** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 56 of 56** (`evidence/verify-port-<ami>.txt`), each with its whole mutation pass (33 of 33, `shaper` and `files` included); the image for staging and prod shared hosts, nobody's default until Platform sets it; supersedes 0.1.10 (`set_class` in place, the per-slot shaper, Files in a slot; desk-rtc 0.5.1, desk-stream 0.3.5) | <ami> | 2026-11-11 11:49 | b7cb1421 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.10-ff58751, desk-agent 2026.11.10-7e809cb, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-c472928 |
| 0.1.11.1, first bake (its room check counted release hard links once per name, 6.0 GB for a 3.55 GB root; found on its lab host, fixed in `463b910d` and baked again under the same name. Deleted before any verify) | <ami> | 2026-11-11 16:16 | cf2b0700 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.10-ff58751, desk-agent 2026.11.10-7e809cb, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-c472928 |
| 0.1.11.1: **`verify.sh` 56 of 56** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 57 of 58** (`evidence/verify-port-<ami>.txt`; the one failure is the new wave step's restore, a harness race, fixed and not run again), each with its whole mutation pass (33 of 33); from `maint/host-0.1.11`; meant to replace 0.1.11 for staging and prod shared hosts once `verify-port.sh` passes whole | <ami> | 2026-11-11 17:00 | 463b910d | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.10-ff58751, desk-agent 2026.11.10-7e809cb, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-c472928 |
| 0.1.11.2: **`verify.sh` 58 of 58** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 60 of 60** (`evidence/verify-port-<ami>.txt`), each once with its whole mutation pass; `<ami>` from `maint/host-0.1.11` `159f06cf`, a candidate to replace 0.1.11.1 (the System Engineer decides); lab in `evidence/host-0.1.11.2-lab.txt`. |
| 0.1.11.3: **`verify.sh` 60 of 60** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 62 of 62** (`evidence/verify-port-<ami>.txt`), each once with its whole mutation pass (33 of 33) and section 8, the teen lock in a slot (`verify-teenlock.sh`) with its mutation; `<ami>` from `maint/host-0.1.11` `d60a09c5` (merged `fb155ad7`): **the candidate for staging and prod shared hosts in place of 0.1.11.1 and 0.1.11.2** (the System Engineer decides); lab in `evidence/host-0.1.11.3-lab.txt`. |
| 0.1.13: **TEST bake, not for staging or prod.** `verify.sh` **63 passed, 1 failed** (`evidence/verify-<ami>.txt`): 63 steps passed; the mutation pass ends with `dirs` (`/run/desk-host` 755, not 711) and `svc-spec` (slot 1 would not start) failing; `verify-port.sh` and the lab not run (`docs/sub-status/host-0.1.13.md`); supersedes 0.1.12 | <ami> | 2026-11-11 17:41 | bac256ef | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.10-01883dd, desk-agent 2026.11.11-7ff8a2e, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-01883dd |
| 0.1.14: **superseded by 0.1.15** (it lacks the slot `datadirs` fix and the slot parity with desk 0.3.5). `verify.sh` **66 of 66** (`evidence/verify-<ami>.txt`, copied from its worktree), its mutation pass 50 of 50; its `verify-port.sh` run left no result line; no lab | <ami> | 2026-11-11 18:41 | af80cf83 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.10-01883dd, desk-agent 2026.11.11-7ff8a2e, desk-agent-filter 0.1.1, desk-notebook 2026.11.10-01883dd |
| 0.1.15: **`verify.sh` 70 of 70** (`evidence/verify-<ami>.txt`) and **`verify-port.sh` 72 of 72** (`evidence/verify-port-<ami>.txt`), each once with its whole mutation pass, step 2b and sections 7 and 8; from `main`; **the main-line candidate for staging shared hosts after 0.1.11.3** (the System Engineer decides; pending Security's read of the anchor and Platform's PU and PB asks); lab in `evidence/host-0.1.15-lab.txt`; supersedes 0.1.14 | <ami> | 2026-11-12 00:28 | c06c04e1 | 6.12.116+deb13-arm64 | 156.0.8078.79 | desk-rtc 0.5.1, desk-stream 0.3.5, deskd 2026.11.11-90528b5, desk-agent 2026.11.11-90528b5, desk-agent-filter 0.1.1, desk-notebook 2026.11.11-90528b5 |
