# 0070. The Agent reaches only the providers' names: a small filter on TLS SNI and DNS

**Status:** Proposed. Built and tested on `sub/agent-egress-filter`, now at `desk-agent-filter` 0.1.1 (2026-11-07). 0.1.0's test bake, `ma-desk-test-filter-2`, passed `verify.sh` 34 of 34 and `count-address.sh` 0, and its clean numbers found that 30 fast downloads at once got it killed at `MemoryMax=32M`. 0.1.1 bounds each connection's buffers and closes that ("Memory", below). Every check failed when broken, on both. 0.1.1's test bake on image 0.2.8, `ma-desk-test-filter-3`, passed `verify.sh` 42 of 42 and `count-address.sh` 0. On no desk until the next bake.
**Date:** 2026-11-07

## Context
The owner, on the allow-list `desk-agent` had, which "works by address, and OpenAI and xAI share Cloudflare addresses, so other sites behind Cloudflare stay reachable": "Yeah we must do it right".

`desk-agent` (uid 1103) holds members' provider keys and reads whatever a provider sends back, so it's the part most likely to be talked into sending something somewhere. Measured here: from the old rules' point of view `www.cloudflare.com` is on the addresses of `api.openai.com` and `api.x.ai`, and a TLS handshake for it completes on both (`verify-agent-filter.sh`, `F-CF`'s controls). The threat is that agent, or code running as it, sending data to a site that isn't a provider, or fetching instructions from one.

Binding: it runs the same on self-hosted desks, it's never sluggish, it fits the outbound throttle (ADR 0036), and the platform sees none of it.

## Decision
`desk-agent-filter`, a Go program with no dependencies (`image/recipe/desk-agent-filter/`, about 800 lines), as its own uid 1106 with no capabilities. `desk-agent` doesn't change. Operating detail: `image/README.md`, "desk-agent-filter".

- **nftables redirects, whatever the address.** A `nat` chain sends uid 1103's TCP 443 to `127.0.0.1:14443` and its DNS, UDP and TCP, to `127.0.0.1:14053`. Only uid 1103 may reach those ports, root included. The address sets and `desk-agent-egress` are gone. UDP stays refused, so no QUIC.
- **The TLS side.** It reads the ClientHello (5 s, 16 KiB, split across records and segments, strict) and refuses no SNI, any name that isn't exactly in `/etc/ma/agent-egress.conf`, and `encrypted_client_hello` (0xfe0d). It resolves the name itself through the stub, keeps only global unicast addresses, never IPv4 inside IPv6, and ignores the address the client aimed at. Then it forwards the hello's bytes and splices both ways. No interception, no keys.
- **The DNS side.** A listed name's A is a placeholder that's never routed, `192.0.2.1`, because the redirect takes the connection first. AAAA is empty. Anything else is NXDOMAIN or FORMERR. It never forwards, so a tunnel over it has nowhere to go.
- **uid 1106** reaches TCP 443 on public addresses and DNS at `127.0.0.53`, and answers on its own ports. Nothing else. Those ranges are in nftables as well as in its code.
- **It fails closed.** With it down, the redirect lands on nothing and uid 1103 gets connection refused. `Restart=always`, 1 s.
- **Each connection's buffers are set, and 64 connections at most** (0.1.1). From the provider 256 KiB and to it 64 KiB, from `desk-agent` 16 KiB and to it 256 KiB, 16 KiB each way on DNS over TCP, each doubled by the kernel. So its memory has a ceiling whatever either end does, and `MemoryMax` holds all 64 with every buffer full. See "Memory".
- **A sandbox as tight as it runs:** `MemoryMax=96M`, an empty capability set, `NoNewPrivileges`, `ProtectSystem=strict`, `InaccessiblePaths=-/data`, `PrivateUsers`, `RestrictAddressFamilies=AF_INET AF_INET6`, `SystemCallFilter=@system-service` less the privileged groups.

**Changed from the System Engineer's design, each because a run or a review showed why:**
- uid 1106, not the next after `stream` 1104: the Notebook work has claimed 1105.
- **uid 1103 is refused anything that still shows port 53 or 443 after the redirect.** One of about 30 proof runs caught uid 1103 getting a real TXT answer and a real A answer from the stub. A `nat` chain sees only a connection's first packet, and conntrack keys on addresses and ports, not on uid. So when uid 1103 picks a source port another uid has just used to ask the stub, conntrack's entry for that uid carries the packet past the redirect, and loopback was open. By chance it's rare, but a compromised agent could do it on purpose, trying source ports, and have real DNS to tunnel through. The check `F-CTHOLE` does it on purpose, and it fails without the rule. The same accident the other way round costs a query: another uid's lookup can land on uid 1103's entry, be refused, and be retried.
- **It asks for IPv4, and for IPv6 only if that didn't connect,** rather than for both at once. A lookup of `ip` can't tell IPv4 from IPv4 inside IPv6, because `/etc/hosts` gives Go's 16-byte form. That meant the check of private answers was passing for the wrong reason. It also saves a query on every connection.
- **The rules match addresses, not `oif "lo"`.** The output hook keeps the interface a packet was first routed to, so a redirected packet still shows `ens5` in the filter chain at priority 0. The first version refused everything for this reason.
- **Only uid 1106 may answer from the two ports.** With the filter down, any other uid could bind them and stand in. It couldn't read TLS, but it could see names and answer DNS. Added, with a check (`F-SQUAT`).
- **A half-closed connection is bounded at 10 minutes.** A client that has gone looks like a half-close until something is written back, and a silent provider would keep its slot for ever. No other time limit applies.
- **Its buffers set, 64 connections, `MemoryMax=96M`** (0.1.1), from 0.1.0's TCP-tuned buffers, 256 connections and 32M: 0.1.0's clean run had the kernel kill it at 32M with 30 fast downloads at once ("Memory").
- **Not a published release.** `bake.sh` builds it from the recipe to the hash in `releases.pin`, with the Go version the package script names, so a bake publishes nothing. See Consequences.

## What it can't stop
Plainly, because a name filter is not an inspection of what's inside TLS.

- **Domain fronting.** A client names a listed host in SNI and another site in the HTTP `Host`. The filter sees only the SNI, so the request gets through to the provider's edge every time. What that edge does with it isn't ours to decide. Measured, one GET each, no key: SNI `api.openai.com` and `api.x.ai`, `Host: www.cloudflare.com`, both **403** from Cloudflare, a 151-byte "403 Forbidden", the same answer as the control sent directly by a uid the filter doesn't hold. SNI `api.anthropic.com`, the same Host: **403**. So today these three refuse that one site. That isn't a promise about every site behind them, or about tomorrow, and it's the edge refusing, not us.

- **An agent sending data to a provider under a different key.** A prompt-injected agent or code running as uid 1103 can put data in a request with a key an attacker holds, to `api.openai.com`, and read it from the attacker's account. The request is TLS to a listed name, and nothing here can tell whose key it is. Not measured: there's nothing to measure, and no key of any kind was used. The Agent's own controls (ADR 0019) and limits are what stand there.
- **A second hello.** It reads only the first ClientHello. A HelloRetryRequest or a TLS 1.2 renegotiation could carry another name, which is the same hole as fronting, on the provider's own edge.
- **Resolved's Varlink socket, on the host only.** `/run/systemd/resolve/io.systemd.Resolve` is world-writable, so a process with uid 1103 on the host has real DNS, TXT included: measured with `resolvectl`. `desk-agent` runs in a container that doesn't have that path (`F-CT`), and nothing else runs as that uid. A container escape would reach it.
- **uid 1103's loopback stays open** (`F-LOOP`), as it was. On a desk that's `127.0.0.53` and `127.0.0.54`, which redirect takes, and `containerd`'s stream port, which needs a token. Chromium's 9222 and IMDS are refused.
- **A client that sends ECH GREASE,** as Chromium does, is refused like real ECH. The JDK's client doesn't send it. An Agent feature that drives Chromium to a provider would need its own answer.

## Numbers
`desk-agent-filter` 0.1.1, one clean run with nothing else on its box (`image/evidence/agent-filter-2026-11-07/numbers.txt`, numbers-5): a t4g.medium from the test bake `ma-desk-test-filter-2`, with 0.1.1 and its unit installed by `ma-update` as a bake lays them out. The stand-in provider was on its private address in the same zone, after Platform's cost guard stopped a public one (below), so for the run the filter was a lab build that also allows that one address, with one nftables rule for uid 1106 to it, both removed after (`lab/agent-filter/lab-private-standin.patch`). The real providers, with no key, were reached as on any desk. Direct is uid 1102, in the same shaper class. `GOMAXPROCS=2`, as the unit sets.

| What | Result |
|---|---|
| CPU, 1 stream, 60 events a second of 150 bytes | 1.0% of a core (40 s, an earlier clean run of the same code path) |
| CPU, 20 streams, 60 events a second | 6.1% of a core over 30 s (6.2% with `GOMAXPROCS=1` in the earlier run) |
| Memory: idle; with 20 streams | RSS 4.2 to 6.2 MiB (cgroup 2 to 4 MiB); 6.4 MiB (cgroup 5) |
| The cap: 100 opened at once | 64 held, 36 refused, 395 descriptors of 2,048, cgroup peak 7 MiB |
| Bulk down, 300 MB, twice each way | Through it 4,713 and 4,577 Mbit/s; direct 4,924 and 4,928. On the public path, three rounds of 1 GB against 0.1.0: 3,069, 3,145 and 2,971 against 2,885, 2,979 and 2,957 |
| Bulk up, 300 MB each way | 99 Mbit/s through it and 99 direct, against class 1:20's 100 |
| `MemoryMax=96M`, many at once | 30 downloads of 100 MB, the run that killed 0.1.0: peak 35 MiB, all 30 whole. 64 of 10 MB, the cap: peak 49 MiB, all whole. 64 uploads of 2 MB behind the shaper: peak 19 MiB, all whole. 0 kills, 0 restarts |
| Added time to first byte, stand-in, n=300 each way | p50 2.91 to 3.61 ms (+0.70), p95 3.40 to 4.51 ms (+1.11) |
| The same, real providers, no key, n=200 each way | Anthropic p50 36.96 to 37.72, p95 60.76 to 56.39. OpenAI p50 72.31 to 72.04, p95 117.16 to 119.14. xAI p50 80.62 to 83.61, p95 99.16 to 100.26. All ms: within 3 ms at p50, and p95 moves both ways, within their noise |
| Idle, 600 s, the same process throughout | 441 µs of CPU, 0 clock ticks, 20 context switches; RSS 4.2 MiB |

Each row is one run on one box. 0.1.0's clean run (numbers-4) matched these but for memory. Lab runs before the pause overlapped each other, so their numbers are void.

## Memory: each connection's buffers (0.1.1)
The kernel charges a connection's socket buffers to the unit's memory cgroup, and TCP grows them, a receive buffer to 6 MiB by Debian's default, whenever one end sends faster than the other reads. In 0.1.0's clean run, 30 downloads of 100 MB at once from the stand-in filled `MemoryMax=32M` with 32.6 MiB of `sock`, against 52 KiB of the program's own memory. The kernel killed it, all 30 failed, and systemd had it back in 1 s. One kill cuts every Agent stream in flight.

0.1.1 sets every connection's buffers, so its memory has a ceiling whatever either end does. They're set per direction, because uploads wait on the shaper's 100 Mbit/s whatever their buffers, while a download needs room to keep its speed. Before the kernel doubles them:

| Direction | Buffer |
|---|---|
| From the provider (`SO_RCVBUF`), to `desk-agent` (`SO_SNDBUF`) | 256 KiB each |
| To the provider (`SO_SNDBUF`) | 64 KiB |
| From `desk-agent` (`SO_RCVBUF`) | 16 KiB |
| DNS over TCP, each way | 16 KiB |

So a connection holds at most 1.16 MiB, and 64 of them 74 MiB, which `MemoryMax=96M` holds with the DNS side's 2 MiB and the program's few. The cap went from 256 to 64: `desk-agent` makes one call at a time for each agent, so it needs far fewer, and 256 would need 296 MiB. `MemoryMax` is a ceiling, not a use: idle, the filter still uses about 4 MiB. `F-BUF` reads the buffers on a live provider connection on every verify.

**How the sizes were chosen** (numbers.txt, the two explorations, `MemoryMax` raised to 1G for them so the true peaks show):

| Variant | 1 GB down, Mbit/s | Peak, 64 or 30 fast downloads | Peak, 256 uploads |
|---|---|---|---|
| 0.1.0, TCP's own tuning | 2,885 to 3,151 | 80 MiB for 30 | 101 MiB |
| 128 KiB to the provider, 64 KiB to `desk-agent`, both ways | 2,200 and 2,413 | 17 MiB for 30 | 104 MiB |
| 64 and 32, both ways | 1,154 and 1,333 | 13 MiB for 30 | 60 MiB |
| 0.1.1's | 2,971 to 3,145 | 68 MiB for 64 | 53 MiB |
| 192 KiB down each side, uploads as 0.1.1 | 2,718 to 2,876 | 52 MiB for 64 | not run |

**What it costs, by arithmetic, not measured:** one connection's download from a provider 100 ms away would get about 20 to 30 Mbit/s from 512 KiB of receive buffer. The providers are about 1.5 ms from a cloud desk (TCP connect, n=15 each, from the lab box), where that's gigabits. A self-hosted desk far from them gets less on one connection than TCP's own tuning would give. Not measured: whether Go's splice pipes, which can hold up to 1 MiB each way on a connection, are charged to the unit. The peaks above didn't show them.

**The cost guard.** The explorations sent about 46 GB from the public stand-in to the lab box in 15 minutes, and Platform's cost guard (`ma-prod-cost-guard`) stopped that stand-in at 12:21 UTC, as it should. The final run then used the private address in the zone, about 5 GB. `lab/agent-filter/measure.sh` says to keep a run so.

## Conntrack and the stream
The chain doesn't bring conntrack onto any traffic, because it's already there. On the test desk before anything was installed, `nf_conntrack` was loaded and tracking (100 entries), since `table inet ma`'s input chain has `ct state` rules. The chain adds `nf_nat`, `nft_redir` and `nft_chain_nat`, and it sees only a connection's first packet, so `notrack` isn't needed for the stream.

The test desk (c7g.large), `stream.spec.ts`'s test 2, the page's own fps while the wheel scrolls for 30 s, in order. This is a real stream at about 55 ms RTT, with the filter running on the middle row:

| Runs | Page fps, avg | p5 | Machine CPU | `desk-rtc` | Packets lost |
|---|---|---|---|---|---|
| Without the chain, 3 | 60, 60, 60 | 59, 59, 59 | 59.1, 54.4, 54.0% | 6.2, 5.9, 5.5% | 0 |
| With it, 3 | 60, 60, 60 | 59, 59.8, 59.9 | 54.4, 55.9, 54.9% | 6.0, 5.8, 5.7% | 0 |
| Without it again, 2 | 59.9, 60 | 59, 59 | 55.8, 55.1% | 5.9, 5.7% | 0 |

No difference shows, and repeats vary by more than any there might be. With it on, all of `stream.spec.ts` (8), `browser-window.spec.ts` (1) and `agent-relay.spec.ts` (1 passed, 1 skipped, for a desk with no `desk-agent`) passed.

## Fits the throttle (ADR 0036)
The filter's traffic on `ens5` is in the default class 1:20, as the agent's was, because no rule labels uid 1106. A 300 MB upload through it went at 99 Mbit/s against the class's 100, the same as direct, and class 1:20 moved 303,108,488 bytes against 18,189 in 1:15 (numbers-5, and `F-CLASS` checks the same on every verify). Loopback isn't shaped, so nothing is counted twice. Self-hosted desks have no shaper, and the same checks pass there with it skipped.

## Rejected
- **An explicit proxy** (`DESK_AGENT_EGRESS_PROXY`, the CONNECT proxy in `deskd` that design 9.8 describes, which doesn't exist). It needs `desk-agent` to change and to behave: a compromised client just doesn't use it, so nftables has to enforce the same thing anyway, and the name it sends in CONNECT is one more thing that can differ from the name in TLS. It would put `deskd`'s uid, whose class is capped at 2 Mbps, on the agent's traffic.
- **nginx `ssl_preread`, or HAProxy.** Both read SNI well, and the first version of this could have been a config file. But each is a package with far more than it needs here, on a member's desk and in the bundle, tens of MB against a 2.3 MB static binary. Neither answers DNS, refuses ECH or keeps only global addresses without more parts, and both resolve names in their own way, at config load or with a resolver block.
- **Ignoring ECH.** A client could name a listed host on the outside and a different site inside, and the filter can't read the inside. The name it checked would then mean nothing, on Cloudflare above all. So ECH is refused, and that's why no client here may use it.
- **TLS interception.** It could read the `Host` header and stop fronting, but only by holding a CA that `desk-agent` trusts and seeing every member's key and prompt in clear on the desk. It's the opposite of what the design promises, and it's a far larger thing to get right.
- **Keeping address sets as a second check.** They add nothing once the filter picks the address itself, and they needed a root timer every 5 minutes.

## Consequences
- **New names need a line and a restart,** `/etc/ma/agent-egress.conf` then `systemctl restart desk-agent-filter`, which drops calls in flight. A new provider for every desk is a recipe change and a bake.
- **A bake needs the named Go, 1.27.3, on the machine that bakes.** A different one changes the hash, and `bake.sh` refuses it with that reason. A source change needs a new version and hash in the pin.
- **It's a component like the others:** `ma-update` can roll a fix without a bake, `smoke-test` checks its health, and with it down an update of any component rolls back. Rolling it needs a publish, which nothing has done yet, and an image with its unit.
- **Every rule change is now in two nftables files,** as before. `selfhost/files/etc/nftables.conf` has the same block.
- **Older self-hosted desks:** `install.sh` takes `desk-agent-egress` off when it updates one. A new `install.sh` refuses a bundle with no `desk-agent-filter`.
- **Each of the numbers above is one run on one box.** Nothing has run on a member's traffic or with a real key, because no real key has touched `desk-agent` yet.
- **`verify.sh` makes 42 checks** with this section, 3e1, and image 0.2.8's. 3e1 adds about 2 minutes and needs the internet.
