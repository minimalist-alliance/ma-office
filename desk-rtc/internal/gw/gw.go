// Package gw holds the gateway contract's framing (gateway.md, contract 0.3.3) for the shim and its
// clients.
package gw

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// Subprotocol is required at upgrade.
	Subprotocol = "ma.gw.v1"
	// MaxFrame is the contract's limit on one frame.
	MaxFrame = 32 * 1024
	// MaxSignalData is the limit on signal.data, serialized.
	MaxSignalData = 30 * 1024
	// DeskAuthHeader marks a desk at upgrade.
	DeskAuthHeader = "X-MA-Desk-Auth"
	readLimit      = 1 << 20
	writeTimeout   = 10 * time.Second
)

// Msg is the union of the fields this stand-in reads. Unknown fields are ignored, per the contract.
type Msg struct {
	Type           string          `json:"type"`
	ID             string          `json:"id,omitempty"`
	DeskID         string          `json:"deskId,omitempty"`
	DeskToken      string          `json:"deskToken,omitempty"`
	SessionID      string          `json:"sessionId,omitempty"`
	Reason         string          `json:"reason,omitempty"`
	Code           string          `json:"code,omitempty"`
	Message        string          `json:"message,omitempty"`
	Data           json.RawMessage `json:"data,omitempty"`
	BootID         string          `json:"bootId,omitempty"`
	RuntimeVersion string          `json:"runtimeVersion,omitempty"`
	DeskAPI        string          `json:"deskApi,omitempty"`
	Sessions       []string        `json:"sessions,omitempty"`
	PeerSessions   []string        `json:"peerSessions,omitempty"`
	OpenedAt       string          `json:"openedAt,omitempty"`
	At             string          `json:"at,omitempty"`
	Phase          string          `json:"phase,omitempty"`
	State          string          `json:"state,omitempty"`
	Total          *int            `json:"total,omitempty"`
	Apps           json.RawMessage `json:"apps,omitempty"`
	IceServers     json.RawMessage `json:"iceServers,omitempty"`
}

// Signal is Desk's payload inside signal.data. The contract leaves it to Desk.
type Signal struct {
	Type    string `json:"type"` // offer, answer or refusal
	SDP     string `json:"sdp,omitempty"`
	Restart bool   `json:"restart,omitempty"` // on an offer: an ICE restart of this session
	Code    string `json:"code,omitempty"`    // on a refusal: why
	Message string `json:"message,omitempty"`
}

// Conn is a client side of the gateway link. Send is safe from any goroutine.
type Conn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

// Dial connects with the contract's subprotocol. A non-empty deskAuth makes this a desk.
func Dial(ctx context.Context, url, deskAuth string) (*Conn, error) {
	opts := &websocket.DialOptions{Subprotocols: []string{Subprotocol}}
	if deskAuth != "" {
		opts.HTTPHeader = http.Header{DeskAuthHeader: {deskAuth}}
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
