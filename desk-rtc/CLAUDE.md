# desk-rtc

Go module, Pion v4. The desk's WebRTC endpoint and its dev tools. Usage is in `README.md`; the spec is `docs/interfaces/desk-runtime.md` and design §4.2.

- Follow the spec. If it's wrong, finish what you can and report the proposed change: don't edit the spec, the design or the root `CLAUDE.md` from here.
- `gateway-shim` and `fake-deskd` are dev tools and must never ship on a desk. Only `desk-rtc` goes in the release artifact.
- The workstation has 2 cores shared by several sessions. Build and test with `-p 1`, and don't run tests in parallel.
- Go is in `~/.local/go/bin`. `CGO_ENABLED=0` always.
- Stage only `desk-rtc/` paths. Other sessions share this checkout.

## Commands
- `./build.sh`: both architectures and the release artifact, in `dist/`.
- `go test -p 1 -parallel 1 ./...`: unit and end-to-end, about a minute.
- `cd test/browser && npm install --ignore-scripts && npm run check`: headless Chromium, after `./build.sh`. Needs Node 20 or later, from `~/.local/node-v24/bin`.
- `test/stream/proof.mjs`: the media and input proof. It needs a real desk box and a client box, so it's in the README, not `go test`.
- `XCLIP_TEST_DISPLAY=:173 go test -p 1 -parallel 1 ./internal/xclip/ ./internal/rtcserver/`: the clipboard against a real X server, which you start yourself. `test/clipproof`: against real Chromium. Both are in the README. **Only ever on a display you started.** On this workstation `:10` runs every working session. Name the display, and don't run any X client here without `DISPLAY` set to it.
- Timing-dependent behavior needs repeated runs: a close-reason race here only showed up in about one run in three.

## Where things are
- `internal/rtcserver`: `desk-rtc` itself. `guild.go` (a Guild Desk's mode: many members, data only, per-member bytes, `member.close`; README "Guild mode"), `voicerelay.go` (a Guild Desk's relay of Commons' voice ICE from 443 to `127.0.0.1:8799`, through Pion's `OnUnhandledPacket` and the TCP gate), `server.go` (socket, deskd link), `session.go` (one PeerConnection), `sched.go` (priority, credit, the `bulk` cap, the clipboard's replies below session data), `tcpgate.go` (drops unknown ufrags before Pion allocates, and holds new ICE-TCP connections in places counted per /24 or /64 until their first frame: README, "The ICE-TCP gate"), `offer.go` (fingerprint and section checks), `stream.go` (the `desk-stream` link and fan-out), `media.go` (tracks and per-viewer forwarding).
- `internal/xinput`: the `input` and `keys` events, and XTEST into `:99`. Pure Go; never add cgo.
- `internal/xclip`: the X `CLIPBOARD` selection, both ways, with its own connection, window and goroutine. `conn.go` (dial, `pump`, `kill`), `xclip.go` (the worker, `set`, `clipboard.changed`), `serve.go` (requestors), `read.go` (owners). `rtcserver/clipboard.go` hands messages over to it. Behavior and what `deskd` needs: README, "The clipboard".
- `internal/xext`: XFIXES setup for any connection in this process. Use it, never `xfixes.Init`.
- `STATUS.md`: handoff 15 B (TD-209), moved here from the branch root at its merge.
- `internal/rtcsock`: the wire protocol, and a client for tests. `internal/frame`: §4.2.4 frames. `internal/identity`: the DTLS identity.
- `internal/shim`, `internal/fakedeskd`, `internal/client`, `internal/devtoken`, `internal/gw`: dev tools. Each has a Guild Desk side (`--desk-kind guild`, `ma-guild+jwt`).
- `test/guildscale`: memory and CPU with hundreds of Guild Desk sessions. Heavy: run it on the build server, not here.
- `test/gateflood`: floods the ICE-TCP gate from many source networks, and forges SYNs, beside a real ICE-TCP client (`box.sh`). A denial-of-service tool: only on a throwaway box of your own, never a desk.

## Pion facts this code depends on
- `TCPMuxDefault` allocates on any STUN request, so `tcpgate.go` filters first. Don't remove it.
- With no shared codec, Pion answers with every codec on its engine, so `offer.go` leaves H.264 off the engine when the offer lacks it. That's what rejects the section.
- `pc.AddTrack` between `SetRemoteDescription` and `CreateAnswer` reuses the offered transceiver and makes the answer `sendonly`. That's what lets video start with no renegotiation.
- `TrackLocalStaticRTP.WriteRTP` rewrites SSRC and payload type per binding, and drops silently before DTLS is up. Sequence numbers and timestamps are ours (`forward` in `media.go`).
- `BufferedAmount` counts bytes until they're acknowledged, so the 64 KiB limit also caps a channel at 64 KiB per round trip.
- A failed DTLS handshake can surface as `Closed` before `Failed`, so `endReason` has to give the same answer for both.

## xgb facts this code depends on
- `xfixes.Init` writes process-wide tables with no lock, and every connection's reader reads them. Two connections make that a data race, and possibly a fatal concurrent map access: the race detector shows it. So `internal/xext`.
- `xgb.Conn.Close` waits for a round trip, and a server that's stopped or grabbed never answers. `NewConnNet` is the only way to keep the socket, and closing that is what unblocks every call. It doesn't look up a cookie for the display, and a desk doesn't use one.
- The reader blocks on a full event queue, and replies come through the same reader. So one goroutine has to keep taking events while another waits on a reply.
- `xproto`'s `ChangeProperty` only has the 16-bit request length, so about 256 KiB at most, whatever BIG-REQUESTS allows.
- Decoding masks off the bit that marks an event as sent by `SendEvent`, so forged events can't be told from real ones.
- Keep X's events in the order they came: a requestor's delete from its last transfer precedes its next request, and the other way round it overwrites that request's `INCR` header.
