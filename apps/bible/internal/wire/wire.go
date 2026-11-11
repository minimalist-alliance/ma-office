// Copied unchanged from spikes/app-contract-sample/internal/wire (the desk app contract's sample, task 18), so the
// Bible app needs nothing from spikes/. deskd's newer fields (From's caller) are ignored, as the contract asks.
// Package wire is the app socket of appApi 1.0 (draft ADR, section 5): a Unix stream socket that the app
// listens on and deskd connects to. Each message is a u32be length, then one frame with the 12-byte header
// of design 4.2.4, so an app speaks the same frames the Desk app does, without the 16 KiB fragmenting.
package wire

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"
)

// AppAPI is the version this package speaks.
const AppAPI = "1.0"

// Kinds, numbered as design 4.2.4 and desk-runtime.md 4.5. AUTH, ACTIVITY, DATA, CHUNK and CREDIT are
// reserved on the app socket in 1.0.
const (
	Hello  byte = 1
	Ping   byte = 4
	Pong   byte = 5
	Close  byte = 6
	Req    byte = 7
	Res    byte = 8
	Err    byte = 9
	Sub    byte = 10
	Unsub  byte = 11
	Evt    byte = 12
	Cancel byte = 13
)

// Limits on the app socket. A frame never carries MORE: messages up to the limit go whole.
const (
	HeaderLen       = 12
	MaxPayload      = 1 << 20 // REQ and RES, as deskApi
	MaxEventPayload = 64 << 10
	FlagBin         = 1 << 1
)

// Close codes an app may see or send.
const (
	CloseProtocol    = 4000
	CloseAPIMismatch = 4426
)

type Frame struct {
	Kind    byte
	Flags   byte
	ID      uint32
	Seq     uint32
	Payload []byte
}

var ErrFrame = errors.New("bad frame")

// Read reads one message. It rejects a wrong version, a non-zero reserved byte and anything over the limit.
func Read(r *bufio.Reader) (Frame, error) {
	var lb [4]byte
	if _, err := io.ReadFull(r, lb[:]); err != nil {
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(lb[:])
	if n < HeaderLen || n > HeaderLen+MaxPayload {
		return Frame{}, fmt.Errorf("%w: length %d", ErrFrame, n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return Frame{}, err
	}
	if buf[0] != 1 || buf[3] != 0 {
		return Frame{}, fmt.Errorf("%w: version %d reserved %d", ErrFrame, buf[0], buf[3])
	}
	return Frame{
		Kind:    buf[1],
		Flags:   buf[2],
		ID:      binary.BigEndian.Uint32(buf[4:8]),
		Seq:     binary.BigEndian.Uint32(buf[8:12]),
		Payload: buf[HeaderLen:],
	}, nil
}

// Conn serializes writes, so any goroutine may send.
type Conn struct {
	c  net.Conn
	R  *bufio.Reader
	mu sync.Mutex
}

func NewConn(c net.Conn) *Conn { return &Conn{c: c, R: bufio.NewReaderSize(c, 64<<10)} }

func (c *Conn) Close() error { return c.c.Close() }

func (c *Conn) Raw() net.Conn { return c.c }

func (c *Conn) Write(f Frame) error {
	if len(f.Payload) > MaxPayload {
		return fmt.Errorf("%w: payload %d", ErrFrame, len(f.Payload))
	}
	buf := make([]byte, 4+HeaderLen+len(f.Payload))
	binary.BigEndian.PutUint32(buf[0:4], uint32(HeaderLen+len(f.Payload)))
	buf[4] = 1
	buf[5] = f.Kind
	buf[6] = f.Flags
	binary.BigEndian.PutUint32(buf[8:12], f.ID)
	binary.BigEndian.PutUint32(buf[12:16], f.Seq)
	copy(buf[16:], f.Payload)
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.c.Write(buf)
	return err
}

// Send marshals v as the JSON payload.
func (c *Conn) Send(kind byte, id, seq uint32, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.Write(Frame{Kind: kind, ID: id, Seq: seq, Payload: b})
}

// Error is the ERR payload, with deskApi's codes.
type Error struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Request is the REQ payload. From is set by deskd: who asked, never who the member is.
type Request struct {
	M          string          `json:"m"`
	P          json.RawMessage `json:"p,omitempty"`
	Idem       string          `json:"idem,omitempty"`
	DeadlineMs int             `json:"deadlineMs,omitempty"`
	From       *From           `json:"from,omitempty"`
}

type From struct {
	Kind    string `json:"kind"`              // "view", "widget" or "desk"
	Session string `json:"session,omitempty"` // opaque, per desk session, never the member's identity
}

type Subscribe struct {
	Topic  string          `json:"topic"`
	Params json.RawMessage `json:"params,omitempty"`
	Since  *uint32         `json:"since,omitempty"`
}

// PeerUID returns the uid of the process at the other end of a Unix socket (SO_PEERCRED).
func PeerUID(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return -1, errors.New("not a Unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return -1, err
	}
	var cred *syscall.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return -1, err
	}
	if serr != nil {
		return -1, serr
	}
	return int(cred.Uid), nil
}

// Major returns the major part of a "MAJOR.MINOR" version.
func Major(v string) string {
	for i := 0; i < len(v); i++ {
		if v[i] == '.' {
			return v[:i]
		}
	}
	return v
}
