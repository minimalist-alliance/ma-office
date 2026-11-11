# Vendored code in `desk-rtc`

## `pion-webrtc/`: Pion WebRTC v4.2.26, with three settings added

`go.mod` replaces `github.com/pion/webrtc/v4` with this folder. It is Pion's v4.2.26 release (MIT, `LICENSE`), with
the tests, examples and the media readers and writers `desk-rtc` doesn't use left out, and three `SettingEngine` settings
added. Nothing else differs; with none set, it behaves as v4.2.26. Only a Guild Desk's sessions set the first two, and only a
shared host's slot sets the third (`internal/rtcserver/session.go`, `newAPI`), so every other desk runs Pion as before.

| Setting | What it does | Why |
|---|---|---|
| `SetSCTPMaxReassemblyQueueEntries(n)` | Passes `sctp.WithMaxReassemblyQueueEntries(n)` to the association: each stream holds at most `n` DATA chunks unread, and past it pion/sctp aborts the association as a protocol violation. pion/sctp v1.12.0 has the option; webrtc v4.2.26 never passes it | The receive window counts payload bytes only, and each message costs Pion about 300 bytes more, so 1-byte messages on a stream nobody reads parked about 300 times the window (the review of guild mode, H1: +1.3 GiB from one session) |
| `SetSCTPRejectUnnegotiatedStreams(true)` | Every data channel is negotiated, so data on any other stream is an error at its first chunk: the transport's `OnError` and `OnClose` hear it, and it accepts no more streams. A negotiated channel's stream that arrives before the channel opened is still taken | Without it, the first chunk of a fragmented message that never completes holds `datachannel.Server`, and up to 16 more streams queue behind it, unread, for the association's life |

| `SetICEUfragPrefix(prefix)` (from desk-rtc 0.5.0) | Every local ICE ufrag starts with `prefix`, the first and the new one at each ICE restart, each with fresh random letters after it (16 in all) and a fresh 32-letter password, as Pion makes them without it. Ignored when `SetICECredentials` sets static ones | On a shared desk host with one public IPv4 every slot's ICE-TCP comes in on the host's one TCP 443, and the host's demux routes a connection by the slot's tag (`s<kk>`) on the ufrag its first STUN request names (`internal/rtcserver/shared.go`). Pion's own `SetICECredentials` is static: an ICE restart would keep the old ufrag and password |

The diff against upstream is in `settingengine.go` (the three fields and setters), `sctptransport.go`
(`optionalSCTPClientOptions`, and `rejectUnnegotiatedStreams` called from `acceptDataChannels`), `icegatherer.go`
(`credentialOptions`) and `icetransport.go` (`restart`) for the prefix, and the new `ufragprefix.go`.

**To move to a newer Pion:** copy the new release's non-test files the same way (`rsync` from the module cache,
leaving out `*_test.go`, `examples/`, `e2e/`, `test-wasm/` and `pkg/media/*/`), apply the three changes again, run `go
mod tidy`, and run the whole suite with `-race`. If upstream has gained either setting, use it and drop this folder.
