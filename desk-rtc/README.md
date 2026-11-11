# desk-rtc

The desk's single WebRTC endpoint, plus the dev tools around it. Spec: `docs/interfaces/desk-runtime.md`, design §4.2, ADRs 0008, 0022, 0023.

| Binary | What it is | Runs where |
|---|---|---|
| `desk-rtc` | ICE-lite on one UDP socket and one passive ICE-TCP listener, the eight data channels, the `rtc.sock` bridge to `deskd`, RTP from `desk-stream` to each session viewing, input injection into `:99`, and the X side of the clipboard | Desk, as `rtc` |
| `gateway-shim` | **Dev only, not for production.** Stand-in for `gw.` (contract 0.3.3) and a few `api.` routes. No SigV4, no Cognito, and anyone who can reach it gets tokens | Your machine |
| `fake-deskd` | Tests only. Speaks `rtc.sock` and the gateway link, answers `HELLO` and `desk.status.get` | Your machine |
| `deskctl` | Pion client. `deskctl status` opens a real session and calls `desk.status.get` | Your machine or a test desk |

## Build

Go lives in `~/.local/go`.

```bash
./build.sh                  # version from git: 0.2.0-<sha of desk-rtc/>[-dirty]
VERSION=0.2.1 ./build.sh    # explicit version
```

Output in `dist/`, with `CGO_ENABLED=0`:

| Path | What |
|---|---|
| `arm64/`, `amd64/` | `desk-rtc`, `deskctl`, `gateway-shim`, `fake-deskd` |
| `desk-rtc-<version>.tgz`, `.tgz.sha256` | The release artifact `ma-update` installs (`desk-runtime.md` §6): `VERSION`, `run`, `health`, and the arm64 `desk-rtc`. The dev tools never go in it |

`run` execs `$RELEASE_DIR/desk-rtc` with the production flags and `GOMEMLIMIT=96MiB`, which keeps the Go heap under the unit's `MemoryMax=128M` with room for what the runtime doesn't count. A `GOMEMLIMIT` the unit sets wins. `health` exits 0 when the `desk-rtc` unit is active and it holds UDP and TCP on its port; as root, it also checks that `desk-rtc` is the process holding them.

**The port is a desk setting.** `run` passes `--config /etc/ma/desk-rtc.conf` and no `--port`. With no file there, as on every cloud desk, `desk-rtc` listens on 443. A self-hosted desk's installer writes `port=4443` there, because Chrome drops a home-network ICE candidate on a port below 1024 (`selfhost/README.md`, "The port"). `health` runs `$RELEASE_DIR/desk-rtc --config … --print-port` to learn which port to check, so it always checks the one `run` listens on. The file is `key=value` lines, `#` comments; `port` (1 to 65535) is the only key so far. A value it can't use stops `desk-rtc` with a `config:` error, and `health` fails with it; a key it doesn't know is logged and skipped, so a file written for a later version doesn't stop an older one. `--port` on the command line wins over the file (dev runs). `DESK_RTC_CONF` names another file for `run` and `health`, for tests. Code: `cmd/desk-rtc/config.go`. From 0.5.0 a shared host's slot adds `tcp_port`, `slot` and `public_ipv4` ("Shared hosts", below); `health` then checks UDP on `port` and TCP on `tcp_port` (`--print-tcp-port`).

The unit needs `User=rtc`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `SupplementaryGroups=desk` and `After=network-online.target`: `run` passes `--socket-group desk`, and `--bind auto` needs a default route at startup. It also needs `/run/desk-media` in `ReadWritePaths`. On an older image with no `stream` user or `/run/desk-media`, `desk-rtc` logs a warning and runs without video: data channels and input still work.

## Test

```bash
go test -p 1 -parallel 1 ./...                                  # about 1 minute, light on CPU
go test -p 1 -parallel 1 -v -run BulkDownload ./test/e2e/       # prints ctl latency under load

./build.sh && cd test/browser && npm install --ignore-scripts && npm run check
# the same while six networks flood the ICE-TCP gate ("The ICE-TCP gate"):
go build -o dist/amd64/gateflood ./test/gateflood && cd test/browser && GATEFLOOD=127.0.1.1,127.0.2.1,127.0.3.1,127.0.4.1,127.0.5.1,127.0.6.1 npm run check
```

The clipboard's tests want a real X server of their own, and skip without one. Start it yourself, on a display number nothing else uses, and never name a display you didn't start: they take its clipboard, and one of them grabs the whole server.

```bash
Xvfb :173 -screen 0 1280x800x24 -nolisten tcp -noreset &      # -noreset as desk-xorg has it, or connecting right after a test fails
XCLIP_TEST_DISPLAY=:173 go test -p 1 -parallel 1 ./internal/xclip/ ./internal/rtcserver/     # about 2 minutes
# The race detector needs cgo, for the tests only: the release stays CGO_ENABLED=0.
CGO_ENABLED=1 XCLIP_TEST_DISPLAY=:173 go test -race -p 1 -parallel 1 ./internal/xclip/ ./internal/rtcsock/ ./internal/rtcserver/
# Also stop and restart a server, with one of its own that it kills by PID:
XCLIP_TEST_DISPLAY=:173 XCLIP_TEST_XVFB=$(command -v Xvfb) XCLIP_TEST_XVFB_DISPLAY=:174 go test -p 1 -parallel 1 -run ServerRestart ./internal/xclip/
```

`test/e2e` starts the real binaries on loopback. `test/browser` does the same with headless Chromium as the client, over UDP and ICE-TCP, and writes `results/result.json`. It needs Node 20 or later (`~/.local/node-v24/bin`, since `/usr/bin/node` is 18) and Playwright's browsers in `~/.cache/ms-playwright`. `HEADLESS_SHELL=1` tries the smaller headless build.

## Run the skeleton locally

Each in its own terminal, from `desk-rtc/`:

```bash
dist/amd64/gateway-shim --addr 127.0.0.1:8787
dist/amd64/desk-rtc --socket /tmp/rtc.sock --data-dir /tmp/rtc-data --bind 127.0.0.1 --port 4443
dist/amd64/fake-deskd --rtc-sock /tmp/rtc.sock --api http://127.0.0.1:8787 --public-ip 127.0.0.1
dist/amd64/deskctl status --gateway ws://127.0.0.1:8787/v1 --transport udp
dist/amd64/deskctl status --gateway ws://127.0.0.1:8787/v1 --transport tcp
```

`deskctl` prints the status, transport, setup time and round-trip time, and exits non-zero on failure. `--bad-cnf` asks for a token bound to another certificate, which must fail with `identity_mismatch`. `--call '<method> [<JSON params>]'` (repeatable) makes more RPCs on the same session after `desk.status.get`, such as `--call 'files.list {"path":""}'`, printing each result or error; any error exits 1 (free walk H5's lab, `image/lab/h5-files/`).

The socket path has to fit the OS limit of 107 bytes.

## Run the shim and desk-rtc against your own `deskd`

Start the shim and `desk-rtc` as above, leave out `fake-deskd`, and point `deskd` at them:

| `deskd` setting | Value |
|---|---|
| `rtc.sock` | `/tmp/rtc.sock` (`desk-rtc --socket`) |
| `api.` base | `http://127.0.0.1:8787` |
| Public IPv4 for `configure` | `127.0.0.1` |
| IMDS | `services/scripts/fake-imds.py`, through `DESKD_IMDS_URL`. Without an IAM role, hello fails with an `IOException` otherwise. Never on a real desk |
| IMDS tag `DeskId` | `d-dev0000000000` (`gateway-shim --desk-id`) |
| IMDS tag `UserId` | `00000000-0000-4000-8000-000000000001` (`gateway-shim --owner-id`) |
| Issuer | `https://api.dev.invalid` (`gateway-shim --issuer`) |
| JWKS | `http://127.0.0.1:8787/.well-known/jwks.json` |
| Gateway | `ws://127.0.0.1:8787/v1`, subprotocol `ma.gw.v1`, with any non-empty `X-MA-Desk-Auth` header |

`POST /v1/agent/hello`, `POST /v1/agent/heartbeat` and `GET /v1/agent/config` are stubs that check no signature. Hello's reply and config carry all the URLs above. Then `deskctl status` tests your `deskd`.

`internal/fakedeskd/fakedeskd.go` is a short worked example of what `deskd` has to do.

## Get a token (Desk app, or anything else)

The shim mints real ES256 `ma-desk+jwt` tokens with a dev key made at startup. Its JWKS is at `GET /.well-known/jwks.json`, and CORS is open on every HTTP route.

`clientDtlsFingerprint` is `"sha-256 " + ` the colon-separated fingerprint from `certificate.getFingerprints()`. The token's `cnf` binds to it, so use the same `RTCCertificate` in the connection.

**`POST /v1/desks/{deskId}/connect`** is the stub of Platform's route, so prefer it: code written against it carries over. No `Authorization` needed.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/desks/d-dev0000000000/connect \
  -H 'content-type: application/json' \
  -d '{"scope":"owner","start":false,"clientDtlsFingerprint":"sha-256 7A:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C"}'
```
```json
{
  "deskId": "d-dev0000000000",
  "state": "running",
  "phase": "ready",
  "deskToken": "eyJhbGciOiJFUzI1NiIs…",
  "expiresAt": "2026-11-05T04:56:15Z",
  "refreshAfter": "2026-11-05T04:55:15Z",
  "gateway": "ws://127.0.0.1:8787/v1",
  "deskIdentity": { "fingerprintsSha256": ["f1d7a164dc82e7751dca45a9eea1ac23a3a30e548f77457a88289e2d1be45bc2"] },
  "identityAsOf": "2026-11-05T04:51:14Z"
}
```

`phase` is `connecting` until a desk has sent `ready`, and `deskIdentity` is `null` before its first hello. Open a session only at `ready`. Any other `deskId` gets `404 not_found`, since the shim serves one desk.

**`POST /dev/token`** is shim-only, for tests that need odd tokens. Only `clientDtlsFingerprint` is required. Optional: `deskId`, `sub`, `scope`, `sid`, `ttlSeconds` (at most 300).

```bash
curl -s -X POST http://127.0.0.1:8787/dev/token \
  -H 'content-type: application/json' \
  -d '{"clientDtlsFingerprint":"sha-256 7A:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C"}'
```
```json
{
  "deskId": "d-dev0000000000",
  "deskToken": "eyJhbGciOiJFUzI1NiIs…",
  "expiresAt": "2026-11-05T04:56:15Z",
  "refreshAfter": "2026-11-05T04:55:15Z",
  "gateway": "ws://127.0.0.1:8787/v1",
  "claims": {
    "iss": "https://api.dev.invalid", "aud": "d-dev0000000000", "sub": "00000000-0000-4000-8000-000000000001",
    "scope": "owner", "sid": "s-devsession00000", "jti": "jt-upofxown2xg7vle6",
    "iat": 1793854275, "nbf": 1793854275, "exp": 1793854575, "auth_time": 1793854275,
    "cnf": { "x5t#S256": "ehw-mw1VL2HIROASmrc99giRzipbfxPUZqC8OeUH8ow" },
    "ma_owner": "00000000-0000-4000-8000-000000000001", "ma_kind": "personal", "ma_name": "Dev User"
  }
}
```

`GET /dev/state` shows the desk's readiness and open sessions.

## Open a session (what the Desk app does)

1. Make the `RTCCertificate`, call `connect`, and open the gateway WebSocket with subprotocol `ma.gw.v1`.
2. Send `{"type":"session.open","id":"o1","deskId":"…","deskToken":"…"}` and wait for `session.opened {sessionId, iceServers: [], iceServersExpireAt: null}`.
3. Build the `RTCPeerConnection` with `certificates: [cert]`, `bundlePolicy: "max-bundle"`, `rtcpMuxPolicy: "require"`. Add recvonly transceivers for audio then video, then the eight negotiated channels. `createOffer`, `setLocalDescription`, and send the offer at once, without waiting for candidates. Never trickle.
4. `{"type":"signal","sessionId":"…","data":{"type":"offer","sdp":"…"}}`.
5. The reply is `signal` with `data` `{"type":"answer","sdp":"…"}`, or `{"type":"refusal","code":"identity_mismatch","message":"…"}` followed by `session.closed`. Check that every `a=fingerprint` in the answer is one of `deskIdentity.fingerprintsSha256`, comparing bytes, then `setRemoteDescription`.
6. Each channel opens on its own, so `ctl` being open doesn't mean `rpc` is. Once the channels you need are open, send `HELLO` on `ctl`, then `REQ desk.status.get` on `rpc`.

**ICE restart:** a new offer with `{"type":"offer","sdp":"…","restart":true}`. The answer comes the same way.

**`signal.data` is ours,** and the shape above is what `fake-deskd` and `deskctl` use. It isn't in the spec yet.

**What the browser sees in the answer.** Audio and video are `a=sendonly` with a non-zero port, as track `audio` in stream `desk-audio` and track `video` in stream `desk-video`, so `ontrack` fires at `setRemoteDescription`. No RTP arrives until the session views (`desk-runtime.md` §8.4). An offer without constrained-baseline H.264 gets `m=video 0`, and the browser then removes that transceiver from `getTransceivers()`. Audio stays.

### Frames

Design §4.2.4 names the `kind` values without numbering them. `internal/frame` numbers them in the design's table order from 1:

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HELLO | AUTH | ACTIVITY | PING | PONG | CLOSE | REQ | RES | ERR | SUB | UNSUB | EVT | CANCEL | DATA | CHUNK | CREDIT |

A frame is at most 16 KiB with its 12-byte header. The answer advertises `a=max-message-size:16384`.

## `rtc.sock` details the spec leaves open

- `offer` and `answer` are SDP strings.
- `CREDIT` counts frame bytes: the §4.2.4 frame, without the 5-byte handle and channel prefix or the envelope.
- `desk-rtc` grants credit back in steps of at least 32 KiB. `deskd` should drain and grant the same way, and its socket reader must never block: credit is what makes that safe.
- Overrunning credit closes that session with reason `credit_violation`.
- `configured` also carries `notAfter` (RFC 3339), which hello's `dtls.notAfter` needs.
- `stats` also carries cumulative `bytesSent` and `bytesReceived`, and per-session `bytesReceived`, which the heartbeat's `media` needs. Totals include closed sessions. A closing session leaves the table and joins the totals in one step under `Server.statsMu`, which a `stats` holds while it reads both, so its bytes count once, never neither and never twice (task 33 item 4: a `stats` straight after a close used to miss them, `RealDeskRtcIT.statsReportWhatTheSessionsSent`).
- A bad `publicIpv4` in `configure` gets `{"t":"error","code":"bad_request"}`, since the spec has no failure reply for it.
- `session.closed` reasons from `desk-rtc` itself: `consent_timeout`, `connect_timeout`, `dtls_failed`, `identity_mismatch`, `client_closed`, `frame_too_large`, `credit_violation`, `rtc_link_lost`.
- `events` runs desk to client only. Frames a client sends on it are dropped.
- Those `session.closed` reasons aren't all on the gateway's list (`gateway.md` §2.3), so map the rest to `closed_by_desk` when relaying.

## Flags

```
desk-rtc   --socket --socket-group --data-dir --bind --port --tcp-port --config --print-port --print-tcp-port --consent-timeout -v --version
           --stream-socket --stream-user --profile-file --display --no-playout-delay --guild-max-sessions --guild-voice-relay
gateway-shim --addr --allow-non-loopback --desk-id --owner-id --owner-name --issuer --origins
             --max-conn-age --idle-timeout --resume-hold --max-sessions --desk-kind --guild-id --max-guild-members
fake-deskd --rtc-sock --api --public-ip --desk-kind
deskctl status --gateway --api --desk --bearer --transport --timeout --json --bad-cnf -v --guild --member
```

`desk-rtc --bind` takes one IPv4 address, or `auto` for the default route's source address. It doesn't bind `0.0.0.0`, because Pion would then make a TCP candidate per interface (`eth0`, `docker0`).

`deskctl --guild <guildId> --member <memberId>` opens a Guild Desk as that member (`gateway-shim --desk-kind guild`).

## The ICE-TCP gate

`internal/rtcserver/tcpgate.go` sits between the TCP 443 listener and Pion's ICE-TCP mux. A new connection waits in it until its first RFC 4571 frame is read, which must be a STUN binding request for a ufrag one of this desk's sessions has. Anything else is closed before Pion allocates for it (`desk-endpoint.md` §3), and on a Guild Desk a `cmns` ufrag goes to the voice relay ("Guild mode"). **From 0.4.1 its waiting places are counted per client network** (Security's `NET031-3`, and the gate Medium in `docs/sub-status/guild-rtc-fixes.md`: before, anyone could hold all 64 places with silent connections and shut every member out of the TCP fallback):

| | Every desk but a Guild Desk | A Guild Desk |
|---|---|---|
| Places in all | **64** | 4 networks' worth: **1,600** at 200 members, 400 at 50, 200 at 25 |
| Places for one network, an IPv4 /24 or an IPv6 /64 | **16** | 2 a member: **400** at 200 members, 100 at 50, 50 at 25; never under 16 |
| How long a place lasts, at most | **3 s** (5 s before 0.4.1) | 3 s |

- **Counted after the handshake.** The kernel hands a connection to `Accept` only once its three-way handshake is done, and only then does it take a place, under its source address's network. A forged SYN never gets that far, since its sender never sees the SYN-ACK: forged SYNs claiming a member's /24 can't use up that network's places. That's why the count is here and not in nftables: desk-net-031's per-network limits there counted SYNs, and were taken out before any release for it (`image/README.md`, "TCP 443 per network: taken out before release"). A SYN flood as such is the kernel's, with SYN cookies (`tcp_syncookies=1`, Debian's default).
- **Past its network's places,** a new connection is closed at once.
- **When every place is taken,** a new connection from a network holding at least two fewer places than the network holding the most takes that network's oldest place, which is closed. Two networks a place apart never trade, so that can't loop. So a flood from a few networks, silent or sending half a frame, can't keep a newcomer out, and with many the places are shared fairly: any network that wants them can hold the total over the number of networks holding any, rounded down (9 each with 7 networks), and a newcomer is never refused while some network holds two or more. Only one place each, held from as many networks as there are places (64 /24s or /64s on a member's desk, each with real handshakes), keeps a new network out.
- **A place lasts at most 3 s.** A browser sends its first check as soon as it's connected, so its place lasts about a round trip. 3 s still lets the retransmission of a lost first segment through on a 500 ms round trip (RFC 6298's timeout from the handshake's sample is about 1.5 s there), with room for a browser that checks its candidate pairs one at a time.
- **Why 16 and 64.** A member's own desk takes 4 sessions, and a browser opens one TCP 443 connection a session for each of its network interfaces, 1 to 3: at most 12 at once from a household's or an office's one address, inside 16 with room for a reconnect beside the old ones. Four networks' worth in all means three flooding networks leave a quarter of the places, 16, enough for a household's 12 with nothing taken back; past three, the fair share above takes over. A place given back at the first frame means 16 at once, not 16 ever: a household opens as many as it likes, one after another.
- **A Guild Desk** can have a whole office of members behind one address, so its places scale with its members, 2 a member at once, as `desk-net-031` sized its nftables burst for the same reason. Members are `configure`'s `maxSessions` over `maxSessionsPerMember` as they took effect (`deskd` sends 600 and 3: 200), at most 200. Each `configure` sets the places for the next connection on (any other kind, or none, gets a member's desk's), connections already waiting keep theirs, and a dropped `deskd` link keeps the last, as the Guild Desk's ICE-TCP send buffer does. Until the first `configure` it's a member's desk's.
- **What a place costs:** a goroutine and a socket, and a frame's 2 KiB once a length has arrived. Measured on the box below with every place held under a flood: 64 places added 3.5 MB to the unit's memory (`memory.current`, the kernel's sockets included) and 3.2 MiB of RSS; a Guild Desk's 1,600 added 20 MB and 12.6 MiB, about 13 KB a place ("Memory: a bound").
- **The log** says, at most once a minute while it's happening, how many connections it has turned away since `desk-rtc` started: `ICE-TCP gate turning connections away` with `refusedPerNetwork`, `refusedFull`, `evicted`, `waiting`, `networks`, `places` and `perNetwork`. Never an address. `stats` is unchanged.

**From 0.4.2** (Security's `GATE041-1` and `GATE041-2`; `docs/sub-status/desk-rtc-gate041.md`). 0.4.1's counts stay as above, with these changes:

- **One address can't hold its whole network (`GATE041-1`).** Within a network, in the shared places and the reserved ones below, an address holding at least two fewer places than the address holding the most takes that address's oldest, as networks do among themselves. One address inside a member's own /24 (an office, a dorm, a shared carrier address) that holds all 16 with silent connections no longer shuts the /24 out. Several addresses of the same /24 holding a place each still can: a /24's places are shared among its addresses.
- **Reserved places for networks a member is expected from (`GATE041-1`).** A connection the shared places refuse (its network at 16, or the gate full and no network holding two more) takes a *reserved* place when a live session is expected from its network. Reserved places are outside the 64 (or 1,600): 4 for each live session expected from the network, at most the network's places, at most a gate's worth in all, with the same per-address rule. So 64 networks holding one shared place each can't lock out a network a member is expected from. A session is expected from a network when (a) its offer names one (server-reflexive, peer-reflexive or public host candidates, at most 2 networks; none today, since the web app's offer carries no candidates and the gateway sends no ICE servers), (b) a first frame signed with its password came from it, or (c) its selected candidate pair has the client there. The desk also remembers the last 32 such networks (a quarter of the places on a Guild Desk, at least 32), 4 reserved places each, so a returning member's usual networks keep theirs when the session is new. Held in memory only, never logged, dropped with the session. **What it does not do:** a member's first connection from a network the desk has never verified gets no reserve, and a Guild Desk's or member's desk's 64 networks can still keep that out.
- **Under pressure a silent connection waits half as long.** Once half the shared places are taken, a new waiting place lasts 1.5 s, not 3. Below that, 3 s as before.
- **The first frame must be signed (`GATE041-2`).** The first frame's MESSAGE-INTEGRITY must verify with the ICE password of the session whose ufrag it names (recorded when the answer is made). A frame naming a live ufrag with the wrong key is closed before Pion allocates anything for it.
- **Past the gate, connections are capped and time out (`GATE041-2`).** At most **6** connections per session ufrag (three interfaces and a reconnect's overlap) and **3 times a network's waiting places** per network (48 on a member's desk, 1,200 on a Guild Desk's) are handed to Pion; the rest are closed. A handed-over connection that sends nothing for the consent timeout (30 s; at least 10 s) is closed (as `net.ErrClosed`, which Pion treats as a quiet closure). A member who holds a live session therefore can't make `desk-rtc` hold more than 6 connections with it.
- The log line adds `refusedPastGate` and `refusedPassword`. Still no address.

**Proven (2026-11-08).** `internal/rtcserver/tcpgate_test.go`, on real loopback TCP, each flooding network a source address in its own `127.0.N.0/24`, IPv6 by rewriting those addresses to /64s. Three networks flooding with 40 connections each (about 760 a network in 0.7 s): a fourth network got in 30 of 30 times, and no network ever held more than 16. Six networks filling every place: a newcomer 30 of 30, and a household's 12 dialled together, each sending its check as it connects, 12 of 12. A slow-loris holding 16 silent or half-sent connections: its 17th closed at once, another network in, every one of the 16 closed at the deadline. A household's 12 held at once before any sends, quiet and with three networks flooding, all through, then 40 more from the same address one after another. IPv6: eight addresses on one /64 share its 16, the next /64 has its own, an IPv4-mapped address counts as its /24. The eviction rule and the fair share without timing, a Guild Desk's numbers, an office of 100 behind one address with three networks at a 50-member Guild Desk's cap, and `configure` setting them. Each rule was broken once and a test failed, 7 of 7 (`test/gateflood/results/mutations.txt`).

`test/gateflood` is the box proof: `gateflood` floods the gate from as many source networks as asked (connections that finish the handshake, then send nothing, a byte, or half a frame, and reopen the moment the gate closes them), holds a household's places, and as root forges SYNs from a network's addresses; `box.sh` runs the real arm64 `desk-rtc` on `127.0.0.1:443` in a scope with the unit's `MemoryMax` and `GOMEMLIMIT`, pinned to two CPUs, with `gateway-shim` and `fake-deskd`, and a real ICE-TCP client beside the floods, `deskctl status --transport tcp`, from `127.0.0.1`'s own /24. Never point it at a desk that isn't yours.

```bash
# on a throwaway arm64 box, as root, with jq, and arm64 builds of the four binaries and gateflood in ./bin:
./box.sh ./bin v041 member > member.jsonl; ./box.sh ./bin v041 guild > guild.jsonl
```

**Measured (2026-11-08), Graviton:** a `c7g.xlarge`, `desk-rtc` pinned to 2 of its 4 vCPUs, the floods and clients on the other 2. 0.4.1 against 0.4.0's published artifact as the control (sha256 `2970c845…`), the same floods. A try is one `deskctl status` over ICE-TCP from `127.0.0.1`: offer, ICE over TCP 443, DTLS, the channels and `desk.status.get`, with a 15 s limit (10 s for the control). Raw lines: `test/gateflood/results/arm64-*.jsonl`.

| Desk | Flood | 0.4.1 | 0.4.0 | 0.4.1: `desk-rtc` cores, what the floods held |
|---|---|---|---|---|
| Member | None | **30 of 30** | 10 of 10 | 0.01 |
| Member | 3 networks, 40 silent connections each, reopened as soon as closed (about 25,000 connections a network over the phase) | **30 of 30** | **0 of 10** | 0.06; 16 each |
| Member | The same, and the household's own 9 silent places beside 3 sessions at a time: 12 places from one address | **30 of 30** | 0 of 10 | 0.07; 16 each, the household 9 |
| Member | 8 networks, 30 each | **30 of 30** | 0 of 10 | 0.12; 8 each, the fair share |
| Member | 8 networks sending half a frame and stopping | **30 of 30** | 0 of 10 | 0.12; 8 each |
| Member | 420,000 forged SYNs from random addresses in the client's own /24, 20,000 a second (`NET031-3`'s attack on the nftables limits) | **30 of 30** | 10 of 10 | 0.01 |
| Guild Desk, 200 members | None | **30 of 30** | 10 of 10 | 0.01 |
| Guild Desk | 3 networks at their 400, an office's 300 silent places behind the client's address, and 10 members at a time connecting from it | **30 of 30** | **0 of 10** | 0.14; 400, 400, 400 and the office's 300 |
| Guild Desk | 6 networks, 300 each | **30 of 30** | 0 of 10 | 0.16; 266 or 267 each, the fair share of 1,600 |

Setup took 207 to 211 ms at the median in every member phase, as with no flood, and at most 292 ms; the Guild Desk's office phase, 10 members at once, 226 ms, at most 634. The control's every failure was ICE never connecting over TCP. Forged SYNs never troubled either version: the gate never counted them; it was the image's nftables limits that did. `desk-rtc` logged its once-a-minute line with the counts (117,101 turned away for their network's cap, 145,596 for a full gate, 139 places taken back, by the member run's second line, 80 s in) and stayed at about 20 MiB RSS (31 MiB on the Guild Desk with 1,500 places held).

**Real Chromium against a flood** (`test/browser`'s check with `GATEFLOOD`, x86_64 build box, Chromium 156 in new headless): every scenario passed, 64 checks, among them ICE-TCP selected, `desk-rtc` reporting `tcp`, and an ICE restart staying on TCP, while six networks held every one of the 64 places, about 31,000 connections each, and the gate logged turning them away. The same check passed with no flood. Result: `test/gateflood/results/chromium-tcp-under-flood.json`.

`e2e/` on the test desk with 0.4.1 (real Chrome through Platform's gateway): 23 passed, 1 skipped, first try; its sessions chose UDP, as a member's normally do.

**Not measured here:** a real browser on a real network against a flood, real networks with loss and long round trips, the 3 s deadline at a 500 ms round trip, IPv6 on a real desk (no desk has IPv6, and `desk-rtc` listens on IPv4 only), and an attacker with real handshakes from 64 or more /24s.

## Shared hosts: one public IPv4 for the host (from 0.5.0)

On a shared desk host under `SlotMode=port` (the owner's choice B, 2026-11-10; ADR 0072 section 6's note; `image/host/README.md`,
"One address per host"), every slot shares the host's one public IPv4: slot k gets UDP 4430+k, DNATed from the host's address
unchanged, and every slot's ICE-TCP comes in on the host's one TCP 443 through the host's `desk-ice-demux`, which routes a
connection by the slot's tag on the ufrag its first STUN request names. `desk-host` writes the slot's own `/etc/ma/desk-rtc.conf`
(the host's `/run/desk-host/<k>/desk-rtc.conf`, read-only in the desk):

```
port=4434            # UDP: the slot's own port
tcp_port=443         # the passive ICE-TCP listener, which the demux reaches through the slot's veth
slot=4               # every local ICE ufrag starts s04
public_ipv4=<the host's public IPv4, from the host's IMDS at this start>
```

- **The ufrag's tag.** Each session's local ufrag is `s<kk>` and 13 random letters (16 in all, as Pion's), and a new one, with
  the same tag and a new password, at every ICE restart. The setting is the vendored Pion's `SetICEUfragPrefix`
  (`third_party/README.md`); `rtcserver.SlotOfUfrag` is the rule the demux reads, `s01` to `s32` and nothing else (Pion's own
  ufrags are letters only, so a desk of its own never carries a tag).
- **The candidates** name `public_ipv4` in place of `configure`'s `publicIpv4`, which `deskd` gets from the slot's metadata
  stand-in (Platform's slot session); a difference is logged once per `configure`. Still exactly two: `<host> 4430+k udp host` and
  `<host> 443 tcp host tcptype passive`.
- **The client's address survives the demux.** The demux opens each connection to `10.98.<k>.2:443` with the client's own
  address and port as its source (`IP_TRANSPARENT`), so the ICE-TCP gate's per-network places, reserves and caps (above) see the
  real client. Measured on the lab host: `desk-rtc`'s TCP 443 sockets in both slots named the client box's own public address
  and port (`spikes/host-shared-address/README.md`).
- `slot` and `public_ipv4` go together, and a value it can't use stops `desk-rtc` with a `config:` error, as `port` does. A
  desk of its own, a self-hosted one and `SlotMode=address`'s slots set none of the three, so nothing changes for them (tested:
  `TestADeskOfItsOwnIsUnchanged`, and `e2e/` on the staging test desk with 0.5.0, "Status").

Tests: `internal/rtcserver/shared_test.go` (the answer's candidates and tag, an ICE restart's new tagged ufrag, a Pion client on
ICE-TCP alone to the TCP port through the gate, the tag rule) and `cmd/desk-rtc/shared_config_test.go` (the keys, refusals,
`--print-tcp-port`, `health` on both ports). `go test -race ./...` on a build box: every package ok.

## Media and input

Spec: `desk-runtime.md` §8. `internal/rtcserver/stream.go` is the `desk-stream` link and the fan-out, `media.go` the tracks and per-viewer forwarding, `internal/xinput` the event layout and XTEST.

- **One encode, per-viewer copies.** The read loop hands each packet to every viewer's bounded queue, and each viewer has its own goroutine: a write can block on a slow ICE-TCP client, and that only costs that client.
- **Each viewer has its own timeline.** Sequence numbers stay contiguous and timestamps keep wall-clock pace across a pause, or a new `desk-stream` process.
- **A new viewer starts on a keyframe,** and asks every 150 ms until one arrives. `keyframe` is rate limited to one per 100 ms for that, and one per 500 ms for PLI and FIR, since a keyframe under loss can make things worse.
- **`resume` and `pause` follow the viewer count.** First viewer in: `resume` and `keyframe`. Last one out: `pause`.
- **NACKs are answered** from a 1024-packet buffer per viewer, and sender reports go out. Video and audio are separate streams, so the browser doesn't hold video back to line it up with audio.
- **Sender reports are on the capture clock** (ADR 0037, `srclock.go`). `desk-stream` 0.2.3 and later stamp RTP from CLOCK_MONOTONIC with no offset, so `desk-rtc` rewrites each report Pion makes to say exactly which RTP time is now on each track, and a browser can tell which sound goes with which picture. Pion's own reports tie RTP time to when the last frame was sent, which put audio and video 15 to 35 ms apart in the tests. `forward` sees per packet whether the source is clocked (within 2 s of the clock), keeps a random offset fixed across pauses and new `desk-stream` processes for one that is, and drops the single stale audio packet the encoder sends after a resume. An older `desk-stream` keeps the old re-anchoring and Pion's reports.
- **`playout-delay` at 0, 0** goes on every video packet when the offer has the extension. It cuts Chrome's smoothing delay. `--no-playout-delay` turns it off for measuring. **A `HOLD` from the client** (type 6 on `keys`, `desk-runtime.md` 8.6) sets this session's to `ms, ms` instead, capped at 500 ms, and `HOLD 0` puts it back: that's how the Desk app holds the picture to match the sound while the member only watches (ADR 0037). Chrome ignores the video receiver's `jitterBufferTarget` while frames say 0, 0, so the hold has to come from here.
- **Quality levels** (ADR 0039, `docs/interfaces/stream-quality.md` sections 3 and 4, `quality.go`). A `QUALITY` on `keys` (type 7, not input, `input` permission or not) is that session's ask, kept until it closes or sends level 0. The stream runs at the highest ask among the sessions viewing, one that never asked counting as High and the level staying put while nobody views, lowered to `deskd`'s `stream.limit`, which lasts until `deskd`'s next connection. `desk-stream` hears `level <name>` as its first line on every connection, before `resume`, and then on a change at most every 500 ms, the newest value winning; an older one logs each as an unknown command and stays at High. A viewing session gets a 16-byte `0x82` reply on `keys` when it starts viewing and whenever its reply would change, or with its first `QUALITY` if `keys` wasn't open yet. `stats` adds `stream.level`, `stream.limit` (null for none) and a session's `quality` (absent until it asks).
- **The allowance profile** (from 0.5.1, S-29, ADR 0036; `quality.go`, `profile_test.go`). `run` passes `--profile-file /run/desk-egress/profile`. `desk-rtc` reads it at start and each time `desk-stream` connects (`desk-egress` writes it before it restarts `desk-stream`, so that's when the two agree), and takes the profile's ceiling as it takes `stream.limit`: `capped` Medium, `deep` Low; `normal`, a missing file or anything else is none. The level in effect is lowered to the lower of the two ceilings, the reply's limit byte carries it and flag bit 0 says held, so a member on Max past 100 GB reads "held at Medium" instead of Max. `stats` adds `stream.profile` (absent for normal). Before 0.5.1 a capped desk answered with the member's own level.
- **X is reached lazily and again after a restart,** because `desk-xorg` starts on demand. Access comes from `xhost +SI:localuser:rtc`, so xgb's "no authority" fallback is the normal path. Connecting turns X's own auto-repeat off.
- **Keys and the wheel depend on the image.** `desk-rtc` 0.2.1 goes with `ma-desk-0.2.2` or later: evdev keycodes, the keymap `desk-xorg-ready` loads, and 1920x1080. On an older image it logs a warning, and `e.code` stays wrong on some named keys. Which keycodes are safe for spare characters, and why, is in `internal/xinput/spares.go` and `desk-runtime.md` §8.6.

## Prove the stream

`test/stream/` is the end-to-end proof: real `desk-rtc`, `desk-stream` and kiosk Chromium on a temporary arm64 box, and Chrome for Testing (Playwright's `chromium` channel, new headless, which has H.264) on a second box. It reads pixels off decoded frames, as design §2.2's photon probe says.

```bash
# On the desk box: gateway-shim, fake-deskd --public-ip <its public IP>, the benchmark pages and
# input.html served on 127.0.0.1:8000, /opt/proof/sample.py, and `systemctl start desk-browser desk-stream`.
# On the client box, with an SSH tunnel from 19222 to the kiosk's CDP port (nftables needs a test-only rule for the tunnel's uid):
node proof.mjs --api http://DESK:8787 --cdp http://127.0.0.1:19222 --ssh 'ssh -i key admin@DESK' \
  --phases input,audio,latency,scroll,video,warm,viewers,idle --out result.json
```

**Use the desk's public IP in `--public-ip`.** Chrome ignored a private-IP candidate from a page on `127.0.0.1`: ICE stayed `new` and sent nothing. A public IP works, and matches production.

### Measured (2026-11-05)

Raw results are in `test/stream/results/`. c7g.large desk, 1920x1080@60, 8 Mbps, x264 `ultrafast`/`zerolatency`. Client: Chrome for Testing 156 on a c7i.xlarge in the same zone, software decode, 30 ms RTT from `tc netem` unless noted. Latency is the design's photon probe on a flipping square (`expectedDisplayTime` minus the keydown), p50/p95 ms, 60 trials. "Loaded" adds a 1080p60 video to the page. Scroll is wheel input at 1200 px/s; fps is decoded, and "page" is the kiosk's own `requestAnimationFrame` rate. CPU is the whole machine.

| Setting | Latency | Loaded | Scroll fps (page) | Scroll CPU | Static page CPU |
|---|---|---|---|---|---|
| **`yuvconv` NV12 (`stream.conf` default)** | **54/78** | **75/89** | **60.0 (59.9)** | **74%** | **28%** |
| `videoconvert` I420, the baseline | 67/88, 83/93 on a second run | 100/120 | 60.0 (56.4) | 88% | 42% |
| NV12 with VFR (`drop-duplicates`) | 71/79 | 76/84 | 60.0 | 74% | 8% |
| Baseline, `playout-delay` off | 84/100 | | 60.0 (55.9) | 88% | |
| Baseline, ICE-TCP | 60/79 | | 60.0 (55.4) | 88% | |
| Baseline, 1% loss | 57/86 | | 60.0 (55.3), 133 NACKs, no PLI, no freeze | 88% | |
| Baseline, CRF 23 capped at 8 Mbps | 85/93 | | 60.0 (55.3), 6.2 Mbps | 88% | |
| Baseline, equal CPU weights | 57/77 | | 59.9 (59.5). Video 58.8, p5 56 | 91% | |
| Baseline, `--disable-software-rasterizer` | 67/106 | | 60.0 (54.9) | 88% | |
| Baseline, about 1 ms RTT | 52/71 | | 60.0 (56.3) | 88% | |

Default settings, other numbers:
- **B11:** 60 s scroll at 60.0 fps, p5 60, zero freezes. On Wikipedia too (83% CPU).
- **B13:** `live` from warm to first frame p50 59, p95 67, max 69 ms. Warm costs 0% for `desk-stream`.
- **Other starts:** `desk-stream` start to first frame with a viewer waiting, 0.65 s. After `kill -9`, 1.8 s. A second viewer's first frame, 58 ms.
- **Memory under load:** `desk-stream` 52 MB, `desk-rtc` 26 MB, Xorg 31 MB, Chromium 630 MB.
- **`bulk` while viewing:** 2.03 Mbps, against 15 Mbps not viewing (30 ms RTT).
- **Colors:** worst channel error 3 of 255 with `yuvconv`, 10 with the baseline.

`expectedDisplayTime` is noisy in headless Chrome: the same settings moved by up to 20 ms between runs, while the frame callback stayed near 65 ms. A real display adds its own scan-out, which the probe leaves out.

**Not measured here:** t4g.medium (the benchmark covers it), a real GPU client, Safari, Firefox, phones.

### Sound and picture (2026-11-06)
`e2e/av-sync/` measures the gap between sound and picture end to end on the staging test desk, through Platform's real API and gateway: a clip with a white box and a 1 kHz tone on the same instant, played in the desk's Browser, a sampler on the desk (its X screen and its Pulse monitor) and a probe in headless Chrome here. Its `README.md` has the run; `runs/` has the numbers. In short, at 52 ms RTT: the desk is in sync with itself to about 10 ms, the picture reaches the client in about 50 ms, the sound in about 90, so the sound trails by 35 to 70 ms before the client's own output device. ADR 0037 has the rest.

## Prove the keys and the wheel

`test/keyproof` runs on a temporary box with the real image, as root: the Pion client talks to the real `desk-rtc` over WebRTC, and the page reports what it saw through its title, read back from CDP. No second box and no video. It needs `gateway-shim` and `fake-deskd --public-ip <private IP>` running, and `desk-browser` started.

```bash
keyproof run --phases viewport,named,ascii,letters,pace,burst,hold,wheel --order asis,reverse,seed1,seed2 --out result.json
keyproof table --loud --from 93 --to 255   # what Chromium does with each keycode; needs xhost +SI:localuser:root
keyproof race --clear --delays 0s,5ms,20ms # wrong letters against the wait after a remap; same xhost
```

Results are in `test/keyproof/results/`.

## The clipboard

`internal/xclip` is the desk's X `CLIPBOARD` selection, both ways, text only, for `deskd`. Never `PRIMARY`. It has its own X connection, window and goroutine, so serving 1 MB can't delay XTEST or the cursor. What a client sees is `services/deskd/docs/API.md` §10; `deskd` is what gates it.

Messages on `rtc.sock`, JSON, type `0x01`. `id` is an integer from 0 to 2^53−1, `part` and `maxBytes` are plain integers (no fraction or exponent, so not `1e6` or `1.0`), `last`, `none` and `on` are booleans, and `data` is base64 of at most 45 KiB. `null` is the same as leaving a field out. `desk-runtime.md` §4.3 lists them too.

| From `deskd` | Reply |
|---|---|
| `clipboard.set {id, part, last, data}` | On the last part: `clipboard.ok {id}`, or `clipboard.error {id, code}` |
| `clipboard.get {id, maxBytes}` | `clipboard.text {id, part, last, data}`, or `clipboard.text {id, part: 0, last: true, none: true}`, or `clipboard.error {id, code}` |
| `clipboard.watch {on}` | None. Starts or stops `clipboard.changed`, which is off again on each new connection |

`clipboard.changed {}` comes unprompted, while watching. Codes: `no_display`, `timeout`, `too_large`, `internal`.

**What `deskd` needs to know:**
- **`clipboard.ok` means the X server said so.** It takes the selection at a time read from the server, then a round trip shows this window owns it, and only then the reply goes. Send the paste key on it.
- **Parts are bytes.** A part can end in the middle of a UTF-8 character, both ways, so decode only what's joined. Text isn't checked here at all: NUL and bad UTF-8 go through as they are, for `deskd` to deal with.
- **One `set` at a time.** Part 0 always starts a new one, and an unfinished one it replaces gets no reply. A part out of order gets `internal` once, and that set's later parts are ignored. Over 2 MiB gets `too_large` on its last part.
- **A set can also get `internal` early,** before its last part, when the queue here is full (64 messages), and again once its next part is seen as out of order. Ignore a reply to an id you've finished with.
- **Empty text takes the selection,** with nothing in it. API.md has `deskd` not send that.
- **`maxBytes` of 0, or over 2 MiB, means 2 MiB.**
- **A `get` waits for sets ahead of it,** so one sent after a `set` sees it, and answers from memory if this window still owns the selection. Gets run one at a time, with 8 more queued, so one behind a stuck owner waits for that one's 3 s too. A `set` waits for no `get`.
- **How long to wait:** an owner that doesn't answer gets `timeout` at 3 s per step, 15 s for a whole transfer. A set gets `timeout` at 3 s. An X server that has stopped answering costs up to 5 s, then `no_display`, and the same again for a dial to it. Wait longer than that before giving up here.
- **A reply can stop partway.** If more than 4 MiB of the clipboard's replies are waiting for `deskd` to read them, `clipboard.text` parts stop and `clipboard.error {id, internal}` comes in place of the rest. Throw away what you had for that id.
- **A field of the wrong type never closes the link.** The message gets `clipboard.error {id, internal}`, or nothing if `id` itself is wrong, or for a `clipboard.watch`, which changes nothing then. A set it's part of ends there, as for a part out of order: `internal` once, and its later parts ignored. A wrong part 0 starts a set of its own, which fails. Any other field of the wrong type, in any message, still closes the link, as it always has.
- **A new connection forgets what the old one had under way,** with no reply, and watching goes off. The text stays on the clipboard. Send `clipboard.watch` again on every connection. Nothing meant for the old connection reaches the new one, not even a reply that was on its way as it connected: each reply names the connection it answers, and goes nowhere if that's gone.
- **Replies queue below session data** on the socket, so 2 MiB of text can't hold up a session's frames, nor JSON and `CREDIT`. They keep their own order. A steady stream of session data lets one through every 256 KiB, so a paste isn't held up for ever.
- **`clipboard.watch` is what makes this connect to X with nothing asked of it,** every 500 ms until it can, so changes are heard when X comes up. It only ever connects: nothing here starts `desk-xorg`. `no_display` means there's no connection yet.
- **`clipboard.changed` is at most 4 a second,** the first at once and the last always reported. It isn't sent for this desk's own `set`, nor for the selection going to no owner.

**How it treats other X clients,** all of them hostile, since Chromium's user has X access and a page can drive Chromium:
- **The worker never waits for another client.** A transfer is a state machine driven by events, with those deadlines. It only waits for the X server itself, and a guard closes the socket if that takes over 5 s, whatever X is doing (grabbed, stopped).
- **Limits:** 8 requestors in the middle of an INCR, and the next one is refused; reading stops at `maxBytes`, with `too_large` and no cut piece; `GetProperty` asks for no more than that, so a huge property stays out of memory; 1024 events queued, of which requests can fill 256, and past that the event is dropped and the other side times out.
- **Forged events** can't be told from real ones, because xgb's decoding drops the bit that says so. So `SelectionClear` is checked against the server, and the rest can only spoil that client's own transfer. A page can't send X events at all, only a compromised browser can.
- **`SelectionClear` drops the text** and ends any transfer of it. A later `set` doesn't end a transfer of the earlier text: it finishes on what it started with. Text is never logged, nor its length, nor a `data` field, at any level.

**Refused:** `PRIMARY`, any target but `TARGETS`, `TIMESTAMP`, `UTF8_STRING` and `text/plain;charset=utf-8`, and a request timed before the selection's own timestamp. On reading, it asks for `UTF8_STRING`, and anything else in answer (a refusal, another type or format, or empty text) is `none`.

## Prove the clipboard

`test/clipproof` runs real Chromium, headed, on a private X display you started, with a throwaway profile. It goes through `internal/xclip` as `desk-rtc` does, injects Ctrl+V and Ctrl+C by XTEST, and reads the page over its debugging port. The display has to be named, and it won't take `:0` or `:10`.

```bash
Xvfb :173 -screen 0 1280x800x24 -nolisten tcp -noreset &
go run ./test/clipproof --display :173 --chrome ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
  --scratch "$(mktemp -d)" --out test/clipproof/results/result.json
```

Results are in `test/clipproof/results/`. Measured 2026-11-06 over 10 runs, 6 before the review fixes and 4 after, on Xvfb 21.1.12, not Xorg, with Chromium 1248 (`--disable-gpu`) on a shared 6-core machine:

| | 1,000,000 bytes | Smaller |
|---|---|---|
| `clipboard.set` to `clipboard.ok` | 1–7 ms | 13 ms at most |
| Ctrl+V to the whole text in the textarea | 150–271 ms | 300 KB 60–90 ms, 100 KB and under 10–66 ms |
| `clipboard.get`, after Chromium's copy | 4–13 ms | 6 ms at most |

- **Chromium as requestor** asks with `CurrentTime`. It asks for `TARGETS` about 16 times per paste, picks `UTF8_STRING`, never `text/plain;charset=utf-8`, and reads the text **twice**, so a 1 MB paste is 2 MB through INCR. Both reads finish.
- **Chromium as owner** doesn't use INCR at 1 MB: it writes one property of that size, through BIG-REQUESTS. So reading that much is one `GetProperty`, and the INCR read path is only proved against a Go owner in the tests.
- **`clipboard.changed`** came 2–8 ms after Ctrl+C when nothing else had just fired it, and otherwise up to the 250 ms the coalescing allows.
- **Serving 1 MB without a pause** to a Go requestor, at 215–442 full reads in 2 s, another client's round trip to the same server stayed at p50 under 75 µs, p99 under 5 ms, worst 12 ms. It stands in for XTEST and the cursor, which weren't themselves measured.
- **A flood** of about 200,000 requests a second, half forged `SelectionRequest` and half `ConvertSelection`, left every `set` and `get` working, the slowest pair 57 ms.

**Not measured here:** the real image's Xorg and keymap, the kiosk's Chromium flags and policies, or a real desk. `DefaultClipboardSetting` isn't set in the kiosk's policy, as API.md says, and this doesn't change that.

## Guild mode

A Guild Desk (ADR 0077, task 48) is one shared desk for a whole guild, on its own server with no screen: no `desk-stream`, Xorg or Browser. Members' browsers reach it the way they reach their own desk, through the gateway's signaling, with a member's `ma-guild+jwt` that `deskd` checks. `desk-rtc` takes many of them at once, data channels only. Code: `internal/rtcserver/guild.go`. Nothing here changes for any other desk.

**How it's chosen: `deskd` says so in `configure`.** `deskd` reads the desk's `DeskKind` tag from IMDS, which `desk-rtc` (uid `rtc`) can't reach (`desk-runtime.md` §1), and sends `"deskKind": "guild"`. That puts this `rtc.sock` connection in guild mode; a new connection starts as an ordinary desk until its own `configure` says otherwise, and a session keeps the mode it was made in. Any other `deskKind`, or none, is a desk as before, byte for byte.

| From `deskd` | Reply | On a Guild Desk |
|---|---|---|
| `configure {publicIpv4, deskKind: "guild", maxSessions?, maxSessionsPerMember?, credit?}` | `configured {fingerprintsSha256, notAfter, version, deskKind: "guild", maxSessions, maxSessionsPerMember, credit}` | `maxSessions` is the most sessions at once: `deskd` sends `maxGuildMembers` × 3; none, or more than the ceiling, means the ceiling, 600 unless `guild_max_sessions` or `--guild-max-sessions` says otherwise (1 to 10000). `maxSessionsPerMember` is one member's most, **3** if none, as `deskd`, the gateway and Security's GD-1 count them. `credit` is `deskd`'s credit per channel toward `desk-rtc` for this connection's sessions, in place of the 256 KiB every desk starts with: 65536 to 262144, anything else means 262144. **`deskd` should send `credit: 65536`** (see "Memory", below) and then hold to what `configured.credit` says: past it is `credit_violation`, as past 256 KiB is on any desk. The other direction needs nothing of `deskd`: `desk-rtc` never has more than 128 KiB a channel on its way to `deskd` ahead of grants, though `deskd` grants 256 KiB (it must keep granting at most every 64 KiB drained, as it does). The reply echoes all three as they took effect, and only a Guild Desk's reply has these fields: a `deskd` that sees no `deskKind` there is talking to a `desk-rtc` without guild mode, and one with no `credit` to a `desk-rtc` before 0.4.0, which holds deskd to 256 KiB |
| `session.create {…, memberId}` | `session.answer` or `session.error` | `memberId` is required: the token's `sub` (`gm-…`), 1 to 128 of `A-Z a-z 0-9 - _ . :`. Missing or bad, `bad_offer`. A member past their `maxSessionsPerMember`, or the desk past `maxSessions`, `session_limit_reached`. `permissions` are ignored: video and input stay off |
| `member.close {memberId, reason?}` | `session.closed {sessionId, reason, …}` for each of that member's sessions, then `member.closed {memberId, sessionIds}` | Closes every session the member has, at once, in parallel. From the moment it's read, nothing more of theirs reaches `deskd` and those sessions no longer count toward the member's `maxSessionsPerMember`, so a role change's fresh session is never refused while they close. Each still flushes `ctl` for at most 500 ms, as `session.close` does, so a `CLOSE` frame `deskd` queued just before reaches the client. `reason` defaults to `member_closed`; send the gateway's (`revoked`, say) to save a mapping. `sessionIds` is absent when there were none. Sessions `deskd` creates after it are new, and stay. No `memberId`: `error {code: "bad_request"}`. **On any other desk it's ignored**, with a warning in the log, as before guild mode |
| (`desk-rtc` closes a session, or `deskd` sends `session.close`) | `session.closed {sessionId, reason, memberId, bytesSent, bytesReceived}` | **On a Guild Desk, the session's final bytes** (the review's M2): what the session sent the member and got from them, over its whole life, as its stats row counts them, at the moment it closed. The same numbers stay in every `stats` as the session's closed row until `deskd` acks it (below), so they're never lost with the message. A `session.close` for a session that's already gone gets them again while `desk-rtc` keeps the row. Other desks' `session.closed` is as before. Reasons a Guild Desk adds: `protocol_error` (the client sent data on a stream that isn't one of the eight channels, or its SCTP broke a limit, see "What a session gets") and `over_budget` (the budget's last resort, see "Memory") |
| `stats.get {ack?}` | One or more `stats {part, last, sessions: [{…, memberId, closed?}], members: [{memberId, sessions, bytesSent, bytesReceived}], bytesSent, bytesReceived, voiceRelay, budget, …}` | **In parts:** 600 sessions' rows are more than one 64 KiB envelope (the scale run found it: one reply at 600 was dropped). Every part has `part` (0, 1, …) and `last`; part 0 has the totals, `stream`, `voiceRelay` and `budget`; each part has the next run of `sessions`, then of `members`. Join both lists until `last`. The parts are one snapshot, and two overlapping `stats.get` never mix their parts. Up to about 400 rows it's one part, `part: 0, last: true`. A connection whose `configure` turned guild mode off while guild sessions remain still gets parts (the review's L3). **Metering is per session** (`guild-eng.md` §3.2): each row carries its `memberId`; a live session's row has its bytes so far, and a closed session's row, `closed: true`, its final bytes. **Closed rows stay in every `stats` until `deskd` lists them in `ack`** (session ids, in the next `stats.get`), at most 2048 of them and at most 15 minutes, the oldest dropped first and counted in `budget.closedDropped`; that covers a `session.closed` lost with a dropped `rtc.sock` (`rtc_link_lost`). `members` is each member's bytes over this `desk-rtc`'s life, closed sessions included, and how many sessions they have open: for logs and checks, not for the meter. Bytes are ICE's, packets on the wire as for the desk's totals, so DTLS, SCTP and retransmits count. A restart of `desk-rtc` starts every count from 0, and loses closed rows not yet acked |

**What a session gets.** Channels 0 to 5 (`ctl`, `rpc`, `events`, `collab`, channel 4, `bulk`), bridged to `deskd` exactly as on any desk, with the same priority. On a Guild Desk channel 4 carries Commons' room link (`docs/sub-status/deskd-guild-sessions.md`, the Desk Engineer's); `desk-rtc` doesn't look inside. `input` and `keys` are opened as on any desk, and **read and dropped**: a channel nobody read would keep everything the client sent on it (the review's H1); `stats` counts them in `inputDropped` and `keysDropped`. **No track is offered.** A data-only offer gets a data-only answer. The Desk app's usual offer, audio and video first, gets both answered `a=inactive` with no `msid` or SSRC, so no `ontrack` fires and the BUNDLE tag stays on the audio section; a video section with no H.264 is rejected with port 0, as on any desk. An ICE restart keeps them so. No NACK or sender-report interceptors, a 16 KiB read buffer per channel instead of 64 (1 KiB for `input` and `keys`), and no video viewer, so nothing reaches `desk-stream` or X, and the clipboard only answers if `deskd` asks: `run`'s `--display` and `--stream-socket` stay, and are inert without Xorg and `desk-stream`. Commons' voice is its own Pion connection inside Commons (ADR 0077 T8), not here.

**What a client can't make `desk-rtc` hold** (the review's H1). A Guild Desk session's SCTP takes a 128 KiB receive window (4 MiB elsewhere), at most 1024 chunks waiting on any one stream, and data only on the eight channels' streams: data on any other stream ends the session at its first chunk, `protocol_error`, and so does going past the 1024. Pion's window counts only payload bytes, and each message costs it about 300 bytes more, so before this a client's 1-byte messages on a stream nobody read held 300 times the window (1.3 GiB from one session, measured). Both settings are a two-line patch to Pion (`third_party/README.md`), set only on a Guild Desk's sessions. Measured (`internal/rtcserver/guild_bound_test.go`): 300,000 1-byte messages on `keys` and 30,000 on `input` leave the heap +0.5 MiB, with the session open; a flood on a stream that isn't a channel ends that session in under a second, others carrying on; with `deskd` granting nothing, a flood on `collab` stops at the channel's credit and ends at the chunk cap, the heap +2.4 MiB.

**Commons' voice on 443** (`voicerelay.go`; the System Engineer's design, for the owner's "UDP with TURN on 443 as fallback"). Commons' voice is its own Pion connection on UDP 8791 and up, which some networks block. `desk-rtc` already holds UDP and TCP 443, so on a Guild Desk it passes Commons' ICE through, unread, to Commons on loopback. The interface with Commons (G5 builds its side to it):

| | |
|---|---|
| Commons' ufrags | Every ICE ufrag Commons' voice uses starts with `cmns`. `desk-rtc`'s own never need to: a session's ufrag is matched first, so the relay only ever sees what no session claimed |
| Where Commons listens | `127.0.0.1:8799`, UDP and TCP (RFC 4571 framing, passive ICE-TCP), for relayed ICE only. `desk-rtc --guild-voice-relay` moves it, loopback IPv4 only (anything else stops `desk-rtc` at startup) |
| UDP | A STUN binding request on 443 that no session's ufrag or address takes, whose USERNAME's first ufrag (Commons' own) starts with `cmns`, opens a **pending** flow for that client address: a loopback socket of its own, connected to 8799, and the request's transaction id. While pending, only binding requests go through, and nothing comes back but the answer below. **It becomes a mapping only when Commons' binding success for one of those requests comes back** (Security's GDS-1): from then on that packet and every later one from the address go through it, STUN or not, and what Commons sends to that socket goes out of 443 to the address. Commons sees each client as a distinct `127.0.0.1` port, a peer-reflexive candidate. Not one shared socket for every first request: Commons' Pion mux remembers the address a connection last answered, and sends what comes from it to that connection after, so a shared socket's next request, another member's, would fail; a socket that never carried an answer is never reused |
| TCP | A connection whose first RFC 4571 frame is such a request, for a ufrag no session has, is spliced whole to 8799, the first frame included, both ways, until either side closes. Pending until Commons first sends anything, which its gate does only for a signed request for a live connection |
| Pending | Commons answers only its live connections' ufrags with the right password, and sends nothing at all otherwise (its gate, `apps/commons/server/internal/voice/gate.go`). A pending flow or connection it hasn't answered ends after **2 s** (it answers on loopback in about a millisecond, and a client resends its check). Pending ones are capped **per client network (4 per /24, or per /64 for IPv6)** and in total (256 UDP, 64 TCP), and when the total is full **a new one pushes out the oldest**: so a flood of requests for ufrags Commons will never answer, from as many networks as you like, can't hold the places, since a member's own request needs its place only for the moment Commons takes to answer |
| Idle | A mapping with no packet either way for 30 s ends, and a relayed TCP connection when either way is quiet for 30 s. ICE's consent checks every few seconds keep a live one going |
| Caps | Mappings, which only Commons' answer makes: UDP 4 per Commons ufrag (one per member's voice connection, which Commons binds to one member) and 1024 in all; TCP 2 per ufrag and 512 in all. Past a cap the answer is dropped and the flow closed, or a new pending one refused, as an unknown ufrag's is today, and `voiceRelay.refused` counts it; `voiceRelay.evicted` counts pending ones pushed out. 256 packets can wait per mapping; past that they're dropped. A pending UDP flow is a socket and a goroutine, about 12 KB, so the 256 cost about 3 MB |
| When | Only while this `rtc.sock` connection's `configure` said `deskKind: "guild"`. A configure for any other kind ends every mapping; a dropped `deskd` link only stops new ones, so voice carries on while `deskd` reconnects |
| `stats` | A Guild Desk's part 0 carries `voiceRelay {udpMappings, tcpConnections, refused}`. The bytes are Commons' to count: it sees them all on 8799 |

What Commons has to do: put host candidates for the desk's public IPv4 on UDP 443 and on TCP 443 (`tcptype passive`) in its answers, beside its own ports; listen on 8799; drop any binding request for a ufrag it doesn't have without allocating for it, as `tcpgate.go` does for `desk-rtc` (anyone can reach 443); and answer only authenticated ones. What the image has to allow: uid `rtc` to `127.0.0.1:8799`, UDP and TCP.

Everything else on 443 is as it was: only packets Pion's mux already drops reach the relay, and only connections the TCP gate already closes, and on any desk that isn't a Guild Desk it returns at once. A flood of `cmns` requests costs a STUN decode a packet on 443's read loop (Pion already pays one for any unknown packet) and, past the per-network cap, a loopback socket each until it's pushed out; it can't hold the pending places for a member who answers (tested: 3,000 spoofed sources from 1,500 networks, and a member's request mapped in the middle of a continuous flood), take a `desk-rtc` session's packets, touch direct voice on 8791, or get past Commons' own check. Proven against the real Commons from this tree, UDP and TCP (`test/e2e/commons_relay_test.go`): a member's voice connects only through `desk-rtc`'s port, and a request for a ufrag Commons doesn't have gets no answer and leaves no mapping. Relayed voice leaves as uid `rtc` from port 443, so the egress shaper (ADR 0036) puts it in `desk-rtc`'s class, and it counts in the desk's outbound bytes. `stats.voiceRelay` is `{udpMappings, udpPending, tcpConnections, tcpPending, refused, evicted}`.

**Memory: a bound, not a measurement** (the review's M1). `run` sets `GOMEMLIMIT=96MiB` under the unit's `MemoryMax=128M`, which holds four sessions, not hundreds. A Guild Desk's image gives `desk-rtc` a drop-in, `MemoryMax=512M` and `Environment=GOMEMLIMIT=384MiB`, which `run` keeps. What keeps 600 sessions inside it whatever members and `deskd` do:

| What `desk-rtc` holds | Its limit | Why it can't grow |
|---|---|---|
| 600 sessions open, light traffic | about 0.55 MiB each: 140 MB of live heap and 11 MB of stacks at 600 on Graviton, 331 to 345 MiB RSS with the GC's headroom | Fixed per session; the session cap is 600 |
| Client to `deskd`, read and waiting for `rtc.sock` | **24 MiB** in all (`budget.rxMax`), each frame charged its bytes and 256 more | Past it every reader waits, so the client's bytes stay in its SCTP window, then at the client. One session never has more than 128 KiB a channel ahead of `deskd`'s grants |
| `deskd` to client, queued or sent and not yet acknowledged | **48 MiB** soft, **96 MiB** hard, in all (`budget.txSoft`, `txMax`), charged the same way | Past the soft line, a session holding more than 128 KiB gets no credit back, so `deskd` stops sending to the slowest members first. Past the hard line the session holding the most is closed, `over_budget`: a stalled member loses their own session, never the desk. `deskd`'s credit is what one session can queue per channel: 256 KiB unless `deskd` asks for 64 KiB in `configure`, which it should |
| A session's SCTP receive window, outside the budget | 128 KiB of payload, at most 1024 messages a stream on the eight channels' streams only | An honest window is mostly 16 KiB messages, about 170 KiB with Pion's overhead. A client's tiny messages can park at most 8 × 1024 × about 330 bytes, 2.7 MiB, and past that its session ends, `protocol_error` |
| ICE-TCP sessions' kernel send buffers, which cgroup v2 charges to the unit | 64 KiB set (128 KiB with the kernel's doubling) a connection on a Guild Desk, against 256 KiB elsewhere | One a session |
| The 443 voice relay | 256 pending flows, about 3 MB; 1024 mappings × 32 queued packets, 48 MB only if Commons stopped reading | Pending flows go after 2 s or when pushed out; mappings need Commons' answer |
| The ICE-TCP gate's waiting places (0.4.1) | 1,600 at 200 members: 20 MB of the unit's memory with all held, 12.6 MiB of it Go's (measured, "The ICE-TCP gate") | A place lasts 3 s at most, one network holds 400 at most, and the total is fixed |

**The arithmetic, at 600 sessions.** Live memory is what `GOMEMLIMIT` has to cover: 151 MiB for the sessions, plus 24 MiB and 96 MiB if both budgets were full at once, plus 600 × 170 KiB = 100 MiB if every member were uploading while `deskd` stalled, is 371 MiB, under 384 MiB: the GC works hard there, and the heap stays under the limit. Every one of the TCP gate's 1,600 places held at the same moment adds about 13 MiB of Go's (0.4.1), right at the limit, with `MemoryMax`'s 128 MiB above it untouched. With a realistic tenth of members uploading, and the relay's 3 MB, it's about 284 MiB, which leaves about 100 MiB: room for 37 sessions at a hostile client's 2.7 MiB, 12 members' worth, at the same moment. RSS stays near `GOMEMLIMIT` plus the runtime's own few MiB, and the cgroup adds the kernel's ICE-TCP buffers: 7.5 MiB for 60 members on TCP, 75 MiB if all 600 were stalled on TCP, still under 512M. What isn't bounded: more than about 37 hostile sessions parking at once while every budget is full (each member has 3 sessions and can be removed), and a `deskd` that ignores credit, which loses that session with `credit_violation` as on any desk.

**Dev tools.** `gateway-shim --desk-kind guild` serves a Guild Desk: `POST /v1/guilds/{guildId}/desk/token {fingerprint}` (also `clientDtlsFingerprint`; shim-only `memberId`, `role`, `name`, `grants`, `teen` pick the member) answers as `connect` does, with an `ma-guild+jwt` carrying `guild-eng.md` §3.2's claims; `session.open` takes only those, up to `--max-guild-members` × 3; `connect` gets 404; `/dev/token` mints guild tokens with `sub` as the member. `fake-deskd --desk-kind guild` sends the guild `configure`, takes only guild tokens, puts the token's `sub` in `session.create` and answers `test.member.close {memberId, reason}`. `internal/client`'s `GuildID` and `MemberID` open a session as a member. `test/e2e/guild_test.go` runs them all.

### Prove the scale

`test/guildscale` is task 20's spike (`spikes/guild-shared-desk/sessions`) on the real binary: one process plays `deskd` and every member's browser, `desk-rtc` runs alone so only its memory and CPU are read, and sessions go to members three at a time. Same traffic as the spike: `deskd` sends each session 300 bytes a second on channel 4 and 1 KB every 5 s on `collab`; each browser sends 200 bytes a second on channel 4 and 1 KB every 10 s on `collab`.

```bash
LEVELS=25,50,100,200,400,600 SETTLE=30s test/guildscale/run.sh out.jsonl   # pins desk-rtc to 4 CPUs (DESK_CPUS), clients to 8
```

With `desk-rtc` on another box, forward its `rtc.sock` to the client box (`ssh -L /tmp/rtc.sock:/run/desk/rtc.sock`) and give `guildscale --socket /tmp/rtc.sock --public-ipv4 <the desk's address> --iface ens5 --pid <no such process>`: the clients' ICE then leaves through the interface and back through the desk's shaper (desk-net-031's traffic run). Memory and CPU then read 0, since they're the desk's.

**Measured (2026-11-07), x86_64:** the build server, an AMD EPYC 7402, `desk-rtc` pinned to 4 threads (a `c7g.xlarge` has 4 vCPUs), the clients to 8 others, with no `GOMEMLIMIT`. Two runs; raw lines in `test/guildscale/results/`. Memory a session is (RSS − RSS with none) ÷ sessions; CPU is `desk-rtc`'s own, over 15 s.

| Sessions (members) | RSS | Go heap live | MiB a session | CPU, cores | `stats.get` | Spike, MiB a session |
|---|---|---|---|---|---|---|
| 0 | 10.3 MiB | | | 0 | 0.7–0.9 ms | |
| 200 (67) | 116–121 MiB | 52 MB | **0.53–0.55** | 0.12 | 4.7–5.1 ms, 1 part | 0.67–0.68 |
| 400 (134) | 215–225 MiB | 102–105 MB | 0.51–0.54 | 0.21–0.25 | 10–21 ms, 2 parts | 0.75–0.76 |
| 600 (200) | 317–331 MiB | 151–161 MB | **0.51–0.53** | 0.26–0.31 | 10–19 ms, 2 parts | |

- **Less than the spike's 0.67 to 0.76 MiB,** though this is the real `desk-rtc` with six channels, credit and its scheduler: a Guild Desk session opens no `input` or `keys`, reads with 16 KiB buffers instead of Pion's 64, and has no media interceptors. Per session it stays flat from 200 to 600.
- **CPU is small:** about 0.5 ms of a core a second per session for this traffic (0.3 KB a second down and 0.2 up each, plus a 1 KB update every 5 to 10 s), 0.26 to 0.31 of a core at 600. The traffic went through whole: 302 KB a second to the browsers and 185 KB a second to `deskd` at 600, and no send failed.
- **600 sessions opened in 5.3 to 5.7 s,** 8 at a time, after 400. `member.close` of a member's 3 sessions with 597 others open took 1.1 to 1.7 ms to `member.closed` (nothing queued on `ctl`, so no flush wait).
- **`stats` passed 64 KiB at about 400 sessions,** which is why a Guild Desk's comes in parts: before that, the reply at 600 was dropped. Members' bytes matched the sessions' in every reply.
- **arm64:** ADR 0077's model takes ×1.1 for arm64 (a guess), so about 0.6 MiB a session, 360 MiB at 600, on Graviton. The load gate on a real guild server replaces this.

**The unit on a Guild Desk:** `MemoryMax=512M` and `Environment=GOMEMLIMIT=384MiB` in a drop-in for `desk-rtc.service`. With light traffic that's room to spare (the runs above: 151 to 161 MB of live heap, about 330 MiB RSS at 600); what bounds it under load is "Memory: a bound", above, and the burst profile below. Every other desk keeps `run`'s 96 MiB under 128M.

### Prove the bound: the burst profile

`guildscale --load` (`test/guildscale/loadtest.go`), run by `test/guildscale/load.sh` from prebuilt binaries: `desk-rtc` in a systemd scope with `MemoryMax`, `MemorySwapMax=0` and `GOMEMLIMIT`, pinned to 4 CPUs, and the scope's `memory.peak` and `oom_kill` in the last line. After the sessions open and settle: 30 s steady, then the burst, then 20 s after. In the burst, a tenth of the sessions move a large item each way every 5 s (`--bulk-frac`, `--bulk-bytes`), a fifth of those with `deskd` granting a second late; a few members' clients never read, with `deskd` sending to them all the time (`--slow`); a tenth are on ICE-TCP; and one member's three sessions flood 1-byte messages on `keys`, `input` and `collab`, and on a stream that isn't a channel, rejoining each time `desk-rtc` ends that one (`--attacker`). Every other session sends a probe on `rpc` each second, which the harness, as `deskd`, answers at once: the round trip other members see, through `desk-rtc` both ways.

```bash
# on the box, as root (the scope needs systemd), with arm64 builds of desk-rtc and guildscale:
tc qdisc add dev lo root netem delay 20ms limit 100000          # 40 ms round trips
DESK_CPUS=0-3 CLIENT_CPUS=4-15 LEVELS=600 SETTLE=20s ./load.sh ./desk-rtc ./guildscale out.jsonl --load 120s --slow 6
```

**Measured (2026-11-08), Graviton3:** a `c7g.4xlarge` with `desk-rtc` 0.4.0 pinned to 4 vCPUs, a `c7g.xlarge`'s, under `MemoryMax=512M` and `GOMEMLIMIT=384MiB`, the 600 clients on the other 12, 40 ms round trips. 600 sessions, 200 members. Raw lines in `test/guildscale/results/arm64-*.jsonl`.

| Run | Burst | Peak, the scope's `memory.peak` | Peak RSS | Live heap | OOM kills | CPU, of 4 | Budget peak, `deskd` to clients | Round trip p50 / p95 / p99 / max (steady: 40.15 / 40.18 / 40.20 / 43 ms) | Closed |
|---|---|---|---|---|---|---|---|---|---|
| The brief's: `deskd`'s 256 KiB credit | 60 sessions moving 1 MiB each way every 5 s, 12 with late grants, 6 stalled members, 60 on ICE-TCP, the attacker (4.6 million messages) | **405.6 MiB** | 385 MiB | 193 MB | **0** | 0.97 | 20.7 MiB; none withheld or shed | **40.17 / 42.25 / 51.53 / 909 ms**; ICE-TCP p99 48.2 | 52, all the attacker's, `protocol_error` |
| The same, `deskd` asking for 64 KiB | as above (5.7 million messages) | 394.4 MiB | 378 MiB | 190 MB | 0 | 0.98 | 8.3 MiB | 40.17 / 41.45 / 49.75 / 1,090 ms | 52, the attacker's |
| Four times the brief | 150 sessions moving 4 MiB each way every 5 s, 30 stalled members, the rest as above | 436.9 MiB | 382 MiB | 203 MB | 0 | 2.83 | 54.1 MiB: past the soft line, 6,684 grants held back; none shed | 40.28 / 86.2 / 678 / 3,171 ms; ICE-TCP p99 113 | 50, the attacker's |

- **Memory holds**, with 75 to 118 MiB of the unit's 512 left at the peak, and `desk-rtc` never restarted. The budget's soft line acted only at four times the brief's load, and nothing was shed.
- **Other members don't feel the brief's burst:** +0.02 ms at the median and +11 ms at p99. The rare outliers near a second (one or two in 64,000 probes, also in the 20 s after the burst) weren't traced; the harness's own process carries all 600 clients, so they're not `desk-rtc`'s alone. At four times the load `desk-rtc` uses 2.8 of its 4 cores and the tail grows: p95 +46 ms, p99 +0.6 s.
- **The attacker** sent 4.6 to 5.7 million 1-byte messages and was closed 50 to 52 times, each time `protocol_error`, rejoining within 2 s; no other session closed. Its floods on `keys` and `collab` ended at the 1024-chunk cap too, when `desk-rtc`'s reader fell behind them.
- `deskd` asking for 64 KiB of credit cuts the budget's peak from 20.7 to 8.3 MiB.

## Not built yet

| What | Where it goes |
|---|---|
| Congestion control. The bitrate in `stream.conf` goes out whatever the link: no transport-wide CC, no resolution ladder, no "reduced quality" chip (design §6.5) | `media.go`, plus bitrate commands to `desk-stream` |
| Remote resolution changes (design §6.3). Coordinates and the X size already follow them, but nothing runs xrandr or restarts the pipeline yet | `deskd` and `desk-stream` |
| Cropped live islands (design §7.4) | Phase 3 |
| DTLS certificate rotation. An expired certificate is replaced at startup, and nothing rotates before that | `internal/identity` |
| `relay` in `transport`: a relayed client looks like `udp` here. There's no TURN yet | `transport()` in `session.go` |
| Per-source rate limits on STUN. TCP 443's waiting connections are counted per network in `desk-rtc`'s own gate from 0.4.1 ("The ICE-TCP gate"), after the handshake; desk-net-031's nftables limits on TCP 443 counted SYNs (Security's `NET031-3`) and were taken out before any release | nftables, in the image |
| Desk-to-desk guild peer sessions (full ICE, offering side) | Retired by ADR 0077: members open client sessions to the Guild Desk ("Guild mode"). `gateway-shim` still refuses `peer.open` |

## Known limits

- **`bulk` is also capped at about 2 Mbps while the session views** (design §4.2.6).
- **`bulk` runs at most 64 KiB per round trip.** Pion's `BufferedAmount` counts bytes until they're acknowledged, so the 64 KiB limit of design §4.2.6 covers data in flight too. Measured on a 200 Mbit/s link: 35.5 Mbit/s at 10 ms RTT, 8.8 at 50 ms, 4.5 at 100 ms.
- **A Guild Desk member's flood of tiny frames costs `deskd` an envelope each.** `desk-rtc` holds none of it (H1's limits), and a stream that falls behind past 1024 messages ends the session, but up to then each 1-byte message a client sends reaches `deskd` as its own `DATA`. There's no rate limit per session yet; `deskd` can close a session that floods it.
- **A client can stall its own `ctl` by uploading too much at once.** SCTP's receive window (4 MiB here) is shared by all channels. If `deskd` stops draining `bulk` and a client sends past that window, everything from that client waits, `ctl` included. Other sessions aren't affected. Up to 1 MiB in flight was tested and stays fine.
