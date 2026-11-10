// Package cdp reads this desk's Chromium cookies over its debugging port and keeps only their hashes,
// the way deskd's data.browser.cookies does (draft ADR data export and transfer, section 7).
package cdp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Item is one cookie as hashes: K of "domain\tname\tpath", V of the value, 16 hex characters each, and E its
// expiry in Unix seconds, -1 for a session cookie, as deskd's data.browser.cookies gives them.
type Item struct {
	K string `json:"k"`
	V string `json:"v"`
	E int64  `json:"e"`
}

func short(s string) string {
	sum := sha256.Sum256([]byte(s))

	return hex.EncodeToString(sum[:])[:16]
}

// Key hashes a cookie's identity.
func Key(domain, name, path string) string { return short(domain + "\t" + name + "\t" + path) }

// Value hashes a cookie's value.
func Value(v string) string { return short(v) }

// Expired reports whether an expiry (Unix seconds; -1 or 0 for none) has passed.
func Expired(e int64, now time.Time) bool { return e > 0 && e < now.Unix() }

type cookie struct {
	Name    string  `json:"name"`
	Value   string  `json:"value"`
	Domain  string  `json:"domain"`
	Path    string  `json:"path"`
	Expires float64 `json:"expires"`
	Session bool    `json:"session"`
}

// digest turns CDP cookies into items. CDP's expires is seconds with a fraction, -1 for a session cookie.
func digest(cs []cookie) []Item {
	out := make([]Item, 0, len(cs))
	for _, c := range cs {
		e := int64(-1)
		if !c.Session && c.Expires > 0 {
			e = int64(c.Expires)
		}
		out = append(out, Item{K: Key(c.Domain, c.Name, c.Path), V: Value(c.Value), E: e})
	}

	return out
}

// WaitAndRead waits up to wait for Chromium's debugging port at base (http://127.0.0.1:9222), then
// reads every cookie with Storage.getCookies. On a desk only root and deskd may reach that port
// (nftables), so this runs as root; ListenerUID says first whether the port is the Browser's.
func WaitAndRead(ctx context.Context, base string, wait time.Duration) ([]Item, error) {
	deadline := time.Now().Add(wait)
	var wsURL string
	var lastErr error
	for {
		wsURL, lastErr = browserSocket(ctx, base)
		if lastErr == nil {
			break
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("Chromium's debugging port didn't answer: %w", lastErr)
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return getCookies(ctx, wsURL)
}

func browserSocket(ctx context.Context, base string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/json/version", nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	var v struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return "", err
	}
	if v.WebSocketDebuggerURL == "" {
		return "", errors.New("no webSocketDebuggerUrl")
	}

	return v.WebSocketDebuggerURL, nil
}

func getCookies(ctx context.Context, wsURL string) ([]Item, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	defer c.CloseNow()
	c.SetReadLimit(256 << 20)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"id":1,"method":"Storage.getCookies"}`)); err != nil {
		return nil, err
	}
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			return nil, err
		}
		var m struct {
			ID     int `json:"id"`
			Result struct {
				Cookies []cookie `json:"cookies"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &m) != nil || m.ID != 1 {
			continue
		}
		if m.Error != nil {
			return nil, errors.New("Storage.getCookies: " + m.Error.Message)
		}

		return digest(m.Result.Cookies), nil
	}
}
