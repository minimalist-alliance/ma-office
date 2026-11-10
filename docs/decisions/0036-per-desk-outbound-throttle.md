# 0036. A per-desk outbound throttle, so the cost guard's stop is the last resort

**Status:** Proposed (TD-223, T57). The on-desk half is in every image from `ma-desk-0.2.4` (`image/RELEASES.md`): the test desk, the owner's desk since it took 0.2.6, and every desk new from staging's and prod's `desk_image#current`, 0.2.9 since 2026-11-07. **Section 6's test 1, video through the shaper, didn't run before it reached them,** against "before anything reaches a member desk"; section 8's lab and `verify.sh` section 3d are all that's proven, so the first real profile change through a real `desk-rtc` happens live, when a desk passes 100 GB. The guard's half (`fast` at 20 GB, the 7 and 140 GB flags) isn't built in `ma-platform`, so nothing reports the shaper's state. ADR 0082's stops stay live. For launch it leaves out `deskd`'s `egress` field, the panel line and the "slowed" flag. *(Status updated 2026-11-07 from the weekend review; it said "not baked and on no desk".)*
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

**Prerequisites, for the System Engineer.** (1) A staging shared host that can carry N desks with per-desk shapers on the veth: **not built** (ADR 0072: "the shaper on a veth" is on the not-built list; no staging shared host can exist until Platform's host link, placement and pairing are). (2) `desk-host` writes each slot's `tc -s class` counters and `net.json` to its report, so the judge's `classes_mbps` and `guard_tx_gb` can be read. (3) A way to remove one slot's shaper for R5 without root in the desk. (4) The test-5 harness (`sh5.sh`) taking a flooder step. None of these is in this change.

**What stays from the original test 1.** Desks of their own (the Alliance size and the owner's) keep section 6's rows 1 to 4 as written; they still need `spikes/browser-bench/real-stack/` on a `Purpose=browser-benchmark` box. The questions section 8 lists as unproven (capped and deep at the real size, QUIC's ACKs, the profile-change pause through a real `desk-rtc`) are test 2 and test 4 items and unchanged.

