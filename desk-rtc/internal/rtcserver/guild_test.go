package rtcserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// configureGuild sends a Guild Desk's configure and returns configured.
func (d *fakeDeskd) configureGuild(maxSessions, perMember int) *rtcsock.Message {
	d.t.Helper()
	d.send(&rtcsock.Message{
		T: "configure", PublicIPv4: "127.0.0.1", MaxSessions: maxSessions,
		DeskKind: rtcsock.DeskKindGuild, MaxSessionsPerMember: perMember,
	})

	return d.expect("configured", "", 3*time.Second)
}

func guildCreate(id, member string, p *peer) *rtcsock.Message {
	m := createMsg(id, p)
	m.MemberID = member

	return m
}

// guildConnected creates a member's session and waits for its channels.
func guildConnected(t *testing.T, d *fakeDeskd, id, member string, opts peerOpts) (*peer, *rtcsock.Message) {
	t.Helper()
	p := newPeer(t, opts)
	d.send(guildCreate(id, member, p))
	ans := d.expect("session.answer", id, 5*time.Second)
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)

	return p, ans
}

func (d *fakeDeskd) stats() *rtcsock.Message {
	d.t.Helper()
	d.send(&rtcsock.Message{T: "stats.get"})

	return d.expect("stats", "", 3*time.Second)
}

func TestGuildModeIsChosenByConfigure(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()

	// A desk that isn't a Guild Desk: the reply is as it always was, and the limit stays 4.
	for _, kind := range []string{"", "personal", "work", "test", "Guild"} {
		d.send(&rtcsock.Message{T: "configure", PublicIPv4: "127.0.0.1", MaxSessions: 600, DeskKind: kind})
		m := d.expect("configured", "", 3*time.Second)
		if m.DeskKind != "" || m.MaxSessions != 0 || m.MaxSessionsPerMember != 0 {
			t.Fatalf("deskKind %q: configured %+v", kind, m)
		}
	}

	cases := []struct{ max, per, wantMax, wantPer int }{
		{0, 0, 600, 3},      // deskd says nothing: 200 members x 3, and 3 a member, as deskd, the gateway and GD-1 count
		{600, 3, 600, 3},    // what deskd sends for 200 members
		{90, 0, 90, 3},      // 30 members x 3
		{601, 0, 600, 3},    // never past the ceiling
		{100000, 9, 600, 9}, // nor far past it
		{3, 9, 3, 3},        // a member can't have more than the desk
		{-1, -1, 600, 3},
	}
	for _, c := range cases {
		m := d.configureGuild(c.max, c.per)
		if m.DeskKind != rtcsock.DeskKindGuild || m.MaxSessions != c.wantMax || m.MaxSessionsPerMember != c.wantPer {
			t.Fatalf("configure %d/%d: got %q %d/%d, want guild %d/%d", c.max, c.per, m.DeskKind, m.MaxSessions, m.MaxSessionsPerMember, c.wantMax, c.wantPer)
		}
		if len(m.FingerprintsSha256) != 1 || m.FingerprintsSha256[0] != f.srv.Fingerprint() {
			t.Fatalf("fingerprints %v", m.FingerprintsSha256)
		}
		if m.Credit != rtcsock.InitialCredit {
			t.Fatalf("credit %d with none asked", m.Credit)
		}
	}
}

func TestGuildCeilingIsAServerSetting(t *testing.T) {
	f := startServerWith(t, 30*time.Second, func(c *Config) { c.GuildMaxSessions = 2 })
	d := f.deskd()
	if m := d.configureGuild(600, 0); m.MaxSessions != 2 || m.MaxSessionsPerMember != 2 {
		t.Fatalf("configured %+v", m)
	}
	for i := 0; i < 2; i++ {
		id := fmt.Sprintf("cs-%d", i)
		d.send(guildCreate(id, fmt.Sprintf("gm-%d", i), newPeer(t, peerOpts{dataOnly: true})))
		d.expect("session.answer", id, 5*time.Second)
	}
	d.send(guildCreate("cs-x", "gm-x", newPeer(t, peerOpts{dataOnly: true})))
	if m := d.expect("session.error", "cs-x", 3*time.Second); m.CodeString() != rtcsock.CodeSessionLimitReached {
		t.Fatalf("code %v", m.Code)
	}
}

func TestGuildSessionNeedsAGoodMemberID(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	p := newPeer(t, peerOpts{dataOnly: true})
	for i, bad := range []string{"", "gm one", "gm-\n", `gm-"x"`, "gm-é", strings.Repeat("a", 129)} {
		id := fmt.Sprintf("cs-bad%d", i)
		d.send(guildCreate(id, bad, p))
		if m := d.expect("session.error", id, 3*time.Second); m.CodeString() != rtcsock.CodeBadOffer || !strings.Contains(m.Message, "memberId") {
			t.Fatalf("memberId %q: %+v", bad, m)
		}
	}
	for i, good := range []string{"gm-c2d3f6h2j5k7", "a", strings.Repeat("Z", 128), "gm_1.2:3"} {
		id := fmt.Sprintf("cs-good%d", i)
		d.send(guildCreate(id, good, newPeer(t, peerOpts{dataOnly: true})))
		d.expect("session.answer", id, 5*time.Second)
	}
}

func TestGuildLimitsPerDeskAndPerMember(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(5, 2)
	create := func(id, member string) *rtcsock.Message {
		d.send(guildCreate(id, member, newPeer(t, peerOpts{dataOnly: true})))
		deadline := time.After(5 * time.Second)
		for {
			select {
			case m := <-d.msgs:
				if m.SessionID == id && (m.T == "session.answer" || m.T == "session.error") {
					return m
				}
			case <-deadline:
				t.Fatalf("no answer or error for %s", id)
			}
		}
	}
	for _, c := range []struct{ id, member, want string }{
		{"cs-a1", "gm-a", "session.answer"},
		{"cs-a2", "gm-a", "session.answer"},
		{"cs-a3", "gm-a", "session.error"}, // gm-a has its 2
		{"cs-b1", "gm-b", "session.answer"},
		{"cs-b2", "gm-b", "session.answer"},
		{"cs-c1", "gm-c", "session.answer"},
		{"cs-d1", "gm-d", "session.error"}, // the desk has its 5
	} {
		m := create(c.id, c.member)
		if m.T != c.want {
			t.Fatalf("%s for %s: got %+v, want %s", c.id, c.member, m, c.want)
		}
		if m.T == "session.error" && m.CodeString() != rtcsock.CodeSessionLimitReached {
			t.Fatalf("%s: code %v", c.id, m.Code)
		}
	}
	// A closed session frees its member's place.
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a1", Reason: "closed_by_client"})
	d.expect("session.closed", "cs-a1", 5*time.Second)
	if m := create("cs-a3", "gm-a"); m.T != "session.answer" {
		t.Fatalf("after a close: %+v", m)
	}
}

func TestGuildAnswerOffersNoMedia(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)

	// The Desk app's own offer, audio and video included: answered inactive, with no track.
	p, ans := guildConnected(t, d, "cs-av", "gm-a", peerOpts{})
	sections := sectionsOf(ans.Answer)
	if len(sections) != 4 {
		t.Fatalf("want session, audio, video, data:\n%s", ans.Answer)
	}
	if !strings.Contains(sections[0], "a=group:BUNDLE 0 1 2") {
		t.Errorf("BUNDLE:\n%s", sections[0])
	}
	for i, name := range []string{"audio", "video"} {
		s := sections[i+1]
		if !strings.Contains(s, "a=inactive") || strings.Contains(s, "a=msid") || strings.Contains(s, "a=ssrc") {
			t.Errorf("%s isn't inactive with no track:\n%s", name, s)
		}
	}

	// A data-only offer: one section, and the bridge works on every channel deskd has.
	p2, ans2 := guildConnected(t, d, "cs-data", "gm-b", peerOpts{dataOnly: true})
	if got := sectionsOf(ans2.Answer); len(got) != 2 || !strings.HasPrefix(got[1], "m=application") {
		t.Fatalf("data-only answer:\n%s", ans2.Answer)
	}
	for _, ch := range []uint8{rtcsock.ChCtl, rtcsock.ChRPC, rtcsock.ChCollab, rtcsock.ChMdoc, rtcsock.ChBulk} {
		out := frame.Encode(frame.Req, 0, uint32(ch), 0, []byte("to the guild"))
		if err := p2.channels[ch].Send(out); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-d.frames:
			if got.handle != ans2.Handle || got.channel != ch || string(got.frame) != string(out) {
				t.Fatalf("channel %d: got %+v", ch, got)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("channel %d: nothing reached deskd", ch)
		}
	}
	for _, ch := range []uint8{rtcsock.ChCtl, rtcsock.ChEvents, rtcsock.ChMdoc} {
		out := frame.Encode(frame.Evt, 0, uint32(ch), 0, []byte("from the guild"))
		if err := d.c.SendData(context.Background(), ans2.Handle, ch, out); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-p2.recv:
			if got.channel != ch || string(got.frame) != string(out) {
				t.Fatalf("channel %d: got %+v", ch, got)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("channel %d: nothing reached the client", ch)
		}
	}
	// An ICE restart keeps both sections inactive, and adds no track.
	restart, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.pc.SetLocalDescription(restart); err != nil {
		t.Fatal(err)
	}
	d.send(&rtcsock.Message{T: "session.ice_restart", SessionID: "cs-av", Offer: restart.SDP})
	again := d.expect("session.answer", "cs-av", 5*time.Second)
	for i, s := range sectionsOf(again.Answer)[1:3] {
		if !strings.Contains(s, "a=inactive") || strings.Contains(s, "a=msid") {
			t.Errorf("section %d after the restart:\n%s", i+1, s)
		}
	}
	p.answer(again.Answer)
}

func TestGuildSessionsNeverViewNorInject(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	p, _ := guildConnected(t, d, "cs-a", "gm-a", peerOpts{})
	on := true
	d.send(&rtcsock.Message{T: "session.permissions", SessionID: "cs-a", Video: &on, Input: &on})
	d.send(&rtcsock.Message{T: "session.video", SessionID: "cs-a", View: &on})
	// input and keys are read and dropped: what the client sends there goes nowhere.
	_ = p.channels[rtcsock.ChKeys].Send(make([]byte, 16))
	_ = p.channels[rtcsock.ChInput].Send(make([]byte, 12))
	time.Sleep(300 * time.Millisecond)
	m := d.stats()
	if len(m.Sessions) != 1 || m.Sessions[0].Viewing || m.Sessions[0].KeysDropped != 1 || m.Sessions[0].InputDropped != 1 {
		t.Fatalf("sessions %+v", m.Sessions)
	}
	if m.Stream == nil || m.Stream.Viewers != 0 {
		t.Fatalf("stream %+v", m.Stream)
	}
	select {
	case got := <-d.frames:
		t.Fatalf("a frame reached deskd: %+v", got)
	default:
	}
}

func TestGuildCountsBytesPerMember(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	pa1, a1 := guildConnected(t, d, "cs-a1", "gm-a", peerOpts{dataOnly: true})
	_, a2 := guildConnected(t, d, "cs-a2", "gm-a", peerOpts{dataOnly: true})
	pb, b1 := guildConnected(t, d, "cs-b1", "gm-b", peerOpts{dataOnly: true})

	// gm-a gets 40 KiB down on one session and sends 8 KiB up; gm-b gets 4 KiB.
	send := func(handle uint32, n int) {
		for i := 0; i < n; i++ {
			out := frame.Encode(frame.Data, 0, 1, uint32(i), make([]byte, 4096-frame.HeaderSize))
			if err := d.c.SendData(context.Background(), handle, rtcsock.ChBulk, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	send(a1.Handle, 10)
	send(b1.Handle, 1)
	for i := 0; i < 2; i++ {
		if err := pa1.channels[rtcsock.ChCollab].Send(make([]byte, 4096)); err != nil {
			t.Fatal(err)
		}
	}
	waitFor := func(what string, cond func(*rtcsock.Message) bool) *rtcsock.Message {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			m := d.stats()
			if cond(m) {
				return m
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: last stats %+v", what, m)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	member := func(m *rtcsock.Message, id string) rtcsock.MemberStats {
		for _, r := range m.Members {
			if r.MemberID == id {
				return r
			}
		}

		return rtcsock.MemberStats{}
	}
	m := waitFor("bytes counted", func(m *rtcsock.Message) bool {
		return member(m, "gm-a").BytesSent > 40*1024 && member(m, "gm-a").BytesReceived > 8*1024 && member(m, "gm-b").BytesSent > 4*1024
	})
	if len(m.Members) != 2 || m.Members[0].MemberID != "gm-a" || m.Members[1].MemberID != "gm-b" {
		t.Fatalf("members %+v", m.Members)
	}
	if a, b := member(m, "gm-a"), member(m, "gm-b"); a.Sessions != 2 || b.Sessions != 1 || b.BytesSent >= a.BytesSent {
		t.Fatalf("gm-a %+v, gm-b %+v", a, b)
	}
	// The members table adds up to the sessions, and every row names its member.
	var sum, rows uint64
	for _, r := range m.Members {
		sum += r.BytesSent
	}
	for _, s := range m.Sessions {
		if s.MemberID == "" {
			t.Fatalf("row without a member: %+v", s)
		}
		rows += s.BytesSent
	}
	if sum != rows || *m.BytesSent != rows {
		t.Fatalf("members %d, sessions %d, desk %d", sum, rows, *m.BytesSent)
	}

	// A closed session's bytes stay with its member, and nothing ever goes down.
	before := member(m, "gm-a")
	d.send(&rtcsock.Message{T: "session.close", SessionID: a1.SessionID, Reason: "closed_by_client"})
	d.expect("session.closed", a1.SessionID, 5*time.Second)
	m = d.stats()
	after := member(m, "gm-a")
	if after.Sessions != 1 || after.BytesSent < before.BytesSent || after.BytesReceived < before.BytesReceived {
		t.Fatalf("before %+v, after %+v", before, after)
	}
	_, _ = a2, pb
}

func TestMemberCloseEndsEveryOneOfTheirSessions(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	pa1, a1 := guildConnected(t, d, "cs-a1", "gm-a", peerOpts{dataOnly: true})
	guildConnected(t, d, "cs-a2", "gm-a", peerOpts{dataOnly: true})
	pb, b1 := guildConnected(t, d, "cs-b1", "gm-b", peerOpts{dataOnly: true})

	// deskd tells the member why on ctl first; it reaches them before the close.
	closeFrame := frame.Encode(frame.Close, 0, 0, 0, []byte(`{"code":4403,"reason":"guild_removed"}`))
	if err := d.c.SendData(context.Background(), a1.Handle, rtcsock.ChCtl, closeFrame); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	d.send(&rtcsock.Message{T: "member.close", MemberID: "gm-a", Reason: "guild_removed"})
	closed := map[string]string{}
	var done *rtcsock.Message
	deadline := time.After(5 * time.Second)
	for done == nil {
		select {
		case m := <-d.msgs:
			switch m.T {
			case "session.closed":
				closed[m.SessionID] = m.Reason
			case "member.closed":
				done = m
			}
		case <-deadline:
			t.Fatalf("no member.closed; closed %v", closed)
		}
	}
	t.Logf("member.closed after %v", time.Since(start))
	if len(closed) != 2 || closed["cs-a1"] != "guild_removed" || closed["cs-a2"] != "guild_removed" {
		t.Fatalf("closed %v", closed)
	}
	if done.MemberID != "gm-a" || strings.Join(done.SessionIDs, ",") != "cs-a1,cs-a2" {
		t.Fatalf("member.closed %+v", done)
	}
	select {
	case got := <-pa1.recv:
		if string(got.frame) != string(closeFrame) {
			t.Fatalf("got %q", got.frame)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CLOSE didn't reach the member")
	}

	// The other member carries on.
	out := frame.Encode(frame.Evt, 0, 0, 0, []byte("still here"))
	if err := d.c.SendData(context.Background(), b1.Handle, rtcsock.ChEvents, out); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-pb.recv:
		if string(got.frame) != string(out) {
			t.Fatalf("got %q", got.frame)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("gm-b lost its session")
	}
	m := d.stats()
	if live := liveRows(m); len(live) != 1 || live[0].SessionID != "cs-b1" {
		t.Fatalf("sessions %+v", m.Sessions)
	}
	// gm-a's closed sessions stay as final rows until deskd acks them (the review's M2).
	if len(m.Sessions) != 3 {
		t.Fatalf("sessions %+v", m.Sessions)
	}
	// gm-a keeps its bytes, for the heartbeat that bills them, with no session.
	if len(m.Members) != 2 || m.Members[0].MemberID != "gm-a" || m.Members[0].Sessions != 0 || m.Members[0].BytesSent == 0 {
		t.Fatalf("members %+v", m.Members)
	}

	// Back with a fresh token: a new session for the same member is fine.
	guildConnected(t, d, "cs-a3", "gm-a", peerOpts{dataOnly: true})

	// A member with no sessions: member.closed at once, with none. No memberId: an error, and the link stays.
	d.send(&rtcsock.Message{T: "member.close", MemberID: "gm-nobody"})
	if m := d.expect("member.closed", "", 3*time.Second); m.MemberID != "gm-nobody" || len(m.SessionIDs) != 0 {
		t.Fatalf("member.closed %+v", m)
	}
	d.send(&rtcsock.Message{T: "member.close"})
	if m := d.expect("error", "", 3*time.Second); m.CodeString() != "bad_request" {
		t.Fatalf("error %+v", m)
	}
	if m := d.stats(); len(liveRows(m)) != 2 {
		t.Fatalf("sessions %+v", m.Sessions)
	}
}

// liveRows is a stats reply's rows for sessions still open.
func liveRows(m *rtcsock.Message) []rtcsock.SessionStats {
	var out []rtcsock.SessionStats
	for _, r := range m.Sessions {
		if !r.Closed {
			out = append(out, r)
		}
	}

	return out
}

func TestMemberCloseWithNoReasonSaysMemberClosed(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	p := newPeer(t, peerOpts{dataOnly: true})
	d.send(guildCreate("cs-a", "gm-a", p))
	d.expect("session.answer", "cs-a", 5*time.Second) // no client yet: a session still being set up closes too
	d.send(&rtcsock.Message{T: "member.close", MemberID: "gm-a"})
	if m := d.expect("session.closed", "cs-a", 5*time.Second); m.Reason != reasonMemberClosed {
		t.Fatalf("reason %q", m.Reason)
	}
	d.expect("member.closed", "", 5*time.Second)
}

// A desk that isn't a Guild Desk: a memberId changes nothing, there's no members table, and member.close is ignored, as
// it was before guild mode (the review's L1).
func TestOtherDesksIgnoreGuildFields(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.send(&rtcsock.Message{T: "configure", PublicIPv4: "127.0.0.1", MaxSessions: 600, MaxSessionsPerMember: 1})
	if m := d.expect("configured", "", 3*time.Second); m.DeskKind != "" || m.MaxSessions != 0 {
		t.Fatalf("configured %+v", m)
	}
	p, ans := connected(t, d, "cs-a")
	d.send(guildCreate("cs-b", "gm-a", newPeer(t, peerOpts{})))
	ansB := d.expect("session.answer", "cs-b", 5*time.Second)
	// Media as before: audio and video sendonly with the desk's tracks.
	for _, a := range []string{ans.Answer, ansB.Answer} {
		if !strings.Contains(a, "a=msid:desk-audio audio") {
			t.Fatalf("answer:\n%s", a)
		}
	}
	m := d.stats()
	if len(m.Members) != 0 {
		t.Fatalf("members %+v", m.Members)
	}
	for _, s := range m.Sessions {
		if s.MemberID != "" {
			t.Fatalf("row %+v", s)
		}
	}
	d.send(&rtcsock.Message{T: "member.close", MemberID: "gm-a"})
	d.send(&rtcsock.Message{T: "member.close"})
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-gone"})
	for {
		m := d.expect("", "", 3*time.Second)
		if m.T == "member.closed" || m.T == "error" {
			t.Fatalf("a reply to member.close on a desk that isn't a Guild Desk: %+v", m)
		}
		if m.T == "session.closed" && m.SessionID == "cs-gone" {
			if m.BytesSent != nil || m.MemberID != "" {
				t.Fatalf("session.closed %+v", m)
			}

			break
		}
	}
	if m := d.stats(); len(m.Sessions) != 2 || m.Budget != nil || m.VoiceRelay != nil || m.Part != nil {
		t.Fatalf("stats %+v", m)
	}
	// Still four at most.
	for i := 0; i < 2; i++ {
		id := fmt.Sprintf("cs-%d", i)
		d.send(createMsg(id, newPeer(t, peerOpts{})))
		d.expect("session.answer", id, 5*time.Second)
	}
	d.send(createMsg("cs-5th", newPeer(t, peerOpts{})))
	if m := d.expect("session.error", "cs-5th", 3*time.Second); m.CodeString() != rtcsock.CodeSessionLimitReached {
		t.Fatalf("code %v", m.Code)
	}
	_ = p
}

// The mode lasts as long as the deskd connection that set it, as stream.limit does.
func TestANewConnectionStartsAsAnOrdinaryDesk(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d1 := f.deskd()
	d1.configureGuild(0, 0)
	d1.send(guildCreate("cs-a", "gm-a", newPeer(t, peerOpts{dataOnly: true})))
	d1.expect("session.answer", "cs-a", 5*time.Second)
	_ = d1.stats()

	d2 := f.deskd()
	d2.send(&rtcsock.Message{T: "configure", PublicIPv4: "127.0.0.1"})
	if m := d2.expect("configured", "", 3*time.Second); m.DeskKind != "" {
		t.Fatalf("configured %+v", m)
	}
	d2.send(createMsg("cs-b", newPeer(t, peerOpts{})))
	ans := d2.expect("session.answer", "cs-b", 5*time.Second)
	if !strings.Contains(ans.Answer, "a=msid:desk-audio audio") {
		t.Fatalf("answer:\n%s", ans.Answer)
	}
	if m := d2.stats(); len(m.Members) != 0 {
		t.Fatalf("members %+v", m.Members)
	}
}

// 600 sessions' rows and 200 members' are more than one envelope: the reply comes in parts that each fit, and join to
// exactly what was read, with the totals in part 0 (found at 600 by test/guildscale, where the one big reply failed).
func TestGuildStatsComeInPartsThatFit(t *testing.T) {
	srv := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	l := newLink(srv, nil)
	sent, recv, peer := uint64(9e9), uint64(8e8), uint64(0)
	in := &rtcsock.Message{T: "stats", BytesSent: &sent, BytesReceived: &recv, PeerBytesSent: &peer, Stream: &rtcsock.StreamStats{State: "down"}}
	for i := 0; i < 600; i++ {
		in.Sessions = append(in.Sessions, rtcsock.SessionStats{
			SessionID: fmt.Sprintf("cs-%016d", i), Transport: "udp", RTTMs: 123.456789, BytesSent: 1 << 40, BytesReceived: 1 << 39,
			MemberID: fmt.Sprintf("gm-%012d", i/3),
		})
	}
	for i := 0; i < 200; i++ {
		in.Members = append(in.Members, rtcsock.MemberStats{MemberID: fmt.Sprintf("gm-%012d", i), Sessions: 3, BytesSent: 3 << 40, BytesReceived: 3 << 39})
	}
	if b, err := json.Marshal(in); err != nil || len(b) < rtcsock.MaxEnvelope {
		t.Fatalf("the test's reply should be over one envelope: %d bytes", len(b))
	}
	go l.sendGuildStats(in)

	var sessions []rtcsock.SessionStats
	var members []rtcsock.MemberStats
	for want := 0; ; want++ {
		b, ok := l.out.next()
		if !ok {
			t.Fatal("queue closed")
		}
		if len(b)-4 > rtcsock.MaxEnvelope {
			t.Fatalf("part %d is %d bytes", want, len(b)-4)
		}
		typ, body, err := rtcsock.ReadEnvelope(bufio.NewReader(bytes.NewReader(b)))
		if err != nil || typ != rtcsock.TypeJSON {
			t.Fatalf("part %d: %v", want, err)
		}
		var m rtcsock.Message
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		if m.T != "stats" || m.Part == nil || *m.Part != want || m.Last == nil {
			t.Fatalf("part %d: %+v", want, m)
		}
		if (want == 0) != (m.BytesSent != nil) || (want == 0) != (m.Stream != nil) {
			t.Fatalf("part %d: totals belong in part 0 only", want)
		}
		sessions = append(sessions, m.Sessions...)
		members = append(members, m.Members...)
		if *m.Last {
			t.Logf("%d parts", want+1)
			if want == 0 {
				t.Fatal("want more than one part")
			}

			break
		}
	}
	if !reflect.DeepEqual(sessions, in.Sessions) || !reflect.DeepEqual(members, in.Members) {
		t.Fatalf("joined %d sessions and %d members, want 600 and 200", len(sessions), len(members))
	}
}
