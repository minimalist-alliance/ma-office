// Package fakedesk is an in-memory desk for tests: a Transport pair, and a desk that speaks deskd's
// protocol (HELLO, PING, AUTH, data.*) over it, reading a directory as the source desk's /data.
package fakedesk

import (
	"errors"
	"sync"
)

type message struct {
	channel uint8
	b       []byte
}

// End is one side of an in-memory session. It implements session.Transport.
type End struct {
	peer *End
	pair *pair

	mu        sync.Mutex
	recv      func(uint8, []byte)
	queue     []message
	cond      *sync.Cond
	started   bool
	Refreshes int
}

type pair struct {
	once sync.Once
	done chan struct{}
}

// Pipe returns two connected ends. Messages arrive in the order sent, on one goroutine per end.
func Pipe() (*End, *End) {
	p := &pair{done: make(chan struct{})}
	a, b := &End{pair: p}, &End{pair: p}
	a.cond, b.cond = sync.NewCond(&a.mu), sync.NewCond(&b.mu)
	a.peer, b.peer = b, a

	return a, b
}

// Send queues one message for the other end.
func (e *End) Send(channel uint8, b []byte) error {
	select {
	case <-e.pair.done:
		return errors.New("fakedesk: closed")
	default:
	}
	p := e.peer
	p.mu.Lock()
	p.queue = append(p.queue, message{channel, append([]byte(nil), b...)})
	p.mu.Unlock()
	p.cond.Signal()

	return nil
}

// SetReceiver installs the handler and starts delivery.
func (e *End) SetReceiver(f func(uint8, []byte)) {
	e.mu.Lock()
	e.recv = f
	start := !e.started
	e.started = true
	e.mu.Unlock()
	if start {
		go e.deliver()
	}
}

func (e *End) deliver() {
	go func() {
		<-e.pair.done
		e.mu.Lock()
		e.cond.Broadcast()
		e.mu.Unlock()
	}()
	for {
		e.mu.Lock()
		for len(e.queue) == 0 && !e.closed() {
			e.cond.Wait()
		}
		if e.closed() {
			e.mu.Unlock()

			return
		}
		m := e.queue[0]
		e.queue = e.queue[1:]
		f := e.recv
		e.mu.Unlock()
		f(m.channel, m.b)
	}
}

func (e *End) closed() bool {
	select {
	case <-e.pair.done:
		return true
	default:
		return false
	}
}

// Done is closed once either end closes.
func (e *End) Done() <-chan struct{} { return e.pair.done }

// Close ends both sides, dropping what's queued.
func (e *End) Close() error {
	e.pair.once.Do(func() { close(e.pair.done) })

	return nil
}

// RefreshToken counts gateway refreshes.
func (e *End) RefreshToken(string) error {
	e.mu.Lock()
	e.Refreshes++
	e.mu.Unlock()

	return nil
}
