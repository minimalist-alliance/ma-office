// The request and reply handling here started as desk-rtc/internal/client/client.go (onMessage, onReply,
// request, Call) at desk-rtc commit 42e6a09. It was moved off Pion behind Transport, so the tests run it
// against an in-memory desk, and extended with HELLO checks, AUTH, keepalive and the bulk channel's
// CHUNK and CREDIT frames (draft ADR data export and transfer, section 7).

// Package session speaks the deskd protocol (services/deskd/docs/API.md) over any Transport: HELLO, RPC,
// and data.read's file bytes on bulk.
package session

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/frame"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/rtcsock"
)

// Transport carries the bridged data channels (0 to 5) of one desk session. client.Conn is the Pion one;
// the tests use an in-memory pipe.
type Transport interface {
	// Send writes one frame on a channel. Safe from any goroutine.
	Send(channel uint8, b []byte) error
	// SetReceiver installs the handler for every message from the desk, before HELLO. The handler must
	// not block for long, and owns b.
	SetReceiver(func(channel uint8, b []byte))
	// Done is closed once the transport is gone.
	Done() <-chan struct{}
	// Close drops the transport.
	Close() error
}

// TokenRefresher is a Transport that can also hand a new desk token to the desk by its own path, as the
// gateway's session.refresh does.
type TokenRefresher interface {
	RefreshToken(token string) error
}

// ErrDisconnected wraps every error caused by the session going away. A new session can carry on.
var ErrDisconnected = errors.New("the desk session ended")

// CloseError is the desk's CLOSE on ctl, or a keepalive that went unanswered.
type CloseError struct {
	Code   int
	Reason string
}

func (e *CloseError) Error() string {
	return fmt.Sprintf("desk closed the session: %d %s", e.Code, e.Reason)
}

// Unwrap makes every CloseError an ErrDisconnected.
func (e *CloseError) Unwrap() error { return ErrDisconnected }

// RPCError is an ERR reply.
type RPCError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

func (e *RPCError) Error() string {
	if r, ok := e.Details["reason"].(string); ok {
		return e.Code + " (" + r + "): " + e.Message
	}

	return e.Code + ": " + e.Message
}

// Reason returns details.reason, or "".
func (e *RPCError) Reason() string {
	r, _ := e.Details["reason"].(string)

	return r
}

// IsCode reports whether err is an RPCError with that code.
func IsCode(err error, code string) bool {
	var e *RPCError

	return errors.As(err, &e) && e.Code == code
}

// Options configures Open.
type Options struct {
	AppVersion string
	// KeepaliveInterval is how often a PING goes on ctl. 0 means 15 s; negative turns it off.
	KeepaliveInterval time.Duration
	// KeepaliveMisses unanswered PINGs in a row end the session. 0 means 3.
	KeepaliveMisses int
	Log             func(format string, args ...any)
}

// Hello is the part of deskd's HELLO reply this reads.
type Hello struct {
	DeskAPI   string `json:"deskApi"`
	SessionID string `json:"sessionId"`
	DeskID    string `json:"deskId"`
	Version   string `json:"version"`
}

type reassemblyKey struct {
	channel uint8
	kind    frame.Kind
	id      uint32
}

const (
	maxReply       = 1<<20 + 64*1024 // RES at most 1 MiB after reassembly, with room for ERR
	maxOrphanBytes = 16 << 20
)

// Session is one open desk session.
type Session struct {
	t     Transport
	opts  Options
	Hello Hello

	mu       sync.Mutex
	nextID   uint32
	pending  map[uint32]chan frame.Frame
	partial  map[reassemblyKey][]byte
	xfers    map[uint32]*Transfer
	orphans  map[uint32]*chunkQueue
	orphanN  int
	finished map[uint32]bool

	done     chan struct{}
	doneOnce sync.Once
	err      error
}

func (s *Session) logf(format string, args ...any) {
	if s.opts.Log != nil {
		s.opts.Log(format, args...)
	}
}

// Open sends HELLO on ctl and checks deskd's answer.
func Open(ctx context.Context, t Transport, opts Options) (*Session, error) {
	s := &Session{
		t: t, opts: opts,
		pending:  map[uint32]chan frame.Frame{},
		partial:  map[reassemblyKey][]byte{},
		xfers:    map[uint32]*Transfer{},
		orphans:  map[uint32]*chunkQueue{},
		finished: map[uint32]bool{},
		done:     make(chan struct{}),
	}
	t.SetReceiver(s.onMessage)
	go func() {
		select {
		case <-t.Done():
			s.fail(fmt.Errorf("%w: the connection dropped", ErrDisconnected))
		case <-s.done:
		}
	}()
	app := opts.AppVersion
	if app == "" {
		app = "ma-move"
	}
	f, err := s.request(ctx, rtcsock.ChCtl, frame.Hello, map[string]any{"deskApi": "1.0", "appVersion": app})
	if err != nil {
		s.Close()

		return nil, fmt.Errorf("HELLO: %w", err)
	}
	if err := json.Unmarshal(f.Payload, &s.Hello); err != nil {
		s.Close()

		return nil, fmt.Errorf("HELLO: %w", err)
	}
	if major, _, _ := strings.Cut(s.Hello.DeskAPI, "."); major != "1" {
		s.Close()

		return nil, fmt.Errorf("HELLO: the desk speaks deskApi %q, not 1.x", s.Hello.DeskAPI)
	}
	if opts.KeepaliveInterval >= 0 {
		go s.keepalive()
	}

	return s, nil
}

// Done is closed when the session has ended; Err says why.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err is why the session ended, or nil while it's open.
func (s *Session) Err() error {
	select {
	case <-s.done:
		return s.err
	default:
		return nil
	}
}

// Close ends the session and drops the transport.
func (s *Session) Close() {
	s.fail(fmt.Errorf("%w: closed here", ErrDisconnected))
	_ = s.t.Close()
}

func (s *Session) fail(err error) {
	s.doneOnce.Do(func() {
		s.mu.Lock()
		s.err = err
		close(s.done)
		for _, x := range s.xfers {
			x.q.fail(err)
		}
		s.mu.Unlock()
		_ = s.t.Close()
	})
}

func (s *Session) keepalive() {
	every := s.opts.KeepaliveInterval
	if every == 0 {
		every = 15 * time.Second
	}
	limit := s.opts.KeepaliveMisses
	if limit == 0 {
		limit = 3
	}
	var misses int
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-tick.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), every)
		_, err := s.request(ctx, rtcsock.ChCtl, frame.Ping, map[string]any{})
		cancel()
		if err == nil {
			misses = 0

			continue
		}
		if errors.Is(err, ErrDisconnected) {
			return
		}
		misses++
		s.logf("PING unanswered (%d of %d)", misses, limit)
		if misses >= limit {
			s.fail(&CloseError{Code: 0, Reason: "no answer from the desk"})

			return
		}
	}
}

func (s *Session) onMessage(channel uint8, data []byte) {
	f, err := frame.Decode(data)
	if err != nil {
		s.logf("bad frame on channel %d: %v", channel, err)

		return
	}
	switch {
	case channel == rtcsock.ChBulk && f.Kind == frame.Chunk:
		s.onChunk(f)
	case channel == rtcsock.ChCtl && f.Kind == frame.Close:
		var c struct {
			Code   int    `json:"code"`
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(f.Payload, &c)
		s.fail(&CloseError{Code: c.Code, Reason: c.Reason})
	case f.Kind == frame.Hello || f.Kind == frame.Pong || f.Kind == frame.Auth || f.Kind == frame.Res || f.Kind == frame.Err:
		s.onReply(channel, f)
	default:
		// EVT and anything unknown: nothing here subscribes, and unknown kinds are ignored (API.md section 2).
	}
}

func (s *Session) onReply(channel uint8, f frame.Frame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := reassemblyKey{channel, f.Kind, f.ID}
	if f.Flags&frame.FlagMore != 0 {
		if len(s.partial[key])+len(f.Payload) > maxReply {
			delete(s.partial, key)

			return
		}
		s.partial[key] = append(s.partial[key], f.Payload...)

		return
	}
	payload := append(s.partial[key], f.Payload...)
	delete(s.partial, key)
	f.Payload = payload
	if w := s.pending[f.ID]; w != nil {
		delete(s.pending, f.ID)
		w <- f
	}
}

func (s *Session) onChunk(f frame.Frame) {
	c := Chunk{Seq: f.Seq, Data: f.Payload, End: f.Flags&frame.FlagEnd != 0}
	s.mu.Lock()
	defer s.mu.Unlock()
	if x := s.xfers[f.ID]; x != nil {
		x.q.push(c)

		return
	}
	if s.finished[f.ID] {
		return // a chunk already on its way when the transfer ended
	}
	// Channels aren't ordered against each other, so chunks can come before data.read's RES.
	if s.orphanN+len(c.Data) > maxOrphanBytes {
		s.logf("dropping a chunk for unknown transfer %d", f.ID)

		return
	}
	q := s.orphans[f.ID]
	if q == nil {
		q = newChunkQueue()
		s.orphans[f.ID] = q
	}
	s.orphanN += len(c.Data)
	q.push(c)
}

func (s *Session) send(channel uint8, kind frame.Kind, id uint32, body []byte) error {
	for len(body) > frame.MaxPayload {
		if err := s.t.Send(channel, frame.Encode(kind, frame.FlagMore, id, 0, body[:frame.MaxPayload])); err != nil {
			return err
		}
		body = body[frame.MaxPayload:]
	}

	return s.t.Send(channel, frame.Encode(kind, 0, id, 0, body))
}

func (s *Session) request(ctx context.Context, channel uint8, kind frame.Kind, v any) (frame.Frame, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return frame.Frame{}, err
	}
	s.mu.Lock()
	if s.Err() != nil {
		s.mu.Unlock()

		return frame.Frame{}, s.err
	}
	s.nextID++
	id := s.nextID
	w := make(chan frame.Frame, 1)
	s.pending[id] = w
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	if err := s.send(channel, kind, id, body); err != nil {
		return frame.Frame{}, fmt.Errorf("%w: %v", ErrDisconnected, err)
	}
	select {
	case f := <-w:
		return f, nil
	case <-s.done:
		return frame.Frame{}, s.err
	case <-ctx.Done():
		if kind == frame.Req {
			_ = s.send(rtcsock.ChRPC, frame.Cancel, id, nil)
		}

		return frame.Frame{}, ctx.Err()
	}
}

// Call makes one RPC and decodes the RES payload into out, if out isn't nil. An ERR comes back as
// *RPCError.
func (s *Session) Call(ctx context.Context, method string, params, out any) error {
	return s.call(ctx, method, params, "", out)
}

// CallMutation is Call for a mutation, which deskd refuses without an idem key (API.md section 4): it sends
// a new UUIDv7 key, as each call here is a new action, never a retry of one deskd may have kept.
func (s *Session) CallMutation(ctx context.Context, method string, params, out any) error {
	return s.call(ctx, method, params, NewIdem(), out)
}

// NewIdem is a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits.
func NewIdem() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(time.Now().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = 0x70 | b[6]&0x0f
	b[8] = 0x80 | b[8]&0x3f

	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Session) call(ctx context.Context, method string, params any, idem string, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	req := map[string]any{"m": method, "p": params}
	if idem != "" {
		req["idem"] = idem
	}
	if dl, ok := ctx.Deadline(); ok {
		req["deadlineMs"] = max(1, time.Until(dl).Milliseconds())
	}
	f, err := s.request(ctx, rtcsock.ChRPC, frame.Req, req)
	if err != nil {
		return err
	}
	if f.Kind == frame.Err {
		e := &RPCError{}
		if json.Unmarshal(f.Payload, e) != nil || e.Code == "" {
			e.Code = "internal"
		}

		return e
	}
	if out == nil {
		return nil
	}

	return json.Unmarshal(f.Payload, out)
}

// Auth hands deskd a new desk token on ctl (API.md section 3, token refresh).
func (s *Session) Auth(ctx context.Context, token string) error {
	f, err := s.request(ctx, rtcsock.ChCtl, frame.Auth, map[string]any{"deskToken": token})
	if err != nil {
		return err
	}
	var r struct {
		OK   bool   `json:"ok"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(f.Payload, &r); err != nil {
		return err
	}
	if !r.OK {
		return &RPCError{Code: r.Code, Message: "AUTH refused"}
	}

	return nil
}

// Refresh passes a new desk token both ways deskd takes one: AUTH on ctl and, when the transport has
// one, the gateway's session.refresh. Sending both is harmless (API.md section 3).
func (s *Session) Refresh(ctx context.Context, token string) error {
	if r, ok := s.t.(TokenRefresher); ok {
		if err := r.RefreshToken(token); err != nil {
			s.logf("session.refresh: %v", err)
		}
	}
	err := s.Auth(ctx, token)
	if IsCode(err, "invalid_token") {
		return nil // the gateway's copy got there first
	}

	return err
}
