package rtcserver

import (
	"math/rand/v2"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"golang.org/x/sys/unix"
)

// Sender reports on desk-stream's capture clock (desk-runtime.md section 8.2, ADR 0037).
//
// desk-stream stamps its RTP from CLOCK_MONOTONIC: the pipeline's base time is 0 and it has no start time, so running time is
// the monotonic clock, and its payloaders add no offset. A packet's timestamp is then the instant its first sample or frame was
// captured, in the track's clock rate, modulo 2^32, and both tracks read the same clock. desk-rtc shares that clock, so a
// sender report here can say exactly which RTP time is "now" on each track, and a browser can tell which sound goes with which
// picture.
//
// Pion's own report maps the RTP time of the last frame to when desk-rtc sent it. That's a different moment for each track: audio
// waits for a 20 ms Opus frame and Pulse's fragments, video for one encode. So the reports alone would put the two tracks tens of
// milliseconds apart.
//
// An older desk-stream picks a random offset. forward notices, since its timestamps aren't near the monotonic clock, and those
// reports keep Pion's mapping.

const (
	// A capture can't be in the future, and nothing reaches desk-rtc 2 s late without the viewer resetting, so a timestamp
	// outside this window wasn't stamped from the monotonic clock.
	clockedAhead  = 100 * time.Millisecond
	clockedBehind = 2 * time.Second

	ntpEpochOffset = 2208988800 // seconds from 1900 to 1970
)

// monoNow reads CLOCK_MONOTONIC, the clock GStreamer's system clock uses by default.
func monoNow() time.Duration {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return 0
	}

	return time.Duration(ts.Nano())
}

// monoTicks is GStreamer's RTP time for a running time, gst_util_uint64_scale_int(t, rate, GST_SECOND) truncated to 32 bits,
// without the overflow a plain product has after a couple of days of uptime.
func monoTicks(t time.Duration, rate uint32) uint32 {
	sec, ns := uint64(t/time.Second), uint64(t%time.Second)

	return uint32(sec*uint64(rate) + ns*uint64(rate)/uint64(time.Second))
}

// clockedTS says whether an RTP timestamp from desk-stream was stamped from the monotonic clock at about `now`.
func clockedTS(ts uint32, now time.Duration, rate uint32) bool {
	lag := int64(int32(monoTicks(now, rate) - ts)) // ticks since capture; the wrap is handled by the int32

	return lag >= -int64(clockedAhead)*int64(rate)/int64(time.Second) && lag <= int64(clockedBehind)*int64(rate)/int64(time.Second)
}

// staleTS says whether a timestamp from a clocked desk-stream is from the past, by more than clockedBehind and less than a
// minute: what its encoder still held from before a pause.
func staleTS(ts uint32, now time.Duration, rate uint32) bool {
	lag := int64(int32(monoTicks(now, rate) - ts))

	return lag > int64(clockedBehind)*int64(rate)/int64(time.Second) && lag < 60*int64(rate)
}

// randUint32 is a forward's starting offset, so a client never learns the desk's uptime from its timestamps.
func randUint32() uint32 { return rand.Uint32() }

func toNTP(t time.Time) uint64 {
	sec := uint64(t.Unix()) + ntpEpochOffset
	frac := uint64(t.Nanosecond()) << 32 / uint64(time.Second)

	return sec<<32 | frac
}

// srClockFactory makes the interceptor that corrects Pion's sender reports. It must be registered before Pion's sender
// interceptor: a chain wraps writers in order, so the sender interceptor then writes its reports through this one.
type srClockFactory struct{ s *session }

func (f srClockFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &srClock{s: f.s}, nil
}

type srClock struct {
	interceptor.NoOp
	s *session
}

func (i *srClock) BindRTCPWriter(w interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, a interceptor.Attributes) (int, error) {
		for _, p := range pkts {
			if sr, ok := p.(*rtcp.SenderReport); ok {
				i.s.clockReport(sr)
			}
		}

		return w.Write(pkts, a)
	})
}

// clockReport rewrites a sender report's time pair onto the capture clock, when the track's source is stamped from it. Pion's
// packet and octet counts stay as they are.
func (s *session) clockReport(sr *rtcp.SenderReport) {
	for _, f := range []*forward{s.audioOut, s.videoOut} {
		if f == nil || f.ssrc() != sr.SSRC {
			continue
		}
		off := f.capOff.Load()
		if off < 0 {
			return
		}
		now := time.Now()
		sr.NTPTime = toNTP(now)
		sr.RTPTime = monoTicks(monoNow(), f.clock) + uint32(off)

		return
	}
}
