package move

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
)

// SourceCookie is one item of the cloud desk's data.browser.cookies: E is the expiry in Unix seconds, -1 for
// a session cookie (0 from a deskd that doesn't send it, which counts as not expired).
type SourceCookie struct {
	K string `json:"k"`
	V string `json:"v"`
	E int64  `json:"e"`
}

// CookieResult is the proof: counts only.
type CookieResult struct {
	Checked   bool   `json:"checked"`
	Readable  int    `json:"readable"`
	Total     int    `json:"total"`
	Missing   int    `json:"missing"`
	Different int    `json:"different"`
	Note      string `json:"note,omitempty"`
}

// compareCookies counts how many of the cloud desk's cookies this desk's Chromium has with the same
// value. A cookie expired on either side doesn't count.
func compareCookies(src []SourceCookie, local []cdp.Item, now time.Time) CookieResult {
	here := make(map[string]cdp.Item, len(local))
	for _, it := range local {
		if prev, ok := here[it.K]; ok && !cdp.Expired(prev.E, now) {
			continue
		}
		here[it.K] = it
	}
	r := CookieResult{Checked: true}
	seen := map[string]bool{}
	for _, c := range src {
		if seen[c.K] {
			continue
		}
		seen[c.K] = true
		if cdp.Expired(c.E, now) {
			continue
		}
		l, ok := here[c.K]
		if ok && cdp.Expired(l.E, now) {
			continue
		}
		r.Total++
		switch {
		case !ok:
			r.Missing++
		case l.V != c.V:
			r.Different++
		default:
			r.Readable++
		}
	}

	return r
}

func (m *mover) sourceCookiesPath() string { return filepath.Join(m.dir, "cookies-source.json") }

func (m *mover) saveSourceCookies(items []SourceCookie) error {
	b, err := json.Marshal(items)
	if err != nil {
		return err
	}

	return writeFileAtomic(m.sourceCookiesPath(), b, 0o600)
}

func (m *mover) loadSourceCookies() ([]SourceCookie, bool) {
	b, err := os.ReadFile(m.sourceCookiesPath())
	if err != nil {
		return nil, false
	}
	var items []SourceCookie
	if json.Unmarshal(b, &items) != nil {
		return nil, false
	}

	return items, true
}
