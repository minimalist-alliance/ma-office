// Package fakedeskd is fake-deskd: a minimal stand-in for deskd, for tests only. It speaks rtc.sock and
// the gateway link, answers HELLO and desk.status.get (desk-runtime.md section 7), and has a few
// test.* RPC methods that drive transfers. It reads as a sketch of what the real deskd must do.
package fakedeskd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/devtoken"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/gw"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// Version is what desk.status.get reports as deskdVersion.
const Version = "fake-deskd"

// Config configures the daemon.
type Config struct {
	RTCSock  string
	API      string
	PublicIP string
	// DeskKind "guild" plays a Guild Desk's deskd (task 48), as the real one does from IMDS's DeskKind tag: configure
	// says deskKind guild, session.open takes only members' ma-guild+jwt tokens, and each session.create carries the
	// member's id. test.member.close drives member.close.
	DeskKind string
	Log      *slog.Logger
}

// Daemon is one fake deskd.
type Daemon struct {
	cfg     Config
	log     *slog.Logger
	rtc     *rtcsock.Client
	bootID  string
	started time.Time

	rtcVersion   string
	fingerprints []string
	notAfter     string
	deskID       string
	ownerID      string
	issuer       string
	gatewayURL   string
	guildID      string
	jwks         devtoken.JWKS

	mu         sync.Mutex
	sessions   map[string]*session
	byHandle   map[uint32]*session
	link       *gw.Conn
	statsWait  []chan *rtcsock.Message
	statsPart  *rtcsock.Message // a Guild Desk's stats parts so far
	configured chan *rtcsock.Message

	inputActivity atomic.Int64
}

type session struct {
	id          string
	handle      uint32
	claims      *devtoken.Claims
	created     bool
	ctx         context.Context //nolint:containedctx // lives exactly as long as the session
	cancel      context.CancelFunc
	bulkStalled atomic.Bool
	bulkHeld    atomic.Int64
	bulkIn      atomic.Int64
	bulkOut     atomic.Int64
	transport   atomic.Value
}

// New builds a daemon.
func New(cfg Config) *Daemon {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		boot = []byte("00000000-0000-0000-0000-000000000000")
	}

	return &Daemon{
		cfg:        cfg,
		log:        cfg.Log,
		bootID:     strings.TrimSpace(string(boot)),
		started:    time.Now(),
		sessions:   map[string]*session{},
		byHandle:   map[uint32]*session{},
		configured: make(chan *rtcsock.Message, 1),
	}
}

// Run follows boot order step 3: connect to rtc.sock, configure, hello, gateway link and ready.
func (d *Daemon) Run(ctx context.Context) error {
	rtc, err := rtcsock.DialRetry(ctx, d.cfg.RTCSock)
	if err != nil {
		return fmt.Errorf("rtc.sock: %w", err)
	}
	d.rtc = rtc
	defer rtc.Close()

	rtcDone := make(chan error, 1)
	go func() { rtcDone <- rtc.Run(d.onRTCJSON, d.onRTCData) }()

	configure := &rtcsock.Message{T: "configure", PublicIPv4: d.cfg.PublicIP, MaxSessions: 4}
	if d.guild() {
		// No maxSessions: desk-rtc's ceiling, maxGuildMembers x 3. Real deskd sends that number from the roster.
		configure = &rtcsock.Message{T: "configure", PublicIPv4: d.cfg.PublicIP, DeskKind: rtcsock.DeskKindGuild}
	}
	if err := rtc.Send(configure); err != nil {
		return err
	}
	select {
	case m := <-d.configured:
		if d.guild() && m.DeskKind != rtcsock.DeskKindGuild {
			return errors.New("rtc.sock: this desk-rtc has no guild mode")
		}
		d.rtcVersion = m.Version
		d.fingerprints = m.FingerprintsSha256
		d.notAfter = m.NotAfter
	case err := <-rtcDone:
		return fmt.Errorf("rtc.sock: %w", err)
	case <-time.After(10 * time.Second):
		return errors.New("rtc.sock: no configured reply")
	case <-ctx.Done():
		return ctx.Err()
	}

	if err := d.hello(ctx); err != nil {
		return err
	}
	go d.heartbeats(ctx)
	go d.gatewayLoop(ctx)

	select {
	case err := <-rtcDone:
		return fmt.Errorf("rtc.sock dropped: %w", err)
	case <-ctx.Done():
		return nil
	}
}

func (d *Daemon) guild() bool { return d.cfg.DeskKind == rtcsock.DeskKindGuild }

// verify is deskd's check of session.open's token: a member's ma-guild+jwt on a Guild Desk, the owner's desk token
// anywhere else. Neither kind of desk takes the other's.
func (d *Daemon) verify(token string) (*devtoken.Claims, error) {
	if d.guild() {
		return devtoken.VerifyGuild(token, d.jwks, devtoken.ExpectGuild{Issuer: d.issuer, DeskID: d.deskID, GuildID: d.guildID})
	}

	return devtoken.Verify(token, d.jwks, devtoken.Expect{Issuer: d.issuer, DeskID: d.deskID, Owner: d.ownerID})
}

func (d *Daemon) postJSON(ctx context.Context, path string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.cfg.API+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

func (d *Daemon) hello(ctx context.Context) error {
	var reply struct {
		DeskID string `json:"deskId"`
		Config struct {
			Owner struct {
				UserID string `json:"userId"`
			} `json:"owner"`
			Guild *struct {
				GuildID string `json:"guildId"`
			} `json:"guild"`
			Endpoints struct {
				Issuer  string `json:"issuer"`
				JWKS    string `json:"jwks"`
				Gateway string `json:"gateway"`
			} `json:"endpoints"`
		} `json:"config"`
	}
	body := map[string]any{
		"instanceId": "i-fake", "bootId": d.bootID, "reason": "boot", "amiId": "ami-fake",
		"runtimeVersion": Version, "imageVersion": "dev", "dataSchema": 1, "deskApi": "1.0",
		"dtls":         map[string]any{"fingerprintsSha256": d.fingerprints, "notAfter": d.notAfter},
		"dataVolume":   map[string]any{"mounted": true, "formattedThisBoot": false, "totalBytes": 0, "usedBytes": 0},
		"capabilities": []string{},
	}
	if err := d.postJSON(ctx, "/v1/agent/hello", body, &reply); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	d.deskID = reply.DeskID
	d.ownerID = reply.Config.Owner.UserID
	if reply.Config.Guild != nil {
		d.guildID = reply.Config.Guild.GuildID
	}
	d.issuer = reply.Config.Endpoints.Issuer
	d.gatewayURL = reply.Config.Endpoints.Gateway

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reply.Config.Endpoints.JWKS, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("jwks: %w", err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&d.jwks); err != nil {
		return fmt.Errorf("jwks: %w", err)
	}
	d.log.Info("hello done", "deskId", d.deskID, "fingerprints", d.fingerprints)

	return nil
}

func (d *Daemon) heartbeats(ctx context.Context) {
	var seq atomic.Int64
	send := func() {
		var out map[string]any
		err := d.postJSON(ctx, "/v1/agent/heartbeat", map[string]any{
			"bootId": d.bootID, "seq": seq.Add(1), "sentAt": time.Now().UTC().Format(time.RFC3339),
		}, &out)
		if err != nil && ctx.Err() == nil {
			d.log.Warn("heartbeat failed", "err", err)
		}
	}
	send()
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			send()
		}
	}
}

// gatewayLoop keeps one link up: it reconnects with backoff and lists live sessions in ready, so live
// PeerConnections carry on across the gateway's 2 h close.
func (d *Daemon) gatewayLoop(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		began := time.Now()
		replaced, err := d.gatewayOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		// A link that held up for a while was a healthy one, such as at the gateway's 2 h close.
		if time.Since(began) > time.Second {
			backoff = time.Second
		}
		if replaced {
			d.log.Warn("another connection replaced this desk's link; not reconnecting")

			return
		}
		d.log.Info("gateway link down, reconnecting", "err", err, "closeCode", gw.CloseStatus(err))
		jitter := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		select {
		case <-time.After(jitter):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (d *Daemon) gatewayOnce(ctx context.Context) (replaced bool, err error) {
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	link, err := gw.Dial(dialCtx, d.gatewayURL, "dev-desk-auth")
	if err != nil {
		return false, err
	}
	defer link.Close()

	d.mu.Lock()
	d.link = link
	live := make([]string, 0, len(d.sessions))
	for id, s := range d.sessions {
		if s.created {
			live = append(live, id)
		}
	}
	d.mu.Unlock()

	err = link.Send(map[string]any{
		"type": "ready", "bootId": d.bootID, "runtimeVersion": Version, "deskApi": "1.0",
		"sessions": live, "peerSessions": []string{},
	})
	if err != nil {
		return false, err
	}

	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		tick := time.NewTicker(4 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-tick.C:
				_ = link.Send(map[string]any{"type": "ping"})
			}
		}
	}()

	for {
		m, err := link.Read(ctx)
		if err != nil {
			return false, err
		}
		if m.Type == "error" && m.Code == "connection_replaced" {
			return true, errors.New("connection replaced")
		}
		d.onGateway(ctx, m)
	}
}

func (d *Daemon) sendGateway(v any) {
	d.mu.Lock()
	link := d.link
	d.mu.Unlock()
	if link == nil {
		return
	}
	if err := link.Send(v); err != nil {
		d.log.Warn("gateway send failed", "err", err)
	}
}

func (d *Daemon) onGateway(ctx context.Context, m *gw.Msg) {
	switch m.Type {
	case "session.open":
		claims, err := d.verify(m.DeskToken)
		if err != nil {
			code := "invalid_token"
			if errors.Is(err, devtoken.ErrWrongDesk) {
				code = "wrong_desk"
			}
			d.sendGateway(map[string]any{"type": "session.reject", "sessionId": m.SessionID, "code": code, "message": err.Error()})

			return
		}
		sctx, cancel := context.WithCancel(ctx)
		d.mu.Lock()
		d.sessions[m.SessionID] = &session{id: m.SessionID, claims: claims, ctx: sctx, cancel: cancel}
		d.mu.Unlock()
		d.sendGateway(map[string]any{"type": "session.accept", "sessionId": m.SessionID})
	case "signal":
		d.onSignal(m)
	case "session.close":
		d.mu.Lock()
		s := d.sessions[m.SessionID]
		d.mu.Unlock()
		if s == nil {
			return
		}
		if err := d.rtc.Send(&rtcsock.Message{T: "session.close", SessionID: m.SessionID, Code: 4000, Reason: m.Reason}); err != nil {
			d.log.Warn("rtc.sock send failed", "err", err)
		}
	default:
		d.log.Debug("gateway message", "type", m.Type)
	}
}

func (d *Daemon) onSignal(m *gw.Msg) {
	var sig gw.Signal
	if err := json.Unmarshal(m.Data, &sig); err != nil || sig.Type != "offer" {
		d.log.Warn("ignoring signal", "session", m.SessionID)

		return
	}
	d.mu.Lock()
	s := d.sessions[m.SessionID]
	var created bool
	if s != nil {
		created = s.created
		s.created = true
	}
	d.mu.Unlock()
	if s == nil {
		return
	}

	var msg *rtcsock.Message
	if created {
		msg = &rtcsock.Message{T: "session.ice_restart", SessionID: s.id, Offer: sig.SDP}
	} else {
		expected, err := devtoken.CnfToHex(s.claims.Cnf.X5tS256)
		if err != nil {
			d.closeRefused(s.id, "identity_mismatch", err.Error())

			return
		}
		msg = &rtcsock.Message{
			T: "session.create", SessionID: s.id, Offer: sig.SDP, ExpectedFingerprint: expected,
			Permissions: &rtcsock.Permissions{Video: true, Input: true},
		}
		if d.guild() {
			// The member's id from the verified token, and nothing to see or type into.
			msg.MemberID = s.claims.Sub
			msg.Permissions = &rtcsock.Permissions{}
		}
	}
	if err := d.rtc.Send(msg); err != nil {
		d.log.Warn("rtc.sock send failed", "err", err)
	}
}

// closeRefused tells the client why, and closes the session on the gateway.
func (d *Daemon) closeRefused(id, code, message string) {
	data, err := json.Marshal(gw.Signal{Type: "refusal", Code: code, Message: message})
	if err == nil {
		d.sendGateway(map[string]any{"type": "signal", "sessionId": id, "data": json.RawMessage(data)})
	}
	reason := "closed_by_desk"
	if code == rtcsock.CodeIdentityMismatch {
		reason = "identity_mismatch"
	}
	d.sendGateway(map[string]any{"type": "session.close", "sessionId": id, "reason": reason})
	d.mu.Lock()
	if s := d.sessions[id]; s != nil {
		s.cancel()
		delete(d.sessions, id)
	}
	d.mu.Unlock()
}

func (d *Daemon) onRTCJSON(m *rtcsock.Message) {
	switch m.T {
	case "configured":
		select {
		case d.configured <- m:
		default:
		}
	case "session.answer":
		d.mu.Lock()
		s := d.sessions[m.SessionID]
		if s != nil {
			s.handle = m.Handle
			d.byHandle[m.Handle] = s
		}
		d.mu.Unlock()
		data, err := json.Marshal(gw.Signal{Type: "answer", SDP: m.Answer})
		if err == nil {
			d.sendGateway(map[string]any{"type": "signal", "sessionId": m.SessionID, "data": json.RawMessage(data)})
		}
	case "session.error":
		d.log.Info("desk-rtc refused", "session", m.SessionID, "code", m.CodeString(), "message", m.Message)
		d.closeRefused(m.SessionID, m.CodeString(), m.Message)
	case "session.state":
		d.mu.Lock()
		s := d.sessions[m.SessionID]
		d.mu.Unlock()
		if s != nil {
			s.transport.Store(m.Transport)
		}
		d.log.Info("session state", "session", m.SessionID, "state", m.State, "transport", m.Transport)
	case "session.closed":
		d.mu.Lock()
		s := d.sessions[m.SessionID]
		if s != nil {
			s.cancel()
			delete(d.sessions, m.SessionID)
			delete(d.byHandle, s.handle)
		}
		d.mu.Unlock()
		d.log.Info("session closed", "session", m.SessionID, "reason", m.Reason)
		if s != nil {
			d.sendGateway(map[string]any{"type": "session.close", "sessionId": m.SessionID, "reason": gatewayReason(m.Reason)})
		}
	case "stats":
		// A Guild Desk's stats can come in parts (desk-rtc README, "Guild mode"): totals in part 0, rows until last.
		d.mu.Lock()
		if d.statsPart != nil {
			d.statsPart.Sessions = append(d.statsPart.Sessions, m.Sessions...)
			d.statsPart.Members = append(d.statsPart.Members, m.Members...)
			d.statsPart.Last = m.Last
			m = d.statsPart
		}
		if last := m.Last; last != nil && !*last {
			d.statsPart = m
			d.mu.Unlock()

			return
		}
		d.statsPart = nil
		m.Part, m.Last = nil, nil
		waiting := d.statsWait
		d.statsWait = nil
		d.mu.Unlock()
		for _, w := range waiting {
			w <- m
		}
	case "input.activity":
		d.inputActivity.Add(1)
	case "member.closed":
		d.log.Info("member closed", "member", m.MemberID, "sessions", m.SessionIDs)
	case "island.blocked":
		d.log.Info("island blocked", "epoch", m.Epoch)
	default:
		d.log.Debug("rtc.sock message", "t", m.T)
	}
}

// gatewayReason maps desk-rtc's reasons onto gateway.md section 2.3's list.
func gatewayReason(reason string) string {
	switch reason {
	case "closed_by_client", "closed_by_desk", "token_expired", "revoked", "desk_stopping",
		"desk_disconnected", "client_gone", "identity_mismatch", "replaced":
		return reason
	default:
		return "closed_by_desk"
	}
}

// onRTCData runs on the socket's read goroutine, so it must not wait: replies go on their own.
func (d *Daemon) onRTCData(handle uint32, channel uint8, data []byte) {
	d.mu.Lock()
	s := d.byHandle[handle]
	d.mu.Unlock()
	if s == nil {
		return
	}

	if channel == rtcsock.ChBulk {
		s.bulkIn.Add(int64(len(data)))
		if s.bulkStalled.Load() {
			s.bulkHeld.Add(int64(len(data)))

			return
		}
		_ = d.rtc.Grant(handle, channel, uint32(len(data)))

		return
	}
	_ = d.rtc.Grant(handle, channel, uint32(len(data)))

	f, err := frame.Decode(data)
	if err != nil {
		d.log.Warn("bad frame", "channel", channel, "err", err)

		return
	}
	payload := append([]byte(nil), f.Payload...)
	f.Payload = payload
	switch {
	case channel == rtcsock.ChCtl && f.Kind == frame.Hello:
		go d.reply(s, rtcsock.ChCtl, frame.Hello, f.ID, map[string]any{
			"deskApi": "1.0", "sessionId": s.id, "resumeToken": "fake-resume-token",
			"serverTime": time.Now().UTC().Format(time.RFC3339),
			"limits":     map[string]any{"requestsPerSecond": 200, "transfers": 16, "subscriptions": 64},
		})
	case channel == rtcsock.ChCtl && f.Kind == frame.Ping:
		go func() {
			_ = d.rtc.SendData(s.ctx, handle, rtcsock.ChCtl, frame.Encode(frame.Pong, 0, f.ID, 0, payload))
		}()
	case channel == rtcsock.ChRPC && f.Kind == frame.Req:
		go d.onRequest(s, &f)
	}
}

func (d *Daemon) reply(s *session, channel uint8, kind frame.Kind, id uint32, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := d.rtc.SendData(s.ctx, s.handle, channel, frame.Encode(kind, 0, id, 0, b)); err != nil && s.ctx.Err() == nil {
		d.log.Warn("reply failed", "err", err)
	}
}

func (d *Daemon) onRequest(s *session, f *frame.Frame) {
	var req struct {
		M string          `json:"m"`
		P json.RawMessage `json:"p"`
	}
	if err := json.Unmarshal(f.Payload, &req); err != nil {
		d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "bad_request", "message": err.Error()})

		return
	}
	switch req.M {
	case "desk.status.get":
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{
			"deskId": d.deskID, "deskdVersion": Version, "rtcVersion": d.rtcVersion, "bootId": d.bootID,
			"uptimeSec": int(time.Since(d.started).Seconds()), "javaVersion": "none (fake-deskd)", "instanceType": "dev",
		})
	case "browser.stream.set":
		// Section 8.4 without the unit control: tests start desk-stream themselves.
		var p struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(req.P, &p)
		view := p.State == "live"
		if err := d.rtc.Send(&rtcsock.Message{T: "session.video", SessionID: s.id, View: &view}); err != nil {
			d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "internal", "message": err.Error()})

			return
		}
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{"ok": true})
	case "test.stream.crop":
		// A video island (desk-runtime.md section 8.8), set straight from the test: real deskd works the rectangle out
		// over CDP. {"crop": null} is the whole screen.
		var p struct {
			Crop *rtcsock.Crop `json:"crop"`
		}
		_ = json.Unmarshal(req.P, &p)
		if err := d.rtc.Send(&rtcsock.Message{T: "stream.crop", Crop: p.Crop}); err != nil {
			d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "internal", "message": err.Error()})

			return
		}
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{"ok": true})
	case "test.bulk.download":
		var p struct {
			Bytes int64 `json:"bytes"`
		}
		_ = json.Unmarshal(req.P, &p)
		go d.bulkDownload(s, p.Bytes)
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{"ok": true})
	case "test.bulk.stall":
		var p struct {
			On bool `json:"on"`
		}
		_ = json.Unmarshal(req.P, &p)
		s.bulkStalled.Store(p.On)
		if !p.On {
			if held := s.bulkHeld.Swap(0); held > 0 {
				_ = d.rtc.Grant(s.handle, rtcsock.ChBulk, uint32(held))
			}
		}
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{"ok": true})
	case "test.counters":
		t, _ := s.transport.Load().(string)
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{
			"bulkIn": s.bulkIn.Load(), "bulkOut": s.bulkOut.Load(), "bulkHeld": s.bulkHeld.Load(),
			"transport": t, "inputActivity": d.inputActivity.Load(),
		})
	case "test.member.close":
		// A roster change, straight from the test: real deskd sends it when the roster drops a member or changes their
		// role or grants. The reply goes first, since the caller may be that member.
		var p struct {
			MemberID string `json:"memberId"`
			Reason   string `json:"reason"`
		}
		_ = json.Unmarshal(req.P, &p)
		d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, map[string]any{"ok": true})
		if err := d.rtc.Send(&rtcsock.Message{T: "member.close", MemberID: p.MemberID, Reason: p.Reason}); err != nil {
			d.log.Warn("rtc.sock send failed", "err", err)
		}
	case "test.rtc.stats":
		w := make(chan *rtcsock.Message, 1)
		d.mu.Lock()
		d.statsWait = append(d.statsWait, w)
		d.mu.Unlock()
		if err := d.rtc.Send(&rtcsock.Message{T: "stats.get"}); err != nil {
			d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "internal", "message": err.Error()})

			return
		}
		select {
		case m := <-w:
			d.reply(s, rtcsock.ChRPC, frame.Res, f.ID, m)
		case <-time.After(5 * time.Second):
			d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "deadline_exceeded", "message": "no stats"})
		}
	default:
		d.reply(s, rtcsock.ChRPC, frame.Err, f.ID, map[string]any{"code": "not_found", "message": "no method " + req.M})
	}
}

// bulkDownload sends CHUNK frames on bulk, as fast as rtc.sock credit allows, until done or the session
// closes.
func (d *Daemon) bulkDownload(s *session, total int64) {
	payload := make([]byte, frame.MaxPayload)
	var seq uint32
	for sent := int64(0); sent < total; {
		n := min(int64(len(payload)), total-sent)
		flags := frame.FlagBin
		if sent+n >= total {
			flags |= frame.FlagEnd
		}
		b := frame.Encode(frame.Chunk, flags, 1, seq, payload[:n])
		if err := d.rtc.SendData(s.ctx, s.handle, rtcsock.ChBulk, b); err != nil {
			return
		}
		sent += n
		seq++
		s.bulkOut.Store(sent)
	}
}
