# Vendored code in `desk-rtc`

## `pion-webrtc/`: Pion WebRTC v4.2.26, with two settings added

`go.mod` replaces `github.com/pion/webrtc/v4` with this folder. It is Pion's v4.2.26 release (MIT, `LICENSE`), with
the tests, examples and the media readers and writers `desk-rtc` doesn't use left out, and two `SettingEngine` settings
added. Nothing else differs; with neither set, it behaves as v4.2.26. Only a Guild Desk's sessions set them
(`internal/rtcserver/session.go`, `newAPI`), so every other desk runs Pion as before.

| Setting | What it does | Why |
|---|---|---|
| `SetSCTPMaxReassemblyQueueEntries(n)` | Passes `sctp.WithMaxReassemblyQueueEntries(n)` to the association: each stream holds at most `n` DATA chunks unread, and past it pion/sctp aborts the association as a protocol violation. pion/sctp v1.12.0 has the option; webrtc v4.2.26 never passes it | The receive window counts payload bytes only, and each message costs Pion about 300 bytes more, so 1-byte messages on a stream nobody reads parked about 300 times the window (the review of guild mode, H1: +1.3 GiB from one session) |
| `SetSCTPRejectUnnegotiatedStreams(true)` | Every data channel is negotiated, so data on any other stream is an error at its first chunk: the transport's `OnError` and `OnClose` hear it, and it accepts no more streams. A negotiated channel's stream that arrives before the channel opened is still taken | Without it, the first chunk of a fragmented message that never completes holds `datachannel.Server`, and up to 16 more streams queue behind it, unread, for the association's life |

The diff against upstream is in `settingengine.go` (the two fields and setters) and `sctptransport.go`
(`optionalSCTPClientOptions`, and `rejectUnnegotiatedStreams` called from `acceptDataChannels`).

**To move to a newer Pion:** copy the new release's non-test files the same way (`rsync` from the module cache,
leaving out `*_test.go`, `examples/`, `e2e/`, `test-wasm/` and `pkg/media/*/`), apply the two changes again, run `go
mod tidy`, and run the whole suite with `-race`. If upstream has gained either setting, use it and drop this folder.
