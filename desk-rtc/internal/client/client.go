// Package client is deskctl's Pion client: it opens a desk session the way the Desk app does (design
// 4.2.1, 4.2.2) and speaks the data-channel protocol enough for status checks and tests.
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
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/gw"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

const (
	bufferedHigh = 64 * 1024
	bufferedLow  = 32 * 1024
)

// Options configures Dial.
type Options struct {
	API     string // api. base URL
	Gateway string // WebSocket URL; empty takes connect's
	DeskID  string
	Bearer  string // Cognito access token for a real api.; the shim ignores it
	// Transport is any, udp or tcp.
	Transport string
	// ResumeGateway reconnects the gateway link and sends session.resume after it drops, keeping the
	// PeerConnection. Off for one-shot commands.
	ResumeGateway bool
	// GuildID opens a Guild Desk as a member: the token comes from POST /v1/guilds/{GuildID}/desk/token, an
	// ma-guild+jwt, instead of connect. MemberID picks the member, which only gateway-shim takes (task 48).
	GuildID  string
	MemberID string

	// Test hooks.
	BadCnf        bool                // ask for a token bound to some other certificate
	LieInOffer    bool                // with BadCnf: also claim that certificate in the sent offer
	NoMediaOffer  bool                // offer data only
	VP8Only       bool                // offer no H.264, like Playwright's Chromium
	AnswerRewrite func(string) string // change the answer before applying it, such as to reach a relay
	Log           func(format string, args ...any)
}

// RefusedError is the desk or gateway saying no.
type RefusedError struct {
	Code    string
	Message string
}

func (e *RefusedError) Error() string { return e.Code + ": " + e.Message }

// Conn is one open desk session.
type Conn struct {
	opts Options
	cert webrtc.Certificate
	fp   string

	link   atomic.Pointer[gw.Conn]
	ctx    context.Context //nolint:containedctx // lives as long as the Conn
	cancel context.CancelFunc

	pc        *webrtc.PeerConnection
	channels  [rtcsock.NumChannels]*webrtc.DataChannel
	allOpen   chan struct{}
	opened    atomic.Int32
	lowWater  [rtcsock.NumChannels]chan struct{}
	SessionID string

	identity []string

	mu       sync.Mutex
	nextID   uint32
	pending  map[uint32]chan frame.Frame
	partial  map[uint32][]byte
	sigCh    chan gw.Signal
	gwErrCh  chan *gw.Msg
	openedCh chan *gw.Msg
	closedCh chan string
	closeRsn atomic.Pointer[string]

	BulkReceived atomic.Int64
	Resumes      atomic.Int64
	bulkDone     chan struct{}
	bulkDoneOnce sync.Once
}

func (c *Conn) logf(format string, args ...any) {
	if c.opts.Log != nil {
		c.opts.Log(format, args...)
	}
}

func colonHex(raw []byte) string {
	h := strings.ToUpper(hex.EncodeToString(raw))
	parts := make([]string, 0, len(raw))
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}

	return strings.Join(parts, ":")
}

type connectReply struct {
	DeskID       string `json:"deskId"`
	Phase        string `json:"phase"`
	DeskToken    string `json:"deskToken"`
	Gateway      string `json:"gateway"`
	DeskIdentity *struct {
		FingerprintsSha256 []string `json:"fingerprintsSha256"`
	} `json:"deskIdentity"`
}

func (c *Conn) connect(ctx context.Context) (*connectReply, error) {
	body, err := json.Marshal(map[string]any{"scope": "owner", "start": false, "clientDtlsFingerprint": "sha-256 " + c.fp})
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(c.opts.API, "/") + "/v1/desks/" + c.opts.DeskID + "/connect"
	if c.opts.GuildID != "" {
		req := map[string]any{"fingerprint": "sha-256 " + c.fp}
		if c.opts.MemberID != "" {
			req["memberId"] = c.opts.MemberID
		}
		if body, err = json.Marshal(req); err != nil {
			return nil, err
		}
		url = strings.TrimRight(c.opts.API, "/") + "/v1/guilds/" + c.opts.GuildID + "/desk/token"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.opts.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.opts.Bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return nil, fmt.Errorf("connect: HTTP %d: %s", resp.StatusCode, data)
	}
	var reply connectReply
	if err := json.Unmarshal(data, &reply); err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	return &reply, nil
}

func tokenFingerprint(c *Conn) (string, error) {
	if !c.opts.BadCnf {
		return c.realFingerprint()
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}

	return colonHex(raw), nil
}

func (c *Conn) realFingerprint() (string, error) {
	fps, err := c.cert.GetFingerprints()
	if err != nil {
		return "", err
	}
	for _, fp := range fps {
		if fp.Algorithm == "sha-256" {
			return strings.ToUpper(fp.Value), nil
		}
	}

	return "", errors.New("certificate has no sha-256 fingerprint")
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
	if c.opts.VP8Only {
		if err := me.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			PayloadType:        111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
		if err := me.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
			PayloadType:        96,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	} else if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me))

	return api.NewPeerConnection(webrtc.Configuration{
		Certificates:  []webrtc.Certificate{c.cert},
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
		dc.OnMessage(func(m webrtc.DataChannelMessage) { c.onMessage(channel, m.Data) })
	}

	return nil
}

// Dial runs the whole of design 4.2.1: connect, session.open, offer, answer, DTLS, HELLO.
func Dial(ctx context.Context, opts Options) (*Conn, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	cert, err := webrtc.GenerateCertificate(key)
	if err != nil {
		return nil, err
	}
	runCtx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		opts: opts, cert: *cert, ctx: runCtx, cancel: cancel,
		allOpen:  make(chan struct{}),
		pending:  map[uint32]chan frame.Frame{},
		partial:  map[uint32][]byte{},
		sigCh:    make(chan gw.Signal, 4),
		gwErrCh:  make(chan *gw.Msg, 4),
		openedCh: make(chan *gw.Msg, 4),
		closedCh: make(chan string, 1),
		bulkDone: make(chan struct{}),
	}
	if err := c.dial(ctx); err != nil {
		c.Close()

		return nil, err
	}

	return c, nil
}

func (c *Conn) dial(ctx context.Context) error {
	var err error
	if c.fp, err = tokenFingerprint(c); err != nil {
		return err
	}
	reply, err := c.connect(ctx)
	if err != nil {
		return err
	}
	if reply.DeskIdentity != nil {
		c.identity = reply.DeskIdentity.FingerprintsSha256
	}
	gwURL := c.opts.Gateway
	if gwURL == "" {
		gwURL = reply.Gateway
	}
	c.opts.Gateway = gwURL

	link, err := gw.Dial(ctx, gwURL, "")
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
	if !c.opts.NoMediaOffer {
		// The client orders its sections audio, video, data (desk-runtime.md section 4.4).
		for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
			if _, err := c.pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
				return err
			}
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
	sent := offer.SDP
	if c.opts.BadCnf && c.opts.LieInOffer {
		sent = rewriteFingerprints(sent, c.fp)
	}
	if err := c.sendSignal(gw.Signal{Type: "offer", SDP: sent}); err != nil {
		return err
	}
	if err := c.acceptAnswer(ctx); err != nil {
		return err
	}

	select {
	case <-c.allOpen:
	case rsn := <-c.closedCh:
		return &RefusedError{Code: rsn, Message: "the session closed before channels opened"}
	case <-ctx.Done():
		return fmt.Errorf("waiting for channels (ICE %s, connection %s): %w", c.pc.ICEConnectionState(), c.pc.ConnectionState(), ctx.Err())
	}

	f, err := c.request(ctx, rtcsock.ChCtl, frame.Hello, map[string]any{"deskApi": "1.0", "appVersion": "deskctl"})
	if err != nil {
		return fmt.Errorf("HELLO: %w", err)
	}
	c.logf("HELLO reply: %s", f.Payload)

	return nil
}

func (c *Conn) acceptAnswer(ctx context.Context) error {
	sig, err := c.awaitAnswer(ctx)
	if err != nil {
		return err
	}
	if err := checkAnswerFingerprints(sig.SDP, c.identity); err != nil {
		return err
	}
	if c.opts.AnswerRewrite != nil {
		sig.SDP = c.opts.AnswerRewrite(sig.SDP)
	}

	return c.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sig.SDP})
}

func (c *Conn) awaitAnswer(ctx context.Context) (*gw.Signal, error) {
	select {
	case sig := <-c.sigCh:
		switch sig.Type {
		case "answer":
			return &sig, nil
		case "refusal":
			return nil, &RefusedError{Code: sig.Code, Message: sig.Message}
		default:
			return nil, fmt.Errorf("unexpected signal %q", sig.Type)
		}
	case rsn := <-c.closedCh:
		return nil, &RefusedError{Code: rsn, Message: "the session closed before the answer"}
	case m := <-c.gwErrCh:
		return nil, &RefusedError{Code: m.Code, Message: m.Message}
	case <-ctx.Done():
		return nil, fmt.Errorf("waiting for the answer: %w", ctx.Err())
	}
}

// LastAnswer returns the answer as the desk sent it, for checks. Empty before the answer.
func (c *Conn) LastAnswer() string {
	if d := c.pc.CurrentRemoteDescription(); d != nil {
		return d.SDP
	}

	return ""
}

func rewriteFingerprints(sdpText, fp string) string {
	lines := strings.Split(sdpText, "\r\n")
	for i, l := range lines {
		if strings.HasPrefix(l, "a=fingerprint:") {
			lines[i] = "a=fingerprint:sha-256 " + fp
		}
	}

	return strings.Join(lines, "\r\n")
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

// gatewayLoop routes gateway messages, and reconnects when ResumeGateway is on.
func (c *Conn) gatewayLoop(link *gw.Conn) {
	for {
		m, err := link.Read(c.ctx)
		if err != nil {
			if c.ctx.Err() != nil {
				return
			}
			c.logf("gateway link down (close %d): %v", gw.CloseStatus(err), err)
			c.link.Store(nil)
			if c.opts.ResumeGateway && c.SessionID != "" {
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
				c.sigCh <- sig
			}
		case "session.closed":
			reason := m.Reason
			c.closeRsn.Store(&reason)
			select {
			case c.closedCh <- reason:
			default:
			}
		case "error":
			c.gwErrCh <- m
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
		backoff = min(backoff*2, 30*time.Second)

		ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
		reply, err := c.connect(ctx)
		if err != nil {
			c.logf("resume: %v", err)
			cancel()

			continue
		}
		link, err := gw.Dial(ctx, c.opts.Gateway, "")
		if err != nil {
			c.logf("resume: %v", err)
			cancel()

			continue
		}
		c.link.Store(link)
		go c.gatewayLoop(link)
		_, err = c.openSession(ctx, "session.resume", reply.DeskToken, c.SessionID)
		cancel()
		if err != nil {
			c.logf("resume: %v", err)
			_ = link.Close()

			var refused *RefusedError
			if errors.As(err, &refused) {
				return
			}

			continue
		}
		c.Resumes.Add(1)
		c.logf("gateway link resumed")

		return
	}
}

// Closed returns the reason the gateway gave for closing this session, if it has.
func (c *Conn) Closed() (string, bool) {
	if r := c.closeRsn.Load(); r != nil {
		return *r, true
	}

	return "", false
}

// WaitClosed waits for the gateway's session.closed.
func (c *Conn) WaitClosed(ctx context.Context) (string, error) {
	if r, ok := c.Closed(); ok {
		return r, nil
	}
	select {
	case r := <-c.closedCh:
		return r, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (c *Conn) onMessage(channel uint8, data []byte) {
	f, err := frame.Decode(data)
	if err != nil {
		c.logf("bad frame on channel %d: %v", channel, err)

		return
	}
	switch {
	case channel == rtcsock.ChBulk && f.Kind == frame.Chunk:
		c.BulkReceived.Add(int64(len(f.Payload)))
		if f.Flags&frame.FlagEnd != 0 {
			c.bulkDoneOnce.Do(func() { close(c.bulkDone) })
		}
	case f.Kind == frame.Hello || f.Kind == frame.Pong || f.Kind == frame.Res || f.Kind == frame.Err:
		c.onReply(f)
	default:
		c.logf("frame kind %d on channel %d", f.Kind, channel)
	}
}

func (c *Conn) onReply(f frame.Frame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if f.Flags&frame.FlagMore != 0 {
		c.partial[f.ID] = append(c.partial[f.ID], f.Payload...)

		return
	}
	payload := append(c.partial[f.ID], f.Payload...)
	delete(c.partial, f.ID)
	f.Payload = payload
	if w := c.pending[f.ID]; w != nil {
		delete(c.pending, f.ID)
		w <- f
	}
}

func (c *Conn) request(ctx context.Context, channel uint8, kind frame.Kind, v any) (frame.Frame, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return frame.Frame{}, err
	}
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	w := make(chan frame.Frame, 1)
	c.pending[id] = w
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	if err := c.channels[channel].Send(frame.Encode(kind, 0, id, 0, body)); err != nil {
		return frame.Frame{}, err
	}
	select {
	case f := <-w:
		return f, nil
	case rsn := <-c.closedCh:
		return frame.Frame{}, &RefusedError{Code: rsn, Message: "the session closed"}
	case <-ctx.Done():
		return frame.Frame{}, ctx.Err()
	}
}

// Call makes one RPC and returns the RES payload.
func (c *Conn) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	f, err := c.request(ctx, rtcsock.ChRPC, frame.Req, map[string]any{"m": method, "p": params})
	if err != nil {
		return nil, err
	}
	if f.Kind == frame.Err {
		var e RefusedError
		var body struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(f.Payload, &body) == nil {
			e.Code, e.Message = body.Code, body.Message
		}

		return nil, &e
	}

	return f.Payload, nil
}

// Ping measures one ctl round trip.
func (c *Conn) Ping(ctx context.Context) (time.Duration, error) {
	start := time.Now()
	if _, err := c.request(ctx, rtcsock.ChCtl, frame.Ping, map[string]any{}); err != nil {
		return 0, err
	}

	return time.Since(start), nil
}

// SendBulk uploads n bytes of CHUNK frames, writing the way design 4.2.6 asks of clients: wait for the
// low-water mark once 64 KiB is buffered.
func (c *Conn) SendBulk(ctx context.Context, n int64) error {
	dc := c.channels[rtcsock.ChBulk]
	low := c.lowWater[rtcsock.ChBulk]
	payload := make([]byte, frame.MaxPayload)
	var seq uint32
	for sent := int64(0); sent < n; {
		for dc.BufferedAmount() >= bufferedHigh {
			select {
			case <-low:
			case <-time.After(100 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		size := min(int64(len(payload)), n-sent)
		if err := dc.Send(frame.Encode(frame.Chunk, frame.FlagBin, 2, seq, payload[:size])); err != nil {
			return err
		}
		sent += size
		seq++
	}

	return nil
}

// SendInput writes one raw frame to channel 6 or 7.
func (c *Conn) SendInput(channel uint8, b []byte) error { return c.channels[channel].Send(b) }

// WaitBulkDone waits for the END chunk of a download.
func (c *Conn) WaitBulkDone(ctx context.Context) error {
	select {
	case <-c.bulkDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Transport reports the selected path: udp or tcp.
func (c *Conn) Transport() string {
	pair, err := c.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil {
		return ""
	}

	return pair.Local.Protocol.String()
}

// RestartICE restarts ICE on the same PeerConnection, through signal. Safe to retry after a lost
// signal: leftovers from an earlier attempt are dropped first.
func (c *Conn) RestartICE(ctx context.Context) error {
	for drained := false; !drained; {
		select {
		case <-c.sigCh:
		case <-c.gwErrCh:
		default:
			drained = true
		}
	}
	offer, err := c.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		return err
	}
	if err := c.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	if err := c.sendSignal(gw.Signal{Type: "offer", SDP: offer.SDP, Restart: true}); err != nil {
		return err
	}

	return c.acceptAnswer(ctx)
}

// ConnectionState reports the PeerConnection's state.
func (c *Conn) ConnectionState() webrtc.PeerConnectionState { return c.pc.ConnectionState() }

// CloseSession asks the gateway to end the session, then closes.
func (c *Conn) CloseSession() {
	if link := c.link.Load(); link != nil && c.SessionID != "" {
		_ = link.Send(map[string]any{"type": "session.close", "sessionId": c.SessionID, "reason": "closed_by_client"})
	}
	c.Close()
}

// Close drops everything without telling the gateway.
func (c *Conn) Close() {
	c.cancel()
	if c.pc != nil {
		_ = c.pc.Close()
	}
	if link := c.link.Load(); link != nil {
		_ = link.Close()
	}
}
