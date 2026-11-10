package rtcserver

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Media for one session. desk-runtime.md sections 4.4 and 8.5: the client orders its offer audio, video,
// data. Audio is never rejected, audio and video are answered sendonly with idle tracks so starting
// video needs no renegotiation, and video alone may be rejected when there's no shared codec.

const (
	// playoutDelayURI lets the sender ask for no playout smoothing. Chrome honors it (design 6.5).
	playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

	videoClock = 90000
	audioClock = 48000

	// viewerQueue bounds one viewer's RTP: about half a second at 8 Mbps. Past it packets are dropped
	// and that viewer waits for a keyframe, so a slow ICE-TCP client can't hold up the others.
	viewerQueue = 512

	nackBuffer = 1024
)

// maxHold caps a client's HOLD: half a second is more than any sound path, and a session can only slow its own picture.
const maxHold = 500 * time.Millisecond

// playoutDelay is the playout-delay extension with min and max both d, in its 10 ms units. 0, 0 is the
// lowest latency; d, d makes the browser show each frame d after it could (ADR 0037).
func playoutDelay(d time.Duration) []byte {
	n := uint32((d + 5*time.Millisecond) / (10 * time.Millisecond))

	return []byte{byte(n >> 4), byte(n<<4) | byte(n>>8), byte(n)}
}

// setHold applies a client's HOLD to its video: the picture waits for its sound (pictureHold.ts in the app).
func (s *session) setHold(ms uint16) {
	d := min(time.Duration(ms)*time.Millisecond, maxHold)
	if f := s.videoOut; f != nil {
		f.hold.Store(int64(d))
	}
}

// newMediaEngine registers what the desk can send: Opus and constrained-baseline H.264. H.264 stays
// off when the offer doesn't have it, which is what makes Pion reject the section (see
// hasConstrainedBaselineH264).
func newMediaEngine(info offerInfo, playoutDelay bool) (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: opusCapability,
		PayloadType:        ptOpus,
	}, webrtc.RTPCodecTypeAudio)
	if err != nil {
		return nil, fmt.Errorf("register Opus: %w", err)
	}
	if !info.hasH264 {
		return m, nil
	}
	err = m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: h264Capability,
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo)
	if err != nil {
		return nil, fmt.Errorf("register H.264: %w", err)
	}
	if playoutDelay {
		err = m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: playoutDelayURI},
			webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverDirectionSendonly)
		if err != nil {
			return nil, fmt.Errorf("register playout-delay: %w", err)
		}
	}

	return m, nil
}

var (
	opusCapability = webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeOpus,
		ClockRate:   audioClock,
		Channels:    2,
		SDPFmtpLine: "minptime=10;useinbandfec=1",
	}
	h264Capability = webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   videoClock,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		RTCPFeedback: []webrtc.RTCPFeedback{
			{Type: "nack"},
			{Type: "nack", Parameter: "pli"},
			{Type: "ccm", Parameter: "fir"},
		},
	}
)

// newInterceptors adds what a sender needs: retransmits for NACKs, and sender reports on the capture clock (srclock.go). The
// clock's correction goes in before Pion's reports, so they're written through it.
func newInterceptors(s *session) (*interceptor.Registry, error) {
	reg := &interceptor.Registry{}
	responder, err := nack.NewResponderInterceptor(nack.ResponderSize(nackBuffer))
	if err != nil {
		return nil, err
	}
	reg.Add(responder)
	reg.Add(srClockFactory{s: s})
	sr, err := report.NewSenderInterceptor()
	if err != nil {
		return nil, err
	}
	reg.Add(sr)

	return reg, nil
}

// addTracks turns the offered sections into sendonly. Call it between SetRemoteDescription and
// CreateAnswer. The tracks stay idle until the session views (streamHub.setViewer).
func (s *session) addTracks(pc *webrtc.PeerConnection, info offerInfo) error {
	audio, err := webrtc.NewTrackLocalStaticRTP(opusCapability, "audio", "desk-audio")
	if err != nil {
		return fmt.Errorf("audio track: %w", err)
	}
	sender, err := pc.AddTrack(audio)
	if err != nil {
		return fmt.Errorf("add audio: %w", err)
	}
	go s.readRTCP(sender)
	s.audioOut = newForward(audio, audioClock, sender)

	if !info.hasH264 {
		s.tracksReady.Store(true)

		return nil
	}
	video, err := webrtc.NewTrackLocalStaticRTP(h264Capability, "video", "desk-video")
	if err != nil {
		return fmt.Errorf("video track: %w", err)
	}
	sender, err = pc.AddTrack(video)
	if err != nil {
		return fmt.Errorf("add video: %w", err)
	}
	go s.readRTCP(sender)
	s.videoOut = newForward(video, videoClock, sender)
	s.tracksReady.Store(true)

	return nil
}

// readRTCP has to run for the interceptors to see NACKs, and it turns PLI and FIR into keyframes.
func (s *session) readRTCP(sender *webrtc.RTPSender) {
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range pkts {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.link.srv.hub.requestKeyframe(keyframeGapPLI)
			}
		}
	}
}

// forward rewrites one source stream into one session's RTP. Sequence numbers stay contiguous and
// timestamps keep wall-clock pace across a pause or a change of desk-stream process, so the browser
// sees one unbroken stream that had a gap. Only the viewer's goroutine calls write.
//
// A source stamped from the monotonic clock (srclock.go) already keeps that pace, so its offset is
// picked once, at random, and never moves: the sender reports can then say exactly what the
// timestamps mean.
type forward struct {
	track  *webrtc.TrackLocalStaticRTP
	sender *webrtc.RTPSender
	clock  uint32

	extID    uint8
	extKnown bool

	seq      uint16
	tsOff    uint32
	lastTS   uint32
	lastWall time.Time
	started  bool
	clocked  bool
	restart  atomic.Bool

	// capOff is tsOff while the source is stamped from the monotonic clock, else -1. The sender
	// interceptor's goroutine reads it.
	capOff  atomic.Int64
	hold    atomic.Int64  // the client's HOLD, a time.Duration: the playout-delay this session's video carries
	ssrcVal atomic.Uint64 // the sender's SSRC plus 1, once known
}

func newForward(t *webrtc.TrackLocalStaticRTP, clock uint32, sender *webrtc.RTPSender) *forward {
	f := &forward{track: t, clock: clock, sender: sender}
	f.capOff.Store(-1)

	return f
}

// ssrc is the SSRC this session sends the track with. 0 before negotiation.
func (f *forward) ssrc() uint32 {
	if v := f.ssrcVal.Load(); v != 0 {
		return uint32(v - 1)
	}
	if f.sender == nil {
		return 0
	}
	enc := f.sender.GetParameters().Encodings
	if len(enc) == 0 || enc[0].SSRC == 0 {
		return 0
	}
	f.ssrcVal.Store(uint64(enc[0].SSRC) + 1)

	return uint32(enc[0].SSRC)
}

// playoutExt finds the negotiated id of the playout-delay extension, once it's negotiated. 0 means
// the offer doesn't have it.
func (f *forward) playoutExt() uint8 {
	if f.sender == nil {
		return 0
	}
	if !f.extKnown {
		f.extKnown = true
		for _, e := range f.sender.GetParameters().HeaderExtensions {
			if e.URI == playoutDelayURI {
				f.extID = uint8(e.ID)
			}
		}
	}

	return f.extID
}

func (f *forward) write(raw []byte) error {
	var p rtp.Packet
	if err := p.Unmarshal(raw); err != nil {
		return err
	}
	now := time.Now()
	clocked, stale := clockedTS(p.Timestamp, monoNow(), f.clock), false
	if !clocked && f.clocked {
		stale = staleTS(p.Timestamp, monoNow(), f.clock)
	}
	if stale {
		// A clocked desk-stream's first audio packet after a resume carries the encoder's last time from before the
		// pause. Sent on, it would put the rest of the timeline a pause's length ahead of the wall clock.
		return nil
	}
	switch {
	case !f.started:
		f.started = true
		f.restart.Store(false)
		if clocked {
			f.tsOff = randUint32()
		}
	case f.restart.Swap(false):
		// A clocked source after a clocked source needs nothing: its timestamps kept the pace.
		if !clocked || !f.clocked {
			ahead := uint32(now.Sub(f.lastWall).Seconds() * float64(f.clock))
			f.tsOff = f.lastTS + ahead - p.Timestamp
		}
	}
	if clocked != f.clocked || (clocked && f.capOff.Load() != int64(f.tsOff)) {
		f.clocked = clocked
		if clocked {
			f.capOff.Store(int64(f.tsOff))
		} else {
			f.capOff.Store(-1)
		}
	}
	p.Timestamp += f.tsOff
	p.SequenceNumber = f.seq
	f.seq++
	f.lastTS, f.lastWall = p.Timestamp, now
	if id := f.playoutExt(); id != 0 {
		if err := p.SetExtension(id, playoutDelay(time.Duration(f.hold.Load()))); err != nil {
			return err
		}
	}

	return f.track.WriteRTP(&p)
}

// rtpItem is one packet from desk-stream. raw is shared by every viewer, and read-only.
type rtpItem struct {
	raw   []byte
	video bool
	key   bool
}

// viewer is one session receiving media. Each has its own queue and goroutine: a write can block on a
// slow ICE-TCP client, and that must only cost that client.
type viewer struct {
	hub  *streamHub
	s    *session
	ch   chan rtpItem
	stop chan struct{}
	done chan struct{}
	// prev is the session's last viewer, if it might still be finishing: only one writes at a time.
	prev    chan struct{}
	started time.Time

	waitKey atomic.Bool
}

func newViewer(h *streamHub, s *session, prev chan struct{}) *viewer {
	v := &viewer{hub: h, s: s, ch: make(chan rtpItem, viewerQueue), stop: make(chan struct{}), done: make(chan struct{}), prev: prev, started: time.Now()}
	v.restartTimeline()

	return v
}

// restartTimeline makes the next forwarded packets start on a keyframe, on a timeline that keeps
// wall-clock pace.
func (v *viewer) restartTimeline() {
	v.waitKey.Store(v.s.videoOut != nil)
	if v.s.videoOut != nil {
		v.s.videoOut.restart.Store(true)
	}
	if v.s.audioOut != nil {
		v.s.audioOut.restart.Store(true)
	}
}

func (v *viewer) push(it rtpItem) {
	select {
	case v.ch <- it:
	default:
		v.s.rtpDropped.Add(1)
		if it.video {
			v.waitKey.Store(true)
		}
	}
}

func (v *viewer) run() {
	defer close(v.done)
	if v.prev != nil {
		<-v.prev
	}
	retry := time.NewTicker(keyframeRetry)
	defer retry.Stop()
	for {
		select {
		case <-v.stop:
			return
		case it := <-v.ch:
			v.forward(it)
		case <-retry.C:
			if v.waitKey.Load() && v.s.connected.Load() {
				// Fast for a viewer that just joined. Later it's a viewer falling behind, and more
				// keyframes only make that worse.
				gap := keyframeGapJoin
				if time.Since(v.started) > time.Second {
					gap = keyframeGapPLI
				}
				v.hub.requestKeyframe(gap)
			}
		}
	}
}

func (v *viewer) forward(it rtpItem) {
	if !v.s.connected.Load() {
		return
	}
	out := v.s.audioOut
	if it.video {
		out = v.s.videoOut
		if v.waitKey.Load() {
			if !it.key {
				return
			}
			v.waitKey.Store(false)
		}
	}
	if out == nil {
		return
	}
	if err := out.write(it.raw); err != nil && !v.s.closing.Load() {
		v.s.log.Debug("RTP write failed", "err", err)
	}
}
