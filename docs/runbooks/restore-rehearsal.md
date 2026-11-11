# Restore rehearsal (TD-110)

**Status (2026-11-11): gate 9 passes on rerun, and Part 6 ran from a by-hand snapshot; gate 10 (DLM on restored volumes) and a real daily snapshot's restore are still unrun** ("Rerun, 2026-11-11" below). Spec written 2026-11-06. **Part 1 ran and passed on 2026-11-06, 10:19 to 10:32 UTC** (handoff 16 E, one agent as P and S): `0.2.2` to `0.2.4`, `<ami>`, the launch image, not the `0.2.3` this page names. Evidence: `image/evidence/restore-rehearsal-2026-11-06.txt`. **Parts 1 to 5 ran on 2026-11-07, 18:16 to 19:48 UTC: gates 1 to 8 passed, gate 9 (the control) failed, gate 10 hasn't run** ("Results, 2026-11-07" below). System Engineer owns this page. Platform Engineer runs the AWS side.

**Part 1's results [run].** Seed 5 of 5. Planned stop: marked to `stopped` 21 s, start to SSM Online 18 s, `stop-wake` passed. Preflight: OK, 156.0.8078.79 both sides. Swap task 29 s, kept root `<volume>` (`Purpose=replaced-root-keep`), new root `<volume>`, tagged from the old one. `root-swap` passed: both cookies, history, the tabs and a password that decrypts. The swap brought back the baked `desk-rtc` 0.3.0, `desk-stream` 0.2.2 and `deskd` `2026.11.06-4919e5d`, the same as the desk ran, so step 7 rolled nothing on. `desk-firstboot` said `NOT formatting`. The record read `{"volumeId":"<volume>","formattedAt":null,…}` and its copy matched, as step 8 expects. `on_new` was set and kept as the baseline. **`exitType` read `Crashed` after the swap:** the swap's reboot isn't a clean exit for Chromium (unknown 5 below), and the session came through it anyway. *(Task 33: that read came in step 7, after step 5's check had started Chromium, which marks its profile `Crashed` while it runs, and `desk-browser-start` rewrites a `Crashed` before each start, so it says nothing either way. The swap path now closes Chromium first, `image/desk-browser-close.sh`, and `SESSION_CHECK=root-swap` reads `exitType` before anything starts it.)* Before you start step 5 (the `DeskBackup` tag) wasn't done, because Part 6 didn't run.

**The 2026-11-07 run [run]: Parts 1 to 5.** Below, under "Results, 2026-11-07". One agent as P and S, on the test desk only. The spec's names mapped onto today: `0.2.2` is `0.2.8` (`<ami>`), `0.2.3` is `0.2.9` (`<ami>`), `OLD_DATA` is 32 GiB and already had `DeskBackup=daily`, and a setup swap S0 put the desk on 0.2.8 first, so Part 1 was a real upgrade and the desk ended on 0.2.9. The full mapping: `docs/sub-status/td-110.md`. Evidence: `image/evidence/td-110-2026-11-07/`.

The owner: "A desk's browser session MUST be carried over no matter where that desk gets hosted. We should never clear browser history/cookies for any user." This is consequence 5 of ADR 0035, and TD-187.

Nobody has ever restored a desk backup. This runs an image upgrade, a rollback and a snapshot restore on the test desk, one after another, with a real session on it, and reads the session back each time.

**"Real" means** Chromium's own stores, filled by real HTTP responses and its password API: a persistent and a session cookie, history, two open tabs, and a saved password that decrypts. The values are test values on the desk's loopback (`e2e/tests/browser-session.spec.ts`). Nothing signs in to a third-party site.

**Marks.** **[run]** was seen on a real desk or in AWS. **[read]** comes from code or docs and hasn't been seen working here. A step with no mark is an instruction. Parts 1 to 5 ran as a sequence on 2026-11-07; Part 6 hasn't run.

## Rerun, 2026-11-11 [run]
Done on two temporary staging test desks of its own (`Owner=syseng-td110`, `ma-desk-0.3.3`, made with `desk-provision.sh --env staging --test`), because the shared test desk's lock was busy. Detail, numbers and the false starts: `docs/sub-status/td110-rerun.md`; timeline `image/evidence/td-110-2026-11-11/timeline.txt`.

| Gate | Result |
|---|---|
| 9, the control, rerun on `0.3.3` (CDP quit in the close) | **Pass.** A cookie set 3 to 11 s before each Chromium exit survived: `desk-browser-close` (about 4 s old at the quit), `systemctl stop desk-browser` (about 3 s), three planned stops through the platform's stop path (10 to 11 s), and Part 5 as written (`desk-browser-close`, then a snapshot with Chromium stopped, a volume from it, the restore check: `g9_s4` present, the marker set after the snapshot absent, `exit_type` `Normal`). Every close line read `quit=cdp exit_type=Normal` |
| Part 6, a restore from a snapshot taken with Chromium running | **Pass, but from a by-hand snapshot, not a DLM daily:** the new desk has none. Cookies (including `p6pre`, set 120 s before the snapshot), the saved password (decrypts), the tabs, the Agent's `master.key` and `age-band` came back; `p6after`, set after the snapshot, was gone; the volume record unchanged; the old data volume was put back and kept. The Notebook on that desk was empty, so it proves nothing about Notebook pages (Part 3's 2026-11-07 restore did, 25 pages) |
| 10, DLM snapshots restored volumes | **Not run.** I left the restored volumes untagged for DLM on purpose |

**Two corrections to this page.** (1) The image's journal is **persistent** (`Storage=persistent`), not wiped at stop: `journalctl -b -1` after a wake shows the previous boot's `desk-browser-quit` line, so a stop's `quit=` is readable without a watcher. (2) A planned stop through `desk-stop-test.py` sends the stop about 1 to 3 s after its mark (`stop_sent_at`) and the row reads `stopped` 14 to 28 s after it, not after the 60 s grace; a desk with `deskd` stopped (the session checks hold it off) does not heartbeat, so the stop waited the full 300 s once: start `deskd` before a planned stop. Also: `create-volume` fails with a duplicate `Owner` tag if the tags are copied from a volume that already has one.

## Results, 2026-11-07 [run]
**The rehearsal doesn't pass as a whole: gates 1 to 8 passed, gate 9 (the control) failed, and gate 10 (DLM) hasn't run.** The control's failure isn't the restore's: the marker cookie it lost never reached the disk at all, because Chromium doesn't write a cookie less than about 30 s old when it exits, even cleanly. Everything that was on the volume when the snapshot was taken came back, both times. TD-110 stays open. Timeline and every `[session]` and `[data]` line: `image/evidence/td-110-2026-11-07/timeline.txt`.

| # | Gate | Result |
|---|---|---|
| 1 | Session through stop and wake, and the swap to the new image | **Pass.** Seed 6 of 6. `stop-wake` and `root-swap` 1 of 1 each, `exit_type` `SessionEnded` before the swap |
| 2 | The downgrade check, rollback onto the kept root, roll forward | **Pass.** Preflight OK (156.0.8078.79 both sides), so the table's first row. The desk booted on the kept 0.2.8 root with no rollout, `deskd` `0e1fb6c` on data `98316db` had written, and `rollback` and `roll-forward` passed |
| 3 | Chromium running: first set present, `after_a` gone, on the restored volume | **Pass** |
| 4 | `desk-firstboot` `NOT formatting` on every boot | **Pass,** all ten boots |
| 5 | Record and `formattedAt` unchanged, copy matches, no Cost Guard flag | **Pass.** The record read `{"volumeId":"<volume>","formattedAt":null,…}` throughout. `deskd` `98316db` sends it, so the guard's rules ran for the first time with a real `deskd`: its identity for the test desk stayed `<volume>`, `before_record`, through four root swaps, two restores and two putbacks, and every one of its 34 lines for the test instance said `ok` |
| 6 | The new volume's tags, encryption, key, AZ, size, `SnapshotId`, `DeleteOnTermination` | **Pass,** V3 for both, and 3.6 read `daily True us-east-1a 32 False` |
| 7 | DTLS identity unchanged; `skeleton`, `stream`, `browser-window` on the restored volume | **Pass:** 6 of 6, 8 of 8 (B12 84/100 ms idle, 105/119 loaded, at the real RTT), 1 of 1 |
| 8 | The old volume back, with `after_a` | **Pass** |
| 9 | The control, Chromium stopped | **Fail.** `before_b`'s cookie was missing; its history entry was there, `after_b` was absent as it should be, and everything else was there. See below |
| 10 | DLM snapshots the restored volumes | **Not run:** needs the next 09:00 UTC with the restored volumes kept |

**Why the control failed.** `before_b` was set with `SESSION_MARK_WAIT=0`, as step 1 says, and Chromium was stopped about 11 s later (`systemctl stop desk-browser`, `exit_type` `SessionEnded`). Three reads, each through this page's own checks:
1. `putback` on `$OLD_DATA` with `before_b` added: missing there too. So it never reached the disk, and the snapshot didn't lose it.
2. No snapshot at all: a marker set 8 s before a clean stop was lost, with its history entry kept; one set 43 s before was kept.
3. SIGTERM to Chromium's main process alone (what `KillMode=mixed` would send), exit 0, `SessionEnded`: a marker set 4 s before was lost too. So it isn't systemd killing the network service first.

So a cookie reaches the disk only at Chromium's periodic commit, about every 30 s, however Chromium exits. History is written at exit. This also means `desk-browser-close.sh` before a root swap, a planned stop and a clean restart can each lose cookies set in the last 30 s or so: ADR 0035's "Clean restart: Safe" was measured with cookies older than that. The control as written can't pass on this Chromium: step 1 now waits the default 120 s. Part 3's `near_a`, set 13.4 s before the snapshot, came through only because a commit happened to land in between.

**Times.**

| What | Took |
|---|---|
| Planned stop, mark to `stopped` in the row | 23, 22, 31, 33 and 19 s (Parts 1, 3, 4, 5 and 5's putback). `desk-stop-test.py` first waits up to 5 min for its window, which a member doesn't see |
| Start to SSM Online | 16 to 19 s |
| Root swap by image (S0, Part 1) | Task 24 and 27 s; SSM 23 s after |
| Rollback onto the kept root, `--volume-id` | **Task 18 s**, SSM 11 s after. `DeleteOnTermination` comes back `False`, and `modify-instance-attribute` puts it back |
| Roll forward, `--volume-id` | Task 24 s, SSM 9 s after |
| **Restore from a snapshot, Part 3: mark to the session read passing** | **110 s:** stopped 22 s, V2 and V3 19 s, V4 5 s, V5 to SSM 19 s, check 39 s (Chromium's port 2706 ms, first read 9.6 s). `desk-firstboot` 137 ms, `data.mount` 360 ms with a journal replay, `desk-datadirs` 171 ms |
| Putback, Part 4: mark to the session read passing | 99 s |
| Reading the whole restored volume | 32 GiB in 261 s, 132 MB/s: gp3's 125 MiB/s ceiling, because this volume holds only about 570 MB. A full one will be slower first |
| Snapshot to `completed` | Under 3 min each |

**How much a restore loses.** Everything on the volume at the snapshot's `StartTime` came back: the session, `on_new`, `before_a`, the Notebook, the Agent's key file, `age-band`, the record and the DTLS identity. `after_a`, set 41 s after `StartTime`, was gone, as it should be. Add to that up to about 30 s of cookies Chromium hadn't committed. In real use that's the time since the last daily, up to about 24 h, plus those 30 s.

**The data `/data` now holds,** read with `data-check.sh` before and after every step: the Notebook's 25 live pages (of 41, then 43 after another session's run before Part 2), `readable/`'s 25 files hashing `a579c2ce640dc1c1`, the Agent's `keys/master.key` (32 bytes, `1103:1103 600`; this test account has no sealed keys), and `age-band` (`adult`, `desk:desk 600`, 6 bytes) were the same on every root and every volume, restored ones included. Nobody wrote a Notebook page between a snapshot and its restore, so that proves the restored Notebook intact, not where its loss window ends.

**Resources:** every root, volume and snapshot this run made was deleted once its part was proven, except `SNAP_B`, `<snapshot>`, kept as the control's evidence. The test desk ended on 0.2.9 (`ROOT_NEW`), on `$OLD_DATA`, healthy.

## Rules
- Test desk only: `<test-desk>`, `<instance>`. Never `<instance>`.
- **Nothing is deleted during this rehearsal, pass or fail.** See "Deleting".
- A result that isn't what this page says: stop, and go to "On a failure". Don't push on to the next part.
- A pass closes TD-110 and the rehearsal half of TD-187. It authorizes nothing on the owner's desk.

## Who does what
| Who | Does |
|---|---|
| **P**, Platform Engineer | Start, stop, root swaps, snapshots, volumes, tags. Writes the UTC time next to every step. |
| **S**, System Engineer | Session checks, reads on the desk over SSM, component rollouts on the test desk, the evidence file. |

Hand over by direct message at each change of letter. The evidence goes in `image/evidence/restore-rehearsal-<date>.txt`: the timeline, each run's `[session]` lines and the describe output.

## Values
Read 2026-11-06 02:48 UTC **[run]**. Read them again before starting: Platform grew this volume from 8 to 9 GiB while this page was being written, and a swap changes the root's ID.
```bash
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
I=<instance> AZ=us-east-1a
OLD_DATA=<volume>   # 9 GiB gp3, 3000 IOPS, 125 MB/s, encrypted, /dev/sdf, DeleteOnTermination false, no DeskBackup tag
ROOT_022=<volume>   # 12 GB, /dev/xvda, DeleteOnTermination true, from ma-desk-0.2.2's snapshot
AMI_022=<ami>    # ma-desk-0.2.2, Chromium 156.0.8078.79
NEW_AMI=<ami>    # ma-desk-0.2.3, baked 02:35 UTC, tag ChromiumVersion=156.0.8078.79. S confirms this is the one that passed verify.sh
SNAP_TAGS='ResourceType=snapshot,Tags=[{Key=Project,Value=minimalist-alliance},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform},{Key=DeskId,Value=<test-desk>},{Key=DeskKind,Value=test},{Key=Purpose,Value=restore-rehearsal}]'
```
S runs every session check from `e2e/`:
```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
S='npx playwright test tests/browser-session.spec.ts --output test-results-session'
```

## Traps
- **`SESSION_KEEP=1` on every check but the last.** Without it a check closes the seeded tabs, and the next check fails.
- **No viewer and no other spec during a session run** (`e2e/README.md`).
- **The desk's journal is wiped at stop [read].** `SESSION_CHECK=restore` reads it first. Read anything else you want before the next stop.
- **Two data volumes attached at once:** `desk-firstboot` refuses and the desk doesn't come up, with nothing formatted **[read]**. Detach first, every time.
- **A volume made without `--snapshot-id` is blank, and `desk-firstboot` formats a blank volume [read].** That's the empty browser this rehearsal exists to prevent. Step V3 below catches it.
- **The row can read `stopped` for up to 5 minutes after a quick start [read, `sweep.ts`],** and `desk-stop-test.py` refuses anything but `running`. Wait for it.
- **Never `desk-rtc` 0.2.0 on this image [run].**
- **`SESSION_CHECK` has never run,** and the rehearsal modes have only passed `--list`, a type check and a local check of their Python and shell. A first failure may be the check. If tabs read as lost, look at their URLs in the log before calling it a loss.

## Before you start
1. **S:** the new `0.2.3` passed `image/verify.sh` and is on `main`. Give P the AMI, and read its `ChromiumVersion` tag, because Part 2 depends on it. This one's tag equals `0.2.2`'s **[run]**, and it hadn't finished `verify.sh` when this was written.
2. **S:** tell whoever uses the test desk the window. Until you say so, nobody opens `test.office.staging`, signs in as `desk-1`, runs `e2e/` or rolls anything out. Focusing a stopped desk in the app wakes it (`web/src/shell/actions.ts`), and nothing stops a wake in the middle of a swap **[read]**.
3. **P:** check the row. `hello_optional` on and `auto_stop_minutes` 180 **[read, `platform-eng.md`]**. The run can pass 180 idle minutes, and an idle stop in the middle spoils "Chromium running", so raise it for the window or watch it. Your call.
4. **P:** check your permissions, because `claude-agent`'s policy wasn't read for this. Each should answer `DryRunOperation`:
   ```bash
   aws ec2 create-snapshot --dry-run --volume-id $OLD_DATA
   aws ec2 create-volume --dry-run --availability-zone $AZ --size 1 --volume-type gp3
   aws ec2 detach-volume --dry-run --volume-id $OLD_DATA
   aws ec2 attach-volume --dry-run --volume-id $OLD_DATA --instance-id $I --device /dev/sdf
   aws ec2 create-replace-root-volume-task --dry-run --instance-id $I --volume-id $ROOT_022
   aws ec2 modify-instance-attribute --dry-run --instance-id $I --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"DeleteOnTermination":true}}]'
   ```
5. **P:** give the test desk's volume the backup tag. Test desks don't get it (`desk-provision.sh`), so otherwise there's nothing to carry over: `aws ec2 create-tags --resources $OLD_DATA --tags Key=DeskBackup,Value=daily`. DLM picks it up at the next 09:00 UTC. The first real one started at 09:18 **[run]**.
6. **S:** `rm -f screenshots/session-baseline.json`, in case of an earlier rehearsal.

## Part 1: image upgrade (this is TD-189)
Don't do TD-189 separately. This replaces steps 3 and 4 of "Resume here" in `image/RELEASES.md`, with one change: **keep the old root.** `desk-rollout.md` puts `--delete-replaced-root-volume` on test-desk swaps, and the last three swaps used it **[run]**. With it there's nothing to roll back onto.

1. **S:** seed: `SESSION_KEEP=1 $S`. Five tests pass. This leaves Chromium running, with the seed in place.
2. **P:** `scripts/desk-stop-test.py`, then `aws ec2 start-instances --instance-ids $I`. Wait for SSM Online.
3. **S:** `SESSION_CHECK=stop-wake SESSION_KEEP=1 $S`
4. **P:** swap. The instance reboots, in about 22 s **[run]**. Close Chromium first, in the same line, so a refusal or a dirty close stops the swap (`image/README.md`, "Before a root swap"; `$MA_DESK` is an `ma-desk` checkout):
   ```bash
   scripts/desk-root-preflight.sh $I $NEW_AMI && $MA_DESK/image/desk-browser-close.sh $I && aws ec2 create-replace-root-volume-task --instance-id $I --image-id $NEW_AMI --no-delete-replaced-root-volume
   ```
   When the task says `succeeded`, read the new root's ID as `ROOT_NEW`, tag it as `desk-rollout.md` step 3 says, and tag the kept root: `aws ec2 create-tags --resources $ROOT_022 --tags Key=Purpose,Value=replaced-root-keep`
5. **S:** `SESSION_CHECK=root-swap SESSION_KEEP=1 $S`
6. **S:** read the new root in the background (`desk-rollout.md` step 4), about 16 minutes **[run, the owner's 12 GiB root]**, so later timings are about the data volume and not the root.
7. **S:** roll the components back on: `~/minimalist-alliance/scripts/desk-service-release.sh rollout <component> <version> test --instance $I`. `desk-rtc` 0.2.1, `desk-stream` 0.2.1, and `deskd`:
   - **Prefer the Desk Engineer's coming release,** which sends `volumeId` and `formattedAt`. Only with it can the Cost Guard's rules run at all. The kept root stays on `2026.11.05-f2711bb` **[read]**, so a rollback also takes `deskd` back, and an old `deskd` refusing newer data is a finding.
   - If it isn't out, use `2026.11.05-f2711bb` and record the guard's rules as not exercised.
8. **S:** `SESSION_MARK=on_new $S`. The first run keeps the baseline in `screenshots/session-baseline.json`: `/data/.ma-volume` and a hash of the DTLS identity. Check the log: the record should read `{"volumeId":"<volume>","formattedAt":null,"firstSeenAt":"…"}`. `formattedAt` is null because this volume is older than `0.2.3` **[read]**. This is the first time `desk-datadirs`' record runs on a desk.

`e2e/`'s other specs run once, in Part 3, on the restored volume.

## Part 2: rollback, onto the root it came from
This is the first procedure for it. It ran on 2026-11-07 onto a kept 0.2.8 root and back **[run]**. DEP-34 forbids a swap to an older Chromium on a desk with a real profile, and the table below keeps to that.

**What the downgrade check does.** `0.2.2` has no refusal of its own, so two checks stand in front of it:
- **Before the swap,** `scripts/desk-root-preflight.sh` compares the profile's `Last Version` with the target image's Chromium **[read; it has run read-only on this desk]**.
- **After the swap, before anything starts Chromium,** `SESSION_CHECK=rollback` compares `Last Version` with the Chromium really on that root, and stops if the profile is newer. A root's Chromium can move above its image's.

| New `0.2.3`'s Chromium | Preflight to `0.2.2` | Do | What happens to the profile |
|---|---|---|---|
| Same as `0.2.2` (156.0.8078.79). **Expected, going by the tag** | Passes, exit 0 | Roll back | Nothing. `Last Version` stays, and Chromium opens it as usual **[read]** |
| Newer, and Chromium has run on it | **Refused, exit 1, no override** | **Don't roll back to `0.2.2`.** This is the correct result: record it. Then swap to `$NEW_AMI` once more, keeping `$ROOT_NEW`, and run the steps below onto `$ROOT_NEW`, so the mechanics are still rehearsed | Nothing |
| Can't be read | Refused, exit 1 | Stop. `--owner-accepts-unread-version` is the owner's decision alone, and this rehearsal doesn't use it | Nothing |

So with today's bake this rehearses a rollback, not a downgrade. A real refusal has only run with faked version numbers (`verify.sh`, the preflight's own tests). If someone gets past both checks: **cookies are razed at Chromium's first start, persistent and session alike, and `Web Data` is recreated. `History` and `Login Data` refuse to open and keep their rows, so passwords are hidden, not lost** (ADR 0035, **[run]** with faked version numbers). Only a snapshot brings the cookies back, which is why step 2 takes one.

1. **P:** `scripts/desk-root-preflight.sh $I $AMI_022`, straight before step 3. Follow the table.
2. **P:** `SNAP_RB=$(aws ec2 create-snapshot --volume-id $OLD_DATA --description 'TD-110 before rollback' --tag-specifications "$SNAP_TAGS" --query SnapshotId --output text)`
3. **P:** roll back. The instance reboots and keeps its IP **[read, AWS docs]**. `--volume-id` is the option for an existing volume, which must be `available` and in the same AZ **[read]**. It worked on 2026-11-07: an 18 s task, and the root came back with `DeleteOnTermination` `False`, which the `modify-instance-attribute` below put right **[run]**. Close Chromium first, and roll back only on its exit 0:
   ```bash
   $MA_DESK/image/desk-browser-close.sh $I
   aws ec2 create-replace-root-volume-task --instance-id $I --volume-id $ROOT_022 --no-delete-replaced-root-volume
   aws ec2 describe-replace-root-volume-tasks --filters Name=instance-id,Values=$I --query 'sort_by(ReplaceRootVolumeTasks,&StartTime)[-1].[TaskState,ReplaceRootVolumeTaskId]' --output text
   aws ec2 modify-instance-attribute --instance-id $I --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"DeleteOnTermination":true}}]'   # this attribute doesn't carry over with --volume-id [read]
   ```
   **If `--volume-id` is refused:** stop the instance, detach the current root, attach `$ROOT_022` with `--device /dev/xvda`, run the `modify-instance-attribute` above, and start. **[read]**, also not run.
4. **S:** `SESSION_CHECK=rollback SESSION_PRESENT=on_new SESSION_KEEP=1 $S`. The log should say `image=0.2.2`, with `deskd` already serving and no rollout needed, because `/opt/ma` is on that root **[read]**. Look at `exitType`: it's the first evidence of whether a root swap lets Chromium exit cleanly. P confirms the row is `running`.
5. **P:** roll forward the same way: preflight against `$NEW_AMI`, then the commands in step 3 with `--volume-id $ROOT_NEW`.
6. **S:** `SESSION_CHECK=roll-forward SESSION_KEEP=1 $S`

## The swap (P)
Used by Parts 3 and 5. `SNAP` is the snapshot and `NEW` the volume it makes.

- **V1. Stop.** `scripts/desk-stop-test.py`, the planned stop a member's desk gets. Then `aws ec2 wait instance-stopped --instance-ids $I`. The row says `stopped` before EC2 does **[read]**.
- **V2. Make the volume.** Copy the tags **from the old volume, never from the snapshot.** A daily snapshot also carries `aws:` and `dlm:` tags **[run]**, and a pre-rollout snapshot has no `DeskBackup` at all **[read, `desk-service-release.sh`]**. `create-volume` copies no tags by itself **[read]**.
  ```bash
  TAGS=$(aws ec2 describe-volumes --volume-ids $OLD_DATA --query 'Volumes[0].Tags' --output json | jq -c '[.[] | select(.Key | startswith("aws:") | not)] + [{Key:"Purpose",Value:"restore-rehearsal"}]')
  NEW=$(aws ec2 create-volume --availability-zone $AZ --snapshot-id $SNAP --volume-type gp3 --iops 3000 --throughput 125 --tag-specifications "$(jq -nc --argjson t "$TAGS" '[{ResourceType:"volume",Tags:$t}]')" --query VolumeId --output text)
  aws ec2 wait volume-available --volume-ids $NEW
  ```
- **V3. Check it before it goes anywhere near the desk.** `$NEW`'s `SnapshotId` must be `$SNAP`. Everything else must match `$OLD_DATA`: AZ, size, type, IOPS, throughput, encrypted, the same KMS key, `DeskBackup=daily`, `DeskId`.
  ```bash
  aws ec2 describe-volumes --volume-ids $NEW $OLD_DATA --query 'Volumes[].[VolumeId,SnapshotId,AvailabilityZone,Size,VolumeType,Iops,Throughput,Encrypted,KmsKeyId,Tags[?Key==`DeskBackup`]|[0].Value,Tags[?Key==`DeskId`]|[0].Value]' --output text
  ```
- **V4. Swap.** Always `/dev/sdf`, because `desk-firstboot` refuses another mapping **[read]**. Expect `/dev/sdf attached False` on the last line: `False` is `DeleteOnTermination`, the default for an attach **[read]**.
  ```bash
  aws ec2 detach-volume --volume-id $OLD_DATA; aws ec2 wait volume-available --volume-ids $OLD_DATA
  aws ec2 attach-volume --volume-id $NEW --instance-id $I --device /dev/sdf; aws ec2 wait volume-in-use --volume-ids $NEW
  aws ec2 describe-volumes --volume-ids $NEW --query 'Volumes[0].Attachments[0].[Device,State,DeleteOnTermination]' --output text
  ```
- **V5. Start.** `aws ec2 start-instances --instance-ids $I`. Tell S the volume's ID as soon as SSM is Online. Nothing else touches the desk first.

To put a volume back, run V1, V4 with the volumes swapped round, and V5. Skip V2 and V3. Stay on the original `$OLD_DATA`.

## Part 3: snapshot restore, Chromium running. **This is the gate.**
**Which snapshot is the gate, and why it matters.** A daily backup is taken with Chromium running, so that's what has to work. It isn't the same test as `kill -9`: a killed process leaves its writes with the kernel, while a snapshot has only what had reached the volume **[read, AWS docs]**. So ADR 0035's crash result doesn't answer this. Upstream Chromium commits cookies every 30 s, with a rollback journal and a full sync on each commit **[read, `main`, not Debian's build]**, so committed cookies should be there. Anything Chromium hasn't synced can be missing. Part 5 is the control: it tells a loss from crash consistency apart from a loss from the procedure.

1. **S:** `SESSION_MARK=before_a $S`. It waits 120 s after setting the marker: a margin for the 30 s commit **[read]** and the kernel's own write delay (default values, not read from the desk). Check `browser=active` in the log, then tell P at once.
   Optional, measured and not a gate: `SESSION_MARK=near_a SESSION_MARK_WAIT=5 $S` straight after, to see what happens to a cookie less than a minute old. The times in the logs give the real gap.
2. **P:** snapshot, with Chromium running. It's point-in-time at the call **[read]**. Give S the `StartTime`. `SnapshotCreationPerVolumeRateExceeded` means retry **[run]**. One took 48 s **[run, the owner's desk]**.
   ```bash
   SNAP_A=$(aws ec2 create-snapshot --volume-id $OLD_DATA --description 'TD-110 restore, Chromium running' --tag-specifications "$SNAP_TAGS" --query SnapshotId --output text)
   aws ec2 describe-snapshots --snapshot-ids $SNAP_A --query 'Snapshots[0].StartTime' --output text
   aws ec2 wait snapshot-completed --snapshot-ids $SNAP_A
   ```
3. **S:** once you have the `StartTime`, and not before: `SESSION_MARK=after_a $S`. Then check the order in the logs: `before_a` ready, then `StartTime`, then `after_a` set. If it's wrong the run proves nothing, so redo it with new names.
4. **P:** the swap, with `SNAP=$SNAP_A`. Call the new volume `NEW_A`, and tell S.
5. **S:** first thing on the desk:
   ```bash
   SESSION_CHECK=restore SESSION_VOLUME=$NEW_A SESSION_ABSENT=after_a SESSION_PRESENT=on_new,before_a SESSION_KEEP=1 $S
   ```
   This is the loss window, measured. The first set is present, the second is gone. In real use the gap is the time since the last daily, so up to about 24 h, plus Chromium's lag.

   Before starting Chromium, it stops if any of these is wrong:
   - `/data` isn't mounted.
   - `desk-firstboot` didn't say `NOT formatting`, or said `FORMATTED`, `REFUSING` or `creating ext4`. This is the check that a restored, lazily loaded volume wasn't taken for blank. Reads load from the snapshot on demand **[read]**, and the script only calls a disk blank after `blkid`, `wipefs` and the backup superblocks all find nothing **[read]**.
   - `Last Version` is missing, or newer than this root's Chromium.
   - The volume mounted isn't `$NEW_A`.

   It then compares `/data/.ma-volume` and the DTLS identity with the baseline, and checks the copy at `/data/desk/volume.json`. **The record must not change,** so the Cost Guard's `data_formatted` and `data_volume_changed` have nothing to fire on. Its `volumeId` stays the original volume's and no longer matches EC2's **[read, contract 0.3.8]**: that's expected.

   It logs the times: `blame` for `desk-firstboot`, `data.mount` and `desk-datadirs`; start to Chromium's port (for scale, on a root: 3169 ms warm, 73448 ms cold **[run]**); and how long each read took.
6. **P:** `aws ec2 describe-volumes --volume-ids $NEW_A --query 'Volumes[0].[Tags[?Key==`DeskBackup`]|[0].Value,Encrypted,AvailabilityZone,Size,Attachments[0].DeleteOnTermination]' --output text` should say `daily True us-east-1a 9 False`, with the same size as `$OLD_DATA`.

   **Don't set `CostGuardVolumeTaskUntil` at any point.** `desks.md` says a restore shows no change, and this is the test of that. If `deskd` sends the record, P reads the guard's `identities` and logs after each swap (`desks.md`, "A volume changing under a desk"; a run every 5 minutes): a flag is a failure. `data_formatted` also means telling the owner at once.
7. **S:** read the rest of the volume, for the MB/s. It only reads, but check the `if=` twice. SSM's `--timeout-seconds` must be 30 or more **[run]**. For scale: a cold root read at 13.3 MB/s and a warm one at 450 MB/s **[run]**.
   ```bash
   D=$(findmnt -no SOURCE /data); nohup nice dd if="$D" of=/dev/null bs=1M >/tmp/data-read.log 2>&1 &
   ```
8. **S:** when that's done, one at a time, on the restored volume. This is TD-189's "all of `e2e/`", and it shows a restored desk really works. `skeleton.spec.ts` tests 1 and 2 are the check on `/data/desk` and on the DTLS identity: live status, and a direct connection on 443 to the fingerprint Platform holds.
   ```bash
   npx playwright test tests/skeleton.spec.ts --output test-results-skeleton
   npx playwright test tests/stream.spec.ts --output test-results-stream
   npx playwright test tests/browser-window.spec.ts --output test-results-browser
   ```
   A failure here: run that spec again in Part 4 on `$OLD_DATA` before blaming the restore.

### What a member would see
Nothing has been measured. App text is **[read]**.

| Stage | Member sees | Time |
|---|---|---|
| Stop | "going to sleep" with a countdown; Browser window: "This desk is going to sleep" | Mark to stopped about 30 s **[run]** |
| Swap | "asleep". **Opening the desk now wakes it,** and nothing stops that | Not measured, fill in from V1 to V5 |
| Wake | "waking · 1 of 4" and on | About 35 s **[read, design]**, plus slow first reads |
| First Browser | "Still starting…" | Not measured, see step 5 |
| After | Their browser as it was at the snapshot, with **no message saying what's gone** | |

**The number to report:** from the mark in V1 to the session read passing in step 5, split by stage.

Stop and start also moves the public IP, since the test desk has no Elastic IP **[run]**. Sites that tie a sign-in to an address will ask again (ADR 0035).

## Part 4: put the old volume back
This is the failure path, so it runs once before anyone needs it. It's also what proves `after_a` was real.
1. **P:** put `$OLD_DATA` back in place of `$NEW_A`.
2. **S:**
   ```bash
   SESSION_CHECK=putback SESSION_VOLUME=$OLD_DATA SESSION_PRESENT=on_new,before_a,after_a SESSION_KEEP=1 $S
   ```

## Part 5: snapshot restore, Chromium stopped. The control.
A desk with Chromium stopped gets this kind of snapshot in real use. It should lose nothing up to the moment Chromium exits.
1. **S:** `SESSION_MARK=before_b $S`, with the default 120 s wait, never `SESSION_MARK_WAIT=0`: Chromium writes a cookie only at its commit, about every 30 s, even when it exits cleanly, so a marker set just before the stop never reaches the disk and the control fails for that alone **[run, 2026-11-07]**. Then over SSM: `systemctl stop desk-browser`, and check `systemctl is-active desk-browser` says `inactive`.
2. **P:** as Part 3 step 2, naming it `SNAP_B` and describing it as Chromium stopped.
3. **S:** `SESSION_MARK=after_b $S`, which starts Chromium again.
4. **P:** the swap, with `SNAP=$SNAP_B`. Call the new volume `NEW_B`.
5. **S:**
   ```bash
   SESSION_CHECK=restore SESSION_VOLUME=$NEW_B SESSION_ABSENT=after_b SESSION_PRESENT=on_new,before_a,after_a,before_b SESSION_KEEP=1 $S
   ```
   Compare with Part 3: `exitType`, `mount` (a journal replay is expected in both, since the filesystem was mounted **[read]**), and the times.
6. **P:** put `$OLD_DATA` back in place of `$NEW_B`.
7. **S:** the last session run, so no `SESSION_KEEP`:
   ```bash
   SESSION_CHECK=putback SESSION_VOLUME=$OLD_DATA SESSION_PRESENT=after_a,after_b $S
   ```
   Then over SSM: `systemctl stop ma-session-pages; rm -rf /var/tmp/ma-session`. The test cookies and password stay in the test profile, as they already do (`e2e/README.md`).

**End state:** `$NEW_AMI`'s root, the original `$OLD_DATA`, everything else detached and kept. Tell people the test desk is free.

## Part 6: the next 09:00 UTC (a true floor, up to 24 h)
**P:** DLM should have snapshotted every tagged volume. This, and not the tag alone, is what shows backups survive a volume replacement:
```bash
for v in $OLD_DATA $NEW_A $NEW_B; do aws ec2 describe-snapshots --owner-ids self --filters Name=volume-id,Values=$v Name=tag:Purpose,Values=daily-backup --query 'Snapshots[].[VolumeId,SnapshotId,StartTime,State]' --output text; done
```
Recommended, not a gate: run the swap once more from that real daily snapshot of `$OLD_DATA`, then put `$OLD_DATA` back. Nobody has restored a real one yet. The manual snapshots stand in for it because DLM's time can't be chosen around a marker.

## Pass and fail
Every line must hold. The rehearsal passes only as a whole.

| # | Gate | Where |
|---|---|---|
| 1 | Cookies, session cookie, history, tabs and a password that decrypts, through stop and wake, and through the swap to `0.2.3` | Part 1 |
| 2 | The downgrade check does what the table says. If it passes: the desk boots on the kept root with no rollout, and the session and `on_new` are there, then again after rolling forward | Part 2 |
| 3 | **Chromium running: the first set present, `after_a` gone, on the volume made from the snapshot** | Part 3.5 |
| 4 | `desk-firstboot` said `NOT formatting`, and never `FORMATTED` or `REFUSING`, on every boot | Parts 3, 4, 5 |
| 5 | `/data/.ma-volume` and `formattedAt` unchanged, and the copy matches. If `deskd` sends the record, no flag from the Cost Guard | Parts 2 to 5 |
| 6 | The new volume: `DeskBackup=daily`, `DeleteOnTermination=false`, encrypted with the same key, the same AZ and size, and the right `SnapshotId` | The swap, 3.6 |
| 7 | The DTLS identity unchanged, and `skeleton.spec.ts`, `stream.spec.ts` and `browser-window.spec.ts` pass on the restored volume | Part 3.8 |
| 8 | The old volume goes back, and `after_a` is on it | Part 4 |
| 9 | The control passes too. A passing gate with a failing control is a failure to explain | Part 5 |
| 10 | DLM snapshots the restored volumes | Part 6 |

**Measured and reported, not gates:** all timings, `near_a`, `exitType`. A slow restore still needs the owner's view, because a member feels it. There's no budget for it yet: B18 is about Chromium's restart, not a restored volume.

## On a failure
**First, in every case:** stop. Delete nothing. Don't start Chromium again on the failed volume, because each start changes the profile, and reading it again from a fresh volume is cheap. Write what happened in the evidence file and your status file, and tell the Lead. TD-110 stays open, and so does everything waiting on it (S-10, S-13, ISS-09). No volume or root operation goes near the owner's desk.

| What you see | What it means | What to do |
|---|---|---|
| Preflight refuses the swap to `$NEW_AMI` | The new image is older than the profile | Bake again. Never override a known downgrade |
| Swap task `failed` or `failed-detached` | AWS rebooted on the original root, or the instance may have none **[read]** | P checks the block device mapping before anything else |
| Session lost after the swap or rollback | Real, or the check | Report at once. Keep both roots. P snapshots the data volume straight away. Read it from a volume made from that snapshot |
| Kept root doesn't boot | The procedure is wrong | Swap back to `$ROOT_NEW`, by the fallback if needed |
| `REFUSING TO FORMAT`, or `/data` not mounted | Safe, the volume is untouched **[read]**, but the restore failed | Read `journalctl -b -u desk-firstboot` before any stop. Then Part 4 |
| `data.mount` or `desk-firstboot` timed out | Slow reads beat a limit: the mount has systemd's default, `desk-firstboot` 300 s **[read]** | Read the journal first. Reboot once only if it's clearly slowness. It's a finding either way |
| **`FORMATTED`, or `formattedAt` changed, or no `Last Version`** | **The worst case: a restored volume was taken for blank, or the wrong volume went on** | Check `$NEW`'s `SnapshotId`. The snapshot and `$OLD_DATA` are untouched. Nothing else happens until the cause is known |
| Part of the first set missing | The restore loses what it must not | Don't restart Chromium. Make a second volume from the same snapshot. Compare with the control |
| An absent marker is present | It isn't the restored volume, or the order was wrong | Check `volume=` in the log and the three times. Not a pass |
| Tag missing, or no DLM snapshot | TD-187 fails | Add the tag by hand so the volume is covered, then find which step dropped it |
| `$OLD_DATA` won't come back | The way back is broken | Leave it detached, and keep `$NEW_A` on the desk if it passed. Tell the Lead |

To go back to a known state: put `$OLD_DATA` back and `$ROOT_NEW` on, and re-seed if needed. The session here is test data, so a loss is a finding, not an emergency.

## Deleting
**Approver: the owner, through the Lead.** Nobody else approves it, and no session deletes on its own (`HANDOFF.md` section 4; Platform's `CLAUDE.md`). Nothing is deleted during the rehearsal, even after a pass. When Part 6 is done, P lists these with IDs and costs and asks:
- `$NEW_A`, `$NEW_B`
- `$ROOT_022` (keep it if another rollback rehearsal is likely)
- `$SNAP_RB`, `$SNAP_A`, `$SNAP_B`, and the daily snapshots DLM took of these volumes

`$OLD_DATA` and the desk's current root stay. Taking `DeskBackup` off `$OLD_DATA` afterwards isn't a destroy, and it's P's call, since test desks don't normally have it. List its daily snapshots first: whether DLM still prunes them after the tag goes is unknown.

## Cost and time
**Cost, an estimate:** about $1 for the rehearsal plus a week waiting on approval, and about $2.85 a month if nothing is ever deleted. That's the test desk for 3 h, which it usually is anyway ($0.0725/h plus $0.005/h for IPv4); two restored 9 GiB volumes ($0.72 a month each); one spare 12 GB root ($0.96 a month); and snapshots, 9 GB at most since they're incremental ($0.45 a month at most). Prices are from `docs/desk-design.md` §11 and `desk-provision.sh`.

**Time, in agent time:** about 3 hours of running, most of it Part 3's specs and reads. True floors: the bake and `verify.sh` (about 50 minutes) if they aren't done, the root read (16 minutes), each `desk-stop-test.py` window (up to 5 minutes, 5 times), and the next 09:00 UTC for Part 6.

## Unknown, riskiest first
1. **Whether a session survives a crash-consistent snapshot at all.** *It did on 2026-11-07, once, from a snapshot taken with Chromium running: the cookies, history, tabs, a password that decrypts, and markers 13 s to 3 min old* **[run]**. *What's unknown now is the edge: a cookie under about 30 s old can be missing at any Chromium exit, clean or not, and so from any snapshot.* Before that run: only `kill -9` had run. The upstream reading is `main`. Debian's 156 build and this profile's real journal modes are unread, and nothing was read for how tab files reach the disk.
2. **How slow a restored data volume is, and whether that beats a limit.** *Measured once, 2026-11-07, on a volume holding about 570 MB: `data.mount` 360 ms with a journal replay, Chromium's port in 2.7 s, the whole 32 GiB read at 132 MB/s* **[run]**. *A full volume is still unmeasured.* Before that: The numbers above are for a root. `data.mount` sets no timeout of its own **[read]**, and a crash-consistent snapshot means a journal replay inside it.
3. **Nothing stops a wake during a swap.** What's read: with no data disk, `desk-firstboot` waits about 3 minutes, refuses and formats nothing, and the sweeper stops the desk after 10 minutes. Attaching a volume to a desk booting like that hasn't been read or tried.
4. **`--volume-id` for a root.** *Works: two tasks on 2026-11-07, 18 and 24 s* **[run]**. The fallback has never been used.
5. **Whether a root swap is a clean shutdown for Chromium.** AWS says only that it reboots **[read]**. If it isn't clean, a swap has the same window as a snapshot. Part 1's `Crashed` was read after Chromium had started again, so it's no evidence. Since task 33 it doesn't matter for a swap that follows these steps: `desk-browser-close.sh` closes Chromium before the swap, and `SESSION_CHECK=root-swap` checks the exit was clean. *On 2026-11-07 every swap read `SessionEnded` after the close* **[run]**, *but a clean exit still loses cookies under about 30 s old (Results, 2026-11-07).* *Since `sub/image-review-fixes` the close quits Chromium over CDP, which writes them, and it reads `Normal`* **[run, test desk, 2026-11-07]**.
6. **Chromium moving during the run.** The new image's tag equals `0.2.2`'s, but unattended upgrades cover Chromium, and that's never been seen firing on a desk (ADR 0035). If it moves the test desk first, the preflight refuses `0.2.2`, and Part 2's second row applies.
7. **A snapshot older than a desk's first boot on `0.2.3`, or older than a grow.** It has no record, so `desk-datadirs` writes a new one with the new volume's ID **[read]**, and `data_volume_changed` fires unless the instance is tagged. It also makes a volume of the old size, so V2 needs `--size` and then a `resize2fs`, or the member loses the space **[read]**. This applies to the owner's desk for a week after its swap. Not exercised here: every snapshot above is newer. `<snapshot>` (Platform's, before the grow) is one to try.
8. **What DLM does with snapshots of a volume that lost its tag or was deleted.** Retention counts per volume **[read]**. The docs found say an untagged volume stops being managed, and not what becomes of its snapshots.
9. **A real `formattedAt`, and the guard itself.** It's null on this volume **[read]**, so "doesn't change" is only proven for null here. `verify.sh` checks the record on a fresh volume, not through a restore. The guard's rules have only run in unit tests (`desks.md`).
10. **Real websites.** Everything here is loopback test data, on 9 GiB. A real site's sign-in needs a test account (open question Q4), and the owner may want one before calling this done. A bigger or busier volume will take longer, by an unknown amount.

## What doesn't exist yet
| Missing | Who'd write it | When |
|---|---|---|
| A restore script. This page's commands are by hand. It should copy tags from the old volume, run V3's checks and refuse on any mismatch | Platform Engineer | After a pass, before any real restore |
| The tested rollback in `desk-rollout.md`, in place of "no tested procedure yet" | Platform Engineer | After a pass |
| **A way to get Chromium's newest cookies to disk before a planned stop or a clean restart.** Before a swap it's done: `desk-browser-close.sh` quits Chromium over CDP (`Browser.close`), which writes them, and waits out the 31 s commit if CDP doesn't answer (on the test desk, a cookie set 8 s before was kept 5 of 5, and the old SIGTERM close lost one 1 of 1; `image/evidence/close-cookie-2026-11-07/`). A planned stop and a restart still end Chromium with systemd's SIGTERM and lose a cookie under about 30 s old. The same `Browser.close` as `desk-browser.service`'s `ExecStop=` would cover both, from the next image | System Engineer, with the Desk Engineer for `deskd`'s side of a stop | Next image |
| **A lock against a wake during a swap.** `upgrading` is in `WAKING`, so `wake()` wouldn't start the desk **[read]**, which may be enough. Not tried | Platform Engineer | Before any real restore |
| A check that every real desk's data volume has `DeskBackup=daily`. Today only `desk-provision.sh` sets it, once | Platform Engineer (TD-187) | With the restore script |
| A `deskd` that sends `volumeId` and `formattedAt`, so the Cost Guard's rules (Platform `8cd6b14`) can run. `formattedThisBoot` in hello is always false (`BootSequence.java`), so it's no signal | Desk Engineer, being built | Before Part 1 if it can be |
| A way to tell a member what a restore lost, and a state for it in the app | UI/UX Engineer, after Platform's state | Before any real restore |
| Reading a restored volume ahead of the member. The design says `deskd` does this for restored Guild Desks; nothing in `services/` does. AWS can also load a volume at a set rate, billed per GiB, not priced here | System and Desk Engineers | After the timings |

**After a pass:** System Engineer updates ADR 0035's table, `docs/desk-design.md` §6.6 and §10.4, and this page's status. Platform Engineer updates `desks.md` ("Restoring has not been rehearsed").
