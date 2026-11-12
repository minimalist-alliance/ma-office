package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/wire"
)

// The protocol over a real Unix socket: what deskd does to the app (contract §5, deskd API.md §19).

const textsDir = "testdata/texts"

func TestMain(m *testing.M) {
	if os.Getenv("BIBLE_APP_CHILD") == "1" {
		// Run as the app itself, for the SIGTERM check.
		os.Args = []string{os.Args[0], "-texts", os.Getenv("BIBLE_APP_TEXTS")}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type server struct {
	cfg    config
	cancel context.CancelFunc
	done   chan error
}

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "bib")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func start(t *testing.T, data string, mod func(*config)) *server {
	t.Helper()
	cfg := config{socket: filepath.Join(shortDir(t), "app.sock"), data: data, texts: textsDir, deskdUID: os.Getuid(),
		id: "com.minimalistalliance.bible", version: "1.0.0", helloTimeout: 2 * time.Second, stopTimeout: time.Second,
		summaryEvery: 100 * time.Millisecond}
	if mod != nil {
		mod(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &server{cfg: cfg, cancel: cancel, done: make(chan error, 1)}
	listening := make(chan struct{})
	go func() { s.done <- run(ctx, cfg, listening) }()
	select {
	case <-listening:
	case err := <-s.done:
		t.Fatalf("run: %v", err)
	}
	t.Cleanup(s.stop)
	return s
}

func (s *server) stop() {
	s.cancel()
	<-s.done
	s.done <- nil
}

// client is deskd's end, enough for the checks.
type client struct {
	c       *wire.Conn
	mu      sync.Mutex
	next    uint32
	pending map[uint32]chan wire.Frame
	events  map[uint32]chan event
	early   map[uint32][]event
	closed  chan struct{}
	closeF  *wire.Frame
	guild   bool // what this stand-in for deskd answers to desk.info.get
}

type event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
	seq  uint32
	at   time.Time
}

type callErr struct{ e wire.Error }

func (e *callErr) Error() string { return e.e.Code + " " + fmt.Sprint(e.e.Details) }

func dial(t *testing.T, s *server, hello map[string]any) (*client, map[string]any, error) {
	t.Helper()
	return dialDesk(t, s, hello, false)
}

// dialDesk is dial as the deskd of a Guild Desk (guild) or of a member's own desk.
func dialDesk(t *testing.T, s *server, hello map[string]any, guild bool) (*client, map[string]any, error) {
	t.Helper()
	nc, err := net.Dial("unix", s.cfg.socket)
	if err != nil {
		return nil, nil, err
	}
	c := &client{c: wire.NewConn(nc), pending: map[uint32]chan wire.Frame{}, events: map[uint32]chan event{},
		early: map[uint32][]event{}, closed: make(chan struct{}), guild: guild}
	t.Cleanup(func() { nc.Close() })
	if hello == nil {
		hello = map[string]any{"appApi": "1.0", "deskApi": "1.4", "app": map[string]string{"id": s.cfg.id, "version": "1.0.0"},
			"grants": []string{}, "limits": map[string]any{"memoryMaxBytes": 64 << 20}, "future": map[string]any{"x": 1}}
	}
	if err := c.c.Send(wire.Hello, 0, 0, hello); err != nil {
		return nil, nil, err
	}
	_ = nc.SetReadDeadline(time.Now().Add(3 * time.Second))
	f, err := wire.Read(c.c.R)
	if err != nil {
		return nil, nil, err
	}
	_ = nc.SetReadDeadline(time.Time{})
	var reply map[string]any
	_ = json.Unmarshal(f.Payload, &reply)
	if f.Kind != wire.Hello {
		return nil, reply, fmt.Errorf("kind %d: %v", f.Kind, reply)
	}
	go c.read()
	return c, reply, nil
}

func (c *client) read() {
	defer close(c.closed)
	for {
		f, err := wire.Read(c.c.R)
		if err != nil {
			return
		}
		switch f.Kind {
		case wire.Res, wire.Err, wire.Pong:
			c.mu.Lock()
			ch := c.pending[f.ID]
			delete(c.pending, f.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- f
			}
		case wire.Evt:
			var e event
			_ = json.Unmarshal(f.Payload, &e)
			e.seq, e.at = f.Seq, time.Now()
			c.mu.Lock()
			ch := c.events[f.ID]
			if ch == nil {
				c.early[f.ID] = append(c.early[f.ID], e)
			}
			c.mu.Unlock()
			if ch != nil {
				ch <- e
			}
		case wire.Req:
			// The app's own calls to deskd: desk.info.get, as deskd answers it.
			var r struct {
				M string `json:"m"`
			}
			_ = json.Unmarshal(f.Payload, &r)
			if r.M == "desk.info.get" {
				_ = c.c.Send(wire.Res, f.ID, 0, map[string]any{"appApi": "1.0", "deskApi": "1.4", "timeZone": "UTC", "guildDesk": c.guild})
			} else {
				_ = c.c.Send(wire.Err, f.ID, 0, map[string]any{"code": "not_found"})
			}
		case wire.Close:
			c.closeF = &f
			return
		}
	}
}

func (c *client) round(kind byte, payload any) (wire.Frame, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan wire.Frame, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	var err error
	if payload == nil {
		err = c.c.Write(wire.Frame{Kind: kind, ID: id})
	} else {
		err = c.c.Send(kind, id, 0, payload)
	}
	if err != nil {
		return wire.Frame{}, err
	}
	select {
	case f := <-ch:
		return f, nil
	case <-c.closed:
		return wire.Frame{}, io.EOF
	case <-time.After(5 * time.Second):
		return wire.Frame{}, errors.New("no reply")
	}
}

var owner = map[string]any{"kind": "owner"}

func member(id string) map[string]any {
	return map[string]any{"kind": "guild_member", "member": id, "role": "member", "grants": []string{}, "teen": false}
}

func (c *client) call(m string, p any, idem string) (json.RawMessage, error) {
	return c.callFrom(map[string]any{"kind": "view", "session": "p-test", "caller": owner}, m, p, idem)
}

// callAs is a view's call for a caller.
func (c *client) callAs(who map[string]any, m string, p any, idem string) (json.RawMessage, error) {
	return c.callFrom(map[string]any{"kind": "view", "session": "p-test", "caller": who}, m, p, idem)
}

func (c *client) callFrom(from any, m string, p any, idem string) (json.RawMessage, error) {
	req := map[string]any{"m": m, "p": p, "deadlineMs": 5000, "from": from}
	if idem != "" {
		req["idem"] = idem
	}
	f, err := c.round(wire.Req, req)
	if err != nil {
		return nil, err
	}
	if f.Kind == wire.Err {
		var e wire.Error
		_ = json.Unmarshal(f.Payload, &e)
		return nil, &callErr{e: e}
	}
	return f.Payload, nil
}

func (c *client) must(t *testing.T, m string, p any, idem string, v any) {
	t.Helper()
	raw, err := c.call(m, p, idem)
	if err != nil {
		t.Fatalf("%s: %v", m, err)
	}
	if v != nil {
		if err := json.Unmarshal(raw, v); err != nil {
			t.Fatalf("%s: %v in %s", m, err, raw)
		}
	}
}

func errReason(err error) string {
	var ce *callErr
	if !errors.As(err, &ce) {
		return fmt.Sprint(err)
	}
	return ce.e.Code + ":" + fmt.Sprint(ce.e.Details["reason"])
}

func (c *client) subscribe(t *testing.T, topic string) chan event {
	t.Helper()
	if topic == "app.summary" {
		return c.subscribeFrom(t, topic, map[string]any{"kind": "desk"})
	}
	return c.subscribeFrom(t, topic, map[string]any{"kind": "view", "caller": owner})
}

func (c *client) subscribeFrom(t *testing.T, topic string, from any) chan event {
	t.Helper()
	f, err := c.round(wire.Sub, map[string]any{"topic": topic, "from": from})
	if err != nil || f.Kind != wire.Res {
		t.Fatalf("SUB %s: %v %s", topic, err, f.Payload)
	}
	var r struct {
		SubID uint32 `json:"subId"`
	}
	_ = json.Unmarshal(f.Payload, &r)
	ch := make(chan event, 64)
	c.mu.Lock()
	for _, e := range c.early[r.SubID] {
		ch <- e
	}
	delete(c.early, r.SubID)
	c.events[r.SubID] = ch
	c.mu.Unlock()
	return ch
}

func next(t *testing.T, ch chan event, within time.Duration) event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(within):
		t.Fatalf("no event within %v", within)
	}
	return event{}
}

func TestHelloPingAndUnknowns(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, hello, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	if hello["appApi"] != "1.0" || hello["app"].(map[string]any)["id"] != "com.minimalistalliance.bible" {
		t.Fatalf("hello %v", hello)
	}
	if f, err := c.round(wire.Ping, nil); err != nil || f.Kind != wire.Pong {
		t.Fatalf("ping: %v %d", err, f.Kind)
	}
	// Reserved and unknown kinds are ignored, as are unknown fields in a request.
	_ = c.c.Write(wire.Frame{Kind: 3, Payload: []byte(`{"future":true}`)})
	_ = c.c.Write(wire.Frame{Kind: 99, ID: 7})
	var info struct {
		Translations []map[string]any `json:"translations"`
	}
	c.must(t, "bible.info", map[string]any{"future": 1}, "", &info)
	if len(info.Translations) != 4 || info.Translations[0]["code"] != "bsb" || info.Translations[0]["default"] != true {
		t.Fatalf("info %v", info)
	}
	if _, err := c.call("bible.nope", nil, ""); errReason(err) != "not_found:method" {
		t.Fatalf("unknown method: %v", err)
	}
	if f, err := c.round(wire.Ping, nil); err != nil || f.Kind != wire.Pong {
		t.Fatalf("ping after unknowns: %v", err)
	}
}

func TestHelloRefusals(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	_, reply, err := dial(t, s, map[string]any{"appApi": "2.0"})
	if err == nil || fmt.Sprint(reply["code"]) != "4426" {
		t.Fatalf("another major: %v %v", err, reply)
	}
	// A first frame that isn't HELLO.
	nc, _ := net.Dial("unix", s.cfg.socket)
	defer nc.Close()
	c := wire.NewConn(nc)
	_ = c.Write(wire.Frame{Kind: wire.Ping, ID: 1})
	f, err := wire.Read(bufio.NewReader(nc))
	if err != nil || f.Kind != wire.Close || !strings.Contains(string(f.Payload), "4000") {
		t.Fatalf("not HELLO first: %v %d %s", err, f.Kind, f.Payload)
	}
}

func TestWrongPeerRefused(t *testing.T) {
	s := start(t, t.TempDir(), func(c *config) { c.deskdUID = os.Getuid() + 1 })
	_, _, err := dial(t, s, nil)
	if err == nil {
		t.Fatal("a peer that isn't deskd got a HELLO")
	}
}

func TestNewerDataRefused(t *testing.T) {
	data := t.TempDir()
	_ = os.WriteFile(filepath.Join(data, "journal.jsonl"), []byte(`{"format":"ma-bible-journal","version":2}`+"\n"), 0o600)
	s := start(t, data, nil)
	_, reply, err := dial(t, s, nil)
	if err == nil || fmt.Sprint(reply["code"]) != "4426" || reply["reason"] != "needs_update" {
		t.Fatalf("newer data: %v %v", err, reply)
	}
}

func TestReading(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	var st struct {
		Available    bool             `json:"available"`
		Translation  string           `json:"translation"`
		Translations []map[string]any `json:"translations"`
		Books        []struct {
			ID     string `json:"id"`
			Verses []int  `json:"verses"`
		} `json:"books"`
		Prefs map[string]any `json:"prefs"`
	}
	c.must(t, "bible.state", map[string]any{}, "", &st)
	if !st.Available || st.Translation != "bsb" || len(st.Books) != 8 || st.Books[0].ID != "GEN" || st.Prefs["textSize"] != 18.0 || st.Prefs["place"] != nil {
		t.Fatalf("state %+v", st)
	}
	var ch struct {
		BookName string           `json:"bookName"`
		Items    []map[string]any `json:"items"`
		Prev     map[string]any   `json:"prev"`
		Next     map[string]any   `json:"next"`
		Marks    []any            `json:"marks"`
	}
	c.must(t, "bible.chapter", map[string]any{"translation": "bsb", "book": "PSA", "chapter": 23}, "", &ch)
	if ch.BookName != "Psalms" || len(ch.Items) != 5 || ch.Items[1]["level"] != "d" || ch.Items[2]["segments"] == nil || ch.Marks == nil || ch.Prev["book"] != "GEN" {
		t.Fatalf("chapter %+v", ch)
	}
	for p, want := range map[string]string{
		`{"translation":"niv","book":"JHN","chapter":3}`:   "not_found:translation",
		`{"translation":"bsb","book":"XYZ","chapter":3}`:   "not_found:book",
		`{"translation":"bsb","book":"JHN","chapter":1}`:   "not_found:chapter",
		`{"book":"JHN","chapter":3}`:                       "bad_request:translation",
		`{"translation":"bsb","book":"JHN","chapter":"3"}`: "bad_request:chapter",
	} {
		if _, err := c.call("bible.chapter", json.RawMessage(p), ""); errReason(err) != want {
			t.Errorf("%s: %v, want %s", p, err, want)
		}
	}
	var about map[string]any
	c.must(t, "bible.about", map[string]any{"translation": "kjv"}, "", &about)
	notice, _ := os.ReadFile(textsDir + "/kjv/NOTICE.txt")
	if about["abbreviation"] != "KJV" || about["statement"] != string(notice) || strings.Contains(about["statement"].(string), "Source:") ||
		about["sourceUrl"] != "https://ebible.org/find/details.php?id=eng-kjv2006" {
		t.Fatalf("about %v", about)
	}
	var lk map[string]map[string]any
	c.must(t, "bible.lookup", map[string]any{"q": "jn 3:99"}, "", &lk)
	if lk["ref"]["book"] != "JHN" || lk["ref"]["verse"] != 17.0 {
		t.Fatalf("lookup %v", lk)
	}
	if _, err := c.call("bible.lookup", map[string]any{"q": "love"}, ""); errReason(err) != "not_found:ref" {
		t.Fatalf("lookup love: %v", err)
	}
}

func TestSearchOverTheSocket(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	type page struct {
		Hits []struct {
			Translation string   `json:"translation"`
			Book        string   `json:"book"`
			Verse       int      `json:"verse"`
			Ranges      [][2]int `json:"ranges"`
		} `json:"hits"`
		Total  int            `json:"total"`
		Counts map[string]int `json:"counts"`
		ByBook []any          `json:"byBook"`
		Cursor *string        `json:"cursor"`
		Ref    map[string]any `json:"ref"`
	}
	var got []string
	p := map[string]any{"translation": "all", "q": "love", "limit": 4}
	for i := 0; i < 5; i++ {
		var pg page
		c.must(t, "bible.search", p, "", &pg)
		if pg.Total != 6 || pg.Counts["kjv"] != 1 || len(pg.ByBook) != 2 {
			t.Fatalf("page %+v", pg)
		}
		for _, h := range pg.Hits {
			got = append(got, h.Translation+" "+h.Book)
		}
		if pg.Cursor == nil {
			break
		}
		p["cursor"] = *pg.Cursor
	}
	if strings.Join(got, ",") != "bsb 1CO,bsb 1CO,bsb 1CO,bsb 1JN,web 1JN,kjv 1JN" {
		t.Fatalf("pages %v", got)
	}
	var pg page
	c.must(t, "bible.search", map[string]any{"translation": "bsb", "q": "jn 3:16"}, "", &pg)
	if pg.Ref["book"] != "JHN" || pg.Ref["verse"] != 16.0 || pg.Total != 0 || pg.Hits == nil {
		t.Fatalf("ref %+v", pg)
	}
	bad := map[string]string{
		`{"translation":"bsb","q":""}`:                                   "bad_request:q",
		`{"translation":"bsb","q":"love","limit":201}`:                   "bad_request:limit",
		`{"translation":"bsb","q":"love","scope":"xx"}`:                  "bad_request:scope",
		`{"translation":"bsb","q":"love","cursor":"abc"}`:                "bad_request:cursor",
		`{"translation":"niv","q":"love"}`:                               "not_found:translation",
		`{"translation":"kjv","q":"love","cursor":"` + *pg0(t, c) + `"}`: "bad_request:cursor",
	}
	for p, want := range bad {
		if _, err := c.call("bible.search", json.RawMessage(p), ""); errReason(err) != want {
			t.Errorf("%s: %v, want %s", p, err, want)
		}
	}
}

// pg0 is a cursor from a search in another translation.
func pg0(t *testing.T, c *client) *string {
	var pg struct {
		Cursor *string `json:"cursor"`
	}
	c.must(t, "bible.search", map[string]any{"translation": "bsb", "q": "love", "limit": 1}, "", &pg)
	return pg.Cursor
}

func TestMarksTopicAndMutations(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	evs := c.subscribe(t, "bible.marks")
	if e := next(t, evs, time.Second); e.Type != "snapshot" || string(e.Data) != `{"rev":0}` {
		t.Fatalf("snapshot %+v %s", e, e.Data)
	}
	var put struct {
		Mark  map[string]any   `json:"mark"`
		Marks []map[string]any `json:"marks"`
	}
	c.must(t, "bible.mark.put", map[string]any{"mark": map[string]any{"kind": "highlight", "book": "JHN", "chapter": 3, "verse": 16, "verseEnd": 17, "color": "blue"}}, "019a-1", &put)
	if len(put.Marks) != 2 || put.Mark["color"] != "blue" {
		t.Fatalf("put %+v", put)
	}
	if e := next(t, evs, time.Second); e.Type != "patch" || string(e.Data) != `{"rev":1}` {
		t.Fatalf("patch %+v %s", e, e.Data)
	}
	// The same key again: the same reply, no second change, no event.
	raw, err := c.call("bible.mark.put", map[string]any{"mark": map[string]any{"kind": "highlight", "book": "JHN", "chapter": 3, "verse": 16, "verseEnd": 17, "color": "blue"}}, "019a-1")
	var again struct {
		Mark map[string]any `json:"mark"`
	}
	_ = json.Unmarshal(raw, &again)
	if err != nil || again.Mark["id"] != put.Mark["id"] {
		t.Fatalf("replay %s %v", raw, err)
	}
	var chm struct {
		Marks []any `json:"marks"`
	}
	c.must(t, "bible.marks.chapter", map[string]any{"book": "JHN", "chapter": 3}, "", &chm)
	if len(chm.Marks) != 2 {
		t.Fatalf("marks %v", chm.Marks)
	}
	var list struct {
		Marks []map[string]any `json:"marks"`
		Total int              `json:"total"`
	}
	c.must(t, "bible.marks.list", map[string]any{"kind": "highlight", "translation": "kjv"}, "", &list)
	if list.Total != 2 || !strings.HasPrefix(list.Marks[0]["verseText"].(string), "For God so loved the world, that he gave") ||
		!strings.HasSuffix(list.Marks[0]["verseText"].(string), "…") || list.Marks[1]["verseText"] != "" {
		t.Fatalf("list %+v", list)
	}
	if n := len(utf16.Encode([]rune(list.Marks[0]["verseText"].(string)))); n > 120 {
		t.Fatalf("verseText %d units", n)
	}
	var cl map[string]int
	c.must(t, "bible.highlight.clear", map[string]any{"book": "JHN", "chapter": 3, "verse": 16, "verseEnd": 17}, "019a-2", &cl)
	if cl["removed"] != 2 {
		t.Fatalf("clear %v", cl)
	}
	if e := next(t, evs, time.Second); string(e.Data) != `{"rev":2}` {
		t.Fatalf("patch after clear %s", e.Data)
	}
	for p, want := range map[string]string{
		`{"mark":{"kind":"highlight","book":"JHN","chapter":3,"verse":1,"color":"yellow"}}`: "bad_request:color",
		`{"mark":{"kind":"note","book":"JHN","chapter":"3","verse":1,"text":"x"}}`:          "bad_request:chapter",
		`{}`:                                 "bad_request:mark",
		`{"mark":{"id":"mnope","text":"x"}}`: "not_found:mark",
	} {
		if _, err := c.call("bible.mark.put", json.RawMessage(p), "k-"+p); errReason(err) != want {
			t.Errorf("%s: %v, want %s", p, err, want)
		}
	}
	if _, err := c.call("bible.mark.remove", map[string]any{"id": "x"}, "019a-1"); errReason(err) != "conflict:idem" {
		t.Fatalf("a key reused for another method: %v", err)
	}
	if _, err := c.call("bible.prefs.set", map[string]any{"textSize": 17}, "019a-3"); errReason(err) != "bad_request:textSize" {
		t.Fatalf("prefs: %v", err)
	}
}

func TestWidgetSummary(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	evs := c.subscribe(t, "app.summary")
	if e := next(t, evs, time.Second); e.Type != "snapshot" || string(e.Data) != `{"rows":[]}` {
		t.Fatalf("snapshot before a place: %s", e.Data)
	}
	set := func(book string, ch, v int, idem string) {
		c.must(t, "bible.prefs.set", map[string]any{"place": map[string]any{"translation": "bsb", "book": book, "chapter": ch, "verse": v}}, idem, nil)
	}
	set("JHN", 3, 16, "w1")
	e1 := next(t, evs, time.Second)
	var sum struct {
		Badge *int `json:"badge"`
		Rows  []struct {
			Text   string `json:"text"`
			Detail string `json:"detail"`
		} `json:"rows"`
	}
	_ = json.Unmarshal(e1.Data, &sum)
	if e1.Type != "patch" || len(sum.Rows) != 1 || sum.Rows[0].Text != "John 3:16 · BSB" || sum.Badge != nil ||
		!strings.HasPrefix(sum.Rows[0].Detail, "For God so loved") || !strings.HasSuffix(sum.Rows[0].Detail, "…") {
		t.Fatalf("summary %s", e1.Data)
	}
	if n := len(utf16.Encode([]rune(sum.Rows[0].Detail))); n > 120 {
		t.Fatalf("detail %d units", n)
	}
	// Three places at once: at most one event per interval, and the last place wins.
	set("GEN", 1, 1, "w2")
	set("GEN", 1, 2, "w3")
	set("PSA", 23, 1, "w4")
	e2 := next(t, evs, time.Second)
	for {
		select {
		case e := <-evs:
			if e.at.Sub(e2.at) < s.cfg.summaryEvery-10*time.Millisecond {
				t.Fatalf("two summaries %v apart", e.at.Sub(e2.at))
			}
			e2 = e
			continue
		case <-time.After(3 * s.cfg.summaryEvery):
		}
		break
	}
	if !strings.Contains(string(e2.Data), "Psalms 23:1 · BSB") {
		t.Fatalf("last summary %s", e2.Data)
	}
	if e2.at.Sub(e1.at) < s.cfg.summaryEvery-10*time.Millisecond {
		t.Fatalf("summaries %v apart", e2.at.Sub(e1.at))
	}
}

func TestIdemAcrossRestart(t *testing.T) {
	data := t.TempDir()
	s := start(t, data, nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := map[string]any{"mark": map[string]any{"kind": "note", "book": "JHN", "chapter": 3, "verse": 16, "text": "once"}}
	first, err := c.call("bible.mark.put", p, "019a5c8e-0000-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	s.stop()
	s2 := start(t, data, nil)
	c2, _, err := dial(t, s2, nil)
	if err != nil {
		t.Fatal(err)
	}
	again, err := c2.call("bible.mark.put", p, "019a5c8e-0000-7000-8000-000000000001")
	if err != nil || string(again) != string(first) {
		t.Fatalf("after a restart: %s vs %s (%v)", again, first, err)
	}
	var chm struct {
		Marks []any `json:"marks"`
	}
	c2.must(t, "bible.marks.chapter", map[string]any{"book": "JHN", "chapter": 3}, "", &chm)
	if len(chm.Marks) != 1 {
		t.Fatalf("%d marks", len(chm.Marks))
	}
}

func TestNewConnectionReplacesOld(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c1, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	c2, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-c1.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("the old connection is still open")
	}
	if f, err := c2.round(wire.Ping, nil); err != nil || f.Kind != wire.Pong {
		t.Fatalf("the new one: %v", err)
	}
}

// TestSIGTERM runs the binary as deskd would and stops it: it must answer HELLO quickly and exit 0 on SIGTERM.
func TestSIGTERM(t *testing.T) {
	sockDir := shortDir(t)
	sock := filepath.Join(sockDir, "app.sock")
	texts, _ := filepath.Abs(textsDir)
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "BIBLE_APP_CHILD=1", "BIBLE_APP_TEXTS="+texts, "MA_APP_SOCKET="+sock, "MA_APP_DATA="+t.TempDir(),
		"MA_APP_ID=com.minimalistalliance.bible", "MA_APP_VERSION=1.0.0", fmt.Sprintf("MA_DESKD_UID=%d", os.Getuid()),
		"MA_APP_MEMORY_MAX=67108864", "MA_APP_CPU_MAX=0.25")
	cmd.Stderr = os.Stderr
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	s := &server{cfg: config{socket: sock, id: "com.minimalistalliance.bible"}}
	var c *client
	for time.Since(t0) < 3*time.Second {
		var err error
		if c, _, err = dial(t, s, nil); err == nil {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if c == nil {
		t.Fatal("no HELLO within 3 s")
	}
	helloAt := time.Since(t0)
	b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/oom_score_adj", cmd.Process.Pid))
	if strings.TrimSpace(string(b)) != "1000" {
		t.Errorf("oom_score_adj %q", b)
	}
	c.must(t, "bible.mark.put", map[string]any{"mark": map[string]any{"kind": "bookmark", "book": "GEN", "chapter": 1, "verse": 1}}, "k1", nil)
	t1 := time.Now()
	_ = cmd.Process.Signal(syscall.SIGTERM)
	err := cmd.Wait()
	took := time.Since(t1)
	if err != nil || took > 2*time.Second {
		t.Fatalf("SIGTERM: %v after %v", err, took)
	}
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Error("the socket is left behind")
	}
	t.Logf("HELLO %v after start (with the test binary's start-up), exit %v after SIGTERM", helloAt.Round(time.Millisecond), took.Round(time.Millisecond))
}

// TestManifestMatches: every method ma-app.json declares is served, with the mutation flag deskd relies on (apps.call
// for reads, apps.mutate for mutations), and nothing else is declared.
func TestManifestMatches(t *testing.T) {
	b, err := os.ReadFile("../ma-app.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Methods []struct {
			Name     string `json:"name"`
			Mutation bool   `json:"mutation"`
		} `json:"methods"`
		Topics []string `json:"topics"`
		Views  struct {
			Widget bool `json:"widget"`
		} `json:"views"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]bool{"bible.mark.put": true, "bible.mark.remove": true, "bible.highlight.clear": true, "bible.prefs.set": true}
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range m.Methods {
		if x.Mutation != mutations[x.Name] {
			t.Errorf("%s: mutation %v in the manifest", x.Name, x.Mutation)
		}
		if _, err := c.call(x.Name, map[string]any{}, "k-"+x.Name); errReason(err) == "not_found:method" {
			t.Errorf("%s isn't served", x.Name)
		}
	}
	if len(m.Methods) != 14 || strings.Join(m.Topics, ",") != "bible.marks" || !m.Views.Widget {
		t.Fatalf("manifest %+v", m)
	}
}

const (
	memberA = "p-AAAAAAAAAAAAAAAAAAAAAA"
	memberB = "p-BBBBBBBBBBBBBBBBBBBBBB"
)

func TestCallerRequired(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, from := range map[string]any{
		"no caller":       map[string]any{"kind": "view", "session": "p-x"},
		"no from":         nil,
		"a stranger":      map[string]any{"kind": "view", "caller": map[string]any{"kind": "stranger"}},
		"a bad member id": map[string]any{"kind": "view", "caller": map[string]any{"kind": "guild_member", "member": "alice"}},
		"deskd, a view's": map[string]any{"kind": "desk"},
	} {
		if _, err := c.callFrom(from, "bible.info", map[string]any{}, ""); errReason(err) != "forbidden:caller" {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := c.call("app.members.retain", map[string]any{"members": []string{}}, "r"); errReason(err) != "forbidden:caller" {
		t.Errorf("a view's retain: %v", err)
	}
	f, err := c.round(wire.Sub, map[string]any{"topic": "bible.marks", "from": map[string]any{"kind": "view"}})
	if err != nil || f.Kind != wire.Err || !strings.Contains(string(f.Payload), "forbidden") {
		t.Errorf("a SUB with no caller: %v %s", err, f.Payload)
	}
}

// TestGuildMembers: on a Guild Desk each member has their own marks, prefs and topic; deskd's retain removes those
// who left and leaves the rest.
func TestGuildMembers(t *testing.T) {
	data := t.TempDir()
	s := start(t, data, nil)
	c, _, err := dialDesk(t, s, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	a, b := member(memberA), member(memberB)
	evA := c.subscribeFrom(t, "bible.marks", map[string]any{"kind": "view", "caller": a})
	evB := c.subscribeFrom(t, "bible.marks", map[string]any{"kind": "view", "caller": b})
	for _, ev := range []chan event{evA, evB} {
		if e := next(t, ev, time.Second); e.Type != "snapshot" || string(e.Data) != `{"rev":0}` {
			t.Fatalf("snapshot %s", e.Data)
		}
	}
	put := func(who map[string]any, text, idem string) {
		t.Helper()
		if _, err := c.callAs(who, "bible.mark.put", map[string]any{"mark": map[string]any{"kind": "note", "book": "JHN", "chapter": 3, "verse": 16, "text": text}}, idem); err != nil {
			t.Fatal(err)
		}
	}
	put(a, "A's note", "same-key")
	put(b, "B's note", "same-key") // the same key, another member: its own action
	put(b, "B's second", "k2")
	if e := next(t, evA, time.Second); string(e.Data) != `{"rev":1}` {
		t.Fatalf("A's patch %s", e.Data)
	}
	if e := next(t, evB, time.Second); string(e.Data) != `{"rev":1}` {
		t.Fatalf("B's first patch %s", e.Data)
	}
	if e := next(t, evB, time.Second); string(e.Data) != `{"rev":2}` {
		t.Fatalf("B's second patch %s", e.Data)
	}
	select {
	case e := <-evA:
		t.Fatalf("A heard about B: %s", e.Data)
	case <-time.After(200 * time.Millisecond):
	}
	marksOf := func(who map[string]any) []string {
		var r struct {
			Marks []struct{ Text string } `json:"marks"`
		}
		raw, err := c.callAs(who, "bible.marks.chapter", map[string]any{"book": "JHN", "chapter": 3}, "")
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(raw, &r)
		var out []string
		for _, m := range r.Marks {
			out = append(out, m.Text)
		}
		return out
	}
	if got := marksOf(a); strings.Join(got, ",") != "A's note" {
		t.Fatalf("A sees %v", got)
	}
	if got := marksOf(b); len(got) != 2 {
		t.Fatalf("B sees %v", got)
	}
	if got := marksOf(owner); len(got) != 0 {
		t.Fatalf("the owner bucket sees %v", got)
	}
	retain := func(members []string, idem string) string {
		t.Helper()
		raw, err := c.callFrom(map[string]any{"kind": "desk"}, "app.members.retain", map[string]any{"members": members}, idem)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	if got := retain([]string{memberA}, "r1"); got != `{"removed":1}` {
		t.Fatalf("retain %s", got)
	}
	if got := marksOf(b); len(got) != 0 {
		t.Fatalf("B's marks after B left: %v", got)
	}
	if got := marksOf(a); strings.Join(got, ",") != "A's note" {
		t.Fatalf("A's marks after B left: %v", got)
	}
	if got := retain([]string{memberA}, "r1"); got != `{"removed":1}` {
		t.Fatalf("a replay %s", got)
	}
	if _, err := c.callFrom(map[string]any{"kind": "desk"}, "app.members.retain", map[string]any{}, "r3"); errReason(err) != "bad_request:members" {
		t.Fatalf("no list: %v", err)
	}
	b2, _ := os.ReadFile(filepath.Join(data, "state.jsonl"))
	j2, _ := os.ReadFile(filepath.Join(data, "journal.jsonl"))
	if strings.Contains(string(b2)+string(j2), "B's") {
		t.Fatal("B's notes are still in the files")
	}
}

// TestGuildWidget: on a Guild Desk the tile never shows a member's place.
func TestGuildWidget(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dialDesk(t, s, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	evs := c.subscribe(t, "app.summary")
	if e := next(t, evs, time.Second); string(e.Data) != `{"rows":[]}` {
		t.Fatalf("snapshot %s", e.Data)
	}
	for _, who := range []map[string]any{member(memberA), owner} {
		if _, err := c.callAs(who, "bible.prefs.set", map[string]any{"place": map[string]any{"translation": "bsb", "book": "JHN", "chapter": 3, "verse": 16}}, ""); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case e := <-evs:
		if strings.Contains(string(e.Data), "John") {
			t.Fatalf("a place on a shared tile: %s", e.Data)
		}
	case <-time.After(3 * s.cfg.summaryEvery):
	}
}

// TestRetainNeedsAll: an empty list is refused unless all: true says to remove every member, never the owner.
func TestRetainNeedsAll(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dialDesk(t, s, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, who := range []map[string]any{owner, member(memberA), member(memberB)} {
		if _, err := c.callAs(who, "bible.mark.put", map[string]any{"mark": map[string]any{"kind": "bookmark", "book": "GEN", "chapter": 1, "verse": 1}}, ""); err != nil {
			t.Fatal(err)
		}
	}
	desk := map[string]any{"kind": "desk"}
	for p, want := range map[string]string{
		`{"members":[]}`: "bad_request:empty",
		`{"members":["` + memberA + `"],"all":true}`: "bad_request:all",
		`{}`: "bad_request:members",
	} {
		if _, err := c.callFrom(desk, "app.members.retain", json.RawMessage(p), "k-"+p); errReason(err) != want {
			t.Errorf("%s: %v, want %s", p, err, want)
		}
	}
	raw, err := c.callFrom(desk, "app.members.retain", map[string]any{"members": []string{}, "all": true}, "all")
	if err != nil || string(raw) != `{"removed":2}` {
		t.Fatalf("all: %s %v", raw, err)
	}
	var mine struct {
		Marks []any `json:"marks"`
	}
	c.must(t, "bible.marks.chapter", map[string]any{"book": "GEN", "chapter": 1}, "", &mine)
	if len(mine.Marks) != 1 {
		t.Fatal("all: true touched the owner's data")
	}
}

// TestPanicStaysInItsCall: a bug in one call answers that call with internal and leaves the link and everyone else's
// calls working.
func TestPanicStaysInItsCall(t *testing.T) {
	s := start(t, t.TempDir(), nil)
	c, _, err := dial(t, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	panicOn = "bible.info"
	defer func() { panicOn = "" }()
	if _, err := c.call("bible.info", map[string]any{}, ""); errReason(err) != "internal:<nil>" {
		t.Fatalf("the panicking call: %v", err)
	}
	if _, err := c.call("bible.books", map[string]any{"translation": "bsb"}, ""); err != nil {
		t.Fatalf("the next call: %v", err)
	}
	if fi, err := os.Stat(s.cfg.socket); err != nil || fi.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode %v %v", fi.Mode(), err)
	}
}
