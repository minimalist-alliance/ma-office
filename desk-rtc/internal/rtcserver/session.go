package rtcserver

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/datachannel"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xinput"
)

// Reasons desk-rtc reports in session.closed when it closes a session itself.
const (
	reasonConsentTimeout   = "consent_timeout"
	reasonConnectTimeout   = "connect_timeout"
	reasonDTLSFailed       = "dtls_failed"
	reasonIdentityMismatch = "identity_mismatch"
	reasonFrameTooLarge    = "frame_too_large"
	reasonCreditViolation  = "credit_violation"
	reasonLinkLost         = "rtc_link_lost"
	reasonClientClosed     = "client_closed"
	// A Guild Desk session only (guild.go): SCTP from the client that desk-rtc can't take, such as data on a stream
	// no channel has, and the desk's budget shedding the session holding the most (budget.go).
	reasonProtocolError = "protocol_error"
	reasonOverBudget    = "over_budget"
)

const (
	gatherTimeout  = 5 * time.Second
	closeFlushWait = 500 * time.Millisecond
	pcCloseTimeout = 3 * time.Second
	// inputActivityEvery is the section 4.3 limit on input.activity.
	inputActivityEvery = time.Second
	// Large enough that a client within its transfer credit doesn't fill SCTP's shared receive
	// window while deskd is slow, which would hold up ctl from the client too.
	sctpReceiveBuffer = 4 * 1024 * 1024
)

type session struct {
	id       string
	handle   uint32
	link     *link
	expected []byte
	log      *slog.Logger
	// guild and memberID are set at creation and never change: a Guild Desk's session, data channels only, and the
	// member it belongs to (guild.go).
	guild    bool
	memberID string
	// leaving is a Guild Desk session that member.close is closing: it no longer counts toward its member's limit, and
	// nothing more of the client's goes to deskd (guild.go).
	leaving atomic.Bool
	// violated: SCTP aborted the association for a protocol violation (guild.go's sctpWatch).
	violated atomic.Bool

	permVideo atomic.Bool
	permInput atomic.Bool
	view      atomic.Bool // session.video: this session wants media now

	audioOut    *forward
	videoOut    *forward
	tracksReady atomic.Bool // audioOut and videoOut are set
	// lastViewerDone closes when the session's latest viewer goroutine has ended. streamHub.mu guards it.
	lastViewerDone chan struct{}
	// quality is the session's QUALITY ask (levelNone until it asks), and qualitySent the last reply it got
	// (quality.go). streamHub.mu guards both.
	quality     level
	qualitySent [xinput.EventSize]byte
	keysOut     atomic.Pointer[datachannel.ReadWriteCloser]

	negMu sync.Mutex // serializes start, ICE restart and close
	// iceUfrag is the desk-side ICE ufrag of the latest answer; negMu guards it.
	iceUfrag string
	pc       atomic.Pointer[webrtc.PeerConnection]

	tx *txSched
	rx [rtcsock.NumBridged]*creditGate

	closing   atomic.Bool
	closeOnce sync.Once

	connected     atomic.Bool
	lastTransport atomic.Value // string
	lastActivity  atomic.Int64

	inputDropped  atomic.Uint64
	keysDropped   atomic.Uint64
	eventsDropped atomic.Uint64
	rtpDropped    atomic.Uint64
}

func newSession(l *link, id string, handle uint32, expected []byte, perm rtcsock.Permissions) *session {
	s := &session{
		id:       id,
		handle:   handle,
		link:     l,
		expected: expected,
		log:      l.srv.log.With("session", id),
	}
	s.permVideo.Store(perm.Video)
	s.permInput.Store(perm.Input)
	s.tx = newTxSched(func(channel uint8, n uint32) {
		l.out.pushCtrl(rtcsock.EncodeCredit(handle, channel, n))
	})
	for i := range s.rx {
		s.rx[i] = newCreditGate()
	}

	return s
}

func (s *session) newAPI(publicIP string, info offerInfo) (*webrtc.API, error) {
	srv := s.link.srv

	var se webrtc.SettingEngine
	se.SetLite(true)
	se.SetICEUDPMux(srv.udpMux)
	se.SetICETCPMux(srv.tcpMux)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetIncludeLoopbackCandidate(srv.bindIP.IsLoopback())
	if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:        []string{publicIP},
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:            webrtc.ICEAddressRewriteReplace,
	}); err != nil {
		return nil, err
	}
	// Consent freshness: disconnected at a third of the timeout, failed at all of it. A keepalive of
	// 0 stops Pion sending binding requests; an ICE-lite desk only answers them.
	disconnected := srv.cfg.ConsentTimeout / 3
	se.SetICETimeouts(disconnected, srv.cfg.ConsentTimeout-disconnected, 0)
	se.DetachDataChannels()
	se.SetSCTPMaxMessageSize(rtcsock.MaxFrame)
	se.SetSCTPMaxReceiveBufferSize(sctpReceiveBuffer)
	if s.guild {
		// A small window and a cap on what each stream may hold unread (guild.go): Pion's window counts payload
		// bytes only, and a message costs it hundreds more.
		se.SetSCTPMaxReceiveBufferSize(guildSCTPReceiveBuffer)
		se.SetSCTPMaxReassemblyQueueEntries(guildReassemblyEntries)
		se.SetSCTPRejectUnnegotiatedStreams(true) // so only the eight channels' streams can hold anything
	}
	se.LoggerFactory = srv.pionLogs
	if s.guild {
		se.LoggerFactory = sctpWatch{LoggerFactory: srv.pionLogs, s: s}
	}

	me, err := newMediaEngine(info, !srv.cfg.NoPlayoutDelay && !s.guild)
	if err != nil {
		return nil, err
	}
	reg := &interceptor.Registry{} // a Guild Desk sends no RTP, so nothing to retransmit or report on
	if !s.guild {
		if reg, err = newInterceptors(s); err != nil {
			return nil, err
		}
	}

	return webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(reg)), nil
}

// start builds the PeerConnection and returns the answer SDP.
func (s *session) start(offer, publicIP string, info offerInfo) (string, error) {
	s.negMu.Lock()
	defer s.negMu.Unlock()
	if s.closing.Load() {
		return "", errors.New("session closed during setup")
	}

	api, err := s.newAPI(publicIP, info)
	if err != nil {
		return "", err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		Certificates:  []webrtc.Certificate{s.link.srv.id.Certificate},
		BundlePolicy:  webrtc.BundlePolicyMaxBundle,
		RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
	if err != nil {
		return "", err
	}
	s.pc.Store(pc)

	pc.OnConnectionStateChange(s.onConnectionState)
	pc.OnDataChannel(func(d *webrtc.DataChannel) {
		// Every channel is pre-negotiated. Anything else would sit unread in SCTP's shared window.
		s.log.Warn("closing unexpected data channel", "label", d.Label())
		_ = d.Close()
	})
	pc.SCTP().Transport().ICETransport().OnSelectedCandidatePairChange(func(pair *webrtc.ICECandidatePair) {
		s.learnClientNetwork(pair)
		if s.connected.Load() && !s.closing.Load() {
			s.reportTransportChange()
		}
	})
	if s.guild {
		// Data on a stream that isn't one of the eight, or SCTP that breaks, ends the session: Pion stops taking the
		// client's streams then, and anything sent on one no channel reads would sit in SCTP for the session's life.
		pc.SCTP().OnError(func(err error) {
			s.log.Info("SCTP error from the client", "err", err)
			go s.close(reasonProtocolError, false)
		})
		pc.SCTP().OnClose(func(err error) {
			if err != nil {
				go s.close(reasonProtocolError, false)
			} else {
				go s.close(reasonClientClosed, false)
			}
		})
	}

	// All eight on every desk. A Guild Desk reads input and keys and drops what comes (readChannel): a channel nobody
	// reads would keep everything the client sends on it.
	for i := range rtcsock.Channels {
		if err := s.createChannel(pc, &rtcsock.Channels[i]); err != nil {
			return "", err
		}
	}
	go s.tx.run(func(channel uint8, err error) {
		if !s.closing.Load() {
			s.log.Warn("data channel write failed", "channel", channel, "err", err)
		}
	})

	media := func(pc *webrtc.PeerConnection) error { return s.addTracks(pc, info) }
	if s.guild {
		media = stopMedia
	}
	answer, err := s.negotiate(offer, media)
	if err != nil {
		return "", err
	}
	s.updateViewing() // session.video can arrive while the answer is being made

	return answer, nil
}

func (s *session) negotiate(offer string, beforeAnswer func(*webrtc.PeerConnection) error) (string, error) {
	pc := s.pc.Load()
	err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer})
	if err != nil {
		return "", &offerError{rtcsock.CodeBadOffer, err.Error()}
	}
	if beforeAnswer != nil {
		if err := beforeAnswer(pc); err != nil {
			return "", err
		}
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return "", err
	}
	// Gathering is local and takes milliseconds: there are no STUN or TURN servers. The answer
	// carries both host candidates, since the client's offer went out without trickle.
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		return "", errors.New("ICE gathering timed out")
	}
	local := pc.LocalDescription()
	if local == nil {
		return "", errors.New("no local description")
	}

	s.registerICE(offer, local.SDP)

	return dropComponent2Candidates(local.SDP), nil
}

// learnClientNetwork tells the gate which network a session's selected candidate pair has the client on, so a returning
// member's usual networks keep reserved places (tcpgate.go, knownNets). A selected pair means checks signed with this
// session's ICE password came from there.
func (s *session) learnClientNetwork(pair *webrtc.ICECandidatePair) {
	srv := s.link.srv
	if pair == nil || pair.Remote == nil || srv.gate == nil {
		return
	}
	if a, err := netip.ParseAddr(pair.Remote.Address); err == nil {
		srv.gate.learnKnown(clientNetwork(a.Unmap()))
	}
}

// registerICE tells the gate about the session's desk-side ICE credentials, once the answer exists and before the
// client can have seen it: the password its first frame must be signed with, and the client networks it's expected
// from (its offer's candidates, and the ones its earlier ufrag's checks came from). Called with negMu held.
func (s *session) registerICE(offer, localSDP string) {
	srv := s.link.srv
	ufrag, pwd := iceCredentials(localSDP)
	if ufrag == "" || srv.tcpMux == nil || srv.gate == nil {
		return
	}
	srv.tcpMux.setPassword(ufrag, pwd)
	nets := offerNetworks(offer, srv.bindIP.IsLoopback())
	if s.iceUfrag != "" && s.iceUfrag != ufrag {
		nets = append(nets, srv.gate.hintsOf(s.iceUfrag)...)
	}
	srv.gate.setHints(ufrag, nets)
	s.iceUfrag = ufrag
}

// dropComponent2Candidates removes the copy of each candidate Pion writes for component 2. rtcp-mux is
// required, so those mean nothing, and the contract says the answer carries exactly two candidates.
func dropComponent2Candidates(sdp string) string {
	lines := strings.Split(sdp, "\r\n")
	out := lines[:0]
	for _, l := range lines {
		if strings.HasPrefix(l, "a=candidate:") {
			if f := strings.Fields(l); len(f) > 1 && f[1] == "2" {
				continue
			}
		}
		out = append(out, l)
	}

	return strings.Join(out, "\r\n")
}

func (s *session) createChannel(pc *webrtc.PeerConnection, def *rtcsock.ChannelDef) error {
	negotiated := true
	ordered := def.Ordered
	id := uint16(def.ID)
	dc, err := pc.CreateDataChannel(def.Label, &webrtc.DataChannelInit{
		Ordered:        &ordered,
		MaxRetransmits: def.MaxRetransmits,
		Negotiated:     &negotiated,
		ID:             &id,
	})
	if err != nil {
		return fmt.Errorf("data channel %s: %w", def.Label, err)
	}

	channel := def.ID
	if channel < rtcsock.NumBridged {
		dc.SetBufferedAmountLowThreshold(sctpLowWater)
		dc.OnBufferedAmountLow(s.tx.notify)
	}
	dc.OnOpen(func() {
		raw, err := dc.Detach()
		if err != nil {
			s.log.Error("detach failed", "channel", def.Label, "err", err)

			return
		}
		if channel < rtcsock.NumBridged {
			s.tx.setSink(channel, dcSink{raw: raw, dc: dc})
		}
		if channel == rtcsock.ChKeys && !s.guild {
			s.keysOut.Store(&raw)
			if s.viewing() {
				s.sendCurrentCursor()
			}
		}
		go s.readChannel(channel, raw)
	})

	return nil
}

type dcSink struct {
	raw datachannel.ReadWriteCloser
	dc  *webrtc.DataChannel
}

func (d dcSink) Write(frame []byte) (int, error) { return d.raw.Write(frame) }
func (d dcSink) BufferedAmount() uint64          { return d.dc.BufferedAmount() }

// readChannel moves one channel's client frames toward deskd.
func (s *session) readChannel(channel uint8, raw io.Reader) {
	buf := make([]byte, s.readBufferSize(channel))
	for {
		n, err := raw.Read(buf)
		if err != nil {
			switch {
			case s.closing.Load() || errors.Is(err, io.EOF):
			case errors.Is(err, io.ErrShortBuffer):
				s.log.Warn("client frame over the read buffer", "channel", channel)
				go s.close(reasonFrameTooLarge, false)
			default:
				// Pion surfaces the client's SCTP abort here, which is how a client normally leaves.
				s.log.Debug("data channel read ended", "channel", channel, "err", err)
				go s.close(reasonClientClosed, false)
			}

			return
		}
		switch channel {
		case rtcsock.ChInput, rtcsock.ChKeys:
			if s.guild {
				s.countInputDrop(channel) // no screen: read, so it can't pile up, and dropped

				continue
			}
			s.onInput(channel, buf[:n])

			continue
		case rtcsock.ChEvents:
			// events runs desk to client only.
			s.eventsDropped.Add(1)

			continue
		}
		if n > rtcsock.MaxFrame {
			s.log.Warn("client frame over 16 KiB", "channel", channel, "bytes", n)
			go s.close(reasonFrameTooLarge, false)

			return
		}
		if !s.rx[channel].acquire(n) {
			return
		}
		env := rtcsock.EncodeData(s.handle, channel, buf[:n])
		var budget *guildBudget
		if s.guild {
			budget = s.link.srv.budget
			if !budget.acquireRx(frameCharge(len(env)), s.closing.Load) {
				return
			}
		}
		s.link.out.pushCharged(channel, env, budget)
	}
}

// onInput decodes one event from channel 6 or 7 (section 8.6) and injects it, for sessions with input.
func (s *session) onInput(channel uint8, b []byte) {
	if channel == rtcsock.ChKeys && s.onQuality(b) {
		return
	}
	ev, ok := xinput.Parse(b)
	if ok && (ev.Kind == xinput.Move) != (channel == rtcsock.ChInput) {
		ok = false // MOVE only on input, everything else only on keys
	}
	if ok && ev.Kind == xinput.Hold {
		s.setHold(ev.HoldMs) // not input, so no permission or activity

		return
	}
	if !ok || !s.permInput.Load() {
		s.countInputDrop(channel)

		return
	}
	if in := s.link.srv.input; in != nil && !in.Submit(s.handle, ev) {
		s.countInputDrop(channel)

		return
	}
	now := time.Now()
	last := s.lastActivity.Load()
	if now.UnixNano()-last < int64(inputActivityEvery) || !s.lastActivity.CompareAndSwap(last, now.UnixNano()) {
		return
	}
	s.link.sendJSON(&rtcsock.Message{
		T:         "input.activity",
		SessionID: s.id,
		At:        now.UTC().Format(time.RFC3339Nano),
	})
}

func (s *session) countInputDrop(channel uint8) {
	if channel == rtcsock.ChInput {
		s.inputDropped.Add(1)
	} else {
		s.keysDropped.Add(1)
	}
}

// setPermissions applies session.permissions.
func (s *session) setPermissions(video, input *bool) {
	if s.guild {
		return // no screen: video and input stay off (guild.go)
	}
	if video != nil {
		s.permVideo.Store(*video)
	}
	if input != nil {
		s.permInput.Store(*input)
		if !*input {
			if in := s.link.srv.input; in != nil {
				in.Release(s.handle)
			}
		}
	}
	s.updateViewing()
}

// setView applies session.video.
func (s *session) setView(view bool) {
	s.view.Store(view)
	s.updateViewing()
}

// viewing is section 8.4: media flows only while the token allows it and the session wants it.
func (s *session) viewing() bool {
	return s.view.Load() && s.permVideo.Load() && !s.closing.Load()
}

func (s *session) updateViewing() {
	if !s.tracksReady.Load() {
		return // start calls this again once the tracks exist
	}
	want := s.viewing()
	s.link.srv.hub.setViewer(s, want)
	if want {
		s.tx.setBulkCap(bulkCapWhileViewing)
		if in := s.link.srv.input; in != nil {
			in.Kick()
		}
		s.sendCurrentCursor()
	} else {
		s.tx.setBulkCap(0)
	}
}

func (s *session) sendCurrentCursor() {
	if in := s.link.srv.input; in != nil {
		if c := in.CurrentCursor(); c != nil {
			s.sendCursor(xinput.CursorMessage(*c))
		}
	}
}

// sendCursor writes one CURSOR message on keys. Dropped if the channel isn't open yet: opening it sends
// the current shape.
func (s *session) sendCursor(msg []byte) { s.sendKeys(msg) }

// sendKeys writes one message on keys, and says whether the channel was open. Writes don't block: Pion
// buffers them.
func (s *session) sendKeys(msg []byte) bool {
	raw := s.keysOut.Load()
	if raw == nil {
		return false
	}
	if _, err := (*raw).Write(msg); err != nil && !s.closing.Load() {
		s.log.Debug("keys write failed", "err", err)
	}

	return true
}

// iceRestart answers an ICE-restart offer on the same PeerConnection. DTLS, SCTP and the channels
// carry on (design 4.2.7).
func (s *session) iceRestart(offer string) (string, error) {
	if _, oerr := parseOffer(offer, s.expected); oerr != nil {
		return "", oerr
	}
	s.negMu.Lock()
	defer s.negMu.Unlock()
	if s.closing.Load() || s.pc.Load() == nil {
		return "", &offerError{rtcsock.CodeBadOffer, "session is not open"}
	}
	if s.guild {
		return s.negotiate(offer, stopMedia) // a section the restart adds gets no track either
	}

	return s.negotiate(offer, nil)
}

func (s *session) transport() string {
	pc := s.pc.Load()
	if pc == nil {
		return ""
	}
	pair, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil {
		if v, ok := s.lastTransport.Load().(string); ok {
			return v
		}

		return ""
	}
	// TODO(TURN): the client is a peer-reflexive candidate here, so a relayed client looks like udp.
	// Reporting relay needs turn.'s addresses from deskd; there is no TURN yet (contract 0.3.3).
	t := pair.Local.Protocol.String()
	s.lastTransport.Store(t)

	return t
}

func (s *session) reportTransportChange() {
	prev, _ := s.lastTransport.Load().(string)
	if cur := s.transport(); cur != prev && cur != "" {
		s.sendState("connected")
	}
}

func (s *session) sendState(state string) {
	s.link.sendJSON(&rtcsock.Message{
		T:         "session.state",
		SessionID: s.id,
		State:     state,
		Transport: s.transport(),
	})
}

func (s *session) onConnectionState(state webrtc.PeerConnectionState) {
	if s.closing.Load() {
		return
	}
	s.log.Debug("connection state", "state", state.String())
	switch state {
	case webrtc.PeerConnectionStateConnected:
		s.connected.Store(true)
		s.sendState("connected")
	case webrtc.PeerConnectionStateDisconnected:
		s.sendState("disconnected")
	case webrtc.PeerConnectionStateFailed:
		s.sendState("failed")
		go s.close(s.endReason(false), false)
	case webrtc.PeerConnectionStateClosed:
		// Our own closes set closing first, so this came from the DTLS layer.
		go s.close(s.endReason(true), false)
	default:
	}
}

// endReason says why a PeerConnection ended on its own. A failed DTLS handshake can reach us as Failed
// or as Closed, in either order, so both paths have to give the same answer.
func (s *session) endReason(closedByDTLS bool) string {
	pc := s.pc.Load()
	if remote := pc.SCTP().Transport().GetRemoteCertificate(); len(remote) > 0 {
		sum := sha256.Sum256(remote)
		if !bytes.Equal(sum[:], s.expected) {
			return reasonIdentityMismatch
		}
	}
	switch {
	case s.connected.Load() && closedByDTLS:
		return reasonClientClosed
	case s.connected.Load():
		return reasonConsentTimeout
	case closedByDTLS:
		return reasonDTLSFailed
	case pc.ICEConnectionState() == webrtc.ICEConnectionStateFailed:
		return reasonConnectTimeout
	default:
		return reasonDTLSFailed
	}
}

// close tears the session down once and reports session.closed. Safe from any goroutine.
func (s *session) close(reason string, flush bool) {
	s.closeOnce.Do(func() {
		if s.violated.Load() && reason == reasonClientClosed {
			reason = reasonProtocolError // our SCTP ended it, not the client
		}
		if flush {
			s.tx.flushCtl(closeFlushWait)
		}
		sent, received := s.teardown(true)
		s.log.Info("session closed", "reason", reason)
		s.link.sendJSON(&rtcsock.Message{T: "session.state", SessionID: s.id, State: "closed", Transport: s.lastTransportValue()})
		closed := &rtcsock.Message{T: "session.closed", SessionID: s.id, Reason: reason}
		if s.guild {
			// The session's final bytes, for the member's meter (guild.go): the same numbers as its closed row in stats.
			closed.MemberID, closed.BytesSent, closed.BytesReceived = s.memberID, &sent, &received
		}
		s.link.sendJSON(closed)
	})
}

// abort ends a session deskd never got an answer for: it hears session.error, not session.closed.
func (s *session) abort() {
	s.closeOnce.Do(func() { s.teardown(false) })
}

// teardown ends the session and returns its final byte counts. keep says a Guild Desk session's closed row stays in
// stats for deskd (guild.go); a session deskd never had an answer for has none.
func (s *session) teardown(keep bool) (sent, received uint64) {
	s.closing.Store(true)
	s.link.srv.hub.setViewer(s, false)
	if in := s.link.srv.input; in != nil {
		in.Release(s.handle)
	}
	s.tx.stop()
	for _, g := range s.rx {
		g.close()
	}
	if s.guild {
		s.link.srv.budget.wakeRx() // its readers may be waiting for room
	}
	// Out of the table and into the totals in one step, so a stats counts these bytes once (Server.statsMu). Once a
	// stats had the session gone and its bytes not yet counted, which read as a fall in what the desk had sent.
	srv := s.link.srv
	srv.statsMu.Lock()
	s.link.forget(s)
	counted := s.pc.Load() != nil
	if counted {
		sent, received = s.byteCounts()
		srv.addTotals(sent, received)
		srv.addMemberTotalsLocked(s.memberID, sent, received)
	}
	if s.guild && keep {
		srv.keepClosedLocked(s.closedRow(sent, received))
	}
	srv.statsMu.Unlock()
	if h := afterForget.Load(); h != nil {
		(*h)()
	}

	// Waits out a setup in progress, so its PeerConnection gets closed too.
	s.negMu.Lock()
	pc := s.pc.Load()
	s.negMu.Unlock()
	if pc == nil {
		return sent, received
	}
	// A setup that finished after the step above: out of the table already, so no stats counted it live.
	if !counted {
		sent, received = s.byteCounts()
		srv.addTotals(sent, received)
		if s.memberID != "" {
			srv.statsMu.Lock()
			srv.addMemberTotalsLocked(s.memberID, sent, received)
			if s.guild && keep {
				srv.updateClosedLocked(s.id, sent, received)
			}
			srv.statsMu.Unlock()
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := pc.Close(); err != nil {
			s.log.Debug("PeerConnection close", "err", err)
		}
	}()
	// Bounded, so session.closed and the section 4.1 limit of 5 s hold even if Pion stalls.
	select {
	case <-done:
	case <-time.After(pcCloseTimeout):
		s.log.Warn("PeerConnection close is slow")
	}

	return sent, received
}

func (s *session) lastTransportValue() string {
	v, _ := s.lastTransport.Load().(string)

	return v
}

func (s *session) byteCounts() (sent, received uint64) {
	pc := s.pc.Load()
	if pc == nil {
		return 0, 0
	}
	st := pc.SCTP().Transport().ICETransport().Stats()

	return st.BytesSent, st.BytesReceived
}

func (s *session) stats() rtcsock.SessionStats {
	sent, received := s.byteCounts()
	var rtt float64
	if pc := s.pc.Load(); pc != nil {
		rtt = pc.SCTP().Stats().SmoothedRoundTripTime * 1000
	}

	return rtcsock.SessionStats{
		SessionID:     s.id,
		Transport:     strings.TrimSpace(s.transport()),
		RTTMs:         rtt,
		BytesSent:     sent,
		BytesReceived: received,
		InputDropped:  s.inputDropped.Load(),
		KeysDropped:   s.keysDropped.Load(),
		Viewing:       s.viewing(),
		RTPDropped:    s.rtpDropped.Load(),
		Quality:       s.link.srv.hub.askName(s),
		MemberID:      s.memberID,
	}
}

// afterForget is for tests only: teardown runs it once the session is out of the table and its bytes are counted.
var afterForget atomic.Pointer[func()]

func setAfterForgetHook(f func()) {
	if f == nil {
		afterForget.Store(nil)

		return
	}
	afterForget.Store(&f)
}
