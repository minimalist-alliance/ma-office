package room

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/relay"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/store"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/wire"
)

// guild is a Commons server on a temporary data directory, reached the way deskd reaches it.
type guild struct {
	t    *testing.T
	data string
	sock string
	srv  *Server
	ln   *relay.Listener
}

func newGuild(t *testing.T, data string, ceiling int) *guild {
	t.Helper()
	d, err := os.MkdirTemp("", "cmg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	g := &guild{t: t, data: data, sock: filepath.Join(d, "c.sock")}
	g.srv = New(data, Options{Ceiling: ceiling})
	if g.ln, err = relay.Listen(g.sock, os.Getuid()); err != nil {
		t.Fatal(err)
	}
	go g.srv.ServeRelay(g.ln, "commons")
	t.Cleanup(g.stop)
	return g
}

func (g *guild) stop() {
	if g.ln != nil {
		g.ln.Close()
		g.ln = nil
		g.srv.Close()
	}
}

// member is one member session, as deskd relays it.
type member struct {
	t    *testing.T
	c    *relay.Conn
	in   chan map[string]any
	gone chan struct{}
	idx  float64
	w    map[string]any      // the welcome
	acks atomic.Int64        // board acks received
	json chan map[string]any // JSON frames from Commons to deskd
}

func caller(id, role, name, badge string, grants ...string) map[string]any {
	if grants == nil {
		grants = []string{}
	}
	var b any
	if badge != "" {
		b = badge
	}
	return map[string]any{"kind": "guild_member", "memberId": id, "role": role, "grants": grants, "name": name, "badge": b, "teen": false}
}

func (g *guild) join(cl map[string]any) *member {
	g.t.Helper()
	c, err := relay.Dial(g.sock)
	if err != nil {
		g.t.Fatal(err)
	}
	m := &member{t: g.t, c: c, in: make(chan map[string]any, 4096), gone: make(chan struct{}), json: make(chan map[string]any, 64)}
	go func() {
		defer close(m.gone)
		for {
			typ, body, err := c.ReadFrame()
			if err != nil {
				return
			}
			if typ == relay.JSON {
				var v map[string]any
				if json.Unmarshal(body, &v) == nil {
					m.json <- v
				}
				continue
			}
			if typ != relay.Link {
				continue
			}
			_ = wire.Each(body, func(rt byte, p []byte) error {
				if rt == wire.BoardAck {
					m.acks.Add(1)
				}
				if rt == wire.Ctrl {
					var v map[string]any
					if json.Unmarshal(p, &v) == nil {
						m.in <- v
					}
				}
				return nil
			})
		}
	}()
	g.t.Cleanup(func() { c.Close() })
	if err := c.WriteJSON(map[string]any{"t": "hello", "sessionId": "cs-test", "sub": cl["memberId"], "caller": cl}); err != nil {
		g.t.Fatal(err)
	}
	// The client's own hello carries a name, which must be ignored.
	m.send(map[string]any{"t": "hello", "v": ProtocolVersion, "name": "Someone Else"})
	m.w = m.expect("welcome", nil)
	m.idx = m.w["you"].(map[string]any)["i"].(float64)
	return m
}

func (m *member) send(v any) {
	b, _ := json.Marshal(v)
	if err := m.c.WriteFrame(relay.Link, wire.Append(nil, wire.Ctrl, b), time.Second); err != nil {
		m.t.Fatal(err)
	}
}

// expect waits for a control message of type t that ok accepts (nil: any).
func (m *member) expect(t string, ok func(map[string]any) bool) map[string]any {
	m.t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case v := <-m.in:
			if v["t"] == t && (ok == nil || ok(v)) {
				return v
			}
		case <-deadline:
			m.t.Fatalf("no %q", t)
			return nil
		}
	}
}

func (m *member) expectError(reason string) {
	m.t.Helper()
	m.expect("error", func(v map[string]any) bool { return v["reason"] == reason })
}

func TestIdentityComesFromDeskd(t *testing.T) {
	g := newGuild(t, t.TempDir(), 0)
	a := g.join(caller("gm-ana001", "lead", "Ana", "lead"))
	b := g.join(caller("gm-ben001", "member", "Ben", ""))
	mm := a.expect("member", func(v map[string]any) bool { return v["m"].(map[string]any)["id"] == "gm-ben001" })["m"].(map[string]any)
	if mm["name"] != "Ben" || mm["role"] != "member" || mm["badge"] != nil {
		t.Fatalf("Ben as Ana sees him: %v", mm)
	}
	if _, ok := mm["teen"]; ok {
		t.Fatal("an age marker reached a member")
	}
	b.send(map[string]any{"t": "ping", "n": 1})
	b.expect("pong", nil)
	_ = b
}

func TestChannelsNeedManageSpaces(t *testing.T) {
	g := newGuild(t, t.TempDir(), 3)
	lead := g.join(caller("gm-ana001", "lead", "Ana", "lead"))
	off := g.join(caller("gm-ofc001", "officer", "Oli", "officer", "moderate"))
	mem := g.join(caller("gm-mem001", "member", "Mo", ""))

	mem.send(map[string]any{"t": "channel", "op": "create", "name": "Design"})
	mem.expectError("forbidden")
	off.send(map[string]any{"t": "channel", "op": "create", "name": "Design"})
	off.expectError("forbidden")

	lead.send(map[string]any{"t": "channel", "op": "create", "name": "Design review"})
	list := mem.expect("channels", nil)["list"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["id"] != MainChannel || list[1].(map[string]any)["name"] != "Design review" {
		t.Fatalf("channels: %v", list)
	}
	design := list[1].(map[string]any)["id"].(string)
	// The maker moves into it; the others stay in main.
	lead.expect("channel", func(v map[string]any) bool { return v["ch"] == design })
	lead.send(map[string]any{"t": "channel", "op": "create", "name": "design REVIEW"})
	lead.expectError("name-taken")

	// An officer granted manage_spaces at the next refresh can make one at once.
	if err := off.c.WriteJSON(map[string]any{"t": "caller", "caller": caller("gm-ofc001", "officer", "Oli", "officer", "moderate", "manage_spaces")}); err != nil {
		t.Fatal(err)
	}
	you := off.expect("you", nil)
	if !you["can"].(map[string]any)["manage"].(bool) {
		t.Fatalf("after the refresh: %v", you)
	}
	off.send(map[string]any{"t": "channel", "op": "create", "name": "Sales"})
	off.expect("channel", nil)
	off.send(map[string]any{"t": "channel", "op": "create", "name": "One too many"})
	off.expectError("limit")

	// The member looks at Design review; deleting it brings them back to main.
	mem.send(map[string]any{"t": "channel", "op": "switch", "id": design})
	mem.expect("channel", func(v map[string]any) bool { return v["ch"] == design })
	off.send(map[string]any{"t": "channel", "op": "rename", "id": design, "name": "Design"})
	mem.expect("channels", func(v map[string]any) bool { return strings.Contains(string(mustJSON(v)), `"Design"`) })
	off.send(map[string]any{"t": "channel", "op": "delete", "id": MainChannel})
	off.expectError("main")
	off.send(map[string]any{"t": "channel", "op": "delete", "id": design})
	mem.expect("channel", func(v map[string]any) bool { return v["ch"] == MainChannel })
	mem.expect("channels", func(v map[string]any) bool { return len(v["list"].([]any)) == 2 })
	if _, err := os.Stat(filepath.Join(g.data, "commons", "channels", design)); !os.IsNotExist(err) {
		t.Fatal("a deleted channel's files are still there")
	}

	// A grant taken away at a refresh stops at once.
	if err := off.c.WriteJSON(map[string]any{"t": "caller", "caller": caller("gm-ofc001", "officer", "Oli", "officer")}); err != nil {
		t.Fatal(err)
	}
	off.expect("you", nil)
	off.send(map[string]any{"t": "channel", "op": "create", "name": "Again"})
	off.expectError("forbidden")

	audit, _ := os.ReadFile(filepath.Join(g.data, "commons", "audit.log"))
	for _, act := range []string{"channel.create", "channel.rename", "channel.delete"} {
		if !strings.Contains(string(audit), act) {
			t.Fatalf("audit has no %s:\n%s", act, audit)
		}
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestSettingsPersist(t *testing.T) {
	data := t.TempDir()
	g := newGuild(t, data, 10)
	lead := g.join(caller("gm-ana001", "lead", "Ana", "lead"))
	mem := g.join(caller("gm-mem001", "member", "Mo", ""))
	mem.send(map[string]any{"t": "settings", "joinMuted": true})
	mem.expect("error", func(v map[string]any) bool { return v["code"] == "settings" && v["reason"] == "forbidden" })
	lead.send(map[string]any{"t": "settings", "maxChannels": 11})
	lead.expect("error", func(v map[string]any) bool { return v["reason"] == "max-channels" })
	lead.send(map[string]any{"t": "settings", "joinMuted": true, "maxChannels": 4})
	s := mem.expect("settings", nil)
	if st := s["settings"].(map[string]any); st["joinMuted"] != true || st["maxChannels"].(float64) != 4 || s["max"].(float64) != 4 {
		t.Fatalf("settings: %v", s)
	}
	g.stop()

	g2 := newGuild(t, data, 3) // the roster's ceiling went down
	w := map[string]any{}
	c := g2.join(caller("gm-mem001", "member", "Mo", ""))
	_ = c
	// join() consumed the welcome; ask again through a fresh session to read its settings.
	cl, _ := relay.Dial(g2.sock)
	defer cl.Close()
	cl.WriteJSON(map[string]any{"t": "hello", "sub": "gm-mem002", "caller": caller("gm-mem002", "member", "May", "")})
	b, _ := json.Marshal(map[string]any{"t": "hello", "v": ProtocolVersion})
	cl.WriteFrame(relay.Link, wire.Append(nil, wire.Ctrl, b), time.Second)
	for w["t"] != "welcome" {
		_, body, err := cl.ReadFrame()
		if err != nil {
			t.Fatal(err)
		}
		wire.Each(body, func(rt byte, p []byte) error {
			if rt == wire.Ctrl {
				var v map[string]any
				if json.Unmarshal(p, &v) == nil && v["t"] == "welcome" {
					w = v
				}
			}
			return nil
		})
	}
	st := w["settings"].(map[string]any)
	if st["settings"].(map[string]any)["joinMuted"] != true || st["max"].(float64) != 3 || st["ceiling"].(float64) != 3 {
		t.Fatalf("after a restart: %v", st)
	}
	if w["can"].(map[string]any)["manage"] != false {
		t.Fatal("a member can manage")
	}
}

func TestChatThreads(t *testing.T) {
	data := t.TempDir()
	g := newGuild(t, data, 10)
	ana := g.join(caller("gm-ana001", "lead", "Ana", "lead"))
	ben := g.join(caller("gm-ben001", "member", "Ben", ""))
	mod := g.join(caller("gm-ofc001", "officer", "Oli", "officer", "moderate"))
	plain := g.join(caller("gm-ofc002", "officer", "Pat", "officer"))

	ben.send(map[string]any{"t": "chat-send", "ch": "main", "nonce": "n1", "text": "Standup moved to 10:15, see https://example.com/notes"})
	mine := ben.expect("chat", nil)["m"].(map[string]any)
	if mine["nonce"] != "n1" || mine["seq"].(float64) != 1 || mine["from"] != "gm-ben001" || mine["name"] != "Ben" {
		t.Fatalf("Ben's ack: %v", mine)
	}
	theirs := ana.expect("chat", nil)["m"].(map[string]any)
	if _, ok := theirs["nonce"]; ok || theirs["text"] != mine["text"] {
		t.Fatalf("Ana's copy: %v", theirs)
	}
	// A resend after a drop gets the same message back, not a copy.
	ben.send(map[string]any{"t": "chat-send", "ch": "main", "nonce": "n1", "text": "Standup moved to 10:15, see https://example.com/notes"})
	if again := ben.expect("chat", nil)["m"].(map[string]any); again["seq"].(float64) != 1 {
		t.Fatalf("a resend made seq %v", again["seq"])
	}

	ana.send(map[string]any{"t": "chat-edit", "ch": "main", "seq": 1, "text": "hijacked"})
	ana.expectError("not-yours")
	ben.send(map[string]any{"t": "chat-edit", "ch": "main", "seq": 1, "text": "Standup moved to 10:30"})
	if e := ana.expect("chat-edit", nil)["m"].(map[string]any); e["text"] != "Standup moved to 10:30" || e["edited"] == nil {
		t.Fatalf("edit: %v", e)
	}
	plain.send(map[string]any{"t": "chat-delete", "ch": "main", "seq": 1})
	plain.expectError("not-yours")
	mod.send(map[string]any{"t": "chat-delete", "ch": "main", "seq": 1})
	if d := ben.expect("chat-delete", nil); d["seq"].(float64) != 1 || d["mod"] != true {
		t.Fatalf("delete: %v", d)
	}
	audit, _ := os.ReadFile(filepath.Join(data, "commons", "audit.log"))
	if !strings.Contains(string(audit), `"act":"chat.delete"`) || !strings.Contains(string(audit), `"author":"gm-ben001"`) || strings.Contains(string(audit), "Standup") {
		t.Fatalf("audit:\n%s", audit)
	}

	ben.send(map[string]any{"t": "chat-send", "ch": "main", "nonce": "n2", "text": strings.Repeat("a", 4001)})
	ben.expectError("too-long")
	for i := 0; i < 12; i++ {
		ana.send(map[string]any{"t": "chat-send", "ch": "main", "nonce": "a" + string(rune('a'+i)), "text": "msg"})
	}
	ana.expectError("rate")

	// Each channel has its own thread.
	ana.send(map[string]any{"t": "channel", "op": "create", "name": "Release"})
	rel := ana.expect("channel", nil)["ch"].(string)
	time.Sleep(600 * time.Millisecond)
	ana.send(map[string]any{"t": "chat-send", "ch": rel, "nonce": "r1", "text": "Release notes are in the board"})
	ana.expect("chat", func(v map[string]any) bool { return v["ch"] == rel })
	g.stop()

	g2 := newGuild(t, data, 10)
	c := g2.join(caller("gm-ben001", "member", "Ben", ""))
	page := c.expect("chat-page", nil)
	msgs := page["msgs"].([]any)
	if page["ch"] != "main" || len(msgs) < 1 {
		t.Fatalf("main after a restart: %v", page)
	}
	for _, m := range msgs {
		if m.(map[string]any)["seq"].(float64) == 1 {
			t.Fatal("a deleted message came back")
		}
	}
	c.send(map[string]any{"t": "channel", "op": "switch", "id": rel})
	rp := c.expect("chat-page", func(v map[string]any) bool { return v["ch"] == rel })
	if rm := rp["msgs"].([]any); len(rm) != 1 || rm[0].(map[string]any)["text"] != "Release notes are in the board" {
		t.Fatalf("Release after a restart: %v", rp)
	}
	c.send(map[string]any{"t": "chat-history", "ch": "main", "before": 3, "limit": 5})
	if h := c.expect("chat-page", func(v map[string]any) bool { return v["before"] != nil }); len(h["msgs"].([]any)) != 1 {
		t.Fatalf("history before 3: %v", h)
	}
}

func TestOneVoicePerMemberAndCallerRules(t *testing.T) {
	g := newGuild(t, t.TempDir(), 0)
	tab1 := g.join(caller("gm-ana001", "member", "Ana", ""))
	tab2 := g.join(caller("gm-ana001", "member", "Ana", ""))
	tab1.send(map[string]any{"t": "join", "muted": true})
	tab1.expect("member", func(v map[string]any) bool { return v["m"].(map[string]any)["in"] == true })
	tab2.send(map[string]any{"t": "join", "muted": true})
	tab1.expect("moved", nil)

	// A refresh may change the name, never the member.
	tab2.c.WriteJSON(map[string]any{"t": "caller", "caller": caller("gm-ana001", "member", "Ana Lopez", "")})
	if m := tab1.expect("member", func(v map[string]any) bool { return v["m"].(map[string]any)["name"] == "Ana Lopez" }); m == nil {
		t.Fatal("no rename")
	}
	tab2.c.WriteJSON(map[string]any{"t": "caller", "caller": caller("gm-someone", "lead", "Ana", "")})
	select {
	case <-tab2.gone:
	case <-time.After(3 * time.Second):
		t.Fatal("a caller frame that changed the member didn't end the connection")
	}
	tab1.expect("gone", nil)
}

func TestOldRoomCarriesOver(t *testing.T) {
	data := t.TempDir()
	// Task 21's layout: room.json and boards/ at the room's root.
	g := newGuild(t, data, 0)
	a := g.join(caller("gm-ana001", "member", "Ana", ""))
	a.send(map[string]any{"t": "join"})
	a.send(map[string]any{"t": "boards", "op": "rename", "id": a.w["boards"].(map[string]any)["active"], "name": "Sprint plan"})
	a.expect("boards", func(v map[string]any) bool { return strings.Contains(string(mustJSON(v)), "Sprint plan") })
	g.stop()
	if _, err := os.Stat(filepath.Join(data, "commons", "room.json")); err != nil {
		t.Fatal("main's boards moved")
	}
	g2 := newGuild(t, data, 0)
	b := g2.join(caller("gm-ben001", "member", "Ben", ""))
	b.send(map[string]any{"t": "boards", "op": "list"})
	b.expect("boards", func(v map[string]any) bool { return strings.Contains(string(mustJSON(v)), "Sprint plan") })
}

func TestBoardUpdatesArePaced(t *testing.T) {
	old := boardRateNow.Load()
	t.Cleanup(func() { boardRateNow.Store(old) })
	set := func(perSec, burst float64, maxWait time.Duration) {
		r := *old
		r.PerSec, r.Burst, r.MaxWait = perSec, burst, maxWait
		boardRateNow.Store(&r)
	}
	set(40, 10, 5*time.Second)
	g := newGuild(t, t.TempDir(), 0)
	a := g.join(caller("gm-ana001", "member", "Ana", ""))
	a.send(map[string]any{"t": "join"})
	a.expect("member", func(v map[string]any) bool { return v["m"].(map[string]any)["in"] == true })
	board := a.w["boards"].(map[string]any)["active"].(string)
	update := func(ref uint32) {
		if err := a.c.WriteFrame(relay.Link, wire.Append(nil, wire.BoardUpdate, wire.BoardPrefix(board), wire.U32(ref), []byte("a yjs update")), time.Second); err != nil {
			t.Fatal(err)
		}
	}
	// 50 at once: the first 10 go at once, the rest at 40 a second, and none is lost.
	start := time.Now()
	for i := uint32(1); i <= 50; i++ {
		update(i)
	}
	deadline := time.Now().Add(5 * time.Second)
	for a.acks.Load() < 50 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	took := time.Since(start)
	if a.acks.Load() != 50 {
		t.Fatalf("%d of 50 updates acked", a.acks.Load())
	}
	if took < 900*time.Millisecond {
		t.Fatalf("50 updates went through in %v; the rate would take about 1 s", took)
	}
	// A member who'd have to wait past the limit is cut off.
	set(1, 10, 200*time.Millisecond)
	for i := uint32(51); i <= 80; i++ {
		// Writes may fail once it's cut off; that's the point.
		_ = a.c.WriteFrame(relay.Link, wire.Append(nil, wire.BoardUpdate, wire.BoardPrefix(board), wire.U32(i), []byte("a yjs update")), time.Second)
	}
	select {
	case <-a.gone:
	case <-time.After(5 * time.Second):
		t.Fatal("a member far past the board rate wasn't cut off")
	}
}

func TestUsageGoesToDeskd(t *testing.T) {
	g := newGuild(t, t.TempDir(), 0)
	a := g.join(caller("gm-ana001", "member", "Ana", ""))
	b := g.join(caller("gm-ben001", "member", "Ben", ""))
	ev := g.srv.VoiceEvents()
	next := func(m *member) map[string]any {
		t.Helper()
		select {
		case v := <-m.json:
			return v
		case <-time.After(2 * time.Second):
			t.Fatal("no usage frame")
			return nil
		}
	}
	// What the SFU reports for Ana's voice connection reaches deskd on Ana's session, in order, and only hers.
	ev.Usage(uint16(a.idx), 4096, false)
	ev.Usage(uint16(a.idx), 9000, false)
	ev.Usage(uint16(a.idx), 12000, true)
	ev.Usage(uint16(a.idx), 300, false) // a new voice connection, from 0
	for _, want := range []map[string]any{
		{"t": "usage", "voiceBytesSent": 4096.0},
		{"t": "usage", "voiceBytesSent": 9000.0},
		{"t": "usage", "voiceBytesSent": 12000.0, "final": true},
		{"t": "usage", "voiceBytesSent": 300.0},
	} {
		got := next(a)
		if string(mustJSON(got)) != string(mustJSON(want)) {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	select {
	case v := <-b.json:
		t.Fatalf("Ben's session got Ana's usage: %v", v)
	case <-time.After(200 * time.Millisecond):
	}
}

// Security's GDS-6: past the channel's budget an update is refused, not stored or relayed, and the member is told; a
// board past the channel's cap of boards is refused too.
func TestBoardsHaveAChannelBudget(t *testing.T) {
	oldBytes, oldBoards := store.ChannelBytes, store.MaxBoards
	t.Cleanup(func() { store.ChannelBytes, store.MaxBoards = oldBytes, oldBoards })
	store.ChannelBytes, store.MaxBoards = 64, 1

	g := newGuild(t, t.TempDir(), 0)
	a := g.join(caller("gm-ana001", "member", "Ana", ""))
	a.send(map[string]any{"t": "join"})
	a.expect("member", func(v map[string]any) bool { return v["m"].(map[string]any)["in"] == true })
	board := a.w["boards"].(map[string]any)["active"].(string)
	update := func(ref uint32, n int) {
		if err := a.c.WriteFrame(relay.Link, wire.Append(nil, wire.BoardUpdate, wire.BoardPrefix(board), wire.U32(ref), []byte(strings.Repeat("u", n))), time.Second); err != nil {
			t.Fatal(err)
		}
	}
	update(1, 40)
	deadline := time.Now().Add(3 * time.Second)
	for a.acks.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if a.acks.Load() != 1 {
		t.Fatal("an update within the budget wasn't acked")
	}
	update(2, 40)
	a.expect("error", func(v map[string]any) bool { return v["code"] == "full" && v["id"] == board })
	if a.acks.Load() != 1 {
		t.Fatal("an update past the budget was acked")
	}

	// The channel's one board is all it may have here.
	a.send(map[string]any{"t": "boards", "op": "new", "name": "Second"})
	a.expect("error", func(v map[string]any) bool { return v["code"] == "boards" })
}
