package main

// The island phase (ADR 0075, desk-runtime.md section 8.8): input through the real desk-rtc into real kiosk Chromium while
// an island is set, by fake-deskd's test.stream.crop. Clicks carry the island's epoch in byte 3 and are normalized to the
// island's picture; the page reports where each mousedown landed. A <select> opens Chromium's own popup, a top-level X
// window over the island, and a press on it must be refused.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"html"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

const islandHTML = `<!doctype html><meta charset="utf-8"><title>island</title>
<style>html,body{margin:0;background:#eef;overflow:hidden;font:20px sans-serif}
#pl{position:fixed;left:320px;top:180px;width:1280px;height:720px;background:#334}
#sel{position:fixed;left:400px;top:800px;width:300px;font:20px sans-serif}
#pop{position:fixed;left:1700px;top:100px;width:150px;height:80px;background:#c33}</style>
<div id="pl"></div><div id="pop"></div>
<select id="sel"><option>zero</option><option>one</option><option>two</option><option>three</option><option>four</option></select>
<script>
const s = { id: Math.round(performance.timeOrigin) % 100000, md: 0, mu: 0, mx: -1, my: -1, kd: 0, lk: '', sel: 0 };
const pub = () => { document.title = 'I' + JSON.stringify(s); };
addEventListener('mousedown', (e) => { s.md++; s.mx = e.clientX; s.my = e.clientY; pub(); }, true);
addEventListener('mouseup', () => { s.mu++; pub(); }, true);
addEventListener('keydown', (e) => { s.kd++; s.lk = e.key; pub(); }, true);
document.getElementById('sel').addEventListener('change', (e) => { s.sel = e.target.selectedIndex; pub(); });
// T47S-1: the first press of a double-click opens a screen-sized window, so the second would land on it.
document.getElementById('pop').addEventListener('mousedown', () => {
  window.open(location.pathname + '?popup', 'pop', 'popup,left=0,top=0,width=1920,height=1080');
});
setInterval(pub, 50);
pub();
</script>`

// popupHTML is the window the island page opens: it reports any press or key that reaches it.
const popupHTML = `<!doctype html><meta charset="utf-8"><title>popup</title>
<style>html,body{margin:0;width:100%;height:100%;background:#fdd}</style>
<script>
const s = { md: 0, mu: 0, mx: -1, my: -1, kd: 0, lk: '', sel: 0 };
const pub = () => { document.title = 'I' + JSON.stringify(s); };
addEventListener('mousedown', (e) => { s.md++; s.mx = e.clientX; s.my = e.clientY; pub(); }, true);
addEventListener('keydown', (e) => { s.kd++; s.lk = e.key; pub(); }, true);
setInterval(pub, 50);
pub();
</script>`

type islandState struct {
	MD  int    `json:"md"`
	MU  int    `json:"mu"`
	MX  int    `json:"mx"`
	MY  int    `json:"my"`
	KD  int    `json:"kd"`
	LK  string `json:"lk"`
	Sel int    `json:"sel"`
}

func readIsland() *islandState { return readTitle("?island") }

func readTitle(query string) *islandState {
	t := tab(query)
	if t == nil || len(t.Title) < 2 || t.Title[0] != 'I' {
		return nil
	}
	var s islandState
	if json.Unmarshal([]byte(html.UnescapeString(t.Title[1:])), &s) != nil {
		return nil
	}

	return &s
}

func waitIsland(ok func(*islandState) bool, d time.Duration) *islandState {
	end := time.Now().Add(d)
	var last *islandState
	for {
		if s := readIsland(); s != nil {
			last = s
			if ok(s) {
				return s
			}
		}
		if time.Now().After(end) {
			return last
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// islandEvent is one 16-byte event with byte 3 set (section 8.6, 8.8).
func (s *session) islandEvent(kind, down, button, epoch byte, x, y uint16, last uint32) {
	b := make([]byte, 16)
	b[0], b[1], b[2], b[3] = kind, down, button, epoch
	binary.BigEndian.PutUint32(b[4:], s.seq.Add(1))
	binary.BigEndian.PutUint16(b[8:], x)
	binary.BigEndian.PutUint16(b[10:], y)
	binary.BigEndian.PutUint32(b[12:], last)
	if err := s.conn.SendInput(7, b); err != nil {
		fail("send: %v", err)
	}
}

// islandClick presses and releases at a point given as fractions of the picture.
func (s *session) islandClick(epoch byte, fx, fy float64) {
	x, y := uint16(fx*65535+0.5), uint16(fy*65535+0.5)
	s.islandEvent(2, 1, 1, epoch, x, y, 0)
	time.Sleep(30 * time.Millisecond)
	s.islandEvent(2, 0, 1, epoch, x, y, 0)
}

func (s *session) setCrop(c map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.conn.Call(ctx, "test.stream.crop", map[string]any{"crop": c}); err != nil {
		fail("test.stream.crop: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
}

func (s *session) streamStats() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := s.conn.Call(ctx, "test.rtc.stats", nil)
	if err != nil {
		fail("test.rtc.stats: %v", err)

		return nil
	}
	var m struct {
		Stream map[string]any `json:"stream"`
	}
	_ = json.Unmarshal(raw, &m)

	return m.Stream
}

// xWindow is a mapped top-level window of :99, as the report records it.
type xWindow struct {
	ID       uint32 `json:"id"`
	X, Y     int
	W, H     int
	Override bool   `json:"overrideRedirect"`
	Role     string `json:"role"`
}

// topWindows lists the mapped top-level windows of :99, bottom to top, and the window with X's keyboard focus.
func topWindows() ([]xWindow, uint32) {
	c, err := xgb.NewConnDisplay(":99")
	if err != nil {
		fail("X: %v", err)

		return nil, 0
	}
	defer c.Close()
	root := xproto.Setup(c).DefaultScreen(c).Root
	role, err := xproto.InternAtom(c, false, uint16(len("WM_WINDOW_ROLE")), "WM_WINDOW_ROLE").Reply()
	if err != nil {
		return nil, 0
	}
	tree, err := xproto.QueryTree(c, root).Reply()
	if err != nil {
		return nil, 0
	}
	var out []xWindow
	for _, w := range tree.Children {
		a, err := xproto.GetWindowAttributes(c, w).Reply()
		if err != nil || a.MapState != xproto.MapStateViewable {
			continue
		}
		g, err := xproto.GetGeometry(c, xproto.Drawable(w)).Reply()
		if err != nil {
			continue
		}
		v := xWindow{ID: uint32(w), X: int(g.X), Y: int(g.Y), W: int(g.Width), H: int(g.Height), Override: a.OverrideRedirect}
		if p, err := xproto.GetProperty(c, false, w, role.Atom, xproto.AtomString, 0, 64).Reply(); err == nil {
			v.Role = string(p.Value)
		}
		out = append(out, v)
	}
	var focus uint32
	if f, err := xproto.GetInputFocus(c).Reply(); err == nil {
		focus = uint32(f.Focus)
	}

	return out, focus
}

// popups lists the mapped top-level windows of :99 that don't cover the screen: Chromium's popups and bubbles.
func popups() []xproto.Rectangle {
	c, err := xgb.NewConnDisplay(":99")
	if err != nil {
		fail("X: %v", err)

		return nil
	}
	defer c.Close()
	root := xproto.Setup(c).DefaultScreen(c).Root
	tree, err := xproto.QueryTree(c, root).Reply()
	if err != nil {
		return nil
	}
	var out []xproto.Rectangle
	for _, w := range tree.Children {
		a, err := xproto.GetWindowAttributes(c, w).Reply()
		if err != nil || a.MapState != xproto.MapStateViewable {
			continue
		}
		g, err := xproto.GetGeometry(c, xproto.Drawable(w)).Reply()
		if err != nil || (g.Width >= 1920 && g.Height >= 1080) {
			continue
		}
		out = append(out, xproto.Rectangle{X: g.X, Y: g.Y, Width: g.Width, Height: g.Height})
	}

	return out
}

func (s *session) blocked() float64 {
	b, _ := s.streamStats()["islandBlocked"].(float64)

	return b
}

func waitPopups() []xproto.Rectangle {
	var pop []xproto.Rectangle
	for range 40 {
		if pop = popups(); len(pop) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	return pop
}

// closeSelectPopup ends the island and closes the select's popup with a press beside it on the whole screen, as on any
// page (the popup may keep that press for itself).
func (s *session) closeSelectPopup() {
	s.setCrop(nil)
	s.islandClick(0, 1400.0/1919, 1000.0/1079)
	time.Sleep(300 * time.Millisecond)
	if len(popups()) != 0 {
		fail("island popup: the select's popup didn't close")
	}
}

// phaseCover is Security's T47S-1: a window over the island that holds all of it isn't the page, and keys don't go
// while another window has X's focus. Each case passed the check in desk-rtc 0.3.6.
func (s *session) phaseCover(res map[string]any) {
	// 1. The select's popup over a small island inside it.
	s.setCrop(nil)
	s.islandClick(0, 550.0/1919, 815.0/1079)
	pop := waitPopups()
	if len(pop) == 0 {
		fail("cover: the select opened no popup")

		return
	}
	p := pop[0]
	small := map[string]any{"epoch": 9, "x": int(p.X) + 40, "y": int(p.Y) + 40, "w": 64, "h": 64, "outW": 64, "outH": 64}
	s.setCrop(small)
	b0 := s.blocked()
	s.islandClick(9, 0.5, 0.5)
	time.Sleep(400 * time.Millisecond)
	st, b1 := readIsland(), s.blocked()
	if st != nil && st.Sel != 0 {
		fail("cover: a press on the select's popup, bigger than the island, chose option %d", st.Sel)
	}
	if b1 <= b0 {
		fail("cover: a press under a popup bigger than the island wasn't refused (%v to %v)", b0, b1)
	}
	res["popup bigger than the island"] = map[string]any{"popup": []int{int(p.X), int(p.Y), int(p.Width), int(p.Height)}, "island": small, "selected": st.Sel, "refused": b1 > b0}
	s.closeSelectPopup()

	// 2. A screen-sized window.open from the first press of a double-click: the second press would land on it.
	const ix, iy, iw, ih = 1650, 40, 260, 200
	s.setCrop(map[string]any{"epoch": 10, "x": ix, "y": iy, "w": iw, "h": ih, "outW": iw, "outH": ih, "keys": true})
	fx, fy := float64(1775-ix)/(iw-1), float64(140-iy)/(ih-1)
	before := readIsland()
	s.islandClick(10, fx, fy)
	var pp *islandState
	for range 100 {
		if pp = readTitle("?popup"); pp != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if after := waitIsland(func(v *islandState) bool { return before != nil && v.MD > before.MD }, 2*time.Second); after == nil || before == nil || after.MD == before.MD {
		fail("cover: the first press didn't reach the page")
	}
	if pp == nil {
		fail("cover: window.open opened no window, so the case wasn't exercised")

		return
	}
	time.Sleep(500 * time.Millisecond) // mapped and focused
	wins, focus := topWindows()
	res["window.open windows"], res["window.open focus"] = wins, focus
	b0 = s.blocked()
	s.islandClick(10, fx, fy)
	time.Sleep(400 * time.Millisecond)
	pp, b1 = readTitle("?popup"), s.blocked()
	if pp != nil && pp.MD != 0 {
		fail("cover: the screen-sized window got the island's press at %d,%d", pp.MX, pp.MY)
	}
	if b1 <= b0 {
		fail("cover: a press under the screen-sized window wasn't refused (%v to %v)", b0, b1)
	}

	// 3. Keys while that window has X's focus: refused, though deskd allows keys.
	kd := 0
	if st := readIsland(); st != nil {
		kd = st.KD
	}
	s.islandEvent(4, 1, 0, 10, 0, 0, 'q')
	s.islandEvent(4, 0, 0, 10, 0, 0, 'q')
	time.Sleep(400 * time.Millisecond)
	pp, b2 := readTitle("?popup"), s.blocked()
	if pp != nil && pp.KD != 0 {
		fail("cover: a key reached the window that took the focus (%q)", pp.LK)
	}
	if st := readIsland(); st != nil && st.KD != kd {
		fail("cover: a key went with the focus outside the kiosk's window")
	}
	if b2 <= b1 {
		fail("cover: a key with the focus on another window wasn't refused (%v to %v)", b1, b2)
	}
	res["screen-sized window.open"] = map[string]any{"press": "refused", "key": "refused", "islandBlocked": b2}

	// It closes: the island works again, presses and then keys.
	if t := tab("?popup"); t != nil {
		cdpGet("/json/close/" + t.ID)
	}
	time.Sleep(500 * time.Millisecond)
	before = readIsland()
	s.islandClick(10, 0.1, 0.9)
	st = waitIsland(func(v *islandState) bool { return before != nil && v.MD > before.MD }, 2*time.Second)
	if st == nil || before == nil || st.MD == before.MD {
		fail("cover: after the window closed, a press on the island didn't arrive")
	}
	s.islandEvent(4, 1, 0, 10, 0, 0, 'w')
	s.islandEvent(4, 0, 0, 10, 0, 0, 'w')
	if st := waitIsland(func(v *islandState) bool { return v.KD > kd }, 2*time.Second); st == nil || st.LK != "w" {
		_, f := topWindows()
		fail("cover: after the window closed, an allowed key didn't arrive (focus 0x%x)", f)
	} else {
		res["after the window closed"] = "press and key arrive"
	}
	s.setCrop(nil)
}

func near(a, b int) bool { return a-b <= 1 && b-a <= 1 }

func phaseIsland(s *session) {
	res := map[string]any{}
	report["island"] = res
	openPage("?island")
	st0 := waitIsland(func(*islandState) bool { return true }, 5*time.Second)
	if st0 == nil {
		fail("island: the page never reported")

		return
	}
	click := func(name string, epoch byte, fx, fy float64, wantX, wantY int) {
		before := readIsland()
		s.islandClick(epoch, fx, fy)
		if wantX < 0 {
			time.Sleep(300 * time.Millisecond)
			if st := readIsland(); st != nil && before != nil && st.MD != before.MD {
				fail("island %s: a press landed at %d,%d; it should have been dropped", name, st.MX, st.MY)
			}
			res[name] = "dropped"

			return
		}
		st := waitIsland(func(v *islandState) bool { return before != nil && v.MD > before.MD && v.MU > before.MU }, 2*time.Second)
		if st == nil || before == nil || st.MD == before.MD {
			fail("island %s: no click arrived", name)

			return
		}
		if !near(st.MX, wantX) || !near(st.MY, wantY) {
			fail("island %s: landed at %d,%d, want %d,%d", name, st.MX, st.MY, wantX, wantY)
		}
		res[name] = []int{st.MX, st.MY}
	}

	// No island: the whole screen, epoch 0, as ever; an island's epoch goes nowhere.
	click("whole screen", 0, 960.0/1920, 540.0/1080, 960, 540)
	click("whole screen, epoch 7", 7, 0.5, 0.5, -1, -1)

	// Island 7 over the player, sent at 640x360: a quarter across and half down the picture is 640,540 on the page.
	s.setCrop(map[string]any{"epoch": 7, "x": 320, "y": 180, "w": 1280, "h": 720, "outW": 640, "outH": 360})
	click("island 7", 7, 0.25, 0.5, 640, 540)
	click("island 7, corner", 7, 0, 0, 320, 180)
	click("island 7, far corner", 7, 1, 1, 1599, 899)
	click("island 7, epoch 0", 0, 0.25, 0.5, -1, -1)
	click("island 7, epoch 6", 6, 0.25, 0.5, -1, -1)
	// The island moved with the page: same epoch, the same point of the picture follows it.
	s.setCrop(map[string]any{"epoch": 7, "x": 0, "y": 0, "w": 1280, "h": 720, "outW": 640, "outH": 360})
	click("island 7 moved", 7, 0.25, 0.5, 320, 360)

	// Keys: not while deskd hasn't allowed them, then yes.
	before := readIsland()
	s.islandEvent(4, 1, 0, 7, 0, 0, 'q')
	s.islandEvent(4, 0, 0, 7, 0, 0, 'q')
	time.Sleep(300 * time.Millisecond)
	if st := readIsland(); st != nil && before != nil && st.KD != before.KD {
		fail("island keys: a key went before deskd allowed keys")
	}
	s.setCrop(map[string]any{"epoch": 7, "x": 0, "y": 0, "w": 1280, "h": 720, "outW": 640, "outH": 360, "keys": true})
	s.islandEvent(4, 1, 0, 7, 0, 0, 'q')
	s.islandEvent(4, 0, 0, 7, 0, 0, 'q')
	if st := waitIsland(func(v *islandState) bool { return before != nil && v.KD > before.KD }, 2*time.Second); st == nil || st.LK != "q" {
		fail("island keys: an allowed key didn't arrive")
	} else {
		res["keys"] = "dropped until allowed, then q"
	}

	// Island 8 over the select and below it. Open the select's popup, then press on the popup: refused.
	s.setCrop(map[string]any{"epoch": 8, "x": 320, "y": 540, "w": 1280, "h": 540, "outW": 640, "outH": 270})
	fx, fy := func(px int) float64 { return float64(px-320) / 1279 }, func(py int) float64 { return float64(py-540) / 539 }
	click("island 8, the select", 8, fx(550), fy(815), 550, 815)
	var pop []xproto.Rectangle
	for range 40 {
		if pop = popups(); len(pop) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(pop) == 0 {
		fail("island popup: the select opened no popup window, so the check wasn't exercised")
	} else {
		p := pop[0]
		res["popup"] = []int{int(p.X), int(p.Y), int(p.Width), int(p.Height)}
		blocked0, _ := s.streamStats()["islandBlocked"].(float64)
		px, py := int(p.X)+int(p.Width)/2, int(p.Y)+int(p.Height)*3/4
		s.islandClick(8, fx(px), fy(py))
		time.Sleep(400 * time.Millisecond)
		st := readIsland()
		blocked1, _ := s.streamStats()["islandBlocked"].(float64)
		if st != nil && st.Sel != 0 {
			fail("island popup: a press on the popup chose option %d", st.Sel)
		}
		if blocked1 <= blocked0 {
			fail("island popup: islandBlocked didn't count it (%v to %v)", blocked0, blocked1)
		}
		res["popup press"] = map[string]any{"at": []int{px, py}, "selected": st.Sel, "islandBlocked": blocked1}
		// Beside the popup, in the island, is refused too while the popup crosses it (T47S-1).
		before := readIsland()
		s.islandClick(8, fx(1400), fy(1000))
		time.Sleep(300 * time.Millisecond)
		st, blocked2 := readIsland(), s.blocked()
		if st != nil && before != nil && st.MD != before.MD {
			fail("island popup: a press beside the popup, in the island, reached the page")
		}
		if blocked2 <= blocked1 {
			fail("island popup: a press beside the popup wasn't counted (%v to %v)", blocked1, blocked2)
		}
		res["press beside the popup"] = "refused"
		s.closeSelectPopup()
	}

	s.phaseCover(res)

	// Back to the whole screen.
	s.setCrop(nil)
	click("whole screen again, epoch 8", 8, 0.5, 0.5, -1, -1)
	click("whole screen again", 0, 960.0/1920, 540.0/1080, 960, 540)
	res["stats"] = s.streamStats()
	closePage()
}
