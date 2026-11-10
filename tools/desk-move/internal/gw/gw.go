// Copied from desk-rtc/internal/gw/gw.go at desk-rtc commit 42e6a09 (Go's internal rule stops an import
// across modules). Trimmed to the client side and the fields ma-move reads.

// Package gw holds the gateway contract's framing (gateway.md, contract 0.3.3) for a client.
package gw

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	neturl "net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// Subprotocol is required at upgrade.
	Subprotocol  = "ma.gw.v1"
	readLimit    = 1 << 20
	writeTimeout = 10 * time.Second
)

// Msg is the union of the fields this client reads. Unknown fields are ignored, per the contract.
type Msg struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	DeskID    string          `json:"deskId,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Reason    string          `json:"reason,omitempty"`
	Code      string          `json:"code,omitempty"`
	Message   string          `json:"message,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// Signal is Desk's payload inside signal.data. The contract leaves it to Desk.
type Signal struct {
	Type    string `json:"type"` // offer, answer or refusal
	SDP     string `json:"sdp,omitempty"`
	Restart bool   `json:"restart,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// Conn is a client side of the gateway link. Send is safe from any goroutine.
type Conn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

// OfficeOrigin is the Origin a client of this gateway presents: the platform's gateway admits a client
// connection only from the office's own origin (services/gateway hub.ts, MA_CLIENT_ORIGINS), as a browser
// running the Desk app sends it. wss://gw.<suffix>/... gives https://office.<suffix>; any other host, such as
// a local gateway-shim, gives "" and no header. The desk token, not the Origin, is what authenticates.
func OfficeOrigin(gatewayURL string) string {
	u, err := neturl.Parse(gatewayURL)
	if err != nil || !strings.HasPrefix(u.Hostname(), "gw.") {
		return ""
	}
	return "https://office." + strings.TrimPrefix(u.Hostname(), "gw.")
}

// Dial connects with the contract's subprotocol, presenting the office's Origin where the gateway wants one.
func Dial(ctx context.Context, url string) (*Conn, error) {
	opts := &websocket.DialOptions{Subprotocols: []string{Subprotocol}}
	if o := OfficeOrigin(url); o != "" {
		opts.HTTPHeader = http.Header{"Origin": []string{o}}
	}
	c, resp, err := websocket.Dial(ctx, url, opts)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	if c.Subprotocol() != Subprotocol {
		_ = c.CloseNow()

		return nil, errors.New("gateway didn't echo the subprotocol")
	}
	c.SetReadLimit(readLimit)

	return &Conn{c: c}, nil
}

// Send writes one JSON text frame.
func (c *Conn) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()

	return c.c.Write(ctx, websocket.MessageText, b)
}

// Read returns the next message.
func (c *Conn) Read(ctx context.Context) (*Msg, error) {
	_, b, err := c.c.Read(ctx)
	if err != nil {
		return nil, err
	}
	var m Msg
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}

	return &m, nil
}

// Close ends the connection without waiting for the peer.
func (c *Conn) Close() error { return c.c.CloseNow() }

// CloseStatus extracts the WebSocket close code, or -1.
func CloseStatus(err error) int { return int(websocket.CloseStatus(err)) }
