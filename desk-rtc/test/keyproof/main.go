// keyproof proves desk-rtc's keys and wheel against real kiosk Chromium, on a temporary box with the
// real image. It runs on the desk itself: the Pion client from internal/client talks to the real
// desk-rtc over WebRTC, and the page reports what it saw in document.title, read back through CDP's
// /json/list. See desk-rtc/README.md, "Prove the keys and the wheel". Never for a real desk.
//
//	keyproof table [--from N] [--to N]    what Chromium does with each X keycode (needs xhost +SI:localuser:root)
//	keyproof run --phases named,ascii,... the real path, through desk-rtc
//
// Run it as root: the image's nftables gives CDP only to uids 0 and 1100.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/client"
)

const pageHTML = `<!doctype html><meta charset="utf-8"><title>input</title>
<style>html,body{margin:0;background:#eef;font:20px sans-serif}body{width:5000px;height:20000px}
#text{position:fixed;left:760px;top:40px;width:400px;height:48px;font:28px monospace}</style>
<body><input id="text" autocomplete="off" spellcheck="false">
<script>
const text = document.getElementById('text');
const q = new URLSearchParams(location.search);
const quiet = q.has('quiet'); // keydown's default is cancelled, so F1, F5, F7 and the like stay put
const s = { id: Math.round(performance.timeOrigin) % 100000, ae: 0, md: 0, mu: 0, kd: 0, ku: 0, rp: 0, lk: '', lc: '', kc: 0, sh: 0, v: '', sy: 0, sx: 0, se: 0, sxe: 0, wh: 0, wy: 0, foc: 0, iw: 0, ih: 0, sw: screen.width, sh2: screen.height, hl: history.length };
const pub = () => { s.v = text.value.slice(-160); s.sy = Math.round(scrollY); s.sx = Math.round(scrollX); s.foc = document.hasFocus() ? 1 : 0; s.iw = innerWidth; s.ih = innerHeight; s.hl = history.length; s.ae = document.activeElement === text ? 1 : 0; document.title = 'I' + JSON.stringify(s); };
addEventListener('mousedown', () => { s.md++; pub(); }, true);
addEventListener('mouseup', () => { s.mu++; pub(); }, true);
addEventListener('keydown', (e) => { s.kd++; if (e.repeat) s.rp++; s.lk = e.key; s.lc = e.code; s.kc = e.keyCode; s.sh = e.shiftKey ? 1 : 0; if (quiet) e.preventDefault(); pub(); }, true);
addEventListener('keyup', () => { s.ku++; pub(); }, true);
addEventListener('input', pub, true);
addEventListener('scroll', () => { s.se = Math.round(scrollY); s.sxe = Math.round(scrollX); pub(); }, true);
addEventListener('wheel', (e) => { s.wh++; s.wy += e.deltaY; pub(); }, { capture: true, passive: true });
addEventListener('focus', pub); addEventListener('blur', pub);
setInterval(pub, 50);
pub();
</script></body>`

// state is what the page published. sy and sx are live, se and sxe are as of the last scroll event.
type state struct {
	ID  int     `json:"id"`
	AE  int     `json:"ae"`
	MD  int     `json:"md"`
	MU  int     `json:"mu"`
	KD  int     `json:"kd"`
	KU  int     `json:"ku"`
	RP  int     `json:"rp"`
	LK  string  `json:"lk"`
	LC  string  `json:"lc"`
	KC  int     `json:"kc"`
	SH  int     `json:"sh"`
	V   string  `json:"v"`
	SY  int     `json:"sy"`
	SX  int     `json:"sx"`
	SE  int     `json:"se"`
	SXE int     `json:"sxe"`
	WH  int     `json:"wh"`
	WY  float64 `json:"wy"`
	Foc int     `json:"foc"`
	IW  int     `json:"iw"`
	IH  int     `json:"ih"`
	SW  int     `json:"sw"`
	SH2 int     `json:"sh2"`
	HL  int     `json:"hl"`
}

type target struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	URL   string `json:"url"`
	Title string `json:"title"`
}

var (
	cdpBase  = "http://127.0.0.1:9222"
	pagePort = 18123
	httpc    = &http.Client{Timeout: 5 * time.Second}
	problems []string
	report   = map[string]any{}
)

func fail(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	problems = append(problems, s)
	fmt.Println("FAIL:", s)
}

func servePage() {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", pagePort))
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/input.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.RawQuery == "island" {
			_, _ = io.WriteString(w, islandHTML) // island.go

			return
		}
		if r.URL.RawQuery == "popup" {
			_, _ = io.WriteString(w, popupHTML) // island.go

			return
		}
		_, _ = io.WriteString(w, pageHTML)
	})
	go func() { _ = http.Serve(ln, mux) }()
}

func targets() ([]target, error) {
	r, err := httpc.Get(cdpBase + "/json/list")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var ts []target
	if err := json.NewDecoder(r.Body).Decode(&ts); err != nil {
		return nil, err
	}

	return ts, nil
}

func cdpGet(path string) {
	r, err := httpc.Get(cdpBase + path)
	if err == nil {
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}
}

// tab finds the proof's tab.
func tab(query string) *target {
	ts, err := targets()
	if err != nil {
		return nil
	}
	for i := range ts {
		if ts[i].Type == "page" && strings.Contains(ts[i].URL, "/input.html"+query) {
			return &ts[i]
		}
	}

	return nil
}

func read(query string) *state {
	t := tab(query)
	if t == nil {
		return nil
	}
	title := html.UnescapeString(t.Title)
	if !strings.HasPrefix(title, "I{") {
		return nil
	}
	var s state
	if err := json.Unmarshal([]byte(title[1:]), &s); err != nil {
		return nil
	}

	return &s
}

func waitState(query string, ok func(*state) bool, d time.Duration) *state {
	end := time.Now().Add(d)
	var last *state
	for {
		if s := read(query); s != nil {
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

// openPage closes any old proof tab and opens a fresh one in front.
func openPage(query string) *state {
	closePage()
	req, _ := http.NewRequest(http.MethodPut, fmt.Sprintf("%s/json/new?http://127.0.0.1:%d/input.html%s", cdpBase, pagePort, query), nil)
	r, err := httpc.Do(req)
	if err != nil {
		panic(err)
	}
	_, _ = io.Copy(io.Discard, r.Body)
	r.Body.Close()
	s := waitState(query, func(*state) bool { return true }, 15*time.Second)
	if s == nil {
		panic("the proof page never reported")
	}

	return s
}

func closePage() {
	ts, _ := targets()
	for _, t := range ts {
		if t.Type == "page" && strings.Contains(t.URL, "/input.html") {
			cdpGet("/json/close/" + t.ID)
		}
	}
	time.Sleep(200 * time.Millisecond)
}

// ---- the session: events as section 8.6 lays them out

type session struct {
	conn *client.Conn
	seq  atomic.Uint32
}

func (s *session) send(channel uint8, kind, down, button byte, x, y uint16, last uint32) {
	b := make([]byte, 16)
	b[0], b[1], b[2] = kind, down, button
	binary.BigEndian.PutUint32(b[4:], s.seq.Add(1))
	binary.BigEndian.PutUint16(b[8:], x)
	binary.BigEndian.PutUint16(b[10:], y)
	binary.BigEndian.PutUint32(b[12:], last)
	if err := s.conn.SendInput(channel, b); err != nil {
		fail("send: %v", err)
	}
}

func nx(px int) uint16 { return uint16((65535*px + 960) / 1920) }
func ny(py int) uint16 { return uint16((65535*py + 540) / 1080) }

func (s *session) key(sym uint32, down bool) {
	d := byte(0)
	if down {
		d = 1
	}
	s.send(7, 4, d, 0, 0, 0, sym)
}

func (s *session) tap(sym uint32, hold time.Duration) {
	s.key(sym, true)
	if hold > 0 {
		time.Sleep(hold)
	}
	s.key(sym, false)
}

func (s *session) click(x, y int) {
	s.send(7, 2, 1, 1, nx(x), ny(y), 0)
	time.Sleep(30 * time.Millisecond)
	s.send(7, 2, 0, 1, nx(x), ny(y), 0)
}

func (s *session) wheel(x, y, dx, dy int) {
	s.send(7, 3, 0, 0, nx(x), ny(y), uint32(uint16(int16(dx)))<<16|uint32(uint16(int16(dy))))
}

func keysym(r rune) uint32 {
	if r < 0x100 {
		return uint32(r)
	}

	return 0x01000000 + uint32(r)
}

// focusAndClear clicks the input until it has focus, since a click in the first moments of a new tab can
// go nowhere, and empties it.
func (s *session) focusAndClear(query string) bool {
	for range 20 {
		s.click(960, 64)
		st := waitState(query, func(v *state) bool { return v.AE == 1 && v.Foc == 1 }, 300*time.Millisecond)
		if st != nil && st.AE == 1 && st.Foc == 1 {
			if st.V == "" {
				return true
			}

			break
		}
	}
	s.key(0xffe3, true)
	s.tap('a', 10*time.Millisecond)
	s.key(0xffe3, false)
	s.tap(0xff08, 10*time.Millisecond)
	st := waitState(query, func(v *state) bool { return v.V == "" }, 2*time.Second)

	return st != nil && st.V == ""
}

// ---- phases

// test5Letters is test 5's list in stream.spec.ts.
var test5Letters = []rune("àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿßÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ¡¿£¥§«»€中日ж")

func ordered(order string) []rune {
	out := slices.Clone(test5Letters)
	switch {
	case order == "" || order == "asis":
	case order == "reverse":
		slices.Reverse(out)
	default:
		var seed int64
		if _, err := fmt.Sscanf(order, "seed%d", &seed); err != nil {
			panic("bad --order " + order)
		}
		rand.New(rand.NewSource(seed)).Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	}

	return out
}

type named struct {
	name string
	sym  uint32
	code string
	key  string
}

var namedKeys = func() []named {
	n := []named{
		{"Backspace", 0xff08, "Backspace", "Backspace"}, {"Tab", 0xff09, "Tab", "Tab"}, {"Enter", 0xff0d, "Enter", "Enter"},
		{"Pause", 0xff13, "Pause", "Pause"}, {"ScrollLock", 0xff14, "ScrollLock", "ScrollLock"}, {"Escape", 0xff1b, "Escape", "Escape"},
		{"Delete", 0xffff, "Delete", "Delete"}, {"Home", 0xff50, "Home", "Home"}, {"ArrowLeft", 0xff51, "ArrowLeft", "ArrowLeft"},
		{"ArrowUp", 0xff52, "ArrowUp", "ArrowUp"}, {"ArrowRight", 0xff53, "ArrowRight", "ArrowRight"}, {"ArrowDown", 0xff54, "ArrowDown", "ArrowDown"},
		{"PageUp", 0xff55, "PageUp", "PageUp"}, {"PageDown", 0xff56, "PageDown", "PageDown"}, {"End", 0xff57, "End", "End"},
		{"Shift", 0xffe1, "ShiftLeft", "Shift"}, {"ShiftRight", 0xffe2, "ShiftRight", "Shift"},
		{"Control", 0xffe3, "ControlLeft", "Control"}, {"ControlRight", 0xffe4, "ControlRight", "Control"},
		{"Alt", 0xffe9, "AltLeft", "Alt"}, {"AltRight", 0xffea, "AltRight", "Alt"}, {"Meta", 0xffeb, "MetaLeft", "Meta"},
		{"AltGraph", 0xfe03, "", "AltGraph"},
		{"ContextMenu", 0xff67, "ContextMenu", "ContextMenu"}, {"Insert", 0xff63, "Insert", "Insert"}, {"PrintScreen", 0xff61, "PrintScreen", "PrintScreen"},
	}
	for i := range 10 { // F11 and F12 aren't sent (section 8.6), and kiosk Chromium keeps F11 for itself
		f := fmt.Sprintf("F%d", i+1)
		n = append(n, named{f, 0xffbe + uint32(i), f, f})
	}

	return n
}()

func phaseNamed(s *session) {
	const q = "?quiet=named"
	st := openPage(q)
	s.focusAndClear(q)
	var rows []map[string]any
	for _, n := range namedKeys {
		st = read(q)
		kd := st.KD
		s.tap(n.sym, 25*time.Millisecond)
		got := waitState(q, func(v *state) bool { return v.KD > kd }, 2*time.Second)
		row := map[string]any{"key": n.name, "code": got.LC, "eventKey": got.LK, "keyCode": got.KC}
		rows = append(rows, row)
		if got.KD <= kd {
			fail("named %s: no keydown", n.name)

			continue
		}
		if got.LC != n.code {
			fail("named %s: e.code %q, want %q", n.name, got.LC, n.code)
		}
		if got.LK != n.key {
			fail("named %s: e.key %q, want %q", n.name, got.LK, n.key)
		}
		// Some keys (Alt, Meta, Tab) can take focus; put it back so the next one has somewhere to land.
		if got.Foc == 0 || n.name == "Tab" {
			s.click(960, 64)
			time.Sleep(50 * time.Millisecond)
		}
	}
	report["named"] = rows
	fmt.Printf("named: %d keys checked\n", len(namedKeys))
}

const asciiRow = "`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./"
const shiftRow = "~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:\"ZXCVBNM<>?"

func usCode(r rune) string {
	if i := strings.IndexRune(shiftRow, r); i >= 0 {
		r = rune(asciiRow[i])
	}
	switch {
	case r >= 'a' && r <= 'z':
		return "Key" + strings.ToUpper(string(r))
	case r >= '0' && r <= '9':
		return "Digit" + string(r)
	case r == ' ':
		return "Space"
	}

	return map[rune]string{
		'`': "Backquote", '-': "Minus", '=': "Equal", '[': "BracketLeft", ']': "BracketRight", '\\': "Backslash",
		';': "Semicolon", '\'': "Quote", ',': "Comma", '.': "Period", '/': "Slash",
	}[r]
}

func phaseASCII(s *session) {
	const q = "?ascii"
	openPage(q)
	s.focusAndClear(q)
	var bad []string
	checked := 0
	for r := rune(0x20); r <= 0x7e; r++ {
		st := read(q)
		kd, v0 := st.KD, st.V
		s.tap(keysym(r), 10*time.Millisecond)
		want := v0 + string(r)
		got := waitState(q, func(v *state) bool { return v.V == want && v.KD > kd }, time.Second)
		checked++
		wantShift := 0
		if strings.ContainsRune(shiftRow, r) {
			wantShift = 1
		}
		if got.V != want || got.LK != string(r) || got.LC != usCode(r) || got.SH != wantShift {
			bad = append(bad, fmt.Sprintf("%q: value %q key %q code %q shift %d", string(r), got.V, got.LK, got.LC, got.SH))
			fail("ascii %q: value %q key %q code %q shift %d (want code %q shift %d)", string(r), got.V, got.LK, got.LC, got.SH, usCode(r), wantShift)
		}
		if len(got.V) > 30 {
			s.focusAndClear(q)
		}
	}
	// A real keyboard: Shift held, then the shifted keysym.
	s.focusAndClear(q)
	for _, r := range "AZ!?" {
		st := read(q)
		v0 := st.V
		s.key(0xffe1, true)
		s.tap(keysym(r), 10*time.Millisecond)
		s.key(0xffe1, false)
		want := v0 + string(r)
		got := waitState(q, func(v *state) bool { return v.V == want }, time.Second)
		if got.V != want || got.LK != string(r) || got.LC != usCode(r) || got.SH != 1 {
			fail("shift held %q: value %q key %q code %q shift %d", string(r), got.V, got.LK, got.LC, got.SH)
		}
		checked++
	}
	report["ascii"] = map[string]any{"checked": checked, "bad": bad}
	fmt.Printf("ascii: %d checked, %d bad\n", checked, len(bad))
}

// phaseLetters is test 5's loop: one character at a time, refocusing and clearing first.
func phaseLetters(s *session, order string) {
	const q = "?letters"
	openPage(q)
	type failure struct {
		Ch, Code, Key, Value string
		Reloaded, Navigated  bool
	}
	var failed []failure
	var okKeys = map[string]int{}
	letters := ordered(order)
	for _, r := range letters {
		s.focusAndClear(q)
		st := read(q)
		if st == nil {
			openPage(q)
			s.focusAndClear(q)
			st = read(q)
		}
		id, hl, kd0, ku0, ae0 := st.ID, st.HL, st.KD, st.KU, st.AE
		s.tap(keysym(r), 30*time.Millisecond)
		got := waitState(q, func(v *state) bool { return v.V == string(r) }, 700*time.Millisecond)
		if got != nil && got.V != string(r) {
			fmt.Printf("lost %q: keydowns +%d keyups +%d, focused before %d now %d, foc %d, value %q\n", string(r), got.KD-kd0, got.KU-ku0, ae0, got.AE, got.Foc, got.V)
		}
		if got != nil && got.V == string(r) && got.ID == id && got.HL == hl {
			okKeys[fmt.Sprintf("%q", got.LK)]++
			if got.LC != "" {
				fail("letters %q: landed on a key with a meaning: e.code %q", string(r), got.LC)
			}

			continue
		}
		f := failure{Ch: string(r)}
		if got != nil {
			f.Code, f.Key, f.Value, f.Reloaded, f.Navigated = got.LC, got.LK, got.V, got.ID != id, got.HL != hl
		} else {
			f.Reloaded = true
		}
		failed = append(failed, f)
		fail("letters %q (order %s): %+v", string(r), order, f)
		if tab(q) == nil || f.Reloaded || f.Navigated {
			openPage(q)
		}
	}
	report["letters-"+order] = map[string]any{"tried": len(letters), "typed": len(letters) - len(failed), "failed": failed, "eventKeyOfTyped": okKeys}
	fmt.Printf("letters (%s): %d of %d typed\n", order, len(letters)-len(failed), len(letters))
}

// phasePace is test 5's pacing check.
func phasePace(s *session) {
	const q = "?pace"
	openPage(q)
	var rows []map[string]any
	for _, c := range []struct {
		chars string
		gap   time.Duration
	}{{"abcdef", 0}, {"ñüßçøå", 0}, {"ñüßçøå", 30 * time.Millisecond}, {"ñüßçøå", 120 * time.Millisecond}} {
		s.focusAndClear(q)
		for _, r := range c.chars {
			s.tap(keysym(r), 0)
			if c.gap > 0 {
				time.Sleep(c.gap)
			}
		}
		got := waitState(q, func(v *state) bool { return v.V == c.chars }, 2500*time.Millisecond)
		rows = append(rows, map[string]any{"chars": c.chars, "gapMs": c.gap.Milliseconds(), "got": got.V})
		if got.V != c.chars {
			fail("pace %q at %v: got %q", c.chars, c.gap, got.V)
		}
	}
	report["pace"] = rows
	fmt.Println("pace: done")
}

// phaseBurst types far more distinct characters than there are spares, with no gap and no refocus,
// so codes get reused while earlier presses may still be in flight. Any wrong letter shows.
func phaseBurst(s *session, rounds int, gap time.Duration) {
	const q = "?burst"
	openPage(q)
	var rows []map[string]any
	for round := range rounds {
		letters := ordered(fmt.Sprintf("seed%d", 1000+round))
		s.focusAndClear(q)
		start := time.Now()
		for _, r := range letters {
			s.tap(keysym(r), 0)
			if gap > 0 {
				time.Sleep(gap)
			}
		}
		want := string(letters)
		got := waitState(q, func(v *state) bool { return v.V == want }, 15*time.Second)
		took := time.Since(start)
		rows = append(rows, map[string]any{"round": round, "gapMs": gap.Milliseconds(), "ms": took.Milliseconds(), "ok": got.V == want})
		if got.V != want {
			fail("burst round %d gap %v: sent %q, got %q", round, gap, want, got.V)
		}
	}
	report[fmt.Sprintf("burst-%dms", gap.Milliseconds())] = rows
	fmt.Printf("burst (gap %v): %d rounds\n", gap, rounds)
}

// phaseHold holds a spare character down while many others go by: its code must not be reused, and
// its release must still be seen.
func phaseHold(s *session) {
	const q = "?hold"
	openPage(q)
	s.focusAndClear(q)
	held := 'ß'
	st := read(q)
	ku := st.KU
	s.key(keysym(held), true)
	time.Sleep(50 * time.Millisecond)
	rest := ""
	for _, r := range test5Letters[:60] {
		if r == held {
			continue
		}
		s.tap(keysym(r), 5*time.Millisecond)
		rest += string(r)
		time.Sleep(5 * time.Millisecond)
	}
	want := string(held) + rest
	got := waitState(q, func(v *state) bool { return v.V == want }, 10*time.Second)
	if got.V != want {
		fail("hold: sent %q, got %q", want, got.V)
	}
	s.key(keysym(held), false)
	got = waitState(q, func(v *state) bool { return v.KU == ku+len([]rune(rest))+1 }, 2*time.Second)
	if got.KU != ku+len([]rune(rest))+1 {
		fail("hold: keyups %d, want %d", got.KU-ku, len([]rune(rest))+1)
	}
	if got.V != want {
		fail("hold: value changed on release: %q", got.V)
	}
	report["hold"] = map[string]any{"held": string(held), "others": len([]rune(rest)), "keyups": got.KU - ku}
	fmt.Println("hold: done")
}

func settled(q string) *state {
	var last *state
	stable := 0
	end := time.Now().Add(6 * time.Second)
	for time.Now().Before(end) {
		s := read(q)
		if s != nil && last != nil && s.SY == last.SY && s.SX == last.SX {
			stable++
			if stable > 20 { // 20 reads over at least 300 ms with no change
				return s
			}
		} else {
			stable = 0
		}
		if s != nil {
			last = s
		}
		time.Sleep(15 * time.Millisecond)
	}

	return last
}

// phaseWheel sends known amounts and reads where the page ended up, in both axes and both directions,
// then a trackpad-like stream of small deltas.
func phaseWheel(s *session) {
	const q = "?wheel"
	var rows []map[string]any
	x, y := 960, 700
	check := func(label string, dx, dy, wantX, wantY int) {
		s.wheel(x, y, dx, dy)
		st := settled(q)
		rows = append(rows, map[string]any{"step": label, "sent": []int{dx, dy}, "sx": st.SX, "sy": st.SY, "lastScrollEvent": []int{st.SXE, st.SE}, "want": []int{wantX, wantY}})
		if st.SX != wantX || st.SY != wantY {
			fail("wheel %s: sent %d,%d: at %d,%d, want %d,%d", label, dx, dy, st.SX, st.SY, wantX, wantY)
		}
	}
	openPage(q)
	s.send(6, 1, 0, 0, nx(x), ny(y), 0)
	time.Sleep(100 * time.Millisecond)
	// The remainder is kept: 530 is 4 clicks, 50 left. 70 more makes a fifth.
	check("down 530", 0, 530, 0, 480)
	check("down 70 more", 0, 70, 0, 600)
	check("up 600", 0, -600, 0, 0)
	check("right 530", 530, 0, 480, 0)
	check("left 530", -530, 0, 0, 0)
	check("down 119", 0, 119, 0, 0)
	check("down 1", 0, 1, 0, 120)
	check("up 120", 0, -120, 0, 0)
	check("down 2400", 0, 2400, 0, 2400)
	check("up 2400", 0, -2400, 0, 0)
	report["wheel"] = rows
	// A trackpad: small deltas, one per display frame, as the app coalesces them.
	type tp struct {
		PxPerFrame, Frames, Sent, Scrolled, DistinctPositions int
	}
	var pads []tp
	for _, pxf := range []int{1, 4, 20, 40} {
		openPage(q)
		s.send(6, 1, 0, 0, nx(x), ny(y), 0)
		time.Sleep(100 * time.Millisecond)
		const frames = 240
		seen := map[int]bool{}
		sent := 0
		for range frames {
			s.wheel(x, y, 0, pxf)
			sent += pxf
			if st := read(q); st != nil {
				seen[st.SY] = true
			}
			time.Sleep(10 * time.Millisecond)
		}
		st := settled(q)
		pads = append(pads, tp{pxf, frames, sent, st.SY, len(seen)})
		if d := sent - st.SY; d < 0 || d >= 120 {
			fail("trackpad %d px/frame: sent %d, scrolled %d", pxf, sent, st.SY)
		}
	}
	report["trackpad"] = pads
	fmt.Printf("wheel: %d steps, trackpad %+v\n", len(rows), pads)
}

// phaseWheelRepeat repeats test 5's first scroll from a fresh page, to see how often it lands short.
func phaseWheelRepeat(s *session, n int, dy int) {
	const q = "?wheelrepeat"
	x, y := 960, 700
	counts := map[string]int{}
	for range n {
		openPage(q)
		s.send(6, 1, 0, 0, nx(x), ny(y), 0)
		time.Sleep(60 * time.Millisecond)
		s.wheel(x, y, 0, dy)
		st := settled(q)
		counts[fmt.Sprintf("sy=%d lastScrollEvent=%d wheelEvents=%d deltaSum=%.0f", st.SY, st.SE, st.WH, st.WY)]++
	}
	report[fmt.Sprintf("wheel-repeat-%d", dy)] = counts
	fmt.Printf("wheel repeat %d px x %d: %v\n", dy, n, counts)
}

func phaseViewport() {
	const q = "?viewport"
	st := openPage(q)
	report["viewport"] = map[string]any{"inner": []int{st.IW, st.IH}, "screen": []int{st.SW, st.SH2}}
	if st.IW != 1920 || st.IH != 1080 {
		fail("viewport %dx%d, want 1920x1080", st.IW, st.IH)
	}
	fmt.Printf("viewport: %dx%d, screen %dx%d\n", st.IW, st.IH, st.SW, st.SH2)
}

// ---- keyproof table: what Chromium does with each keycode, whatever the keymap says

func cmdTable(from, to int, skip map[int]bool, loud bool) {
	q := "?quiet=table"
	if loud {
		q = "?loud" // the key's default action happens: reloads, navigation and text all show
	}
	c, err := xgb.NewConnDisplay(":99")
	if err != nil {
		fmt.Fprintln(os.Stderr, "keyproof table needs xhost +SI:localuser:root:", err)
		os.Exit(1)
	}
	defer c.Close()
	if err := xtest.Init(c); err != nil {
		panic(err)
	}
	setup := xproto.Setup(c)
	mapping, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, byte(int(setup.MaxKeycode)-int(setup.MinKeycode)+1)).Reply()
	if err != nil {
		panic(err)
	}
	per := int(mapping.KeysymsPerKeycode)
	orig := func(code int) []xproto.Keysym {
		i := code - int(setup.MinKeycode)

		return slices.Clone(mapping.Keysyms[i*per : (i+1)*per])
	}
	press := func(code int, down bool) {
		t := byte(xproto.KeyRelease)
		if down {
			t = xproto.KeyPress
		}
		xtest.FakeInput(c, t, byte(code), 0, xproto.WindowNone, 0, 0, 0)
	}
	clickText := func() {
		const x, y = 960, 64
		xtest.FakeInput(c, xproto.MotionNotify, 0, 0, setup.DefaultScreen(c).Root, x, y, 0)
		xtest.FakeInput(c, xproto.ButtonPress, 1, 0, xproto.WindowNone, 0, 0, 0)
		xtest.FakeInput(c, xproto.ButtonRelease, 1, 0, xproto.WindowNone, 0, 0, 0)
		xproto.GetInputFocus(c).Reply()
		time.Sleep(80 * time.Millisecond)
	}
	restart := func() {
		_ = exec.Command("systemctl", "restart", "desk-browser").Run()
		for range 60 {
			if _, err := targets(); err == nil {
				break
			}
			time.Sleep(time.Second)
		}
		time.Sleep(2 * time.Second)
		openPage(q)
		clickText()
	}
	openPage(q)
	clickText()
	type row struct {
		Code     int    `json:"code"`
		Mapped   bool   `json:"mapped"`
		ECode    string `json:"eCode"`
		EKey     string `json:"eKey"`
		KeyCode  int    `json:"keyCode"`
		Typed    string `json:"typed"`
		Downs    int    `json:"downs"`
		Reloaded bool   `json:"reloaded"`
		LostPage bool   `json:"lostPage"`
		LostFoc  bool   `json:"lostFocus"`
	}
	const testSym = 0xe9 // eacute, on every level, as MapSpare does
	var rows []row
	for code := from; code <= to; code++ {
		if skip[code] {
			continue
		}
		st := read(q)
		if st == nil || st.Foc == 0 {
			restart()
			st = read(q)
		}
		id, kd := st.ID, st.KD
		v0 := st.V
		o := orig(code)
		syms := make([]xproto.Keysym, per)
		for i := range syms {
			syms[i] = testSym
		}
		if err := xproto.ChangeKeyboardMappingChecked(c, 1, xproto.Keycode(code), byte(per), syms).Check(); err != nil {
			panic(err)
		}
		press(code, true)
		time.Sleep(30 * time.Millisecond)
		press(code, false)
		xproto.GetInputFocus(c).Reply()
		got := waitState(q, func(v *state) bool { return v.KD > kd }, 500*time.Millisecond)
		time.Sleep(120 * time.Millisecond)
		now := read(q)
		r := row{Code: code}
		for _, x := range o {
			if x != 0 {
				r.Mapped = true
			}
		}
		if err := xproto.ChangeKeyboardMappingChecked(c, 1, xproto.Keycode(code), byte(per), o).Check(); err != nil {
			panic(err)
		}
		if got != nil {
			r.ECode, r.EKey, r.KeyCode, r.Downs = got.LC, got.LK, got.KC, got.KD-kd
		}
		switch {
		case now == nil:
			r.LostPage = true
		default:
			r.Typed = strings.TrimPrefix(now.V, v0)
			r.Reloaded = now.ID != id
			r.LostFoc = now.Foc == 0
		}
		rows = append(rows, r)
		fmt.Printf("%d %s\n", code, must(json.Marshal(r)))
		if r.LostPage || r.Reloaded || r.LostFoc {
			restart()
		} else if len(now.V) > 20 {
			press(37, true) // Control_L + a, Delete
			press(38, true)
			press(38, false)
			press(37, false)
			press(119, true)
			press(119, false)
			xproto.GetInputFocus(c).Reply()
			time.Sleep(100 * time.Millisecond)
		}
	}
	closePage()
	report["table"] = rows
}

// cmdSeq maps and presses keycodes in the order given, each step "code:keysym:delayMs" (keysym in hex),
// and prints what the page saw. For finding out how Chromium follows a keymap change.
func cmdSeq(steps []string) {
	const q = "?seq"
	c, err := xgb.NewConnDisplay(":99")
	if err != nil {
		fmt.Fprintln(os.Stderr, "keyproof seq needs xhost +SI:localuser:root:", err)
		os.Exit(1)
	}
	defer c.Close()
	if err := xtest.Init(c); err != nil {
		panic(err)
	}
	setup := xproto.Setup(c)
	mapping, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, byte(int(setup.MaxKeycode)-int(setup.MinKeycode)+1)).Reply()
	if err != nil {
		panic(err)
	}
	per := int(mapping.KeysymsPerKeycode)
	press := func(code int, down bool) {
		t := byte(xproto.KeyRelease)
		if down {
			t = xproto.KeyPress
		}
		xtest.FakeInput(c, t, byte(code), 0, xproto.WindowNone, 0, 0, 0)
	}
	openPage(q)
	xtest.FakeInput(c, xproto.MotionNotify, 0, 0, setup.DefaultScreen(c).Root, 960, 64, 0)
	xtest.FakeInput(c, xproto.ButtonPress, 1, 0, xproto.WindowNone, 0, 0, 0)
	xtest.FakeInput(c, xproto.ButtonRelease, 1, 0, xproto.WindowNone, 0, 0, 0)
	xproto.GetInputFocus(c).Reply()
	time.Sleep(200 * time.Millisecond)
	for _, step := range steps {
		var code, delay int
		var sym uint32
		if _, err := fmt.Sscanf(step, "%d:%x:%d", &code, &sym, &delay); err != nil {
			panic(step)
		}
		st := read(q)
		kd, v0 := st.KD, st.V
		if sym != 0 {
			syms := make([]xproto.Keysym, per)
			for i := range syms {
				syms[i] = xproto.Keysym(sym)
			}
			if err := xproto.ChangeKeyboardMappingChecked(c, 1, xproto.Keycode(code), byte(per), syms).Check(); err != nil {
				panic(err)
			}
		}
		time.Sleep(time.Duration(delay) * time.Millisecond)
		press(code, true)
		press(code, false)
		xproto.GetInputFocus(c).Reply()
		got := waitState(q, func(v *state) bool { return v.KD > kd }, 500*time.Millisecond)
		time.Sleep(50 * time.Millisecond)
		now := read(q)
		fmt.Printf("%s: code %q key %q keyCode %d typed %q downs %d focus %d\n", step, got.LC, got.LK, got.KC, strings.TrimPrefix(now.V, v0), got.KD-kd, now.Foc)
	}
	closePage()
}

// cmdRace measures the race between a remap and the key after it: clear the input (or not), put a new
// keysym on a free code, wait, press it, and see whether the text arrived. Each code is reused only after
// the whole list, so this isn't the reuse race.
func cmdRace(n int, delays []time.Duration, clearFirst bool, hold time.Duration) {
	const q = "?race"
	c, err := xgb.NewConnDisplay(":99")
	if err != nil {
		fmt.Fprintln(os.Stderr, "keyproof race needs xhost +SI:localuser:root:", err)
		os.Exit(1)
	}
	defer c.Close()
	if err := xtest.Init(c); err != nil {
		panic(err)
	}
	setup := xproto.Setup(c)
	mapping, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, byte(int(setup.MaxKeycode)-int(setup.MinKeycode)+1)).Reply()
	if err != nil {
		panic(err)
	}
	per := int(mapping.KeysymsPerKeycode)
	press := func(code int, down bool) {
		t := byte(xproto.KeyRelease)
		if down {
			t = xproto.KeyPress
		}
		xtest.FakeInput(c, t, byte(code), 0, xproto.WindowNone, 0, 0, 0)
	}
	sync := func() { _, _ = xproto.GetInputFocus(c).Reply() }
	codes := []int{120, 126, 138, 147, 149, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 165, 168, 170, 177, 178,
		182, 183, 184, 185, 186, 189, 190, 208, 210, 211, 213, 214, 217, 218, 219, 220, 221, 222, 223, 224,
		226, 227, 228, 229, 230, 231, 234, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255}
	openPage(q)
	focus := func() {
		for range 20 {
			xtest.FakeInput(c, xproto.MotionNotify, 0, 0, setup.DefaultScreen(c).Root, 960, 64, 0)
			xtest.FakeInput(c, xproto.ButtonPress, 1, 0, xproto.WindowNone, 0, 0, 0)
			xtest.FakeInput(c, xproto.ButtonRelease, 1, 0, xproto.WindowNone, 0, 0, 0)
			sync()
			if st := waitState(q, func(v *state) bool { return v.AE == 1 && v.Foc == 1 }, 300*time.Millisecond); st != nil && st.AE == 1 {
				return
			}
		}
	}
	focus()
	rn := 0x4e00 // CJK: never in the keymap
	for _, d := range delays {
		lostText, lostDown := 0, 0
		var examples []string
		for i := range n {
			code := codes[rn%len(codes)]
			r := rune(rn)
			rn++
			st := read(q)
			if st.V != "" || clearFirst {
				press(37, true)
				press(38, true)
				press(38, false)
				press(37, false)
				press(22, true)
				press(22, false)
				sync()
				waitState(q, func(v *state) bool { return v.V == "" }, time.Second)
			}
			st = read(q)
			kd := st.KD
			syms := make([]xproto.Keysym, per)
			for j := range syms {
				syms[j] = xproto.Keysym(keysym(r))
			}
			if err := xproto.ChangeKeyboardMappingChecked(c, 1, xproto.Keycode(code), byte(per), syms).Check(); err != nil {
				panic(err)
			}
			if d > 0 {
				time.Sleep(d)
			}
			press(code, true)
			sync()
			if hold > 0 {
				time.Sleep(hold)
			}
			press(code, false)
			sync()
			got := waitState(q, func(v *state) bool { return v.V == string(r) }, 400*time.Millisecond)
			if got == nil || got.V != string(r) {
				lostText++
				if got == nil || got.KD == kd {
					lostDown++
				}
				if len(examples) < 4 {
					examples = append(examples, fmt.Sprintf("i=%d code=%d kd+%d key=%q v=%q", i, code, got.KD-kd, got.LK, got.V))
				}
			}
		}
		fmt.Printf("delay %v clear=%v hold=%v: %d of %d lost (%d with no keydown) %v\n", d, clearFirst, hold, lostText, n, lostDown, examples)
	}
	closePage()
}

func must(b []byte, err error) string {
	if err != nil {
		panic(err)
	}

	return string(b)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: keyproof table|run ...")
		os.Exit(2)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	api := fs.String("api", "http://127.0.0.1:8787", "gateway-shim's API")
	gateway := fs.String("gateway", "ws://127.0.0.1:8787/v1", "gateway-shim's gateway")
	desk := fs.String("desk", "d-dev0000000000", "desk id")
	phases := fs.String("phases", "viewport,named,ascii,letters,pace,burst,hold,wheel", "comma-separated")
	order := fs.String("order", "asis,reverse,seed1,seed2", "letter orders: asis, reverse, seedN")
	out := fs.String("out", "", "JSON report path")
	from := fs.Int("from", 8, "table: first keycode")
	to := fs.Int("to", 255, "table: last keycode")
	skipList := fs.String("skip", "37,50,62,64,66,77,92,105,108,133,134,203,204,205,206,207", "table: keycodes to leave alone (modifiers)")
	loud := fs.Bool("loud", false, "table: don't cancel keydown, so default actions and text show")
	count := fs.Int("n", 100, "race: presses per delay")
	delays := fs.String("delays", "0s,5ms,20ms,50ms,100ms", "race: waits between the remap and the key")
	clearFirst := fs.Bool("clear", false, "race: Ctrl+A and Backspace before every press")
	hold := fs.Duration("hold", 30*time.Millisecond, "race: how long the key stays down")
	_ = fs.Parse(os.Args[2:])
	servePage()
	switch os.Args[1] {
	case "table":
		skip := map[int]bool{}
		for _, f := range strings.Split(*skipList, ",") {
			var n int
			if _, err := fmt.Sscanf(f, "%d", &n); err == nil {
				skip[n] = true
			}
		}
		cmdTable(*from, *to, skip, *loud)
	case "seq":
		cmdSeq(fs.Args())
	case "race":
		var ds []time.Duration
		for _, f := range strings.Split(*delays, ",") {
			d, err := time.ParseDuration(f)
			if err != nil {
				panic(err)
			}
			ds = append(ds, d)
		}
		cmdRace(*count, ds, *clearFirst, *hold)
	case "run":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		conn, err := client.Dial(ctx, client.Options{API: *api, Gateway: *gateway, DeskID: *desk, Transport: "udp"})
		if err != nil {
			fmt.Fprintln(os.Stderr, "dial:", err)
			os.Exit(1)
		}
		defer conn.CloseSession()
		s := &session{conn: conn}
		for _, p := range strings.Split(*phases, ",") {
			switch p {
			case "viewport":
				phaseViewport()
			case "named":
				phaseNamed(s)
			case "ascii":
				phaseASCII(s)
			case "letters":
				for _, o := range strings.Split(*order, ",") {
					phaseLetters(s, o)
				}
			case "pace":
				phasePace(s)
			case "burst":
				phaseBurst(s, 5, 0)
				phaseBurst(s, 3, 15*time.Millisecond)
			case "hold":
				phaseHold(s)
			case "wheel":
				phaseWheel(s)
			case "island":
				phaseIsland(s)
			case "wheelrepeat":
				phaseWheelRepeat(s, 20, 530)
				phaseWheelRepeat(s, 20, 1200)
			default:
				fmt.Fprintln(os.Stderr, "unknown phase", p)
				os.Exit(2)
			}
		}
		closePage()
		// Release anything left down, and tell the page's state to the log.
		s.send(7, 5, 0, 0, 0, 0, 0)
		time.Sleep(100 * time.Millisecond)
	default:
		fmt.Fprintln(os.Stderr, "usage: keyproof table|run ...")
		os.Exit(2)
	}
	report["problems"] = problems
	report["at"] = time.Now().UTC().Format(time.RFC3339)
	if *out != "" {
		if err := os.WriteFile(*out, []byte(must(json.MarshalIndent(report, "", " "))), 0o644); err != nil {
			panic(err)
		}
	}
	fmt.Printf("RESULT: %d problems\n", len(problems))
	if len(problems) > 0 {
		os.Exit(1)
	}
}
