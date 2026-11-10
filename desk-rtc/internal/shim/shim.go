// Package shim is gateway-shim: a DEV-ONLY stand-in for gw. and the few api. routes a desk and the
// Desk app need. It follows gateway.md contract 0.3.3 and checks no SigV4 or Cognito credentials.
// Never run it in production.
package shim

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/devtoken"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/gw"
)

// Banner is logged at startup and repeated in the README.
const Banner = "*** gateway-shim is a DEV-ONLY stand-in: no SigV4, no Cognito, anyone who can reach it gets tokens. NOT FOR PRODUCTION. ***"

const readyDeadline = 10 * time.Second

// Config configures the shim. Zero durations take the contract's values.
type Config struct {
	Addr             string
	AllowNonLoopback bool
	DeskID           string
	OwnerID          string
	OwnerName        string
	Issuer           string
	AllowedOrigins   []string
	MaxConnAge       time.Duration
	IdleTimeout      time.Duration
	ResumeHold       time.Duration
	OpenTimeout      time.Duration
	MaxSessions      int
	// DeskKind "guild" makes this shim a Guild Desk's gateway (task 48): members get ma-guild+jwt tokens from
	// POST /v1/guilds/{GuildID}/desk/token, session.open takes only those, and MaxSessions defaults to
	// MaxGuildMembers x 3. Anything else is a member's own desk, as before.
	DeskKind        string
	GuildID         string
	MaxGuildMembers int
	Log             *slog.Logger
}

// DeskKindGuild is the DeskKind of a Guild Desk.
const DeskKindGuild = "guild"

func (c *Config) guild() bool { return c.DeskKind == DeskKindGuild }

func (c *Config) defaults() {
	set := func(v *string, d string) {
		if *v == "" {
			*v = d
		}
	}
	setD := func(v *time.Duration, d time.Duration) {
		if *v <= 0 {
			*v = d
		}
	}
	set(&c.DeskID, "d-dev0000000000")
	set(&c.OwnerID, "00000000-0000-4000-8000-000000000001")
	set(&c.OwnerName, "Dev User")
	set(&c.Issuer, "https://api.dev.invalid")
	setD(&c.MaxConnAge, 2*time.Hour)
	setD(&c.IdleTimeout, 10*time.Minute)
	setD(&c.ResumeHold, 60*time.Second)
	setD(&c.OpenTimeout, 15*time.Second)
	set(&c.GuildID, "g-dev000000000")
	if c.MaxGuildMembers <= 0 {
		c.MaxGuildMembers = 200
	}
	if c.MaxSessions <= 0 {
		c.MaxSessions = 4
		if c.guild() {
			c.MaxSessions = c.MaxGuildMembers * 3 // outside the 4 a desk takes (guild-eng.md 3.2)
		}
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
}

// Shim is the server.
type Shim struct {
	cfg    Config
	signer *devtoken.Signer
	log    *slog.Logger

	mu           sync.Mutex
	desk         *wsConn
	bootID       string
	fingerprints []string
	identityAsOf string
	sessions     map[string]*gwSession
	watchers     map[*wsConn]struct{}
	heartbeats   int
}

type gwSession struct {
	id       string
	client   *wsConn
	openID   string
	accepted bool
	sub      string
	scope    string
	cnf      string
	exp      int64
	timer    *time.Timer // the open deadline or the resume hold
}

// New builds a Shim.
func New(cfg Config) (*Shim, error) {
	cfg.defaults()
	signer, err := devtoken.NewSigner()
	if err != nil {
		return nil, err
	}

	return &Shim{
		cfg:      cfg,
		signer:   signer,
		log:      cfg.Log,
		sessions: map[string]*gwSession{},
		watchers: map[*wsConn]struct{}{},
	}, nil
}

// CheckBind refuses a non-loopback address unless the operator asked for it.
func (c *Config) CheckBind() error {
	host, _, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return err
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	if c.AllowNonLoopback {
		return nil
	}

	return fmt.Errorf("refusing to bind %s: this is a dev-only shim; pass --allow-non-loopback if you really mean it", c.Addr)
}

// Handler serves everything.
func (s *Shim) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1", s.handleUpgrade)
	mux.HandleFunc("GET /.well-known/jwks.json", s.handleJWKS)
	mux.HandleFunc("GET /v1/client-config", s.handleClientConfig)
	mux.HandleFunc("POST /dev/token", s.handleDevToken)
	mux.HandleFunc("GET /dev/state", s.handleDevState)
	mux.HandleFunc("POST /v1/desks/{deskId}/connect", s.handleConnect)
	mux.HandleFunc("POST /v1/guilds/{guildId}/desk/token", s.handleGuildToken)
	mux.HandleFunc("POST /v1/agent/hello", s.handleHello)
	mux.HandleFunc("POST /v1/agent/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("GET /v1/agent/config", s.handleConfig)

	return cors(mux)
}

// Run serves until ctx ends.
func (s *Shim) Run(ctx context.Context) error {
	if err := s.cfg.CheckBind(); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return err
	}
	s.log.Warn(Banner)
	s.log.Info("gateway-shim listening", "addr", ln.Addr().String(), "deskId", s.cfg.DeskID, "issuer", s.cfg.Issuer, "deskKind", firstNonEmpty(s.cfg.DeskKind, "personal"))
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go s.sweep(ctx)
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		_ = srv.Close()
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}

	return nil
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "authorization, content-type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)

			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{
		"code": code, "message": msg, "requestId": "r-dev", "retryable": false, "details": map[string]any{},
	}})
}

func baseURLs(r *http.Request) (httpURL, wsURL string) {
	return "http://" + r.Host, "ws://" + r.Host + "/v1"
}

func (s *Shim) handleJWKS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, http.StatusOK, s.signer.JWKS())
}

func (s *Shim) handleClientConfig(w http.ResponseWriter, r *http.Request) {
	_, wsURL := baseURLs(r)
	writeJSON(w, http.StatusOK, map[string]any{"gateway": wsURL})
}

// tokenRequest is the body of POST /dev/token and the fields connect shares with it. On a Guild Desk, sub is the
// member's gm- id, and role, name, grants and teen are the member's (shim-only: Platform takes them from the roster).
type tokenRequest struct {
	ClientDtlsFingerprint string    `json:"clientDtlsFingerprint"`
	DeskID                string    `json:"deskId"`
	Sub                   string    `json:"sub"`
	Scope                 string    `json:"scope"`
	Sid                   string    `json:"sid"`
	TTLSeconds            int64     `json:"ttlSeconds"`
	Role                  string    `json:"role"`
	Name                  string    `json:"name"`
	Grants                *[]string `json:"grants"`
	Teen                  bool      `json:"teen"`
}

func randomID(prefix string) string {
	var buf [10]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}

	return prefix + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf[:]))
}

func (s *Shim) mint(req *tokenRequest) (string, *devtoken.Claims, error) {
	raw, err := devtoken.ParseClientFingerprint(req.ClientDtlsFingerprint)
	if err != nil {
		return "", nil, fmt.Errorf("clientDtlsFingerprint: %w", err)
	}
	now := time.Now()
	ttl := req.TTLSeconds
	if ttl <= 0 || ttl > 300 {
		ttl = 300
	}
	claims := &devtoken.Claims{
		Iss:      s.cfg.Issuer,
		Aud:      firstNonEmpty(req.DeskID, s.cfg.DeskID),
		Sub:      firstNonEmpty(req.Sub, s.cfg.OwnerID),
		Scope:    firstNonEmpty(req.Scope, "owner"),
		Sid:      firstNonEmpty(req.Sid, "s-devsession00000"),
		Jti:      randomID("jt-"),
		Iat:      now.Unix(),
		Nbf:      now.Unix(),
		Exp:      now.Unix() + ttl,
		AuthTime: now.Unix(),
		Cnf:      devtoken.Cnf{X5tS256: devtoken.CnfFromBytes(raw)},
		MaOwner:  s.cfg.OwnerID,
		MaKind:   "personal",
		MaName:   s.cfg.OwnerName,
	}
	if s.cfg.guild() {
		guildClaims(claims, req, s.cfg.GuildID)
		token, err := s.signer.SignGuild(claims)
		if err != nil {
			return "", nil, err
		}

		return token, claims, nil
	}
	token, err := s.signer.Sign(claims)
	if err != nil {
		return "", nil, err
	}

	return token, claims, nil
}

// guildClaims turns a desk token's claims into a Guild Desk member's (guild-eng.md 3.2): sub is the member, scope
// guild_member, and the ma_g* claims replace ma_owner and ma_kind. A lead holds every grant, a member none.
func guildClaims(c *devtoken.Claims, req *tokenRequest, guildID string) {
	c.Sub = firstNonEmpty(req.Sub, "gm-dev00000001")
	c.Scope = devtoken.ScopeGuildMember
	c.MaOwner, c.MaKind = "", ""
	c.MaGid = guildID
	c.MaGrole = firstNonEmpty(req.Role, "member")
	c.MaName = firstNonEmpty(req.Name, "Dev Member")
	grants := []string{}
	switch {
	case c.MaGrole == "lead":
		grants = append(grants, devtoken.GuildGrants...)
	case c.MaGrole == "officer" && req.Grants != nil:
		grants = append(grants, *req.Grants...)
	case c.MaGrole == "officer":
		grants = []string{"moderate", "invite"}
	}
	c.MaGrants = &grants
	if c.MaGrole != "member" {
		badge := c.MaGrole
		c.MaBadge = &badge
	}
	teen := req.Teen
	c.MaTeen = &teen
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}

	return b
}

func timesOf(c *devtoken.Claims) (expiresAt, refreshAfter string) {
	exp := time.Unix(c.Exp, 0).UTC()

	return exp.Format(time.RFC3339), exp.Add(-time.Minute).Format(time.RFC3339)
}

func (s *Shim) handleDevToken(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")

		return
	}
	token, claims, err := s.mint(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())

		return
	}
	expiresAt, refreshAfter := timesOf(claims)
	_, wsURL := baseURLs(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"deskId": claims.Aud, "deskToken": token, "expiresAt": expiresAt, "refreshAfter": refreshAfter,
		"gateway": wsURL, "claims": claims,
	})
}

func (s *Shim) handleConnect(w http.ResponseWriter, r *http.Request) {
	deskID := r.PathValue("deskId")
	if deskID != s.cfg.DeskID {
		writeError(w, http.StatusNotFound, "not_found", "this shim serves one desk: "+s.cfg.DeskID)

		return
	}
	if s.cfg.guild() {
		writeError(w, http.StatusNotFound, "not_found", "a Guild Desk's members get their token from POST /v1/guilds/"+s.cfg.GuildID+"/desk/token")

		return
	}
	var req struct {
		tokenRequest
		Start bool `json:"start"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")

		return
	}
	req.DeskID = deskID
	// Only scope and the fingerprint come from the caller on connect, as on the real route.
	req.Sub, req.Sid, req.TTLSeconds = "", "", 0
	token, claims, err := s.mint(&req.tokenRequest)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())

		return
	}
	expiresAt, refreshAfter := timesOf(claims)
	s.writeTokenReply(w, r, deskID, token, expiresAt, refreshAfter)
}

// writeTokenReply is connect's reply, which the guild token route shares.
func (s *Shim) writeTokenReply(w http.ResponseWriter, r *http.Request, deskID, token, expiresAt, refreshAfter string) {
	_, wsURL := baseURLs(r)

	s.mu.Lock()
	phase := "connecting"
	if s.desk != nil {
		phase = "ready"
	}
	var identity any
	var identityAsOf any
	if len(s.fingerprints) > 0 {
		identity = map[string]any{"fingerprintsSha256": s.fingerprints}
		identityAsOf = s.identityAsOf
	}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"deskId": deskID, "state": "running", "phase": phase, "deskToken": token,
		"expiresAt": expiresAt, "refreshAfter": refreshAfter, "gateway": wsURL,
		"deskIdentity": identity, "identityAsOf": identityAsOf,
	})
}

// handleGuildToken is the stub of Platform's POST /v1/guilds/{id}/desk/token (guild-eng.md 3.2): connect's reply,
// with a member's ma-guild+jwt. It takes the fingerprint as fingerprint or clientDtlsFingerprint. Shim-only: memberId,
// role, name, grants and teen pick the member, since there's no roster here; with none, it's gm-dev00000001.
func (s *Shim) handleGuildToken(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.guild() || r.PathValue("guildId") != s.cfg.GuildID {
		writeError(w, http.StatusNotFound, "not_found", "this shim serves no such guild")

		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
		MemberID    string `json:"memberId"`
		tokenRequest
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")

		return
	}
	tr := &tokenRequest{
		ClientDtlsFingerprint: firstNonEmpty(req.Fingerprint, req.ClientDtlsFingerprint),
		Sub:                   req.MemberID, Role: req.Role, Name: req.Name, Grants: req.Grants, Teen: req.Teen,
	}
	token, claims, err := s.mint(tr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())

		return
	}
	expiresAt, refreshAfter := timesOf(claims)
	s.writeTokenReply(w, r, s.cfg.DeskID, token, expiresAt, refreshAfter)
}

func (s *Shim) agentConfig(r *http.Request) map[string]any {
	httpURL, wsURL := baseURLs(r)

	var guild any
	if s.cfg.guild() {
		guild = map[string]any{"guildId": s.cfg.GuildID, "maxGuildMembers": s.cfg.MaxGuildMembers}
	}

	return map[string]any{
		"configVersion": 1,
		"desk":          map[string]any{"deskId": s.cfg.DeskID, "kind": firstNonEmpty(s.cfg.DeskKind, "personal"), "name": "Dev Desk", "sizeId": "standard", "mode": "normal", "exportUntil": nil},
		"owner":         map[string]any{"userId": s.cfg.OwnerID, "displayName": s.cfg.OwnerName, "tier": "officer"},
		"endpoints": map[string]any{
			"api": httpURL, "app": "http://localhost:5173", "issuer": s.cfg.Issuer,
			"jwks": httpURL + "/.well-known/jwks.json", "gateway": wsURL, "gatewayId": "gw.dev.invalid",
		},
		"media":        map[string]any{"udpPort": 443, "tcpPort": 443, "maxSessions": s.cfg.MaxSessions, "maxPeerSessions": 0},
		"intervals":    map[string]any{"heartbeatSeconds": 60, "llmUsageSeconds": 300},
		"autoStop":     map[string]any{"autoStopMinutes": nil, "agentStallMinutes": 60, "sweepMinutes": 15, "prewarmMinutes": 10, "stopGraceSeconds": 60, "downtimeAgentGraceSeconds": 300},
		"upcomingStop": nil,
		"streaming":    map[string]any{"streamProfile": "normal", "allowanceRemainingGb": 100, "targetKbps": nil, "reason": nil},
		"llmKeys":      []any{},
		"keysVersion":  1,
		"guild":        guild,
		"shareLimits":  map[string]any{"maxItemBytes": 26214400},
	}
}

func (s *Shim) handleHello(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BootID string `json:"bootId"`
		DTLS   struct {
			FingerprintsSha256 []string `json:"fingerprintsSha256"`
		} `json:"dtls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")

		return
	}
	if len(body.DTLS.FingerprintsSha256) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "dtls.fingerprintsSha256 is required")

		return
	}
	s.mu.Lock()
	s.fingerprints = body.DTLS.FingerprintsSha256
	s.identityAsOf = time.Now().UTC().Format(time.RFC3339)
	s.mu.Unlock()
	s.log.Info("hello", "bootId", body.BootID, "fingerprints", body.DTLS.FingerprintsSha256)
	writeJSON(w, http.StatusOK, map[string]any{
		"deskId": s.cfg.DeskID, "state": "running", "heartbeatSeconds": 60, "config": s.agentConfig(r),
	})
}

func (s *Shim) handleHeartbeat(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.heartbeats++
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"state": "running", "nextHeartbeatSeconds": 60,
		"activity":      map[string]any{"lastActiveAt": time.Now().UTC().Format(time.RFC3339), "autoStopAt": nil},
		"stopAt":        nil,
		"stopReason":    nil,
		"configVersion": 1, "keysVersion": 1, "sharesVersion": 0,
		"limitsRemaining": map[string]any{}, "dropKeyIds": []any{}, "purgeGrantIds": []any{},
		"revokedSessions": []any{}, "tokensValidAfter": nil, "supportSession": nil, "upcomingStop": nil,
		"streaming":    map[string]any{"streamProfile": "normal", "allowanceRemainingGb": 100, "targetKbps": nil, "reason": nil},
		"guildVersion": nil, "actions": []any{},
	})
}

func (s *Shim) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.agentConfig(r))
}

func (s *Shim) handleDevState(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.sessions))
	for id, sess := range s.sessions {
		if sess.accepted {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	writeJSON(w, http.StatusOK, map[string]any{
		"deskId": s.cfg.DeskID, "ready": s.desk != nil, "bootId": s.bootID,
		"fingerprintsSha256": s.fingerprints, "sessions": ids, "heartbeats": s.heartbeats,
	})
}

// wsConn is one upgraded connection.
type wsConn struct {
	c        *websocket.Conn
	isDesk   bool
	lastSeen atomic.Int64
	sendMu   sync.Mutex
	gone     chan struct{}
	goneOnce sync.Once
	ready    atomic.Bool
}

func (c *wsConn) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.c.Write(ctx, websocket.MessageText, b)
}

func (c *wsConn) sendError(id, code, msg string, retryable bool) {
	c.send(map[string]any{
		"type": "error", "id": id, "code": code, "message": msg, "retryable": retryable, "details": map[string]any{},
	})
}

func (s *Shim) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	if !slices.ContainsFunc(r.Header.Values("Sec-WebSocket-Protocol"), func(v string) bool {
		return slices.Contains(strings.Split(strings.ReplaceAll(v, " ", ""), ","), gw.Subprotocol)
	}) {
		writeError(w, http.StatusBadRequest, "invalid_request", "Sec-WebSocket-Protocol: "+gw.Subprotocol+" is required")

		return
	}
	isDesk := r.Header.Get(gw.DeskAuthHeader) != ""
	if !isDesk && len(s.cfg.AllowedOrigins) > 0 && !slices.Contains(s.cfg.AllowedOrigins, r.Header.Get("Origin")) {
		writeError(w, http.StatusForbidden, "origin_not_allowed", "origin not allowed")

		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{gw.Subprotocol},
		InsecureSkipVerify: true, // Origin is checked above.
	})
	if err != nil {
		s.log.Warn("upgrade failed", "err", err)

		return
	}
	// Above the contract's limit, so an oversized frame gets its error reply instead of a close.
	c.SetReadLimit(1 << 20)

	conn := &wsConn{c: c, isDesk: isDesk, gone: make(chan struct{})}
	conn.lastSeen.Store(time.Now().UnixNano())
	s.log.Info("gateway connection", "desk", isDesk, "remote", r.RemoteAddr)

	go s.watchConn(conn)
	s.readConn(r.Context(), conn)
}

// watchConn closes a connection at the max age (1001), when silent, or when a desk never sent ready.
func (s *Shim) watchConn(conn *wsConn) {
	age := time.NewTimer(s.cfg.MaxConnAge)
	defer age.Stop()
	tick := time.NewTicker(min(s.cfg.IdleTimeout/4, time.Second))
	defer tick.Stop()
	opened := time.Now()
	for {
		select {
		case <-conn.gone:
			return
		case <-age.C:
			s.log.Info("closing connection at max age", "desk", conn.isDesk)
			_ = conn.c.Close(websocket.StatusGoingAway, "max connection age")

			return
		case <-tick.C:
			if time.Since(time.Unix(0, conn.lastSeen.Load())) > s.cfg.IdleTimeout {
				s.log.Info("dropping silent connection", "desk", conn.isDesk)
				_ = conn.c.CloseNow()

				return
			}
			if conn.isDesk && !conn.ready.Load() && time.Since(opened) > readyDeadline {
				s.log.Info("dropping desk connection with no ready")
				_ = conn.c.CloseNow()

				return
			}
		}
	}
}

func (s *Shim) readConn(ctx context.Context, conn *wsConn) {
	defer func() {
		conn.goneOnce.Do(func() { close(conn.gone) })
		_ = conn.c.CloseNow()
		s.onGone(conn)
	}()
	for {
		typ, data, err := conn.c.Read(ctx)
		if err != nil {
			return
		}
		conn.lastSeen.Store(time.Now().UnixNano())
		if len(data) > gw.MaxFrame {
			conn.sendError("", "message_too_large", "frame over 32 KiB", false)

			continue
		}
		var m gw.Msg
		if typ != websocket.MessageText || json.Unmarshal(data, &m) != nil || m.Type == "" {
			conn.sendError("", "invalid_request", "want a JSON text frame with a type", false)

			continue
		}
		if m.Type == "ping" {
			conn.send(map[string]any{"type": "pong", "id": m.ID, "at": time.Now().UTC().Format(time.RFC3339)})

			continue
		}
		if m.Type == "signal" && len(m.Data) > gw.MaxSignalData {
			conn.sendError(m.ID, "message_too_large", "signal.data over 30 KiB", false)

			continue
		}
		if conn.isDesk {
			s.onDeskMsg(conn, &m)
		} else {
			s.onClientMsg(conn, &m)
		}
	}
}

// verify takes a member's guild token on a Guild Desk, and only a desk token anywhere else.
func (s *Shim) verify(token string) (*devtoken.Claims, error) {
	if s.cfg.guild() {
		return devtoken.VerifyGuild(token, s.signer.JWKS(), devtoken.ExpectGuild{
			Issuer: s.cfg.Issuer, DeskID: s.cfg.DeskID, GuildID: s.cfg.GuildID,
		})
	}

	return devtoken.Verify(token, s.signer.JWKS(), devtoken.Expect{
		Issuer: s.cfg.Issuer, DeskID: s.cfg.DeskID, Owner: s.cfg.OwnerID,
	})
}

func tokenCode(err error) string {
	if errors.Is(err, devtoken.ErrWrongDesk) {
		return "wrong_desk"
	}

	return "invalid_token"
}

func openedMsg(id, sessionID, deskID string) map[string]any {
	return map[string]any{
		"type": "session.opened", "id": id, "deskId": deskID, "sessionId": sessionID,
		"iceServers": []any{}, "iceServersExpireAt": nil,
	}
}

func (s *Shim) stateOf() (state, phase string) {
	if s.desk != nil {
		return "running", "ready"
	}

	return "running", "connecting"
}

// notifyWatchers sends a desk.progress to every watcher. Call with s.mu held.
func (s *Shim) notifyWatchers() {
	_, phase := s.stateOf()
	msg := map[string]any{
		"type": "desk.progress", "deskId": s.cfg.DeskID, "phase": phase,
		"at": time.Now().UTC().Format(time.RFC3339), "queue": nil, "error": nil,
	}
	for w := range s.watchers {
		go w.send(msg)
	}
}

// onDeskMsg handles gateway.md section 3.2.
func (s *Shim) onDeskMsg(conn *wsConn, m *gw.Msg) {
	switch m.Type {
	case "ready":
		s.onReady(conn, m)
	case "session.accept":
		s.mu.Lock()
		sess := s.sessions[m.SessionID]
		if sess == nil || sess.accepted {
			s.mu.Unlock()

			return
		}
		sess.accepted = true
		if sess.timer != nil {
			sess.timer.Stop()
			sess.timer = nil
		}
		client, openID := sess.client, sess.openID
		s.mu.Unlock()
		if client != nil {
			client.send(openedMsg(openID, sess.id, s.cfg.DeskID))
		}
	case "session.reject":
		s.mu.Lock()
		sess := s.sessions[m.SessionID]
		if sess != nil {
			delete(s.sessions, m.SessionID)
			if sess.timer != nil {
				sess.timer.Stop()
			}
		}
		s.mu.Unlock()
		if sess != nil && sess.client != nil {
			sess.client.sendError(sess.openID, m.Code, m.Message, false)
		}
	case "signal":
		s.mu.Lock()
		sess := s.sessions[m.SessionID]
		var client *wsConn
		if sess != nil {
			client = sess.client
		}
		s.mu.Unlock()
		if client != nil {
			client.send(map[string]any{"type": "signal", "sessionId": m.SessionID, "data": m.Data})
		}
	case "session.close":
		s.endSession(m.SessionID, firstNonEmpty(m.Reason, "closed_by_desk"), false)
	case "badges":
		s.mu.Lock()
		msg := map[string]any{
			"type": "desk.badges", "deskId": s.cfg.DeskID, "at": time.Now().UTC().Format(time.RFC3339),
			"badges": map[string]any{"total": m.Total, "apps": m.Apps},
		}
		for w := range s.watchers {
			go w.send(msg)
		}
		s.mu.Unlock()
	case "peer.open", "peer.close":
		// Desk-to-desk guild sessions are gone (ADR 0077): members open guild_member client sessions to the Guild Desk.
		conn.sendError(m.ID, "unknown_type", "guild peer sessions are retired: a Guild Desk takes guild_member client sessions", false)
	default:
		s.log.Debug("ignoring desk message", "type", m.Type)
	}
}

func (s *Shim) onReady(conn *wsConn, m *gw.Msg) {
	conn.ready.Store(true)
	s.mu.Lock()
	old := s.desk
	s.desk = conn
	s.bootID = m.BootID

	var unknown []string
	for _, id := range m.Sessions {
		if _, ok := s.sessions[id]; !ok {
			unknown = append(unknown, id)
		}
	}
	// Held here but not on the desk any more: the desk restarted.
	var lost []*gwSession
	for id, sess := range s.sessions {
		if !slices.Contains(m.Sessions, id) {
			lost = append(lost, sess)
		}
	}
	for _, sess := range lost {
		delete(s.sessions, sess.id)
		if sess.timer != nil {
			sess.timer.Stop()
		}
	}
	s.notifyWatchers()
	s.mu.Unlock()

	if old != nil && old != conn {
		old.sendError("", "connection_replaced", "a newer connection took over this desk", false)
		_ = old.c.CloseNow()
	}
	conn.send(map[string]any{"type": "ready.ack", "at": time.Now().UTC().Format(time.RFC3339)})
	for _, id := range unknown {
		conn.send(map[string]any{"type": "session.close", "sessionId": id, "reason": "client_gone"})
	}
	for _, id := range m.PeerSessions {
		conn.send(map[string]any{"type": "peer.closed", "peerSessionId": id, "reason": "guild_ended"})
	}
	for _, sess := range lost {
		if sess.client == nil {
			continue
		}
		if sess.accepted {
			sess.client.send(map[string]any{"type": "session.closed", "sessionId": sess.id, "reason": "desk_disconnected"})
		} else {
			sess.client.sendError(sess.openID, "desk_not_ready", "the desk reconnected without this session", true)
		}
	}
	s.log.Info("desk ready", "bootId", m.BootID, "sessions", m.Sessions)
}

// endSession removes a session and tells the other side.
func (s *Shim) endSession(id, reason string, tellDesk bool) {
	s.mu.Lock()
	sess := s.sessions[id]
	if sess == nil {
		s.mu.Unlock()

		return
	}
	delete(s.sessions, id)
	if sess.timer != nil {
		sess.timer.Stop()
	}
	desk := s.desk
	s.mu.Unlock()

	if tellDesk && desk != nil {
		desk.send(map[string]any{"type": "session.close", "sessionId": id, "reason": reason})
	}
	if sess.client != nil {
		sess.client.send(map[string]any{"type": "session.closed", "sessionId": id, "reason": reason})
	}
}

// onClientMsg handles gateway.md section 2.
func (s *Shim) onClientMsg(conn *wsConn, m *gw.Msg) {
	switch m.Type {
	case "watch":
		if _, err := s.verifyFor(conn, m); err != nil {
			return
		}
		s.mu.Lock()
		s.watchers[conn] = struct{}{}
		state, phase := s.stateOf()
		s.mu.Unlock()
		conn.send(map[string]any{"type": "watching", "id": m.ID, "deskId": s.cfg.DeskID, "state": state, "phase": phase, "etag": `"1"`})
	case "unwatch":
		s.mu.Lock()
		delete(s.watchers, conn)
		s.mu.Unlock()
	case "session.open":
		s.onSessionOpen(conn, m)
	case "session.resume":
		s.onSessionResume(conn, m)
	case "session.refresh":
		s.onSessionRefresh(conn, m)
	case "signal":
		s.mu.Lock()
		sess := s.sessions[m.SessionID]
		ok := sess != nil && sess.client == conn && sess.accepted
		desk := s.desk
		s.mu.Unlock()
		switch {
		case !ok:
			conn.sendError(m.ID, "session_not_found", "unknown or closed sessionId", false)
		case desk == nil:
			conn.sendError(m.ID, "desk_not_ready", "the desk's gateway link is down", true)
		default:
			desk.send(map[string]any{"type": "signal", "sessionId": m.SessionID, "data": m.Data})
		}
	case "session.close":
		s.mu.Lock()
		sess := s.sessions[m.SessionID]
		ok := sess != nil && sess.client == conn
		s.mu.Unlock()
		if !ok {
			conn.sendError(m.ID, "session_not_found", "unknown or closed sessionId", false)

			return
		}
		s.endSession(m.SessionID, firstNonEmpty(m.Reason, "closed_by_client"), true)
	default:
		conn.sendError(m.ID, "unknown_type", "unknown request type "+m.Type, false)
	}
}

// verifyFor checks a desk-scoped message's token and reports a failure to the sender.
func (s *Shim) verifyFor(conn *wsConn, m *gw.Msg) (*devtoken.Claims, error) {
	if m.DeskID != "" && m.DeskID != s.cfg.DeskID {
		conn.sendError(m.ID, "wrong_desk", "this shim serves one desk: "+s.cfg.DeskID, false)

		return nil, devtoken.ErrWrongDesk
	}
	claims, err := s.verify(m.DeskToken)
	if err != nil {
		conn.sendError(m.ID, tokenCode(err), err.Error(), false)

		return nil, err
	}

	return claims, nil
}

func (s *Shim) onSessionOpen(conn *wsConn, m *gw.Msg) {
	claims, err := s.verifyFor(conn, m)
	if err != nil {
		return
	}
	s.mu.Lock()
	desk := s.desk
	if desk == nil {
		s.mu.Unlock()
		conn.sendError(m.ID, "desk_not_ready", "the desk isn't connected", true)

		return
	}
	if len(s.sessions) >= s.cfg.MaxSessions {
		s.mu.Unlock()
		conn.sendError(m.ID, "session_limit_reached", fmt.Sprintf("%d client sessions per desk", s.cfg.MaxSessions), false)

		return
	}
	id := randomID("cs-")[:19]
	sess := &gwSession{
		id: id, client: conn, openID: m.ID, sub: claims.Sub, scope: claims.Scope,
		cnf: claims.Cnf.X5tS256, exp: claims.Exp,
	}
	sess.timer = time.AfterFunc(s.cfg.OpenTimeout, func() {
		s.mu.Lock()
		cur := s.sessions[id]
		expired := cur != nil && !cur.accepted
		if expired {
			delete(s.sessions, id)
		}
		s.mu.Unlock()
		if expired {
			conn.sendError(m.ID, "desk_not_ready", "the desk didn't answer session.open", true)
		}
	})
	s.sessions[id] = sess
	s.mu.Unlock()
	desk.send(map[string]any{
		"type": "session.open", "sessionId": id, "deskToken": m.DeskToken,
		"openedAt": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Shim) onSessionResume(conn *wsConn, m *gw.Msg) {
	claims, err := s.verifyFor(conn, m)
	if err != nil {
		return
	}
	s.mu.Lock()
	sess := s.sessions[m.SessionID]
	if sess == nil || !sess.accepted {
		s.mu.Unlock()
		conn.sendError(m.ID, "session_not_found", "unknown or closed sessionId", false)

		return
	}
	if sess.sub != claims.Sub || sess.scope != claims.Scope || sess.cnf != claims.Cnf.X5tS256 {
		s.mu.Unlock()
		conn.sendError(m.ID, "invalid_token", "token doesn't match this session", false)

		return
	}
	sess.client = conn
	sess.exp = claims.Exp
	if sess.timer != nil {
		sess.timer.Stop()
		sess.timer = nil
	}
	s.mu.Unlock()
	s.log.Info("session resumed", "session", sess.id)
	conn.send(openedMsg(m.ID, sess.id, s.cfg.DeskID))
}

func (s *Shim) onSessionRefresh(conn *wsConn, m *gw.Msg) {
	claims, err := s.verifyFor(conn, m)
	if err != nil {
		return
	}
	s.mu.Lock()
	sess := s.sessions[m.SessionID]
	ok := sess != nil && sess.client == conn && sess.accepted
	matches := ok && sess.sub == claims.Sub && sess.scope == claims.Scope && sess.cnf == claims.Cnf.X5tS256
	if matches {
		sess.exp = claims.Exp
	}
	desk := s.desk
	s.mu.Unlock()
	switch {
	case !ok:
		conn.sendError(m.ID, "session_not_found", "unknown or closed sessionId", false)
	case !matches:
		conn.sendError(m.ID, "invalid_token", "token doesn't match this session", false)
	default:
		if desk != nil {
			desk.send(map[string]any{"type": "session.refresh", "sessionId": m.SessionID, "deskToken": m.DeskToken})
		}
		conn.send(map[string]any{
			"type": "session.refreshed", "id": m.ID, "sessionId": m.SessionID,
			"iceServers": []any{}, "iceServersExpireAt": nil,
		})
	}
}

// onGone runs when a connection ends. Desk sessions survive a desk reconnect. A client's sessions go
// on hold, then close with client_gone.
func (s *Shim) onGone(conn *wsConn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.watchers, conn)
	if conn.isDesk {
		if s.desk == conn {
			s.desk = nil
			s.notifyWatchers()
			s.log.Info("desk link down")
		}

		return
	}
	for id, sess := range s.sessions {
		if sess.client != conn {
			continue
		}
		sess.client = nil
		if sess.timer != nil {
			sess.timer.Stop()
		}
		sessionID := id
		sess.timer = time.AfterFunc(s.cfg.ResumeHold, func() {
			s.mu.Lock()
			cur := s.sessions[sessionID]
			gone := cur != nil && cur.client == nil
			s.mu.Unlock()
			if gone {
				s.endSession(sessionID, "client_gone", true)
			}
		})
	}
}

// sweep closes sessions whose token ran out: the contract's exp + 30 s rule.
func (s *Shim) sweep(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			s.mu.Lock()
			var expired []string
			for id, sess := range s.sessions {
				if sess.accepted && now.Unix() >= sess.exp+30 {
					expired = append(expired, id)
				}
			}
			s.mu.Unlock()
			for _, id := range expired {
				s.endSession(id, "token_expired", true)
			}
		}
	}
}
