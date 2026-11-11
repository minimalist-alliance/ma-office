// Package rtcserver is desk-rtc: the desk's single WebRTC endpoint (ICE-lite on one UDP socket and one
// passive ICE-TCP listener) and the rtc.sock bridge to deskd. See docs/interfaces/desk-runtime.md.
package rtcserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/user"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/identity"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xclip"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xinput"
)

const (
	// clientSessionLimit is the contract's ceiling on client sessions per desk.
	clientSessionLimit = 4
	socketWriteTimeout = 30 * time.Second
	socketBuffer       = 64 * 1024
	linkCloseWait      = 5 * time.Second
	udpSocketBuffer    = 4 * 1024 * 1024
)

// Config is desk-rtc's configuration.
type Config struct {
	SocketPath  string
	SocketGroup string
	DataDir     string
	Bind        string // an IPv4 address, or "auto" for the address of the default route
	Port        int
	// TCPPort is the passive ICE-TCP listener's port when it isn't Port's (shared.go: a shared host's slot takes UDP on
	// its own port and TCP on 443, which the host's demux shares between slots). 0 means Port.
	TCPPort int
	// SharedSlot is the slot of a shared desk host this desk runs on, 1 to 32, or 0 for a desk of its own (shared.go).
	// With it every local ICE ufrag starts s<kk>, so the host's TCP 443 demux can route a connection to this slot.
	SharedSlot int
	// PublicIPv4 is the address both candidates name when it isn't configure's: a shared host's own public IPv4, which
	// desk-host reads from the host's IMDS at each start (shared.go). Empty means configure's publicIpv4, as on any desk.
	PublicIPv4     string
	ConsentTimeout time.Duration
	Version        string
	Log            *slog.Logger

	// StreamSocket is where desk-stream connects (section 8.2), and StreamUID the only uid it accepts.
	// Empty means no video.
	StreamSocket string
	StreamUID    int
	// ProfileFile is where desk-egress names the stream's allowance profile (production: /run/desk-egress/profile),
	// read at start and each time desk-stream connects (quality.go). Empty, or no file there, is the normal picture.
	ProfileFile string
	// Display is the X display to inject into (section 8.6) and hold the clipboard on. Empty means input is
	// decoded and dropped, and the clipboard answers no_display.
	Display string
	// NoPlayoutDelay leaves the playout-delay extension off, for measuring what it buys.
	NoPlayoutDelay bool
	// GuildMaxSessions is the most sessions a Guild Desk takes at once (guild.go), whatever deskd's configure asks.
	// 0 means defaultGuildMaxSessions, maxGuildMembers x 3.
	GuildMaxSessions int
	// VoiceRelayAddr is where a Guild Desk relays Commons' voice ICE (voicerelay.go): a loopback address, TCP and UDP.
	// Empty means DefaultVoiceRelayAddr. Other desks never use it.
	VoiceRelayAddr string
	// voiceLimits are the relay's caps and timings, for tests; zero means defaultVoiceLimits.
	voiceLimits voiceLimits
	// GuildRxBudget, GuildTxSoft and GuildTxBudget are a Guild Desk's memory budget in bytes (budget.go); zero means
	// the defaults. Other desks have none.
	GuildRxBudget, GuildTxSoft, GuildTxBudget int64
}

// Server is one running desk-rtc.
type Server struct {
	cfg      Config
	log      *slog.Logger
	id       *identity.Identity
	bindIP   net.IP
	pionLogs logging.LoggerFactory

	udpConn *net.UDPConn
	udpMux  ice.UDPMux
	tcpMux  *gatedTCPMux
	gate    *gateListener
	sockLn  net.Listener

	hub   *streamHub
	input *xinput.Injector
	clip  *xclip.Clipboard
	voice *voiceRelay // a Guild Desk's relay of Commons' voice ICE; idle on every other desk

	mu  sync.Mutex
	cur *link

	nextHandle  atomic.Uint32
	totalSent   atomic.Uint64
	totalRecv   atomic.Uint64
	lastBlocked atomic.Int64 // crop.go: when deskd last heard island.blocked, unix ns
	// statsMu makes a session's move from its link's table to the totals one step, which a stats holds still while it
	// reads both, so a stats counts each session's bytes once: live or in the totals, never neither, never both.
	statsMu sync.RWMutex
	// memberTotals are a Guild Desk's closed sessions' bytes by member (guild.go). statsMu guards it, as the totals.
	memberTotals map[string]*memberTotal
	// closed are a Guild Desk's closed sessions' final rows, oldest first, kept until deskd acks them (guild.go), and
	// closedDropped those dropped unacked. statsMu guards closed.
	closed        []*closedRow
	closedDropped atomic.Uint64
	// budget is the Guild Desk's memory budget (budget.go). Only a Guild Desk's sessions use it.
	budget *guildBudget
	// guildDesk says the last configure was a Guild Desk's. It outlives a dropped link, for what's set before a
	// session is known: the ICE-TCP send buffer (tcpgate.go).
	guildDesk atomic.Bool
}

// New loads the identity, binds UDP and TCP and listens on rtc.sock, per boot order step 2. It answers
// no STUN until deskd creates a session.
func New(cfg Config) (*Server, error) {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.ConsentTimeout <= 0 {
		cfg.ConsentTimeout = 30 * time.Second
	}
	if cfg.GuildMaxSessions <= 0 {
		cfg.GuildMaxSessions = defaultGuildMaxSessions
	}
	if err := validateShared(cfg); err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, log: cfg.Log, pionLogs: logging.NewDefaultLoggerFactory(), memberTotals: map[string]*memberTotal{},
		budget: newGuildBudget(cfg.GuildRxBudget, cfg.GuildTxSoft, cfg.GuildTxBudget)}

	id, err := identity.LoadOrCreate(cfg.DataDir, cfg.Log)
	if err != nil {
		return nil, err
	}
	s.id = id

	if s.bindIP, err = resolveBind(cfg.Bind); err != nil {
		return nil, err
	}
	if s.voice, err = newVoiceRelay(cfg.VoiceRelayAddr, cfg.voiceLimits, cfg.Log); err != nil {
		return nil, err
	}
	if err := s.bindICE(); err != nil {
		return nil, err
	}
	if err := s.listenSocket(); err != nil {
		s.closeICE()

		return nil, err
	}
	s.hub = newStreamHub(s)
	if cfg.Display != "" {
		s.input = xinput.New(cfg.Display, cfg.Log.With("part", "input"))
		s.input.OnCursor(s.onCursor)
		s.input.OnBlocked(s.onIslandBlocked)
		s.clip = xclip.New(xclip.Config{Display: cfg.Display, Log: cfg.Log.With("part", "clipboard"), Send: s.clipSend})
	}

	return s, nil
}

// resolveBind picks the address to bind. One address, not 0.0.0.0, because Pion would otherwise add a
// TCP candidate per interface (eth0, docker0), and duplicates after the rewrite to the public IP
// break the mux's per-address lookup. On a desk this is the instance's private IPv4, the 1:1 NAT
// target.
func resolveBind(bind string) (net.IP, error) {
	if bind != "" && bind != "auto" {
		ip := net.ParseIP(bind).To4()
		if ip == nil || ip.IsUnspecified() {
			return nil, fmt.Errorf("--bind %q: want one IPv4 address, or auto", bind)
		}

		return ip, nil
	}
	// A connected UDP socket sends nothing; this only asks the kernel for the route's source address.
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return nil, fmt.Errorf("--bind auto: no default route (%w); pass --bind", err)
	}
	defer c.Close()

	addr, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.To4() == nil {
		return nil, errors.New("--bind auto: no IPv4 source address; pass --bind")
	}

	return addr.IP.To4(), nil
}

func (s *Server) bindICE() error {
	udpConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: s.bindIP, Port: s.cfg.Port})
	if err != nil {
		return fmt.Errorf("bind UDP: %w", err)
	}
	_ = udpConn.SetReadBuffer(udpSocketBuffer)
	_ = udpConn.SetWriteBuffer(udpSocketBuffer)

	tcpLn, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: s.bindIP, Port: s.tcpPort()})
	if err != nil {
		_ = udpConn.Close()

		return fmt.Errorf("bind TCP: %w", err)
	}

	s.udpConn = udpConn
	pionLog := s.pionLogs.NewLogger("rtc-mux")
	s.voice.out = udpConn
	// OnUnhandledPacket sees only what the mux would drop: no session's ufrag or address. The relay takes Commons'
	// part of that on a Guild Desk, and on any other desk returns at once.
	s.udpMux = ice.NewUDPMuxDefault(ice.UDPMuxParams{Logger: pionLog, UDPConn: udpConn, OnUnhandledPacket: s.voice.onUDP})

	gate := newGateListener(tcpLn, s.log)
	mux := &gatedTCPMux{ufrags: map[string]struct{}{}, pwds: map[string]string{}, gate: gate}
	gate.allow = mux.known
	gate.verify = mux.verify
	gate.handedIdle = max(s.cfg.ConsentTimeout, 10*time.Second)
	gate.relay = s.voice.takeTCP
	gate.sendBuffer = func() int {
		if s.guildDesk.Load() {
			return guildTCPSendBuffer
		}

		return tcpSendBuffer
	}
	mux.TCPMuxDefault = ice.NewTCPMuxDefault(ice.TCPMuxParams{
		Listener:       gate,
		Logger:         pionLog,
		ReadBufferSize: 64,
		// 0 means writes block instead of dropping packets, so nothing queues above the kernel's
		// bounded send buffer and SCTP's own limit keeps holding.
		WriteBufferSize: 0,
	})
	s.gate = gate
	s.tcpMux = mux
	go gate.serve()

	return nil
}

func (s *Server) closeICE() {
	if s.tcpMux != nil {
		_ = s.tcpMux.Close()
	}
	if s.udpMux != nil {
		_ = s.udpMux.Close()
	}
}

func (s *Server) listenSocket() error {
	path := s.cfg.SocketPath
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("rtc.sock: %w", err)
	}
	old := syscall.Umask(0o117)
	ln, err := net.Listen("unix", path)
	syscall.Umask(old)
	if err != nil {
		return fmt.Errorf("rtc.sock: %w", err)
	}
	if err := os.Chmod(path, 0o660); err != nil {
		_ = ln.Close()

		return fmt.Errorf("rtc.sock: %w", err)
	}
	if s.cfg.SocketGroup != "" {
		g, err := user.LookupGroup(s.cfg.SocketGroup)
		if err != nil {
			_ = ln.Close()

			return fmt.Errorf("rtc.sock group: %w", err)
		}
		gid, err := strconv.Atoi(g.Gid)
		if err != nil {
			_ = ln.Close()

			return fmt.Errorf("rtc.sock group: %w", err)
		}
		if err := os.Chown(path, -1, gid); err != nil {
			_ = ln.Close()

			return fmt.Errorf("rtc.sock group: %w", err)
		}
	}
	s.sockLn = ln

	return nil
}

// Fingerprint returns the identity's fingerprint as 64 lowercase hex chars.
func (s *Server) Fingerprint() string { return s.id.FingerprintHex }

// BindAddr describes where ICE listens.
func (s *Server) BindAddr() string {
	return net.JoinHostPort(s.bindIP.String(), strconv.Itoa(s.udpConn.LocalAddr().(*net.UDPAddr).Port))
}

// Serve accepts deskd connections until ctx ends, then closes every session within 5 s.
func (s *Server) Serve(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() { _ = s.sockLn.Close() })
	defer stop()
	go s.hub.serve()
	defer s.hub.close()
	go s.voice.sweep()
	defer s.voice.close()
	if s.input != nil {
		defer s.input.Close()
	}
	if s.clip != nil {
		defer s.clip.Close()
	}

	for {
		conn, err := s.sockLn.Accept()
		if err != nil {
			s.replaceLink(nil)
			s.closeICE()
			if ctx.Err() != nil {
				return nil
			}

			return fmt.Errorf("rtc.sock accept: %w", err)
		}
		s.replaceLink(conn)
	}
}

// replaceLink enforces one client at a time: the old connection and its sessions go first.
func (s *Server) replaceLink(conn net.Conn) {
	s.mu.Lock()
	old := s.cur
	s.cur = nil
	s.mu.Unlock()
	if old != nil {
		s.log.Info("rtc.sock: replacing the current client")
		old.shutdown()
		<-old.done
	}
	// The voice relay takes nothing new until a configure says Guild Desk again; what it has carries on meanwhile.
	s.voice.pause()
	if conn == nil {
		return
	}
	s.hub.setLimit(nil) // a stream.limit lasts as long as the deskd connection that sent it
	s.hub.setCrop(nil)  // and so does an island
	l := newLink(s, conn)
	if s.clip != nil {
		// Before this link's first message, and before clipSend can see it, so the clipboard sends it nothing
		// that was meant for the last one.
		l.clipLink = s.clip.ResetLink()
	}
	s.mu.Lock()
	s.cur = l
	s.mu.Unlock()
	l.start()
}

// toDeskd sends a message to the connected deskd, if there is one.
func (s *Server) toDeskd(m *rtcsock.Message) {
	s.mu.Lock()
	l := s.cur
	s.mu.Unlock()
	if l != nil {
		l.sendJSON(m)
	}
}

// onCursor sends a new pointer shape to every session viewing.
func (s *Server) onCursor(c xinput.Cursor) {
	msg := xinput.CursorMessage(c)
	for _, v := range *s.hub.current.Load() {
		v.s.sendCursor(msg)
	}
}

func (s *Server) addTotals(sent, received uint64) {
	s.totalSent.Add(sent)
	s.totalRecv.Add(received)
}

// link is one deskd connection.
type link struct {
	srv  *Server
	conn net.Conn
	out  *outQueue
	// clipLink is what the clipboard calls this connection, set before it's published.
	clipLink uint64

	mu          sync.RWMutex
	configured  bool
	publicIP    string
	maxSessions int
	// guild and perMember are a Guild Desk's, from configure (guild.go). A session keeps the mode it was made in.
	guild     bool
	perMember int
	credit    int // deskd's credit per channel toward a Guild Desk's sessions
	sessions  map[string]*session
	byHandle  map[uint32]*session

	// statsSend keeps a Guild Desk's stats parts together when two stats.get overlap (guild.go).
	statsSend sync.Mutex

	shutdownOnce sync.Once
	done         chan struct{}
}

func newLink(s *Server, conn net.Conn) *link {
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.SetWriteBuffer(socketBuffer)
		_ = uc.SetReadBuffer(socketBuffer)
	}

	return &link{
		srv:      s,
		conn:     conn,
		out:      newOutQueue(),
		sessions: map[string]*session{},
		byHandle: map[uint32]*session{},
		done:     make(chan struct{}),
	}
}

func (l *link) start() {
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		l.writeLoop()
	}()
	go func() {
		err := l.readLoop()
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
			l.srv.log.Error("rtc.sock read failed", "err", err)
		}
		l.shutdown()
		l.closeAllSessions()
		l.out.close()
		<-writerDone
		close(l.done)
	}()
}

func (l *link) shutdown() {
	l.shutdownOnce.Do(func() {
		_ = l.conn.Close()
	})
}

// closeAllSessions is the section 4.1 rule: when the connection drops, every session closes within
// 5 s.
func (l *link) closeAllSessions() {
	l.mu.RLock()
	all := make([]*session, 0, len(l.sessions))
	for _, s := range l.sessions {
		all = append(all, s)
	}
	l.mu.RUnlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for _, s := range all {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s.close(reasonLinkLost, false)
			}()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(linkCloseWait):
		l.srv.log.Warn("sessions still closing after 5 s")
	}
}

func (l *link) writeLoop() {
	for {
		b, ok := l.out.next()
		if !ok {
			return
		}
		_ = l.conn.SetWriteDeadline(time.Now().Add(socketWriteTimeout))
		if _, err := l.conn.Write(b); err != nil {
			if !errors.Is(err, net.ErrClosed) {
				l.srv.log.Error("rtc.sock write failed", "err", err)
			}
			l.shutdown()

			return
		}
	}
}

func (l *link) sendJSON(m *rtcsock.Message) {
	b, err := rtcsock.EncodeJSON(m)
	if err != nil {
		l.srv.log.Error("rtc.sock encode failed", "t", m.T, "err", err)

		return
	}
	l.out.pushCtrl(b)
}

func (l *link) readLoop() error {
	r := bufio.NewReaderSize(l.conn, 128*1024)
	for {
		typ, body, err := rtcsock.ReadEnvelope(r)
		if err != nil {
			return err
		}
		switch typ {
		case rtcsock.TypeJSON:
			var m rtcsock.Message
			if err := json.Unmarshal(body, &m); err != nil {
				return fmt.Errorf("bad JSON from deskd: %w", err)
			}
			l.handleJSON(&m)
		case rtcsock.TypeData:
			handle, channel, frame, err := rtcsock.ParseData(body)
			if err != nil {
				return err
			}
			l.handleData(handle, channel, frame)
		case rtcsock.TypeCredit:
			handle, channel, n, err := rtcsock.ParseCredit(body)
			if err != nil {
				return err
			}
			if s := l.session(handle); s != nil && channel < rtcsock.NumBridged {
				s.rx[channel].grant(n)
			}
		default:
			return fmt.Errorf("unknown envelope type 0x%02x from deskd", typ)
		}
	}
}

func (l *link) session(handle uint32) *session {
	l.mu.RLock()
	defer l.mu.RUnlock()

	return l.byHandle[handle]
}

func (l *link) sessionByID(id string) *session {
	l.mu.RLock()
	defer l.mu.RUnlock()

	return l.sessions[id]
}

func (l *link) forget(s *session) {
	l.mu.Lock()
	delete(l.sessions, s.id)
	delete(l.byHandle, s.handle)
	l.mu.Unlock()
}

func (l *link) handleData(handle uint32, channel uint8, frame []byte) {
	s := l.session(handle)
	if s == nil {
		return // The session just closed; deskd hasn't heard yet.
	}
	if channel >= rtcsock.NumBridged || len(frame) > rtcsock.MaxFrame {
		l.srv.log.Error("bad DATA from deskd", "channel", channel, "bytes", len(frame))

		return
	}
	// ReadEnvelope allocates per message, so the queue may keep this slice.
	switch err := s.tx.enqueue(channel, frame); {
	case errors.Is(err, errOverBudget):
		l.shedTx() // a Guild Desk past its budget: the session holding the most goes
	case err != nil:
		l.srv.log.Error("closing session", "session", s.id, "channel", channel, "err", err)
		go s.close(reasonCreditViolation, false)
	}
}

func (l *link) handleJSON(m *rtcsock.Message) {
	switch m.T {
	case "configure":
		l.handleConfigure(m)
	case "session.create":
		l.handleCreate(m)
	case "session.ice_restart":
		l.handleICERestart(m)
	case "session.permissions":
		if s := l.sessionByID(m.SessionID); s != nil {
			s.setPermissions(m.Video, m.Input)
		}
	case "session.video":
		if s := l.sessionByID(m.SessionID); s != nil && m.View != nil {
			s.setView(*m.View)
		}
	case "session.close":
		l.handleClose(m)
	case "stats.get":
		l.handleStats(m)
	case msgMemberClose:
		if !l.isGuild() {
			l.srv.log.Warn("ignoring unknown message from deskd", "t", m.T) // as before guild mode, byte for byte
			break
		}
		l.handleMemberClose(m)
	case "stream.limit":
		l.srv.hub.setLimit(m.Level)
	case "stream.crop":
		l.srv.hub.setCrop(m.Crop)
	case rtcsock.MsgClipSet, rtcsock.MsgClipGet, rtcsock.MsgClipWatch:
		l.handleClipboard(m)
	default:
		l.srv.log.Warn("ignoring unknown message from deskd", "t", m.T)
	}
}

func (l *link) handleConfigure(m *rtcsock.Message) {
	ip := net.ParseIP(m.PublicIPv4).To4()
	if ip == nil {
		// Not in the spec's table: it has no failure reply for configure.
		l.sendJSON(&rtcsock.Message{T: "error", Code: "bad_request", Message: "publicIpv4 must be an IPv4 address"})

		return
	}
	guild := m.DeskKind == rtcsock.DeskKindGuild
	limit, perMember, credit := m.MaxSessions, 0, 0
	if guild {
		limit, perMember = guildLimits(m, l.srv.cfg.GuildMaxSessions)
		credit = guildCredit(m.Credit)
	} else if limit <= 0 || limit > clientSessionLimit {
		limit = clientSessionLimit
	}
	public := l.srv.candidateIP(ip)
	l.mu.Lock()
	l.configured = true
	l.publicIP = public
	l.maxSessions = limit
	l.guild = guild
	l.perMember = perMember
	l.credit = credit
	l.mu.Unlock()
	l.srv.voice.setEnabled(guild)
	l.srv.guildDesk.Store(guild)
	// The TCP gate's places follow the kind, and outlive a dropped link as guildDesk does (tcpgate.go).
	gate := memberGateLimits
	if guild {
		gate = guildGateLimits(limit, perMember)
	}
	l.srv.gate.setLimits(gate)
	reply := &rtcsock.Message{
		T:                  "configured",
		FingerprintsSha256: []string{l.srv.id.FingerprintHex},
		Version:            l.srv.cfg.Version,
		NotAfter:           l.srv.id.NotAfter.UTC().Format(time.RFC3339),
	}
	if guild {
		l.srv.log.Info("configured as a Guild Desk", "publicIpv4", ip.String(), "maxSessions", limit,
			"maxSessionsPerMember", perMember, "credit", credit, "tcpGatePlaces", gate.total, "tcpGatePerNetwork", gate.perNet)
		reply.DeskKind, reply.MaxSessions, reply.MaxSessionsPerMember, reply.Credit = rtcsock.DeskKindGuild, limit, perMember, credit
	} else {
		l.srv.log.Info("configured", "publicIpv4", ip.String(), "candidateIpv4", public, "maxSessions", limit)
	}
	l.sendJSON(reply)
	l.sendJSON(l.srv.hub.stateMessage())
}

func (l *link) sessionError(id, code, msg string) {
	l.sendJSON(&rtcsock.Message{T: "session.error", SessionID: id, Code: code, Message: msg})
}

func (l *link) handleCreate(m *rtcsock.Message) {
	l.mu.RLock()
	configured, publicIP, limit, guild, perMember, credit := l.configured, l.publicIP, l.maxSessions, l.guild, l.perMember, l.credit
	l.mu.RUnlock()
	if !configured {
		l.sessionError(m.SessionID, rtcsock.CodeNotConfigured, "send configure first")

		return
	}
	if m.SessionID == "" {
		l.sessionError(m.SessionID, rtcsock.CodeBadOffer, "sessionId is required")

		return
	}
	expected, err := parseExpected(m.ExpectedFingerprint)
	if err != nil {
		l.sessionError(m.SessionID, rtcsock.CodeBadOffer, err.Error())

		return
	}
	// A Guild Desk's session belongs to one member, whose bytes it counts and whom member.close can end. Elsewhere a
	// memberId means nothing and is left out.
	memberID := ""
	if guild {
		if err := checkMemberID(m.MemberID); err != nil {
			l.sessionError(m.SessionID, rtcsock.CodeBadOffer, err.Error())

			return
		}
		memberID = m.MemberID
	}
	// Everything about the offer is checked before anything is allocated for it.
	info, oerr := parseOffer(m.Offer, expected)
	if oerr != nil {
		l.srv.log.Info("refused offer", "session", m.SessionID, "code", oerr.code, "why", oerr.msg)
		l.sessionError(m.SessionID, oerr.code, oerr.msg)

		return
	}
	var perm rtcsock.Permissions
	if m.Permissions != nil {
		perm = *m.Permissions
	}

	l.mu.Lock()
	if _, exists := l.sessions[m.SessionID]; exists {
		l.mu.Unlock()
		l.sessionError(m.SessionID, rtcsock.CodeBadOffer, "sessionId is already in use")

		return
	}
	if len(l.sessions) >= limit {
		l.mu.Unlock()
		l.sessionError(m.SessionID, rtcsock.CodeSessionLimitReached, "the desk already has its maximum of sessions")

		return
	}
	if guild && l.memberSessionsLocked(memberID) >= perMember {
		l.mu.Unlock()
		l.sessionError(m.SessionID, rtcsock.CodeSessionLimitReached, "this member already has their maximum of sessions on the Guild Desk")

		return
	}
	if guild {
		perm = rtcsock.Permissions{} // no screen: no video and no input, whatever deskd says
	}
	s := newSession(l, m.SessionID, l.srv.nextHandle.Add(1), expected, perm)
	if guild {
		s.setGuild(memberID, credit)
	}
	l.sessions[s.id] = s
	l.byHandle[s.handle] = s
	l.mu.Unlock()

	// Not on the read loop: nothing here may delay other sessions' frames.
	go func() {
		answer, err := s.start(m.Offer, publicIP, info)
		if err != nil {
			code, msg := errorCode(err)
			l.srv.log.Warn("session setup failed", "session", s.id, "code", code, "err", err)
			s.abort()
			l.sessionError(s.id, code, msg)

			return
		}
		l.srv.log.Info("session created", "session", s.id, "handle", s.handle)
		l.sendJSON(&rtcsock.Message{T: "session.answer", SessionID: s.id, Handle: s.handle, Answer: answer})
	}()
}

func lookupUID(name string) (int, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return -1, err
	}

	return strconv.Atoi(u.Uid)
}

func errorCode(err error) (string, string) {
	var oerr *offerError
	if errors.As(err, &oerr) {
		return oerr.code, oerr.msg
	}

	return rtcsock.CodeInternal, err.Error()
}

func (l *link) handleICERestart(m *rtcsock.Message) {
	s := l.sessionByID(m.SessionID)
	if s == nil {
		l.sessionError(m.SessionID, rtcsock.CodeBadOffer, "unknown session")

		return
	}
	go func() {
		answer, err := s.iceRestart(m.Offer)
		if err != nil {
			code, msg := errorCode(err)
			l.srv.log.Warn("ICE restart failed", "session", s.id, "code", code, "err", err)
			l.sessionError(s.id, code, msg)

			return
		}
		l.sendJSON(&rtcsock.Message{T: "session.answer", SessionID: s.id, Handle: s.handle, Answer: answer})
	}()
}

func (l *link) handleClose(m *rtcsock.Message) {
	s := l.sessionByID(m.SessionID)
	if s == nil {
		// Already gone. The reply makes session.close idempotent for deskd; on a Guild Desk it carries the final
		// bytes while desk-rtc still keeps them.
		reply := &rtcsock.Message{T: "session.closed", SessionID: m.SessionID, Reason: m.Reason}
		if row, ok := l.srv.closedRowFor(m.SessionID); ok && l.isGuild() {
			reply.MemberID, reply.BytesSent, reply.BytesReceived = row.MemberID, &row.BytesSent, &row.BytesReceived
		}
		l.sendJSON(reply)

		return
	}
	go s.close(m.Reason, true)
}

func (l *link) isGuild() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()

	return l.guild
}

func (l *link) handleStats(m *rtcsock.Message) {
	go func() {
		if len(m.Ack) > 0 && l.isGuild() {
			l.srv.statsMu.Lock()
			l.srv.ackClosedLocked(m.Ack)
			l.srv.statsMu.Unlock()
		}
		// Held until the totals are read, so no session here moves into them meanwhile (statsMu).
		l.srv.statsMu.RLock()
		defer l.srv.statsMu.RUnlock()
		l.mu.RLock()
		all := make([]*session, 0, len(l.sessions))
		anyGuild := false
		for _, s := range l.sessions {
			all = append(all, s)
			anyGuild = anyGuild || s.guild
		}
		guild := l.guild
		l.mu.RUnlock()

		rows := make([]rtcsock.SessionStats, 0, len(all))
		var liveSent, liveRecv uint64
		for _, s := range all {
			row := s.stats()
			rows = append(rows, row)
			liveSent += row.BytesSent
			liveRecv += row.BytesReceived
		}
		var peer uint64
		sent := l.srv.totalSent.Load() + liveSent
		recv := l.srv.totalRecv.Load() + liveRecv
		reply := &rtcsock.Message{
			T:             "stats",
			Sessions:      rows,
			PeerBytesSent: &peer,
			BytesSent:     &sent,
			BytesReceived: &recv,
			Stream:        l.srv.hub.stats(),
		}
		if guild {
			reply.Members = l.srv.memberStats(rows) // live rows only: closed sessions' bytes are in the members' totals
			reply.Sessions = append(reply.Sessions, l.srv.closedRowsLocked()...)
			reply.VoiceRelay = l.srv.voice.stats()
			reply.Budget = l.srv.budgetStats()
		}
		if guild || anyGuild {
			// In parts: hundreds of rows don't fit one envelope. Guild sessions left on a link configure made ordinary
			// again (the review's L3) still come in parts, so a reply never outgrows 64 KiB.
			l.sendGuildStats(reply)

			return
		}
		l.sendJSON(reply)
	}()
}
