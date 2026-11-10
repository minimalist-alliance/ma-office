package rtcserver

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// Guild mode: a Guild Desk is one shared desk for a whole guild, with no screen, encoder or Browser (ADR 0077). deskd
// reads the desk's kind from IMDS, which desk-rtc can't reach, and says so in configure: deskKind "guild". From then
// on, on that rtc.sock connection:
//   - many sessions at once, maxGuildMembers x 3 by default, outside the four a desk otherwise takes, and at most
//     maxSessionsPerMember of them for any one member;
//   - each session.create carries the member's id (the token's sub, deskd checked the token), and the session keeps it;
//   - data channels only: channels 0 to 5, bridged as on any desk. No track is offered: an audio or video section
//     in the offer is answered inactive (or rejected, for video without a shared codec, as on any desk), input and
//     keys are read and dropped, and video and input permissions stay off;
//   - a bound on memory (the review's H1 and M1): a small SCTP window, a cap on what each SCTP stream may hold unread,
//     data on a stream that isn't a channel ends the session, a credit of deskd's choosing, and the desk's budget
//     (budget.go) over every session's queued bytes;
//   - stats carry each session's memberId, a members table (each member's bytes over this process's life), and each
//     closed session's final row, closed: true, until deskd acks it; session.closed carries the final bytes too;
//   - member.close {memberId, reason} closes every session that member has, at once, then answers member.closed.
// A desk that isn't a Guild Desk sees none of this. The README's "Guild mode" is the contract.

const (
	// defaultGuildMaxSessions is maxGuildMembers (200) x 3, the gateway's ceiling for a Guild Desk.
	defaultGuildMaxSessions = 600
	// defaultSessionsPerMember is what one member gets when deskd doesn't say: three, as deskd's API, the gateway and
	// Security's GD-1 count them.
	defaultSessionsPerMember = 3
	// maxMemberIDLen bounds a memberId. Platform's are "gm-" and a dozen characters.
	maxMemberIDLen = 128
	// guildReadBuffer is a Guild Desk session's read buffer per channel: one frame at most, and one byte more, so a
	// larger message still fails the read and closes the session with frame_too_large, as the 64 KiB buffer does.
	// Six channels at 16 KiB instead of eight at 64 is about 400 KiB less a session.
	guildReadBuffer = rtcsock.MaxFrame + 1
	// guildDropBuffer is the read buffer for input and keys, which a Guild Desk reads only to drop: an event is 12
	// bytes, and anything over this closes the session (frame_too_large), as any oversized frame does.
	guildDropBuffer = 1024

	// guildSCTPReceiveBuffer is a Guild Desk session's SCTP receive window, against 4 MiB on any other desk. It's
	// what the client may have in flight to desk-rtc unread, so it bounds a member's upload rate at about this much a
	// round trip (1.3 MB/s at 100 ms), and what a session can park in desk-rtc when deskd or the budget hold it up.
	guildSCTPReceiveBuffer = 128 * 1024
	// guildReassemblyEntries caps the DATA chunks one SCTP stream may hold unread, fragments included. Pion's window
	// counts only payload bytes, and each message costs it about 300 bytes more, so without this 1-byte messages could
	// park 300 times the window. Only the eight channels' streams can hold any (SetSCTPRejectUnnegotiatedStreams), so a
	// session parks at most 8 x 1024 chunks, about 2.6 MiB. A window of 16 KiB messages is about 120 chunks, and a
	// reader keeps a stream near empty unless it's waiting on credit; past this, SCTP aborts and the session ends,
	// protocol_error. 256 was too few: a reader that falls behind a fast burst of small messages for a moment can see
	// a few thousand (the scale test's flood found it).
	guildReassemblyEntries = 1024
	// guildRxCredit is the most a Guild Desk session sends deskd on one channel ahead of deskd's grants, though deskd
	// grants 256 KiB: desk-rtc may always use less, and it halves what one session can queue for rtc.sock. It must
	// stay above deskd's grant step plus a frame (64 KiB + 16 KiB), or a channel could wait on a grant that never comes.
	guildRxCredit = 128 * 1024
	// The credit deskd may ask for in configure, per channel toward desk-rtc. The floor keeps a grant step (32 KiB)
	// and a frame (16 KiB) inside it, so deskd never waits on a grant desk-rtc holds back.
	minGuildCredit = 64 * 1024
	maxGuildCredit = rtcsock.InitialCredit

	// Closed sessions' final rows wait in stats for deskd's ack, up to this many, for at most this long.
	guildClosedKeep = 2048
	guildClosedTTL  = 15 * time.Minute

	msgMemberClose  = "member.close"
	msgMemberClosed = "member.closed"
	// reasonMemberClosed is session.closed's reason for a member.close that names none.
	reasonMemberClosed = "member_closed"
)

// guildLimits is configure's answer on a Guild Desk: deskd's maxSessions up to the ceiling (none, or one past it,
// means the ceiling), and its maxSessionsPerMember up to that (none means four).
func guildLimits(m *rtcsock.Message, ceiling int) (limit, perMember int) {
	limit = m.MaxSessions
	if limit <= 0 || limit > ceiling {
		limit = ceiling
	}
	perMember = m.MaxSessionsPerMember
	if perMember <= 0 {
		perMember = defaultSessionsPerMember
	}

	return limit, min(perMember, limit)
}

// checkMemberID accepts what Platform's member ids look like, and nothing that could upset a log line or a JSON
// reader downstream: 1 to 128 of A-Z, a-z, 0-9, '-', '_', '.', ':'.
func checkMemberID(id string) error {
	if id == "" {
		return errors.New("memberId is required on a Guild Desk")
	}
	if len(id) > maxMemberIDLen {
		return errors.New("memberId is over 128 characters")
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == ':'
		if !ok {
			return errors.New("memberId has a character other than A-Z, a-z, 0-9, - _ . :")
		}
	}

	return nil
}

// memberSessionsLocked counts the member's sessions, not those already closing: member.close's, which may take 500 ms
// to flush, mustn't refuse the fresh session a role change brings. Call with l.mu held. A linear scan: at most 600,
// once per create.
func (l *link) memberSessionsLocked(memberID string) int {
	n := 0
	for _, s := range l.sessions {
		if s.memberID == memberID && !s.leaving.Load() && !s.closing.Load() {
			n++
		}
	}

	return n
}

// guildCredit is deskd's credit toward desk-rtc per channel on a Guild Desk: what configure asks for, from 64 to 256
// KiB, or the 256 KiB every desk starts with.
func guildCredit(asked int) int {
	if asked < minGuildCredit || asked > maxGuildCredit {
		return rtcsock.InitialCredit
	}

	return asked
}

// setGuild makes s a Guild Desk session of a member's, before it starts: its budget, deskd's credit toward it, and
// the most it sends deskd ahead of grants.
func (s *session) setGuild(memberID string, credit int) {
	s.guild, s.memberID = true, memberID
	s.tx.useBudget(s.link.srv.budget, int64(credit))
	for _, g := range s.rx {
		g.n = guildRxCredit
	}
}

// stopMedia answers every audio and video section inactive, with no track: a Guild Desk sends no media, and keeping
// the sections (rather than rejecting them) keeps the BUNDLE tag the first one carries. Call it between
// SetRemoteDescription and CreateAnswer, as addTracks.
func stopMedia(pc *webrtc.PeerConnection) error {
	for _, t := range pc.GetTransceivers() {
		if err := t.Stop(); err != nil {
			return err
		}
	}

	return nil
}

// readBufferSize is a session's read buffer for a channel.
func (s *session) readBufferSize(channel uint8) int {
	switch {
	case !s.guild:
		return 64 * 1024
	case channel >= rtcsock.NumBridged:
		return guildDropBuffer
	default:
		return guildReadBuffer
	}
}

// memberTotal is one member's closed sessions' bytes.
type memberTotal struct {
	sent, received uint64
}

// addMemberTotalsLocked moves a closing session's bytes into its member's totals. Call with statsMu held for writing,
// in the same step as the session leaves its link's table (session.teardown), so a stats counts them once.
func (srv *Server) addMemberTotalsLocked(memberID string, sent, received uint64) {
	if memberID == "" {
		return
	}
	t := srv.memberTotals[memberID]
	if t == nil {
		t = &memberTotal{}
		srv.memberTotals[memberID] = t
	}
	t.sent += sent
	t.received += received
}

// memberStats is the stats reply's members table: each member's closed sessions' bytes plus their live sessions' bytes
// from rows, sorted by memberId. Call with statsMu held for reading, as rows were read under it. A member stays in it
// for the life of the process, closed and removed members too, so a count never goes down while desk-rtc runs.
func (srv *Server) memberStats(rows []rtcsock.SessionStats) []rtcsock.MemberStats {
	by := map[string]*rtcsock.MemberStats{}
	get := func(id string) *rtcsock.MemberStats {
		m := by[id]
		if m == nil {
			m = &rtcsock.MemberStats{MemberID: id}
			by[id] = m
		}

		return m
	}
	for id, t := range srv.memberTotals {
		m := get(id)
		m.BytesSent += t.sent
		m.BytesReceived += t.received
	}
	for _, r := range rows {
		if r.MemberID == "" {
			continue
		}
		m := get(r.MemberID)
		m.Sessions++
		m.BytesSent += r.BytesSent
		m.BytesReceived += r.BytesReceived
	}
	out := make([]rtcsock.MemberStats, 0, len(by))
	for _, m := range by {
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MemberID < out[j].MemberID })

	return out
}

// handleMemberClose ends every session of one member at once: their removal from the guild, or a change of their role
// or grants, after which the client comes back with a fresh token. Each session gets its session.closed, with deskd's
// reason, and member.closed {memberId, sessionIds} follows the last of them. The sessions are those in the table when
// the message is read: a session.create deskd sends after it is a new session, and stays.
func (l *link) handleMemberClose(m *rtcsock.Message) {
	if m.MemberID == "" {
		l.sendJSON(&rtcsock.Message{T: "error", Code: "bad_request", Message: "member.close needs a memberId"})

		return
	}
	reason := m.Reason
	if reason == "" {
		reason = reasonMemberClosed
	}
	l.mu.RLock()
	var mine []*session
	for _, s := range l.sessions {
		if s.memberID == m.MemberID {
			mine = append(mine, s)
		}
	}
	l.mu.RUnlock()
	// At once, before the flush: nothing more of theirs reaches deskd, and they no longer count toward the member's
	// limit, so a role change's fresh session isn't refused while these flush.
	for _, s := range mine {
		s.leaving.Store(true)
		for _, g := range s.rx {
			g.close()
		}
	}
	ids := make([]string, 0, len(mine))
	for _, s := range mine {
		ids = append(ids, s.id)
	}
	sort.Strings(ids)
	l.srv.log.Info("closing a member's sessions", "member", m.MemberID, "sessions", len(mine), "reason", reason)

	// Not on the read loop. Each close flushes ctl for at most closeFlushWait, as session.close does, so a CLOSE frame
	// deskd queued first still reaches the client; all of them at once, so a member with four sessions waits no longer.
	go func() {
		var wg sync.WaitGroup
		for _, s := range mine {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s.close(reason, true)
			}()
		}
		wg.Wait()
		l.sendJSON(&rtcsock.Message{T: msgMemberClosed, MemberID: m.MemberID, SessionIDs: ids})
	}()
}

// sctpWatch is a Guild Desk session's Pion logger factory: srv.pionLogs, except that SCTP's "protocol violation"
// warning, which is how pion/sctp says it aborted the association (past guildReassemblyEntries, among others), marks
// the session, so it closes with protocol_error rather than client_closed.
type sctpWatch struct {
	logging.LoggerFactory
	s *session
}

func (w sctpWatch) NewLogger(scope string) logging.LeveledLogger {
	l := w.LoggerFactory.NewLogger(scope)
	if scope != "sctp" {
		return l
	}

	return sctpWatchLogger{LeveledLogger: l, s: w.s}
}

type sctpWatchLogger struct {
	logging.LeveledLogger
	s *session
}

func (l sctpWatchLogger) Warnf(format string, args ...any) {
	if strings.Contains(format, "protocol violation") {
		l.s.violated.Store(true)
	}
	l.LeveledLogger.Warnf(format, args...)
}

// closedRow is one closed Guild Desk session's final row in stats, kept until deskd acks it.
type closedRow struct {
	row rtcsock.SessionStats
	at  time.Time
}

// closedRow is s's final row: its last bytes, marked closed.
func (s *session) closedRow(sent, received uint64) rtcsock.SessionStats {
	return rtcsock.SessionStats{
		SessionID: s.id, Transport: strings.TrimSpace(s.lastTransportValue()), BytesSent: sent, BytesReceived: received,
		InputDropped: s.inputDropped.Load(), KeysDropped: s.keysDropped.Load(), MemberID: s.memberID, Closed: true,
	}
}

// keepClosedLocked keeps a closed session's final row for deskd: the session.closed that carries the same numbers can
// be lost with the link (rtc_link_lost), and a stats after a reconnect still has it. At most guildClosedKeep rows, the
// oldest dropped first and counted. Call with statsMu held for writing.
func (srv *Server) keepClosedLocked(row rtcsock.SessionStats) {
	srv.expireClosedLocked(time.Now())
	if len(srv.closed) >= guildClosedKeep {
		srv.closed[0] = nil
		srv.closed = srv.closed[1:]
		srv.closedDropped.Add(1)
	}
	srv.closed = append(srv.closed, &closedRow{row: row, at: time.Now()})
}

// updateClosedLocked sets a kept row's bytes, for a session whose setup finished while it was torn down.
func (srv *Server) updateClosedLocked(id string, sent, received uint64) {
	for _, c := range srv.closed {
		if c.row.SessionID == id {
			c.row.BytesSent, c.row.BytesReceived = sent, received
		}
	}
}

// expireClosedLocked drops rows deskd never acked within guildClosedTTL: a deskd that doesn't read them.
func (srv *Server) expireClosedLocked(now time.Time) {
	i := 0
	for i < len(srv.closed) && now.Sub(srv.closed[i].at) > guildClosedTTL {
		i++
	}
	if i > 0 {
		srv.closedDropped.Add(uint64(i))
		clear(srv.closed[:i])
		srv.closed = srv.closed[i:]
	}
}

// ackClosedLocked forgets the rows deskd has recorded.
func (srv *Server) ackClosedLocked(ids []string) {
	if len(ids) == 0 || len(srv.closed) == 0 {
		return
	}
	acked := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		acked[id] = struct{}{}
	}
	kept := srv.closed[:0]
	for _, c := range srv.closed {
		if _, ok := acked[c.row.SessionID]; !ok {
			kept = append(kept, c)
		}
	}
	clear(srv.closed[len(kept):])
	srv.closed = kept
}

// closedRowsLocked is every kept row, for a stats reply.
func (srv *Server) closedRowsLocked() []rtcsock.SessionStats {
	srv.expireClosedLocked(time.Now())
	out := make([]rtcsock.SessionStats, 0, len(srv.closed))
	for _, c := range srv.closed {
		out = append(out, c.row)
	}

	return out
}

// closedRowFor is a kept row's bytes, for a session.close of a session that's already gone.
func (srv *Server) closedRowFor(id string) (rtcsock.SessionStats, bool) {
	srv.statsMu.RLock()
	defer srv.statsMu.RUnlock()
	for _, c := range srv.closed {
		if c.row.SessionID == id {
			return c.row, true
		}
	}

	return rtcsock.SessionStats{}, false
}

// shedTx is the budget's last resort (budget.go): while the desk's deskd-to-client bytes are past txMax, the session
// holding the most stops being charged and closes, over_budget. Frames already queued for it go with it.
func (l *link) shedTx() {
	b := l.srv.budget
	for b.overMax() {
		var victim *session
		var most int64
		l.mu.RLock()
		for _, s := range l.sessions {
			if n := s.tx.charged.Load(); s.guild && n > most {
				victim, most = s, n
			}
		}
		l.mu.RUnlock()
		if victim == nil || !victim.tx.dropBudget() {
			return
		}
		b.shed.Add(1)
		l.srv.log.Warn("closing the session holding the most of the Guild Desk's budget", "session", victim.id,
			"member", victim.memberID, "bytes", most)
		go victim.close(reasonOverBudget, false)
	}
}

// budgetStats is the budget's line in a Guild Desk's stats. Call with statsMu held.
func (srv *Server) budgetStats() *rtcsock.BudgetStats {
	b := srv.budget
	rx, tx := b.usage()
	rxPeak, txPeak := b.peaks()

	return &rtcsock.BudgetStats{
		RxBytes: rx, RxMax: b.rxMax, RxPeak: rxPeak, TxBytes: tx, TxSoft: b.txSoft, TxMax: b.txMax, TxPeak: txPeak,
		RxWaits: b.rxWaits.Load(), TxWithheld: b.txWithheld.Load(), Shed: b.shed.Load(),
		ClosedKept: len(srv.closed), ClosedDropped: srv.closedDropped.Load(),
	}
}

// statsPartBudget is how much of an envelope a stats part's rows may take: the 64 KiB limit less room for the
// message's other fields and the JSON around the rows.
const statsPartBudget = rtcsock.MaxEnvelope - 4*1024

// sendGuildStats sends a Guild Desk's stats as parts that each fit an envelope: 600 sessions' rows and 200 members'
// are about 100 KB, and one envelope is 64 KiB. Every part has part (0, 1, …) and last; part 0 has the totals and
// stream, and every part a run of the sessions and then of the members, in order, so deskd joins the lists until
// last. Its rows are one snapshot, read under statsMu, and statsSend keeps two replies' parts from mixing. A
// desk that isn't a Guild Desk has four sessions at most, and its stats stay one message with neither field.
func (l *link) sendGuildStats(reply *rtcsock.Message) {
	sessions, members := reply.Sessions, reply.Members
	var parts []*rtcsock.Message
	cur := &rtcsock.Message{
		T: reply.T, PeerBytesSent: reply.PeerBytesSent, BytesSent: reply.BytesSent, BytesReceived: reply.BytesReceived,
		Stream: reply.Stream, VoiceRelay: reply.VoiceRelay, Budget: reply.Budget,
	}
	used := 0
	next := func() {
		parts = append(parts, cur)
		cur = &rtcsock.Message{T: reply.T}
		used = 0
	}
	for _, r := range sessions {
		n := jsonSize(r) + 1
		if used+n > statsPartBudget && used > 0 {
			next()
		}
		cur.Sessions = append(cur.Sessions, r)
		used += n
	}
	for _, m := range members {
		n := jsonSize(m) + 1
		if used+n > statsPartBudget && used > 0 {
			next()
		}
		cur.Members = append(cur.Members, m)
		used += n
	}
	parts = append(parts, cur)

	l.statsSend.Lock()
	defer l.statsSend.Unlock()
	for i, p := range parts {
		part, last := i, i == len(parts)-1
		p.Part, p.Last = &part, &last
		l.sendJSON(p)
	}
}

func jsonSize(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return statsPartBudget // can't happen for these rows; a part of its own if it did
	}

	return len(b)
}
