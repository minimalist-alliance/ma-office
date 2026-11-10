package move

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/client"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fakedesk"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

const (
	testCode   = "ABCD-EFGH-JKMN"
	targetDesk = "d-target000001"
	sourceDesk = "d-source000001"
)

type fakeAPI struct {
	mu        sync.Mutex
	moveID    string
	claims    int
	proofs    []*ClaimProof
	connects  int
	reports   []PlatformReport
	rawBodies [][]byte
	ended     map[string]bool // move IDs whose token no longer works
	onReport  func(PlatformReport)
}

func (a *fakeAPI) Claim(_ context.Context, code, target string, proof *ClaimProof) (*Claim, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.claims++
	a.proofs = append(a.proofs, proof)
	if code != testCode || target != targetDesk {
		return nil, &APIError{Status: 404, Code: "not_found"}
	}
	id := a.moveID
	if id == "" {
		id = "mv-test1"
	}

	return &Claim{MoveID: id, MoveToken: "tok-" + id, SourceDeskID: sourceDesk, TargetDeskID: targetDesk,
		SourceName: "Personal", TargetName: "Home box"}, nil
}

func (a *fakeAPI) Connect(_ context.Context, moveID, token, fp string, _ bool) (*client.ConnectReply, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.connects++
	if a.ended[moveID] || token != "tok-"+moveID || !strings.HasPrefix(fp, "sha-256 ") {
		return nil, &APIError{Status: 401, Code: "invalid_token"}
	}

	return &client.ConnectReply{DeskID: sourceDesk, Phase: "ready", DeskToken: fmt.Sprintf("dt-%d", a.connects)}, nil
}

func (a *fakeAPI) Report(_ context.Context, moveID, token string, r PlatformReport) error {
	b, _ := json.Marshal(r)
	a.mu.Lock()
	a.reports = append(a.reports, r)
	a.rawBodies = append(a.rawBodies, b)
	hook := a.onReport
	a.mu.Unlock()
	if hook != nil {
		hook(r)
	}

	return nil
}

func (a *fakeAPI) states() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, r := range a.reports {
		out = append(out, r.State)
	}

	return out
}

type fakeSystemd struct {
	mu     sync.Mutex
	units  map[string]bool // exists → active
	ops    []string
	cat    string
	failOn string
}

func (s *fakeSystemd) Exists(u string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.units[u]

	return ok
}

func (s *fakeSystemd) IsActive(u string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.units[u]
}

func (s *fakeSystemd) Stop(units ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, "stop "+strings.Join(units, " "))
	for _, u := range units {
		if _, ok := s.units[u]; ok {
			s.units[u] = false
		}
	}

	return nil
}

func (s *fakeSystemd) Start(u string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, "start "+u)
	if s.failOn == u {
		return errors.New("failed")
	}
	s.units[u] = true

	return nil
}

func (s *fakeSystemd) Cat(string) (string, error) { return s.cat, nil }

func (s *fakeSystemd) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.ops...)
}

const goodUnit = `# /etc/systemd/system/desk-browser.service
[Service]
User=kiosk
ExecStart=/usr/local/lib/ma/desk-browser-start
`

const goodWrapper = `#!/bin/bash
exec /usr/bin/chromium --kiosk --no-first-run --password-store=basic \
  --user-data-dir="$P" --remote-debugging-port=9222
`

type harness struct {
	t       *testing.T
	src     string // the cloud desk's /data
	dst     string // this desk's /data
	desk    *fakedesk.Desk
	api     *fakeAPI
	sd      *fakeSystemd
	out     bytes.Buffer
	env     Env
	chownMu sync.Mutex
	owners  map[string]int // path relative to dst → uid set
	cookies []cdp.Item
}

func random(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)

	return b
}

func sqlite(n int) []byte { return append([]byte("SQLite format 3\x00"), random(n)...) }

func put(t *testing.T, name string, data []byte, mode fs.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, mode); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, target, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, name); err != nil {
		t.Fatal(err)
	}
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, src: t.TempDir(), dst: t.TempDir(), api: &fakeAPI{ended: map[string]bool{}}, owners: map[string]int{}}
	s := h.src
	put(t, filepath.Join(s, "browser/profile/Last Version"), []byte("156.0.8078.79"), 0o600)
	put(t, filepath.Join(s, "browser/profile/Local State"), []byte(`{"os_crypt":{}}`), 0o600)
	put(t, filepath.Join(s, "browser/profile/Default/Cookies"), sqlite(40000), 0o600)
	put(t, filepath.Join(s, "browser/profile/Default/History"), sqlite(3<<20), 0o600)
	put(t, filepath.Join(s, "browser/profile/Default/Preferences"), []byte(`{"v":1}`), 0o600)
	put(t, filepath.Join(s, "browser/profile/Default/Old"), []byte("goes away"), 0o600)
	put(t, filepath.Join(s, "browser/profile/Default/Local Storage/leveldb/000003.log"), random(70000), 0o600)
	put(t, filepath.Join(s, "browser/profile/Cache/data_0"), random(5000), 0o600)
	put(t, filepath.Join(s, "browser/downloads/report.pdf"), random(20000), 0o640)
	link(t, "Preferences", filepath.Join(s, "browser/profile/Default/prefs-link"))
	link(t, "/etc/passwd", filepath.Join(s, "browser/profile/Default/abs-link"))
	link(t, "../../../outside", filepath.Join(s, "browser/profile/Default/escape-link"))
	for i := range 40 {
		put(t, filepath.Join(s, fmt.Sprintf("desk/notebook/page-%02d.md", i)), random(1000+i*100), 0o640)
	}
	put(t, filepath.Join(s, "desk/chat.db"), sqlite(200000), 0o600)
	put(t, filepath.Join(s, "desk/volume.json"), []byte(`{"volumeId":"vol-source"}`), 0o644)
	put(t, filepath.Join(s, "agent/memory.json"), []byte(`{"m":[]}`), 0o600)
	put(t, filepath.Join(s, "apps/notes/data/n.txt"), []byte("notes"), 0o600)
	put(t, filepath.Join(s, "apps/notes/releases/1.0/bin"), []byte("old app"), 0o755)
	put(t, filepath.Join(s, "apps/registry.json"), []byte(`{"apps":{"notes":{"uid":2999}}}`), 0o644)
	put(t, filepath.Join(s, "rtc/key"), []byte("source key"), 0o600)
	put(t, filepath.Join(s, "desk-egress/state.json"), []byte("{}"), 0o600)
	put(t, filepath.Join(s, ".ma-volume"), []byte(`{"volumeId":"vol-source"}`), 0o644)
	put(t, filepath.Join(s, "selfhost/desk.json"), []byte(`{"deskId":"d-elsewhere0001","env":"staging"}`), 0o640)

	d := h.dst
	put(t, filepath.Join(d, "desk/volume.json"), []byte(`{"volumeId":"vol-target"}`), 0o644)
	put(t, filepath.Join(d, "desk/old.txt"), []byte("this desk's own"), 0o600)
	put(t, filepath.Join(d, "browser/profile/Default/Cookies"), []byte("old cookies"), 0o600)
	put(t, filepath.Join(d, "apps/registry.json"), []byte(`{"apps":{"notes":{"uid":2001}}}`), 0o644)
	put(t, filepath.Join(d, "apps/notes/releases/2.0/bin"), []byte("installed app"), 0o755)
	link(t, "releases/2.0", filepath.Join(d, "apps/notes/current"))
	put(t, filepath.Join(d, "apps/notes/data/old.txt"), []byte("old"), 0o600)
	put(t, filepath.Join(d, "rtc/key"), []byte("target key"), 0o600)
	put(t, filepath.Join(d, "desk-egress/state.json"), []byte(`{"t":1}`), 0o600)
	put(t, filepath.Join(d, ".ma-volume"), []byte(`{"volumeId":"vol-target"}`), 0o644)
	put(t, filepath.Join(d, "files/kept.txt"), []byte("a part only this desk has"), 0o644)
	put(t, filepath.Join(d, "selfhost/desk.json"), []byte(`{"deskId":"`+targetDesk+`","userId":"u-1","env":"staging","deskName":"Home box"}`), 0o640)
	put(t, filepath.Join(d, "selfhost/key.pem"), []byte("this desk's own key"), 0o600)

	soon := time.Now().Add(30 * 24 * time.Hour).Unix()
	gone := time.Now().Add(-time.Hour).Unix()
	h.cookies = []cdp.Item{
		{K: cdp.Key(".example.com", "sid", "/"), V: cdp.Value("s3cret"), E: soon},
		{K: cdp.Key("mail.example.org", "auth", "/"), V: cdp.Value("t0ken"), E: -1},
		{K: cdp.Key("old.example.net", "x", "/"), V: cdp.Value("1"), E: gone},
	}
	h.desk = &fakedesk.Desk{Root: h.src, PageSize: 7, Cookies: []fakedesk.Cookie{
		{K: cdp.Key(".example.com", "sid", "/"), V: cdp.Value("s3cret"), E: soon},
		{K: cdp.Key("mail.example.org", "auth", "/"), V: cdp.Value("t0ken"), E: -1},
		{K: cdp.Key("old.example.net", "x", "/"), V: cdp.Value("1"), E: gone},   // expired on both
		{K: cdp.Key("stale.example.net", "y", "/"), V: cdp.Value("2"), E: gone}, // expired there, gone here
	}}
	h.sd = &fakeSystemd{cat: goodUnit, units: map[string]bool{
		"desk-browser": true, "desk-stream": false, "deskd": true, "desk-agent": true,
	}}
	h.env = Env{
		DataRoot: h.dst,
		API:      h.api,
		Dial: func(ctx context.Context, deskID string, connect client.ConnectFunc) (session.Transport, error) {
			if deskID != sourceDesk {
				return nil, fmt.Errorf("dialed %s", deskID)
			}
			if _, err := connect(ctx, "sha-256 AB:CD"); err != nil {
				return nil, err
			}
			c, srv := fakedesk.Pipe()
			h.desk.Serve(srv)

			return c, nil
		},
		Systemd: h.sd,
		Chown: func(name string, uid, gid int) error {
			rel, err := filepath.Rel(h.dst, name)
			if err != nil || strings.HasPrefix(rel, "..") {
				return fmt.Errorf("chown outside the data root: %s", name)
			}
			if uid != gid {
				return fmt.Errorf("uid %d gid %d differ", uid, gid)
			}
			h.chownMu.Lock()
			h.owners[filepath.ToSlash(rel)] = uid
			h.chownMu.Unlock()

			return nil
		},
		FreeBytes:       func(string) (uint64, error) { return 100 << 30, nil },
		ChromiumVersion: func() (string, error) { return "156.0.8078.79", nil },
		BrowserLaunch:   func() (string, error) { return h.sd.cat + "\n" + goodWrapper, nil },
		LocalCookies:    func(context.Context) ([]cdp.Item, error) { return h.cookies, nil },
		Out:             &h.out,
		Backoff:         func(int) time.Duration { return 10 * time.Millisecond },
		Keepalive:       -1,
		ChunkTimeout:    5 * time.Second,
		RefreshEvery:    50 * time.Millisecond,
	}
	if testing.Verbose() {
		h.env.Log = t.Logf
	}

	return h
}

func (h *harness) run(ctx context.Context) int {
	h.t.Helper()

	return Run(ctx, h.env, Options{TargetDesk: targetDesk, Code: func() (string, error) { return "abcd efgh jkmn", nil }})
}

type node struct {
	Type, Mode, Hash, Target string
}

// snapshot is every path under root with its type, mode, content hash and link target.
func snapshot(t *testing.T, root string, skipMove bool) map[string]node {
	t.Helper()
	out := map[string]node{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if skipMove && (rel == ".ma-move" || strings.HasPrefix(rel, ".ma-move/")) {
			return fs.SkipDir
		}
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		n := node{Mode: fi.Mode().String()}
		switch {
		case fi.Mode()&fs.ModeSymlink != 0:
			n.Type = "link"
			n.Target, _ = os.Readlink(p)
		case fi.IsDir():
			n.Type = "dir"
		default:
			n.Type = "file"
			b, _ := os.ReadFile(p)
			sum := sha256.Sum256(b)
			n.Hash = hex.EncodeToString(sum[:])
		}
		out[rel] = n

		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	return out
}

func sameTree(t *testing.T, before, after map[string]node) {
	t.Helper()
	var diffs []string
	for k, v := range before {
		if w, ok := after[k]; !ok || w != v {
			diffs = append(diffs, "changed or gone: "+k)
		}
	}
	for k := range after {
		if _, ok := before[k]; !ok {
			diffs = append(diffs, "new: "+k)
		}
	}
	sort.Strings(diffs)
	if len(diffs) > 0 {
		t.Fatalf("the data root changed:\n%s", strings.Join(diffs, "\n"))
	}
}

func fileEq(t *testing.T, a, b string) {
	t.Helper()
	x, err := os.ReadFile(a)
	if err != nil {
		t.Fatal(err)
	}
	y, err := os.ReadFile(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(x, y) {
		t.Fatalf("%s differs from %s", b, a)
	}
}

func readsOf(st fakedesk.Stats, part, rel string) []fakedesk.ReadLog {
	var out []fakedesk.ReadLog
	for _, r := range st.Reads {
		if r.Part == part && r.Path == rel {
			out = append(out, r)
		}
	}

	return out
}
