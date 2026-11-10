// Copied from desk-rtc/internal/client/client.go at desk-rtc commit 42e6a09 (Go's internal rule stops an
// import across modules). Trimmed to opening a session: connect is a function the caller passes (the
// move routes, not /v1/desks/{id}/connect), the certificate is the caller's so every token of a move
// binds to one cnf, and the frames go to a session.Transport receiver instead of being parsed here.
// HELLO, RPC and bulk moved to internal/session.

// Package client opens a desk session the way the Desk app does (design 4.2.1, 4.2.2): connect, the
// gateway's session.open, an offer, the answer checked against the desk's identity, DTLS, the
// negotiated data channels. It is the Pion half of session.Transport.
package client

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/gw"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/rtcsock"
)

const (
	bufferedHigh = 1 << 20
	bufferedLow  = 256 * 1024
)

// ConnectReply is what connect returns (auth.md section 4.1), as far as this reads it.
type ConnectReply struct {
	DeskID            string `json:"deskId"`
	State             string `json:"state"`
	Phase             string `json:"phase"`
	DeskToken         string `json:"deskToken"`
	RefreshAfter      string `json:"refreshAfter"`
	Gateway           string `json:"gateway"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
	DeskIdentity      *struct {
		FingerprintsSha256 []string `json:"fingerprintsSha256"`
	} `json:"deskIdentity"`
}

// ConnectFunc asks the platform for a desk token bound to fingerprint ("sha-256 AB:CD:…").
type ConnectFunc func(ctx context.Context, fingerprint string) (*ConnectReply, error)

// Options configures Dial.
type Options struct {
	Connect ConnectFunc
	DeskID  string
	// Gateway overrides connect's gateway URL (tests).
	Gateway string
	// Transport is any, udp or tcp.
	Transport string
	// Cert is the DTLS certificate. Keep one for the whole move: a refreshed token must keep its cnf.
	Cert *webrtc.Certificate
	Log  func(format string, args ...any)
}

// RefusedError is the desk or gateway saying no.
type RefusedError struct {
	Code    string
	Message string
}

func (e *RefusedError) Error() string { return e.Code + ": " + e.Message }

// NewCertificate makes an ECDSA P-256 DTLS certificate, as the Desk app does.
func NewCertificate() (*webrtc.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	return webrtc.GenerateCertificate(key)
}

// Fingerprint is the certificate's sha-256 fingerprint as connect takes it: "sha-256 AB:CD:…".
func Fingerprint(cert *webrtc.Certificate) (string, error) {
	fps, err := cert.GetFingerprints()
	if err != nil {
		return "", err
	}
	for _, fp := range fps {
		if fp.Algorithm == "sha-256" {
			return "sha-256 " + strings.ToUpper(fp.Value), nil
		}
	}

	return "", errors.New("certificate has no sha-256 fingerprint")
}

// Conn is one open desk session's peer connection and gateway link.
type Conn struct {
	opts Options
	fp   string

	link   atomic.Pointer[gw.Conn]
	ctx    context.Context //nolint:containedctx // lives as long as the Conn
	cancel context.CancelFunc

	pc        *webrtc.PeerConnection
	channels  [rtcsock.NumChannels]*webrtc.DataChannel
	lowWater  [rtcsock.NumChannels]chan struct{}
	allOpen   chan struct{}
	opened    atomic.Int32
	SessionID string
	identity  []string

	receiver atomic.Pointer[func(uint8, []byte)]
	sendMu   [rtcsock.NumChannels]sync.Mutex

	sigCh    chan gw.Signal
	gwErrCh  chan *gw.Msg
	openedCh chan *gw.Msg
	closedCh chan string

	done     chan struct{}
	doneOnce sync.Once
}

func (c *Conn) logf(format string, args ...any) {
	if c.opts.Log != nil {
		c.opts.Log(format, args...)
	}
}

// Dial runs design 4.2.1 up to open channels. HELLO is the session package's.
func Dial(ctx context.Context, opts Options) (*Conn, error) {
	if opts.Cert == nil || opts.Connect == nil {
		return nil, errors.New("client: Cert and Connect are required")
	}
	runCtx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		opts: opts, ctx: runCtx, cancel: cancel,
		allOpen:  make(chan struct{}),
		sigCh:    make(chan gw.Signal, 4),
		gwErrCh:  make(chan *gw.Msg, 4),
		openedCh: make(chan *gw.Msg, 4),
		closedCh: make(chan string, 1),
		done:     make(chan struct{}),
	}
	if err := c.dial(ctx); err != nil {
		_ = c.Close()

		return nil, err
	}

	return c, nil
}

func (c *Conn) dial(ctx context.Context) error {
	var err error
	if c.fp, err = Fingerprint(c.opts.Cert); err != nil {
		return err
	}
	reply, err := c.opts.Connect(ctx, c.fp)
	if err != nil {
		return err
	}
	if reply.DeskIdentity != nil {
		c.identity = reply.DeskIdentity.FingerprintsSha256
	}
	if c.opts.DeskID == "" {
		c.opts.DeskID = reply.DeskID
	}
	gwURL := c.opts.Gateway
	if gwURL == "" {
		gwURL = reply.Gateway
	}
	c.opts.Gateway = gwURL

	link, err := gw.Dial(ctx, gwURL)
	if err != nil {
		return fmt.Errorf("gateway: %w", err)
	}
	c.link.Store(link)
	go c.gatewayLoop(link)

	opened, err := c.openSession(ctx, "session.open", reply.DeskToken, "")
	if err != nil {
		return err
	}
	c.SessionID = opened.SessionID
	c.logf("session %s opened", c.SessionID)

	if c.pc, err = c.newPeerConnection(); err != nil {
		return err
	}
	c.pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		c.logf("peer connection %s", s)
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			c.markDone()
		}
	})
	// The client orders its sections audio, video, data (desk-runtime.md section 4.4).
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if _, err := c.pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			return err
		}
	}
	if err := c.createChannels(); err != nil {
		return err
	}

	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	// The offer goes out before gathering and no candidate is ever trickled: the desk learns this
	// client from its connectivity checks.
	if err := c.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	if err := c.sendSignal(gw.Signal{Type: "offer", SDP: offer.SDP}); err != nil {
		return err
	}
	if err := c.acceptAnswer(ctx); err != nil {
		return err
	}

	select {
	case <-c.allOpen:
		return nil
	case rsn := <-c.closedCh:
		return &RefusedError{Code: rsn, Message: "the session closed before channels opened"}
	case <-ctx.Done():
		return fmt.Errorf("waiting for channels (ICE %s, connection %s): %w", c.pc.ICEConnectionState(), c.pc.ConnectionState(), ctx.Err())
	}
}

func (c *Conn) newPeerConnection() (*webrtc.PeerConnection, error) {
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	switch c.opts.Transport {
	case "tcp":
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	case "udp":
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	case "", "any":
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	default:
		return nil, fmt.Errorf("unknown transport %q", c.opts.Transport)
	}
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me))

	return api.NewPeerConnection(webrtc.Configuration{
		Certificates:  []webrtc.Certificate{*c.opts.Cert},
		BundlePolicy:  webrtc.BundlePolicyMaxBundle,
		RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
}

func (c *Conn) createChannels() error {
	for i := range rtcsock.Channels {
		def := &rtcsock.Channels[i]
		negotiated := true
		ordered := def.Ordered
		id := uint16(def.ID)
		dc, err := c.pc.CreateDataChannel(def.Label, &webrtc.DataChannelInit{
			Ordered: &ordered, MaxRetransmits: def.MaxRetransmits, Negotiated: &negotiated, ID: &id,
		})
		if err != nil {
			return err
		}
		c.channels[def.ID] = dc
		channel := def.ID
		low := make(chan struct{}, 1)
		c.lowWater[channel] = low
		dc.SetBufferedAmountLowThreshold(bufferedLow)
		dc.OnBufferedAmountLow(func() {
			select {
			case low <- struct{}{}:
			default:
			}
		})
		// Each channel opens on its own: ctl being open doesn't mean rpc is.
		dc.OnOpen(func() {
			if c.opened.Add(1) == rtcsock.NumChannels {
				close(c.allOpen)
			}
		})
		dc.OnClose(func() {
			if channel <= rtcsock.ChBulk {
				c.markDone()
			}
		})
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if channel > rtcsock.ChBulk {
				return
			}
			if r := c.receiver.Load(); r != nil {
				(*r)(channel, append([]byte(nil), m.Data...))
			}
		})
	}

	return nil
}

func (c *Conn) acceptAnswer(ctx context.Context) error {
	var sig gw.Signal
	select {
	case sig = <-c.sigCh:
	case rsn := <-c.closedCh:
		return &RefusedError{Code: rsn, Message: "the session closed before the answer"}
	case m := <-c.gwErrCh:
		return &RefusedError{Code: m.Code, Message: m.Message}
	case <-ctx.Done():
		return fmt.Errorf("waiting for the answer: %w", ctx.Err())
	}
	switch sig.Type {
	case "answer":
	case "refusal":
		return &RefusedError{Code: sig.Code, Message: sig.Message}
	default:
		return fmt.Errorf("unexpected signal %q", sig.Type)
	}
	if err := checkAnswerFingerprints(sig.SDP, c.identity); err != nil {
		return err
	}

	return c.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sig.SDP})
}

// checkAnswerFingerprints is design 4.2.2 step 5: every a=fingerprint in the answer must be one of the
// desk's registered ones, compared as bytes.
func checkAnswerFingerprints(sdpText string, identity []string) error {
	var seen int
	for _, l := range strings.Split(sdpText, "\r\n") {
		v, ok := strings.CutPrefix(l, "a=fingerprint:")
		if !ok {
			continue
		}
		seen++
		alg, value, _ := strings.Cut(v, " ")
		got, err := hex.DecodeString(strings.ReplaceAll(value, ":", ""))
		if err != nil || !strings.EqualFold(alg, "sha-256") {
			return &RefusedError{Code: "identity_mismatch", Message: "answer's a=fingerprint isn't SHA-256 hex"}
		}
		var match bool
		for _, want := range identity {
			if raw, err := hex.DecodeString(want); err == nil && bytes.Equal(raw, got) {
				match = true
			}
		}
		if !match {
			return &RefusedError{Code: "identity_mismatch", Message: "answer's a=fingerprint isn't in deskIdentity"}
		}
	}
	if seen == 0 {
		return &RefusedError{Code: "identity_mismatch", Message: "answer has no a=fingerprint"}
	}

	return nil
}

func (c *Conn) sendSignal(sig gw.Signal) error {
	data, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	link := c.link.Load()
	if link == nil {
		return errors.New("gateway link is down")
	}

	return link.Send(map[string]any{"type": "signal", "sessionId": c.SessionID, "data": json.RawMessage(data)})
}

func (c *Conn) openSession(ctx context.Context, typ, token, sessionID string) (*gw.Msg, error) {
	link := c.link.Load()
	if link == nil {
		return nil, errors.New("gateway link is down")
	}
	msg := map[string]any{"type": typ, "id": "o1", "deskId": c.opts.DeskID, "deskToken": token}
	if sessionID != "" {
		msg["sessionId"] = sessionID
	}
	if err := link.Send(msg); err != nil {
		return nil, err
	}
	select {
	case m := <-c.openedCh:
		return m, nil
	case m := <-c.gwErrCh:
		return nil, &RefusedError{Code: m.Code, Message: m.Message}
	case <-ctx.Done():
		return nil, fmt.Errorf("waiting for %s: %w", typ, ctx.Err())
	}
}

// gatewayLoop routes gateway messages, and reconnects the link once a session is open: the gateway
// holds a session only 60 s after its client's link drops.
func (c *Conn) gatewayLoop(link *gw.Conn) {
	for {
		m, err := link.Read(c.ctx)
		if err != nil {
			if c.ctx.Err() != nil {
				return
			}
			c.logf("gateway link down (close %d): %v", gw.CloseStatus(err), err)
			c.link.Store(nil)
			if c.SessionID != "" {
				go c.resumeGateway()
			}

			return
		}
		switch m.Type {
		case "session.opened":
			c.openedCh <- m
		case "signal":
			var sig gw.Signal
			if json.Unmarshal(m.Data, &sig) == nil {
				select {
				case c.sigCh <- sig:
				default:
				}
			}
		case "session.closed":
			select {
			case c.closedCh <- m.Reason:
			default:
			}
			c.markDone()
		case "error":
			select {
			case c.gwErrCh <- m:
			default:
			}
		}
	}
}

func (c *Conn) resumeGateway() {
	backoff := time.Second
	for c.ctx.Err() == nil {
		select {
		case <-time.After(backoff):
		case <-c.ctx.Done():
			return
		}
		backoff = min(backoff*2, 15*time.Second)

		ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
		reply, err := c.opts.Connect(ctx, c.fp)
		if err != nil {
			c.logf("gateway resume: %v", err)
			cancel()

			continue
		}
		link, err := gw.Dial(ctx, c.opts.Gateway)
		if err != nil {
			c.logf("gateway resume: %v", err)
			cancel()

			continue
		}
		c.link.Store(link)
		go c.gatewayLoop(link)
		_, err = c.openSession(ctx, "session.resume", reply.DeskToken, c.SessionID)
		cancel()
		if err != nil {
			c.logf("gateway resume: %v", err)
			_ = link.Close()
			var refused *RefusedError
			if errors.As(err, &refused) {
				c.markDone() // the gateway no longer holds the session

				return
			}

			continue
		}
		c.logf("gateway link resumed")

		return
	}
}

func (c *Conn) markDone() { c.doneOnce.Do(func() { close(c.done) }) }

// Send writes one frame on a bridged channel, waiting while too much is buffered (design 4.2.6).
func (c *Conn) Send(channel uint8, b []byte) error {
	if channel > rtcsock.ChBulk {
		return fmt.Errorf("client: channel %d isn't bridged", channel)
	}
	dc := c.channels[channel]
	if dc == nil {
		return errors.New("client: not open")
	}
	c.sendMu[channel].Lock()
	defer c.sendMu[channel].Unlock()
	for dc.BufferedAmount() >= bufferedHigh {
		select {
		case <-c.lowWater[channel]:
		case <-time.After(100 * time.Millisecond):
		case <-c.done:
			return errors.New("client: closed")
		}
	}

	return dc.Send(b)
}

// SetReceiver installs the handler for frames from the desk on channels 0 to 5.
func (c *Conn) SetReceiver(f func(channel uint8, b []byte)) { c.receiver.Store(&f) }

// Done is closed when the peer connection, a bridged channel or the gateway's session has gone.
func (c *Conn) Done() <-chan struct{} { return c.done }

// RefreshToken sends the gateway's session.refresh, when the link is up.
func (c *Conn) RefreshToken(token string) error {
	link := c.link.Load()
	if link == nil {
		return errors.New("gateway link is down")
	}

	return link.Send(map[string]any{"type": "session.refresh", "id": "r1", "sessionId": c.SessionID, "deskToken": token})
}

// Close tells the gateway the session is over (closed_by_client), then drops everything.
func (c *Conn) Close() error {
	if link := c.link.Load(); link != nil && c.SessionID != "" {
		_ = link.Send(map[string]any{"type": "session.close", "sessionId": c.SessionID, "reason": "closed_by_client"})
	}
	c.cancel()
	c.markDone()
	if c.pc != nil {
		_ = c.pc.Close()
	}
	if link := c.link.Load(); link != nil {
		_ = link.Close()
	}

	return nil
}
