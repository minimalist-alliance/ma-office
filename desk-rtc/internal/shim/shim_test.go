package shim

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/devtoken"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/gw"
)

const testFP = "sha-256 7A:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C"

func startShim(t *testing.T, mod func(*Config)) (*Shim, *httptest.Server, string) {
	t.Helper()
	cfg := Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if mod != nil {
		mod(&cfg)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	return s, srv, "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1"
}

func dial(t *testing.T, url, deskAuth string) *gw.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := gw.Dial(ctx, url, deskAuth)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })

	return c
}

func read(t *testing.T, c *gw.Conn) *gw.Msg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}

	return m
}

func post(t *testing.T, url string, body any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%s: %d %v", url, resp.StatusCode, out)
	}

	return out
}

func token(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	tok, ok := post(t, srv.URL+"/dev/token", map[string]any{"clientDtlsFingerprint": testFP})["deskToken"].(string)
	if !ok {
		t.Fatal("no deskToken")
	}

	return tok
}

func readyDesk(t *testing.T, url string) *gw.Conn {
	t.Helper()
	d := dial(t, url, "dev")
	if err := d.Send(map[string]any{"type": "ready", "bootId": "b1", "runtimeVersion": "t", "deskApi": "1.0", "sessions": []string{}, "peerSessions": []string{}}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "ready.ack" || m.At == "" {
		t.Fatalf("got %+v", m)
	}

	return d
}

func TestSubprotocolRequired(t *testing.T) {
	_, srv, _ := startShim(t, nil)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Error.Code != "invalid_request" {
		t.Fatalf("body %+v %v", body, err)
	}
}

func TestOriginCheckAppliesToClientsOnly(t *testing.T) {
	_, _, url := startShim(t, func(c *Config) { c.AllowedOrigins = []string{"http://localhost:5173"} })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	bad := &websocket.DialOptions{Subprotocols: []string{gw.Subprotocol}, HTTPHeader: http.Header{"Origin": {"https://evil.example"}}}
	_, resp, err := websocket.Dial(ctx, url, bad)
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %v %v", resp, err)
	}
	good := &websocket.DialOptions{Subprotocols: []string{gw.Subprotocol}, HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}}
	c, _, err := websocket.Dial(ctx, url, good)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.CloseNow()
	_ = dial(t, url, "dev") // A desk carries X-MA-Desk-Auth and has no Origin.
}

func TestPingPong(t *testing.T) {
	_, _, url := startShim(t, nil)
	c := dial(t, url, "")
	if err := c.Send(map[string]any{"type": "ping", "id": "p1"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "pong" || m.ID != "p1" || m.At == "" {
		t.Fatalf("got %+v", m)
	}
}

func TestOversizedFrameIsRejected(t *testing.T) {
	_, _, url := startShim(t, nil)
	c := dial(t, url, "")
	big := strings.Repeat("x", gw.MaxFrame+1)
	if err := c.Send(map[string]any{"type": "ping", "pad": big}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "error" || m.Code != "message_too_large" {
		t.Fatalf("got %+v", m)
	}
	// The frame is dropped, and the connection stays usable.
	if err := c.Send(map[string]any{"type": "ping", "id": "after"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "pong" {
		t.Fatalf("got %+v", m)
	}
}

func TestMaxAgeClosesWith1001(t *testing.T) {
	_, _, url := startShim(t, func(c *Config) { c.MaxConnAge = 300 * time.Millisecond })
	c := dial(t, url, "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.Read(ctx)
	if got := gw.CloseStatus(err); got != int(websocket.StatusGoingAway) {
		t.Fatalf("close %d, err %v", got, err)
	}
}

func TestSilentConnectionIsDropped(t *testing.T) {
	_, _, url := startShim(t, func(c *Config) { c.IdleTimeout = 400 * time.Millisecond })
	c := dial(t, url, "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if _, err := c.Read(ctx); err == nil {
		t.Fatal("want the connection dropped")
	}
	if took := time.Since(start); took < 300*time.Millisecond {
		t.Fatalf("dropped after only %v", took)
	}
}

func TestPingsKeepAConnectionAlive(t *testing.T) {
	_, _, url := startShim(t, func(c *Config) { c.IdleTimeout = 500 * time.Millisecond })
	c := dial(t, url, "")
	for i := 0; i < 5; i++ {
		if err := c.Send(map[string]any{"type": "ping"}); err != nil {
			t.Fatal(err)
		}
		if m := read(t, c); m.Type != "pong" {
			t.Fatalf("got %+v", m)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestSessionFlowAndEmptyIceServers(t *testing.T) {
	_, srv, url := startShim(t, nil)
	d := readyDesk(t, url)
	c := dial(t, url, "")
	tok := token(t, srv)

	if err := c.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	open := read(t, d)
	if open.Type != "session.open" || !strings.HasPrefix(open.SessionID, "cs-") || len(open.SessionID) != 19 || open.DeskToken != tok || open.OpenedAt == "" {
		t.Fatalf("got %+v", open)
	}
	if open.SessionID != strings.ToLower(open.SessionID) {
		t.Fatalf("sessionId must be lower case: %s", open.SessionID)
	}
	if err := d.Send(map[string]any{"type": "session.accept", "sessionId": open.SessionID}); err != nil {
		t.Fatal(err)
	}
	opened := read(t, c)
	if opened.Type != "session.opened" || opened.ID != "o1" || opened.SessionID != open.SessionID {
		t.Fatalf("got %+v", opened)
	}
	if string(opened.IceServers) != "[]" {
		t.Fatalf("iceServers %s", opened.IceServers)
	}

	data := json.RawMessage(`{"type":"offer","sdp":"v=0"}`)
	if err := c.Send(map[string]any{"type": "signal", "sessionId": open.SessionID, "data": data}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "signal" || string(m.Data) != string(data) {
		t.Fatalf("got %+v", m)
	}
	if err := d.Send(map[string]any{"type": "signal", "sessionId": open.SessionID, "data": data}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "signal" || string(m.Data) != string(data) {
		t.Fatalf("got %+v", m)
	}

	big := json.RawMessage(`"` + strings.Repeat("x", gw.MaxSignalData+1) + `"`)
	if err := c.Send(map[string]any{"type": "signal", "id": "s", "sessionId": open.SessionID, "data": big}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "message_too_large" {
		t.Fatalf("got %+v", m)
	}

	if err := c.Send(map[string]any{"type": "session.close", "sessionId": open.SessionID, "reason": "closed_by_client"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "session.close" || m.Reason != "closed_by_client" {
		t.Fatalf("got %+v", m)
	}
	if m := read(t, c); m.Type != "session.closed" || m.Reason != "closed_by_client" {
		t.Fatalf("got %+v", m)
	}
}

func TestSessionOpenRefusals(t *testing.T) {
	s, srv, url := startShim(t, nil)
	c := dial(t, url, "")
	tok := token(t, srv)

	if err := c.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "desk_not_ready" || m.ID != "o1" {
		t.Fatalf("got %+v", m)
	}

	d := readyDesk(t, url)
	if err := c.Send(map[string]any{"type": "session.open", "id": "o2", "deskId": "d-other", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "wrong_desk" {
		t.Fatalf("got %+v", m)
	}
	if err := c.Send(map[string]any{"type": "session.open", "id": "o3", "deskId": "d-dev0000000000", "deskToken": "garbage"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "invalid_token" {
		t.Fatalf("got %+v", m)
	}

	if err := c.Send(map[string]any{"type": "session.open", "id": "o4", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	open := read(t, d)
	if err := d.Send(map[string]any{"type": "session.reject", "sessionId": open.SessionID, "code": "session_limit_reached", "message": "full"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "error" || m.Code != "session_limit_reached" || m.ID != "o4" {
		t.Fatalf("got %+v", m)
	}

	// The 5th open session on a desk stops at the gateway.
	for i := 0; i < 4; i++ {
		if err := c.Send(map[string]any{"type": "session.open", "id": "o", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
			t.Fatal(err)
		}
		open := read(t, d)
		if err := d.Send(map[string]any{"type": "session.accept", "sessionId": open.SessionID}); err != nil {
			t.Fatal(err)
		}
		if m := read(t, c); m.Type != "session.opened" {
			t.Fatalf("got %+v", m)
		}
	}
	if err := c.Send(map[string]any{"type": "session.open", "id": "o5", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "session_limit_reached" {
		t.Fatalf("got %+v", m)
	}
	_ = s
}

func TestUnknownTypesAndPeerMessages(t *testing.T) {
	_, _, url := startShim(t, nil)
	c := dial(t, url, "")
	if err := c.Send(map[string]any{"type": "nonsense", "id": "x"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "unknown_type" || m.ID != "x" {
		t.Fatalf("got %+v", m)
	}
	d := readyDesk(t, url)
	if err := d.Send(map[string]any{"type": "peer.open", "id": "p1", "guildToken": "x"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Code != "unknown_type" {
		t.Fatalf("got %+v", m)
	}
}

func TestDeskReconnectKeepsListedSessionsAndClosesUnknownOnes(t *testing.T) {
	_, srv, url := startShim(t, nil)
	d := readyDesk(t, url)
	c := dial(t, url, "")
	tok := token(t, srv)
	if err := c.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	open := read(t, d)
	if err := d.Send(map[string]any{"type": "session.accept", "sessionId": open.SessionID}); err != nil {
		t.Fatal(err)
	}
	read(t, c)

	// A new connection replaces the old: connection_replaced, then dropped.
	d2 := dial(t, url, "dev")
	if err := d2.Send(map[string]any{
		"type": "ready", "bootId": "b1", "sessions": []string{open.SessionID, "cs-stale"}, "peerSessions": []string{"ps-x"},
	}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "error" || m.Code != "connection_replaced" {
		t.Fatalf("got %+v", m)
	}
	if m := read(t, d2); m.Type != "ready.ack" {
		t.Fatalf("got %+v", m)
	}
	if m := read(t, d2); m.Type != "session.close" || m.SessionID != "cs-stale" {
		t.Fatalf("got %+v", m)
	}
	if m := read(t, d2); m.Type != "peer.closed" {
		t.Fatalf("got %+v", m)
	}
	// The listed session is intact.
	data := json.RawMessage(`{"type":"offer"}`)
	if err := c.Send(map[string]any{"type": "signal", "sessionId": open.SessionID, "data": data}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d2); m.Type != "signal" {
		t.Fatalf("got %+v", m)
	}

	// A desk that comes back without the session: the client hears desk_disconnected.
	d3 := dial(t, url, "dev")
	if err := d3.Send(map[string]any{"type": "ready", "bootId": "b2", "sessions": []string{}, "peerSessions": []string{}}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "session.closed" || m.Reason != "desk_disconnected" {
		t.Fatalf("got %+v", m)
	}
}

func TestClientResumeAndHold(t *testing.T) {
	_, srv, url := startShim(t, func(c *Config) { c.ResumeHold = 500 * time.Millisecond })
	d := readyDesk(t, url)
	c := dial(t, url, "")
	tok := token(t, srv)
	open := func(conn *gw.Conn) string {
		if err := conn.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
			t.Fatal(err)
		}
		m := read(t, d)
		if err := d.Send(map[string]any{"type": "session.accept", "sessionId": m.SessionID}); err != nil {
			t.Fatal(err)
		}
		read(t, conn)

		return m.SessionID
	}
	id := open(c)
	_ = c.Close()

	c2 := dial(t, url, "")
	if err := c2.Send(map[string]any{"type": "session.resume", "id": "r1", "sessionId": id, "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	m := read(t, c2)
	if m.Type != "session.opened" || m.SessionID != id || string(m.IceServers) != "[]" {
		t.Fatalf("got %+v", m)
	}

	// Past the hold, the desk hears client_gone and a resume is refused.
	_ = c2.Close()
	if m := read(t, d); m.Type != "session.close" || m.SessionID != id || m.Reason != "client_gone" {
		t.Fatalf("got %+v", m)
	}
	c3 := dial(t, url, "")
	if err := c3.Send(map[string]any{"type": "session.resume", "id": "r2", "sessionId": id, "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c3); m.Code != "session_not_found" {
		t.Fatalf("got %+v", m)
	}
}

func TestSessionRefresh(t *testing.T) {
	_, srv, url := startShim(t, nil)
	d := readyDesk(t, url)
	c := dial(t, url, "")
	tok := token(t, srv)
	if err := c.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	open := read(t, d)
	if err := d.Send(map[string]any{"type": "session.accept", "sessionId": open.SessionID}); err != nil {
		t.Fatal(err)
	}
	read(t, c)

	if err := c.Send(map[string]any{"type": "session.refresh", "id": "f1", "sessionId": open.SessionID, "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "session.refresh" || m.DeskToken != tok {
		t.Fatalf("got %+v", m)
	}
	if m := read(t, c); m.Type != "session.refreshed" || string(m.IceServers) != "[]" {
		t.Fatalf("got %+v", m)
	}

	other := post(t, srv.URL+"/dev/token", map[string]any{
		"clientDtlsFingerprint": strings.Replace(testFP, "7A", "00", 1),
	})["deskToken"].(string)
	if err := c.Send(map[string]any{"type": "session.refresh", "id": "f2", "sessionId": open.SessionID, "deskToken": other}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Code != "invalid_token" {
		t.Fatalf("got %+v", m)
	}
}

func TestConnectAndTokenClaims(t *testing.T) {
	s, srv, _ := startShim(t, nil)
	out := post(t, srv.URL+"/v1/desks/d-dev0000000000/connect", map[string]any{"scope": "owner", "start": false, "clientDtlsFingerprint": testFP})
	if out["phase"] != "connecting" || out["deskIdentity"] != nil {
		t.Fatalf("before hello: %v", out)
	}
	post(t, srv.URL+"/v1/agent/hello", map[string]any{"bootId": "b", "dtls": map[string]any{"fingerprintsSha256": []string{"ab"}}})
	out = post(t, srv.URL+"/v1/desks/d-dev0000000000/connect", map[string]any{"clientDtlsFingerprint": testFP})
	id, _ := out["deskIdentity"].(map[string]any)
	if id == nil || out["identityAsOf"] == nil {
		t.Fatalf("after hello: %v", out)
	}

	claims, err := devtoken.Verify(out["deskToken"].(string), s.signer.JWKS(), devtoken.Expect{
		Issuer: s.cfg.Issuer, DeskID: s.cfg.DeskID, Owner: s.cfg.OwnerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if claims.Exp-claims.Iat != 300 || claims.Cnf.X5tS256 != "ehw-mw1VL2HIROASmrc99giRzipbfxPUZqC8OeUH8ow" || claims.Scope != "owner" {
		t.Fatalf("claims %+v", claims)
	}

	resp, err := http.Post(srv.URL+"/v1/desks/d-other/connect", "application/json", strings.NewReader(`{"clientDtlsFingerprint":"`+testFP+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("other desk: %d", resp.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/dev/token", nil)
	opt, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer opt.Body.Close()
	if opt.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("no CORS on preflight")
	}
}

func TestBindRefusesNonLoopbackUnlessAsked(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:8787": true, "[::1]:8787": true, "localhost:8787": true,
		"0.0.0.0:8787": false, ":8787": false, "192.0.2.1:8787": false,
	} {
		c := Config{Addr: addr}
		if got := c.CheckBind() == nil; got != want {
			t.Errorf("%s: allowed=%v, want %v", addr, got, want)
		}
		c.AllowNonLoopback = true
		if c.CheckBind() != nil {
			t.Errorf("%s: refused despite the flag", addr)
		}
	}
}

func guildShim(t *testing.T) (*Shim, *httptest.Server, string) {
	t.Helper()

	return startShim(t, func(c *Config) { c.DeskKind = DeskKindGuild })
}

func guildToken(t *testing.T, srv *httptest.Server, body map[string]any) (string, map[string]any) {
	t.Helper()
	body["fingerprint"] = testFP
	out := post(t, srv.URL+"/v1/guilds/g-dev000000000/desk/token", body)
	tok, ok := out["deskToken"].(string)
	if !ok {
		t.Fatalf("no deskToken: %v", out)
	}

	return tok, out
}

func status(t *testing.T, url string, body any) int {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	return resp.StatusCode
}

// A Guild Desk's gateway (task 48): members' ma-guild+jwt tokens, and only those, up to maxGuildMembers x 3 sessions.
func TestGuildDeskTokensAndSessions(t *testing.T) {
	s, srv, url := guildShim(t)
	if s.cfg.MaxSessions != 600 {
		t.Fatalf("max sessions %d", s.cfg.MaxSessions)
	}
	d := readyDesk(t, url)

	tok, out := guildToken(t, srv, map[string]any{"memberId": "gm-ana", "role": "officer", "name": "Ana"})
	if out["deskId"] != "d-dev0000000000" || out["phase"] != "ready" || out["gateway"] == nil {
		t.Fatalf("reply %v", out)
	}
	c, err := devtoken.VerifyGuild(tok, s.signer.JWKS(), devtoken.ExpectGuild{Issuer: s.cfg.Issuer, DeskID: s.cfg.DeskID, GuildID: "g-dev000000000"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub != "gm-ana" || c.Scope != "guild_member" || c.MaGrole != "officer" || c.MaName != "Ana" || c.MaBadge == nil || *c.MaBadge != "officer" || c.MaTeen == nil || *c.MaTeen {
		t.Fatalf("claims %+v", c)
	}
	lead, _ := guildToken(t, srv, map[string]any{"memberId": "gm-lee", "role": "lead"})
	if c, _ := devtoken.VerifyGuild(lead, s.signer.JWKS(), devtoken.ExpectGuild{Issuer: s.cfg.Issuer, DeskID: s.cfg.DeskID}); c == nil || len(*c.MaGrants) != len(devtoken.GuildGrants) {
		t.Fatalf("a lead's grants: %+v", c)
	}

	// The member's session reaches the desk with the guild token, as an owner's does with theirs.
	cl := dial(t, url, "")
	if err := cl.Send(map[string]any{"type": "session.open", "id": "o1", "deskId": "d-dev0000000000", "deskToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Type != "session.open" || m.DeskToken != tok {
		t.Fatalf("desk got %+v", m)
	}

	// Not here: connect, a desk token, or another guild's route.
	if code := status(t, srv.URL+"/v1/desks/d-dev0000000000/connect", map[string]any{"scope": "owner", "clientDtlsFingerprint": testFP}); code != http.StatusNotFound {
		t.Fatalf("connect on a Guild Desk: %d", code)
	}
	if code := status(t, srv.URL+"/v1/guilds/g-other/desk/token", map[string]any{"fingerprint": testFP}); code != http.StatusNotFound {
		t.Fatalf("another guild: %d", code)
	}
	owner, err := s.signer.Sign(&devtoken.Claims{
		Iss: s.cfg.Issuer, Aud: s.cfg.DeskID, Sub: s.cfg.OwnerID, Scope: "owner", Iat: time.Now().Unix(), Nbf: time.Now().Unix(),
		Exp: time.Now().Unix() + 300, Cnf: devtoken.Cnf{X5tS256: "abc"}, MaOwner: s.cfg.OwnerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := cl.Send(map[string]any{"type": "session.open", "id": "o2", "deskId": "d-dev0000000000", "deskToken": owner}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, cl); m.Type != "error" || m.Code != "invalid_token" || m.ID != "o2" {
		t.Fatalf("an owner's token on a Guild Desk: %+v", m)
	}

	// The old desk-to-desk guild sessions stay refused.
	if err := d.Send(map[string]any{"type": "peer.open", "id": "p1", "guildToken": tok}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, d); m.Code != "unknown_type" || !strings.Contains(m.Message, "retired") {
		t.Fatalf("peer.open: %+v", m)
	}
}

// A member's own desk refuses a guild token, and serves no guild route.
func TestOwnDeskRefusesGuildTokens(t *testing.T) {
	s, srv, url := startShim(t, nil)
	if s.cfg.MaxSessions != 4 {
		t.Fatalf("max sessions %d", s.cfg.MaxSessions)
	}
	if code := status(t, srv.URL+"/v1/guilds/g-dev000000000/desk/token", map[string]any{"fingerprint": testFP}); code != http.StatusNotFound {
		t.Fatalf("guild route on a desk: %d", code)
	}
	readyDesk(t, url)
	gs, _, _ := guildShim(t)
	grants := []string{}
	teen := false
	tok, err := gs.signer.SignGuild(&devtoken.Claims{
		Iss: s.cfg.Issuer, Aud: s.cfg.DeskID, Sub: "gm-x", Scope: "guild_member", Iat: time.Now().Unix(), Nbf: time.Now().Unix(),
		Exp: time.Now().Unix() + 300, Cnf: devtoken.Cnf{X5tS256: "abc"}, MaGid: "g-dev000000000", MaGrole: "member", MaGrants: &grants, MaTeen: &teen,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Signed by another key here, so rule out the key too: the same shim's signer, guild typ.
	tok2, err := s.signer.SignGuild(&devtoken.Claims{
		Iss: s.cfg.Issuer, Aud: s.cfg.DeskID, Sub: "gm-x", Scope: "guild_member", Iat: time.Now().Unix(), Nbf: time.Now().Unix(),
		Exp: time.Now().Unix() + 300, Cnf: devtoken.Cnf{X5tS256: "abc"}, MaGid: "g-dev000000000", MaGrole: "member", MaGrants: &grants, MaTeen: &teen,
	})
	if err != nil {
		t.Fatal(err)
	}
	cl := dial(t, url, "")
	for i, tk := range []string{tok, tok2} {
		id := fmt.Sprintf("o%d", i)
		if err := cl.Send(map[string]any{"type": "session.open", "id": id, "deskId": "d-dev0000000000", "deskToken": tk}); err != nil {
			t.Fatal(err)
		}
		if m := read(t, cl); m.Type != "error" || m.Code != "invalid_token" || m.ID != id {
			t.Fatalf("a guild token on a desk: %+v", m)
		}
	}
}
