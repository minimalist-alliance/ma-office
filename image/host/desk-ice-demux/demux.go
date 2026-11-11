package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// dialSlot opens the connection to slot k's desk-rtc with the client's own address as its source (dial_linux.go), so
// desk-rtc's gate counts the real client. Tests give their own.
type dialSlot func(ctx context.Context, client *net.TCPAddr, k int) (net.Conn, error)

type demux struct {
	slots   int
	slotDir string // a slot is live while desk-host's marker <slotDir>/<k> is there
	dial    dialSlot
	g       *gate
	st      *stats
	log     *slog.Logger
	wg      sync.WaitGroup
}

type stats struct {
	accepted, handed, badFrame, noSlot, stoppedSlot, silent, refusedPerNet, refusedFull, evicted, refusedHanded, dialFailed atomic.Uint64
	lastLog                                                                                                                 atomic.Int64
}

func newDemux(slots int, slotDir string, dial dialSlot, lim limits, log *slog.Logger) *demux {
	st := &stats{}

	return &demux{slots: slots, slotDir: slotDir, dial: dial, g: newGate(lim, st), st: st, log: log}
}

// live says whether slot k has a running desk: desk-host's marker, made once the slot's network is set and removed at its
// stop's reset (desk-host up_one, reset_slot).
func (d *demux) live(k int) bool {
	if k < 1 || k > d.slots {
		return false
	}
	fi, err := os.Lstat(filepath.Join(d.slotDir, strconv.Itoa(k)))

	return err == nil && fi.Mode().IsRegular()
}

func (d *demux) serve(ctx context.Context, ln net.Listener) error {
	go func() { <-ctx.Done(); _ = ln.Close() }()
	go d.logLoop(ctx)
	var delay time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				d.wg.Wait()

				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() || errors.Is(err, os.ErrDeadlineExceeded) || isTemporary(err) {
				// EMFILE and the like: back off as net/http does, rather than spin
				if delay == 0 {
					delay = 5 * time.Millisecond
				} else if delay *= 2; delay > time.Second {
					delay = time.Second
				}
				time.Sleep(delay)

				continue
			}

			return err
		}
		delay = 0
		d.st.accepted.Add(1)
		p := d.g.admit(c)
		if p == nil {
			abort(c)

			continue
		}
		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			d.handle(ctx, p)
		}()
	}
}

func isTemporary(err error) bool {
	var t interface{ Temporary() bool }

	return errors.As(err, &t) && t.Temporary()
}

func (d *demux) handle(ctx context.Context, p *place) {
	c := p.c
	frame, k, why := readFirst(c, p.wait)
	if !d.g.leave(p) { // a newer connection took the place, and closed this one
		return
	}
	switch why {
	case "":
	case "silent":
		d.st.silent.Add(1)
		abort(c)

		return
	case "tag":
		d.st.noSlot.Add(1)
		abort(c)

		return
	default:
		d.st.badFrame.Add(1)
		abort(c)

		return
	}
	if k > d.slots {
		d.st.noSlot.Add(1)
		abort(c)

		return
	}
	if !d.live(k) {
		d.st.stoppedSlot.Add(1)
		abort(c)

		return
	}
	release, ok := d.g.hand(p.network)
	if !ok {
		d.st.refusedHanded.Add(1)
		abort(c)

		return
	}
	defer release()
	client, _ := c.RemoteAddr().(*net.TCPAddr)
	dctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	up, err := d.dial(dctx, client, k)
	cancel()
	if err != nil {
		d.st.dialFailed.Add(1)
		abort(c)

		return
	}
	if _, err := up.Write(frame); err != nil {
		d.st.dialFailed.Add(1)
		abort(up)
		abort(c)

		return
	}
	d.st.handed.Add(1)
	splice(c, up)
}

// readFirst reads the first RFC 4571 frame within wait. why is "" for a binding request naming a slot (k), "silent" for
// nothing whole within wait, "tag" for one whose USERNAME names no slot, and anything else for a frame that can't be one;
// those last are known at the first bytes that can't be, and closed then.
func readFirst(c net.Conn, wait time.Duration) (frame []byte, k int, why string) {
	if err := c.SetReadDeadline(time.Now().Add(wait)); err != nil {
		return nil, 0, "silent"
	}
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return nil, 0, readWhy(err)
	}
	n, ok := frameLength(hdr)
	if !ok {
		return nil, 0, "length"
	}
	buf := make([]byte, 2+n)
	copy(buf, hdr[:])
	if _, err := io.ReadFull(c, buf[2:2+stunHeader]); err != nil {
		return nil, 0, readWhy(err)
	}
	if !checkHeader(buf[2:2+stunHeader], n) {
		return nil, 0, "header"
	}
	if _, err := io.ReadFull(c, buf[2+stunHeader:]); err != nil {
		return nil, 0, readWhy(err)
	}
	if err := c.SetReadDeadline(time.Time{}); err != nil {
		return nil, 0, "silent"
	}
	k, err := slotOfRequest(buf[2:])
	switch {
	case errors.Is(err, errNoTag):
		return nil, 0, "tag"
	case err != nil:
		return nil, 0, "stun"
	}

	return buf, k, ""
}

func readWhy(err error) string {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return "silent"
	}

	return "closed"
}

// splice copies both ways until either side ends, then closes both. Between two TCP sockets io.Copy uses splice(2), so
// nothing is copied through the demux's memory.
func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}

// logLoop says, at most once a minute and only when something was turned away, how many connections the demux has
// handled and turned away since it started. Never an address, a ufrag or a slot's desk.
func (d *demux) logLoop(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	var last uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s := d.st
		away := s.badFrame.Load() + s.noSlot.Load() + s.stoppedSlot.Load() + s.silent.Load() + s.refusedPerNet.Load() + s.refusedFull.Load() +
			s.evicted.Load() + s.refusedHanded.Load() + s.dialFailed.Load()
		if away == last {
			continue
		}
		last = away
		w, nets, h := d.g.counts()
		d.log.Info("ICE-TCP demux turning connections away", "accepted", s.accepted.Load(), "handed", s.handed.Load(),
			"badFrame", s.badFrame.Load(), "noSlot", s.noSlot.Load(), "stoppedSlot", s.stoppedSlot.Load(), "silent", s.silent.Load(),
			"refusedPerNetwork", s.refusedPerNet.Load(), "refusedFull", s.refusedFull.Load(), "evicted", s.evicted.Load(),
			"refusedHanded", s.refusedHanded.Load(), "dialFailed", s.dialFailed.Load(), "waiting", w, "networks", nets, "handedNow", h)
	}
}
