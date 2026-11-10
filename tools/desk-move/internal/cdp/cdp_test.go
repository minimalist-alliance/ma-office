package cdp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A stand-in for Chromium's debugging port: /json/version, then Storage.getCookies on the browser socket.
func fakeChromium(t *testing.T, cookies string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/json/version", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"Browser":"Chrome/156.0.8078.79","webSocketDebuggerUrl":"ws://%s/devtools/browser/x"}`, strings.TrimPrefix(srv.URL, "http://"))
	})
	mux.HandleFunc("/devtools/browser/x", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			http.Error(w, "Chromium refuses an Origin it wasn't told to allow", http.StatusForbidden)

			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_, b, err := c.Read(r.Context())
		if err != nil {
			return
		}
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(b, &req)
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"method":"Target.targetCreated","params":{}}`))
		if req.Method != "Storage.getCookies" {
			_ = c.Write(r.Context(), websocket.MessageText, []byte(fmt.Sprintf(`{"id":%d,"error":{"message":"no"}}`, req.ID)))

			return
		}
		_ = c.Write(r.Context(), websocket.MessageText, []byte(fmt.Sprintf(`{"id":%d,"result":{"cookies":%s}}`, req.ID, cookies)))
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestReadsCookiesAsHashes(t *testing.T) {
	past := time.Now().Add(-time.Hour).Unix()
	future := time.Now().Add(time.Hour).Unix()
	srv := fakeChromium(t, fmt.Sprintf(`[
		{"name":"sid","value":"s3cret","domain":".example.com","path":"/","expires":%d.25,"session":false},
		{"name":"old","value":"x","domain":"example.com","path":"/","expires":%d,"session":false},
		{"name":"tab","value":"y","domain":"example.com","path":"/a","expires":-1,"session":true}]`, future, past))
	items, err := WaitAndRead(context.Background(), srv.URL, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("%+v", items)
	}
	if items[0].K != Key(".example.com", "sid", "/") || items[0].V != Value("s3cret") || items[0].E != future {
		t.Errorf("first: %+v", items[0])
	}
	if len(items[0].K) != 16 || strings.Contains(items[0].K+items[0].V, "s3cret") {
		t.Errorf("not a 16-hex hash: %+v", items[0])
	}
	now := time.Now()
	if !Expired(items[1].E, now) || items[2].E != -1 || Expired(items[2].E, now) || Expired(items[0].E, now) {
		t.Errorf("expiry: %+v", items)
	}
	// The same hash deskd uses: first 16 hex of SHA-256 of "domain\tname\tpath".
	if Key("a", "b", "c") != "8b4e84e4e5d1c12e" {
		t.Errorf("Key: %s", Key("a", "b", "c"))
	}
}

func TestWaitsForChromium(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if _, err := WaitAndRead(ctx, "http://127.0.0.1:1", 1500*time.Millisecond); err == nil {
		t.Fatal("no Chromium, and no error")
	}
	if time.Since(start) < time.Second {
		t.Fatal("it didn't wait")
	}
}

func TestListenerOn(t *testing.T) {
	table := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1102        0 41551 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2406 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000     0        0 41552 1 0000000000000000 20 4 30 10 -1
   2: 00000000:115C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1101        0 41553 1 0000000000000000 100 0 0 10 0
`
	uid, ok, err := findListener(strings.NewReader(table), 9222, false)
	if err != nil || !ok || uid != 1102 {
		t.Fatalf("%d %v %v", uid, ok, err)
	}
	if _, ok, _ := findListener(strings.NewReader(table), 4444, false); ok {
		t.Fatal("found a port nobody listens on")
	}
	v6 := "   0: 00000000000000000000000001000000:2406 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1100        0 9 1\n"
	if uid, ok, _ := findListener(strings.NewReader(v6), 9222, true); !ok || uid != 1100 {
		t.Fatalf("::1: %d %v", uid, ok)
	}
}
