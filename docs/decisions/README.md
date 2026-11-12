# Architecture decision records

One file per decision: `NNNN-short-title.md`, numbered in order. Never edit an accepted ADR's decision; supersede it with a new one and update both statuses.

**How to read the Status column (checked against each file, 2026-11-11).** The status is the file's own. An ADR is Accepted only where its file says the owner (or, where the file says so, the Lead) accepted it; everything marked Proposed still waits for the owner's approval of the design. After the status, a short note says what is built, with the release or image that carries it. "Image 0.x.y" is the desk image (`image/RELEASES.md`); "host 0.1.x" is the shared-host image (`image/host/RELEASES.md`).

## Index
| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-separate-repo-and-aws-boundary.md) | Separate repo and AWS boundary | Accepted | 2026-11-04 |
| [0002](0002-web-app-react-konva.md) | Desk is a web app (React + Konva), not Tauri/native | Proposed. Built: the Desk app at `office.` (`web/`) | 2026-11-04 |
| [0003](0003-canvas-interaction-model.md) | Canvas interaction model: scope filter, cell-grid desks, per-desk windows, Arrange mode | Proposed (Arrange mode replaced by Cleanup, 0062; the scope filter accepted as Q6, [ADR 0096](0096-scope-is-a-filter.md)). Built in the Desk app | 2026-11-04 |
| [0004](0004-canvas-rendering-and-accessibility.md) | Canvas rendering, accessibility and visual tokens | Proposed (amended by 0028, 0029, 0065) | 2026-11-04 |
| [0005](0005-client-state-and-storage.md) | Client state and storage: layout doc in Platform, desk content in memory only | Proposed. Built: the layout doc on Platform | 2026-11-04 |
| [0006](0006-desk-daemon-node-sqlite.md) | Desk daemon (deskd): Node 24 + TypeScript, SQLite per app | Superseded by 0040 | 2026-11-04 |
| [0007](0007-desk-image-debian-arm64.md) | Desk image: Debian 13 arm64, recipe in ma-desk, built and rolled out by Platform | Proposed (amended by 0022; images are baked by the System Engineer under 0032, not Platform's pipeline). Built: images 0.1.0 to 0.3.3 | 2026-11-04 |
| [0008](0008-browser-streaming-webrtc-neko.md) | Browser streaming: WebRTC via Neko v3, CDP screencast as compat fallback | Proposed (amended by 0022, 0030: desk-rtc, 60 fps, TURN replaces compat; by 0034 and 0073: `desk-stream`'s capture). Built: `desk-rtc` and `desk-stream`, modeled on Neko, with none of its code | 2026-11-04 |
| [0009](0009-browser-process-model.md) | Browser process model: sandboxed kiosk Chromium, Playwright over local CDP, separate agent context | Proposed (amended by 0022; by 0041: CDP directly, no Playwright). Built: the kiosk Chromium | 2026-11-04 |
| [0010](0010-desk-connectivity-and-auth.md) | Desk connectivity and auth: direct TLS to the desk VM, Platform desk tokens, per-desk role | Superseded by 0022 | 2026-11-04 |
| [0011](0011-desk-data-location-and-privacy.md) | Desk data location and privacy posture | Proposed (amended by 0022, 0024; the claim is 0074) | 2026-11-04 |
| [0012](0012-llm-keys-desk-encrypted-envelopes.md) | LLM provider keys: desk-encrypted KMS envelopes, Platform-blind | Superseded by 0042 | 2026-11-04 |
| [0013](0013-idle-stop-and-wake.md) | Idle-stop and wake: Platform decides, Desk supplies activity signals | Superseded by 0026 | 2026-11-04 |
| [0014](0014-minimum-instance-t4g-medium.md) | Minimum instance for primary desks: t4g.medium, provisional until a benchmark gate | Proposed (amended by 0025, 0027, 0028, 0033). The owner's desk runs `c7g.large`, the Alliance desk `t4g.medium`; shared hosts are 0071 | 2026-11-04 |
| [0015](0015-notebook-editor-tiptap-yjs.md) | Notebook editor: TipTap 3 with Yjs (Hocuspocus) sync and versioned history | Proposed (amended by 0023; its server half decided by 0044). Built: the Notebook app and `desk-notebook` | 2026-11-04 |
| [0016](0016-chat-channels-and-delivery.md) | Chat model: channels, medium separate from author, default = last medium received | Proposed. Not built (guild chat is Commons', 0080) | 2026-11-04 |
| [0017](0017-sealed-relay-desk-to-desk.md) | Desk-to-desk messaging through a sealed Platform relay | Proposed (amended by 0022, 0024). Not built: Platform's `relay.md` is a stub for contract 0.4.0 | 2026-11-04 |
| [0018](0018-agent-framework-ai-sdk.md) | Agent framework: AI SDK Core with thin custom orchestration | Proposed, superseded in part by 0040: `desk-agent` is Java with thin provider clients, and the AI SDK isn't used | 2026-11-04 |
| [0019](0019-agent-safety-policy-point.md) | Agent safety: deskd as the single policy point, sandboxed runtime, confirmed egress, audit log | Proposed (amended by 0040) | 2026-11-04 |
| [0020](0020-agent-runs-and-usage-limits.md) | Agent runs and usage limits enforced on the desk | Proposed (amended by 0026, 0043). Built: the limits in `desk-agent` | 2026-11-04 |
| [0021](0021-minified-websites-structure-based.md) | Minified websites: built from page structure, staged, no generative pixels | Proposed (amended by 0028, 0030, 0041). Stage A built (0046) | 2026-11-04 |
| [0022](0022-desk-connectivity-hybrid-webrtc.md) | Desk connectivity: the hybrid (Platform gateway for control and signaling, one WebRTC connection per desk for all content) | Proposed. Built on every desk | 2026-11-04 |
| [0023](0023-desk-data-channel-protocol.md) | Desk data-channel protocol: channels, framing, RPC and subscriptions, backpressure, resume | Proposed. Built: `desk-rtc` and `deskd` (`docs/interfaces/desk-runtime.md` §4) | 2026-11-04 |
| [0024](0024-guild-host-and-member-sync.md) | Guild host: the leader's Guild Desk hosts guild spaces; member Guild Desks are light replicas synced desk-to-desk | Superseded by 0080 | 2026-11-04 |
| [0025](0025-guild-desk-sizing.md) | Guild Desk sizing: lighter member class and host tiers by member count (pending benchmark) | Superseded by 0080 | 2026-11-04 |
| [0026](0026-idle-24-hour-rule.md) | Idle stop: the 24-hour rule, activity signals and wake | Proposed. Built: Platform's sweeper. An Alliance desk stops after 20 idle minutes and a free desk after 30 (Platform's tiers). An open tab holds a session until 60 min hidden, or 2 h untouched on free and Alliance desks (24 h otherwise; ISS-64b) | 2026-11-04 |
| [0027](0027-always-on-cost-envelope.md) | Always-on cost envelope under flat pricing: plan at 730 h, contain CPU surplus on the desk, never throttle | Proposed | 2026-11-04 |
| [0028](0028-quality-bar-never-sluggish.md) | Quality bar: "never sluggish" budgets, enforced by a perf CI | Proposed. The perf CI isn't built; `e2e/` gates releases to the test desk | 2026-11-04 |
| [0029](0029-themes-light-dusk-dark.md) | Themes: Light, Dusk and Dark from one semantic token set shared by CSS and Konva | Proposed (amended by 0050: neutral Dusk whites; by 0093: Dusk is Zen). Built | 2026-11-04 |
| [0030](0030-browser-modes-local-minified-60fps-normal.md) | Browser modes: minified rendered locally by default, normal mode streamed at 60 fps | Proposed (amended by 0034: no intra refresh yet; by 0041). Built: normal mode, and the simplified view (0046) | 2026-11-04 |
| [0031](0031-waking-and-reconnecting-ux.md) | Waking and reconnecting UX: never block, show Platform's wake phases, capture while waking | Proposed. Built in the Desk app | 2026-11-04 |
| [0032](0032-owners-desk-skeleton-hostname-and-rollout.md) | The owner's desk: walking skeleton at `office.`, fast rollout | Accepted for the owner's desk | 2026-11-05 |
| [0033](0033-normal-mode-stream-profiles-and-member-desk-size.md) | Normal-mode stream profiles and member desk size | Proposed; B12 met on the real stack, the member desk's size awaits the owner | 2026-11-05 |
| [0034](0034-desk-media-path.md) | Desk media path: `desk-stream` as its own user, RTP over a Unix socket | Accepted for the owner's desk (amended by 0037: one capture clock; by 0073: XDamage capture). Built: every image from 0.2.2 | 2026-11-05 |
| [0035](0035-browser-session-is-carried-over.md) | A desk's browser session is carried over, wherever the desk is hosted | Accepted (the owner). Built: the downgrade refusal and the volume record (image 0.2.3 on); a root swap carries the session (image 0.3.3's record) | 2026-11-06 |
| [0036](0036-per-desk-outbound-throttle.md) | A per-desk outbound throttle, so the cost guard's stop is the last resort | Proposed. The desk's half is in every image from 0.2.4, and a shared host's per-slot shaper is built for host 0.1.11 (TD-223, not baked); Platform's half isn't built | 2026-11-06 |
| [0037](0037-sound-and-picture-sync.md) | Sound and picture: one capture clock, and the picture waits for the sound only while a member watches | Proposed. Built: `desk-rtc` 0.3.2 and `desk-stream` 0.2.3 on (every image from 0.2.5), and the Desk app's picture hold | 2026-11-06 |
| [0038](0038-sound-in-a-hidden-tab.md) | Sound in a hidden tab: the stream stays live while the desk plays sound | Proposed. Built in the Desk app; its `desk-rtc` `PICTURE` event (point 7) isn't | 2026-11-06 |
| [0039](0039-stream-quality-levels.md) | Stream quality levels: Low, Medium, High and Max, an account default and per-app overrides | Proposed. Built: the desk's half (every image from 0.2.6) and Platform's setting (contract 0.3.16) | 2026-11-06 |
| [0040](0040-desk-services-spring-boot-docker.md) | Desk services: Java 21, Spring Boot, Docker | Accepted (supersedes 0006). Built: `deskd` and `desk-agent` | 2026-11-05 |
| [0041](0041-deskd-drives-cdp-directly.md) | deskd drives CDP directly | Accepted. Built | 2026-11-05 |
| [0042](0042-llm-keys-sealed-on-the-desk.md) | LLM keys are sealed on the member's desk | Accepted. Built in `desk-agent` | 2026-11-07 |
| [0043](0043-agent-limits-local-time-and-platform-prices.md) | Agent limits: the member's local time, desk over account, and the Platform's prices | Accepted. Built in `desk-agent` and `deskd` | 2026-11-07 |
| [0044](0044-notebook-service-hocuspocus-on-node.md) | Notebook's service: Hocuspocus on Node, its own container, nothing lost across a restart | Accepted. Built: `desk-notebook`, every image from 0.2.8 | 2026-11-07 |
| [0045](0045-unseen-desks-freeze.md) | A desk nobody looks at encodes nothing, and its Chromium freezes | Accepted (the owner). Built: every image from 0.3.0 (`docs/interfaces/desk-runtime.md` §8.3) | 2026-11-07 |
| [0046](0046-minified-stage-a.md) | The simplified view's desk side, Stage A | Proposed. Built: in image 0.3.3's `deskd` | 2026-11-07 |
| [0047](0047-multi-agent-desks.md) | Many agents on a desk, each its own app, set up by the lead agent | Proposed. Built: in image 0.3.3's `desk-agent` | 2026-11-08 |
| [0048](0048-files-app.md) | Files app: a Dropbox-like window onto the desk's own drive | Accepted (Lead decisions, 2026-11-08). Built: image 0.3.3's `deskd`; `/data/files` from image 0.3.2 | 2026-11-08 |
| [0049](0049-agent-attachments.md) | Files attached to an agent message are held in memory for one answer and then removed | Proposed. Built: in image 0.3.3's `desk-agent` | 2026-11-09 |
| [0050](0050-dusk-neutral-whites.md) | Dusk uses neutral whites, not warm off-white | Accepted for the owner's desk (amended by 0093: Zen's text is warm linen) | 2026-11-05 |
| [0051](0051-bandwidth-circle-and-streamed-app-pause.md) | The bandwidth circle, and the Browser pausing at a limit | Proposed | 2026-11-06 |
| [0052](0052-account-settings-modal.md) | Account settings is a full-screen modal over the office, framing the Platform account page beside "Your data" | Accepted (the owner's order) | 2026-11-09 |
| [0053](0053-open-tiles.md) | Open tiles: an app enlarged on its desk is the live app there | Accepted (the owner's ask; the calls are the UI/UX Engineer's). Amends 0062 and 0064 | 2026-11-11 |
| [0054](0054-desk-app-host.md) | The desk app host: the Apps sheet, one tap to add, and the sandboxed window | Proposed (the UI/UX Engineer's half of launch row S-97) | 2026-11-11 |
| [0060](0060-brand-kit.md) | Brand: adopt the owner's brand kit | Accepted (lockups amended by 0061; the mark replaced by 0066) | 2026-11-05 |
| [0061](0061-full-logo-jost-caps.md) | Full logo: the name in Jost capitals | Accepted (the mark inside it replaced by 0066) | 2026-11-05 |
| [0062](0062-desk-surface-etched-name-and-cleanup.md) | The desk's surface: etched name, cleanup, and nothing else unless there's a problem | Accepted | 2026-11-05 |
| [0063](0063-your-office-and-desk-team.md) | Members call the app "your office", and one desk's agents are its "desk team" | Accepted | 2026-11-05 |
| [0064](0064-desk-stacking-hidden-items-and-etch.md) | Desks: apps can stack, a hidden count, and a deeper etch at constant size | Accepted | 2026-11-05 |
| [0065](0065-apps-use-kit-colors-and-nunito.md) | The apps use the kit's colors and Nunito | Accepted | 2026-11-05 |
| [0066](0066-the-ribbon-mark.md) | The logo is the ribbon M | Accepted (amends 0060, 0061) | 2026-11-05 |
| [0067](0067-maia-two-strand-hair.md) | Maia's look is version 7: two strands of hair | Accepted | 2026-11-06 |
| [0068](0068-one-app-icon.md) | One app icon: the white-ribbon mark on a light tile | Accepted | 2026-11-06 |
| [0070](0070-agent-outbound-filter.md) | The Agent reaches only the providers' names: a small filter on TLS SNI and DNS | Proposed. Built: `desk-agent-filter` 0.1.1, every image from 0.2.9 | 2026-11-07 |
| [0071](0071-shared-desk-hosts-four-per-c7g-xlarge.md) | Shared desk hosts: 4 desks per `c7g.xlarge` | Accepted (the owner). The setting's seed is now 6 per `m7g.xlarge` (`ma-platform` ADR 0101's addendum). No member is on a shared host yet | 2026-11-07 |
| [0072](0072-shared-desk-hosts-host-side.md) | Shared desk hosts: the host side | Proposed. Built: test bakes to host 0.1.10, on staging's soak; nothing for members | 2026-11-07 |
| [0073](0073-desk-stream-encodes-only-what-changes.md) | `desk-stream` encodes only what changes, and holds 30 fps under contention | Proposed. Built: `desk-stream` 0.3.0 to 0.3.3, in every image from 0.3.0 | 2026-11-07 |
| [0074](0074-privacy-claim-operator-blind-and-audited.md) | The privacy claim is "operator-blind by design, and audited", never "zero-knowledge" | Accepted (the owner, design Q2). Built: content and keys stay on the desk, and a CloudTrail trail; alarms and the member's access history aren't | 2026-11-11 |
| [0075](0075-video-islands-crop-the-one-encoder.md) | Video islands: the one encoder crops to the player, and input follows the crop | Proposed. Built: `desk-stream` 0.3.2 and `desk-rtc` 0.3.7 on, in every image from 0.3.0. `deskd`'s half isn't, so no member's desk shows an island | 2026-11-07 |
| [0076](0076-browser-ad-and-tracker-blocking.md) | The desk Browser blocks ads and trackers with its own extension: uBlock Origin Lite's pinned lists, network rules only, on by default, with a per-site off switch and a kill switch | Proposed. Built: on in every image from 0.3.0 | 2026-11-07 |
| [0077](0077-shared-host-desk-updates.md) | Shared-host desks take Debian's security updates from template generations built once and fetched, signed, by each host | Proposed. Being built (`sub/u77-host`, `sub/u77-builder`) | 2026-11-10 |
| [0078](0078-service-releases-on-shared-hosts.md) | Shared-host desks take the same signed service batches as desks of their own: unpacked once into each host's release store, switched live in each slot at idle | Proposed. Built on `sub/host-batches` (lab only; the live switch off until the Security Analyst's read; host 0.1.12, not baked) | 2026-11-11 |
| [0079](0079-each-desk-has-its-own-chat-address.md) | Each desk has its own chat address | Accepted (the owner, design Q3; its guild half changed by 0080). Not built | 2026-11-11 |
| [0080](0080-guild-shared-desk.md) | A guild is one shared desk on its own server, up to 200 members | Accepted (supersedes 0024, 0025). Built: the Guild Desk kind (image 0.3.0 on) and `commons-server` (image 0.3.1 on) | 2026-11-07 |
| [0090](0090-free-tier-desk.md) | The free tier on the desk: Browser time a day, a Files cap, limits that change live | Proposed. Built: in image 0.3.3's `deskd`; Platform's free tier waits for shared hosts. Amended by ISS-64b (a visible tab lets go after 2 h untouched) | 2026-11-09 |
| [0091](0091-notebook-colors.md) | Notebook colors: the tabs' six names in the page, labels in the page row | Proposed. Built in the Notebook app | 2026-11-10 |
| [0092](0092-browser-downloads-and-tab-order.md) | The Browser says when a download starts and ends, and keeps its tab order across a stop and a wake | Proposed. Built on `sub/ls-31-36` | 2026-11-10 |
| [0093](0093-zen-theme.md) | Dusk becomes Zen: the name, a natural palette, natural desk textures | Accepted (the owner; amends 0029, 0050) | 2026-11-10 |
| [0094](0094-office-backgrounds.md) | Office backgrounds | Proposed. Built in the Desk app | 2026-11-10 |

### Drafts, not numbered yet
| Draft | Title | Status | Date |
|---|---|---|---|
| [0095](0095-notebook-tabs-are-binder-sections.md) | Notebook tabs are section dividers: notebooks, then tabs, then pages, shown as a binder | Accepted (the owner, design Q5). Built in the Notebook app | 2026-11-11 |
| [0096](0096-scope-is-a-filter.md) | A scope is a filter: Personal, Work and Guild hide the other desks and their badges | Accepted (the owner, design Q6). Built, but for the cross-scope dot | 2026-11-11 |
| [agent tools](draft-agent-tools-approvals.md) | The Agent's tools and approvals at launch | Proposed (draft; the Desk range is full) | 2026-11-11 |
| [desk app contract](draft-desk-app-contract.md) | The desk app contract: what any app must meet to run on a desk | Draft. Its section 13, updates by signed batches, is built on the desk (image 0.3.2 on; `docs/interfaces/desk-runtime.md` §6.1) | 2026-11-06 |
| [export and transfer](draft-data-export-and-transfer.md) | Download all my data, and move my desk to my own hardware | Draft. The desk's half is built (`desk-data`, image 0.2.6 on) | 2026-11-06 |
| [self-hosted desk](draft-self-hosted-desk.md) | A self-hosted desk is the cloud desk's software on amd64 Debian 13, with a stand-in for the metadata service | Proposed (draft). Built: `selfhost/`; Platform's side is staging only | 2026-11-06 |
| [office fast start](draft-office-fast-start.md) | The office draws what it last drew, at once (stale-while-revalidate) | Draft | 2026-11-10 |

Numbers to use next, so sessions don't collide: System Engineer 0070–0079 (**full**), then **0095–0109**, Desk Engineer 0041–0049 (**full**), then **0110–0119**, UI/UX Engineer 0051–0059, Product Designer 0061–0069, Guild Engineer 0080–0089. 0090–0094 were taken by several sessions without a range; ask the System Engineer before using 0120 or later. Write the ADR file yourself and ask the System Engineer to add the index row.

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
