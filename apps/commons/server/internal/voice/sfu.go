// Package voice is Commons' voice: a forwarding server (an SFU) on Pion, audio only.
//
// Each member in the room has one WebRTC connection to the guild server, DTLS-SRTP like any
// WebRTC call. The member's offer carries one sendrecv audio line (their microphone, and the first
// voice they hear) and Slots-1 recvonly lines. The server sends the voices of the room's talkers
// into those slots, so a member's connection never renegotiates however many people join: a slot
// changes hands by rewriting SSRC, sequence numbers and timestamps, and the member is told who is
// in which slot. When more people are unmuted than a member has slots, the ones heard most
// recently keep them, judged by the RFC 6464 audio level each browser already sends.
//
// The server never decodes, mixes or stores audio. The media engine knows only Opus, so no video
// can be negotiated at all.
package voice

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// Config sets up the SFU.
type Config struct {
	// UDP is where media arrives: one port for every member (ICE-lite on a UDP mux).
	UDP *net.UDPAddr
	// Advertise is the address members reach UDP on, if not UDP's own.
	Advertise string
	// Slots is how many voices a member hears at once.
	Slots int
	// Batch sends with sendmmsg(2), many packets per system call (batch.go).
	Batch bool
	// Sockets spreads members over this many UDP ports, from UDP's port up. 0: one per core, at
	// most 8.
	Sockets int
	// NoDTX stops browsers from sending almost nothing in silence (for comparison only).
	NoDTX bool
	// RelayUDP and RelayTCP are where desk-rtc relays voice ICE it takes on the guild desk's port 443 for members whose
	// network blocks UDP 8791 and up (127.0.0.1:8799 on a guild desk): datagrams on UDP, ICE-TCP (RFC 4571, passive)
	// on TCP. Empty: off. desk-rtc tells Commons' traffic from its own by the ICE ufrag, which here always starts with
	// UfragPrefix.
	RelayUDP, RelayTCP string
	// RelayPort is the public port members reach the relay on (443). Answers carry host candidates for Advertise on it,
	// UDP and TCP, below the direct UDP ones. Only with Advertise.
	RelayPort int
	// Police holds each talker to what Opus voice needs, before anything is forwarded (police.go).
	Police Police
}

// UfragPrefix starts every voice connection's ICE ufrag, so desk-rtc, which shares port 443, can tell Commons'
// connectivity checks from its own and pass them to the relay listeners.
const UfragPrefix = "cmns"

// opusFmtp is what the server says it accepts. usedtx=1 lets a browser send almost nothing while
// its member is silent, which is most of the time in a room.
const opusFmtp = "minptime=10;useinbandfec=1;usedtx=1"

// Level thresholds, RFC 6464 (-dBov, 0 is loudest, 127 silence).
const (
	voiceLevel   = 55                     // at or under this, someone is talking
	speakingHold = 300 * time.Millisecond // the speaking light stays on this long after
	quietToSwap  = 1500 * time.Millisecond
)

// Events are what the SFU tells the room.
type Events struct {
	Slots    func(member uint16, slots []int32) // who is in each slot, -1 for none
	Speaking func(members []uint16)
	ICE      func(member uint16, c webrtc.ICECandidateInit)
	Down     func(member uint16) // the connection failed or closed
	// Policed is called, instead of Down, when the SFU closed a member's voice connection for sending far more than
	// voice needs for several seconds (police.go). Called outside the SFU's lock.
	Policed func(member uint16)
	// Usage reports the voice bytes sent to a member's voice connection since it began: every UsageEvery while it
	// lasts, and once more, final, when it ends. A new connection starts again at 0. Called outside the SFU's lock.
	Usage func(member uint16, voiceBytesSent uint64, final bool)
}

// UsageEvery is how often Usage reports a live voice connection's bytes. A var so tests can shorten it.
var UsageEvery = 30 * time.Second

// Counters for the stats page.
type Counters struct {
	PacketsIn, BytesIn, PacketsOut, BytesOut atomic.Uint64
	// PolicedPackets and PolicedBytes are what the police dropped before forwarding (never charged to a listener);
	// PolicedCloses is how many voice connections it closed.
	PolicedPackets, PolicedBytes, PolicedCloses atomic.Uint64
}

// SFU forwards voice between the members of one server's rooms.
type SFU struct {
	cfg     Config
	ses     []webrtc.SettingEngine // one per voice port; each connection gets its own API from one, with its own ufrag
	me      *webrtc.MediaEngine
	reg     *interceptor.Registry
	muxes   []ice.UDPMux
	relayU  ice.UDPMux
	relayT  ice.TCPMux
	relayUP int // the relay UDP listener's local port, to find its candidates
	relayTP int
	creds   *credentials // live voice connections' ICE credentials, for the relay gate
	gateU   *gatedPacketConn
	batches []*batchConn
	slots   int
	police  Police
	ev      Events
	C       Counters

	mu       sync.Mutex
	peers    map[uint16]*Peer
	speaking []uint16
	stop     chan struct{}
	// Slot maps go out in the order they were dealt, from one goroutine, outside s.mu.
	notify chan slotMap

	fwdSumUs, fwdN, fwdMaxUs atomic.Uint64
}

type slotMap struct {
	member uint16
	slots  []int32
}

// Peer is one member's connection.
type Peer struct {
	sfu   *SFU
	Idx   uint16
	room  string // members hear only their own room (a Commons channel); guarded by sfu.mu
	ufrag string // this connection's ICE ufrag, live in sfu.creds while it lasts

	sent       atomic.Uint64 // RTP bytes the SFU has sent to this connection, for metering
	lastReport int64         // mono() of the last Usage report; guarded by sfu.mu
	reportMu   sync.Mutex    // orders Usage reports: none after the final one
	pc         *webrtc.PeerConnection
	slots      []*slot

	muted     atomic.Bool
	hasTrack  atomic.Bool
	lastVoice atomic.Int64 // monotonic ns of the last packet that sounded like talking
	outs      atomic.Pointer[[]*slot]
	closed    atomic.Bool

	// Guarded by sfu.mu: which slot each talker holds at this peer.
	held map[uint16]*slot
}

var start = time.Now()

func mono() int64 { return int64(time.Since(start)) }

// New opens the UDP ports and starts the SFU's clock.
func New(cfg Config, ev Events) (*SFU, error) {
	if cfg.Slots < 1 {
		cfg.Slots = 10
	}
	if cfg.Sockets < 1 {
		// One per core: a single socket's sends serialize in the kernel, and at 100,000
		// packets a second that queued voice by hundreds of milliseconds (README, load test).
		cfg.Sockets = min(max(runtime.GOMAXPROCS(0), 1), 8)
	}
	fmtp := opusFmtp
	if cfg.NoDTX {
		fmtp = "minptime=10;useinbandfec=1"
	}
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: fmtp},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	if err := me.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI}, webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverDirectionRecvonly); err != nil {
		return nil, err
	}
	reg := &interceptor.Registry{}
	// Sender and receiver reports only: audio needs no NACK, and no bandwidth estimate.
	if err := webrtc.ConfigureRTCPReports(reg); err != nil {
		return nil, err
	}

	s := &SFU{
		cfg:    cfg,
		creds:  &credentials{pwd: map[string]string{}},
		me:     me,
		reg:    reg,
		slots:  cfg.Slots,
		police: cfg.Police.withDefaults(),
		ev:     ev,
		peers:  map[uint16]*Peer{},
		stop:   make(chan struct{}),
		notify: make(chan slotMap, 8192),
	}
	// desk-rtc's relay for members whose network blocks UDP 8791 and up: loopback listeners every connection may use.
	networks := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	if cfg.RelayUDP != "" {
		rc, err := net.ListenPacket("udp4", cfg.RelayUDP)
		if err != nil {
			return nil, fmt.Errorf("voice: relay udp: %w", err)
		}
		_ = rc.(*net.UDPConn).SetReadBuffer(4 << 20)
		_ = rc.(*net.UDPConn).SetWriteBuffer(4 << 20)
		// Anyone can reach this through 443: the gate lets only Commons' own live connections' checks in.
		s.gateU = newGatedPacketConn(rc, s.creds)
		s.relayU = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: s.gateU})
		s.relayUP = rc.LocalAddr().(*net.UDPAddr).Port
	}
	if cfg.RelayTCP != "" {
		ln, err := net.Listen("tcp4", cfg.RelayTCP)
		if err != nil {
			s.closeMuxes()
			return nil, fmt.Errorf("voice: relay tcp: %w", err)
		}
		s.relayT = ice.NewTCPMuxDefault(ice.TCPMuxParams{Listener: newGatedListener(ln, s.creds), ReadBufferSize: 64, WriteBufferSize: 4 << 20})
		s.relayTP = ln.Addr().(*net.TCPAddr).Port
		networks = append(networks, webrtc.NetworkTypeTCP4)
	}
	// One socket can only send so fast, so a big room spreads its members over a few ports.
	for i := 0; i < cfg.Sockets; i++ {
		addr := *cfg.UDP
		if addr.Port != 0 {
			addr.Port += i
		}
		conn, err := net.ListenUDP("udp4", &addr)
		if err != nil {
			s.closeMuxes()
			return nil, err
		}
		// A busy room sends tens of thousands of small packets a second.
		_ = conn.SetWriteBuffer(8 << 20)
		_ = conn.SetReadBuffer(8 << 20)
		var pconn net.PacketConn = conn
		if cfg.Batch {
			bc := newBatchConn(conn)
			s.batches = append(s.batches, bc)
			pconn = bc
		}
		mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: pconn})
		s.muxes = append(s.muxes, mux)

		var se webrtc.SettingEngine
		se.SetLite(true)
		if s.relayU != nil {
			se.SetICEUDPMux(ice.NewMultiUDPMuxDefault(mux, s.relayU))
		} else {
			se.SetICEUDPMux(mux)
		}
		if s.relayT != nil {
			se.SetICETCPMux(s.relayT)
		}
		se.SetNetworkTypes(networks)
		se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
		// Loopback addresses are gathered so the relay listeners have candidates to take checks on. Members never see
		// them on a guild desk: answers name only the public address (answerCandidates).
		se.SetIncludeLoopbackCandidate(true)
		// Consent: an ICE-lite server only answers checks. Drop a member 15 s after they go quiet.
		se.SetICETimeouts(5*time.Second, 10*time.Second, 0)
		s.ses = append(s.ses, se)
	}
	go s.tick()
	go func() {
		for m := range s.notify {
			if s.ev.Slots != nil {
				s.ev.Slots(m.member, m.slots)
			}
		}
	}()
	return s, nil
}

// Slots is how many voices a member hears at once.
func (s *SFU) Slots() int { return s.slots }

// Sockets is how many UDP ports voice uses.
func (s *SFU) Sockets() int { return len(s.muxes) }

// QueueStats is the batched sender's queueing: mean and worst wait, in ms, since the last call.
func (s *SFU) QueueStats() (meanMs, maxMs float64) {
	var sum, n, mx uint64
	for _, b := range s.batches {
		sum += b.QueueSumUs.Swap(0)
		n += b.QueueN.Swap(0)
		mx = max(mx, b.QueueMaxUs.Swap(0))
	}
	if n > 0 {
		meanMs = float64(sum) / float64(n) / 1000
	}
	return meanMs, float64(mx) / 1000
}

// ForwardStats is the time a talker's read loop spends forwarding one packet to every slot it
// holds: mean and worst since the last call, in ms.
func (s *SFU) ForwardStats() (meanMs, maxMs float64) {
	sum, n, mx := s.fwdSumUs.Swap(0), s.fwdN.Swap(0), s.fwdMaxUs.Swap(0)
	if n > 0 {
		meanMs = float64(sum) / float64(n) / 1000
	}
	return meanMs, float64(mx) / 1000
}

// SendDrops is how many packets the batched sender dropped because a queue was full.
func (s *SFU) SendDrops() uint64 {
	var n uint64
	for _, b := range s.batches {
		n += b.Drops.Load()
	}
	return n
}

// Close stops every connection and the port.
func (s *SFU) Close() {
	close(s.stop)
	s.mu.Lock()
	peers := make([]*Peer, 0, len(s.peers))
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		s.Remove(p.Idx)
	}
	s.closeMuxes()
}

func (s *SFU) closeMuxes() {
	for _, m := range s.muxes {
		m.Close()
	}
	if s.relayU != nil {
		s.relayU.Close()
	}
	if s.relayT != nil {
		s.relayT.Close()
	}
}

// api makes a connection's own API: its voice port's settings, with an ICE ufrag that starts with UfragPrefix. It
// returns the credentials too, for the relay gate.
func (s *SFU) api(idx uint16) (*webrtc.API, string, string, error) {
	se := s.ses[int(idx)%len(s.ses)]
	ufrag, err := randomICE(12)
	if err != nil {
		return nil, "", "", err
	}
	pwd, err := randomICE(24)
	if err != nil {
		return nil, "", "", err
	}
	ufrag = UfragPrefix + ufrag
	se.SetICECredentials(ufrag, pwd)
	return webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(s.me), webrtc.WithInterceptorRegistry(s.reg)), ufrag, pwd, nil
}

func randomICE(n int) (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b), nil
}

// Answer takes a member's offer and returns the server's answer, plus the mid of each slot.
func (s *SFU) Answer(room string, idx uint16, offer string, muted bool) (answer string, mids []string, err error) {
	s.Remove(idx)
	api, ufrag, pwd, err := s.api(idx)
	if err != nil {
		return "", nil, err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", nil, err
	}
	p := &Peer{sfu: s, Idx: idx, room: room, pc: pc, held: map[uint16]*slot{}, ufrag: ufrag, lastReport: mono()}
	// Live from now, so the member's first checks through the relay get in; gone when the connection ends or fails.
	s.creds.add(ufrag, pwd)
	p.muted.Store(muted)
	empty := []*slot{}
	p.outs.Store(&empty)

	fail := func(e error) (string, []string, error) {
		s.creds.remove(ufrag)
		pc.Close()
		return "", nil, e
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return fail(err)
	}
	audio := 0
	for _, t := range pc.GetTransceivers() {
		if t.Kind() == webrtc.RTPCodecTypeAudio {
			audio++
		} else {
			t.Stop() // anything but audio is refused
		}
	}
	if audio == 0 {
		return fail(errors.New("voice: the offer has no audio"))
	}
	n := min(audio, s.slots)
	for i := 0; i < n; i++ {
		tr, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			fmt.Sprintf("slot%d", i), fmt.Sprintf("commons-slot%d", i))
		if err != nil {
			return fail(err)
		}
		sender, err := pc.AddTrack(tr)
		if err != nil {
			return fail(err)
		}
		go drainRTCP(sender)
		sl := &slot{i: i, track: tr, src: -1, sent: &p.sent}
		sl.srcA.Store(-1)
		p.slots = append(p.slots, sl)
	}
	pc.OnTrack(func(t *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
		if t.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		go p.read(t, r)
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil && s.ev.ICE != nil {
			s.ev.ICE(idx, c.ToJSON())
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			if s.removePeer(p) && s.ev.Down != nil {
				s.ev.Down(idx)
			}
		}
	})
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(ans); err != nil {
		return fail(err)
	}
	select {
	case <-gathered:
	case <-time.After(2 * time.Second):
	}
	// The mid of each slot, in slot order, so the client knows which line is which.
	for _, sl := range p.slots {
		mid := ""
		for _, t := range pc.GetTransceivers() {
			if snd := t.Sender(); snd != nil && snd.Track() == sl.track {
				mid = t.Mid()
			}
		}
		mids = append(mids, mid)
	}
	s.mu.Lock()
	s.peers[idx] = p
	s.allocate()
	s.mu.Unlock()
	return s.answerCandidates(pc.LocalDescription().SDP), mids, nil
}

// answerCandidates sets the candidates members see. With Advertise (a guild desk): every candidate names the public
// address; the direct ones keep their port (8791 and up), and the relay listeners' become the public RelayPort (443),
// UDP and TCP, at lower priorities, so a browser uses them only when the direct ones fail. Loopback and private
// addresses never reach a member, and each address and port is named once. Without Advertise (-dev, tests), the
// gathered candidates go as they are.
func (s *SFU) answerCandidates(answer string) string {
	if s.cfg.Advertise == "" {
		return answer
	}
	lines := strings.Split(answer, "\r\n")
	out := make([]string, 0, len(lines))
	seen := map[string]bool{}
	for _, l := range lines {
		if !strings.HasPrefix(l, "a=candidate:") {
			out = append(out, l)
			continue
		}
		f := strings.Fields(strings.TrimPrefix(l, "a=candidate:"))
		// foundation component transport priority address port "typ" type [extensions]
		if len(f) < 8 || f[6] != "typ" {
			continue
		}
		port, err := strconv.Atoi(f[5])
		if err != nil {
			continue
		}
		transport := strings.ToLower(f[2])
		relayed := (transport == "udp" && s.relayU != nil && port == s.relayUP) || (transport == "tcp" && s.relayT != nil && port == s.relayTP)
		if transport == "tcp" && !relayed {
			continue
		}
		if relayed {
			if s.cfg.RelayPort <= 0 {
				continue
			}
			port = s.cfg.RelayPort
			// Host type, local preference below the direct UDP candidates': UDP 443 first, then TCP 443.
			pref := 30000
			if transport == "tcp" {
				pref = 20000
			}
			comp, _ := strconv.Atoi(f[1])
			f[3] = strconv.Itoa(126<<24 | pref<<8 | (256 - max(comp, 1)))
		}
		f[4] = s.cfg.Advertise
		f[5] = strconv.Itoa(port)
		key := transport + " " + f[4] + " " + f[5]
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, "a=candidate:"+strings.Join(f, " "))
	}
	return strings.Join(out, "\r\n")
}

// AddICE adds a member's trickled candidate.
func (s *SFU) AddICE(idx uint16, c webrtc.ICECandidateInit) error {
	s.mu.Lock()
	p := s.peers[idx]
	s.mu.Unlock()
	if p == nil {
		return nil
	}
	return p.pc.AddICECandidate(c)
}

// SetRoom moves a member's voice to another room (a Commons channel) without renegotiating: they stop hearing the
// old one's talkers and start hearing the new one's at the next deal, which is now.
func (s *SFU) SetRoom(idx uint16, room string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.peers[idx]; p != nil && p.room != room {
		p.room = room
		s.allocate()
	}
}

// SetMuted mutes or unmutes a member. A muted member's packets are dropped here too, whatever
// their browser sends.
func (s *SFU) SetMuted(idx uint16, muted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.peers[idx]; p != nil {
		p.muted.Store(muted)
		s.allocate()
	}
}

// Remove ends a member's connection.
func (s *SFU) Remove(idx uint16) {
	s.mu.Lock()
	p := s.peers[idx]
	s.mu.Unlock()
	if p != nil {
		s.removePeer(p)
	}
}

// policeClose ends a talker's voice connection after sustained abuse and tells the room why.
func (s *SFU) policeClose(p *Peer) {
	if s.removePeer(p) {
		s.C.PolicedCloses.Add(1)
		log.Printf("voice: member %d: closed, over the voice limits for %d s", p.Idx, s.police.AbuseSecs)
		if s.ev.Policed != nil {
			s.ev.Policed(p.Idx)
		} else if s.ev.Down != nil {
			s.ev.Down(p.Idx)
		}
	}
}

func (s *SFU) removePeer(p *Peer) bool {
	if !p.closed.CompareAndSwap(false, true) {
		return false
	}
	// The relay gate lets nothing more in for it.
	s.creds.remove(p.ufrag)
	s.mu.Lock()
	if s.peers[p.Idx] == p {
		delete(s.peers, p.Idx)
	}
	s.allocate()
	s.mu.Unlock()
	go p.pc.Close()
	// Its last count, for the member's allowance. Nothing more is forwarded to it: it holds no slot now.
	if s.ev.Usage != nil {
		p.reportMu.Lock()
		s.ev.Usage(p.Idx, p.sent.Load(), true)
		p.reportMu.Unlock()
	}
	return true
}

// Peers is how many members have a voice connection.
func (s *SFU) Peers() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.peers)
}

func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			return
		}
	}
}

// read forwards one member's microphone to every slot it holds.
func (p *Peer) read(t *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
	levelID := uint8(0)
	for _, e := range r.GetParameters().HeaderExtensions {
		if e.URI == sdp.AudioLevelURI {
			levelID = uint8(e.ID)
		}
	}
	p.hasTrack.Store(true)
	p.sfu.mu.Lock()
	p.sfu.allocate()
	p.sfu.mu.Unlock()

	buf := make([]byte, 1500)
	var pkt rtp.Packet
	c := &p.sfu.C
	pol := newPolicer(p.sfu.police, mono())
	for {
		n, _, err := t.Read(buf)
		if err != nil {
			if !errors.Is(err, io.EOF) && !p.closed.Load() {
				log.Printf("voice: member %d: %v", p.Idx, err)
			}
			return
		}
		c.PacketsIn.Add(1)
		c.BytesIn.Add(uint64(n))
		// Police before anything is forwarded or counted to a listener, muted talkers included.
		if ok, abusive := pol.allow(n, mono()); !ok {
			c.PolicedPackets.Add(1)
			c.PolicedBytes.Add(uint64(n))
			if abusive {
				p.sfu.policeClose(p)
				return
			}
			continue
		}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		if p.muted.Load() {
			continue
		}
		now := mono()
		if levelID != 0 {
			if ext := pkt.GetExtension(levelID); len(ext) > 0 && ext[0]&0x7f <= voiceLevel {
				p.lastVoice.Store(now)
			}
		} else if len(pkt.Payload) > 10 {
			p.lastVoice.Store(now) // no level: anything bigger than DTX silence counts
		}
		outs := *p.outs.Load()
		var sent, bytes uint64
		for _, sl := range outs {
			if w := sl.forward(int32(p.Idx), &pkt, now); w > 0 {
				sent++
				bytes += uint64(w)
			}
		}
		c.PacketsOut.Add(sent)
		c.BytesOut.Add(bytes)
		if len(outs) > 0 {
			us := uint64((mono() - now) / 1000)
			p.sfu.fwdSumUs.Add(us)
			p.sfu.fwdN.Add(1)
			for {
				m := p.sfu.fwdMaxUs.Load()
				if us <= m || p.sfu.fwdMaxUs.CompareAndSwap(m, us) {
					break
				}
			}
		}
	}
}

// tick re-deals slots when more people talk than there are slots, and sends the speaking lights.
func (s *SFU) tick() {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
		s.mu.Lock()
		s.allocate()
		now := mono()
		var speaking []uint16
		for idx, p := range s.peers {
			if !p.muted.Load() && now-p.lastVoice.Load() < int64(speakingHold) && p.lastVoice.Load() != 0 {
				speaking = append(speaking, idx)
			}
		}
		sort.Slice(speaking, func(i, j int) bool { return speaking[i] < speaking[j] })
		changed := !equal16(speaking, s.speaking)
		s.speaking = speaking
		var due []*Peer
		if s.ev.Usage != nil {
			for _, p := range s.peers {
				if now-p.lastReport >= int64(UsageEvery) {
					p.lastReport = now
					due = append(due, p)
				}
			}
		}
		s.mu.Unlock()
		if changed && s.ev.Speaking != nil {
			s.ev.Speaking(speaking)
		}
		for _, p := range due {
			// Never after the final report: removePeer marks the peer closed before it sends that.
			p.reportMu.Lock()
			if !p.closed.Load() {
				s.ev.Usage(p.Idx, p.sent.Load(), false)
			}
			p.reportMu.Unlock()
		}
	}
}

// allocate deals slots. Called with s.mu held.
//
// Every unmuted member with a microphone track is a talker. A talker keeps a slot at a listener
// until they leave or mute, or until someone without a slot starts talking while they've been quiet
// for quietToSwap. Free slots go to whoever talked most recently.
func (s *SFU) allocate() {
	now := mono()
	var talkers []*Peer
	for _, p := range s.peers {
		if p.hasTrack.Load() && !p.muted.Load() {
			talkers = append(talkers, p)
		}
	}
	sort.Slice(talkers, func(i, j int) bool {
		a, b := talkers[i].lastVoice.Load(), talkers[j].lastVoice.Load()
		if a != b {
			return a > b
		}
		return talkers[i].Idx < talkers[j].Idx
	})
	isTalker := make(map[uint16]bool, len(talkers))
	for _, t := range talkers {
		isTalker[t.Idx] = true
	}
	changedOuts := false
	for _, l := range s.peers {
		changed := false
		for idx, sl := range l.held {
			if !isTalker[idx] || s.peers[idx] == nil || s.peers[idx].room != l.room {
				delete(l.held, idx)
				sl.assign(-1)
				changed = true
			}
		}
		var free []*slot
		for _, sl := range l.slots {
			if sl.srcLoad() < 0 {
				free = append(free, sl)
			}
		}
		for _, t := range talkers {
			if t.Idx == l.Idx || t.room != l.room {
				continue
			}
			if _, ok := l.held[t.Idx]; ok {
				continue
			}
			if len(free) == 0 {
				// Only someone talking right now may take a quiet talker's slot.
				if now-t.lastVoice.Load() > int64(speakingHold) || t.lastVoice.Load() == 0 {
					continue
				}
				var victim uint16
				var oldest int64 = 1 << 62
				for idx := range l.held {
					if v := s.peers[idx].lastVoice.Load(); v < oldest {
						oldest, victim = v, idx
					}
				}
				if now-oldest < int64(quietToSwap) {
					continue
				}
				sl := l.held[victim]
				delete(l.held, victim)
				sl.assign(-1)
				free = append(free, sl)
			}
			sl := free[0]
			free = free[1:]
			sl.assign(int32(t.Idx))
			l.held[t.Idx] = sl
			changed = true
		}
		if changed {
			changedOuts = true
			m := make([]int32, len(l.slots))
			for i, sl := range l.slots {
				m[i] = sl.srcLoad()
			}
			select {
			case s.notify <- slotMap{l.Idx, m}:
			default:
				log.Printf("voice: slot notices backed up; member %d missed one", l.Idx)
			}
		}
	}
	if !changedOuts {
		return
	}
	outs := map[uint16][]*slot{}
	for _, l := range s.peers {
		for idx, sl := range l.held {
			outs[idx] = append(outs[idx], sl)
		}
	}
	for idx, p := range s.peers {
		o := outs[idx]
		p.outs.Store(&o)
	}
}

func equal16(a, b []uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
