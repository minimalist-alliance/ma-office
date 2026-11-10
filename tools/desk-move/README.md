# ma-move

Moves your cloud desk onto your own self-hosted desk: every file, checked, then put in place, with
your Browser's sign-ins carried over. Your cloud desk's files stay exactly as they were, and its Browser
stays stopped, so your sign-ins are only used on this desk, until you start it there again.

## For members

### Before you start
1. **Install your self-hosted desk first,** and add it to your office: `sudo ./selfhost/install.sh
   --bundle ./bundle`, then open the link it shows (see the self-hosted desk's own guide,
   `selfhost/README.md`). It should show in your office as online.
2. **Make a move code:** in your office, open **Download your data** from the account menu. Under
   **Move a desk to your own computer**, pick your cloud desk and this self-hosted desk, choose **Get a
   move code**, and keep the code it shows you (like `ABCD-EFGH-JKMN`). The code works once, for 15
   minutes.

### Run it
On the self-hosted desk:

```
sudo ma-move
```

It knows which desk it's on from the install, and asks for the move code. Type it in, with or
without the dashes; it's never taken on the command line, so it stays out of your shell's history.
If the install hasn't been done, it says so and changes nothing.

### What happens
1. **It copies everything** from your cloud desk to this one: your Browser, your desk settings,
   Notebook and Chat, your Agent, and your apps' data. You can keep using your cloud desk meanwhile.
   A big desk takes a while: about 8 hours for 32 GB on a typical connection.
2. **It catches up the last changes,** and reads every database again, because its latest changes can't
   be seen from outside. Your cloud desk's Browser stops while its part is copied, and **stays stopped
   after**: if it started again on the same sign-ins, a site that changes them each time you visit could
   sign you out here. To use the Browser on your cloud desk again, open that desk in your office and start
   its Browser; it says the desk was moved and asks first. Anything you change on your cloud desk after this
   stays on your cloud desk.
3. **It checks every file** against your cloud desk's copy, checks this desk's Browser is new enough
   for your profile, and checks it keeps sign-ins the way cloud desks do. If anything isn't right, it
   stops there and changes nothing on this desk.
4. **It puts your data in place.** This desk's Browser and services stop for a moment, your data goes
   in, and they start again. The desk stays in your office, online, the whole time. What this desk had before is kept, in `/data/.ma-move/<move>/before/`.
5. **It checks your sign-ins** by starting this desk's Browser, and tells you how many work here.

At the end you'll see something like:

```
Your desk is moved. 4 parts, 2,314 files, 1.2 GB, every file checked. 312 of 312 sign-in cookies work here. Your cloud desk's files are unchanged. Your cloud desk's Browser stays stopped, so your sign-ins are only used here, where a site that changes them won't sign you out. To use it there again, open that desk in your office and start its Browser; nothing else starts it. It stays in your office until you choose to remove it.
```

### If something goes wrong
- **The connection drops:** it reconnects by itself for up to 10 minutes and carries on from where it
  was, mid-file.
- **It stops for any other reason:** run `sudo ma-move` again. It
  finds the move it was doing and carries on; files already copied aren't copied again, except
  databases, which the last step always reads again. After 24 hours the move needs a new code, and
  what's copied so far is still kept.
- **It says this desk's Chromium is older:** update Chromium on this desk first. Opening your profile
  with an older Chromium would sign you out of every site, so it won't.
- **It says your cloud desk's Browser couldn't be paused:** run `sudo ma-move` again a little later. Copying the
  Browser while it runs could catch a file half written, so it stops instead, with nothing on this desk changed.
- **It says your cloud desk has a file whose name this desk can't carry:** nothing on this desk was changed. Ask
  Minimalist Alliance support; a move never leaves a file behind and says it's done.
- **It stops after copying your Browser** (a check fails, or the swap): your cloud desk's Browser stays
  stopped all the same, and it says so. Run `sudo ma-move` again to finish, or start the Browser on your
  cloud desk from your office if you'd rather stay there.
- **It says your cloud desk's Browser started again there:** your cloud desk runs an older version that can't
  keep it stopped. Use the Browser on one desk only, or a site may sign you out on the other.
- **Nothing is ever deleted.** Not on your cloud desk, and not on this one: this desk's earlier data
  stays in `before/` until you remove it yourself.

Your cloud desk's files are never changed by a move, and it keeps running until you choose to remove it;
only its Browser stays stopped, and starting it there is your choice. Your
cloud desk sends its files straight to this desk, encrypted. If the connection needs our relay, they
pass through it still encrypted, and we can't read them. Minimalist Alliance only hears how many files
and bytes moved, and whether the checks passed.

### Try it first
`--dry-run` uses the code, lists what would move and runs the checks, and changes nothing on either
desk. The code is used up by it, so make a new one for the move itself.

## For engineers

Spec: `docs/decisions/draft-data-export-and-transfer.md` decisions 4, 5, 7 and 9 (this repo), and
section 4 of the platform half in `ma-platform`.

### Flow
1. Reads this desk's ID and env from `/data/selfhost/desk.json` (task 31; with `key.pem`, the only files of
   `/data/selfhost` it ever opens), refusing if it's missing: "This computer isn't a desk in an office
   yet: run the install first". `--target-desk` may only repeat that ID. The env picks the API unless
   `--api` or `--staging` is given. Then checks this desk's `desk-browser` runs Chromium with
   `--password-store=basic` (`systemctl cat desk-browser` and the scripts its `ExecStart` runs).
2. Finds `/data/.ma-move/*/state.json` for an unfinished move to this target, or asks for the code and
   `POST /v1/moves/claim {code, targetDeskId, targetKey}`. `targetKey` is `{at, nonce, sig}` (`internal/move/sign.go`, EXP-1, contract `desks.md` 0.3.43): the desk's own Ed25519 signature over `ma-selfhost/v1`, `move`, the env, the desk's public key, `at`, `nonce` and `<sha256 hex of the 12-character code>:<targetDeskId>`, newline-joined, as `ma-selfhost` signs its other calls. So a code seen by someone else is no use from another computer. The key is read with `O_NOFOLLOW`, signed with and never sent, printed or logged.
3. `POST /v1/moves/{moveId}/connect {clientDtlsFingerprint, start}` with `Authorization: Move <token>`,
   polling while the cloud desk wakes, then the gateway, Pion and HELLO as the Desk app does. One
   DTLS certificate for the whole run, so every refreshed token keeps its `cnf`; the platform gives
   every token of one move the same `sid` (`move#<moveId>`) and `sub`, scope `export`, so deskd takes
   each refresh. Tokens are refreshed every 4 minutes (connect again with `start: false`, then
   `session.refresh` and AUTH on `ctl`).
4. `data.parts.list`, every page of `data.manifest` per part. Skips `rtc`, `selfhost`, `desk-egress`,
   `.ma-volume`, `lost+found`, `.ma-export-tmp`, `.ma-move`, `browser-readable` (made by the helper
   for exports) and this machine's files (`desk/volume.json`, `desk/browser-moved.json`, `apps/*/releases|current|previous`,
   `apps/registry.json`) even if a desk lists them.
   - **Names are bytes** (`internal/fsname`). The helper lists a byte that isn't UTF-8 as `\udcXX` (Python's
     surrogateescape), and deskd passes it on. `encoding/json` read those as U+FFFD, a different name, so the
     file's `data.read` was `not_found`, it counted as gone, and the move said done without it, a database
     included. Now the manifest's paths, link targets and cursor, `data.read`'s part and path, and the journal's
     lines carry the bytes, written back as the same escapes. A name the mover can't make exactly (a lone
     surrogate the helper never sends, JSON that isn't, a path outside its part, a part whose name isn't UTF-8)
     stops the move (`copy_failed`), with nothing here changed: it's never skipped.
5. Reads `browser/profile/Last Version` and refuses if the local Chromium is older (ADR 0035), and
   refuses unless free space ≥ what's left to stage + 2 GiB. Nothing is written before this.
6. Copies with up to 8 `data.read`s in flight into `stage/<part>/<path>` (directories `0700` while
   staging). CHUNK frames are written, then credited back in steps of at least 256 KiB of payload (what
   deskd counts); the END trailer (SHA-256 of bytes 0..size, `u64be` size) must match what was written
   and the size `data.read` announced. A mismatch reads the file again from 0, once; then the file
   fails. An END with no trailer (deskd's helper failed, or the file changed while it was read) asks again
   from what's written, up to three times; that read's trailer hashes the part before its offset from the file
   as it is now, so old bytes there fail it and it's read from 0. Each finished file is journaled.
7. Last pass: every other part again, then `data.browser.cookies` (kept as hashes in
   `cookies-source.json`), `data.browser.hold`, the Browser again, then `data.browser.keep` on the session that
   held it, then `data.browser.release`, deferred so it runs on every path. A reconnect while held holds again. Both are mutations, so each call carries a new
   UUIDv7 `idem` (`session.CallMutation`): deskd refuses them without one, which before the rehearsal meant every
   real move copied the Browser unheld.
   - **The Browser's part is done only under one hold** (`heldDelta`). A refused hold is asked for again, 4 times
     in all (`HoldTries`); then the move stops (`copy_failed`): "your cloud desk's Browser couldn't be paused to
     copy its last changes". It used to log the refusal and copy the Browser unheld, and say done.
   - The hold is renewed every 10 minutes (`HoldRenew`) on its own session, as deskd lets go after 30 (`HoldFor`).
   - deskd lets go of a hold when its session ends or when it refuses a renewal, and starts Chromium again, which
     can write the profile. So a pass counts only if the hold it started under is the one there at its end: the
     same session, never refused, and not within a tenth of 30 minutes of its last renewal by this machine's clock.
     Otherwise the profile is listed again and what changed, and every database, is copied under the new hold, 4
     passes at most before the move stops. Before, a reconnect held again and carried on with the old job list, so
     a file Chromium wrote in between stayed as the first hold found it.
   - **In every part** it fetches what changed or is new, removes what's gone, and reads **every SQLite file**
     again from 0. A write to a `-wal` moves neither the main file's size nor its mtime, and the manifest doesn't
     list the `-wal`, so nothing else shows it. Other files keep the size and mtime check.
   - A SQLite file's journal line goes before its read, and a new one comes only after the new trailer passes. So
     the staged copy, which the read overwrites in place, has nothing vouching for it until then. A read that fails
     or a crash part way leaves no line, and step 8 refuses it or the rerun fetches it. Overwriting in place needs no
     more disk than the file has grown by, so the space check in step 5 stands.
   - A read carried on from an offset can't splice two backups: the trailer is the new backup's whole hash, so a
     different start fails it and the file is read again from 0.
   - **The hold is kept after the move** (Security's `NE-2`, `API.md` section 12). Released, deskd started the cloud
     desk's Chromium again on the cookies this desk now has, and a site that rotates its sign-in tokens would then
     sign the member out here. So the pass that counts ends with `data.browser.keep` on the session that held it:
     deskd keeps the hold past the session, through restarts, in its `/data/desk/browser-moved.json`, until the
     member lets go from the Desk app (`data.browser.release {kept: true}`, owner sessions only; a move can't).
     deskd answers only if that session held it the whole time. A keep that comes back `not_held`, `unavailable`
     with no reason, or lost with its session means Chromium may have run, so the profile is listed again and
     copied under a new hold, which counts toward the 4 passes; keeping again is the same keep. A deskd from before
     keep (`not_found`) or one that can't write its file goes on, and the done line says the cloud desk's Browser
     started again. `state.json` and `report.json` record which as `browserKept`: `kept`, `unsupported` or
     `failed`. The keep is made right after the Browser's pass, before the checks, so there's no gap for Chromium
     to run in; a move that stops after it says the cloud desk's Browser stays stopped.
   - **Only the Browser is held.** The cloud desk keeps running, so what's written to a part after its last read
     stays on the cloud desk.
8. Checks: Chromium against the staged `Last Version`, `--password-store=basic` again, and every staged
   file hashed again against the journal. Any failure refuses (exit 3) with the live parts untouched.
9. Swap, as task 31 asks: `systemctl stop deskd desk-browser desk-stream` (and `desk-agent` and
   `desk-notebook` if the units exist), then per part the live directory to `before/<part>`, the staged one
   in, owners by part (`browser` 1102, `desk` 1100, `agent` 1103, `notebook` 1105, `apps/<id>/*` by this
   desk's `registry.json` uid, others keep what this desk's copy had), the fixed modes (`browser` 0750, `browser/profile` 0700,
   `browser/downloads` 0750, `browser/home` 0700, `desk` 0750), then this desk's machine files carried
   in, and `desk/browser-moved.json`, deskd's record of a move from this desk, is this desk's too: the cloud
   desk's never comes across. Then `systemctl start deskd`, which starts the Browser and the stream when they're wanted, and
   `desk-agent` and `desk-notebook` again if they were running. Each step checks where it stands, and `state.json` records the
   parts done, so a rerun finishes a swap that crashed.
10. Proof: starts `desk-browser`, checks in `/proc/net/tcp` that kiosk (1102) holds port 9222, then reads
    `Storage.getCookies` as root: on a self-hosted desk only root and deskd may reach that port
    (`selfhost/files/etc/nftables.conf`). Each cookie is hashed as deskd does (`k` = first 16 hex of
    SHA-256 of `domain\tname\tpath`, `v` the same of the value) and its `expires` kept as `e` (Unix
    seconds, `-1` for a session cookie), as deskd's items carry it. Cookies expired on either side don't
    count.
11. Reports: `report.json` here, and `POST /v1/moves/{moveId}/report` with `{state, parts, files,
    bytes, checks: {passed, failed}}`, and on `failed` an `error` from the platform's list
    (`chromium_older`, `password_store`, `disk_full`, `checksum_mismatch`, `helper_unavailable`,
    `connection_lost`, `copy_failed`, `swap_failed`, `interrupted`, `other`), at `copying`, `checking`,
    `done` or `failed`. A move the platform says has ended (401, 409 `move_ended`) isn't reported.

### Files
`/data/.ma-move/` is `0700` root. Per move: `state.json` (`0600`, holds the move token), `journal.jsonl`
(one line per finished file: part, path, the manifest's size and mtime, SHA-256, bytes read),
`stage/`, `before/`, `cookies-source.json` (hashes only), `report.json`.

### Flags and exit codes
`--target-desk` (only to double-check: the ID comes from `/data/selfhost/desk.json`),
`--api` (default: the env the desk was paired in, `https://api.minimalistalliance.com` or
`https://api.staging.minimalistalliance.com`), `--staging`, `--data-root` (default `/data`),
`--dry-run`, `--code-file` (tests), `--transport any|udp|tcp`, `-v`, `--version`.
Exit 0 done, 1 failed, 2 usage, 3 refused by a check (including "not a desk in an office yet").

### Build and test
```
flock ~/work/.build.lock nice -n 10 ./build.sh          # dist/{amd64,arm64}/ma-move, static
flock ~/work/.build.lock nice -n 10 ~/.local/go/bin/go test ./...
```
The tests run unprivileged against temp dirs: `internal/fakedesk` is an in-memory desk speaking deskd's
protocol over an in-memory transport, with hooks to damage or refuse a read, drop the session mid-file or as a
given read starts, send chunks before the reply, change files when the Browser is held, when its hold is lost or
between the passes, refuse a hold or a renewal (and let go, as deskd does), and edit a manifest page. It writes
names as deskd does, a byte that isn't UTF-8 as `\udcXX`. `hold_test.go` covers the hold (refused for good,
refused once, lost with the session, renewed, renewal refused), `keep_test.go` its keep after the move (kept, a
deskd without it, one that can't record it, lost with the session, its reply lost, a refusal after it, the cloud
desk's record never coming across) and `names_test.go` names that aren't UTF-8. systemd,
chown, free space, the Chromium version, desk-browser's command line and the local cookies are injected
through `move.Env`. There's no WebRTC test here; the Pion half is `internal/client`, kept thin.

`TestRealHelperWALWriteBetweenPasses` puts the real `tools/desk-data/desk-data` behind the fake desk
(`fakedesk.RealHelper`, one process per request through `rehearsal/helper-run.py`) with a real WAL database and its
writer still running, and opens the moved database to find the row. `TestRealHelperNamesThatArentUTF8` does the same
with a file, a directory and a WAL database each named with a byte that isn't UTF-8. They need `python3` with
`sqlite3`, and skip without them.

`rehearsal/` runs the real binary against a real deskd, `desk-data`, desk-rtc and Chromium on this machine
(`rehearsal/README.md`). It uses one test switch: `MA_DESK_MOVE_TEST=1` (`cmd/ma-move/testenv.go`), refused as
root and on `/data`, which stands in for systemctl (unit files and start and stop scripts in
`MA_DESK_MOVE_TEST_DIR`), logs each chown instead of making it, and takes the Chromium version and this desk's
debugging port from `MA_DESK_MOVE_TEST_CHROMIUM` and `MA_DESK_MOVE_TEST_CDP_PORT`.

### Code
| Package | What |
|---|---|
| `cmd/ma-move` | Flags, this desk's ID, the code prompt |
| `internal/move` | The flow, journal, staging, checks, swap, proof, reports, and the real `Env` |
| `internal/session` | deskd's protocol over any transport: HELLO, RPC, AUTH, keepalive, bulk CHUNK and CREDIT |
| `internal/fsname` | File names as bytes through JSON, as desk-data writes them (`\udcXX` for a byte that isn't UTF-8) |
| `internal/client` | Pion and the gateway: connect, `session.open`, offer and answer, the data channels |
| `internal/frame`, `internal/gw`, `internal/rtcsock` | Frames, gateway framing, the channel table |
| `internal/cdp` | This desk's cookies over CDP, as hashes, and who holds port 9222 |
| `internal/fakedesk` | The tests' desk |

`frame`, `gw`, `rtcsock` and `client` are copies from `desk-rtc/internal/` at desk-rtc commit
`42e6a09` (each file says which), trimmed, because Go's `internal` rule stops an import across modules.
`frame` gains CREDIT and the END trailer; `session` holds the request handling that came out of
`client`.

### Open points
- **Credit** is granted in payload bytes, as deskd's `Transfer` counts it (END needs none). The draft ADR
  should say so.
- **`checks`** goes to the platform as `{passed, failed}` over five checks: Chromium, password store,
  space, every file, and every sign-in cookie working here.
