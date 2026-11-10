# Architecture decision records

One file per decision: `NNNN-short-title.md`, numbered in order. Never edit an accepted ADR's decision; supersede it with a new one and update both statuses.

## Index
| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-separate-repo-and-aws-boundary.md) | Separate repo and AWS boundary | Accepted | 2026-11-04 |
| [0002](0002-web-app-react-konva.md) | Desk is a web app (React + Konva), not Tauri/native | Proposed | 2026-11-04 |
| [0003](0003-canvas-interaction-model.md) | Canvas interaction model: scope filter, cell-grid desks, per-desk windows, Arrange mode | Proposed | 2026-11-04 |
| [0004](0004-canvas-rendering-and-accessibility.md) | Canvas rendering, accessibility and visual tokens | Proposed (amended by 0028, 0029) | 2026-11-04 |
| [0005](0005-client-state-and-storage.md) | Client state and storage: layout doc in Platform, desk content in memory only | Proposed | 2026-11-04 |
| [0006](0006-desk-daemon-node-sqlite.md) | Desk daemon (deskd): Node 24 + TypeScript, SQLite per app | Superseded by 0040 | 2026-11-04 |
| [0007](0007-desk-image-debian-arm64.md) | Desk image: Debian 13 arm64, recipe in ma-desk, built and rolled out by Platform | Proposed (amended by 0022) | 2026-11-04 |
| [0008](0008-browser-streaming-webrtc-neko.md) | Browser streaming: WebRTC via Neko v3, CDP screencast as compat fallback | Proposed (amended by 0022, 0030: desk-rtc, 60 fps, TURN replaces compat; by 0034: `desk-stream` capture and keyframes) | 2026-11-04 |
| [0009](0009-browser-process-model.md) | Browser process model: sandboxed kiosk Chromium, Playwright over local CDP, separate agent context | Proposed (amended by 0022, 0041) | 2026-11-04 |
| [0010](0010-desk-connectivity-and-auth.md) | Desk connectivity and auth: direct TLS to the desk VM, Platform desk tokens, per-desk role | Superseded by 0022 | 2026-11-04 |
| [0011](0011-desk-data-location-and-privacy.md) | Desk data location and privacy posture | Proposed (amended by 0022, 0024) | 2026-11-04 |
| [0012](0012-llm-keys-desk-encrypted-envelopes.md) | LLM provider keys: desk-encrypted KMS envelopes, Platform-blind | Superseded by 0042 | 2026-11-04 |
| [0013](0013-idle-stop-and-wake.md) | Idle-stop and wake: Platform decides, Desk supplies activity signals | Superseded by 0026 | 2026-11-04 |
| [0014](0014-minimum-instance-t4g-medium.md) | Minimum instance for primary desks: t4g.medium, provisional until a benchmark gate | Proposed (amended by 0025, 0027, 0028) | 2026-11-04 |
| [0015](0015-notebook-editor-tiptap-yjs.md) | Notebook editor: TipTap 3 with Yjs (Hocuspocus) sync and versioned history | Proposed (amended by 0023, 0044) | 2026-11-04 |
| [0016](0016-chat-channels-and-delivery.md) | Chat model: channels, medium separate from author, default = last medium received | Proposed | 2026-11-04 |
| [0017](0017-sealed-relay-desk-to-desk.md) | Desk-to-desk messaging through a sealed Platform relay | Proposed (amended by 0022, 0024) | 2026-11-04 |
| [0018](0018-agent-framework-ai-sdk.md) | Agent framework: AI SDK Core with thin custom orchestration | Proposed (amended by 0040) | 2026-11-04 |
| [0019](0019-agent-safety-policy-point.md) | Agent safety: deskd as the single policy point, sandboxed runtime, confirmed egress, audit log | Proposed | 2026-11-04 |
| [0020](0020-agent-runs-and-usage-limits.md) | Agent runs and usage limits enforced on the desk | Proposed (amended by 0026, 0043) | 2026-11-04 |
| [0021](0021-minified-websites-structure-based.md) | Minified websites: built from page structure, staged, no generative pixels | Proposed (amended by 0028, 0030, 0041) | 2026-11-04 |
| [0022](0022-desk-connectivity-hybrid-webrtc.md) | Desk connectivity: the hybrid (gateway for control and signaling, one WebRTC connection per desk for all content) | Proposed | 2026-11-04 |
| [0023](0023-desk-data-channel-protocol.md) | Desk data-channel protocol: channels, framing, RPC and subscriptions, backpressure, resume | Proposed | 2026-11-04 |
| [0024](0024-guild-host-and-member-sync.md) | Guild host: the leader's Guild Desk hosts guild spaces; member Guild Desks are light replicas synced desk-to-desk | Superseded by 0080 | 2026-11-04 |
| [0025](0025-guild-desk-sizing.md) | Guild Desk sizing: lighter member class and host tiers by member count | Superseded by 0080 | 2026-11-04 |
| [0026](0026-idle-24-hour-rule.md) | Idle stop: the 24-hour rule, activity signals and wake | Proposed | 2026-11-04 |
| [0027](0027-always-on-cost-envelope.md) | Always-on cost envelope under flat pricing: plan at 730 h, contain CPU surplus, never throttle | Proposed | 2026-11-04 |
| [0028](0028-quality-bar-never-sluggish.md) | Quality bar: "never sluggish" budgets, enforced by a perf CI | Proposed | 2026-11-04 |
| [0029](0029-themes-light-dusk-dark.md) | Themes: Light, Dusk and Dark from one semantic token set shared by CSS and Konva | Proposed (amended by 0050: neutral Dusk whites) | 2026-11-04 |
| [0030](0030-browser-modes-local-minified-60fps-normal.md) | Browser modes: minified rendered locally by default, normal mode streamed at 60 fps | Proposed (amended by 0034: no intra refresh yet; by 0041) | 2026-11-04 |
| [0031](0031-waking-and-reconnecting-ux.md) | Waking and reconnecting UX: never block, show Platform's wake phases, capture while waking | Proposed | 2026-11-04 |
| [0032](0032-owners-desk-skeleton-hostname-and-rollout.md) | The owner's desk: walking skeleton at `office.` (renamed from `desk.`), no personal subdomains, fast rollout | Accepted for the owner's desk | 2026-11-05 |
| [0033](0033-normal-mode-stream-profiles-and-member-desk-size.md) | Normal-mode stream profiles and member desk size | Proposed; B12 met on the real stack, member size awaits the owner | 2026-11-05 |
| [0034](0034-desk-media-path.md) | Desk media path: `desk-stream` as its own user, RTP over a Unix socket, `yuvconv` NV12 capture (amends 0008, 0030) | Accepted for the owner's desk (amended by 0037: one capture clock, sender reports, smaller audio buffers) | 2026-11-05 |
| [0035](0035-browser-session-is-carried-over.md) | A desk's browser session is carried over, wherever the desk is hosted | Accepted | 2026-11-06 |
| [0036](0036-per-desk-outbound-throttle.md) | A per-desk outbound throttle, so the cost guard's stop is the last resort | Proposed | 2026-11-06 |
| [0037](0037-sound-and-picture-sync.md) | Sound and picture: one capture clock, and the picture waits for the sound only while a member watches (amends 0034) | Proposed; live: `desk-rtc` 0.3.2 and `desk-stream` 0.2.3 on the owner's desk and in image 0.2.5, the Desk app's picture hold in prod since `2f84a7b` | 2026-11-06 |
| [0038](0038-sound-in-a-hidden-tab.md) | Sound in a hidden tab: the stream stays live while the desk plays sound | Proposed; live in the Desk app in prod since `8c30114`. Its `desk-rtc` `PICTURE` event (point 7) isn't built | 2026-11-06 |
| [0039](0039-stream-quality-levels.md) | Stream quality levels: Low, Medium, High and Max, an account default and per-app overrides | Proposed | 2026-11-06 |
| [0040](0040-desk-services-spring-boot-docker.md) | Desk services: Java 21, Spring Boot, Docker (supersedes 0006) | Accepted | 2026-11-05 |
| [0041](0041-deskd-drives-cdp-directly.md) | deskd drives CDP directly: no Playwright, fixed RPCs only | Accepted | 2026-11-05 |
| [0042](0042-llm-keys-sealed-on-the-desk.md) | LLM keys are sealed on the member's desk | Accepted | 2026-11-07 |
| [0043](0043-agent-limits-local-time-and-platform-prices.md) | Agent limits: the member's local time, desk over account, and the Platform's prices | Accepted | 2026-11-07 |
| [0044](0044-notebook-service-hocuspocus-on-node.md) | Notebook's service: Hocuspocus on Node, its own container, nothing lost across a restart | Accepted | 2026-11-07 |
| [0045](0045-unseen-desks-freeze.md) | A desk nobody looks at encodes nothing, and its Chromium freezes (amends design §6.1 and §11.5; the freeze is the kernel's cgroup freezer, written by `desk-units`, not `systemctl freeze`: `desk-runtime.md` §8.3) | Accepted; `deskd`'s part merged, the image's on `main`, baked into image 0.3.0 | 2026-11-07 |
| [0046](0046-minified-stage-a.md) | The simplified view's desk side, Stage A | Proposed | 2026-11-07 |
| [0048](0048-files-app.md) | Files app: a Dropbox-like window onto the desk's own drive | Accepted | 2026-11-08 |
| [0050](0050-dusk-neutral-whites.md) | Dusk uses neutral whites, not warm off-white | Accepted for the owner's desk | 2026-11-05 |
| [0051](0051-bandwidth-circle-and-streamed-app-pause.md) | The bandwidth circle, and the Browser pausing at a limit | Proposed | 2026-11-06 |
| [0060](0060-brand-kit.md) | Brand: adopt the owner's brand kit | Accepted | 2026-11-05 |
| [0061](0061-full-logo-jost-caps.md) | Full logo: the name in Jost capitals | Accepted | 2026-11-05 |
| [0062](0062-desk-surface-etched-name-and-cleanup.md) | The desk's surface: etched name, cleanup, and nothing else unless there's a problem | Accepted | 2026-11-05 |
| [0063](0063-your-office-and-desk-team.md) | Members call the app "your office", and one desk's agents are its "desk team" | Accepted | 2026-11-05 |
| [0064](0064-desk-stacking-hidden-items-and-etch.md) | Desks: apps can stack, a hidden count, and a deeper etch at constant size | Accepted | 2026-11-05 |
| [0065](0065-apps-use-kit-colors-and-nunito.md) | The apps use the kit's colors and Nunito | Accepted | 2026-11-05 |
| [0066](0066-the-ribbon-mark.md) | The logo is the ribbon M. Amends 0060 and 0061 | Accepted | 2026-11-05 |
| [0067](0067-maia-two-strand-hair.md) | Maia's look is version 7: two strands of hair | Accepted | 2026-11-06 |
| [0068](0068-one-app-icon.md) | One app icon: the white-ribbon mark on a light tile | Accepted | 2026-11-06 |
| [0070](0070-agent-outbound-filter.md) | The Agent reaches only the providers' names: a small filter on TLS SNI and DNS | Proposed | 2026-11-07 |
| [0071](0071-shared-desk-hosts-four-per-c7g-xlarge.md) | Shared desk hosts: 4 desks per `c7g.xlarge`, as a setting | Accepted | 2026-11-07 |
| [0072](0072-shared-desk-hosts-host-side.md) | Shared desk hosts, the host side: what runs in each desk's container, identity on the self-hosted model, a volume and a public IPv4 per desk, stop and wake, bytes per desk, moves | Proposed; Platform's section to come | 2026-11-07 |
| [0073](0073-desk-stream-encodes-only-what-changes.md) | `desk-stream` encodes only what changes (XDamage capture), and holds 30 fps under contention by lowering resolution, then quality | Proposed | 2026-11-07 |
| [0075](0075-video-islands-crop-the-one-encoder.md) | Video islands: the one encoder crops to the player, and input follows the crop | Proposed | 2026-11-07 |
| [0076](0076-browser-ad-and-tracker-blocking.md) | The desk Browser blocks ads and trackers with its own extension: uBlock Origin Lite's pinned lists, network rules only, on by default, with a per-site off switch and a kill switch | Proposed | 2026-11-07 |
| [0047](0047-multi-agent-desks.md) | Many agents on a desk, each its own app, set up by the lead agent: proposals the member confirms, opt-in messaging with hard limits, a workspace and timers per agent | Proposed | 2026-11-08 |
| [0080](0080-guild-shared-desk.md) | A guild is one shared desk on its own server, up to 200 members; guild chat in Commons channels; join by request or invite | Accepted (supersedes 0024, 0025) | 2026-11-07 |

Numbers to use next, so sessions don't collide: System Engineer 0070–0079, Desk Engineer 0041–0049, UI/UX Engineer 0051–0059, Product Designer 0061–0069, Guild Engineer 0080–0089. Write the ADR file yourself and ask the System Engineer to add the index row.

## Template
```markdown
# NNNN. Title

**Status:** Proposed | Accepted | Superseded by NNNN
**Date:** YYYY-MM-DD

## Context
Why a decision is needed; constraints and forces.

## Decision
What we decided.

## Consequences
What becomes easier or harder as a result.
```
