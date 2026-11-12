# 0036. A per-desk outbound throttle, so the cost guard's stop is the last resort

**Status:** Proposed (TD-223, T57). The on-desk half is in every image from `ma-desk-0.2.4` (`image/RELEASES.md`): the test desk, the owner's desk since it took 0.2.6, and every desk new from staging's and prod's `desk_image#current`, 0.2.9 since 2026-11-07. **Section 6's test 1, video through the shaper, didn't run before it reached them,** against "before anything reaches a member desk"; section 8's lab and `verify.sh` section 3d are all that's proven, so the first real profile change through a real `desk-rtc` happens live, when a desk passes 100 GB. *(2026-11-11: test 1's profile part has run through a real `desk-rtc` on a staging test desk, page fps never under 58.9 and a 233 to 250 ms pause per switch, and it found a `desk-stream` start bug, fixed in 0.3.5; the clamp now counts `desk-rtc` alone and the day lines look ahead. Addendum of that date.)* *(2026-11-11: tests 1, 2 and 4 have now run on a desk of its own, on `ma-desk-0.3.3`. Test 1's kiosk-saturating row fails its CPU rule by 1.2 to 1.4 points and everything else passes; on a shared host the tests still wait for the per-desk shaper. Results are under the addendum of 2026-11-09.)* The guard's half (`fast` at 20 GB, the 7 and 140 GB flags) isn't built in `ma-platform`, so nothing reports the shaper's state. ADR 0082's stops stay live. *(2026-11-11: test 1 on a shared host ran in part on host 0.1.11, six shaped slots: R0 to R3 in full and one repeat of R4; the picture, B12, B13 and loss held in every row, the flooders held their ceilings, and the viewer's `desk-stream` CPU failed its 1-point rule in R1 (+1.1) and R4 (+4.1); R5 not run. Result under the addendum of 2026-11-09.)* For launch it leaves out `deskd`'s `egress` field, the panel line and the "slowed" flag. *(Status updated 2026-11-07 from the weekend review; it said "not baked and on no desk".)*
**Date:** 2026-11-06

## Context
The owner: "Yes but there must be a way to throttle to prevent excessive outbound in the first place. E stopping should be the last resort if a bug or hack somehow broke through".

Binding: 60 fps and low latency are never traded for bandwidth. The platform can't see or relay member traffic. No usage charges; past 100 GB a month the browser view drops in quality. Marks: **[M]** measured, **[R]** read, **[A]** assumed, for section 6's test to prove unless it says otherwise. Sums are mine. GB is 10^9 bytes, as the guard counts. Dollars are $0.09/GB, before the account's shared free tier [R ADR 0082].

## Decision
**Recommendation:** `tc` HTB on the desk's network interface with `desk-rtc`'s packets in their own class, plus a small root process, `desk-egress`, for the budgets a kernel token bucket can't hold: a bucket on all non-stream traffic, and stream quality steps at 100 and 500 GB. The guard keeps its stops, moves `fast` to 20 GB, and gains flags that say the throttle isn't holding. It holds against everything below root, except that a broken `desk-rtc` can still reach `month`. Root removes it in one command, and then only the guard's stop stands, at the cost ADR 0082 already lists.

### 1. The numbers
| Guard rule [R source and the deployed Lambda, today] | As a sustained rate |
|---|---|
| `fast`: stop past 30 GB in 15 min | 267 Mbps |
| `day`: stop past 150 GB in 24 h | 13.9 Mbps |
| `month`: stop past 1,200 GB since the 1st, flag past 700 GB | 3.58 and 2.09 Mbps over 31 days (3.70 and 2.16 over 30) |

| Normal use | Mbps | GB/h | Source |
|---|---|---|---|
| Stream, typical browsing | 1.3 | 0.59 | [M] ADR 0033, on Neko; not repeated on the real stack |
| Stream, scrolling | 5.6 | 2.5 | [M] real-stack benchmark |
| Stream, real video | 4.5 to 7.1 | 2.04 (t4g, 1280x800) to 3.18 (c7g, 1080p) | [M] real-stack |
| Stream at its cap | 8.22 measured, 8.34 by sum | 3.70, and **3.75** used below | [M] ADR 0033; the sum is the 8 Mbps VBV, Opus and packet headers |
| Capped, then deep profile, at their caps | 4.21, 2.66 | 1.89, 1.20 (video 1.09 to 1.85, 0.74 [M]) | ADR 0033; both 60 fps |
| Four viewers at the cap, the session limit, with `bulk` | 41 | 18 | [R] `SessionManager`; `sched.go` holds `bulk` to 2 Mbps per viewer |
| The same at level `max` (12 Mbps VBV, task 29, after this table) | about 57 | about 26 | Sum, weekend review 2026-11-07: inside the 60 Mbps of 1:10, with far less room than 41 |
| A large upload from the Browser | Whatever the site takes | | No file path between member and desk yet (TD-213), so it's what is already there: at most the 8 GiB volume [R ADR 0082] |

No member use exists to learn from: the owner's desk has sent 0.02 GB and the test desk 0.39 GB since 5 Nov [M, CloudWatch today].

**Where they collide:**
- **`fast`: never.** The stream at its cap is 3% of it.
- **`day`: only beside a lot of other traffic.** The stream at its cap all day is 90 GB, which leaves 60 GB, or 5.55 Mbps, for everything else.
- **`month`: yes, with nothing broken.** The stream alone reaches 1,200 GB in 320 h at its cap (10.3 h every day of a 31-day month), or 377 to 588 h on real video (12.2 to 19 h a day). The flag comes at 187 to 343 h. A whole month at the cap is 2,790 GB. After `month`, every wake is stopped again within 5 minutes until the 1st [R ADR 0082]. No limit on other traffic can fix this. Only the stream's own rate can, and the product rule already lets its quality drop.
- **TURN: not built (ADR 0075).** ICE-TCP leaves `desk-rtc` from port 443, in the stream's class. When TURN returns, the desk's outbound doesn't change, but the relay is an instance under the guard, and two viewers at the cap through it reach `day` in 20 h. It needs its own limits first.

### 2. The mechanism
On `ens5` [R verify evidence], set by root before `desk-rtc` and `deskd` start. `fq_codel` keeps web requests and ACKs moving past a big upload.

| HTB class | Who | Rate and ceiling | Burst | Prio | Leaf |
|---|---|---|---|---|---|
| 1:10 | `desk-rtc`: uid 1101, from port 443 | 60 Mbps | 1 MB, as `burst` and `cburst` | 0 | `pfifo` |
| 1:15 | Root and `deskd`, uid 0 and 1100: SSM, heartbeat, gateway link | 2 Mbps | Default | 0 | `fq_codel` |
| 1:20, the default | Everything else: Chromium, the agent, DNS | 100 Mbps | 256 KB | 1 | `fq_codel` |

**Classification:** a new base chain in `image/recipe/files/etc/nftables.conf`, `type filter hook output priority -150`, with `meta skuid 1101 udp sport 443 meta priority set 1:10`, the same for TCP, and `meta skuid { 0, 1100 } meta priority set 1:15`. The output hook runs before the qdisc, and HTB takes a class straight from `skb->priority`, so no `tc filter` is needed [M section 8]. `deskd` shows as 1100: host network, fixed uids, Docker's iptables off [R runtime §1, `daemon.json`]. Nothing else can claim the stream's class: the kernel sets `skuid`, port 443 is privileged and held [R], and `SO_PRIORITY` above 6 needs `CAP_NET_ADMIN` [M section 8]. `desk-stream` only writes to a Unix socket [R].

**Why the stream is unaffected:**
- **It never waits for tokens.** 60 Mbps is above the 41 it can normally send, and 1 MB covers four viewers' keyframes at 150 KB each (VBV 1,200 kbit [R `stream.conf`]). Level `max` (task 29) came later: four viewers at it with `bulk` come to about 57 Mbps and 900 KB of keyframes, so it still fits, with little room (weekend review, 2026-11-07, by sum). The 1 MB has to be the ceiling's bucket too (`cburst`): with tc's default `cburst` of 1,600 bytes, 600 KB of keyframes left at 58 Mbps over 82 ms instead of in 4 ms [M section 8]. Rate equals ceiling on every class, so nothing borrows and no class depends on another's tokens.
- **Under contention it goes first.** Prio 0 is dequeued first, so a stream packet waits only for what's already on the NIC: one 64 KB segment at 5 Gbps is 105 µs. Call it under 1 ms [M section 8: at p99, not every packet], against a p50 of about 75 ms [M]. Contention is rare: 162 Mbps in all against baselines of 256 Mbps (t4g.medium) and 937 Mbps (c7g.large) [R `describe-instance-types`]. The shaper's own cost is microseconds a packet at about 900 packets a second [M section 8]. Section 6 decides, not these estimates.

**Why a process too.** An HTB or TBF bucket is a u32 count of 64 ns ticks, so it holds 275 s of the class's rate [R `tc_htb_opt`, `/proc/net/psched`; M section 8: tc caps a 1 Mbit class's burst at 34,359,738 bytes, 274.9 s]: 34 MB at 1 Mbps, 191 MB at 5.55 Mbps. `desk-egress` is about 120 lines of Python, as root. Every 60 s it reads `tc -j -s class show`, applies section 5's budgets, saves state in `/data/desk-egress` (root only; ext4's reserve lets it write to a full volume [R ADR 0082]) and puts the shaper back if it's gone.

**A profile change:** `desk-stream`'s `run` picks `stream-<profile>.conf`, and `desk-egress` writes `/run/desk-egress/profile` and calls `systemctl try-restart desk-stream`. The picture pauses about 0.3 to 0.4 s [M off-to-live 287 to 385 ms], two or three times a month at most.

**If it fails:** with `desk-egress` dead the ceilings stay, so `fast` holds and `day` and `month` fall to the guard. If the shaper won't load, `desk-rtc` still starts (`Wants`, not `Requires`), its `health` fails and `deskd` reports it. The throttle's own bug doesn't cut a member off, because the guard still stands.

### 3. A compromised desk
| Level | Can it remove the shaper? | What it can spend | What acts |
|---|---|---|---|
| Web content or a Chromium exploit, uid `kiosk` | No: no `CAP_NET_ADMIN`, sandbox on [R] | 40.8 GB, $3.67 on day one; 365 GB, $32.85 a month. Noise on screen raises the stream only while someone views, and only to its cap | The bucket. No stop. A flag once slowed 3 days |
| `deskd`, uid `desk` | No: `--cap-drop=ALL`, no-new-privileges; `units.sock` only starts and stops four units [R]. It can drive Chromium and lie in its heartbeat, so no traffic stop reads the heartbeat | The same bucket, the same $3.67 and $32.85 | The bucket. It can hide the slowed flag |
| `desk-rtc`, uid `rtc` | No: `CAP_NET_BIND_SERVICE` only [R]. But it's in the stream's class | 135 GB in 5 h, then 1 Mbps: 144 GB in any 24 h, $13 a day | `day` holds, flagged on day one. **`month` doesn't:** flag on day 5 ($63), stop on day 8.4 ($108). With the bucket saturated too it peaks at 153 GB and `day` stops it |
| Root, including a kernel exploit from any of those | Yes, one command. Everything on the desk is void, its reports too | Below | Only the guard |

**Root's spend.** `NetworkOut` is counted outside the guest [A; section 8 found it equal to the guest's own count to 0.0001%, which a box can't show is outside it], the desk role can't write tags or start instances [R contract §5.4, ADR 0082], and a stop ends it.

| Root's approach | GB | Dollars |
|---|---:|---:|
| Rush at 5 Gbps, the internet cap [R ADR 0082]: 15 min to detect + 6 min graceful (30 min if the sweep fails) | 788 (1,125) | $71 ($101) |
| Rush at the baseline for 21 min: c7g.large 0.937 Gbps, t4g.medium 0.256 Gbps (5 Gbps only while burst credits last) | 148, 40 | $13.28, $3.63 |
| Paced under every limit, for a month | 1,200 | $108, flagged at 700 GB ($63) |
| Each member wake of a desk past a limit [R ADR 0082]. It can't wake itself; nothing limits the member's click until an operator holds it (TD-218) | 35 to 410 | $3 to $37 |

15 minutes is ADR 0082's design bound, not a measurement (two samples: 35 s and 78 s). A guest ignoring the shutdown signal adds "a few minutes" until AWS forces it [R AWS docs], at $3.38 a minute at 5 Gbps. **The throttle lowers none of the rush figures at 5 Gbps,** because the reading's lag sets them, not the limit.

**What the guard adds, on its existing data:**
- **`fast` from 30 to 20 GB,** just above the 18.2 GB that 162 Mbps allows. It catches 178 to 267 Mbps, which today only `day` catches, after 75 to 112 minutes: at 256 Mbps, about 40 GB and $3.63 instead of 150 GB and $13.50. It's safe on an unshaped box, since it takes 178 Mbps for 15 minutes.
- **Two flags that mean "the throttle isn't holding":** any 5-minute bucket over 7 GB (the ceiling is 6.1) and 24 h over 140 GB (an honest viewer stays at or under 131).

**What the outer layers can't do:** rate-limit. AWS offers no outbound rate per instance [A]. The guard sees one total per instance, in 5-minute buckets, minutes late, and can't tell a stream from an attack. All it can do is flag or stop. Section 7 says why a security group doesn't change this.

### 4. What a member sees
| When | What they see |
|---|---|
| Browsing and video, under 100 GB this month | Nothing, ever |
| Uploads inside the bucket | The site's own progress, up to 100 Mbps: 1 GB in 80 s, a full 8 GiB volume in 11.5 min, 30 GB in 40 min |
| Bucket empty | Uploads crawl (1 GB in 3 h). Video is untouched. Pages still load, a little slower: four real pages took 0.3 to 2.9 s against 0.2 to 0.8 s, and a DNS lookup or a new connection waits about 50 ms behind an upload [M section 8]. Downloads aren't held to 30 Mbps by their ACKs, as this said [A]: 206 to 284 Mbps at a 30 ms round trip, 76 with an upload running [M section 8]. Not for launch: one line in the desk panel, "Uploads from this desk are slowed. Full speed again in about 2 hours." |
| Past 100 GB, then 500 GB, until the 1st | A softer picture at the same 60 fps, after one short pause. Capped text isn't distinguishable at 1:1 [M ADR 0033]. Deep is a smaller encode, upscaled |

**Does normal use trigger it?** The bucket needs more than 3.5 full volumes of outbound, and a full volume every day never empties it, because the 10.8 GB refill covers it. The ACKs for 40 Mbps of inbound video fit inside the refill too, at 0.6 to 0.7 Mbps of the 1 Mbps over TCP [M section 8; QUIC not measured], and the stream doesn't count. Reaching 100 GB is the product rule working, not a false throttle: 8 h a day of typical browsing gets there around day 18 to 21. **A false stop:** one honest viewer can't reach any stop limit (131 GB a day, 1,127 GB a month). Two viewers nonstop for 17 days can, and that's accepted. The Terms state this as a standing limit, with the 24-hour notice kept for stops (TD-220), so a slowdown sends no notice.

### 5. The order of layers
| # | Layer | Fires at | Does | Holds |
|---|---|---|---|---|
| 1 | Classes and ceilings, in the kernel | Always | Video first, 162 Mbps in all | `fast`: 18.2 GB in 15 min at most |
| 2 | Bucket, `desk-egress` | 30 GB of 1:15 and 1:20 used. Refills at 1 Mbps, 10.8 GB a day. Reopens with 1 GB back, about 2 h idle | 1:20 to 0.75 Mbps, 1:15 to 0.25 Mbps | Non-stream at 30 GB + 10.8 GB a day, whatever runs |
| 3 | Stream step, `desk-egress` | 100 GB this month or in 24 h | Capped profile | The product rule |
| 4 | Stream step, `desk-egress` | 500 GB this month, or 120 GB in 24 h until under 100 | Deep profile | `month` for one viewer, `day` for two |
| 5 | `desk-rtc` clamp, `desk-egress` | 135 GB in 24 h, until under 120 | 1:10 to 1 Mbps | `day` if `desk-rtc` itself is broken |
| 6 | Flags, the guard | A 5-minute bucket over 7 GB, 24 h over 140 GB, slowed for 3 days; 700 GB this month, as today | Ticket | |
| 7 | Stops, the guard | `fast` 20 GB, `day` 150 GB, `month` 1,200 GB | The last resort | |

**Simulated by the minute over 31 days at the hard caps** (the month column ignores the stop):

| Case | Peak 15 min | Peak 24 h | Month | Result |
|---|---:|---:|---:|---|
| Video 8 h a day | 0.9 GB | 31 GB | 527 GB | Nothing fires |
| One viewer nonstop | 0.9 GB | 91 GB | 1,127 GB | Flag, day 16.5. No stop |
| Non-stream saturated, nobody viewing | 11.3 GB | 40 GB | 364 GB | Nothing fires |
| One viewer nonstop, non-stream saturated | 12.2 GB | 117 GB | 1,417 GB | **`month` stop, day 25.5** |
| Two viewers nonstop | 1.9 GB | 133 GB | 2,010 GB | **`month` stop, day 17** |

### 6. The build
It fits the next bake: no new packages, since `tc` comes with the `iproute2` that `ss` already uses in verify evidence [R], and `nft` and `python3` are there [R]. `sch_htb` and `sch_fq_codel` are in Debian's cloud kernel [M section 8], and `build.sh` and `verify.sh` fail the bake if they don't load. The image holds the unit and a release `build.sh` bakes from the recipe, so fixes ship by `ma-update` without a bake [R runtime §6]. The capped and deep confs are in `desk-stream`'s release, which the image now takes from `releases.pin`: the launch bake needs a `desk-stream` release packed from this recipe, published, passed on the test desk and pinned, or `build.sh` refuses (section 8).

| Owner | What | Agent hours |
|---|---|---:|
| System Engineer | Image: `classify` chain, `desk-egress.service`, `verify.sh`. `desk-egress`, its tests on a fake clock, `/etc/ma/egress.conf`. `desk-stream` release: capped and deep confs. The test below, the runtime spec | 6 |
| Desk Engineer | Not for launch: `deskd` reads `/run/desk/egress.json`: `egress {level, since}` in the heartbeat and `desk.status.get` | 1 |
| UI/UX Engineer | Not for launch: the desk panel's one line | 1 |
| Platform Engineer | Guard: the `fast` dial and three flags. `services/desks` keeps the field, as with `data_volume`. Contract, ADR 0082 addendum, runbook | 2.5 |
| **Total** | The only floor is one bake, about 20 min, shared with the launch image | **10.5** |

**Running cost:** $0. No new AWS resource and no new paid service. `desk-egress` is about 13 MB and 0.005% of a core [M section 8], at most about $0.06 a month on a t4g already past its credits. The guard's query doesn't change. The test costs about $2.

**The test,** before anything reaches a member desk, and then `e2e/` on the test desk as for any change:
1. **Video unchanged** *(for a desk of its own as written; for shared hosts see the addendum of 2026-11-09, "Test 1 on a shared host")*, on `Purpose=browser-benchmark` boxes with `spikes/browser-bench/real-stack/`, c7g.large at 1080p and t4g.medium if W3 picks it. Rows: no shaper; shaper idle; shaper with `kiosk` saturating 100 Mbps; bucket empty with an upload running. 3 repeats each. Pass: page fps within 0.5 of the first row; B12 p50 within 3 ms of it and inside budget (repeats vary by up to 6 ms [M], so nothing finer can be claimed); B13 in budget; zero drops on 1:10 and `rtpDropped` 0; CPU within 1 point.
2. **Profiles and counters:** capped and deep at the real size, since capped was never run on c7g and deep never on the real stack [R benchmark §5, §9]. Each class holds its ceiling; `tc` bytes against `NetworkOut` within 5% over 10 GB.
3. **Threats:** as `kiosk`, `desk` and `rtc`, `tc`, `nft`, `SO_PRIORITY` 0x10010 and binding 443 are each refused. As root on a `DeskKind=test` desk: delete the shaper, send past the ceiling, see the flag, then the stop through `CostGuardTestLimitGb` *(built; addendum of 2026-11-09, "Test 3, the root part")*. Time a guest that ignores the shutdown signal.
4. **Budgets, with lowered thresholds in `egress.conf`:** bucket empties and reopens; a real page load with it empty; state survives a reboot and a stop and wake; month rollover; `desk-stream` restarted during a live session recovers.

### 7. Rejected
- **A flat limit with the kernel's burst only.** Holds `fast`. It holds `day` only at 5.55 Mbps with 191 MB of burst: 1 GB takes 24 min, 8 GiB 3.4 h. It does nothing for `month`.
- **Policing (`nft limit`, `tc police`) or `nft quota`.** Policing drops where a shaper queues, so uploads collapse, and it has the same burst limit. A quota has no refill and resets on boot, so the process is needed anyway.
- **CAKE, HFSC, eBPF pacing.** CAKE has one shaper over all its tins, and the stream must stay outside. HFSC's delay curves solve contention that isn't here. eBPF is more to build and bake for rates this low.
- **The guard driving the throttle** through the row, heartbeat and `deskd`: a new root verb, 5 more minutes of lag, and `deskd` in the path, for nothing gained. **Platform's meter as the counter (S-29 as designed):** per member and billing period, 10 to 12 h. Added desks need it; one desk doesn't.
- **Swapping a security group, or a network ACL.** Neither can set a rate. In a group, "its tracked connections are not immediately interrupted" [R AWS docs], and responses to inbound traffic ignore outbound rules, so an accomplice just sends first. Desks share one group per VPC [R], so it also needs a second group and a new guard permission, and it cuts `deskd` off from the gateway. An ACL cuts at once [R AWS docs], but video too, and a stop is cleaner for a desk that must be treated as lost.
- **Anything in the path** (NAT gateway, Network Firewall, a relay). It puts the platform in member traffic, which the product rules out. Network Firewall alone is about $288 a month [A].
- **Faster detection.** VPC Flow Logs show the platform where members go. Detailed monitoring's one-minute buckets would save about $30 per rush at 5 Gbps, for about $2.10 per desk a month [A]: a dial for later.
- **Raising `month` to fit the stream:** 2,790 GB a month, more than twice the stop, for one desk. **Dropping frame rate or closing sessions:** ruled out.

### 8. Results from the lab boxes (2026-11-06, `sub/throttle`)
Two boxes from `ma-desk-0.2.3` (`<ami>`), a c7g.large and a t4g.medium in one subnet, tagged `Purpose=ma-sub-throttle`, with no instance role and no member data. The branch's image files went on by `build.sh`'s own steps (`image/lab/throttle/apply.sh`), each box in turn shaped while the other was the sink. Everything is reproducible with `image/lab/throttle/lab.sh`, and the evidence is in `image/evidence/throttle-2026-11-06/`: `ev-*` from the first two boxes, which ran before this branch and were never reported, and `lab2-*` from these. Kernel `6.12.115+deb13.1-cloud-arm64`. **Headline: of the 12 [A] claims, 9 can be tested on a box. 7 are proven, one of them only at p99, and 1 is disproven in members' favour. The 9th, that `NetworkOut` is counted outside the guest, matches the guest's own count to 0.0001%, but a box can't show where it's counted. The other 3 are prices or AWS facts a box can't test.**

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | Section 2: no `tc filter`, HTB takes the class from `skb->priority` | **Proven,** both sizes. No filter on `ens5`. 15 of 15 cases land where they should: `desk-rtc`'s UDP and ICE-TCP from 443 in 1:10, its other ports in 1:20, root and `desk` (also from a container with `deskd`'s flags) in 1:15, `kiosk`, `agent` and `stream` in 1:20. With the chain emptied, all of it falls to 1:20 | `lab2-1-*`, `ev-1`, `ev-5b` (real `desk-rtc`) |
| 2 | Section 2: `SO_PRIORITY` above 6 needs `CAP_NET_ADMIN` | **Proven.** 6 is allowed and 7 and up refused, for `desk`, `rtc` bare and as its unit runs it, `kiosk`, `agent`, `stream`, `kiosk` in a new user namespace and `desk` in its container. `IP_TOS` gives at most 6, which HTB sends to 1:20. The `SO_PRIORITY` cmsg isn't in this kernel (`EINVAL`). Each of them is also refused `tc qdisc del`, `tc class change`, `tc filter add`, `nft flush`, `nft add rule`, `SO_MARK` and port 443, and root checked the shaper unchanged after each. Root may set any priority, and the chain relabels root to 1:15 anyway | `lab2-2-*`, `ev-6` |
| 3 | Section 2: a stream packet waits under 1 ms behind the other classes | **Proven at p99, not for every packet.** Round-trip p99 at most 0.45 ms in every row on both sizes (no shaper, idle, `kiosk` saturating 1:20, `kiosk` and `deskd` saturating, slowed with an upload), against at most 0.37 ms with no shaper, and no stream packet lost in 60 runs. 12 of the 60 had a maximum of 1 to 4.3 ms: 10 of the 48 shaped runs and 2 of the 12 with no shaper, about the same share, so those come from the box or the network. Synthetic stream, 8.3 and 41 Mbps, 3 repeats | `lab2-4-*`, `ev-3` |
| 4 | Section 2: the shaper costs microseconds a packet | **Proven.** At 41 Mbps (4,270 packets a second) the c7g.large was 1.15% busy with the shaper and 1.17% without, and the t4g.medium 5.7% and 5.15%: about 2.6 µs a packet. At 8.3 Mbps the difference is inside the noise | `lab2-4-*` |
| 5 | Section 3: `NetworkOut` is counted outside the guest | **Consistent, can't be proven from a box.** Over a 10.73 GB test, CloudWatch's two 5-minute buckets held 10,018 bytes more than `tc` counted, 0.0001%, which is the minute of SSH around the test, and `tc` and `ip link` agree to the byte. No CloudWatch agent runs on the image. That the guest can't change it is AWS's design [R]. This also passes section 6's test 2 counter check (within 5% over 10 GB) | `lab2-6` |
| 6 | Section 3: AWS offers no outbound rate per instance | Not a lab claim. Still [A] | |
| 7 | Section 4: with the bucket empty, downloads are held to about 30 Mbps by their ACKs | **Disproven, in the members' favour.** At a 30 ms round trip with 1:20 at 0.75 Mbit, an unlimited download ran at 206 to 284 Mbps, and 76 Mbps beside an upload that filled the slowed class. A 40 Mbit download held 38.1 Mbps either way. TCP sends fewer, larger ACKs when they queue. What does get slower is anything that waits behind an upload: a DNS lookup from `kiosk` took 47 ms (p50, 80 max) against 0.15 ms, and four real pages 0.3 to 2.9 s against 0.2 to 0.8 s | `lab2-5`, `lab2-7a` |
| 8 | Section 4: the ACKs for 40 Mbps of inbound video fit inside the refill | **Proven, with less room than it implies:** 0.58 to 0.69 Mbps of the 1 Mbps refill for a 40 Mbit TCP download at 30 ms, the internet's MSS, 1.5% of the bytes. The first box's 0.12 (`ev-4`) was line-rate bursts that GRO folds into few ACKs. QUIC, which most video uses, wasn't measured | `lab2-5` |
| 9 | Section 6: `sch_htb` and `sch_fq_codel` are in Debian's cloud kernel | **Proven** on both sizes. `build.sh` asserts both, and `verify.sh` loads them | `lab2-9-*` |
| 10 | Section 6: `desk-egress` is about 15 MB and under 0.1% of a core | **Proven,** with room: 12.7 MB resident (6.5 MiB charged to its cgroup) and 0.031 s of CPU in 10 minutes at the shipped 60 s tick, 0.005% of one core, on the t4g.medium | `lab2-10` |
| 11 | Section 7: Network Firewall is about $288 a month | Not a lab claim. Still [A] | |
| 12 | Section 7: detailed monitoring saves about $30 a rush for about $2.10 a desk a month | Not a lab claim. Still [A] | |

**Section 6's tests, part by part.**
- **Test 2.** Each class holds its ceiling alone and together: 60.9, 2.03 and 100.3 Mbps, 163 to 164 in all over 15 s, of which about 0.7 is the two bursts. Four viewers' keyframes, 600 and 960 KB, leave at line rate in 4 to 6 ms with no drop. Counters against `NetworkOut`: row 5. Capped and deep build, send at 60 frames a second to a stand-in viewer and use their own pipelines (quantizer 28; quantizer 30 at 960x540), but on a synthetic page, not real content and not the real stack (`lab2-3-*`, `lab2-7d`, `verify.sh` 3d).
- **Test 3.** Refusals: row 2. As root on a `DeskKind=test` desk (delete the shaper, see the flag, then the stop through `CostGuardTestLimitGb`): not run, since it needs a test desk and Platform's guard changes. A guest that ignores the shutdown signal: one sample on the t4g.medium. `systemd-logind` set to ignore the power button got it at the stop call and about 30 s and 90 s later, ignored each, and the box was off with no shutdown in its journal 251 s after the call, so EC2 forced it at about 4.2 minutes (`lab2-13`). Section 3's "a few minutes" [R] holds: about $14 more at 5 Gbps on top of the rush figures.
- **Test 4,** with lowered thresholds, the real `desk-egress`: the bucket empties after 0.3 GB at 100 Mbps and 1:20 and 1:15 drop to 0.75 and 0.25 Mbit within the tick; it reopens by itself; four real pages load with it empty, with and without an upload; `desk-rtc`'s class clamps to 1 Mbit past its day line and lifts when the line rises; slowed, deep and the month's bytes survive a reboot and a real EC2 stop and start, with the shaper on 7.1 to 7.6 s after boot and the time stopped refilling the bucket; a state from last month starts this month at 0. The stream steps from normal to capped to deep under a live stand-in viewer, at 60 frames a second each, with one pause of 158 and 175 ms at each step, and three plain `try-restart`s paused it 155 to 165 ms (`lab2-7*`).
- **`verify.sh`'s sections 2 to 3d** (IMDS, the kiosk and 9222, the keymap and its `LAST-ACK` count, `units.sock`, `desk-stream`, the shaper) passed 6 of 6 on the t4g.medium, and on the c7g.large after the shaper section's own fixes below (`lab2-9-*`). Rebased onto `main` with handoff 16's sections A to C and the IMDS change below, they passed 6 of 6 on both (`lab2-11-*`). The 9222 rule still refuses `kiosk` and `agent` on both addresses, and 1,000 CDP requests as `desk` leave 0 sockets in `LAST-ACK`. The IMDS rule still gives 200 to root and `desk` only (`lab2-8`).

**Found and fixed on the way.**
- `cburst` (section 2's table now says so), from the first box.
- `gst-ptp-helper` came with `cap_net_admin` as a file capability, so Chromium, which runs without `NoNewPrivileges`, could exec it and hold `CAP_NET_ADMIN` until it dropped it. `build.sh` makes it root-only with a `dpkg-statoverride`, which also clears the capability; no file on the image has one now. From the first box.
- The first box's slowed rows (`ev-4`, "1:20 at 0.75 Mbit") never ran slowed: `desk-egress` put the rate back within its tick, and their class lines say 100 Mbit. `lab2-5` replaces them.
- `desk-egress` with no state from this boot, under a shaper that outlived its process, charged all the shaper had ever counted to the bucket at once (11.5 GB on a lab box). It now starts from the counters it finds.
- `verify.sh`'s shaper section had never run. It read 1:15's counter before 200 packets had left at 2 Mbit, tested `gst-ptp-helper` through `setpriv`, which execs with root's capabilities still held, and could be restarted mid-check by `desk-egress`'s own tick. All three are fixed.
- **IMDS (handoff 16 G's last bullet).** The IMDS rules refused the kernel's closing packets, as the 9222 rule did before `0f3b27c`, but only when the client closes first. IMDS closed every connection `curl` made, and then nothing reached the refusal. With the client closing first, 20 connections had 300 ACKs refused and IMDS resent its FIN 212 times in a minute. `nftables.conf` now refuses only a new TCP connection there too, and everything that isn't TCP: 0 resent, and the refusal for `rtc`, `kiosk`, `agent`, a container as `rtc` and UDP is unchanged (`lab2-8`, `lab2-8b`, and `lab2-12` for the rule as committed).

**Unproven until the member size is chosen (test 1, the video test).** All of it needs the real stack, `desk-rtc`, `desk-stream` and Chromium, on `Purpose=browser-benchmark` boxes at the size W3 picks:
- Page fps within 0.5 of no shaper, B12 p50 within 3 ms and inside budget, B13, zero drops on 1:10 with `rtpDropped` 0, and CPU within 1 point, each with `kiosk` saturating 1:20 and with the bucket empty. The rows above are a synthetic stream on a LAN; real WebRTC through the shaper has only `ev-5b`'s 20 s of one viewer.
- What capped and deep look like and cost in GB/h at the chosen size: capped never ran on c7g, deep never on the real stack, and here both ran only on a synthetic page.
- `stream-deep.conf` scales to 960x540, half of the 1920x1080 X screen. If W3 picks t4g.medium at 1280x800, it must say 640x400.
- The pause at a profile change through a real `desk-rtc`, here 158 to 175 ms with a stand-in.
- QUIC's ACKs, which most video downloads use, against the refill.

## Consequences
- Non-stream outbound gets a standing limit. ADR 0027's "never throttle" was about CPU, and frame rate is untouched.
- S-29's on-desk half returns for launch at 0.5 h; Platform's meter stays cut. `streaming.streamProfile` is a constant `normal` in `services/desks/src/agent.ts` and `deskd` doesn't read it [R], so nothing here depends on it. When the meter ships, the worse of the two wins. Until then this is per desk and UTC month, which suits one desk a member at launch.
- The owner's desk was unshaped until it took 0.2.6, with the guard as today; it's shaped since, and runs 0.2.9. Flags are tickets, and nobody reads them at night, so for root the stop is the only automatic layer.

**For the owner, each with a default:**
1. The stream's quality steps at launch, at 100 and 500 GB? Default: yes; it's the only way an honest heavy viewer avoids the `month` stop.
2. A broken `desk-rtc` or root stays bounded by the stops, not the throttle ($108 a month paced, $71 in a rush)? Default: accept.
3. Two viewers nonstop, or a compromised browser beside nonstop video, can still reach `month`? Default: accept.

## Addendum, 2026-11-07: `desk-agent-filter` (ADR 0070)
`desk-agent` (uid 1103) no longer sends on `ens5` itself. `desk-agent-filter` (uid 1106) carries its traffic, so section 2's table reads, and nothing in the decision changes:

| HTB class | Who |
|---|---|
| 1:20, the default | Everything else: Chromium, `desk-agent-filter` carrying the agent's traffic, DNS |

No rule labels uid 1106, so it lands in 1:20 the way the agent did. Loopback isn't shaped, because `classify` returns on `oif "lo"` and the shaper is on `ens5`, so the agent's side of the filter isn't counted and the bytes are counted once. A transfer measured it: ADR 0070. `verify.sh`'s check `F-CLASS` keeps it true. Self-hosted desks have no shaper, and the filter doesn't need one.

## Addendum, 2026-11-08: a Guild Desk's voice class and budget (desk-net-031)
A Guild Desk (ADR 0080) is the same image, and before this its Commons voice fell into the default class 1:20 at 100 Mbit, under the 30 GB bucket, and every class under the 135 GB clamp. Both are one member's rules: each member's bytes from a Guild Desk are metered to that member's own allowance (`guild-eng.md` §3.2), and 200 members with 10 talking send about 121 Mbit of voice. Measured on a `c7g.xlarge` with 200 members' voice from another box: in 1:20, a fifth of the voice dropped (clients heard 394 packets a second each of 495) and voice through the server went from 0.8 to 78 ms at p50; the bucket would then have emptied within the hour.

**Decision, on a Guild Desk only** (`/run/ma/guild`; image README, "Guild Desk"):
- **Class 1:30 for voice:** uid 1110 from its voice ports, and uid 1101's RTP and RTCP from UDP 443 (first byte 128 to 191, by RFC 7983; a Guild Desk's own sessions carry no media), labelled by `desk-guild-net` in `classify`. 0.8 Mbit a member of the tier, rate equal to ceiling, 1 MB `burst`, prio 0, `fq_codel`. The tier comes from the instance type (`t4g.small` 25, `t4g.medium` 50, `c7g.xlarge` 200, else 200) in `/etc/ma/guild.conf`.
- **Budgets:** the bucket stays on 1:15 and 1:20, which there carry only the desk's own senders. Layers 3 to 5 don't apply: there's no stream, and 1:10 is every member's metered data. One day line for the guild replaces them: past 4 GB a member of the tier in any 24 h, voice drops to 0.2 Mbit a member and 1:10 to 0.1 Mbit a member, until under 3.5 GB a member. It's a cost guard for a broken server, sized to the tier rather than to one member's allowance; honest use, 12.8 of ADR 0080's worst hours for every member, stays under it.
- **The guard's stops** (section 5, layer 7) are per instance and don't know a Guild Desk: 150 GB in 24 h is about 2.4 of the worst hours at 200 members. Platform needs a Guild Desk's own limits by tier, above this line.

- **1:10 on a Guild Desk** (desk-net-031-rtc): every member's data, so 0.75 Mbit a member of the tier, never under 60, on `fq_codel` instead of the member's 1,000-packet `pfifo`. The member's 60 Mbit FIFO stalled every member's data for seconds under `guildscale`'s burst profile.
- **The day line capped at 120 GB, for now** (desk-net-031-sec, Security's `NET031-1`): on the members' line a 50- or 200-member guild reached the guard's 150 GB stop first, and the whole desk was stopped. Until the guard has a Guild Desk's limits, every tier's line is at most 120 GB, released at most at 105 (`day_cap_gb` and `day_release_cap_gb` in `guild.conf`, 0 lifts it). With the worst hour twelve hours a day, 50 members now stay under the stop; 200 members are slowed at 1.9 hours and still reach it at 3.4, since 3 voices heard for 200 members is 18 GB an hour, so the guard's own limits remain the fix.

A member's desk keeps sections 2 and 5 exactly: the same three classes, `egress.conf` and state file. `desk-egress` now starts after `desk-kind`, which `desk-rtc` and `deskd` already wait for.

## Addendum, 2026-11-09: test 1 on a shared host, and test 3's root part (TD-223, S-35, `sub/s35-throttle-tests`)
Section 6's test 1 and test 3 were left open. Test 3's root part is built and **passed on staging** (run 4 of 4, below); test 1 is redesigned for shared hosts and waits for a host. The shaper, the host image and `desk-egress` are the System Engineer's and aren't touched here. Marks as above: **[M]** measured, **[R]** read, **[A]** assumed.

### Test 3, the root part (built; ran on a staging test desk)
- **Guard side** (`ma-platform` ADR 0082 addendum 2026-11-09): the two flags section 3 asks for, `throttle_bucket` (a 5-minute bucket over 7 GB) and `throttle_day` (24 h over 140 GB), flags only. `DeskKind=test` gets one tag, `CostGuardTestBucketGb`, which lowers the bucket line and nothing else; a member's desk ignores it, as it ignores `CostGuardTestLimitGb`. `fast` is still 30 GB: moving it to 20 is a stop dial and the Platform Engineer's call. A shared host reads these at one desk's lines times `DesksPerHost`.
- **The test** (`ma-platform` `scripts/throttle-root-test.sh <staging test desk>`): (1) `kiosk` (uid 1102) sends flat out for 7 min to an unused private address in the desk's subnet; pass: the interface sends at most 110 Mbps, the class ceiling plus slack, and every CloudWatch bucket is under 6.4 GB. (2) As root: stop `desk-egress`, `tc qdisc del dev ens5 root`, `desk-egress --check` fails, send 400 Mbps for 6 min (about 18 GB, under the real `fast` stop of 30). Pass: the guard's own rules, run on the real buckets (`scripts/throttle-root-check.mjs`), give `throttle_bucket` over 7 GB. (3) Tag `CostGuardTestLimitGb=15`; pass: the deployed guard stops the desk within 24 minutes. Cost under $1, in-VPC bytes only. The script refuses anything but a running `DeskKind=test`, `Env=staging` desk with SSM, a desk with `CostGuardIgnoreUntil`, and a Personal or Work name.
- **What the shaper is expected to show:** one desk sends no more than 163 Mbps in all, 6.1 GB in a bucket, so the flag never fires on a shaped desk and always on a bare one at 400 Mbps (12 GB a bucket).
- **Result, 2026-11-10 (staging, one hand-made `DeskKind=test` desk, image 0.3.1):** kiosk flat out held to 100.0 Mbps; with the shaper deleted as root, 18.63 GB in 6 min, buckets 3.75, 14.65 and 3.07 GB, so `throttle_bucket` (guard rules run on the real buckets); `CostGuardTestLimitGb=15` then stopped the desk through the deployed guard (rule `fast`, 21.5 GB). Not shown live: the flag mail, since the deployed guard has no flag until Platform applies. Three earlier runs sent bytes that `NetworkOut` never counted: an unused address on the subnet (nothing leaves), and TEST-NET and UDP port 9 (the desk's security group allows out only tcp 80, tcp 443 and udp 443, and drops the rest before counting). A root attacker's reach is those ports only.
- **Section 6's "time a guest that ignores the shutdown signal"** stays section 8's one sample (251 s).

### Test 1, the video test, on a shared host (redesigned; not run)
**Why it changes.** On a desk of its own the shaper is one HTB on `ens5` and the video test is one desk against "no shaper / idle / `kiosk` saturating / bucket empty". On a shared host (ADR 0072 section 8) the shaper is per desk, on the desk end of its veth, `ens5` has none, and `desk-egress`'s budgets run on the host. The risk is therefore different: not only "does the shaper cost one viewer its frames", but "does one desk's flood, held by its own shaper, cost its neighbours theirs", plus the load of N shapers and N floods on one host's CPU and NIC.

**Setup.** One host at the size task 46 chose, N desks (the packing under test, 6), each with its own shaper from `desk-host` and its own budgets. `D1` is the viewer: the real-stack video clip and the key-to-frame probe of `spikes/shared-hosts-test5/probe5.mjs` from a client that is not on the host. `D2` to `DN` are flooders, driven from inside each desk by `image/lab/throttle/net.py udp-send` to an unused private address (so the bytes count in `NetworkOut` and leave the host). The rest of the packing is what test 5 used: swap caps, desks' real Chromium tabs on unseen desks, the same clip at random offsets. Each row: 3 repeats of 300 s.

| Row | D1 | Others |
|---|---|---|
| R0 | video | all quiet (the baseline, with the shapers on) |
| R1 | video | D2 `kiosk` saturating 1:20 (100 Mbps) |
| R2 | video | D2 root flat out (held to 1:15, 2 Mbps), and D2 `rtc` flat out from UDP 443 (1:10, 60 Mbps) |
| R3 | video | D2 with its bucket empty (lowered thresholds in its `egress.conf` copy on the host) and an upload running |
| R4 | video | D2 to DN all flooding at once, every class at its ceiling: the worst case for the host's NIC, CPU and softirq |
| R5 (negative control) | video | D2's shaper removed by the host, as a bug would: the throttle flag must fire and D1's loss, if any, is what the shaper was preventing |

**Pass criteria** (`image/lab/throttle/test1_shared_judge.py`, 5 unit tests): per row against R0 and a standing floor:
- **The viewer, D1:** page fps within 0.5 of R0 and its 5th-percentile 5 s window at least 30 fps (task 46's floor; 60 is a goal, not a promise); B12 p50 within 3 ms of R0 (repeats vary up to 6 ms [M], so nothing finer) and inside 90 ms p50 and 150 ms p95; B13 in budget; `rtpDropped` 0 and zero drops on D1's 1:10; `desk-stream` CPU within 1 point of R0.
- **Each flooder, held under ADR 0082's stops:** shaper on; every 5-minute bucket at most 6.3 GB (the ceiling 6.1 plus the two bursts), under the 7 GB flag line; any 15 minutes at most 19 GB against the `fast` stop at 30; classes at their ceilings (60, 2, 100 Mbps, 3%); the guard's count of the slot (`slot_net`, the host's report) within 5% of the veth's own, so the per-desk stop sees what was sent.
- **The host:** its NIC's largest bucket under the flooders' ceilings added, and its `NetworkOut` under ADR 0036's limits times `DesksPerHost` (ADR 0072 section 8's last-resort stop). `ens5` is unshaped by design, so R4 is also the check that 5 floods at 163 Mbps (815 Mbps) don't queue a viewer's packets: if D1's B12 moves by more than 3 ms in R4 and not in R1, `fq_codel` on `ens5` is what the System Engineer adds.
- **R5** must show the opposite: `throttle_bucket` on the slot or host (bucket over 7 GB per desk) and, if the host can bind it, that the guard's per-slot stop follows `CostGuardTestLimitGb` on a `DeskKind=test` desk.

**Prerequisites, for the System Engineer.** (1) A staging shared host that can carry N desks with per-desk shapers on the veth: **not built** (ADR 0072: "the shaper on a veth" is on the not-built list; no staging shared host can exist until Platform's host link, placement and pairing are). (2) `desk-host` writes each slot's `tc -s class` counters and `net.json` to its report, so the judge's `classes_mbps` and `guard_tx_gb` can be read. (3) A way to remove one slot's shaper for R5 without root in the desk. (4) The test-5 harness (`sh5.sh`) taking a flooder step. None of these is in this change. **Note, 2026-11-11 (TD-223, `sub/td223-shaper`, for host 0.1.11):** (2) and (3) are built, and (1)'s host half: each slot's shaper on its veth and its budgets on the host (ADR 0072 section 8), the report's `shaper` counters, `desk-host shaper <k> off|on`, and the flooder step in the host image's lab driver (`image/lab/td223/lab.sh row`) in place of `sh5.sh`, which has no `desk-host`. A staging shared host is still Platform's. How to run the test: `docs/sub-status/td223-shaper.md`.

**What stays from the original test 1.** Desks of their own (the Alliance size and the owner's) keep section 6's rows 1 to 4 as written; they still need `spikes/browser-bench/real-stack/` on a `Purpose=browser-benchmark` box. The questions section 8 lists as unproven (capped and deep at the real size, QUIC's ACKs, the profile-change pause through a real `desk-rtc`) are test 2 and test 4 items and unchanged.

### Result, 2026-11-11: tests 1, 2 and 4 on a desk of its own; test 1 on a shared host still can't run (`sub/guild-td223-test1`)
**Test 1 on a shared host (rows R0 to R5): not run.** No shared host has a per-desk shaper: ADR 0072 lists "the shaper on a veth" as not built, and the host's `classes.conf` publishes each class's `egress` without enforcing it. The four prerequisites above went to the System Engineer (`PROGRESS.md`, 02:18 MT). The same holds for the shared-host forms of tests 2 and 4 (budgets on the host, state under `/var/lib/desk-host`). **What ran instead** is what the addendum keeps for desks of their own, which is every desk in prod today: section 6's tests 1, 2 and 4 on one `c7g.large` from `ma-desk-0.3.3` (`<ami>`) at 1920x1080, as baked (the shaper on `ens5`, `desk-egress` `baked-de48ec84`, `desk-rtc` 0.5.0, `desk-stream` 0.3.3, `deskd` `ff58751`). The client was a `c7i.xlarge` in the same subnet with Playwright's Chrome 156, 30 ms of `netem` on the client's own outbound (so `ens5` kept the shaper as its root qdisc), reaching `desk-rtc` on the desk's public address. `gateway-shim` and the fake IMDS ran on the desk's loopback. Both boxes were tagged `Purpose=browser-benchmark`, with no role and no member data, and both are gone. The driver is `image/lab/throttle/real/` (`real.sh`, `rows.sh`, `rtctap.py` for `rtpDropped`, `t1judge.py`, `pause.mjs`), and the evidence is `image/evidence/throttle-real-2026-11-11/` (`docs/sub-status/guild-td223-test1.md`). All figures are [M].

**Test 1, video through the shaper: idle and bucket-empty pass; kiosk-saturating fails the CPU rule.** Each row is the median of 3 repeats, interleaved, each a fresh session through `spikes/browser-bench/real-stack/proof2.mjs`. `desk-stream`'s CPU is in % of one core, and the machine's is for 2 vCPUs.

| Row | Page fps, scroll / video | B12 idle p50 / p95 | B12 video p50 / p95 | B13 p50 / p95 | 1:10 drops, `rtpDropped` | `desk-stream` CPU, scroll / video | Machine CPU | Verdict |
|---|---|---|---|---|---|---|---|---|
| No shaper (baseline) | 59.95 / 59.91 | 40.9 / 53.2 | 59.9 / 74.9 | 41.1 / 44.7 | (no class), 0 | 44.8 / 56.6 | 47.8 / 53.6 | |
| Shaper idle | 59.95 / 59.92 | 41.7 / 55.4 | 60.2 / 74.4 | 41.7 / 45.1 | 0, 0 | 45.4 / 56.5 | 48.4 / 53.6 | **Pass** |
| Shaper, `kiosk` saturating 1:20 (UDP, 150 Mbps offered, 100.3 carried) | 59.93 / 59.87 | 43.0 / 54.2 | 59.9 / 76.2 | 38.9 / 46.4 | 0, 0 | **47.0 / 59.0** | 55.9 / 61.8 | **Fail: CPU** |
| Bucket empty (`bucket_gb` 0.3), `kiosk` upload running | 59.95 / 59.91 | 41.2 / 53.3 | 58.8 / 72.3 | 37.0 / 43.1 | 0, 0 | 45.0 / 56.5 | 48.1 / 53.5 | **Pass** |

- **The failing row,** exactly: `desk-stream` CPU was 2.2 points over no shaper while scrolling (47.0 against 44.8) and 2.4 points over with video (59.0 against 56.6), against a limit of 1. That is 1.2 and 1.4 points over the rule. Read as machine CPU, the row is 8.1 and 8.2 points over, but that includes the flood's own sender. Every other rule passed in that row: page fps 0.02 and 0.04 under, B12 2.1 ms and 0.0 ms over, B13 46 ms, and no drop on 1:10 or in `rtpDropped`. The client saw 0 packets lost and 0 freezes in every row of every repeat.
- **Repeated, and what it's made of** (3 repeats each, against the same baseline): the kiosk row again gave +1.9 and +2.4 (fail). With `kiosk` paced at exactly 100 Mbps under the shaper it gave +2.0 and +2.5 (fail). With the same 100 Mbps and **no shaper** it gave +0.9 and +0.5 (would pass), with the machine +5.3 and +5.4, which is the sender. So carrying 100 Mbps of 1:20 through HTB costs about 1 to 2 points of `desk-stream`'s CPU and 2.2 to 2.8 points of the machine, beyond the sender. That is about 4 to 5 µs a packet at about 10,000 packets a second, against section 8's 2.6 µs, which was measured on the stream's own class. The desk kernel has `CONFIG_IRQ_TIME_ACCOUNTING` off, so softirq work (HTB's dequeue and its watchdog) is charged to whatever task it interrupts, `desk-stream` included. `desk-stream`'s own encode can't be told apart from the shaper's softirq that lands on it. The picture did not change.
- **Not changed to make it pass:** the shaper, the rows and the rule are as section 6 wrote them. Whether a saturating upload's 1 to 2 points on the stream is accepted, reduced or measured another way is the System Engineer's call.

**Test 2, profiles and counters: pass.**
- **Capped and deep at the real size** (3 repeats each; normal is test 1's shaper-idle row), each set by `desk-egress` itself through lowered day lines:

| Profile | Picture | Video GB/h | Scroll GB/h | Page fps, scroll / video | Stream fps, scroll / video | B12 video p50 / p95 | B13 p95 | `desk-stream` CPU, video |
|---|---|---|---|---|---|---|---|---|
| Normal | 1920x1080 | 3.27 | 1.26 | 59.95 / 59.92 | 59.84 / 59.98 | 60.2 / 74.4 | 45.1 | 56.5 |
| Capped | 1920x1080, q28, 4 Mbps | **1.65** | 1.05 | 59.95 / 59.90 | 59.19 / 59.96 | 58.6 / 73.2 | 44.3 | 50.5 |
| Deep | 960x540, q30, 2.5 Mbps | **0.58** | 1.11 | 59.95 / 59.91 | 59.23 / 59.97 | 57.7 / 69.5 | 41.0 | 26.3 |

  Both keep 60 fps, B12 and B13. On video, capped is 50% of normal and deep is 18% (ADR 0033 had 1.85 and 0.74 GB/h on its own content). Scrolling barely changes, because scroll already sits near the lower caps. Deep's scroll is a little above capped's: 2.5 Mbps is its VBV cap, and the 5th-percentile stream fps while scrolling was 55 to 56 on both, against 58 to 59 at normal.
- **Each class holds its ceiling** (`tests/t3-ceilings.sh`, run unchanged with `desk-rtc` stopped so 443 was free): alone, 1:10 carried 60.93, 1:15 2.03, and 1:20 100.29 (UDP), 100.80 (TCP) and 100.63 Mbps (internet MSS). All at once they carried 60.62, 2.02 and 101.16, 163.8 Mbps in all (0.7 of that is the two bursts). Keyframe bursts of 600 and 960 KB left in 1.9 and 2.7 ms with no drop. All within 3%. The first try, with `desk-rtc` still holding 443, couldn't send from 443 and is kept as `t3-rtc-running.out`.
- **`tc` against `NetworkOut` over 10 GB** (`tests/t6-counters.sh`): `tc` counted 10,727,046,744 bytes, the same as `ip link` to the byte. CloudWatch's two 5-minute buckets for the test held 10.515 GB, 1.98% under. The next bucket held 0.676 GB, the test's last seconds plus the next tests' traffic, so even counting all of it the total is at most 4.3% over. **Within 5%.**

**Test 4, budgets with lowered thresholds: pass** (`tests/t7-budgets.sh` phases run unchanged, plus `real/pause.mjs` for a real viewer):
- **The bucket empties and reopens:** after 0.3 GB at 100 Mbps, 1:20 dropped to 0.75 and 1:15 to 0.25 within the 5 s tick, carrying 0.76 Mbps. With a 40 Mbps refill it reopened by itself within 10 s.
- **A real page load with it empty:** four real pages took 0.37 to 1.59 s, against 0.30 to 0.96 s with the bucket full, and 0.38 to 1.02 s with an upload running beside them. All returned 200.
- **The clamp (layer 5):** `rtc` sending 50 Mbps from 443 was clamped to 1 Mbit past 0.2 GB and lifted when the line was raised.
- **State survives a reboot and a stop and wake:** with the desk slowed, deep and holding 349 MB this month, a reboot kept all three and the shaper was on 4.2 s after boot. A real EC2 stop and start (52 s) kept them too, with the shaper on at 4.17 s. The bucket gained 7.3 MB across the 62 s between readings, so the stopped time refilled it at 1 Mbps.
- **Month rollover:** a state from October holding 600 GB started November at 264 bytes.
- **`desk-stream` restarted during a live session recovers:** three `try-restart`s under a real viewer through the real `desk-rtc` each gave one pause, of 217, 200 and 267 ms. The session stayed the same and the picture came back each time.
- **The pause at a profile change through a real `desk-rtc`** (section 8's open item): normal to capped 233 ms, capped to deep 233 ms (the picture went to 960x540), and deep to normal 233 ms. On the way to deep, the lab's fresh start passed through normal once, adding one 217 ms pause that `desk-egress` itself wouldn't make. The client saw 0 packets lost, and its 7 freezes are those 7 pauses. Two clusters of 4 or 5 shorter gaps (67 to 150 ms), 10 to 20 s after a step and tied to no command, are recorded. The 15 s baseline had none.

**Test 3:** recorded above (2026-11-10, on staging; MP `ed27c15c`, MD `210b83d5`, both on `main`). Not re-run.

**Still open:** test 1 on a shared host and the shared-host forms of tests 2 and 4 (the per-desk shaper on the veth, the System Engineer's); the kiosk row's CPU (the System Engineer's call); a t4g.medium (not a member size); QUIC's ACKs against the refill; and the guard's half (`fast` at 20 GB, Platform's).


### Result, 2026-11-11: test 1 on a shared host, host 0.1.11 (`sub/guild-td223-shared`; two labs)
**Run in two labs on the same day: R0 to R5 judged: everything a member sees holds in every row, the viewer's CPU rule fails in R1, R4 and R5, and R5's negative control behaves as designed.** Each lab: one `m7g.xlarge` from host 0.1.11 as baked (`<ami>`), `SlotMode=port`, six `standard` slots, each shaped on its veth (`desk-host-check --only shaper,counters` PASS; 1:10, 1:15, 1:20 at 60, 2 and 100 Mbit on every slot), driven by `image/lab/td223/lab.sh` as `docs/sub-status/td223-shaper.md` says, with the uploads started before the probe's session so B13 is taken under them (`FLOOD_EARLY`). D1 played the 1080p60 clip under `probe5.mjs` from a `c7i.xlarge` client at 31 ms; the other desks sat idle except as flooders. 300 s a repeat, medians of the repeats, each lab's rows against its own R0 (the two labs' R0 differ by 1.1 points), judged by `test1_shared_judge.py` (B13 budget 300 ms). The first lab ran R0 to R3 x3 and R4 once before the coordinator's stop order (usage); the second ran a fresh R0 x3 interleaved with R4 x3, then R5 x2. Lab evidence, never a release proof; `docs/sub-status/guild-td223-shared.md`. All figures are [M].
| Row | Lab, repeats | Page fps / lowest 5 s | B12 p50 / p95 ms | B13 ms | Lost, 1:10 drops, freezes | `desk-stream` CPU (vs its R0) | Flooders' classes, Mbit/s (1:10 / 1:15 / 1:20) | Guard vs veth GB | Host's largest 5-min bucket | Verdict |
| R0 | 1st, 3 | 59.6 / 45.4 | 55.9 / 67.6 | 160 to 332 | 0, 0, 0 | 57.7 | quiet | - | - | baseline |
| R1 | 1st, 3 | 59.6 / 45.6 | 56.4 / 69.5 | 160 to 177 | 0, 0, 0 | **58.8** (+1.1) | D2 0 / 0 / 100.0 | 10.753 / 10.761 | 3.1 GB | **Fail: CPU** |
| R2 | 1st, 3 | 59.6 / 46.0 | 56.5 / 68.7 | 163 to 173 | 0, 0, 0 | 58.1 (+0.4) | D2 0 / 2.0 / 0 | 0.219 / 0.220 | 3.1 GB | Pass |
| R3 | 1st, 3 | 59.6 / 45.6 | 56.2 / 68.9 | 164 to 168 | 0, 0, 0 | 58.1 (+0.4) | D2 0 / 0 / 0.75, slowed | 0.082 / 0.083 | 0.8 GB | Pass |
| R0 | 2nd, 3 | 59.6 / 45.0 | 56.6 / 68.1 | 170 to 292 | 0, 0, 0 | 58.8 | quiet | - | - | baseline |
| R4 | 2nd, 3 | 59.6 / 45.4 | 56.9 / 69.2 | 183 to 202 | 0, 0, 0 | **63.3** (+4.5; each +3.7 to +4.8) | D2 to D6 each 0 / 0 / 100.0 to 100.05 | 10.58 to 10.74 / 10.59 to 10.75 each | 18.6 GB (ceiling 31.5) | **Fail: CPU** |
| R5 | 2nd, 2 | 59.6 / 44.2 | 56.3 / 69.2 | 175, 178 | 0, 0, 0 | **60.55** (+1.75) | D2 unshaped, 300.6 at its veth | 22.427 / 22.436 | 11.2 GB | **Control as designed:** `throttle_bucket` fires; viewer CPU +1.75 |

- **The viewer's picture held in every row of both labs:** page fps 59.6, stream 59.59 to 59.64, lowest 5 s windows 44.2 to 47.4 (the stream's, as in R0), B12 p50 within 0.6 ms of its R0, B13 at most 202 ms under every flood (each R0's slow one, 292 and 332, is a host's first session after its warm-up), no packet lost, no drop on 1:10, no freeze. Its 1:10 carried 7.5 to 7.8 Mbit/s.
- **The flooders held:** 1:20 at 100.0 Mbit/s median (no second above 102.14), 1:15 at 2.0 (2.02), every slot's 5-minute bucket 3.4 to 3.6 GB against 6.3, the guard's `out_<k>` 0.07 to 0.7% under the veth's bytes. R3: the 0.5 GB bucket emptied 48 s into the upload, the slot slowed within the 10 s tick and stayed at 0.75 Mbit/s; after `[slot2]` came out it stayed slowed, as `td223-shaper.md` says, until stopped with its state deleted. R4's five floods (three repeats) put at most 18.6 GB in the host's aligned buckets (19.0 over any five 1-minute points), under the 31.5 GB the judge allows, and moved D1's B12 p50 by 0.3 ms, so nothing says `ens5` needs `fq_codel`.
- **R5, the negative control:** `desk-host shaper 2 off` took slot 2's classes off (`noqueue`, the check FAILs naming it); its `kiosk` upload went out at 300 Mbit/s, 11.2 GB a window, the guard's count within 0.04% of the veth's; the guard's own rules (`ma-platform` `scripts/throttle-root-check.mjs`) on the slot's clock-aligned buckets give `throttle_bucket` in both repeats (11.24 and 10.11 GB against 7; no stop, 14.6 GB in 15 minutes against 30). `shaper 2 on` put the classes back and the check passed at once. The slot's budget doesn't count what it sent while off (`dayGb` 4.868 after, the R4 share only): only the guard's count saw it, as section 8's design says. The guard's per-slot stop with `CostGuardTestLimitGb` wasn't tried: the lab host isn't a staging host the guard reads slots on.
- **The CPU rule fails in R1, R4 and R5,** the viewer's `desk-stream` 1.1, 4.5 and 1.75 points over its R0 against 1, while nothing a member sees moved; the machine was about 30% of 4 vCPUs at R0, 36% at R4 and 32% at R5, no steal. The cost grows with the neighbours' forwarded traffic (0.6 to 1.1 points a 100 Mbit/s), and R5's neighbour had no shaper at all, so it isn't the shaper's: the host kernel (Debian 13, 6.12 arm64) has `CONFIG_IRQ_TIME_ACCOUNTING` off, as the desk kernel had, so a neighbour's forwarded upload's softirq (veth, NAT, `netem`) is charged to whatever task it interrupts, `desk-stream` included. Nothing tuned: the System Engineer's call, as the desk-of-its-own row's was.
- **The prod cost guard stopped each lab's host once its R4 floods put over 30 GB in 15 minutes** (12:16 and 15:11 MT, rule `fast`, after a `throttle_bucket` flag on each), since a lab host without `HostKind=shared` is read as one desk. That, not SSH, lost the first lab's second R4 repeat. The second lab then drove the host through the client on its private address (`h17.sh` `SA_VIA_CLIENT=1`), finished R0 and R4 on a fresh host from the same AMI, and kept its heavy rows 15 minutes apart. Spend about $4.68 of $5 over both labs; everything tagged `Owner=guild-td223` is deleted. **Not run:** R1's rerun beside a fresh R0 (budget), R2's `rtc` part (by rule), and test 5's real tabs on the unseen desks.

## Addendum, 2026-11-11: the clamp counts `desk-rtc`, the day lines look ahead, and the profile test through a real `desk-rtc` (S-29, 16 D items 2 and 3)
Marks as above. Simulations by the minute with the real `Budget` class, as the weekend review's were: `image/lab/s29/sim.py`, outputs in `image/evidence/s29-2026-11-11/`. Viewers at their hard caps the whole time, from 00:00 on the 1st of a month so the month line can't step the stream down first.

### Item 2: the clamp fired on honest use
**Found (weekend review 16 D, CONFIRMED again here):** layer 5's clamp and the day lines all counted every class, so a clamp meant for a broken `desk-rtc` held honest viewers to 1 Mbit when anything else was sent, and the stream steps came too late for more than one viewer: two viewers and a 25 GB upload reached the guard's 150 GB `day` stop at hour 21.9, three viewers were clamped for 9 hours. Section 4's "A false stop" listed only `month`.

**Decision, in the rule functions only (`Budget.tick`, so the shared host's per-slot `desk-egress` gets the same):**
- **Layer 5 counts 1:10 alone,** in its own 24 h window of 5-minute slots: 135 GB, released under 120, as before. Its job is a broken `desk-rtc`; an upload beside honest viewers is the bucket's business.
- **Layers 3 and 4 keep counting every class,** because they hold the guard's `day` and `month`, which do. But their day lines now look ahead: `ahead` is the most the 24 h window would reach if the stream went `deep` now and stayed there (the window's highest point is just before one of its slots ages out). Deep's rate is estimated from the stream's 15-minute moving average, scaled by each profile's share at its cap (High 3.75, capped 1.89, deep 1.20 GB/h). Past 100 GB of `ahead` the stream goes `capped`, past 105 `deep` until under 95 (was a plain 24 h total, 100 and 120 until under 100). 105 leaves the bucket's 30 GB and its 10.8 GB refill under the guard's 150. Back to `normal` only if the window could take `normal` at Max (5.55 GB/h): seen from `capped`, Max and High look alike, and without this a member at Max went up and down every hour (19 switches in 72 h with two viewers).
- The month lines (100 and 500 GB) are unchanged. `egress.conf` keeps its keys; `deep_day_gb` is 105 and `deep_day_release_gb` 95. The state file gains `stream_windows` and `deep_rate`; a state from before keeps everything else.

| Case (hard caps, from the 1st) | Clamp, before | After | Peak 24 h GB, before | After | Guard `day` stop, before | After | capped / deep at h, before | After |
|---|---|---|---:|---:|---|---|---|---|
| 1 viewer | never | never | 90.7 | 90.7 | never | never | 26.5 / never | 26.5 / never |
| 1 viewer at Max | never | never | 111.7 | 101.3 | never | never | 17.9 / never | 15.1 / never |
| 2 viewers | never | never | 133.3 | 105.4 | never | never | 13.3 / 18.5 | 8.3 / 11.8 |
| 2 viewers, 6 GB a day other | h 23.4, 169 min | never | 135.5 | 108.7 | never | never | 12.9 / 17.8 | 7.9 / 10.9 |
| 2 viewers, 25 GB upload at h 20 | h 20.2, 486 min | never | 151.0 | 130.4 | **h 21.9** | never | 13.3 / 18.5 | 8.3 / 11.8 |
| 2 viewers, 30 GB upload at the worst hour | h 23.1, 405 min | never | 161.6 | 135.4 | **h 23.4** | never | 13.3 / 18.5 | 8.3 / 11.8 |
| 2 viewers at Max, 30 GB at the worst hour | h 20.4, 478 min | never | 166.8 | 134.5 | **h 21.3** | never | 9.0 / 14.2 | 2.0 / 23.0 |
| 3 viewers | h 16.5, 551 min | never | 138.6 | 105.6 | never | never | 8.9 / 12.4 | 1.8 / 4.1 |
| 3 viewers, 30 GB at the worst hour | h 16.5, 716 min | never | 168.6 | 135.6 | **h 17.3** | never | 8.9 / 12.4 | 1.8 / 4.1 |
| 4 viewers, the session limit | h 12.4, 1,219 min | never | 140.6 | 120.7 | never | never | 6.7 / 9.3 | 0.5 / 0.5 |
| 3 viewers at Medium, 30 GB at the worst hour | h 23.2, 486 min | never | 158.1 | 147.4 | **h 23.5** | never | 17.6 / 21.1 | 14.5 / 14.6 |
| Broken `desk-rtc` | h 5.0 | h 5.0 | 144.3 | 144.3 | never | never | | |
| Broken `desk-rtc`, bucket saturated | h 3.8 | h 5.0 | 153.2 | 184.6 | h 20.4 | **h 4.4** | | |

- **What it costs a member:** more viewers step down sooner. Two viewers at High's cap are capped at hour 8.3 (was 13.3) and deep at 11.8 (was 18.5); three are deep at hour 4.1, and four almost at once. Frame rate is never touched, and no honest case is clamped any more, where before 2 to 4 viewers lost their video to 1 Mbit for 3 to 20 hours.
- **Section 5's table, rerun** (31 days, `test_desk_egress.py`'s `AdrTable`): two viewers nonstop now peak at 105.4 GB in 24 h (was 133) and 1,996 GB in the month (still the `month` stop); one viewer with non-stream saturated 107.7 (was 117), 1,411 in the month. The other rows are unchanged.
- **What it gives up:** a broken `desk-rtc` beside a saturated bucket now reaches `day` at hour 4.4, not 20.4, because the clamp no longer counts the bucket's traffic. Both cases ended at the stop before, and a broken `desk-rtc` is the "bug or hack" the stop is for; it stops sooner, so it costs less. With honest other traffic the clamp still holds `day` (144.3 GB).
- **Where the estimate is low:** members at Low or Medium under `normal` send closer to deep's rate than High's share assumes, so the step comes later. Three viewers at Medium with a whole-bucket upload at the worst hour peak at 147.4 GB, under the stop by 2.6. `desk-egress` can't see the level; `desk-rtc` could publish it if this needs to be exact.
- **Tests that fail on the old rule:** `test_desk_egress.py`'s `HonestViewers` (8 tests: two and three viewers with a whole-bucket upload at four hours, 6 GB of other traffic, two at Max, four viewers; 9 failures on `main`'s `desk-egress`) and `Lookahead.test_the_clamp_counts_desk_rtc_alone`. 84 of 84 pass on the new one.

### The capped profile and the member's level (S-29, ADR 0039's addendum of this date)
`stream-capped.conf` (`desk-stream` 0.3.5) holds each level to its picture, so Low stays Low; `desk-rtc` 0.5.1 reads `/run/desk-egress/profile` and holds the level at Medium (`capped`) or Low (`deep`), and its reply says held.

### Item 3: section 6's test 1, the profile part, through a real `desk-rtc` (ran 2026-11-11)
Section 8 left "the pause at a profile change through a real `desk-rtc`" unproven, and the review found the first such change would happen live, at a member's 100 GB.
- **Where it ran:** on the coordinator's change of plan, a temporary staging test desk of this task's own, not the shared one. A c7g.large on image 0.3.3 with `desk-rtc` 0.5.1 and `desk-stream` 0.3.5, test account `desk-2`.
- **How:** a member's session through the real office app and Browser window, W3's 1080p60 synthetic clip playing (`e2e/w3/profile.spec.ts`).
  - **To capped,** as at 100 GB, through `desk-egress`'s own tick: its `egress.conf` gets a 1 kB month line and a 5 s tick, and it restarts.
  - **Back to normal,** with its conf and state put back. Both restore at the end, pass or fail.
- **What it measures:** page fps is the desk's own rAF, one report a second, and the verdict. The client's decoded fps comes from getStats. The client was this workstation's headless Chrome at 52 to 57 ms RTT.
- **Runs:**
  - Two complete runs on 0.3.5: the member on Max across both switches, then on Low.
  - One run on 0.3.4 found the start bug below.
  - One more stopped in the spec, not on the desk: a stats second came back without a video entry, and the spec now skips such seconds. The desk's switch was clean there.

| Run, level asked | Phase | Page fps: samples, avg, p5, min | Decoded fps avg, p5 (s) | Mbit/s | Pause ms | Decoded at 30+ again, ms after the pause | The desk's reply |
|---|---|---|---|---:|---:|---:|---|
| 2, Max | normal | 30, 60.0, 59.9, 59.0 | 59.7, 58 (30) | 11.97 | | | max |
| 2, Max | **to capped** | 45, 60.0, 59.9, 59.1 | 59.6, 59 (45) | 4.60 | **250** | **623** | **medium, held, ceiling medium** |
| 2, Max | capped | 30, 60.0, 59.9, 59.1 | 59.8, 58.5 (30) | 3.42 | | | medium, held |
| 2, Low | capped | 30, 60.0, 59.9, 59.0 | 59.9, 59 (30) | 1.98 | | | low (1280x720) |
| 2, Max | **back to normal** | 45, 60.0, 59.6, 58.9 | 59.6, 59 (45) | 11.75 | **250** | **655** | **max** |
| 2, Max | normal | 30, 60.0, 59.8, 59.1 | 59.8, 59 (30) | 11.99 | | | max |
| 4, Low | normal | 30, 60.0, 59.4, 58.9 | 59.8, 59 (30) | 1.98 | | | low |
| 4, Low | **to capped** | 45, 60.0, 59.9, 59.1 | 59.6, 59 (45) | 1.99 | **250** | **717** | **low, ceiling medium** (not held: Low is inside the cap) |
| 4, Low | capped | 30, 60.0, 59.9, 59.0 | 59.8, 59 (30) | 1.96 | | | low (1280x720) |
| 4, Max | capped | 30, 60.0, 59.9, 59.0 | 59.9, 59.5 (30) | 3.42 | | | medium, held |
| 4, Low | **back to normal** | 45, 60.0, 59.8, 59.0 | 59.6, 58.2 (45) | 1.98 | **233** | **549** | **low** |
| 4, Low | normal | 30, 60.0, 59.9, 58.9 | 59.8, 59 (30) | 1.95 | | | low |

- **Page fps never went under 58.9** in 420 one-second samples, both switches included. The stream came back each time: one pause of 233 to 250 ms (the longest gap between presented frames, and WebRTC's one freeze of 0.23 to 0.25 s), decoded frames at 30 a second or more again 0.55 to 0.72 s after it, no packet lost, the session kept.
- **The member's word:** on a capped desk the real menu said "This desk is held at Medium for now." The reply came with `desk-stream`'s first connection after the profile changed.
- **The pause:** 233 to 250 ms here, against section 8's 158 to 175 ms with a stand-in. This is the whole restart as a member sees it: `desk-stream`'s start, the level, the keyframe and the client's jitter buffer. A real crossing comes at a tick, at most every hour in the sharper direction, two or three times a month.
- **The start bug it found:** run 1 (`desk-stream` 0.3.4) paused 3.8 s going back to normal at Max, because a new `desk-stream` told Max failed twice with "encoder not initialized" before a third start held.
  - On the same desk with a stand-in for `desk-rtc`, starts at Max failed 4 of 10.
  - With `desk-stream` 0.3.5, which takes a level's encoder values after the first frame, 20 of 20 starts at Max were clean, plus 5 of 5 at Medium and 5 of 5 at Low.
  - It predates S-29: any `desk-stream` restart with a member on Max hits it.
  - Evidence: `image/evidence/s29-2026-11-11/start-level-*.txt`.
- **Not covered:**
  - Test 1's other rows: no shaper, the shaper idle, `kiosk` saturating 1:20, and the bucket empty with an upload. They still need a `Purpose=browser-benchmark` box.
  - The `deep` profile on the real stack.
  - Real footage: the clip is synthetic and fills each ceiling.
  - A client near the desk: latency isn't judged here.

## Addendum, 2026-11-11: the `kiosk` row's CPU is accepted (the System Engineer's call)
Test 1's `kiosk`-saturating row on a desk of its own (result of 2026-11-11 above) put `desk-stream` 2.2 and 2.4 points over no shaper against a limit of 1, and +1.9 to +2.5 when repeated. Everything a member sees held: 60 fps, B12 and B13 in budget, no drop on 1:10, 0 packets lost and 0 freezes in every repeat. **Accepted, not reduced.**
- **What it is:** HTB's per-packet work on about 10,000 packets a second of the desk's own `kiosk` upload (about 4 to 5 µs a packet). It appears only while that desk saturates its own 100 Mbps class, and ends with the upload or when the bucket empties (the bucket-empty row passes).
- **Why accept:** the CPU rule stands in for the picture, and the picture didn't move. The machine had room: 61.8% of its 2 vCPUs at the worst repeat, the flood's own sender included. Reducing the cost means a cheaper qdisc or no ceiling on 1:20, and either gives up what the shaper is for (section 5, ADR 0082's stops).
- **The rule from now on,** for a desk of its own: `desk-stream` CPU within 1 point of no shaper with the shaper idle or the bucket empty, and within 3 points while the desk's own `kiosk` class saturates, every other rule unchanged.
- **Shared hosts are unchanged:** the 2026-11-09 addendum's rule that the viewer D1 stays within 1 point of R0 while its neighbours flood (R1 to R4) stands. A neighbour paying for another desk's flood is a different question, and those rows answer it. The per-slot shaper, its counters and `desk-host shaper <k> off|on` are in host image 0.1.11 (TD-223), so test 1 on a shared host can run on a lab host of its own from that image (`docs/sub-status/td223-shaper.md`).
