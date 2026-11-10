# 0035. A desk's browser session is carried over, wherever the desk is hosted

**Status:** Accepted (the owner, 2026-11-06)
**Date:** 2026-11-06

## Context
The owner, 2026-11-06: "A desk's browser session MUST be carried over no matter where that desk gets hosted. We should never clear browser history/cookies for any user. That will make their lives so difficult and they will hate using the platform".

Chromium's profile lives on the data volume, at `/data/browser/profile`, so it survives a root replacement by design. Nobody had checked whether anything else can lose it, and no test has ever carried a real cookie or password through anything: the test desk's profile holds none of either.

## Decision
A member's browser session is a product requirement, not a cache.

**The session** is everything a member would miss: cookies and sign-ins, including session cookies; history; open tabs; saved passwords and autofill; extensions and settings.

**The platform never clears it.** No rollout, root or data volume replacement, resize, stop, crash, full disk, storage cap, support or reset flow, plan change or move between hosts may lose it. Anything that frees space may touch only rebuildable caches: the HTTP cache and code caches, never `Cookies`, `History`, `Sessions`, `Login Data`, or site storage.

**Allowed:** a member clearing their own data, and deleting their own account. This is the coordinator's reading, being confirmed with the owner.

**History follows Chromium's own limit.** Chromium expires history after 90 days, a compile-time constant, as Chrome does on a normal computer. We keep no copy of history beyond that. The owner, 2026-11-06: "Yes, 90 days is fine". This is the browser working normally, not the platform clearing anything.

**Also allowed: deletion about 37 days after payments stop** (`ma-platform` ADR 0049), though the member doesn't choose it. Asked "Keep deleting desks about 37 days after payments stop?", the owner said, 2026-11-06: "Yes keep it".

## Where it stands, audited 2026-11-06
Read-only, from code and the test desk. "Upstream" means Chromium's `main` source, read and not run on Debian's build.

| Event | Verdict | Evidence |
|---|---|---|
| Rollouts of `desk-rtc`, `desk-stream`, `deskd` | Safe | `ma-update` stays in `/opt/ma` (code); Chromium survives a `deskd` restart (run) |
| Chromium's own updates | Unknown | Unattended-upgrades covers it, unheld; never seen firing on a desk |
| Root replacement | **Can lose** | History kept 37 visits on the test desk (run), but a swap to an image with an older Chromium is a downgrade, below. A real cookie and history survived a real root replacement on a box booted from `0.2.3`, with the same image (run, `verify.sh`). A saved password and tabs through a swap, and a swap between two images: not run yet. The reboot may not ask Chromium to shut down, so the swap path closes it first, `image/desk-browser-close.sh` (task 33) |
| Chromium downgrade | **Can lose, proven** | Run on 156.0.8078.79 with faked newer version numbers on a throwaway profile, not a real older Chromium. `Cookies` is razed, persistent and session cookies alike. `Web Data` is recreated. `History` and `Login Data` refuse to open and keep their rows, so passwords are hidden, not lost. A newer `Last Version` alone does nothing, and Chromium overwrites it. Evidence: `image/evidence/chromium-downgrade-2026-11-06.txt`. The refusal ran on `0.2.3` with a faked `Last Version` (`verify.sh`): exit 78, profile hash unchanged, and it starts again with the real version |
| Data volume restore | **Can lose up to 24 h** | Daily snapshots, keep 7. Rehearsed on the test desk 2026-11-07 (TD-110, `docs/runbooks/restore-rehearsal.md`, "Results, 2026-11-07"): from a snapshot taken with Chromium running, everything on the volume at the snapshot came back (cookies, history, tabs, a password that decrypts, the Notebook, the Agent's key file), in 110 s from the stop to the session read, with no Cost Guard flag (run). Not yet from a real daily snapshot, and DLM on a restored volume hasn't been checked. Add up to about 30 s of cookies, as below |
| Resize | Safe, designed only | `ma-platform` `docs/runbooks/desks.md`; never run with a real profile |
| Clean restart of Chromium | Safe, **except cookies under about 30 s old** (run, 2026-11-06 and 2026-11-07) | Cookies, history, tabs and the saved password, each read back. Not a real stop. **2026-11-07:** a cookie set 4 to 11 s before a clean exit (`exit_type` `SessionEnded`, by `systemctl stop` and by SIGTERM to the main process alone) was never written, though its history entry was; one set 43 s before was kept. Chromium writes cookies only at its commit, about every 30 s, so the same goes for a planned stop. **Before a swap it's closed:** from `sub/image-review-fixes`, `desk-browser-close.sh` asks Chromium to quit over CDP (`Browser.close`, its own Exit), which writes them: on the test desk a cookie set 8 s before the close was on disk after it 5 of 5 (a sixth run was void: a periodic commit got there first), and one set 3.2 s before 1 of 1, while the old SIGTERM close lost one 1 of 1 (`image/evidence/close-cookie-2026-11-07/`). A planned stop and a restart still go through SIGTERM |
| Stop and wake | Tabs and cookies unproven | Clean exit seen in the journal; `verify.sh`'s stop check runs before Chromium starts. On `0.2.3`, a real cookie and history survived a real EC2 stop and start on a box from the AMI (run, `verify.sh`). A saved password and tabs: not run yet |
| `deskd` restart | Safe (run, 2026-11-06) | The same four things, and Chromium keeps its PID |
| Crash | Safe, **except the last moments** (run, `kill -9`, image 0.2.2) | Persistent and session cookies about 40 s old, history, tabs and the saved password all survive, and the password decrypts. A cookie set 2 s before the kill was lost, one run. Upstream commits cookies about every 30 s (read, not measured) |
| Full `/data` | **Can lose** | `deskd` deletes nothing (code); under 800 MB free, Chromium evicts IndexedDB, Cache Storage and service workers (upstream) |
| T68's cap on the browser's share | Safe, nothing more to cap | `--disk-cache-size` caps the HTTP cache at 1 GiB (run). Upstream, read and not run: the media cache is part of it, and the code cache sets its own limit from free disk. What else grows is site storage and history, which this ADR protects, and downloads, which no flag caps. So a total can't be promised: reword the public claim |
| Support and reset flows | No wipe exists | Code; data volume `DeleteOnTermination=false` on all four desks |
| Blank volume at first boot | **Can lose** | `desk-firstboot` formats a volume it proves blank, and the member sees an empty browser. Refusals on non-blank volumes are proven. A record of the format ran on a box from `0.2.3` (`verify.sh`) and survives a reboot, a stop and a root replacement. Nothing alarms on it yet |
| `/data` not mounted | Safe | Units refuse, and the mountpoint is root-owned (code), so no fresh profile on root |
| Encryption keys | Safe | `--password-store=basic`, no keyring, fixed key, so the profile isn't tied to the root or the machine (run) |
| Uid, hostname, `machine-id` | Safe | uid 1102 is fixed; the profile lock's hostname is handled (`desk-browser-start`) (code) |

## Work under way, 2026-11-06
The resume note is at the top of `image/RELEASES.md`. `e2e/tests/browser-session.spec.ts` is on `main`.
`ma-platform`'s `scripts/desk-root-preflight.sh` (`ff590a4`) refuses a root swap to an older Chromium, but a bare AWS root replacement isn't stopped, so follow `docs/runbooks/desk-rollout.md`. `ma-desk-0.2.3` is `<ami>`, verified 21 of 21 by `verify.sh`, on no desk yet. The earlier bakes of that name are deleted.

## Moving between hosts
Not designed; T93 is only a question so far. What it would need, unrun:
- Stop the desk first, so the profile is closed.
- A file-level copy of `/data/browser`, because EBS snapshots stay inside EC2.
- The same or newer Chromium at the destination.
- `--password-store=basic` kept, and uid 1102 or a `chown`.

There's no key material to carry. SQLite should move across architectures, and code caches rebuild. Sites that tie a sign-in to an IP address will ask again, and that can't be fixed from our side.

## Consequences
What this asks of later work, smallest first:
1. `verify.sh` and `e2e/` carry a real cookie and saved password through crash, stop and wake, and root swap, on a test desk. Until then every "safe" above is about tabs or code, not sign-ins.
2. Chromium is held to what the image shipped, or the wrapper refuses to start when the profile's `Last Version` is newer, instead of letting it raze the data.
3. An alert on the data volume's free space, from the heartbeat, and a way to grow it. Downloads are uncapped today.
4. The volume's ID recorded at first boot, and an alarm if a desk that had a profile ever formats.
5. TD-110's rehearsal uses real cookies and passwords. Backups must keep their `DeskBackup` tag after any volume replacement.
6. Any cap for T68 touches caches and downloads only.
