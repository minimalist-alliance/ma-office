package voice

import (
	"testing"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// A slot's output stays one steady stream as it passes from one talker to another.
func TestSlotKeepsSequenceAcrossTalkers(t *testing.T) {
	tr, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	s := &slot{track: tr, src: -1}
	s.srcA.Store(-1)
	pkt := func(ssrc uint32, seq uint16, ts uint32) *rtp.Packet {
		p := &rtp.Packet{Header: rtp.Header{Version: 2, SSRC: ssrc, SequenceNumber: seq, Timestamp: ts}, Payload: []byte{1, 2, 3}}
		_ = p.SetExtension(1, []byte{30})
		return p
	}
	if s.forward(7, pkt(1, 100, 1000), 0) != 0 {
		t.Fatal("a slot nobody holds sends nothing")
	}
	s.assign(7)
	const ms = int64(1e6)
	for i := 0; i < 3; i++ {
		s.forward(7, pkt(1, uint16(100+i), uint32(1000+960*i)), int64(i)*20*ms)
	}
	seq1, ts1 := s.lastSeq, s.lastTs
	// Another talker takes the slot 500 ms later, with its own numbering.
	s.assign(9)
	s.forward(9, pkt(2, 40000, 7), 540*ms)
	if s.lastSeq != seq1+1 {
		t.Fatalf("sequence jumped: %d after %d", s.lastSeq, seq1)
	}
	if got, want := s.lastTs-ts1, uint32(500*48); got != want {
		t.Fatalf("timestamp advanced %d, want %d (the real gap)", got, want)
	}
	s.forward(9, pkt(2, 40001, 7+960), 560*ms)
	if s.lastSeq != seq1+2 || s.lastTs-ts1 != 500*48+960 {
		t.Fatalf("second packet: seq %d ts +%d", s.lastSeq-seq1, s.lastTs-ts1)
	}
	// The old talker's late packets are dropped.
	if s.forward(7, pkt(1, 103, 1000+960*3), 561*ms) != 0 {
		t.Fatal("a talker who lost the slot is still forwarded")
	}
}
