# Task 32's rehearsal

Runs the four parts of task 32 together for real, on one machine: deskd's `data.*` (`services/deskd`, `API.md` §12), the
root helper `desk-data` (`tools/desk-data/`), the move tool `ma-move` (this folder's parent) and the Desk app's
`/export` page (`web/src/export/`). As the current user, on loopback only, nothing as root, no AWS. Draft ADR:
`docs/decisions/draft-data-export-and-transfer.md`.

```sh
tools/desk-move/rehearsal/rehearse.sh            # builds, then both tests: about 2 minutes here
tools/desk-move/rehearsal/rehearse.sh --no-build --only move    # or --only export; --keep keeps the trees
```

It prints `PASS` or `FAIL` and exits 0 or 1. Everything is under one scratch directory, `MA_REHEARSE_DIR` (default
`/tmp/claude-$UID/ma-rehearse`): `evidence.json` (every check and number), `logs/` (each process's output, the
helper's requests in `logs/helper/reads.jsonl`, `units.log`). Every port is a free one and every socket path its own.
Every process it starts is stopped on the way out, Ctrl-C included, and the big files go unless `--keep`.

Needs: Go in `~/.local/go`, Temurin 21 (`services/scripts/bootstrap-toolchain.sh`), Node 24 in `~/.local/node-v24`,
Playwright's Chromium in `~/.cache/ms-playwright` (`MA_REHEARSE_CHROMIUM` for another), `systemd-socket-activate`,
`unzip`. Builds take `~/work/.build.lock` when it exists, and the rig runs under `nice -n 10`.

## What runs

| Part | How |
|---|---|
| `gateway-shim`, `desk-rtc` | From `desk-rtc/`, built into `bin/` in the scratch directory |
| deskd | The jar from `./mvnw -DskipTests package`, a plain JVM, with `fake-imds.py` and the shim as its platform, its sockets in the scratch directory, `DESKD_DATA_SOCKET` at the helper, `DESKD_CDP_UID` this user |
| `units.sock` | A stub in `rig.py`: answers `ok`, logs each verb, and really stops (gracefully, over CDP: headless Chromium doesn't write its cookies down on SIGTERM) and starts the source's Chromium. On each stop it copies the stopped profile, so the held pass can be compared |
| `desk-data` | The real helper, socket-activated per connection by `systemd-socket-activate --accept --inetd`, through `helper-run.py`, which runs its `Helper` as its tests do (the source tree as `/data`, this uid as deskd's) and records each request and its bytes for the checks. The helper itself is unchanged |
| Chromium | Headless, with `desk-browser-start`'s flags (`--password-store=basic` among them) and `session.restore_on_startup: 1` standing in for the image's `RestoreOnStartup` policy. A page on loopback sets persistent, HttpOnly, path-scoped and session cookies on two hosts, localStorage and IndexedDB, and there are five visits and a real-format `Bookmarks` |
| Trees | A source `/data` (`desk/`, `agent/` with a SQLite database in WAL mode, `apps/` with installed packages and a cache, `files/` with a 300 MiB `big.bin`, links in and out of the part, an empty folder, UTF-8 names) and a target `/data` with `selfhost/desk.json`. Both have `rtc/`, `selfhost/`, `desk-egress/`, `.ma-volume` and `lost+found/`, watched with inotify |

## Test A, the move
A stand-in for the platform's `/v1/moves/claim`, `/connect` (to the shim's `connect`, which gives an `owner` token:
the `export` scope is only unit-tested, in deskd) and `/report` (kept as it came). `ma-move` runs against the
target tree with `MA_DESK_MOVE_TEST=1` (`cmd/ma-move/testenv.go`: refused as root and on `/data`; systemctl and
chown logged, not done, and the target's `desk-browser` unit really starts Chromium on the target profile). Then:

- deskd is killed outright a quarter into `big.bin`, and comes back: the same run reconnects and goes on from its offset.
- `ma-move` is killed outright further on, and run again at once: it finds the move, skips what its journal has but
  the databases, and finishes `big.bin` from what's staged. Its session ends only when desk-rtc's consent check gives
  up (30 s), so the rerun fits its reads beside the dead ones under deskd's 12 (`too_many` is retried).
- Between those two runs a row goes into `agent/runs.db` on a connection that stays open, so it's only in the `-wal`
  and the main file's size and mtime don't show it. The rerun's last pass has to bring it.
- Checks: every file not left out by decision 4 equal at the target, bytes or SQLite as a database (a dump of each);
  links in the part carried, the one out of it not made; caches and lock files not carried; the target's own
  `desk/volume.json` and `apps/registry.json` kept; no inotify event on any machine path but `ma-move` opening
  `selfhost/desk.json`, and their bytes, inodes and modes as before; every report counts only; the source's
  Chromium stopped for the held pass and kept stopped after, with `desk/browser-moved.json` on the source and
  `browserKept: "kept"` in `report.json` (Security's `NE-2`); and the sign-ins: `ma-move`'s own proof, then
  `Storage.getCookies` from the target's Chromium compared name for name and value for value with the source's, and
  the page reloaded there getting its cookies, localStorage and IndexedDB back.

## Test B, the download
`web/harness/serve.mjs` serves the shipping bundle (`web/dist/release`) with the shim as its desk and
`export.enabled: true`; its own `GET /v1/me/export` stands in. `export.mjs` signs in, opens `/export` in full headless
Chromium, takes the OPFS path (it removes `showSaveFilePicker`, which this Chromium has but can't show), and saves the
ZIP. desk-rtc is killed outright a quarter into `big.bin` and started again. Checks: `unzip -t`, `python3 -I -m
zipfile -t`, every `manifest.json` hash against its entry, `big.bin` against the source, `bookmarks.html` and
`history.csv` with the profile's bookmarks and visits, nothing of the machine's or the caches in it, and a read of
`big.bin` from an offset after the drop.

## Not covered
The `export` token scope over the wire (the shim mints `owner` only); the real `desk-units`, the unit sandbox and
root; a headed kiosk Chromium and Debian's build; ICE over a real network (bulk here is loopback, so the speeds are an
upper bound); a closed account's export link.
