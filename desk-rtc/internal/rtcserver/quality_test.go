package rtcserver

import (
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/datachannel"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// quality builds a client's QUALITY event.
func quality(l level) []byte {
	b := make([]byte, 16)
	b[0], b[1] = qualityAsk, byte(l)

	return b
}

// reply is the 0x82 a session should get.
func reply(l, limit level, flags byte) []byte {
	b := make([]byte, 16)
	b[0], b[1], b[3], b[4] = qualityReply, byte(l), flags, byte(limit)

	return b
}

func str(s string) *string { return &s }

// newQualityHub is a hub with no socket and no desk-stream, on a Server with only what it needs.
func newQualityHub(t *testing.T) *streamHub {
	t.Helper()
	srv := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	srv.hub = newStreamHub(srv)
	t.Cleanup(srv.hub.close)

	return srv.hub
}

// keysSink stands in for a session's keys channel, and keeps what's written to it.
type keysSink struct {
	mu   sync.Mutex
	msgs [][]byte
}

func (k *keysSink) Read([]byte) (int, error)                       { return 0, io.EOF }
func (k *keysSink) ReadDataChannel([]byte) (int, bool, error)      { return 0, false, io.EOF }
func (k *keysSink) WriteDataChannel(b []byte, _ bool) (int, error) { return k.Write(b) }
func (k *keysSink) Close() error                                   { return nil }
func (k *keysSink) Write(b []byte) (int, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.msgs = append(k.msgs, append([]byte(nil), b...))

	return len(b), nil
}

// take returns what was written since the last take.
func (k *keysSink) take() [][]byte {
	k.mu.Lock()
	defer k.mu.Unlock()
	m := k.msgs
	k.msgs = nil

	return m
}

// expect checks that exactly these messages were written since the last take.
func (k *keysSink) expect(t *testing.T, what string, want ...[]byte) {
	t.Helper()
	got := k.take()
	if len(got) != len(want) {
		t.Fatalf("%s: %d replies %x, want %x", what, len(got), got, want)
	}
	for i := range got {
		if string(got[i]) != string(want[i]) {
			t.Fatalf("%s: reply %x, want %x", what, got[i], want[i])
		}
	}
}

// newQualitySession is a session with nothing but a link to h's server and, if open, a keys channel.
func newQualitySession(t *testing.T, h *streamHub, id string, open bool) (*session, *keysSink) {
	t.Helper()
	l := &link{srv: h.srv, out: newOutQueue()}
	s := &session{id: id, link: l, log: h.log}
	s.permVideo.Store(true)
	k := &keysSink{}
	if open {
		var rwc datachannel.ReadWriteCloser = k
		s.keysOut.Store(&rwc)
	}
	t.Cleanup(func() { h.setViewer(s, false) }) // stops its viewer goroutine

	return s, k
}

func levelOf(h *streamHub) level {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.q.level
}

// attachStream gives h a fake desk-stream, on a real Unix socket since attach wants one.
func attachStream(t *testing.T, h *streamHub) *fakeStream {
	t.Helper()
	path := filepath.Join(shortDir(t), "s")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := ln.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sc.Close() })
	fs := watchStream(t, c)
	h.attach(sc)

	return fs
}

// nextCmd is the next command line, whatever it is. It fails the test if none comes within wait.
func (s *fakeStream) nextCmd(wait time.Duration) string {
	s.t.Helper()
	select {
	case got, ok := <-s.cmds:
		if !ok {
			s.t.Fatal("desk-stream connection closed")
		}

		return got
	case <-time.After(wait):
		s.t.Fatalf("no command within %v", wait)
	}

	return ""
}

func (s *fakeStream) noCmd(wait time.Duration) {
	s.t.Helper()
	select {
	case got, ok := <-s.cmds:
		if ok {
			s.t.Fatalf("unexpected command %q", got)
		}
	case <-time.After(wait):
	}
}

func TestParseQuality(t *testing.T) {
	withSeq := quality(levelMax)
	withSeq[3], withSeq[4], withSeq[7], withSeq[15] = 9, 0xff, 1, 7 // ignored, seq included
	for _, c := range []struct {
		name string
		b    []byte
		want level
		ok   bool
	}{
		{"low", quality(levelLow), levelLow, true},
		{"medium", quality(levelMedium), levelMedium, true},
		{"high", quality(levelHigh), levelHigh, true},
		{"max", quality(levelMax), levelMax, true},
		{"level 0 withdraws", quality(levelNone), levelNone, true},
		{"other bytes ignored", withSeq, levelMax, true},
		{"15 bytes", quality(levelLow)[:15], 0, false},
		{"17 bytes", append(quality(levelLow), 0), 0, false},
		{"level 5", quality(5), 0, false},
		{"level 255", quality(255), 0, false},
		{"stream 1", func() []byte { b := quality(levelLow); b[2] = 1; return b }(), 0, false},
		{"HOLD", func() []byte { b := quality(levelLow); b[0] = 6; return b }(), 0, false},
	} {
		got, ok := parseQuality(c.b)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %d, %v", c.name, got, ok)
		}
	}
	for l := levelLow; l <= levelMax; l++ {
		if got, ok := parseLevel(l.String()); !ok || got != l || *l.name() != l.String() {
			t.Errorf("level %d doesn't round-trip: %q", l, l.String())
		}
	}
	if _, ok := parseLevel("High"); ok {
		t.Error("names are lower case")
	}
	if levelNone.name() != nil || levelNone.String() != "" {
		t.Error("levelNone has a name")
	}
}

// onQuality takes every type 7 on keys and nothing else: a bad one counts as a dropped key event.
func TestOnQuality(t *testing.T) {
	h := newQualityHub(t)
	s, _ := newQualitySession(t, h, "cs-a", true)
	ask := func() *string { return h.askName(s) }
	if !s.onQuality(quality(levelLow)) || ask() == nil || *ask() != "low" || s.keysDropped.Load() != 0 {
		t.Fatalf("good QUALITY: ask %v, dropped %d", ask(), s.keysDropped.Load())
	}
	for _, bad := range [][]byte{quality(levelMax)[:8], quality(9), func() []byte { b := quality(levelMax); b[2] = 2; return b }()} {
		if !s.onQuality(bad) {
			t.Fatalf("%x wasn't taken", bad)
		}
	}
	if *ask() != "low" || s.keysDropped.Load() != 3 {
		t.Fatalf("bad QUALITY: ask %v, dropped %d", *ask(), s.keysDropped.Load())
	}
	for _, other := range [][]byte{nil, {}, make([]byte, 16), {6}, {8, 1}} {
		if s.onQuality(other) {
			t.Fatalf("%x was taken", other)
		}
	}
	if !s.onQuality(quality(levelNone)) || ask() != nil {
		t.Fatalf("level 0 didn't withdraw: %v", ask())
	}
}

// QUALITY goes nowhere near input: no permission, no activity, never on the input channel. HOLD still sets the
// session's playout-delay, and a type desk-rtc doesn't know is still a dropped key event.
func TestQualityIsNotInput(t *testing.T) {
	h := newQualityHub(t)
	s, _ := newQualitySession(t, h, "cs-a", true)
	s.videoOut = newForward(nil, videoClock, nil)
	queued := func() int {
		q := s.link.out
		q.mu.Lock()
		defer q.mu.Unlock()

		return len(q.ctrl)
	}

	s.onInput(rtcsock.ChKeys, quality(levelLow)) // no input permission
	if a := h.askName(s); a == nil || *a != "low" || s.keysDropped.Load() != 0 {
		t.Fatalf("QUALITY without input: ask %v, dropped %d", a, s.keysDropped.Load())
	}
	s.permInput.Store(true)
	s.onInput(rtcsock.ChKeys, quality(levelMax))
	if n := queued(); n != 0 {
		t.Fatalf("QUALITY sent %d messages to deskd", n)
	}
	key := make([]byte, 16)
	key[0], key[1], key[15] = 4, 1, 'a'
	s.onInput(rtcsock.ChKeys, key)
	if n := queued(); n != 1 {
		t.Fatalf("a KEY made %d input.activity, so this test can't see one", n)
	}

	s.onInput(rtcsock.ChInput, quality(levelLow))
	if a := h.askName(s); *a != "max" || s.inputDropped.Load() != 1 {
		t.Fatalf("QUALITY on input: ask %v, inputDropped %d", *a, s.inputDropped.Load())
	}

	hold := make([]byte, 16)
	hold[0], hold[13] = 6, 120
	s.onInput(rtcsock.ChKeys, hold)
	if got := time.Duration(s.videoOut.hold.Load()); got != 120*time.Millisecond {
		t.Fatalf("HOLD 120 set %v", got)
	}

	unknown := make([]byte, 16)
	unknown[0] = 8
	s.onInput(rtcsock.ChKeys, unknown)
	if s.keysDropped.Load() != 1 {
		t.Fatalf("type 8: keysDropped %d", s.keysDropped.Load())
	}
}

// The highest ask among the sessions viewing, a session that never asked counting as High. Asks from sessions that
// aren't viewing don't count, and with nobody viewing the level stays.
func TestLevelIsTheHighestViewersAsk(t *testing.T) {
	h := newQualityHub(t)
	a, _ := newQualitySession(t, h, "cs-a", true)
	b, _ := newQualitySession(t, h, "cs-b", true)
	c, _ := newQualitySession(t, h, "cs-c", true)
	step := func(what string, want level) {
		t.Helper()
		if got := levelOf(h); got != want {
			t.Fatalf("%s: level %s, want %s", what, got, want)
		}
	}
	step("start", levelHigh)
	h.setQuality(b, levelLow)
	step("an ask with nobody viewing", levelHigh)
	h.setViewer(a, true)
	step("a views, never asked", levelHigh)
	h.setViewer(b, true)
	step("b views asking low", levelHigh)
	h.setViewer(a, false)
	step("a leaves", levelLow)
	h.setQuality(c, levelMax)
	step("c asks max, not viewing", levelLow)
	h.setViewer(b, false)
	step("nobody viewing", levelLow)
	h.setViewer(c, true)
	step("c views", levelMax)
	h.setQuality(c, levelMedium)
	step("c asks medium", levelMedium)
	h.setQuality(c, levelNone)
	step("c withdraws", levelHigh)
	h.setViewer(b, true)
	step("b views again", levelHigh)
	h.setQuality(c, levelLow)
	step("both low", levelLow)
}

func TestLimit(t *testing.T) {
	h := newQualityHub(t)
	a, _ := newQualitySession(t, h, "cs-a", true)
	h.setQuality(a, levelMax)
	h.setViewer(a, true)
	for _, c := range []struct {
		limit *string
		want  level
	}{
		{str("medium"), levelMedium},
		{str("max"), levelMax},
		{str("low"), levelLow},
		{nil, levelMax},
		{str("low"), levelLow},
		{str("ultra"), levelMax}, // unknown: no limit
	} {
		h.setLimit(c.limit)
		if got := levelOf(h); got != c.want {
			t.Fatalf("limit %v: level %s, want %s", c.limit, got, c.want)
		}
	}
	// With nobody viewing, a limit still lowers the level, and lifting it goes back to the last ask.
	h.setViewer(a, false)
	h.setLimit(str("low"))
	if got := levelOf(h); got != levelLow {
		t.Fatalf("limit with nobody viewing: %s", got)
	}
	h.setLimit(nil)
	if got := levelOf(h); got != levelMax {
		t.Fatalf("limit lifted with nobody viewing: %s", got)
	}
}

// Replies go to a session when it starts viewing, and to every session viewing when what it would hear changes:
// never twice the same.
func TestQualityReplies(t *testing.T) {
	h := newQualityHub(t)
	a, ka := newQualitySession(t, h, "cs-a", true)
	b, kb := newQualitySession(t, h, "cs-b", true)

	h.setQuality(a, levelHigh)
	ka.expect(t, "not viewing")
	h.setViewer(a, true)
	ka.expect(t, "a views", reply(levelHigh, levelNone, 0))
	h.setQuality(b, levelLow)
	h.setViewer(b, true)
	ka.expect(t, "b views: nothing changed for a")
	kb.expect(t, "b views", reply(levelHigh, levelNone, flagRaised))
	h.setQuality(a, levelMax)
	ka.expect(t, "a asks max", reply(levelMax, levelNone, 0))
	kb.expect(t, "a asks max", reply(levelMax, levelNone, flagRaised))
	h.setLimit(str("medium"))
	ka.expect(t, "limit medium", reply(levelMedium, levelMedium, flagHeld))
	kb.expect(t, "limit medium", reply(levelMedium, levelMedium, flagRaised))
	h.setQuality(b, levelLow)
	h.setLimit(str("medium"))
	ka.expect(t, "same ask, same limit")
	kb.expect(t, "same ask, same limit")
	h.setQuality(b, levelMedium)
	ka.expect(t, "b asks what's in effect: nothing changed for a")
	kb.expect(t, "b's flags change", reply(levelMedium, levelMedium, 0))
	h.setViewer(a, false)
	ka.expect(t, "a leaves")
	kb.expect(t, "a leaves: nothing changed for b")
	h.setQuality(b, levelLow)
	kb.expect(t, "b asks low", reply(levelLow, levelMedium, 0))
	h.setViewer(a, true)
	ka.expect(t, "a views again", reply(levelMedium, levelMedium, flagHeld))
	kb.expect(t, "a views again", reply(levelMedium, levelMedium, flagRaised))
	h.setViewer(a, false)
	h.setViewer(a, true)
	ka.expect(t, "a views again: told again", reply(levelMedium, levelMedium, flagHeld))
	kb.expect(t, "a out and in", reply(levelLow, levelMedium, 0), reply(levelMedium, levelMedium, flagRaised))

	// A session whose keys isn't open yet hears nothing, and hears the level when its first QUALITY comes, even one
	// that changes nothing.
	c, kc := newQualitySession(t, h, "cs-c", false)
	h.setViewer(c, true)
	var rwc datachannel.ReadWriteCloser = kc
	c.keysOut.Store(&rwc)
	kc.expect(t, "keys closed")
	c.onQuality(quality(levelHigh))
	kc.expect(t, "first QUALITY", reply(levelMedium, levelMedium, flagHeld))
}

// One line at once, a second within 500 ms waits for them to be up and goes as the newest value, and a level that's
// back where it was by then doesn't go at all.
func TestLevelPace(t *testing.T) {
	h := newQualityHub(t)
	s := attachStream(t, h)
	if got := s.nextCmd(time.Second); got != "level high" {
		t.Fatalf("on attach: %q", got)
	}
	s.noCmd(levelPace + 50*time.Millisecond)

	start := time.Now()
	h.setLimit(str("low"))
	if got := s.nextCmd(time.Second); got != "level low" || time.Since(start) > 100*time.Millisecond {
		t.Fatalf("first change: %q after %v", got, time.Since(start))
	}
	h.setLimit(str("medium"))
	h.setLimit(nil)
	h.setLimit(str("medium"))
	if got := s.nextCmd(time.Second); got != "level medium" {
		t.Fatalf("paced change: %q", got)
	} else if d := time.Since(start); d < levelPace-20*time.Millisecond {
		t.Fatalf("paced change went after %v", d)
	}
	s.noCmd(levelPace + 100*time.Millisecond)

	h.setLimit(str("low"))
	if got := s.nextCmd(time.Second); got != "level low" {
		t.Fatalf("after a quiet 500 ms: %q", got)
	}
	h.setLimit(str("medium"))
	h.setLimit(str("low"))
	s.noCmd(levelPace + 100*time.Millisecond)

	// Closing the hub stops a paced line, and none is set up after.
	h.setLimit(nil)
	if got := s.nextCmd(time.Second); got != "level high" {
		t.Fatalf("after a quiet 500 ms: %q", got)
	}
	pending := func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()

		return h.q.timer != nil
	}
	h.setLimit(str("medium"))
	if !pending() {
		t.Fatal("no paced line waiting")
	}
	h.close()
	if pending() {
		t.Fatal("a paced line is still waiting after close")
	}
	s.noCmd(levelPace + 100*time.Millisecond)
	h.setLimit(str("low"))
	if pending() {
		t.Fatal("a paced line was set up after close")
	}
}

// A new desk-stream hears the level first, before resume, and again on every new connection whatever was sent before.
func TestAttachSendsLevelBeforeResume(t *testing.T) {
	h := newQualityHub(t)
	a, _ := newQualitySession(t, h, "cs-a", true)
	h.setQuality(a, levelLow)
	h.setViewer(a, true)
	for i := range 2 {
		s := attachStream(t, h)
		for _, want := range []string{"level low", "resume", "keyframe"} {
			if got := s.nextCmd(time.Second); got != want {
				t.Fatalf("connection %d: %q, want %q", i+1, got, want)
			}
		}
	}
}

// The level goes ahead of a first viewer's resume, so desk-stream's first keyframe for it is at that level.
func TestFirstViewersLevelGoesBeforeResume(t *testing.T) {
	h := newQualityHub(t)
	s := attachStream(t, h)
	if got := s.nextCmd(time.Second); got != "level high" {
		t.Fatalf("on attach: %q", got)
	}
	time.Sleep(levelPace + 50*time.Millisecond)
	a, _ := newQualitySession(t, h, "cs-a", true)
	h.setQuality(a, levelLow)
	h.setViewer(a, true)
	for _, want := range []string{"level low", "resume", "keyframe"} {
		if got := s.nextCmd(time.Second); got != want {
			t.Fatalf("%q, want %q", got, want)
		}
	}
}

func TestQualityStatsJSON(t *testing.T) {
	h := newQualityHub(t)
	a, _ := newQualitySession(t, h, "cs-a", true)
	st := h.stats()
	if st.Level != "high" || st.Limit != nil || a.stats().Quality != nil {
		t.Fatalf("at start: level %q, limit %v, quality %v", st.Level, st.Limit, a.stats().Quality)
	}
	b, _ := json.Marshal(st)
	if !strings.Contains(string(b), `"level":"high","limit":null`) {
		t.Fatalf("stream stats %s", b)
	}
	if b, _ = json.Marshal(a.stats()); strings.Contains(string(b), "quality") {
		t.Fatalf("session stats with no ask %s", b)
	}
	h.setQuality(a, levelMax)
	h.setViewer(a, true)
	h.setLimit(str("medium"))
	if b, _ = json.Marshal(h.stats()); !strings.Contains(string(b), `"level":"medium","limit":"medium"`) {
		t.Fatalf("stream stats %s", b)
	}
	if b, _ = json.Marshal(a.stats()); !strings.Contains(string(b), `"quality":"max"`) {
		t.Fatalf("session stats %s", b)
	}
}

// The whole path: QUALITY on a real keys channel, the reply, desk-stream's level, stream.limit from deskd, stats, and
// the limit's reset when deskd's connection is replaced.
func TestQualityOverKeys(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	if got := s.nextCmd(3 * time.Second); got != "level high" {
		t.Fatalf("desk-stream's first line: %q", got)
	}
	p, _ := connected(t, d, "cs-a")
	send := func(l level) {
		t.Helper()
		if err := p.channels[rtcsock.ChKeys].Send(quality(l)); err != nil {
			t.Fatal(err)
		}
	}
	nextReply := func() []byte {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case got := <-p.recv:
				if got.channel == rtcsock.ChKeys && len(got.frame) > 0 && got.frame[0] == qualityReply {
					return got.frame
				}
			case <-deadline:
				t.Fatal("no QUALITY reply")
			}
		}
	}
	stats := func() *rtcsock.Message {
		t.Helper()
		d.send(&rtcsock.Message{T: "stats.get"})

		return d.expect("stats", "", 3*time.Second)
	}

	send(levelLow)
	var st *rtcsock.Message
	waitFor(t, "the ask in stats", func() bool { st = stats(); return len(st.Sessions) == 1 && st.Sessions[0].Quality != nil })
	if st.Stream.Level != "high" || *st.Sessions[0].Quality != "low" {
		t.Fatalf("not viewing: stream %+v, session %+v", st.Stream, st.Sessions[0])
	}
	view(d, "cs-a", true)
	s.expectCmd("level low")
	if got := nextReply(); string(got) != string(reply(levelLow, levelNone, 0)) {
		t.Fatalf("reply on viewing %x", got)
	}
	select {
	case m := <-d.msgs:
		if m.T == "input.activity" {
			t.Fatal("QUALITY made input.activity")
		}
	case <-time.After(100 * time.Millisecond):
	}

	send(levelMax)
	if got := nextReply(); string(got) != string(reply(levelMax, levelNone, 0)) {
		t.Fatalf("reply to max %x", got)
	}
	d.send(&rtcsock.Message{T: "stream.limit", Level: str("medium")})
	if got := nextReply(); string(got) != string(reply(levelMedium, levelMedium, flagHeld)) {
		t.Fatalf("reply to the limit %x", got)
	}
	s.expectCmd("level medium")
	st = stats()
	if st.Stream.Level != "medium" || st.Stream.Limit == nil || *st.Stream.Limit != "medium" || *st.Sessions[0].Quality != "max" {
		t.Fatalf("limited: stream %+v, session %+v", st.Stream, st.Sessions[0])
	}
	if st.Sessions[0].KeysDropped != 0 {
		t.Fatalf("keysDropped %d", st.Sessions[0].KeysDropped)
	}

	// A new deskd connection closes the session and lifts the limit. With nobody viewing, the level is the last ask.
	d2 := f.deskd()
	s.expectCmd("level max")
	d2.send(&rtcsock.Message{T: "stats.get"})
	if st := d2.expect("stats", "", 3*time.Second); st.Stream.Level != "max" || st.Stream.Limit != nil {
		t.Fatalf("after a new deskd: %+v", st.Stream)
	}
}
