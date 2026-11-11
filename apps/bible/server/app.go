package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"runtime/debug"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/store"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/text"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/wire"
)

const maxInFlight = 32

type app struct {
	cfg   config
	lib   *text.Library
	newer bool // the data is from a newer version: every HELLO gets CLOSE 4426

	ready chan struct{} // closed once the store has loaded, or failed to
	st    *store.Store
	stErr error

	mu       sync.Mutex
	conn     *wire.Conn
	subs     map[uint32]*sub
	nextSub  uint32
	inflight map[uint32]context.CancelFunc
	sem      chan struct{}
	calls    sync.WaitGroup

	sumMu    sync.Mutex
	sumLast  []byte
	sumAt    time.Time
	sumTimer *time.Timer
}

type sub struct {
	topic string
	seq   uint32
	conn  *wire.Conn
}

// run listens on the app socket and serves deskd until ctx ends. listening, if not nil, is closed once it listens.
func run(ctx context.Context, cfg config, listening chan<- struct{}) error {
	a := &app{cfg: cfg, lib: text.NewLibrary(cfg.texts, cfg.manifest), ready: make(chan struct{}),
		subs: map[uint32]*sub{}, inflight: map[uint32]context.CancelFunc{}, sem: make(chan struct{}, maxInFlight)}
	a.sumLast = a.summaryJSON() // what a subscriber sees before the data has loaded: no rows
	if err := store.CheckFormat(cfg.data); errors.Is(err, store.ErrNewerFormat) {
		log.Print("the data is from a newer version of the app; it's left as it is and every HELLO gets 4426")
		a.newer = true
	}
	_ = os.Remove(cfg.socket) // a socket left by a killed run
	ln, err := net.Listen("unix", cfg.socket)
	if err != nil {
		return err
	}
	_ = os.Chmod(cfg.socket, 0o660) // deskd reaches it through the directory's group (contract §5.1)
	if listening != nil {
		close(listening)
	}
	// The data loads after the socket is up, so HELLO never waits for it; calls that need it wait instead.
	go func() {
		defer close(a.ready)
		if a.newer {
			a.stErr = store.ErrNewerFormat
			return
		}
		a.st, a.stErr = store.Open(cfg.data, store.Options{Translations: a.lib.Has})
		if a.stErr != nil {
			log.Printf("the data couldn't be read: %v", a.stErr)
			return
		}
		debug.FreeOSMemory() // reading the files leaves garbage the size of the data: give it back now
		a.publishSummary()
	}()
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				break
			}
			continue
		}
		if uid, err := wire.PeerUID(c); err != nil || uid != cfg.deskdUID {
			_ = c.Close() // only deskd may talk to an app (contract §5.1)
			continue
		}
		go a.serve(wire.NewConn(c))
	}
	a.shutdown()
	_ = os.Remove(cfg.socket)
	return nil
}

// shutdown ends the link and waits briefly for calls under way: a mutation's change is on disk before its reply, so
// stopping mid-call loses nothing that was answered.
func (a *app) shutdown() {
	a.mu.Lock()
	if a.conn != nil {
		_ = a.conn.Close()
	}
	for _, cancel := range a.inflight {
		cancel()
	}
	a.mu.Unlock()
	done := make(chan struct{})
	go func() { a.calls.Wait(); close(done) }()
	deadline := time.After(a.cfg.stopTimeout)
	select {
	case <-done:
	case <-deadline:
	}
	select {
	case <-a.ready:
		if a.st != nil {
			_ = a.st.Close()
		}
	case <-deadline:
	}
}

func (a *app) serve(c *wire.Conn) {
	// One deskd at a time: a new connection replaces the old one, as on rtc.sock.
	a.mu.Lock()
	if a.conn != nil {
		_ = a.conn.Close()
	}
	a.conn = c
	for id, s := range a.subs {
		if s.conn != c {
			delete(a.subs, id)
		}
	}
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		if a.conn == c {
			a.conn = nil
		}
		for id, s := range a.subs {
			if s.conn == c {
				delete(a.subs, id)
			}
		}
		a.mu.Unlock()
		_ = c.Close()
	}()

	_ = c.Raw().SetReadDeadline(time.Now().Add(a.cfg.helloTimeout))
	f, err := wire.Read(c.R)
	if err != nil || f.Kind != wire.Hello {
		_ = c.Send(wire.Close, 0, 0, map[string]any{"code": wire.CloseProtocol, "reason": "hello_first"})
		return
	}
	var hello struct {
		AppAPI string `json:"appApi"`
	}
	_ = json.Unmarshal(f.Payload, &hello) // unknown fields are ignored: that's what lets minors add them
	if wire.Major(hello.AppAPI) != wire.Major(wire.AppAPI) {
		_ = c.Send(wire.Close, 0, 0, map[string]any{"code": wire.CloseAPIMismatch, "reason": "app_api_mismatch", "appApi": wire.AppAPI})
		return
	}
	if a.newer {
		_ = c.Send(wire.Close, 0, 0, map[string]any{"code": wire.CloseAPIMismatch, "reason": "needs_update", "appApi": wire.AppAPI})
		return
	}
	_ = c.Send(wire.Hello, 0, 0, map[string]any{"appApi": wire.AppAPI, "app": map[string]string{"id": a.cfg.id, "version": a.cfg.version}})
	_ = c.Raw().SetReadDeadline(time.Time{})

	for {
		f, err := wire.Read(c.R)
		if err != nil {
			return
		}
		switch f.Kind {
		case wire.Ping:
			_ = c.Write(wire.Frame{Kind: wire.Pong, ID: f.ID})
		case wire.Req:
			a.request(c, f)
		case wire.Sub:
			a.calls.Add(1)
			go func() { defer a.calls.Done(); a.subscribe(c, f) }()
		case wire.Unsub:
			var u struct {
				SubID uint32 `json:"subId"`
			}
			_ = json.Unmarshal(f.Payload, &u)
			a.mu.Lock()
			delete(a.subs, u.SubID)
			a.mu.Unlock()
			_ = c.Send(wire.Res, f.ID, 0, map[string]any{})
		case wire.Cancel:
			a.mu.Lock()
			if cancel := a.inflight[f.ID]; cancel != nil {
				cancel()
			}
			a.mu.Unlock()
		case wire.Close:
			return
		default:
			// A kind this version doesn't know (or reserves) is ignored, so a later minor can add one.
		}
	}
}

func (a *app) request(c *wire.Conn, f wire.Frame) {
	var r wire.Request
	if err := json.Unmarshal(f.Payload, &r); err != nil {
		_ = c.Send(wire.Err, f.ID, 0, wire.Error{Code: "bad_request", Message: "not JSON", Details: map[string]any{"reason": "json"}})
		return
	}
	select {
	case a.sem <- struct{}{}:
	default:
		_ = c.Send(wire.Err, f.ID, 0, wire.Error{Code: "rate_limited", Message: "too many calls at once", Details: map[string]any{"limit": "appCalls"}})
		return
	}
	deadline := 30 * time.Second
	if r.DeadlineMs > 0 {
		deadline = time.Duration(r.DeadlineMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	a.mu.Lock()
	a.inflight[f.ID] = cancel
	a.mu.Unlock()
	a.calls.Add(1)
	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.inflight, f.ID)
			a.mu.Unlock()
			cancel()
			<-a.sem
			a.calls.Done()
		}()
		res, aerr := a.dispatch(ctx, &r)
		if aerr == nil && ctx.Err() != nil {
			aerr = ctxErr(ctx)
		}
		if aerr != nil {
			_ = c.Send(wire.Err, f.ID, 0, aerr.wire())
			return
		}
		b, err := json.Marshal(res)
		if err != nil || len(b) > wire.MaxPayload {
			_ = c.Send(wire.Err, f.ID, 0, wire.Error{Code: "internal", Message: "Internal error"})
			return
		}
		_ = c.Write(wire.Frame{Kind: wire.Res, ID: f.ID, Payload: b})
	}()
}

func ctxErr(ctx context.Context) *apiErr {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &apiErr{code: "deadline_exceeded", msg: "ran out of time"}
	}
	return &apiErr{code: "cancelled", msg: "cancelled"}
}

func (a *app) subscribe(c *wire.Conn, f wire.Frame) {
	var s wire.Subscribe
	if err := json.Unmarshal(f.Payload, &s); err != nil || (s.Topic != "bible.marks" && s.Topic != "app.summary") {
		_ = c.Send(wire.Err, f.ID, 0, wire.Error{Code: "not_found", Message: "No such topic", Details: map[string]any{"reason": "topic"}})
		return
	}
	var data any
	if s.Topic == "bible.marks" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		st, aerr := a.waitStore(ctx)
		cancel()
		if aerr != nil {
			_ = c.Send(wire.Err, f.ID, 0, aerr.wire())
			return
		}
		data = map[string]uint64{"rev": st.Rev()}
	} else {
		data = json.RawMessage(a.summaryJSON())
	}
	// No history is kept, so every subscription starts with a snapshot, which the contract allows. The lock keeps
	// a patch from going out between the reply and the snapshot.
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn != c {
		return
	}
	a.nextSub++
	id := a.nextSub
	x := &sub{topic: s.Topic, conn: c, seq: 1}
	a.subs[id] = x
	_ = c.Send(wire.Res, f.ID, 0, map[string]any{"subId": id, "seq": 0})
	_ = c.Send(wire.Evt, id, x.seq, map[string]any{"type": "snapshot", "data": data})
}

// publish sends a patch to every subscription of a topic: values, never increments, since deskd may coalesce them.
func (a *app) publish(topic string, data any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, s := range a.subs {
		if s.topic == topic && s.conn == a.conn {
			s.seq++
			_ = s.conn.Send(wire.Evt, id, s.seq, map[string]any{"type": "patch", "data": data})
		}
	}
}

func (a *app) marksChanged() {
	if a.st != nil {
		a.publish("bible.marks", map[string]uint64{"rev": a.st.Rev()})
	}
}

// publishSummary sends the widget's summary if it changed, at most once a second (contract §3.1).
func (a *app) publishSummary() {
	a.sumMu.Lock()
	defer a.sumMu.Unlock()
	if a.sumTimer != nil {
		return // one is due already, and it reads the latest
	}
	wait := a.cfg.summaryEvery - time.Since(a.sumAt)
	if wait < 0 {
		wait = 0
	}
	a.sumTimer = time.AfterFunc(wait, func() {
		b := a.summaryJSON()
		a.sumMu.Lock()
		a.sumTimer = nil
		same := string(b) == string(a.sumLast)
		if !same {
			a.sumLast, a.sumAt = b, time.Now()
		}
		a.sumMu.Unlock()
		if !same {
			a.publish("app.summary", json.RawMessage(b))
		}
	})
}
