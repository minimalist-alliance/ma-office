package fakedesk

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/frame"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/rtcsock"
)

// Cookie is one item of data.browser.cookies.
type Cookie struct {
	K string `json:"k"`
	V string `json:"v"`
	E int64  `json:"e"`
}

// ReadLog is one data.read the desk answered.
type ReadLog struct {
	Part, Path string
	Offset     int64
	Session    int
}

// Desk serves deskd's data.* methods from Root, which stands for the cloud desk's /data, with the
// helper's exclusions (draft ADR, sections 4 and 7).
type Desk struct {
	Root        string
	PageSize    int // manifest page size; 0 means 2,000
	MaxInFlight int // 0 means 8
	Cookies     []Cookie
	// CorruptRead flips a byte of what's sent on the nth read (from 1) of a file, keeping the trailer true.
	CorruptRead func(part, path string, n int) bool
	// DropAfterBytes closes the first session once this many file bytes went out, mid-file.
	DropAfterBytes int64
	// FailRead ends the nth read (from 1) of a file halfway with an END that has no trailer, as deskd does
	// when its helper fails.
	FailRead func(part, path string, n int) bool
	// ChunksBeforeReply sends a transfer's first chunk before data.read's RES.
	ChunksBeforeReply bool
	// OnHold runs inside data.browser.hold, as Chromium stopping would change files.
	OnHold func()
	// OnManifest runs before the first page of a listing, with how many times that part has been listed
	// (from 1). A move lists a part once at its start and once more on its last pass, so 2 is between them.
	OnManifest func(part string, n int)
	// OnRead runs as the nth read (from 1) of a file starts, under the desk's lock, after that read's bytes
	// were taken. A code it returns refuses the read with that RPC error, as deskd does when its helper fails.
	OnRead func(part, path string, n int) string
	// Helper answers data.manifest and data.read in Root's place, as desk-data does behind deskd.
	Helper *RealHelper
	// RefuseHold refuses the nth data.browser.hold (from 1, renewals included) with the RPC error it returns, as
	// deskd does when Chromium won't stop. A session that held then holds no more, as deskd drops it.
	RefuseHold func(n int) string
	// OnHoldLost runs when a hold ends other than by data.browser.release: its session ended, or a renewal was
	// refused. deskd then starts Chromium again, which can write to the profile.
	OnHoldLost func()
	// NoKeep answers data.browser.keep not_found, as a deskd from before it does.
	NoKeep bool
	// RefuseKeep refuses the nth data.browser.keep (from 1) with the RPC error and reason it returns, as deskd does when
	// it can't write its file ("unavailable", "disk"). An empty code keeps it.
	RefuseKeep func(n int) (code, reason string)
	// DropOnKeep closes the session as the nth data.browser.keep (from 1) comes, before it's answered, when it returns
	// true. Whether it was kept is DropKeeps.
	DropOnKeep func(n int) bool
	// DropKeeps says whether a keep that DropOnKeep dropped was kept all the same, as deskd may have written it.
	DropKeeps bool
	// DropOnRead closes the session as the nth read (from 1) of a file starts, when it returns true.
	DropOnRead func(part, path string, n int) bool
	// EditManifest may change a data.manifest reply's JSON before it's sent.
	EditManifest func(part string, page []byte) []byte

	mu         sync.Mutex
	sessions   int
	dropped    bool
	readsOf    map[string]int
	listsOf    map[string]int
	Reads      []ReadLog
	Grants     []int64
	MaxActive  int
	Holds      int
	Releases   int
	Held       bool
	HeldOnRead bool // a browser read happened while held
	holder     int  // the session holding the Browser, 0 for none
	HoldsBy    []int
	HoldsLost  int
	// Kept is a move's hold kept past its session (data.browser.keep): Chromium stays stopped, whatever ends.
	Kept  bool
	Keeps int
	// Restarts counts the holds that ended with nothing kept, each of which deskd follows by starting Chromium again
	// if it was running: after a move's last pass, the cookies the target now has.
	Restarts int
	// UnheldBrowserReads counts browser reads that started, after the first hold, while nothing held it.
	UnheldBrowserReads int
	Auths              int
	NoIdem             int  // mutations refused for want of idem
	Overrun            bool // the reader's credit was exceeded (never, by construction)
}

// Stats is a copy of the counters, safe to read.
type Stats struct {
	Sessions, MaxActive, Holds, Releases, Auths, NoIdem int
	Reads                                               []ReadLog
	Grants                                              []int64
	Held, HeldOnRead                                    bool
	HoldsBy                                             []int // the session of each hold asked for
	HoldsLost, UnheldBrowserReads                       int
	Kept                                                bool
	Keeps, Restarts                                     int
}

// Stats returns the counters.
func (d *Desk) Stats() Stats {
	d.mu.Lock()
	defer d.mu.Unlock()

	return Stats{
		Sessions: d.sessions, MaxActive: d.MaxActive, Holds: d.Holds, Releases: d.Releases, Auths: d.Auths, NoIdem: d.NoIdem,
		Reads: append([]ReadLog(nil), d.Reads...), Grants: append([]int64(nil), d.Grants...), Held: d.Held, HeldOnRead: d.HeldOnRead,
		HoldsBy: append([]int(nil), d.HoldsBy...), HoldsLost: d.HoldsLost, UnheldBrowserReads: d.UnheldBrowserReads,
		Kept: d.Kept, Keeps: d.Keeps, Restarts: d.Restarts,
	}
}

type xfer struct {
	mu      sync.Mutex
	cond    *sync.Cond
	credit  int64
	stopped bool
}

type conn struct {
	d       *Desk
	e       *End
	n       int
	mu      sync.Mutex
	nextID  uint32
	xfers   map[uint32]*xfer
	active  int
	partial map[uint32][]byte
}

// Serve answers one session on e, the desk's end of a Pipe.
func (d *Desk) Serve(e *End) {
	d.mu.Lock()
	d.sessions++
	n := d.sessions
	if d.readsOf == nil {
		d.readsOf = map[string]int{}
	}
	d.mu.Unlock()
	c := &conn{d: d, e: e, n: n, xfers: map[uint32]*xfer{}, partial: map[uint32][]byte{}, nextID: 100}
	e.SetReceiver(c.onMessage)
	go func() {
		<-e.Done()
		c.mu.Lock()
		for _, x := range c.xfers {
			x.mu.Lock()
			x.stopped = true
			x.cond.Broadcast()
			x.mu.Unlock()
		}
		c.mu.Unlock()
		d.loseHold(n) // deskd lets go of a session's hold when it ends
	}()
}

// loseHold ends session n's hold, if it has one, other than by a release.
func (d *Desk) loseHold(n int) {
	d.mu.Lock()
	if d.holder != n {
		d.mu.Unlock()

		return
	}
	d.holder, d.Held = 0, false
	d.HoldsLost++
	hook := d.OnHoldLost
	if d.Kept {
		hook = nil // deskd starts Chromium again only when no hold is left, and a kept one is
	} else {
		d.Restarts++
	}
	d.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (c *conn) send(channel uint8, kind frame.Kind, flags uint8, id, seq uint32, body []byte) {
	for len(body) > frame.MaxPayload {
		_ = c.e.Send(channel, frame.Encode(kind, flags|frame.FlagMore, id, seq, body[:frame.MaxPayload]))
		body = body[frame.MaxPayload:]
	}
	_ = c.e.Send(channel, frame.Encode(kind, flags, id, seq, body))
}

func (c *conn) reply(id uint32, v any) {
	b, _ := json.Marshal(v)
	c.send(rtcsock.ChRPC, frame.Res, 0, id, 0, b)
}

func (c *conn) fail(id uint32, code, reason string) {
	b, _ := json.Marshal(map[string]any{"code": code, "message": code, "details": map[string]any{"reason": reason}})
	c.send(rtcsock.ChRPC, frame.Err, 0, id, 0, b)
}

func (c *conn) onMessage(channel uint8, b []byte) {
	f, err := frame.Decode(b)
	if err != nil {
		_ = c.e.Close()

		return
	}
	switch {
	case channel == rtcsock.ChCtl && f.Kind == frame.Hello:
		body, _ := json.Marshal(map[string]any{
			"deskApi": "1.0", "sessionId": fmt.Sprintf("cs-%d", c.n), "resumeToken": "rt", "resumed": false,
			"deskId": "d-source", "service": "deskd", "version": "fake",
		})
		c.send(rtcsock.ChCtl, frame.Hello, 0, f.ID, 0, body)
	case channel == rtcsock.ChCtl && f.Kind == frame.Ping:
		c.send(rtcsock.ChCtl, frame.Pong, 0, f.ID, 0, f.Payload)
	case channel == rtcsock.ChCtl && f.Kind == frame.Auth:
		c.d.mu.Lock()
		c.d.Auths++
		c.d.mu.Unlock()
		c.send(rtcsock.ChCtl, frame.Auth, 0, f.ID, 0, []byte(`{"ok":true,"validUntil":"2099-01-01T00:00:00Z"}`))
	case channel == rtcsock.ChRPC && f.Kind == frame.Req:
		if f.Flags&frame.FlagMore != 0 {
			c.partial[f.ID] = append(c.partial[f.ID], f.Payload...)

			return
		}
		payload := append(c.partial[f.ID], f.Payload...)
		delete(c.partial, f.ID)
		go c.handle(f.ID, payload)
	case channel == rtcsock.ChBulk && f.Kind == frame.Credit:
		n, err := frame.DecodeCredit(f.Payload)
		if err != nil {
			return
		}
		c.d.mu.Lock()
		c.d.Grants = append(c.d.Grants, n)
		c.d.mu.Unlock()
		c.mu.Lock()
		x := c.xfers[f.ID]
		c.mu.Unlock()
		if x != nil {
			x.mu.Lock()
			x.credit += n
			x.cond.Broadcast()
			x.mu.Unlock()
		}
	}
}

func (c *conn) handle(id uint32, payload []byte) {
	var req struct {
		M    string          `json:"m"`
		P    json.RawMessage `json:"p"`
		Idem string          `json:"idem"`
	}
	if json.Unmarshal(payload, &req) != nil {
		c.fail(id, "bad_request", "json")

		return
	}
	// Mutations need idem, as deskd's RpcSession says (API.md section 4): without it, bad_request.
	if (req.M == "data.browser.hold" || req.M == "data.browser.release" || req.M == "data.browser.keep") && (req.Idem == "" || len(req.Idem) > 128) {
		c.d.mu.Lock()
		c.d.NoIdem++
		c.d.mu.Unlock()
		c.fail(id, "bad_request", "This method needs idem")

		return
	}
	// Names as deskd takes them: a \udcXX escape is the byte desk-data made it from (fsname).
	var p struct {
		Part       fsname.Name  `json:"part"`
		Path       fsname.Name  `json:"path"`
		Offset     int64        `json:"offset"`
		Cursor     *fsname.Name `json:"cursor"`
		TransferID uint32       `json:"transferId"`
	}
	_ = json.Unmarshal(req.P, &p)
	part, rel := string(p.Part), string(p.Path)
	var cursor *string
	if p.Cursor != nil {
		c := string(*p.Cursor)
		cursor = &c
	}
	d := c.d
	switch req.M {
	case "desk.status.get":
		c.reply(id, map[string]any{"deskId": "d-source"})
	case "data.parts.list":
		c.reply(id, d.partsList())
	case "data.manifest":
		if cursor == nil {
			d.listed(part)
		}
		if d.Helper != nil {
			page, code := d.Helper.Manifest(part, cursor)
			if code != "" {
				c.fail(id, code, "helper")

				return
			}
			c.reply(id, page)

			return
		}
		entries, next, err := d.manifest(part, cursor)
		if err != nil {
			c.fail(id, "not_found", "part")

			return
		}
		var nextName *fsname.Name
		if next != nil {
			n := fsname.Name(*next)
			nextName = &n
		}
		page, _ := json.Marshal(map[string]any{"entries": entries, "next": nextName})
		if d.EditManifest != nil {
			page = d.EditManifest(part, page)
		}
		c.reply(id, json.RawMessage(page))
	case "data.read":
		c.read(id, part, rel, p.Offset)
	case "data.read.stop":
		c.mu.Lock()
		x := c.xfers[p.TransferID]
		c.mu.Unlock()
		if x != nil {
			x.mu.Lock()
			x.stopped = true
			x.cond.Broadcast()
			x.mu.Unlock()
		}
		c.reply(id, map[string]any{})
	case "data.browser.cookies":
		items := d.Cookies
		if items == nil {
			items = []Cookie{}
		}
		c.reply(id, map[string]any{"count": len(items), "items": items})
	case "data.browser.hold":
		d.mu.Lock()
		d.Holds++
		d.HoldsBy = append(d.HoldsBy, c.n)
		refuse := ""
		if d.RefuseHold != nil {
			refuse = d.RefuseHold(d.Holds)
		}
		if refuse != "" {
			d.mu.Unlock()
			d.loseHold(c.n)
			c.fail(id, refuse, "chromium")

			return
		}
		d.holder, d.Held = c.n, true
		hook := d.OnHold
		d.mu.Unlock()
		if hook != nil {
			hook()
		}
		c.reply(id, map[string]any{"held": true, "until": time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339)})
	case "data.browser.keep":
		d.mu.Lock()
		if d.NoKeep {
			d.mu.Unlock()
			c.fail(id, "not_found", "method")

			return
		}
		d.Keeps++
		n := d.Keeps
		code, reason := "", ""
		if d.RefuseKeep != nil {
			code, reason = d.RefuseKeep(n)
		}
		drop := d.DropOnKeep != nil && d.DropOnKeep(n)
		switch {
		case drop:
			if d.DropKeeps && d.holder == c.n {
				d.Kept = true
			}
			d.mu.Unlock()
			_ = c.e.Close()
			d.loseHold(c.n)

			return
		case d.holder != c.n:
			d.mu.Unlock()
			c.fail(id, "unavailable", "not_held")

			return
		case code != "":
			d.mu.Unlock()
			c.fail(id, code, reason)

			return
		}
		d.Kept = true
		d.mu.Unlock()
		c.reply(id, map[string]any{"held": true, "kept": true, "since": time.Now().UTC().Format(time.RFC3339)})
	case "data.browser.release":
		d.mu.Lock()
		d.Releases++
		if d.holder == c.n {
			d.holder, d.Held = 0, false
			if !d.Kept {
				d.Restarts++
			}
		}
		held := d.Held || d.Kept
		d.mu.Unlock()
		c.reply(id, map[string]any{"held": held})
	default:
		c.fail(id, "not_found", "method")
	}
}

// listed counts a listing of a part and runs OnManifest.
func (d *Desk) listed(part string) {
	d.mu.Lock()
	if d.listsOf == nil {
		d.listsOf = map[string]int{}
	}
	d.listsOf[part]++
	n := d.listsOf[part]
	hook := d.OnManifest
	d.mu.Unlock()
	if hook != nil {
		hook(part, n)
	}
}

func validRel(p string) bool {
	return p != "" && !strings.HasPrefix(p, "/") && path.Clean(p) == p && p != "." && !strings.HasPrefix(p, "../") && p != ".."
}

// body is what one data.read sends: the length counting from byte 0, the file's time, the bytes from the
// offset asked for, and the END frame's trailer.
type body struct {
	size, mtimeMs int64
	sent, trailer []byte
}

// load takes one read's bytes from the helper, or from Root. A code that isn't "" refuses the read.
func (d *Desk) load(part, rel string, offset int64) (body, string, string) {
	if d.Helper != nil {
		b, code := d.Helper.Read(part, rel, offset)

		return b, code, "helper"
	}
	if !validRel(part) || strings.Contains(part, "/") || !validRel(rel) {
		return body{}, "invalid", "path"
	}
	if part == "browser-readable" || excluded(part, rel) {
		return body{}, "not_found", "path"
	}
	full := filepath.Join(d.Root, part, filepath.FromSlash(rel))
	fi, err := os.Lstat(full)
	if err != nil {
		return body{}, "not_found", "path"
	}
	if !fi.Mode().IsRegular() {
		return body{}, "invalid", "path"
	}
	content, err := os.ReadFile(full)
	if err != nil {
		return body{}, "unavailable", "helper"
	}
	if offset < 0 || offset > int64(len(content)) {
		return body{}, "invalid", "offset"
	}
	sum := sha256.Sum256(content)

	return body{
		size: int64(len(content)), mtimeMs: fi.ModTime().UnixMilli(), sent: content[offset:],
		trailer: frame.EncodeTrailer(frame.Trailer{SHA256: sum, Size: uint64(len(content))}),
	}, "", ""
}

func (c *conn) read(id uint32, part, rel string, offset int64) {
	d := c.d
	b, code, reason := d.load(part, rel, offset)
	if code != "" {
		c.fail(id, code, reason)

		return
	}
	limit := d.MaxInFlight
	if limit == 0 {
		limit = 8
	}
	c.mu.Lock()
	if c.active >= limit {
		c.mu.Unlock()
		c.fail(id, "too_many", "")

		return
	}
	c.active++
	c.nextID++
	tid := c.nextID
	x := &xfer{credit: 1 << 20}
	x.cond = sync.NewCond(&x.mu)
	c.xfers[tid] = x
	active := c.active
	c.mu.Unlock()

	d.mu.Lock()
	if active > d.MaxActive {
		d.MaxActive = active
	}
	key := part + "/" + rel
	d.readsOf[key]++
	nth := d.readsOf[key]
	d.Reads = append(d.Reads, ReadLog{Part: part, Path: rel, Offset: offset, Session: c.n})
	if part == "browser" && d.Held {
		d.HeldOnRead = true
	}
	if part == "browser" && !d.Held && d.Holds > 0 {
		d.UnheldBrowserReads++
	}
	drop := d.DropOnRead != nil && d.DropOnRead(part, rel, nth)
	corrupt := d.CorruptRead != nil && d.CorruptRead(part, rel, nth)
	failHalfway := d.FailRead != nil && d.FailRead(part, rel, nth)
	refuse := ""
	if d.OnRead != nil {
		refuse = d.OnRead(part, rel, nth)
	}
	before := d.ChunksBeforeReply
	d.mu.Unlock()
	if drop {
		c.mu.Lock()
		delete(c.xfers, tid)
		c.active--
		c.mu.Unlock()
		d.loseHold(c.n) // before the reader can hear of it, so OnHoldLost runs before it holds again
		_ = c.e.Close()

		return
	}
	if refuse != "" {
		c.mu.Lock()
		delete(c.xfers, tid)
		c.active--
		c.mu.Unlock()
		c.fail(id, refuse, "helper")

		return
	}

	sent, trailer := b.sent, b.trailer
	if corrupt && len(sent) > 0 {
		sent = append([]byte(nil), sent...)
		sent[len(sent)/2] ^= 0xff
	}
	if failHalfway {
		sent, trailer = sent[:len(sent)/2], []byte{}
	}
	res := map[string]any{"transferId": tid, "size": b.size, "mtimeMs": b.mtimeMs}

	first := make(chan struct{})
	go c.stream(tid, x, sent, trailer, first)
	if before {
		<-first
	}
	c.reply(id, res)
}

func (c *conn) stream(tid uint32, x *xfer, data, trailer []byte, first chan struct{}) {
	var once sync.Once
	signal := func() { once.Do(func() { close(first) }) }
	defer signal()
	defer func() {
		c.mu.Lock()
		delete(c.xfers, tid)
		c.active--
		c.mu.Unlock()
	}()
	var seq uint32
	for len(data) > 0 {
		x.mu.Lock()
		for x.credit <= 0 && !x.stopped {
			x.cond.Wait()
		}
		if x.stopped {
			x.mu.Unlock()

			return
		}
		n := min(int64(len(data)), int64(frame.MaxPayload), x.credit)
		x.credit -= n
		x.mu.Unlock()
		c.send(rtcsock.ChBulk, frame.Chunk, frame.FlagBin, tid, seq, data[:n])
		seq++
		data = data[n:]
		signal()
		if c.countSent(n) {
			return
		}
	}
	c.send(rtcsock.ChBulk, frame.Chunk, frame.FlagBin|frame.FlagEnd, tid, seq, trailer)
}

// countSent drops the first session once DropAfterBytes went out. It reports whether it did.
func (c *conn) countSent(n int64) bool {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.DropAfterBytes <= 0 || d.dropped {
		return false
	}
	d.DropAfterBytes -= n
	if d.DropAfterBytes <= 0 {
		d.dropped = true
		_ = c.e.Close()

		return true
	}

	return false
}

var browserCaches = map[string]bool{
	"Cache": true, "Code Cache": true, "GPUCache": true, "DawnCache": true, "DawnGraphiteCache": true,
	"DawnWebGPUCache": true, "GrShaderCache": true, "GraphiteDawnCache": true, "ShaderCache": true,
	"component_crx_cache": true, "Crashpad": true, "SingletonLock": true, "SingletonCookie": true, "SingletonSocket": true,
}

// excluded is the helper's list of what isn't the member's (draft ADR, section 4).
func excluded(part, rel string) bool {
	parts := strings.Split(rel, "/")
	switch part {
	case "desk":
		return rel == "volume.json"
	case "apps":
		if rel == "registry.json" {
			return true
		}
		if len(parts) >= 2 {
			switch parts[1] {
			case "releases", "current", "previous", "cache":
				return true
			}
		}
	case "browser":
		if len(parts) >= 2 && parts[0] == "profile" && browserCaches[parts[1]] {
			return true
		}
		if len(parts) >= 3 && parts[0] == "profile" && browserCaches[parts[2]] {
			return true
		}
	}
	for _, p := range parts {
		if strings.HasSuffix(p, "-journal") || strings.HasSuffix(p, "-wal") || strings.HasSuffix(p, "-shm") {
			return true
		}
	}

	return false
}

var leftOutParts = map[string]bool{"rtc": true, "desk-egress": true, "lost+found": true}

// entry is one manifest entry, its names written as desk-data writes them and deskd passes them on (fsname).
type entry struct {
	Path    fsname.Name `json:"path"`
	Type    string      `json:"type"`
	Size    int64       `json:"size"`
	MtimeMs int64       `json:"mtimeMs"`
	Mode    uint32      `json:"mode"`
	Target  fsname.Name `json:"target,omitempty"`
}

func (d *Desk) walk(part string) ([]entry, error) {
	root := filepath.Join(d.Root, part)
	if fi, err := os.Lstat(root); err != nil || !fi.IsDir() {
		return nil, errors.New("no such part")
	}
	var out []entry
	var walk func(dir, rel string) error
	walk = func(dir, rel string) error {
		des, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
		for _, de := range des {
			r := de.Name()
			if rel != "" {
				r = rel + "/" + de.Name()
			}
			if excluded(part, r) {
				continue
			}
			full := filepath.Join(dir, de.Name())
			fi, err := os.Lstat(full)
			if err != nil {
				continue
			}
			e := entry{Path: fsname.Name(r), MtimeMs: fi.ModTime().UnixMilli(), Mode: uint32(fi.Mode().Perm())}
			switch {
			case fi.Mode()&fs.ModeSymlink != 0:
				e.Type = "link"
				t, _ := os.Readlink(full)
				e.Target = fsname.Name(t)
				out = append(out, e)
			case fi.IsDir():
				e.Type = "dir"
				out = append(out, e)
				if err := walk(full, r); err != nil {
					return err
				}
			case fi.Mode().IsRegular():
				e.Type = "file"
				e.Size = fi.Size()
				out = append(out, e)
			}
		}

		return nil
	}

	return out, walk(root, "")
}

func less(a, b string) bool {
	as, bs := strings.Split(a, "/"), strings.Split(b, "/")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if c := bytes.Compare([]byte(as[i]), []byte(bs[i])); c != 0 {
			return c < 0
		}
	}

	return len(as) < len(bs)
}

func (d *Desk) manifest(part string, cursor *string) ([]entry, *string, error) {
	all, err := d.walk(part)
	if err != nil {
		return nil, nil, err
	}
	size := d.PageSize
	if size == 0 {
		size = 2000
	}
	start := 0
	if cursor != nil {
		start = len(all)
		for i, e := range all {
			if less(*cursor, string(e.Path)) {
				start = i

				break
			}
		}
	}
	end := min(len(all), start+size)
	page := all[start:end]
	if page == nil {
		page = []entry{}
	}
	if end == len(all) {
		return page, nil, nil
	}
	next := string(page[len(page)-1].Path)

	return page, &next, nil
}

type partInfo struct {
	Part  string `json:"part"`
	Label string `json:"label"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}

func (d *Desk) partsList() map[string]any {
	des, _ := os.ReadDir(d.Root)
	parts := []partInfo{}
	for _, de := range des {
		name := de.Name()
		if !de.IsDir() || leftOutParts[name] || strings.HasPrefix(name, ".") {
			continue
		}
		es, _ := d.walk(name)
		p := partInfo{Part: name, Label: name}
		for _, e := range es {
			if e.Type == "file" {
				p.Files++
				p.Bytes += e.Size
			}
		}
		parts = append(parts, p)
		if name == "browser" {
			if fi, err := os.Stat(filepath.Join(d.Root, "browser", "profile")); err == nil && fi.IsDir() {
				parts = append(parts, partInfo{Part: "browser-readable", Label: "Browser, readable", Files: 1, Bytes: 10})
			}
		}
	}

	return map[string]any{"parts": parts, "helperVersion": "fake"}
}
