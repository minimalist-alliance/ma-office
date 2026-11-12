# Draft. The desk app contract: what any app must meet to run on a desk

**Status:** Draft, for review by the System Engineer and the Desk Engineer, then the owner's decisions (section 11). Not numbered yet: the System Engineer gives it a number and an index row. Decisions 1 to 15 took their defaults (Nov 7). Reviewed by the Desk Engineer on 2026-11-11, with deskd's half built: see "Desk Engineer review" at the end, which wins where it differs.
**Date:** 2026-11-06
**Author:** subcontractor, task 18 (`sub/desk-app-contract`)
**Sample:** [`spikes/app-contract-sample/`](../../spikes/app-contract-sample/README.md), an app in Go that meets this contract, with the tools that check it

## Context

The owner, 2026-11-05: "Apps on the desk should be as efficient as possible and can be language agnostic as long as they launch and fit the parameters set forth by the desk. Eventually I want the alliance community building apps for this platform and contributing to ma-desks, adding more and more integrations". And: "I want core services that make a desk run need to be in java 21 so anyone can understand how the desk works and contribute to it".

So the desk needs written parameters. Today there are none: a desk has four built-in apps (Notebook, Browser, Chat, Agent) served by `deskd`, its core services in Java 21 (`deskd`, `desk-agent`, ADR 0040) and Go (`desk-rtc`), Docker inside, and little memory to spare. On a 4 GiB desk Chromium holds 870 to 900 MB with pages open, `deskd` about 110 MB and `desk-stream` 32 to 57 MB, and the 1080p stream takes 69 to 76% of a c7g.large's CPU (`CLAUDE.md`, `docs/benchmarks/2026-11-real-stack.md`). Task 10 ran the Claude desktop app on a desk-like t4g.medium: about 590 MB PSS at idle, and it needs its own user, its own X display and caps (`spikes/native-apps/README.md` on `sub/native-apps-spike`).

What binds the contract:
- **Never sluggish** (ADR 0028, design §2.2): 60 fps and low input latency. Here that means the desk's own work comes first, and an app loses resources before the desk does.
- **Privacy is what MA sells** (ADR 0011, design §2 trust boundary): desk content stays on the desk and between the member's browser and the desk, end to end.
- **The browser session is never cleared, and no app may read it** (ADR 0035).
- **Core services stay Java 21** (ADR 0040 and its addendum). Apps may be in any language.
- **No new paid service** without the owner, and no GitHub Actions.

This ADR is design only. It changes no part of the desk. Section 9 lists what each owner would build if it's accepted.

## Decision, in short

1. **An app is a signed package with a manifest** that says up front what it is and what it needs: name, version, memory, CPU, disk, network hosts and permissions (section 1).
2. **It runs as its own user, in `apps.slice`, where it always loses to the desk:** a CPU weight a tenth of the core's, its own memory, CPU, task and disk caps, one memory budget for all apps, first in line for the OOM killer, and a guard that throttles apps when the desk is under pressure (section 2).
3. **The member sees it in three ways,** all drawn or framed by the Desk app: a widget the Desk app draws from the app's data, a window whose content runs in a sandboxed frame with no network, and, for reviewed native apps only, a display streamed like the Browser (section 3).
4. **It touches only its own data.** The member's files only when picked, the Browser only to open a link, the network only to declared hosts. No permission exists that reads the Browser's session (section 4).
5. **It talks only to `deskd`,** over a Unix socket with the same frames the Desk app uses, in a versioned interface, `appApi`, that changes only by adding, with a frozen schema and a conformance suite for every version (section 5).
6. **Nothing is installed without the member's tap.** Every package carries the developer's signature and MA's review signature. Developer mode lets an author run their own unsigned work on their own desk (section 6).
7. **The open source repository** gets the spec, schemas, conformance suite, sample and tools under a permissive license, and a catalog repository for submissions (section 7).
8. **Updates to members' desks are rare and never interrupt:** at most one core batch a month, pulled and checked by the desk and applied only while it's idle, reaching test desks, then the owner's desk, then members. Apps update on their own (section 13).

## 1. Package, manifest and lifecycle

### 1.1 The package
A `.maapp` file is a gzipped tar with exactly three things at its root:

| Entry | Holds |
|---|---|
| `ma-app.json` | The manifest (1.2), including the SHA-256, size and mode of every file |
| `ma-app.sig` | Signatures over the manifest's exact bytes: the developer's, then MA's review (6.2) |
| `files/` | The app: its executable, its view and anything else it needs. Regular files and directories only |

deskd refuses a package with anything else: a symlink, hard link or device, an absolute path or `..`, a duplicate, a file not in the manifest, or a manifest file missing or with another hash. One signature over the manifest therefore covers every byte. Compression is gzip so any language's standard library can build one.

**The app brings its own runtime.** The executable is a static linux/arm64 binary, or a launcher plus the runtime it needs inside `files/` (a jlink'd JRE, a Python build, Node). The desk provides only the kernel, glibc and the libraries the image already has. That keeps the image small and an app's update independent of it. Native GUI apps (section 3.3) are the exception: they may rely on a reviewed set of display libraries in the image.

### 1.2 The manifest

| Field | Meaning | Rule |
|---|---|---|
| `manifest` | Format version | `1` |
| `id` | Reverse-DNS id, such as `org.example.tally` | Lower case, at most 64 characters, so `/run/ma-apps/<id>/app.sock` fits in the 108-byte socket path. Reserved by the catalog on first submission |
| `name`, `description` | What the member reads | 1 to 32 and at most 140 characters |
| `version` | `MAJOR.MINOR.PATCH` | |
| `publisher` | Who made it | Must match a registered developer key (6.2) |
| `source`, `license` | Where the reviewed source is, and its license | Required for community apps |
| `appApi` | The versions of section 5 it speaks, as a range | `">=1.0 <2"` |
| `arch` | `arm64` (desks) or `amd64` (tests) | One per package |
| `run.exec` | The executable and its arguments, inside `files/` | Mode `0755` |
| `run.start` | `on-demand` or `background` | `background` needs the permission |
| `run.startTimeoutSec`, `run.stopTimeoutSec` | How long to HELLO after start, and to exit after SIGTERM | 1 to 10 each |
| `resources` | `memoryMaxMiB`, `cpuMax` (vCPUs), `tasksMax`, `diskMaxMiB` | Within the tier's ceiling (2.2). Zero takes the default |
| `permissions` | From the closed list in section 4 | Shown to the member in plain words |
| `net` | `[{host, port, why}]` | Only with `net`. Port 443 only, a host name (no IPs or wildcards), and a reason the member reads |
| `views.window` | Its HTML, script and style files, and default and minimum sizes | Minimum at least 280 x 200 |
| `views.widget` | Whether it publishes `app.summary` (3.1) | |
| `methods` | `[{name, mutation}]` a view may call | Dotted names outside the reserved namespaces `app.`, `desk.`, `apps.`, `browser.`, `files.`, `notebook.`, `chat.`, `agent.` |
| `topics` | Topics a view may subscribe to | Same namespaces reserved |
| `files` | `{path: {sha256, size, mode}}` | Every file, and nothing else |

The sample's manifest is [`app/ma-app.json`](../../spikes/app-contract-sample/app/ma-app.json), and `internal/manifest` checks every rule above.

### 1.3 Lifecycle

| Step | Who does it | What happens |
|---|---|---|
| **Install** | The member taps Install on the install sheet (6.1). `deskd` downloads, checks, then asks `desk-apps`, a root helper, to place it | deskd checks the layout, the hashes, the signatures, the manifest against the tier's ceilings, `appApi` and arch, and that disk is left for the Browser (2.4). The helper gives the app a uid, its directories, its disk quota and its firewall rule, and unpacks it read-only. Nothing of the app runs yet |
| **Start** | deskd, when the member opens the app's window. A `background` app starts with the desk | The helper starts a transient systemd unit from the manifest (2.1). deskd waits for the socket and HELLO within `startTimeoutSec`, or stops it and says it couldn't start |
| **Stop** | deskd, 10 minutes after the app's last window closes, or when the memory budget needs room (least recently used first); the desk stopping | SIGTERM, then SIGKILL after `stopTimeoutSec`. Apps stop before the core at shutdown |
| **Update** | deskd, from the catalog, once a day | Same or fewer permissions and resources: installed beside the old version and used at the next start. More of either: the member is asked, and the old version runs until they answer. `previous` is kept; three failed starts of a new version switch back to it |
| **Remove** | The member | Stop, delete the release, the uid's rules and its quota. The data stays unless the member ticks "Also delete its data" (section 11, decision 10) |
| **Revoke** | MA, through the catalog's revocation list | deskd stops and disables the app and tells the member why. Its data stays theirs |

**Apps never keep a desk awake.** App work isn't member activity (ADR 0026): a background app runs while the desk runs, and stops with it.

**One instance per desk,** as for the built-in apps (design §3.3). Apps can't move between desks: their data lives on that desk's volume.

### 1.4 Where things live

| Path | Holds | Owner, mode |
|---|---|---|
| `/data/apps/<id>/releases/<version>/` | The unpacked package. On `/data`, so a root swap keeps it and nothing has to be replayed | root, read-only |
| `/data/apps/<id>/current`, `previous` | Symlinks, as `ma-update` does for core components | root |
| `/data/apps/<id>/data` | The app's own data, under its disk quota | the app's uid, `0700` |
| `/data/apps/<id>/cache` | Rebuildable data under the same quota. deskd may empty it when the disk is short; data is never touched | the app's uid, `0700` |
| `/data/apps/registry.json` | Installed apps: uid, version, grants, install time, the package's hash | root |
| `/run/ma-apps/<id>/app.sock` | The app's socket (5.1) | Directory `2750`, owner the app, group `desk`, so the socket inherits group `desk` |

**Uids** come from a range kept for apps, 2000 to 2999, one per installed app, recorded in the registry and never reused while that app's data exists. Task 10 proposed 1105 for the Claude app; under this contract it gets one from the range.

### 1.5 What an app must do
The whole list for an author. The sample does each one in about 330 lines of Go, plus 185 for the frames it shares with the checker.
1. Listen on `$MA_APP_SOCKET`, accept only a peer whose `SO_PEERCRED` uid is `$MA_DESKD_UID`, and answer HELLO within `startTimeoutSec`.
2. Serve the methods and topics its manifest declares, and `app.summary` if it has a widget.
3. Keep its state in `$MA_APP_DATA`, written so a kill at any moment leaves the old or the new version.
4. Treat `$MA_APP_CACHE` as something that can vanish.
5. Size its runtime to `$MA_APP_MEMORY_MAX` and `$MA_APP_CPU_MAX` (Go's memory limit, a JVM's `-XX:MaxRAM`, Node's `--max-old-space-size`).
6. Exit cleanly on SIGTERM within `stopTimeoutSec`.
7. Ignore fields and frame kinds it doesn't know.

It is told nothing else: its environment is `MA_APP_ID`, `MA_APP_VERSION`, `MA_APP_API`, `MA_APP_SOCKET`, `MA_APP_DATA`, `MA_APP_CACHE`, `MA_APP_MEMORY_MAX`, `MA_APP_CPU_MAX`, `MA_DESKD_UID` and `HOME`, plus `HTTPS_PROXY` with `net` and `DISPLAY` with `display`. No member name, email, desk ID or account.

## 2. Resources: the desk comes first

### 2.1 The slice
Every app runs in `apps.slice`, a sibling of `system.slice`, where the core runs.

| Setting | `apps.slice` | Why |
|---|---|---|
| `CPUWeight` | 10 (core units keep the default 100) | Under contention all apps together get at most about a tenth of a CPU the core wants. Idle CPU is still theirs |
| `IOWeight` | 10 | The same for disk |
| `MemoryHigh`, `MemoryMax` | 1.25 GiB and 1.5 GiB on a 4 GiB desk (decision 3) | One budget for all apps, throttled before it's killed |
| `MemorySwapMax` | 0 | No swap, so an app never makes the desk page |

Each app's unit adds its own limits from its manifest:

| Unit setting | From | |
|---|---|---|
| `MemoryMax`, `MemoryHigh` | `memoryMaxMiB`, and 80% of it | Reclaimed and slowed above `MemoryHigh`, killed at `MemoryMax`, inside its own cgroup only. The kernel slows an app above `MemoryHigh` so hard that a leak stalls there instead of reaching `MemoryMax` (2.7), so deskd also kills an app that spends most of a second stalled on memory (its `memory.pressure`), as systemd-oomd's `ManagedOOMMemoryPressure=kill` would |
| `CPUQuota`, `CPUQuotaPeriodSec` | `cpuMax`, and 10 ms | Even an idle desk gives one app no more than this. The period is 10 ms, not systemd's default 100 ms: within each period a capped app competes at full strength, and a 100 ms period lets it hold the CPU long enough to make the desk miss frames (2.7). The weight, not the cap, is what protects frame time |
| `TasksMax` | `tasksMax` | A fork bomb stops at the limit |
| `OOMScoreAdjust` | 800 | If the desk itself runs short, the kernel kills apps first |
| `LimitCORE` | 0 | No core files, which could hold whatever the app read |

**The core gets protection too,** which is image work (section 9): `MemoryLow` on Chromium (1 GiB), `deskd` (128 MiB), `desk-rtc` and `desk-stream` (64 MiB each), so their memory is reclaimed last.

The unit's sandbox, generated by the helper from the manifest (`ma-app units` prints it for the sample): `User=` the app's uid, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `PrivateIPC`, `TemporaryFileSystem=/data:ro` with only the app's own directories bound back, `InaccessiblePaths=` for `/run/desk`, `/run/desk-media`, `/run/desk-agent` and Docker's socket, `NoNewPrivileges`, an empty `CapabilityBoundingSet`, `RestrictSUIDSGID`, the kernel, clock and cgroup protections, `ProtectProc=invisible`, `SystemCallFilter=@system-service`, `RestrictNamespaces=yes` (not for `display` apps, whose Chromium sandbox needs user namespaces), and `RestrictAddressFamilies=AF_UNIX` with `IPAddressDeny=any` unless the app has `net`.

### 2.2 Limits per app

| | Default | Community ceiling | Reviewed first-party ceiling |
|---|---|---|---|
| Memory (`memoryMaxMiB`) | 64 | 256 | 1,400 (a `display` app such as Claude's, task 10) |
| CPU (`cpuMax`, vCPUs) | 0.25 | 0.5 | 1.0 |
| Tasks | 32 | 128 | 512 |
| Disk (`diskMaxMiB`, package included) | 64 | 1,024 | 4,096 |
| Network | None | Declared hosts on 443 | Declared hosts on 443 |
| `display` | No | No | Yes |

The ceilings are for a 4 GiB desk. Bigger custom desks can raise the apps' budget, never the per-app ceilings.

### 2.3 The pressure guard
Weights decide who wins a contested CPU, but a desk has two of them and many core threads. So deskd also watches the core:
- It reads the CPU pressure (PSI, `cpu.pressure`) of the core units and `desk-stream`'s late frames every 100 ms.
- After 300 ms over 10% pressure, it caps `apps.slice` at 10% of one CPU, with a 10 ms period, and freezes background apps that have no window open (`cgroup.freeze`).
- It lifts the cap after 10 s under 2%.
- If an app the member is looking at stays capped for more than a minute, its window says "Paused to keep your desk smooth", which is the only time the member hears about any of this.

The sample shows the guard acting 0.3 s after an app started to starve the desk's frames (2.7). A guard that also kills an app stalled on memory is in 2.1.

### 2.4 Disk
- **A hard quota per app:** an ext4 project quota on `/data/apps/<id>`, with the project id equal to the app's uid. A full app gets `EDQUOT`, and its tile says "‹App› is full". This needs `/data` formatted or tuned with the `project` and `quota` features (section 9).
- **A floor for the Browser:** an install or update that would leave less than 2 GiB free on `/data` is refused, and deskd empties app caches first when free space falls under that. ADR 0035 found that under 800 MB free Chromium evicts site storage, and the member's browser session comes before any app.
- An app can't write anywhere else: its root is read-only and its `/tmp` is private.

### 2.5 Network
- **None by default.** An app without `net` has only Unix sockets.
- **With `net`,** it reaches only `127.0.0.1` on its own port of deskd's egress proxy (design §9.8, the same proxy `desk-agent` uses), set as `HTTPS_PROXY`. nftables matches the app's uid, as it does for `agent`. The proxy allows `CONNECT` only to the manifest's hosts on 443, so TLS stays end to end and the proxy sees host names, never content.
- **Its traffic is last in line:** a class of its own below Chromium's in ADR 0036's HTB tree (1:30, prio 2, 20 Mbit/s ceiling), so an app's download never delays the stream or the Browser.
- **Never inbound.** No app listens on anything but its Unix socket.
- **The member can see where it went:** the proxy keeps per-app host names and byte counts per day, on the desk only, in the app's About sheet. Nothing of it goes to the platform.
- **No telemetry:** an app may not send analytics or crash reports anywhere, which review checks (6.3). The desk itself sends none (design §2.2).
- IMDS, the desk role, the platform's API, Chromium's debugging port and other desks are never reachable, as for `kiosk` and `agent` today.

### 2.6 When an app goes over

| Over | What enforces it | The app | The member |
|---|---|---|---|
| `MemoryHigh` | The kernel reclaims and slows it. If it stalls on memory for most of a second, deskd kills it | Slower, then killed | As for `MemoryMax` |
| `MemoryMax` | OOM kill inside its own cgroup | Killed | deskd restarts it after 1 s, 5 s and 30 s. After 3 kills in 10 minutes it stays stopped, and the tile says "Stopped: used too much memory", with Restart |
| `apps.slice`'s budget | The kernel, then deskd stops the least recently used app | Stopped | Nothing, unless its window was open: "Closed to make room" |
| `cpuMax` | `CPUQuota` | Slower | Nothing |
| The desk under pressure | Weight 10, then the guard (2.3) | Slower, or frozen if in the background | Only after a minute with its window open |
| `tasksMax` | `TasksMax` | `fork` and thread creation fail with `EAGAIN` | Nothing (the app's own error) |
| Disk quota | ext4 project quota | `EDQUOT` | "‹App› is full" |
| Undeclared network | nftables and the proxy | Connection refused | Nothing |
| Request rate to deskd | deskd, 50 a second | `ERR rate_limited` | Nothing |
| A view's long frames | The Desk app (3.2) | Its frame is unloaded | "Paused to keep your desk smooth", with Resume |
| `startTimeoutSec` | deskd | Stopped | "Couldn't start" |
| `stopTimeoutSec` | systemd | SIGKILL | Nothing |

### 2.7 Measured with the sample
On this shared build machine (x86_64, 6 vCPUs, systemd 255 user manager with the cpu, memory and pids controllers), not on a desk. The desk's own work is a probe that spends 11 ms of CPU in every 16.7 ms frame, two thirds of a CPU, near the 69 to 76% a c7g.large spends streaming. Both it and a CPU-bound app are pinned to the same CPU. Full numbers: [`results/local/limits.json`](../../spikes/app-contract-sample/results/local/limits.json).

| Scenario, 8 s each | Desk fps | Frames missed | Desk frame p95 | App's CPU |
|---|---|---|---|---|
| The desk alone | 60.0 | 0 of 480 | 12.5 ms | |
| A CPU-bound app, same weight as the desk, no limits | **0.0** | 480 | 38.5 ms | 50.4% |
| The same app at `CPUWeight=10` (`apps.slice`) | **60.0** | 0 | 14.5 ms | 34.2% |
| Same weight, `CPUQuota` 0.25 vCPU, default 100 ms period | 29.5 | 244 | 25.8 ms | 25.0% |
| Same weight, `CPUQuota` 0.25 vCPU, 10 ms period | 52.2 | 62 | 17.2 ms | 25.0% |
| **The contract:** weight 10, and 0.25 vCPU with a 10 ms period | **60.0** | 0 | 14.8 ms | 24.9% |
| Same weight, no cap, the pressure guard | 57.6 | 19, 17 of them in the first second | 14.3 ms | 11.9% |

What it says:
- **Without the contract the desk loses every frame.** With equal weight the app takes half the CPU, and the desk needs about two thirds.
- **The weight is what protects the frames.** At weight 10 the app still got 34%, about what the desk left over, so spare CPU isn't wasted.
- **A cap alone doesn't.** Within each period the capped app competes at full weight. With the default 100 ms period the desk missed half its frames; with 10 ms, one in eight. Hence `CPUQuotaPeriodSec=10ms` (2.1).
- **The guard** saw the desk's pressure and capped the app 0.3 s in, then held the desk at 60 fps but for 2 frames.
- **Memory:** an app growing 8 MiB every 50 ms under `MemoryHigh` 48 MiB and `MemoryMax` 64 MiB never reached the max. The kernel throttled it at about 49.5 MiB (4,000 to 5,200 `high` events), where it would have hung. The guard killed it on memory pressure after 5 to 7 s, three times, then left it stopped. The desk ran its 720 frames meanwhile and missed none.
- **Tasks:** under `TasksMax=16` the app started 4 processes (each with its own threads) before `fork` failed with `EAGAIN`.
- **Isolation,** in Docker on the build server (`results/49/demo-49.txt`), with the flags `ma-app units` derives from the manifest: no network (`network is unreachable`), a read-only root and package (`read-only file system`), a 16 MiB disk cap (`no space left on device` at 16,380 KiB), another app's uid refused at the socket (`permission denied`), an OOM kill inside the app's own container, and Tally still passing all 14 protocol checks afterwards.

## 3. How an app reaches the member

All three are inside the Desk app, on the desk's one WebRTC connection (ADR 0022). No new port, origin or connection, and nothing passes through the platform.

### 3.1 The widget
- An app with `views.widget` publishes the reserved topic `app.summary`: `{badge?, problem?, rows: [{text, detail?, time?}]}`, at most 6 rows of 120 characters, a `problem` of at most 40, 8 KiB in all, and at most once a second. deskd coalesces it into the canvas's `summary` topic (design §3.9), which is already limited to 2 Hz per desk.
- **The Desk app draws it** with its own components and tokens, in Konva. App code never runs on the canvas, which keeps the canvas at 60 fps (budget B1) and every widget in the house style.
- deskd keeps the last summary, so the widget shows while the app isn't running. An on-demand app doesn't run just because its widget is on screen.
- Badges follow the house rule: off by default, on only for something that needs the member (ADR 0062).

### 3.2 The window
- **The frame is the Desk app's:** title bar, glyph, name, desk name, close, move and resize (design §3.6). The content is the app's view, in an `<iframe sandbox="allow-scripts">` built from `srcdoc`.
- **The view's files come from the desk.** The Desk app gets them with `apps.view.get` (5.6), checks each SHA-256 against the signed manifest, and checks the review signature with MA's public keys, which it ships with. The view's total size is at most 512 KiB, and the Desk app prefetches it when idle, so opening meets budget B4 (first frame 16 ms, content 250 ms).
- **No `allow-same-origin`,** so the view has an opaque origin. It can't read the Desk app's DOM, storage or cookies, or the member's platform session.
- **Its own policy, on top of the Desk app's:** `default-src 'none'`, scripts and styles only by the hashes of its own files, `img-src data:`, `font-src data:`, `form-action 'none'`, `base-uri 'none'`. It reaches nothing on the network, not even the platform's API that the Desk app's own policy allows. No popups, forms, top navigation, camera, microphone, clipboard or other device features.
- **One way out:** a `MessagePort` the Desk app hands it. Through it the view calls the app's declared methods and subscribes to its declared topics. The Desk app forwards those on `rpc` as `apps.call` and `apps.sub` (5.6), deskd forwards them to the app, and the replies come back the same way.
- **Theme:** the Desk app passes the theme's tokens (ADR 0065), and again on a theme switch, so views match Light, Dusk and Dark. Nunito can be passed as a `data:` font.
- **Frame budget:** a view must not hold the Desk app's main thread. Chrome may run a sandboxed frame in its own process, but no browser promises it, so the Desk app watches its own frames (Long Animation Frames, and rAF gaps where that API is missing). Three frames over 50 ms in 10 s while a view is showing and the Desk app's own work is idle, and the view is unloaded with "Paused to keep your desk smooth" and Resume.
- **Phones and tablets** use the same view, full screen, as the built-in apps do (design §3.6).

The sample's view, in its window, after three taps on +, in Light and Dusk:

![Tally in Light](../../spikes/app-contract-sample/results/local/tally-light.png)
![Tally in Dusk](../../spikes/app-contract-sample/results/local/tally-dusk.png)

A hostile view tried 12 ways out of its frame in Chrome 157 and none reached the network (`results/local/view-probe.json`): fetch, WebSocket, an image, a beacon, a form, top navigation and a popup were blocked; the parent's DOM, cookies, local storage and IndexedDB threw `SecurityError`; `eval` threw `EvalError`; its origin was `null`. The server counted 0 requests from it.

### 3.3 A display (reviewed native apps only)
For a native GUI app, such as the Claude desktop app, this is task 10's option B:
- Its own Xorg dummy display (`:98`, then down), owned by its uid. Never `:99`, the Browser's: X11 lets any client read and type into any other window on a display.
- `desk-stream` captures whichever display the member is looking at, and `desk-rtc` injects input into it. The Desk app shows it in a window like the Browser's, without the address bar.
- One stream is live at a time, so a desk never encodes two.
- It needs the `display` permission, which only reviewed first-party apps get in 1.0, because it costs encoder CPU and bandwidth and widens what the app can do.

### 3.4 Never
- App code on the canvas.
- A view outside its frame, or with network access.
- A pop-up, notification or sound outside the app's own window. Notifications are the widget's badge, and only for something that needs the member.

## 4. What an app may touch

| Thing | In 1.0 | Enforced by |
|---|---|---|
| Its own data and cache | Read and write, within its quota | Its uid, `0700` directories, project quota |
| Its own package | Read only | Root-owned, read-only bind |
| Other apps' data and sockets | Never | Uids, `0700` and `2750` directories, and a mount namespace that shows only its own |
| `deskd`'s data (`/data/desk`): Notebook, Chat, Agent, settings | Never directly. Only through `appApi` methods, and 1.0 has none for them | `TemporaryFileSystem=/data`, uids |
| **The Browser's session:** `/data/browser`, cookies, history, passwords, tabs, site storage, Chromium's debugging port | **Never. No permission exists for it, and none will be added.** No app can clear it either | `/data/browser` is `0750 kiosk`; the mount namespace hides it; nftables limits port 9222 to `kiosk`; deskd's interface has no method that reads it |
| The Browser, to open a link | `browser.open {url}`: a new `https` tab in front of the member. The reply is `{}`, so the app learns nothing about the Browser. A URL can carry data out, so it's honored only right after a click in the app's view, and review treats the hosts it opens like `net` hosts | deskd, with the permission and the Desk app's click |
| The member's files (the desk's storage drive, task 19, once it exists) | Only a file the member picks, each time: `files.pick` returns a handle, then `files.read` and `files.write` on that handle | deskd's picker. No ambient access to the drive |
| The network | Declared hosts on 443, through the proxy | nftables by uid, the proxy, `IPAddressDeny` |
| Other apps | Not in 1.0. Later, through deskd, for interfaces an app declares and the member allows | deskd |
| The desk's agents | Not in 1.0. Later, as tools behind ADR 0019's policy point, with approvals | deskd |
| The member's identity, the desk's ID, the platform account | Never. An app that needs a stable id gets one made per desk and app | deskd |
| IMDS, the desk role, the platform's API, other desks | Never | nftables, as for `kiosk` and `agent` |
| `rtc.sock`, `units.sock`, Docker's socket, X display `:99` | Never | Paths, groups, `InaccessiblePaths` |

**The closed list of permissions in 1.0,** each in the words the member reads:

| Permission | Install sheet |
|---|---|
| `background` | Keeps running with no window open |
| `net` | Connects to the hosts listed, through the desk's proxy (each host shown with its reason) |
| `files.pick` | Opens or saves a file you choose, each time |
| `browser.open` | Opens a link in a new tab of your desk's Browser. It can't see the Browser |
| `display` | Shows its own screen, streamed like the Browser (reviewed first-party apps only) |

Adding a permission is a minor `appApi` version and goes to the owner, because each one changes what the product promises.

## 5. Talking to deskd: `appApi`

### 5.1 Transport
- **A Unix stream socket the app listens on,** `/run/ma-apps/<id>/app.sock`, and `deskd` connects to. That's the direction `desk-agent`'s proposal takes for `agent.sock`, and for the same reason: no app user is ever in group `desk`, which opens `rtc.sock`. The directory is `2750`, owned by the app with group `desk`, so the socket inherits group `desk` and the app makes it `0660`.
- **Both ends check `SO_PEERCRED`:** the app accepts only uid 1100, and deskd only the app's own uid.
- **One connection at a time.** A new one replaces the old, as on `rtc.sock`.
- deskd's container needs `/run/ma-apps` mounted (section 9).

### 5.2 Frames
Every message is a `u32be` length, then one frame exactly as design §4.2.4 defines it: the 12-byte header (`ver` 1, `kind`, `flags`, reserved, `id`, `seq`) and the payload. Kinds keep their numbers. The differences from the data channels: no 16 KiB fragmenting (`MORE` is never set; a message goes whole up to the limit) and no credit. Limits: REQ and RES 1 MiB, EVT 64 KiB. JSON is camelCase with RFC 3339 times, as in deskd's API. An app speaks the same frames as the Desk app, and deskd reuses its `protocol` package.

| Kind | deskd to app | App to deskd |
|---|---|---|
| HELLO | First, with `{appApi, deskApi, app, grants, limits}` | The answer: `{appApi, app}` |
| PING, PONG | PING every 30 s. Three missed PONGs and deskd restarts the app | PONG |
| REQ, RES, ERR, CANCEL | Calls from views and widgets, and lifecycle calls | Calls to `desk.*`, `browser.open`, `files.*` |
| SUB, UNSUB, EVT | Subscriptions to the app's topics and `app.summary` | Events |
| CLOSE | Before a planned disconnect | `4426` on a major mismatch |
| AUTH, ACTIVITY, DATA, CHUNK, CREDIT | Reserved in 1.0. Ignored if received | |

### 5.3 Calls
- **deskd to app:** `REQ {m, p, idem?, deadlineMs?, from: {kind, session}}`. `from.kind` is `view`, `widget` or `desk`, and `from.session` an opaque id per desk session, never who the member is. deskd refuses before the app sees it: an undeclared method or topic, a mutation without `idem`, more than 32 calls in flight. It also keeps results for 10 minutes by `idem`, as it does for its own methods (deskd API §4), so a retry after a reconnect never applies twice.
- **Subscriptions:** deskd subscribes once per topic and fans events out to every session viewing the app. `snapshot` first, then `patch`. An app with no history may always answer `since` with a snapshot.
- **App to deskd, in 1.0:** `desk.info.get` (theme, locale, time zone, `appApi`), `browser.open {url}` with that permission, and `files.pick`, `files.read` and `files.write` with `files.pick`. 50 requests a second.
- **Errors:** deskApi's codes (`bad_request`, `not_found`, `forbidden`, `rate_limited`, `unavailable` …). `forbidden` means the permission isn't granted.
- **A 1.x addition, `app.members.retain` (2026-11-11):** on a Guild Desk, deskd sends `REQ {m: "app.members.retain", p: {members: [pseudonym, …]}, idem, from: {kind: "desk"}}`. It comes after each HELLO and whenever the roster changes, and only on a roster that passes the agent purge's guard (ADR 0080's addendum of 2026-11-10). `members` is every current member's pseudonym for this app. The app deletes all data of any member not listed and answers `{removed}`. `not_found` from an app that predates the call is tolerated. deskd's API §19, "Members leaving", has the rules. It's reserved (`app.`), and a Guild Desk app that keeps a member's own data must take it.

### 5.4 HELLO and versions
- `appApi` is `MAJOR.MINOR`, separate from `deskApi`, because apps and the Desk app change at different times.
- deskd sends the highest `appApi` it speaks within the app's major. The app answers with its own. Either side ignores fields it doesn't know.
- **A different major closes with 4426** and the `appApi` the app speaks. deskd marks it "Needs an update" and doesn't retry.
- The manifest's range is checked at install, so an app that can't talk to this desk is never installed.

### 5.5 How it never changes silently
1. **Minor versions only add:** a field, a method, a topic, a kind, a permission. Nothing is renamed, removed or made to mean something else. An app built for 1.0 runs unchanged on 1.9.
2. **Each version's spec and JSON Schemas are files:** `docs/app-api/1.x/`, with a `FROZEN` file of SHA-256s per released minor. A test in deskd's build fails if a released minor's schema changes, so a change can only land as a new minor.
3. **The conformance suite of every released minor runs against each new deskd** before it ships, on MA's own machine, not GitHub Actions. The sample's `ma-app check` is its start: 20 checks today.
4. **Every change has a `docs/app-api/CHANGELOG.md` entry** and goes through the same review as an ADR.
5. **A new major needs an ADR and the owner's OK.** deskd keeps serving the previous major for at least 12 months after the new one ships (decision 12). Deprecations are announced in a minor, and publishers of affected apps are told.
6. **deskd reports what it speaks:** `appApi` and its supported majors in `desk.status.get` and in each HELLO.

### 5.6 What the Desk app gets (additions to `deskApi` 1.x)
Additive, so a minor version of deskd's client API: `apps.list` (installed apps, state, grants, last summary), `apps.install {id, version, sha256, grants}` (step-up, design §4.2.2), `apps.remove {id, deleteData}`, `apps.start`, `apps.stop`, `apps.view.get {id}` (the view's files, checked by the client against the manifest), `apps.call {id, m, p, idem}`, `apps.sub {id, topic}`, and the topic `apps` for installs, updates and state. The catalog itself is static, signed and fetched by the Desk app (6.5).

## 6. Opt-in, signing and review

### 6.1 The member opts in, every time
- **Nothing is installed without the member's tap,** on the desk they're looking at. The platform never installs, updates to more permissions or turns on an app for anyone.
- The **install sheet** comes from the "+" tile's app picker (design §3.7). It says, in plain words: who made it, "Reviewed by Minimalist Alliance" or "In developer mode", how much memory and storage it may use, each permission, and each network host with its reason. An app with no permissions says: "It asks for nothing else: no internet, no files, no Browser." (`ma-app verify` prints the sample's sheet.)
- Installing needs a recent sign-in, like revealing an LLM key (step-up, design §4.2.2), because it puts new code on the desk.
- An update that asks for more permissions or resources asks again. The old version runs until the member answers.
- Support sessions can't install, update or remove apps (design §4.2.12).

### 6.2 Signing
- **Two signatures over the manifest's exact bytes.** The developer's says who made it. MA's review says MA checked this exact version. Because the manifest holds every file's hash, the two cover the whole package.
- **Developer keys** are registered to a publisher in the catalog (6.5). A signature from a key registered to someone else fails.
- **Review keys** are MA's, and each vouches for a tier: `community` or `first-party`. The tier sets the ceilings (2.2). deskd and the Desk app carry the review public keys; there are always two valid, so one can be rotated.
- **Revocation:** the catalog's signed index lists revoked keys and package hashes. deskd checks it daily and at install. A revoked app is stopped and disabled, and the member is told why.
- **Algorithm:** Ed25519 in the sample. The review key lives in the cloud provider's key service and never leaves it. If that service doesn't offer Ed25519, review signatures are ECDSA P-256, and deskd accepts both. One more key costs about $1 a month (decision 7).
- The root helper trusts deskd's verification and doesn't parse app files beyond the manifest: deskd already holds all of the member's data, so it's already trusted with more than this.

### 6.3 Review
For every community app and every version:
1. **Automated,** on MA's build machine: `ma-app verify` and `check` (layout, signatures, manifest, ceilings, the conformance suite), the footprint on the reference desk class (memory at idle and under use, start time, idle CPU), and a run with network capture to check the traffic goes only to declared hosts.
2. **A person reads the source** against the manifest: what each permission and host is for, no telemetry, no obfuscated code, no data leaving that the listing doesn't say.
3. **MA builds the package from the reviewed commit** (decision 5), so what members run is what was read.
4. **The owner approves each new app's first listing.** Updates need the review only.

Rejections say why. Review results for a version are public in the catalog repository.

### 6.4 Developer mode
- A member can turn on developer mode for one desk, with a recent sign-in. That desk then also accepts packages signed only by the developer keys the member registered there, at the community tier's ceilings and never with `display`.
- The desk's strip shows "Developer mode" while it's on (it's a problem in ADR 0062's sense: the desk is running unreviewed code).
- Authors also run the whole loop without a desk: the sample's `ma-app` installs, starts, checks and hosts a view locally (section 7).

### 6.5 The catalog
- A signed static index of reviewed apps (id, versions, package hashes, publisher, permissions, hosts, size and memory, description, review notes) and the packages, served from the platform's existing storage and CDN.
- **The platform keeps no list of who installed what.** deskd downloads packages by hash and the CDN's access logs are off for the catalog, so the platform at most sees a desk's address fetch a package, as for any download. Installed apps live only on the desk.
- Free apps only in 1.0. Paid apps would move money, which is the owner's (decision 9).

## 7. The open source repository
Task 06 prepares a cleaned public copy of `ma-desk`. For the community to build apps it needs:

| What | Where |
|---|---|
| This contract as the normative spec, with JSON Schemas for the manifest, every `appApi` message and `app.summary` | `docs/app-api/1.x/` |
| `CHANGELOG.md` and `FROZEN` (5.5) | `docs/app-api/` |
| The conformance suite and the developer tool (`ma-app keygen`, `pack`, `verify`, `check`, `view`) | From `spikes/app-contract-sample/`, grown into `tools/ma-app/` |
| Samples in at least two languages, one of them Java (Spring not required), so "any language" is shown, not claimed | `samples/` |
| A view bridge library (the 40 lines in the sample's `view.js`) | `sdk/view/` |
| `CONTRIBUTING.md`: how to propose an `appApi` change (ADR, schema, conformance tests), who reviews (Desk and System Engineers), how to run the checks locally | Root |
| `SECURITY.md`, a code of conduct, `TRADEMARKS` | Root |
| A separate catalog repository: one folder per app, with its manifest, source link and review record. Submissions are pull requests. Checks run on MA's machine, never GitHub Actions | `ma-apps` (new) |

- **License:** the spec, schemas, tool, SDK and samples under Apache-2.0, whatever the desk's own license turns out to be, so an app's author has clear terms for building against the interface (decision 11).
- **Names:** apps may say "for Minimalist Alliance desks", but not use MA's name as their own or its mark.
- Task 06's `remove-paths.tsv` should keep `docs/app-api/`, `spikes/app-contract-sample/` and this ADR in the public tree.

## 8. Languages, and why apps aren't Docker containers
- **Core services stay Java 21 Spring Boot in Docker** (ADR 0040): `deskd`, `desk-agent`, `desk-guildhost`. The app module of `deskd` (install checks, the link to apps, the guard) is Java, in `deskd`.
- **Apps are in any language,** which the contract makes possible by asking only for a socket, a frame format, JSON, a signal and a directory. The sample is Go with only the standard library. A Java app is welcome too.
- **An app runs as a systemd unit, not a Docker container.** ADR 0040's addendum asks app services to keep its container rules; the unit keeps each of them: read-only root (`ProtectSystem=strict`), a non-root numeric uid, no capabilities, no `docker.sock`, memory and CPU limits, and journald logging. Reasons not to use Docker for apps:
  - A native GUI app can't keep Chromium's sandbox in a container (task 10 saw "Failed to move to new namespace"), and `--no-sandbox` is never acceptable on a desk.
  - Each container adds a shim process and Docker's own memory, on a desk with little to spare.
  - systemd gives the slice, weights, `MemoryLow`, PSI, freezing and project quotas directly. Docker reaches some of them only through `--cgroup-parent`.
  - Packages on `/data` survive a root swap with nothing to replay. Docker images live on the root volume.
- The trade: an app brings its own runtime instead of a base image. Docker for apps that want it is an owner's decision (decision 2), default no for 1.0.

## 9. Consequences: who would build what
Nothing here is built. If the contract is accepted:

| Owner | Work |
|---|---|
| System Engineer | `apps.slice`; `MemoryLow` on core units; the `desk-apps` root helper (like `desk-units`: verbs `place`, `start`, `stop`, `freeze`, `thaw`, `cap`, `remove`, refusing any uid but 1100); the app uid range; `/run/ma-apps`; nftables per app uid; the HTB class for apps (ADR 0036); `project,quota` on `/data` (new volumes at format, existing ones offline at boot); a second display and `desk-stream` per display for `display` apps (task 10); `desk-runtime.md` §1, §2 and §5 rows; this ADR's number |
| Desk Engineer | `deskd`'s `apps` module: install checks, catalog and revocation, the link, the guard, the egress proxy's per-app ports, `apps.*` in `API.md`; `/run/ma-apps` in `deskd`'s `run`; `docs/app-api/1.x` with schemas and `FROZEN`; the conformance suite in Java tests |
| UI/UX Engineer | The app picker and install sheet, the view host with the bridge and frame guard, widgets from `app.summary`, the problem labels in 2.6, developer mode's label |
| Platform Engineer | The catalog's storage and CDN with logs off, the review signing key, developer key registration |
| Task 06 | Keep the paths in section 7 public |
| Task 10 | Its install sketch becomes a `display` app package under this contract, or stays a first-party special case (decision 13) |

**What gets harder:** every app brings its own runtime, so packages are bigger than container layers that share a base. Reviews take people's time, and MA builds every community package. The desk image grows a little (the helper, quotas, a second display stack later).

**What gets easier:** a member can trust what they install, because it can't see the Browser, can't slow the desk and can't phone home. An author can build in any language from one spec and one checker, without a desk.

## 10. Alternatives considered
- **Apps as Docker containers,** like core services: rejected for 1.0, section 8.
- **Apps as WebAssembly modules inside deskd:** strong isolation and one runtime, but it would put app code in a core service's JVM, rule out native and GUI apps, and limit languages to what compiles to WASI well.
- **Apps as web pages only, with their back end on the author's servers:** no desk resources at all, but the member's data would leave the desk, which is what MA sells against.
- **Views streamed as pixels for every app:** one path for everything, but every app would cost encoder CPU and bandwidth, and text would be softer than a local view (design §2.2's honest limits). Kept only for `display` apps.
- **Views on their own origin (`apps.minimalistalliance.com`):** a real origin instead of an opaque one, but it needs the platform to host app code and makes the platform part of each view's path. The sandboxed frame needs nothing new.
- **JSON-RPC over newline-delimited JSON** for the socket: more familiar, but deskd would carry a second protocol. The 12-byte header is a few lines in any language, as the sample shows.
- **The app connects to deskd instead of listening:** deskd would need a socket every app user can reach, and would have to tell apps apart on it. One socket per app, opened by deskd, keeps identity in the path and the peer's uid.

## 11. The owner's decisions, each with a default
1. **Community apps at all,** opt-in per app and per desk, reviewed and signed. *Default: yes.*
2. **Docker for apps** as well as systemd units. *Default: no for 1.0; units only (section 8).*
3. **How much of a 4 GiB desk apps may use together:** 1.5 GiB of memory (throttled at 1.25), a tenth of contested CPU, and disk while 2 GiB stays free for the Browser. *Default: yes; bigger custom desks get more.*
4. **Per-app ceilings** for community apps: 256 MB, half a vCPU, 1 GB of disk. *Default: yes.*
5. **Review:** source public under an open license, read by a person, and MA builds the package from that source. *Default: yes.*
6. **Window views in a sandboxed frame with no network** for community apps. *Default: yes.*
7. **The review signing key** in the cloud provider's key service, about $1 a month. *Default: yes.*
8. **Native apps with their own streamed display** (`display`): reviewed first-party apps only, one streaming at a time. *Default: yes.*
9. **Free apps only** in 1.0. *Default: yes.*
10. **Removing an app keeps its data** unless the member ticks "Also delete its data". *Default: yes.*
11. **Apache-2.0 for the app spec, tool, SDK and samples,** separate from the desk's own license. *Default: yes.*
12. **Old majors kept for 12 months** after a new `appApi` major. *Default: 12 months.*
13. **The Claude desktop app (task 10) goes through this contract** as a first-party `display` app. *Default: yes.*
14. **The four built-in apps stay as they are,** inside `deskd`. New first-party apps use the contract. *Default: yes.*
15. **No network for an app without `net`, and no telemetry for any app.** *Default: yes.*
16. **At most one core batch a month on members' desks,** applied only while a desk is idle (section 13). *Default: yes.*
17. **One exception: an urgent fix,** a security hole that's actively exploited or reachable remotely, or a bug that loses members' data or leaves desks unusable and that rollback can't cure. The System Engineer declares it and the owner is told in one line. After 24 hours it may interrupt a member who hasn't gone idle (13.2). *Default: yes.*

## 12. Not decided here
- App-to-app interfaces, agent tools from apps, Chat transports and Notebook embeds: later minors, each with its own ADR, built on section 5.
- Apps on Guild Desks and guild hosts, where members' data mixes.
- How the member's storage drive (task 19) is laid out and shared, beyond "only what the member picks".
- Paid apps.

## 13. Updates to members' desks

The owner, 2026-11-06: "I want to make sure that this gets done so that updates to real users desks are infrequent because we don't want to frustrate the founding users and never grow".

Members' desks only. Test desks and the owner's desk can still take work between batches through `desk-service-release.sh`, which never gets a member target. Nothing here was built when it was written; 13.8 says what is now (the desk's half, `sub/desk-batch`, 2026-11-09). *Assumed* marks any number nobody has measured.

### 13.1 Cadence
- **One batch a month at most** (decision 16): `deskd`, `desk-agent`, `desk-rtc`, `desk-stream`, `desk-egress` and, when it must change, the image. Tested as a set, applied all or nothing. Batches are cumulative, so a late desk takes only the newest.
- **Mostly services:** `ma-update`, no reboot. A root swap comes only when something outside `/opt/ma` must change, and that image bakes the batch's own service versions.
- **One exception: an urgent fix** (decision 17): a security hole that's actively exploited or reachable remotely, or a bug that loses members' data or leaves desks unusable and that rollback can't cure. The System Engineer declares it and the owner is told in one line. Any other bug waits for the next batch.

**What already bypasses this:** `unattended-upgrades`, daily on every desk (`20auto-upgrades`), no reboot (`51ma-unattended`), Chromium unheld (ADR 0035). It stays, because Chromium fixes can't wait a month. But:
- ADR 0035 has never seen it fire on a desk. Despite `51ma-unattended`'s comment it isn't security-only: Debian's default origins (2.12, trixie's) also take stable point releases. The next bake narrows them.
- It has no rings and no rollback. A bad Chromium reaches every desk in about a day and can only be fixed forward. Accepted.
- A package on disk interrupts nobody, and protects nobody until the process restarts. Nothing restarts Chromium on an always-on desk, and a new kernel waits for a reboot.
- Debian's timers are `Persistent=true` (read, not run), so it can start right after a wake, with a member waiting. One first boot spent 31.5 s on it (`image/evidence/verify-<ami>.txt`).

So, from the next bake, it runs only while idle, at low priority, or after 3 days with no idle (*assumed*). Once it moves Chromium, the next idle closes Chromium with `desk-browser-close`, and the next open starts the new version. If a newer kernel is installed, a batch reboots the idle desk, with `deskd` back in 9 to 10 s (measured). **ADR 0035's catch:** `Last Version` then moves forward and an older image can't be swapped in. A rollout takes a week, so that will be common (*assumed*). The root swap's step 5 handles it.

### 13.2 Never interrupting
- **Idle** means no client session, no Agent run, no export or move, for half the desk's idle-stop time, at most 60 minutes (*assumed*): 10 minutes on an Alliance desk. A root swap or Chromium close also waits for Browser downloads. A desk that's never idle waits, with no limit. A window the member picks (`updates.window`, account default, desk override, "whenever idle" unless set) only narrows idle.
- **A service batch:** `ma-update` gains a prepare step, so download, unpack and `docker load` finish before the first restart. Once switching starts it finishes, because a half-applied set was never tested, and a member arriving sees the normal connecting state. Chromium keeps running (ADR 0035, run). About 2 minutes (*assumed*).
- **A root swap:**
  1. Compare `Last Version` with the batch's image and, if the profile is newer, with Debian's package. If neither is new enough, don't swap. This is the preflight's check, on the desk.
  2. `desk-browser-close`, going on only at exit 0.
  3. Ask the platform (13.6). It snapshots the data volume, replaces the root, keeps the old one and tags the new one.
  4. On the new root `desk-preread` runs, and Chromium stays stopped until the self-test passes (13.5).
  5. If the profile is newer than the image's Chromium, update Chromium from Debian before its first start: the guard's documented recovery, automated. Refusing would strand desks, and re-baking per wave would break "same artifact". If Debian can't be reached, the guard refuses and the Browser says it's waiting, session safe.
- **Its time,** measured on small samples: replacement 22 to 25 s, `deskd` ready 44 to 58 s after boot, `desk-preread` 2.7 to 6.2 s, then a first open at 2.1 s. About 2 minutes whole is *assumed*: never timed, and step 5 not at all. `desk-rollout.md`'s whole-root read (968 s on 12 GiB) runs at low priority only while idle, and nothing waits for it.
- **A stopped desk:** the slow step happens in the idle time before the desk stops, never at wake, and no desk is woken for a batch. An Alliance desk stops 20 to 25 minutes after its last session, and its batch starts at 10. Why: a wake has a member waiting (18 to 30 s is modeled, unmeasured, `ma-platform` ADR 0097), a special wake can collide with that member, and in that idle time the desk is already on and what it reads from a cold root stays read. `update.holdUntil` in the heartbeat, at most 15 minutes ahead (*assumed*), holds the sweep without counting as activity. A desk stopped with a batch waiting wakes as usual on the old version, and updates when its member next leaves.
- **An urgent fix** waits for idle for 24 hours. Then a connected desk with no input for 15 minutes counts as idle, ignoring the window. After 72 hours any 60 seconds with no input will do (all *assumed*). The member sees a reconnect (a service), reloaded tabs (Chromium) or the desk gone for about 2 minutes (a root swap). A half-typed form or a running Agent run can be lost, as durable runs aren't built. Sign-ins, tabs and history can't: nothing overrides steps 1 and 2. A stopped desk starts this clock when it wakes, and an urgent Chromium fix installs at that wake, before Chromium's first start, so that first open is slower (unmeasured).

### 13.3 Apps apart from the core
Section 1.3 says how: once a day from the catalog, beside the old version, used at the next start. So an app updates only while it isn't running, with no desk restart or core update, and it isn't a batch. Apps live on `/data` (1.4), so a root swap leaves them alone. Added here:
- A `background` app with no window open restarts while idle to take its update. On an always-on desk it would otherwise never start again.
- `deskd` takes the newest version whose `appApi` range it speaks, so a desk behind on batches isn't stuck.
- The release gate runs `ma-app check` on the sample and every first-party app against the candidate (5.5). A failure stops the batch, so a core update never breaks an app.

### 13.4 Compatibility
- **`appApi` only adds** (5.5). An old app keeps working for at least 12 batches, which can't be shorter than decision 12's 12 months. Anything being removed is announced at least 3 batches ahead, in `HELLO` (a new `deprecated` list) and the developer notes. Urgent fixes don't count as batches.
- **`deskApi`:** the web app ships far more often than desks update, so both directions must hold while any desk is behind. Minors only add, and the web app uses a feature only if `HELLO`'s minor has it. Both sides speak a new major first: the web app adds it before any desk has it, and `deskd` keeps the old one for a batch after the web app drops it, so `4426` and its reload never fire in a normal batch.
- **The gate** runs `e2e/` both ways: new desk with the previous bundle, new bundle on the oldest batch a cloud desk runs. `hostnames.md` says promotion is blocked when a running desk is outside `deskApiRange`; `desk-web-release.sh` doesn't check that yet.
- **Data:** `deskd` and `desk-agent` stay expand-then-contract, and a contract step ships only when no cloud desk runs a batch older than the one that expanded.

### 13.5 Rollout and rollback

| Step | Who | Must pass | Hold (*assumed*) |
|---|---|---|---|
| Test | `DeskKind=test`, by the pull path, same artifacts and hashes | All of `e2e/`, `SESSION_CHECK=root-swap` on a root batch, 13.3's and 13.4's gates. `PASSED-TEST` only means it came up | Until it passes |
| The owner | The owner's desk, on exactly the batch, the owner told in one line in their own
 time zone, snapshot first. A root batch waits for the owner's answer if the desk is in use | The desk's own checks | 48 h and one real session, at most 7 days |
| First group | 10% of member desks, at least 5, every desk size present, picked per batch by hash so nobody is always first | The same | 48 h |
| Everyone | The rest, in three waves, self-hosted desks in the last | The same | 24 h a wave |

An urgent fix takes the same steps with 1-hour holds. New desks are born on the last image to finish a rollout and take later batches at their first idle.

**A desk rolls itself back on a failed check.** All limits but the first are *assumed*.
- **A component:** `ma-update`'s smoke test, 90 s. It puts that component back, and the helper uses `ma-update`'s `--rollback` (`previous`) on the batch's others.
- **A service batch:** the smoke test, which a stopped `desk-stream` passes, then a self-test: a local client gets video packets and a data-channel echo through `desk-rtc`, counting packets and decoding nothing. 5 minutes. The same rollback, reported, not retried.
- **A new root:** the same self-test with Chromium stopped, then a report. 10 minutes from the ask, and silence counts as failure. The platform puts the kept root back. That's safe: no new Chromium ran, so the profile didn't move.

**A whole batch halts** (the platform stops naming it) on any failure at the test or owner step, any rollback in the first group, more than 2 desks or 5% of a wave (`ma-platform` `platform-design.md` §6.5's numbers), or at once on a changed `dataVolume.formattedAt` or a `health.checks.chromium` that outlasts step 5. Desks that passed stay. The System Engineer fixes forward or signs a rollback batch, with a higher sequence number naming older versions.

**Where rollback can't be simple.** Once a new root's newer Chromium has run, `Last Version` is ahead of the kept root, and the old Chromium would raze `Cookies`. So nothing rolls a root back automatically after Chromium's first start. If a service is at fault, `ma-update --rollback` leaves the root and Chromium alone. Otherwise fix forward with a new image. Only if the new root is unusable and can't wait does the System Engineer put the kept root back with Chromium held stopped, then as in step 5: the guard refuses, Debian's newer package goes on, and it starts. Never start an older Chromium, edit `Last Version`, or restore the data volume to get round this (a restore can lose up to 24 hours, ADR 0035). A kept root is deleted after 7 days (*assumed*); deleting the owner's still needs the owner's OK.

### 13.6 How a desk gets a batch (for the Platform Engineer's review)
`desk-service-release.sh` targets only test desks and the owner's, and `ma-platform` ADR 0091 refused `ssm:SendCommand` from an event, because that's root on a member's desk from the platform. So the desk pulls:
1. The heartbeat response names the batch once the desk's wave is open. The platform sends nothing else.
2. A new agent route returns the manifest and presigned URLs. The desk role doesn't change.
3. A root helper, `desk-batch`, socket-activated like `desk-units` and outside `deskd` because nothing can supervise its own replacement, checks the manifest's signature against two public keys in the image and refuses a lower sequence number. It takes idle from `deskd`, picks the moment and runs `ma-update`.
4. A root swap is an ask: one signed call from the helper, naming only the batch. The platform takes the image from its own record, refuses if the batch is halted or the wave isn't open, and carries it out. A refusal just starts `deskd` again.

**For Platform:** a batch record and waves, the route, root replacement on an ask with the snapshot, tags, watchdog and put-back, a narrow replace-root permission instead of remote commands, `update.holdUntil` in the sweep, `deskApiRange` enforced, and the signing key in the cloud provider's key service as in 6.2, about $1 a month. This supersedes the forced upgrade after 7 days, the default 02:00 to 05:00 window and the previous-image rollback in `ma-platform` ADR 0015 and `platform-design.md` §6.5, `upcomingStop`'s `upgrade`, and ADR 0026's upgrade stops. The signature means a bug or breach of the platform's API alone can't put code on a desk. An account admin still could, as break-glass remote commands remain. The helper must be in the image desks are born on; a desk born earlier gets it once, by today's path.

**Self-hosted desks** update today only by re-running `install.sh`. They get the same batches: the same commits built for amd64, the same signature, the same heartbeat, after a test on a `ma-selfhost-*` VM. No platform root: no remote commands and no ask. An image change runs the bundle's `install.sh` in place, and `--rollback` is the rollback. The member owns the machine, so the window and the choice are theirs: "when idle" by default, or only when they run `sudo ma-selfhost update`. The gate's oldest-batch rule ignores these desks, and one more than 12 batches behind is told so in one line on its `/self-hosted` page.

### 13.7 Members are told
- A short plain "what changed" note the next time they open their office, once per batch across desks and browsers, needing no action, only when something they'd notice changed. Most batches have none. It's a plain-text field of the signed manifest.
- No "update available", no "restart now", no modal. After an urgent fix that interrupted them, one line saying so.
- The Desk app's "A new version is ready, reload when you like" (`NewVersion.tsx`) is that kind of notice, on every web release, so it goes: a tab takes the new bundle at its next load, and it shows only if the tab can't talk to the desk.

### 13.8 What exists and what has to be built

| Part | Today | To build | Owner | Agent hours (estimate) |
|---|---|---|---|---|
| Apply on the desk | **Built, not baked (`sub/desk-batch`, for 0.3.2):** `desk-batch` (signed manifest v1, sequence floor, prepare all then activate in order, reverse rollback, resume after a cut-off, `holdUntil`, `root-pending`), `ma-update --prepare`, `--activate`, `--unprepare`, idle-only apt at the lowest priority, origins narrowed to the security archive, `chromium.pending` and `reboot.pending` recorded, `verify.sh` section 7. Runtime spec §6.1 | The self-test (video packets and a data-channel echo); the Chromium close at idle and the catch-up of step 5, both waiting on a newer Chromium to prove against (none exists yet); a reboot for a kernel; the root-swap ask and its reply; `updates.window` | System | Built: about 6. Left: 3 to 6. Floor: a bake and `verify.sh`, about 40 min |
| `deskd` | Session counts, `agent.activeTasks`, `data.*` | `/run/desk/idle.json` and fetching and offering a batch on `batch.sock`, both now defined (runtime spec §6.1); batch state and hold in the heartbeat, note state, `deprecated` in `HELLO` | Desk | 4 to 8 |
| Agent keys | **In RAM: a `desk-agent` restart loses the member's LLM key** | ADR 0012's envelopes, before the first batch that restarts `desk-agent` | Desk | Not sized here |
| Platform | Release script, preflight over remote commands, root swaps by hand | 13.6's list, plus `agent.md`, `selfhost.md` and ADR 0015 | Platform | 12 to 20 |
| Release gate | `e2e/`, `ma-app check`, `passed-test.json`; **`tools/batch/`: `batch-build` (refuses a release with no pass record), `batch-sign` (KMS or a dev key), `batch-verify` (the desk's own check), `batch-urls`** | A real-test record for a batch, runs both ways, a second test desk on the oldest batch, the image's baseline seq at bake | System | 3 to 5. Floor: `e2e/` is about 19 min a pass |
| Desk app | The reload notice | The note, the notice gone, features by minor, the window setting (can follow the first batch) | UI/UX | 3 to 5 |
| Self-hosted | `install.sh`, unsigned | Signed amd64 batches, the member's choice | System | 3 to 5 |
| Proof runs | A lab box from 0.3.1 with real releases (`docs/sub-status/desk-batch.md`): two batches each way, refusals, a prepare and an activate that fail, idle fail-closed, apt only at idle, timed. Nothing on a test desk | 13.9's first three items, on a test desk | System | 3 to 5 |

### 13.9 What stays unproven
- A newer Chromium opening a real profile, by restart or root swap. Every image so far has 156.0.8078.79, so nothing has moved it.
- `unattended-upgrades` replacing Chromium's package under a running Chromium, and `docker.io` under `deskd` (`live-restore` is on, not run). If Chromium misbehaves, its package waits for idle even past 3 days, and the urgent path covers the gap.
- Putting a kept root back: the runbook says no tested procedure exists. A stop, a volume swap and a start are *assumed*.
- A member arriving mid-batch, a batch timed whole on an Alliance desk, and a wake after a swap and a stop.
- What share of desks reach idle during a batch. A tab left visible holds a session, so that desk waits. Unknown until there are members.
- **Shared machines: not designed, and the plan depends on them.** The owner has decided desks will share machines (task 28, S-56). All of this assumes one desk per instance, which is true today, Alliance included. On a shared machine a service batch stays per desk, but a host change needs all its desks idle or moved first (`ma-platform` `docs/research/shared-desk-hosts.md`), so a root swap as written here can't apply. This has to be designed before S-56 places a member on a shared host. Guild hosts aren't designed either, and aren't built. **Since designed (2026-11-11):** a shared host's template generations are ADR 0077, and its service batches ADR 0078: the same signed batch, unpacked once into each host's release store and switched in each slot at idle (built on `sub/host-batches`, `docs/sub-status/host-batches.md`; not baked yet).

## Desk Engineer review (2026-11-11)

Launch row S-97 pulled the base into launch. This review covers decisions 1 to 17 and sections 1 to 13 from deskd's side, and deskd's half is built to it: `services/deskd/src/main/java/com/minimalistalliance/desk/deskd/apps/`, wire in `services/deskd/docs/API.md` §19. Where this section and the draft differ, this section is what deskd does. The ADR stays Proposed.

### The decisions

| # | Verdict | Note |
|---|---|---|
| 1, 5, 6, 9, 11, 12, 14 | Accepted | As written |
| 2 | Accepted | Units, not Docker. deskd never runs an app: the helper does |
| 3, 4 | Accepted | deskd checks the ceilings at install and refuses one that leaves under 2 GiB free on `/data` |
| 7 | Accepted | The same key-service key signs the catalog index (C1): no second key |
| 8, 13 | Accepted | deskd refuses `display` (`not_supported`) until a second display exists (C10) |
| 10 | Accepted | The app's uid stays reserved with its kept data, so a reinstall gets both back |
| 15 | Accepted | deskd refuses `net` until the egress proxy has per-app ports (C10) |
| 16, 17 | Accepted | Not on deskd's install path: apps update apart from batches (§13.3) |

### Changes, each with its reason

- **C1. deskd fetches, checks and serves the catalog** (changes 5.6 and 6.5). `apps.catalog.get` returns deskd's verified copy; the Desk app never fetches or checks it. The trust check then runs once, in Java, where installs happen; the Desk app needs no new origin in its policy; and the Platform sees a desk fetch a public file, not which member browsed the picker. The envelope is `{index: base64, signatures: [{keyId, sig}]}`, signed by a review key. A `seq` lower than the newest taken is refused, so the Platform can't replay an old index to undo a revocation. Only that `seq` is kept on the volume (in `registry.json`); the index stays in memory, so none of it reaches the member's export.
- **C2. `ma-app.json` and `ma-app.sig` are the first two tar entries,** and deskd streams the rest (changes 1.1). deskd verifies both signatures and the manifest before it writes a byte, then hashes each file as it writes it into staging. The sample reads the whole package into memory, which a desk with about 110 MB for deskd can't do for packages up to 4 GiB. Format: gzip, POSIX ustar, pax `x` headers for long names (only `path` and `size` are used). No GNU or global headers, links, devices, sparse files. The whole package's size and hash must equal the catalog's. Caps: 4096 files, paths of 255 bytes, a 256 KiB manifest, a 16 KiB `ma-app.sig`, and 16 MiB of headers and padding.
- **C3. A key's id is the first 8 bytes of SHA-256 over its SubjectPublicKeyInfo,** as 16 hex digits, for Ed25519 and P-256 alike (changes 6.2). The sample hashes the raw Ed25519 key; `ma-app` changes that one line when it becomes `tools/ma-app`. P-256 signatures are DER over SHA-256, as the key service gives them. Two review signatures of different tiers give the lower tier.
- **C4. Releases are written by deskd, owned by `desk`, not root** (changes 1.4): directories `0755`, files `0644` or `0755`. The app's uid can only read them, and the helper binds them read-only. The root helper then never parses or copies package bytes, which keeps root's surface small, and deskd already holds more than this. Staging is `releases/.staging-*`, inside the app's project quota, because ext4 refuses a rename across project ids (`EXDEV`), and inside `releases`, which the export already leaves out.
- **C5. Every install and upgrade ends with a trial start,** and a failed one rolls back (changes 1.3). The new version must answer HELLO within its `startTimeoutSec`. If it doesn't, the old record, links and run come back, the new release is deleted, and a first install's directories go too. The registry marks the entry `trial`, with the entry it replaced beside it, until the HELLO comes, so a deskd that stops mid-trial is rolled back at its next start the same way. The member hears at once, and a version that can't start never stays current. The draft's "three failed starts switch back" is kept for the automatic updates, not built yet.
- **C6. No step-up to install** (changes 6.1). The house rule is no sign-in-age gates. The consent is the owner's session, or the Founder's on a Guild Desk, plus the tap. `grants` must be exactly the version's permissions, so the Desk app can't grant what the sheet didn't show.
- **C7. `apps.call` is split, and `apps.sub` becomes a SUB** (changes 5.6). `apps.call` reaches declared reads and `apps.mutate` declared mutations, never the other way round, because deskd's dispatcher decides per method name whether a key is needed and kept. Subscriptions are SUB `app:<id>:<topic>`, so they get deskd's flow control, resume and slow-consumer rules. App topics are coalescible: a patch carries values, never increments, since one can repeat what a snapshot had.
- **C8. `from` gains the caller, as pseudonyms** (changes 5.3). `from` is `{kind, session, caller}`.
  - `session` is an HMAC of the desk session under a per-app key held only in memory.
  - `caller` is `{kind: "owner"}`. On a Guild Desk it is `{kind: "guild_member", member, role, grants, teen}`, where `member` is an HMAC under the app's own key in the registry: stable for that app on that desk, and unlinkable across apps.
  - Never a name, email, account or guild member id.
  - The mutation's `idem` goes on to the app too.
- **C9. The manifest is strict and the catalog lenient.** A key deskd doesn't know in `ma-app.json` refuses the package, so a field deskd can't honour, a permission above all, is never ignored in silence. A desk too old for a new field can't install that version, which the `appApi` range already says. The index is MA's own, so unknown fields there are ignored.
- **C10. Only permissions deskd can honour today install.** That is `background`. `net` waits for the proxy's per-app ports, `files.pick` for the picker, `browser.open` for the click rule and `display` for a second display. A version asking for one shows `installable: false, reason: not_supported` and is refused, never installed half-working. Each one turns on when its part ships, with no new `appApi` minor, because the permission list is already 1.0's.
- **C11. Downgrades are refused.** An app may have moved its data forward. Rollback goes to `previous` only when the new version never answered HELLO (C5), before it could touch its data.
- **C12. Reserved namespaces add `guild.`, `data.` and `commons.`,** which are deskd's own families too.

### Gaps, and how they close

- **Upgrade and rollback:** C5 and C11. The daily automatic update (1.3, 13.3) isn't built. When it is, it updates only a stopped app whose new permissions are within its grants and whose resources are within the current ones (`Resources.within`), with three failed starts switching back.
- **Data migration:** deskd never touches an app's data. The contract gains a rule for apps:
  - change the data's format only after answering HELLO;
  - keep a format number in the data;
  - an older version that finds a newer format closes with 4426 (`needs_update`) and doesn't read it.
- **An app that crashes** (built): it starts again after 1 s, 5 s and 30 s while anyone is subscribed or it's `background`. After 3 in 10 minutes it stays `failed`, with `crashed`, or `memory` when the helper reports an OOM kill, until the member starts it. An on-demand app stops after 10 idle minutes.
- **Size and CPU caps:** deskd holds the manifest to the tier's ceilings, the files to `diskMaxMiB`, frames to 1 MiB and 64 KiB, and calls to 32 in flight and a 30 s deadline. The kernel's enforcement is the unit's (System). The pressure guard (2.3), the apps' memory budget (stop the least recently used) and emptying caches below 2 GiB free (2.4) aren't built: each needs a helper verb (`cap`, `freeze`, `cache.clear`).
- **Export (S-86):** each app's `data/` and its widget's `summary.json` are in the export's "Apps" part already. `tools/desk-data` leaves out `registry.json` and every `releases`, `current`, `previous` and `cache`, and that matches this layout, so the helper needs no change. A move carries the data but not the registry, so a reinstall on the new desk takes the data back at `prepare` (which re-owns it). A Guild Desk member's pseudonym changes on a move, but Guild Desks don't move today. **New rule for review (6.3):** an app keeps its data in a form readable without it (plain files, JSON, SQLite), because the export promises members their data, not an app's private blob.
- **Guild Desks** (§12 had them open; decided here for 1.0): installing, upgrading, removing and stopping an app are the Founder's (`role: lead`), because a new app on a shared desk sees every member's calls. Every member may list, open, call, mutate and subscribe, and each member's subscription is their own. Leaving a guild now reaches apps: `app.members.retain` (5.3, a 1.x addition of 2026-11-11) closes what was a gap here. Review refuses a Guild Desk app that keeps a member's own data and doesn't take it.
- **deskd's own cost:** with no app, one directory check at start, no thread and no timer. Each running app adds one socket and three virtual threads, a writer queue capped at 4 MiB, and a 5 s ticker. A 30 s ticker runs while any app runs. The daily catalog check runs only while an app is installed.

### ADR 0035 and the export

- **No permission reaches the Browser's session,** and nothing in deskd's apps package touches `/data/browser`. No conflict there.
- **A full `/data` is the real risk.** An app with no disk cap could fill the volume, and Chromium would evict site storage. Binding from here:
  - the helper's `prepare` refuses on a `/data` without project quotas, so no app starts on such a desk;
  - deskd refuses an install that leaves under 2 GiB free.
- **The unit must hide `/data/browser`** (`TemporaryFileSystem=/data:ro`, then only the app's own directories bound back), as 2.1 says. That is the System Engineer's template, and Security should read it.
- **The export:** no conflict. The layout above keeps package bytes, the registry's per-app keys and the catalog out of it.

### For the System Engineer: what deskd needs

- **The helper `desk-apps`** on `/run/desk/apps.sock`: root, socket-activated, `0600` owner `desk`, peer uid 1100 only, one JSON line each way of at most 4 KiB (`HelperAppHost`). It refuses a uid outside 2000 to 2999 and any id that isn't a manifest id.
  - `prepare {id, uid, diskMaxBytes}`: make `/data/apps/<id>/` (owner `desk`, `0700`) with project id = uid, the inherit flag and a hard quota of `diskMaxBytes`; make `data/` and `cache/` (`0700`, the uid), re-owning ones that exist; make `/run/ma-apps/<id>/` (`2750`, uid:`desk`). Idempotent. Refuse with `no_quota` if `/data` has no project quota.
  - `start {id, uid}`: build the transient unit from `/data/apps/<id>/current/ma-app.json` as 2.1 says, holding it to the first-party ceilings and refusing `display` and `net` for now, whatever it says. Start it in `apps.slice` with §1.5's environment (`MA_DESKD_UID=1100`). Answer once systemd has; a running unit answers `ok` as it is.
  - `stop {id}`: SIGTERM, then SIGKILL after `stopTimeoutSec`; answer when it's gone.
  - `status {id}`: `{state: running|stopped|failed, result}`, with `result` `oom-kill` for a kill at `MemoryMax`.
  - `remove {id, uid, deleteData}`: stop it; drop its quota, firewall rule and socket directory; with `deleteData`, delete `data/`, `cache/`, then `/data/apps/<id>/` once it's empty. deskd has already deleted its releases.
- **The image:**
  - `/data/apps` (`desk`, `0700`) from `desk-datadirs`, made together with the helper;
  - `/run/ma-apps` (root, `0755`) from tmpfiles;
  - review keys as `/opt/ma/etc/app-keys/<tier>.<name>.pem` (Platform's public halves), with `/etc/ma/app-keys.d/` for a test desk's drop-in;
  - `project,quota` on `/data`;
  - `apps.slice`, and `MemoryLow` on the core units.
  
  deskd's `run` already mounts `/data/apps`, `/run/ma-apps` and both key directories, each only if it exists.
- **Docs:** `desk-runtime.md` §1 (`desk-apps`, the uid range), §2 (`/data/apps`, `/run/ma-apps`, the key directories, `apps.sock`) and §5 (deskd's new mounts).
- **The ADR index:** no row change asked. It stays a draft until the owner's decisions are recorded; number it then.

### For the Platform Engineer

- `GET /v1/public/apps/catalog`: the envelope above, at most 4 MiB, or 404 while there's none. No auth, and the CDN keeps no access log.
- The index is `{catalog: 1, seq, issuedAt, developers: [{keyId, publisher, publicKey}], revoked: {keys, packages}, apps: [{id, name, publisher, description, versions: [{version, arch, packageSha256, manifestSha256, bytes, appApi, permissions, net, resources: {diskMaxMiB, …}, notes}]}]}`. `publicKey` is base64 SPKI and `keyId` follows C3. `revoked.packages` holds manifests' SHA-256.
- `GET /v1/public/apps/packages/<packageSha256>`: the bytes, or a 302, 303 or 307 to an `https` URL; deskd follows one.
- The review key in the key service (Ed25519, or P-256 if it has no Ed25519; decision 7) signs both the index and each package's manifest. There are always two valid public halves, for the image.
- Developer key registration per publisher.

### For the UI/UX Engineer

- **The picker** reads `apps.catalog.get`, never the CDN, and shows `installable: false` with its reason.
- **The install sheet** sends `grants` equal to the version's `permissions`, with no step-up.
- **The tiles** come from `apps.list` and the `apps` topic, using `state`, `problem` (2.6's words) and `summary` (the widget, drawn in Konva with house components).
- **The window** comes from `apps.view.get`: check the review signature over `manifest` with MA's public keys and every file's SHA-256, then build the sandboxed `srcdoc` frame (3.2). The bridge calls `apps.call` and `apps.mutate`, and SUBs `app:<id>:<topic>`.
- **On a Guild Desk,** install, remove and stop are the Founder's.

### For Security: read before any desk runs it

The house rule is config review and normal use only, with no probing.
- **Trusted:**
  - the review public keys, which only the image places (root-owned, mounted read-only);
  - deskd, the only parser of packages and the catalog;
  - the root helper, which trusts deskd's verification but holds every unit to the ceilings and the uid range itself;
  - the kernel's uids, mount namespaces, cgroups and project quotas.
- **Not trusted:**
  - the Platform's API and CDN, which can withhold a catalog or a package but can't forge either, and can't replay an older index;
  - package bytes until verified;
  - the app process;
  - everything an app sends;
  - the Desk app's requests beyond the owner's or Founder's session.
- **deskd checks** (`apps/`):
  - the envelope's signature and `seq` floor;
  - the package's size and hash against the catalog, and the manifest's hash against the catalog;
  - both signatures over the manifest, with the developer key registered to the publisher and revoked keys and packages refused;
  - the manifest strictly, against the tier's ceilings;
  - the tar layout (C2), and each file's hash as it's written;
  - grants equal to permissions;
  - the 2 GiB floor;
  - the peer's `SO_PEERCRED` uid at the app's socket, before it says a word;
  - frame sizes, 32 calls in flight, 50 requests a second from an app, and only reads through `apps.call` and only declared names.
- **Threats to read for:**
  - a hostile package: path traversal, links, a decompression bomb, a manifest swapped after signing;
  - a tier raised by a second signature;
  - a publisher impersonated through another's developer key;
  - catalog rollback;
  - a compromised Platform withholding a revocation. deskd keeps serving its last catalog and checks daily, so a revocation lands only when a fetch succeeds. Accepted, and worth a read;
  - an app reaching the Browser's session or another app's data, which are the unit's mount namespace and uids;
  - an app impersonated at its socket (`2750` directory, peer uid);
  - an app flooding or stalling deskd (bounded queues, a stalled write ends only that app's link);
  - linking a member across apps, or a guild member learning another's id (C8 pseudonyms);
  - a kept registry leaking per-app keys. It's `0600`, deskd's, and left out of the export.

### What deskd's part is, and isn't

- **Built and tested, inert on every desk today:** no image has the helper, `/data/apps` or a review key, so `apps.list` says `available: false` and nothing installs. 65 tests and one integration with the sample's real Go Tally are in `services/deskd/src/test/java/…/apps/`.
  - verification (C1 to C3, C9);
  - install, upgrade and remove with rollback (C4, C5, C11);
  - the catalog RPC;
  - the relay to each app's socket with the caller (C7, C8);
  - topics, the widget summary, the crash and idle rules;
  - the Guild Desk rules;
  - `/health`'s `apps`;
  - the kill switch `/data/desk/apps-switch`.
- **Stand-in:** the helper is an interface (`AppHost`) with a client for the wire above (`HelperAppHost`) and a test double that runs a fake app in the test's JVM. Nothing has run against a real helper or unit.
- **Not built:** the daily automatic update, the pressure guard and memory budget, cache emptying, developer mode (6.4), `browser.open` and `files.*` for apps, per-app egress, `display`, the `docs/app-api/1.x` schemas with their `FROZEN` test, and the conformance suite in Java (5.5).

## Addendum (2026-11-11): deskd hosts first-party apps bundled in its image until the helper exists

**Status:** Proposed by the Desk Engineer, for Security's read before any desk runs it. Built on `sub/bible-deskd` (S-150). The wire is in deskd's `API.md` §19, "Bundled apps".

### Context
The Bible (S-150, `com.minimalistalliance.bible`) is the first contract app, and it's wanted at launch, free on every tier. A catalog app needs the System Engineer's helper `desk-apps`, `/data/apps`, a Platform catalog and a review key, and no image or Platform has any of them yet. Waiting would hold the Bible behind all four.

### Decision
1. **deskd's image carries first-party apps** under `/app/bundled-apps/<id>/`. Each holds exactly what a package unpacks to: `ma-app.json`, with every file's hash, and `files/`. They're built from source in this repository by the image's own build (`deskd/docker/bundle-app.go`). Never a downloaded binary, and never a community app.
2. **deskd checks each one at start,** off its start path:
   - the manifest, as a first-party package's;
   - a bundled ceiling of 64 MiB, 0.25 CPU, 32 tasks and 1 GiB;
   - the directory named for its id;
   - every file's size and hash, with nothing extra and no link.

   One that fails isn't offered.
3. **The member adds and removes them as any app.** The catalog lists them with `bundled: true`, `installable: true`, and the manifest's hash as `packageSha256`. Their data goes in `/data/desk/apps/<id>/` (deskd's, `0700`). Section 19's methods, topics, table of who may call, switch and health hold unchanged.
4. **deskd runs each one as its own child** (`BundledAppHost`), with exactly section 1.5's environment and its socket in a `0700` directory in the container's `/tmp`.
5. **A bundled app has no signature.** `apps.view.get` gives `signatures: null, bundled: true`. The Desk app accepts the view on each file's SHA-256 against the manifest, because the files come from deskd's own image, which the desk trusts as much as deskd itself. A catalog app's view is checked as before.
6. **A bundled app goes with deskd's image.** Its version follows the image, and a deskd release updates it.

### Security posture (for Security's read)
A bundled app is first-party, reviewed code from this repository, compiled in deskd's image build, and it runs with **deskd's own authority**:
- **Same uid, same container.** It can read and write whatever deskd can:
  - deskd's state in `/data/desk`, other bundled apps' data included;
  - the member's Files (`/data/files`, which deskd's container mounts);
  - the sockets in `/run/desk`, whose helpers trust uid 1100: `rtc.sock`, `units.sock`, `data.sock`, and `apps.sock` once it exists;
  - the services deskd relays to, as deskd: `/run/desk-agent` (it could drive the Agent), `/run/desk-notebook`, `/run/desk-commons` and `/run/desk-links`;
  - its own member key, `/data/desk/apps/<id>/member.key`, and every other bundled app's.

  The peer-uid check on its socket, made both ways, proves only "deskd's uid".
- **Network:** deskd's container is on the host's network, so nothing stops the app opening a connection. The Bible opens none: its texts are bundled, and nothing is fetched at runtime (S-150's rule, which its review checks).
- **Limits:** its runtime sizes itself to `MA_APP_MEMORY_MAX` and `MA_APP_CPU_MAX`, and nothing else holds its memory, CPU or tasks. The container's limits (512 MiB, 256 pids) are deskd's, and the app takes from them. `nice -n 10` lets deskd win under contention, and `oom_score_adj` 1000 makes the kernel take the app first in a full container. There's no disk quota: install keeps the Browser's 2 GiB floor (ADR 0035), and the app's own code bounds its data.
- **What deskd does hold:**
  - the integrity check at start;
  - a cleared environment, with no `PATH`, name or desk id;
  - its own data as its working directory, and no stdin;
  - its output dropped, so nothing it logs names a verse or a note;
  - its socket in a private directory;
  - the ceiling, and every frame, call and event bound of section 19;
  - the kill switch, and the export rule below;
  - no process of it during the AppCDS training run, and none after deskd stops.
- **Hardening without root (not built):** the app could restrict itself after start with Landlock, to its `files/`, its data and cache, and no TCP, which Go can do with system calls alone. That's a follow-up for the app's builder and Security, not a condition here.
- **Threats to read for:**
  - a bundled app as a path to deskd's helpers or the member's Files, which is why only reviewed first-party code is bundled;
  - a tampered image file (the check at start; the image is root's);
  - one bundled app reading another's data (no barrier: same uid);
  - an app's memory squeezing deskd (`oom_score_adj`, and its own limit).
- **On a Guild Desk** the Founder adds and removes a bundled app, and every member uses it, as section 19's table says for any app. It sees every member's calls. So it must:
  - keep each member's data apart by `from.caller.member`, which deskd sends on every relayed call and each member's own subscription (the Bible's service adds this);
  - publish no member's place or content in `app.summary`, which every member's tile shows;
  - take `app.members.retain` (5.3), so a member who leaves loses their data on the same guard as their agent conversations.

  deskd sends it only with a key it can trust (Security's S-150 Medium). The key is kept beside the app's data, so a lost registry changes no pseudonym. It's never sent when the key was made over data the app already had, or when there's no key. It's never sent with an empty list, and never on a first roster with nothing before it.

  The export's `desk` part then holds current members' data under pseudonyms and none of a departed member's, as the `agent` part does.

### The export
Each bundled app's `data` and `summary.json` go in the export's `desk` part ("Desk settings and Chat"), as `apps/<id>/…`. deskd leaves out `apps/registry.json`, which holds each app's member-pseudonym key (the contract keeps those out of the export), and every `apps/<id>/cache`, whatever `desk-data` says. `desk-data` should get the same rule (its `excluded()` for part `desk`), and may want the member to see the data under Apps. Those are for the System Engineer.

### What moves when the helper ships
- **Each bundled app becomes a unit like any other app:**
  - `prepare` gives it a uid from the range;
  - its `data` and `cache` move from `/data/desk/apps/<id>/` to `/data/apps/<id>/` (prepare re-owns them);
  - its registry entry moves, with its member key;
  - `HelperAppHost` runs it with the unit's sandbox: its own uid, mount namespace, cgroup and quota, and no network.
- **Its files** can stay in deskd's image, bound read-only into the unit, or the app can move to the catalog as a signed package. After that, `bundled` is false and the view needs signatures.
- **What goes:** `BundledAppHost` and the `/data/desk/apps` home. The wire's `bundled` fields stay (they're additive), so the Desk app needs no change.
