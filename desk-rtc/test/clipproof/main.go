// clipproof proves internal/xclip against real Chromium, on a private X display you started. It goes through the
// package the way desk-rtc does (Submit, and the replies from Send), injects keys by XTEST, and reads the page
// over its debugging port.
//
//	Xvfb :173 -screen 0 1280x800x24 -nolisten tcp -noreset &
//	go run ./test/clipproof --display :173 --chrome ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//	  --scratch /some/empty/dir
//
// The display is required and never read from the environment. It's only ever passed to what this starts, and
// this kills only the Chromium it started. Never for a real desk: it takes that display's clipboard and keyboard.
//
// Paste: set the text through xclip, wait for clipboard.ok, send Ctrl+V, read textarea.value.
// Copy: put the text in the textarea, select it, send Ctrl+C, wait for clipboard.changed, clipboard.get.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xclip"
)

const pageHTML = `<!doctype html><meta charset="utf-8"><title>clipproof</title>
<style>html,body{margin:0;height:100%}
#t{position:fixed;left:40px;top:40px;width:900px;height:600px;font:14px monospace}</style>
<textarea id="t" wrap="off" spellcheck="false" autocomplete="off"></textarea>
`

const (
	keysymControl = 0xffe3
	keysymC       = 0x63
	keysymV       = 0x76
)

var sizes = []int{17, 30_000, 100_000, 300_000, 1_000_000}

type phaseResult struct {
	Phase string `json:"phase"`
	Bytes int    `json:"bytes"`
	OK    bool   `json:"ok"`
	// ReplyMs is set to clipboard.ok, or the key to clipboard.changed, or the get to its last part.
	ReplyMs int64 `json:"replyMs,omitempty"`
	// ArrivedMs is Ctrl+V to the whole text being in the page, as polled.
	ArrivedMs int64  `json:"arrivedMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

func main() {
	display := flag.String("display", "", "a private X display that you started")
	chrome := flag.String("chrome", "", "the Chromium binary")
	scratch := flag.String("scratch", "", "an empty directory for Chromium's throwaway profile")
	port := flag.Int("port", 9377, "Chromium's debugging port")
	out := flag.String("out", "", "write the results here as JSON")
	flag.Parse()
	if err := run(*display, *chrome, *scratch, *port, *out); err != nil {
		fmt.Fprintln(os.Stderr, "FAILED:", err)
		os.Exit(1)
	}
	fmt.Println("PASS")
}

func run(display, chrome, scratch string, port int, out string) error {
	if display == "" || display == ":10" || display == ":0" {
		return fmt.Errorf("--display %q: name a private display that you started", display)
	}
	if chrome == "" || scratch == "" {
		return errors.New("--chrome and --scratch are required")
	}
	num := strings.TrimPrefix(display, ":")
	if _, err := os.Stat("/tmp/.X11-unix/X" + num); err != nil {
		return fmt.Errorf("no X server on %s: %w", display, err)
	}

	page := filepath.Join(scratch, "page.html")
	if err := os.WriteFile(page, []byte(pageHTML), 0o600); err != nil {
		return err
	}
	stop, err := startChromium(chrome, display, scratch, port, page)
	if err != nil {
		return err
	}
	defer stop()

	ctx := context.Background()
	cdp, err := dialCDP(ctx, port)
	if err != nil {
		return err
	}
	defer cdp.close()
	x, err := newKeyboard(display)
	if err != nil {
		return err
	}
	defer x.close()

	p := &proof{cdp: cdp, x: x, replies: make(chan *rtcsock.ClipReply, 16), changed: make(chan struct{}, 64)}
	p.clip = xclip.New(xclip.Config{
		Display: display,
		Log:     slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
		Send:    p.send,
	})
	defer p.clip.Close()

	if err := p.focus(); err != nil {
		return err
	}
	p.clip.Submit(rtcsock.ClipWatch(true))

	var results []phaseResult
	failed := false
	note := func(r phaseResult) {
		results = append(results, r)
		line, _ := json.Marshal(r)
		fmt.Println(string(line))
		failed = failed || !r.OK
	}
	for _, n := range sizes {
		note(p.paste(n))
	}
	for _, n := range sizes {
		note(p.copyText(n))
		note(p.overCap(n))
	}
	// Chromium is the owner now. Taking it back, and pasting, has to work the same.
	note(p.paste(1_000_000))
	note(p.selectionAloneDoesNothing())
	note(p.pasteAfterChromiumReads())

	if out != "" {
		b, _ := json.MarshalIndent(results, "", "  ")
		if err := os.WriteFile(out, append(b, '\n'), 0o644); err != nil {
			return err
		}
	}
	if failed {
		return errors.New("a phase failed")
	}

	return nil
}

// startChromium runs it headed on the private display only, with an environment built here from nothing, so it
// inherits no bus, keyring or other display from whoever runs this.
func startChromium(chrome, display, scratch string, port int, page string) (func(), error) {
	home := filepath.Join(scratch, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, err
	}
	cmd := exec.Command(chrome,
		"--user-data-dir="+filepath.Join(scratch, "profile"),
		fmt.Sprintf("--remote-debugging-port=%d", port),
		"--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
		"--ozone-platform=x11", "--password-store=basic", "--use-mock-keychain",
		"--disable-background-networking", "--disable-component-update", "--disable-sync",
		"--disable-extensions", "--window-position=0,0", "--window-size=1200,780",
		"file://"+page)
	cmd.Env = []string{
		"DISPLAY=" + display, "HOME=" + home, "XDG_CONFIG_HOME=" + home, "XDG_CACHE_HOME=" + home,
		"XAUTHORITY=/dev/null", "DBUS_SESSION_BUS_ADDRESS=disabled:", "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
	}
	log, err := os.Create(filepath.Join(scratch, "chromium.log"))
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	return func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		// Its helpers are in the group this started, and no one else is.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = log.Close()
	}, nil
}

// cdpConn is the least of the debugging protocol: Runtime.evaluate on one page.
type cdpConn struct {
	ws   *websocket.Conn
	next int
}

func dialCDP(ctx context.Context, port int) (*cdpConn, error) {
	var url string
	deadline := time.Now().Add(30 * time.Second)
	for url == "" {
		if time.Now().After(deadline) {
			return nil, errors.New("Chromium's debugging port never answered")
		}
		time.Sleep(200 * time.Millisecond)
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", port))
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		var targets []struct {
			Type string `json:"type"`
			URL  string `json:"url"`
			WS   string `json:"webSocketDebuggerUrl"`
		}
		if json.Unmarshal(body, &targets) != nil {
			continue
		}
		for _, t := range targets {
			if t.Type == "page" && strings.HasSuffix(t.URL, "page.html") {
				url = t.WS
			}
		}
	}
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(64 << 20)

	return &cdpConn{ws: ws}, nil
}

func (c *cdpConn) close() { _ = c.ws.CloseNow() }

func (c *cdpConn) eval(expr string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c.next++
	req, err := json.Marshal(map[string]any{
		"id":     c.next,
		"method": "Runtime.evaluate",
		"params": map[string]any{"expression": expr, "returnByValue": true},
	})
	if err != nil {
		return nil, err
	}
	if err := c.ws.Write(ctx, websocket.MessageText, req); err != nil {
		return nil, err
	}
	for {
		_, b, err := c.ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		var res struct {
			ID     int `json:"id"`
			Result struct {
				Result struct {
					Value json.RawMessage `json:"value"`
				} `json:"result"`
				Exception *struct {
					Text string `json:"text"`
				} `json:"exceptionDetails"`
			} `json:"result"`
		}
		if err := json.Unmarshal(b, &res); err != nil {
			return nil, err
		}
		if res.ID != c.next {
			continue
		}
		if res.Result.Exception != nil {
			return nil, fmt.Errorf("page: %s", res.Result.Exception.Text)
		}

		return res.Result.Result.Value, nil
	}
}

// keyboard is XTEST on the private display.
type keyboard struct {
	c    *xgb.Conn
	root xproto.Window
	code map[uint32]xproto.Keycode
}

func newKeyboard(display string) (*keyboard, error) {
	c, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, err
	}
	if err := xtest.Init(c); err != nil {
		c.Close()

		return nil, err
	}
	setup := xproto.Setup(c)
	count := byte(int(setup.MaxKeycode) - int(setup.MinKeycode) + 1)
	r, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, count).Reply()
	if err != nil {
		c.Close()

		return nil, err
	}
	k := &keyboard{c: c, root: setup.DefaultScreen(c).Root, code: map[uint32]xproto.Keycode{}}
	per := int(r.KeysymsPerKeycode)
	for i := range int(count) {
		for _, s := range r.Keysyms[i*per : (i+1)*per] {
			if _, seen := k.code[uint32(s)]; s != 0 && !seen {
				k.code[uint32(s)] = xproto.Keycode(int(setup.MinKeycode) + i)
			}
		}
	}
	for _, s := range []uint32{keysymControl, keysymC, keysymV} {
		if _, ok := k.code[s]; !ok {
			c.Close()

			return nil, fmt.Errorf("keysym %#x isn't in the keymap", s)
		}
	}

	return k, nil
}

func (k *keyboard) close() { k.c.Close() }

func (k *keyboard) sync() error {
	_, err := xproto.GetInputFocus(k.c).Reply()

	return err
}

func (k *keyboard) chord(sym uint32) error {
	ctrl, key := byte(k.code[keysymControl]), byte(k.code[sym])
	for _, e := range []struct {
		typ    byte
		detail byte
	}{{xproto.KeyPress, ctrl}, {xproto.KeyPress, key}, {xproto.KeyRelease, key}, {xproto.KeyRelease, ctrl}} {
		xtest.FakeInput(k.c, e.typ, e.detail, 0, xproto.WindowNone, 0, 0, 0)
	}

	return k.sync()
}

func (k *keyboard) click(x, y int16) error {
	xtest.FakeInput(k.c, xproto.MotionNotify, 0, 0, k.root, x, y, 0)
	xtest.FakeInput(k.c, xproto.ButtonPress, 1, 0, xproto.WindowNone, 0, 0, 0)
	xtest.FakeInput(k.c, xproto.ButtonRelease, 1, 0, xproto.WindowNone, 0, 0, 0)

	return k.sync()
}

type proof struct {
	cdp     *cdpConn
	x       *keyboard
	clip    *xclip.Clipboard
	replies chan *rtcsock.ClipReply
	changed chan struct{}
	joiner  rtcsock.ClipJoiner
	nextID  uint64
}

// send is the Send of xclip.Config. There's one deskd here and it never reconnects, so the link is always 0.
func (p *proof) send(_ uint64, m *rtcsock.Message) bool {
	if m.T == rtcsock.MsgClipChanged {
		select {
		case p.changed <- struct{}{}:
		default:
		}

		return true
	}
	r, err := p.joiner.Add(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad reply:", err)
	}
	if r != nil {
		p.replies <- r
	}

	return true
}

// fit is lines with some characters past ASCII, exactly n bytes, and valid UTF-8 at the end.
func fit(n int) []byte {
	const line = "the quick brown fox héllo wörld ✓ jumps over the lazy dog 0123456789\n"
	b := bytes.Repeat([]byte(line), n/len(line)+1)
	cut := n
	for cut > 0 && b[cut]&0xC0 == 0x80 {
		cut--
	}
	b = b[:cut]
	for len(b) < n {
		b = append(b, 'x')
	}

	return b
}

// rootOf turns a point in the page into one on the X screen. The browser's own bars are above the page, and how
// tall they are changes as it starts up and shows its infobars.
func (p *proof) rootOf(x, y int) (int16, int16, error) {
	v, err := p.cdp.eval(fmt.Sprintf(`[screenX + %d, screenY + outerHeight - innerHeight + %d]`, x, y))
	if err != nil {
		return 0, 0, err
	}
	var at [2]int16
	if err := json.Unmarshal(v, &at); err != nil {
		return 0, 0, err
	}

	return at[0], at[1], nil
}

// focus clicks the textarea, with no window manager to give the window focus.
func (p *proof) focus() error {
	var last json.RawMessage
	for range 50 {
		x, y, err := p.rootOf(200, 200)
		if err != nil {
			return err
		}
		if err := p.x.click(x, y); err != nil {
			return err
		}
		v, err := p.cdp.eval(`document.hasFocus() && document.activeElement === document.getElementById('t')`)
		if err != nil {
			return err
		}
		last = v
		if string(v) == "true" {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}

	return fmt.Errorf("the textarea never took focus: %s", last)
}

func (p *proof) id() uint64 {
	p.nextID++

	return p.nextID
}

func (p *proof) wait(d time.Duration) (*rtcsock.ClipReply, error) {
	select {
	case r := <-p.replies:
		return r, nil
	case <-time.After(d):
		return nil, fmt.Errorf("no reply in %v", d)
	}
}

func (p *proof) set(t []byte) (time.Duration, error) {
	id := p.id()
	began := time.Now()
	rtcsock.ClipEachPart(t, func(part int, last bool, chunk []byte) bool {
		p.clip.Submit(rtcsock.ClipSet(id, part, last, chunk))

		return true
	})
	r, err := p.wait(10 * time.Second)
	if err != nil {
		return 0, err
	}
	if r.ID != id || !r.OK {
		return 0, fmt.Errorf("set: id %d code %q", r.ID, r.Code)
	}

	return time.Since(began), nil
}

func (p *proof) get(maxBytes int) (*rtcsock.ClipReply, time.Duration, error) {
	id := p.id()
	began := time.Now()
	p.clip.Submit(rtcsock.ClipGet(id, maxBytes))
	r, err := p.wait(30 * time.Second)
	if err != nil {
		return nil, 0, err
	}
	if r.ID != id {
		return nil, 0, fmt.Errorf("reply to %d, wanted %d", r.ID, id)
	}

	return r, time.Since(began), nil
}

func (p *proof) drainChanged() {
	for {
		select {
		case <-p.changed:
		default:
			return
		}
	}
}

func (p *proof) waitChanged(d time.Duration) error {
	select {
	case <-p.changed:
		return nil
	case <-time.After(d):
		return fmt.Errorf("no clipboard.changed in %v", d)
	}
}

// pageBytes is how many UTF-8 bytes the textarea holds.
func (p *proof) pageBytes() (int, error) {
	v, err := p.cdp.eval(`new TextEncoder().encode(document.getElementById('t').value).length`)
	if err != nil {
		return 0, err
	}
	var n int
	err = json.Unmarshal(v, &n)

	return n, err
}

func (p *proof) pageText() ([]byte, error) {
	v, err := p.cdp.eval(`document.getElementById('t').value`)
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return nil, err
	}

	return []byte(s), nil
}

func (p *proof) setPage(t []byte) error {
	lit, err := json.Marshal(string(t))
	if err != nil {
		return err
	}
	_, err = p.cdp.eval(`(() => { const t = document.getElementById('t'); t.value = ` + string(lit) + `; t.focus(); t.select(); })()`)

	return err
}

func fail(r phaseResult, err error) phaseResult {
	r.Error = err.Error()

	return r
}

// paste is what a member's paste will do: write, wait for the reply, send the key.
func (p *proof) paste(n int) phaseResult {
	r := phaseResult{Phase: "paste", Bytes: n}
	want := fit(n)
	if _, err := p.cdp.eval(`(() => { const t = document.getElementById('t'); t.value = ''; t.focus(); })()`); err != nil {
		return fail(r, err)
	}
	took, err := p.set(want)
	if err != nil {
		return fail(r, err)
	}
	r.ReplyMs = took.Milliseconds()
	began := time.Now()
	if err := p.x.chord(keysymV); err != nil {
		return fail(r, err)
	}
	deadline := began.Add(60 * time.Second)
	for {
		got, err := p.pageBytes()
		if err != nil {
			return fail(r, err)
		}
		if got >= n {
			break
		}
		if time.Now().After(deadline) {
			return fail(r, fmt.Errorf("the page has %d of %d bytes after 60 s", got, n))
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.ArrivedMs = time.Since(began).Milliseconds()
	got, err := p.pageText()
	if err != nil {
		return fail(r, err)
	}
	if !bytes.Equal(got, want) {
		return fail(r, fmt.Errorf("the page has %d bytes that differ from the %d sent", len(got), len(want)))
	}
	r.OK = true

	return r
}

// copyText is what a member's copy will do: the key, clipboard.changed, then a read.
func (p *proof) copyText(n int) phaseResult {
	r := phaseResult{Phase: "copy", Bytes: n}
	want := fit(n)
	if err := p.setPage(want); err != nil {
		return fail(r, err)
	}
	p.drainChanged()
	began := time.Now()
	if err := p.x.chord(keysymC); err != nil {
		return fail(r, err)
	}
	if err := p.waitChanged(30 * time.Second); err != nil {
		return fail(r, err)
	}
	r.ReplyMs = time.Since(began).Milliseconds()
	reply, took, err := p.get(1_000_000)
	if err != nil {
		return fail(r, err)
	}
	r.ArrivedMs = took.Milliseconds()
	if !bytes.Equal(reply.Text, want) {
		return fail(r, fmt.Errorf("clipboard.get gave %d bytes, code %q, none %v, wanted %d", len(reply.Text), reply.Code, reply.None, len(want)))
	}
	r.OK = true

	return r
}

// overCap reads what copyText left, with maxBytes one under: too_large, with no piece of it.
func (p *proof) overCap(n int) phaseResult {
	r := phaseResult{Phase: "get one byte under", Bytes: n}
	reply, took, err := p.get(n - 1)
	if err != nil {
		return fail(r, err)
	}
	r.ReplyMs = took.Milliseconds()
	if reply.Code != rtcsock.ClipTooLarge || len(reply.Text) != 0 {
		return fail(r, fmt.Errorf("got code %q and %d bytes", reply.Code, len(reply.Text)))
	}
	r.OK = true

	return r
}

// selectionAloneDoesNothing checks PRIMARY is left out. Selecting text in Chromium on X takes PRIMARY, not
// CLIPBOARD, so with no copy key there's no clipboard.changed, and a read still gets the clipboard's own text.
func (p *proof) selectionAloneDoesNothing() phaseResult {
	r := phaseResult{Phase: "selecting without copying", Bytes: 17}
	mine := fit(17)
	if _, err := p.set(mine); err != nil {
		return fail(r, err)
	}
	lit, err := json.Marshal(string(fit(500)))
	if err != nil {
		return fail(r, err)
	}
	// Nothing selected yet: pressing on a selection would start a drag and drop instead, which holds the
	// keyboard until it ends.
	js := `(() => { const t = document.getElementById('t'); t.value = ` + string(lit) + `; t.focus(); t.setSelectionRange(0, 0); })()`
	if _, err := p.cdp.eval(js); err != nil {
		return fail(r, err)
	}
	p.drainChanged()
	primary, err := xproto.InternAtom(p.x.c, false, 7, "PRIMARY").Reply()
	if err != nil {
		return fail(r, err)
	}
	// A real selection by the pointer, which is what makes Chromium take PRIMARY.
	fromX, fromY, err := p.rootOf(60, 60)
	if err != nil {
		return fail(r, err)
	}
	toX, toY, err := p.rootOf(500, 120)
	if err != nil {
		return fail(r, err)
	}
	xtest.FakeInput(p.x.c, xproto.MotionNotify, 0, 0, p.x.root, fromX, fromY, 0)
	xtest.FakeInput(p.x.c, xproto.ButtonPress, 1, 0, xproto.WindowNone, 0, 0, 0)
	if err := p.x.sync(); err != nil {
		return fail(r, err)
	}
	time.Sleep(50 * time.Millisecond)
	xtest.FakeInput(p.x.c, xproto.MotionNotify, 0, 0, p.x.root, toX, toY, 0)
	if err := p.x.sync(); err != nil {
		return fail(r, err)
	}
	time.Sleep(50 * time.Millisecond)
	xtest.FakeInput(p.x.c, xproto.ButtonRelease, 1, 0, xproto.WindowNone, 0, 0, 0)
	if err := p.x.sync(); err != nil {
		return fail(r, err)
	}
	if err := p.waitChanged(time.Second); err == nil {
		return fail(r, errors.New("clipboard.changed from a selection alone"))
	}
	v, err := p.cdp.eval(`(() => { const t = document.getElementById('t'); return t.selectionEnd - t.selectionStart; })()`)
	if err != nil {
		return fail(r, err)
	}
	if string(v) == "0" {
		return fail(r, errors.New("the drag selected nothing, so this proved nothing"))
	}
	owner, err := xproto.GetSelectionOwner(p.x.c, primary.Atom).Reply()
	if err != nil {
		return fail(r, err)
	}
	if owner.Owner == xproto.WindowNone {
		return fail(r, errors.New("Chromium didn't take PRIMARY, so this proved nothing"))
	}
	reply, _, err := p.get(1000)
	if err != nil {
		return fail(r, err)
	}
	if !bytes.Equal(reply.Text, mine) {
		return fail(r, fmt.Errorf("the read gave %d bytes, code %q", len(reply.Text), reply.Code))
	}
	r.OK = true

	return r
}

// pasteAfterChromiumReads pastes the same text twice, so Chromium reads it twice from one set.
func (p *proof) pasteAfterChromiumReads() phaseResult {
	r := phaseResult{Phase: "two pastes from one set", Bytes: 300_000}
	want := fit(300_000)
	if _, err := p.cdp.eval(`(() => { const t = document.getElementById('t'); t.value = ''; t.focus(); })()`); err != nil {
		return fail(r, err)
	}
	if _, err := p.set(want); err != nil {
		return fail(r, err)
	}
	for range 2 {
		if err := p.x.chord(keysymV); err != nil {
			return fail(r, err)
		}
		time.Sleep(time.Second)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		got, err := p.pageBytes()
		if err != nil {
			return fail(r, err)
		}
		if got == 2*len(want) {
			break
		}
		if time.Now().After(deadline) {
			return fail(r, fmt.Errorf("the page has %d bytes", got))
		}
		time.Sleep(50 * time.Millisecond)
	}
	got, err := p.pageText()
	if err != nil {
		return fail(r, err)
	}
	if !bytes.Equal(got, append(bytes.Clone(want), want...)) {
		return fail(r, errors.New("the two pastes differ from what was set"))
	}
	r.OK = true

	return r
}
