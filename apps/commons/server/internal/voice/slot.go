package voice

import (
	"math/rand/v2"
	"sync"
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// slot is one voice a member hears. Whoever holds it, the member sees one steady stream: the
// server keeps the slot's sequence numbers and timestamps running on from the last packet it sent,
// so the browser's jitter buffer never sees a jump backwards.
type slot struct {
	i     int
	track *webrtc.TrackLocalStaticRTP
	srcA  atomic.Int32   // member index of the holder, -1 for none
	sent  *atomic.Uint64 // the listener's voice bytes sent, for metering

	mu      sync.Mutex
	src     int32
	mapped  bool
	inSSRC  uint32
	seqOff  uint16
	tsOff   uint32
	started bool
	lastSeq uint16
	lastTs  uint32
	lastAt  int64
}

func (s *slot) srcLoad() int32 { return s.srcA.Load() }

// assign gives the slot to member src (or -1). The next packet from src starts a new mapping.
func (s *slot) assign(src int32) {
	s.mu.Lock()
	s.src = src
	s.mapped = false
	s.mu.Unlock()
	s.srcA.Store(src)
}

// forward rewrites one packet from src for this slot and sends it. It returns the bytes written,
// or 0 if src doesn't hold the slot.
func (s *slot) forward(src int32, in *rtp.Packet, now int64) int {
	s.mu.Lock()
	if s.src != src {
		s.mu.Unlock()
		return 0
	}
	marker := in.Marker
	if !s.mapped || in.SSRC != s.inSSRC {
		var seq uint16
		var ts uint32
		if s.started {
			seq = s.lastSeq + 1
			// Advance by the real gap, at least one 20 ms frame (960 samples at 48 kHz).
			adv := uint32((now - s.lastAt) * 48 / 1_000_000)
			ts = s.lastTs + max(adv, 960)
		} else {
			seq = uint16(rand.Uint32())
			ts = rand.Uint32()
		}
		s.seqOff = seq - in.SequenceNumber
		s.tsOff = ts - in.Timestamp
		s.inSSRC = in.SSRC
		s.mapped = true
		marker = true // a new talkspurt
	}
	h := in.Header
	h.SequenceNumber = in.SequenceNumber + s.seqOff
	h.Timestamp = in.Timestamp + s.tsOff
	h.Marker = marker
	h.Extension = false
	h.Extensions = nil
	h.ExtensionProfile = 0
	h.CSRC = nil
	if !s.started || int16(h.SequenceNumber-s.lastSeq) > 0 {
		s.lastSeq, s.lastTs, s.lastAt = h.SequenceNumber, h.Timestamp, now
	}
	s.started = true
	s.mu.Unlock()
	if err := s.track.WriteRTP(&rtp.Packet{Header: h, Payload: in.Payload}); err != nil {
		return 0
	}
	n := h.MarshalSize() + len(in.Payload)
	if s.sent != nil {
		s.sent.Add(uint64(n))
	}
	return n
}
