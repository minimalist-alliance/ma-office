package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// The demux end to end on loopback: a client network is a source address in its own 127.0.N.0/24 (Linux takes any
// 127/8 address as a local one), and each slot's desk-rtc a listener of its own. The dial stands in for transparentDial
// and records the client address it was asked to keep, which the lab host proves on the real path.

type rig struct {
	t     *testing.T
	d     *demux
	addr  string
	dir   string
	slots map[int]*fakeSlot
	mu    sync.Mutex
	asked []*net.TCPAddr // the client addresses dial was asked to keep
}

type fakeSlot struct {
	ln    net.Listener
	conns chan net.Conn
}

func newRig(t *testing.T, nslots int, lim limits, live ...int) *rig {
	t.Helper()
	r := &rig{t: t, dir: t.TempDir(), slots: map[int]*fakeSlot{}}
	for k := 1; k <= nslots; k++ {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		fs := &fakeSlot{ln: ln, conns: make(chan net.Conn, 256)}
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				fs.conns <- c
			}
		}()
		t.Cleanup(func() { _ = ln.Close() })
		r.slots[k] = fs
	}
	for _, k := range live {
		r.setLive(k, true)
	}
	dial := func(ctx context.Context, client *net.TCPAddr, k int) (net.Conn, error) {
		r.mu.Lock()
		r.asked = append(r.asked, client)
		r.mu.Unlock()
		var d net.Dialer

		return d.DialContext(ctx, "tcp4", r.slots[k].ln.Addr().String())
	}
	r.d = newDemux(nslots, r.dir, dial, lim, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r.addr = ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.d.serve(ctx, ln); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	return r
}

func (r *rig) setLive(k int, on bool) {
	p := filepath.Join(r.dir, strconv.Itoa(k))
	if on {
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			r.t.Fatal(err)
		}
	} else {
		_ = os.Remove(p)
	}
}

// dial connects from src (a 127/8 address) to the demux.
func (r *rig) dial(src string) net.Conn {
	r.t.Helper()
	c, err := r.tryDial(src)
	if err != nil {
		r.t.Fatal(err)
	}

	return c
}

// tryDial is dial for a connection the demux may refuse at once: its reset can reach the client before connect returns.
func (r *rig) tryDial(src string) (net.Conn, error) {
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(src)}, Timeout: 2 * time.Second}
	c, err := d.Dial("tcp4", r.addr)
	if err == nil {
		r.t.Cleanup(func() { _ = c.Close() })
	}

	return c, err
}

func framed(pkt []byte) []byte {
	b := make([]byte, 2, 2+len(pkt))
	binary.BigEndian.PutUint16(b, uint16(len(pkt)))

	return append(b, pkt...)
}

func slotRequest(t *testing.T, k int) []byte {
	return framed(request(t, stunBindingReq, [][2][]byte{user("s" + twoDigits(k) + "AbCdEfGhIjKlM:clnt"), {at(attrIntegrity), make([]byte, 20)}}, false))
}

func twoDigits(k int) string {
	if k < 10 {
		return "0" + strconv.Itoa(k)
	}

	return strconv.Itoa(k)
}

// closedWithin says whether c is closed by the other end within d (read returns EOF or a reset, not a timeout).
func closedWithin(c net.Conn, d time.Duration) bool {
	_ = c.SetReadDeadline(time.Now().Add(d))
	_, err := c.Read(make([]byte, 64))
	var ne net.Error

	return err != nil && !(errors.As(err, &ne) && ne.Timeout())
}

func quick() limits {
	return limits{perNet: 48, total: 64 * 3, wait: 400 * time.Millisecond, pressureWait: 300 * time.Millisecond, handedPerNet: 192, handedTotal: 192 * 3}
}

func TestARequestReachesItsSlotWithTheClientsAddress(t *testing.T) {
	r := newRig(t, 3, quick(), 1, 2, 3)
	c := r.dial("127.0.7.9")
	first := slotRequest(t, 2)
	if _, err := c.Write(first); err != nil {
		t.Fatal(err)
	}
	var up net.Conn
	select {
	case up = <-r.slots[2].conns:
	case <-time.After(2 * time.Second):
		t.Fatal("slot 2 got no connection")
	}
	defer up.Close()
	got := make([]byte, len(first))
	if _, err := io.ReadFull(up, got); err != nil || !bytes.Equal(got, first) {
		t.Fatalf("slot 2 read %x (%v), want the first frame whole", got, err)
	}
	for _, k := range []int{1, 3} {
		select {
		case <-r.slots[k].conns:
			t.Fatalf("slot %d got a connection", k)
		default:
		}
	}
	r.mu.Lock()
	asked := r.asked[0]
	r.mu.Unlock()
	if asked.IP.String() != "127.0.7.9" || asked.Port != c.LocalAddr().(*net.TCPAddr).Port {
		t.Fatalf("dial was asked to keep %v, the client is %v", asked, c.LocalAddr())
	}
	// both ways, then a close on either end closes the other
	if _, err := up.Write([]byte("from desk-rtc")); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 13)
	if _, err := io.ReadFull(c, b); err != nil || string(b) != "from desk-rtc" {
		t.Fatalf("client read %q, %v", b, err)
	}
	if _, err := c.Write([]byte("from the client")); err != nil {
		t.Fatal(err)
	}
	b = make([]byte, 15)
	if _, err := io.ReadFull(up, b); err != nil || string(b) != "from the client" {
		t.Fatalf("slot read %q, %v", b, err)
	}
	_ = up.Close()
	if !closedWithin(c, 2*time.Second) {
		t.Fatal("the client's side stayed open after desk-rtc closed")
	}
}

func TestAnythingElseClosesAtOnce(t *testing.T) {
	r := newRig(t, 3, limits{perNet: 48, total: 192, wait: 5 * time.Second, pressureWait: 3 * time.Second, handedPerNet: 192, handedTotal: 576}, 1, 2, 3)
	pion, _ := hex.DecodeString(pionRequest)
	badFP := framed(append([]byte(nil), pion...))
	badFP[len(badFP)-1] ^= 1
	for name, first := range map[string][]byte{
		"TLS ClientHello":        {0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03},
		"HTTP":                   []byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
		"a binding success":      framed(request(t, 0x0101, [][2][]byte{user("s01AbCdEfGhIjKlM:x")}, false)),
		"Commons' ufrag":         framed(request(t, stunBindingReq, [][2][]byte{user("cmnsAbCdEfGhIjKl:x")}, false)),
		"a wrong FINGERPRINT":    badFP,
		"a slot past the host's": slotRequest(t, 4),
	} {
		c := r.dial("127.0.8.1")
		_, _ = c.Write(first)
		t0 := time.Now()
		if !closedWithin(c, time.Second) {
			t.Errorf("%s: not closed within 1 s (the wait is 5 s)", name)
		} else if dt := time.Since(t0); dt > 500*time.Millisecond {
			t.Errorf("%s: closed after %v, want at once", name, dt)
		}
	}
	for k, fs := range r.slots {
		select {
		case <-fs.conns:
			t.Fatalf("slot %d got a connection", k)
		default:
		}
	}
	st := r.d.st
	if st.badFrame.Load() != 4 || st.noSlot.Load() != 2 || st.handed.Load() != 0 {
		t.Fatalf("badFrame %d noSlot %d handed %d", st.badFrame.Load(), st.noSlot.Load(), st.handed.Load())
	}
}

func TestSilenceAndHalfAFrameClose(t *testing.T) {
	r := newRig(t, 3, quick(), 1)
	silent := r.dial("127.0.9.1")
	half := r.dial("127.0.9.2")
	req := slotRequest(t, 1)
	_, _ = half.Write(req[:10])
	time.Sleep(200 * time.Millisecond)
	for name, c := range map[string]net.Conn{"silent": silent, "half a frame": half} {
		if closedWithin(c, 10*time.Millisecond) {
			t.Fatalf("%s: closed before the wait", name)
		}
	}
	for name, c := range map[string]net.Conn{"silent": silent, "half a frame": half} {
		if !closedWithin(c, time.Second) {
			t.Fatalf("%s: still open after the wait", name)
		}
	}
	if r.d.st.silent.Load() != 2 {
		t.Fatalf("silent %d, want 2", r.d.st.silent.Load())
	}
}

func TestAStoppedSlotIsRefused(t *testing.T) {
	r := newRig(t, 3, quick(), 1)
	c := r.dial("127.0.10.1")
	_, _ = c.Write(slotRequest(t, 2)) // slot 2 has no marker: no desk running
	if !closedWithin(c, time.Second) {
		t.Fatal("a stopped slot's connection stayed open")
	}
	// a marker that's a link isn't a marker
	if err := os.Symlink("/etc/hostname", filepath.Join(r.dir, "3")); err != nil {
		t.Fatal(err)
	}
	c = r.dial("127.0.10.1")
	_, _ = c.Write(slotRequest(t, 3))
	if !closedWithin(c, time.Second) {
		t.Fatal("a link took a marker's place")
	}
	r.setLive(2, true)
	c = r.dial("127.0.10.1")
	_, _ = c.Write(slotRequest(t, 2))
	select {
	case up := <-r.slots[2].conns:
		_ = up.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("slot 2, once live, got nothing")
	}
	if r.d.st.stoppedSlot.Load() != 2 {
		t.Fatalf("stoppedSlot %d, want 2", r.d.st.stoppedSlot.Load())
	}
}

// A member on a network that blocks UDP, while six other networks hold every waiting place with silent connections and
// reopen each the moment it's closed: the member gets through every time, at once.
func TestAMemberGetsInWhileSixNetworksHoldEveryPlace(t *testing.T) {
	lim := limits{perNet: 48, total: 64 * 3, wait: 5 * time.Second, pressureWait: 3 * time.Second, handedPerNet: 192, handedTotal: 576}
	r := newRig(t, 3, lim, 1, 2, 3)
	var held []net.Conn
	for n := range 6 {
		for range 48 {
			if c, err := r.tryDial("127.0." + strconv.Itoa(20+n) + ".1"); err == nil {
				held = append(held, c)
			}
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if w, _, _ := r.d.g.counts(); w == lim.total {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w, nets, _ := r.d.g.counts(); w != lim.total || nets != 6 {
		t.Fatalf("waiting %d in %d networks, want every place (%d) shared by the 6", w, nets, lim.total)
	}
	for i := range 30 {
		c := r.dial("127.0.99.1")
		_, _ = c.Write(slotRequest(t, 1+i%3))
		select {
		case up := <-r.slots[1+i%3].conns:
			_ = up.Close()
		case <-time.After(2 * time.Second):
			t.Fatalf("try %d: the member didn't reach its slot", i)
		}
	}
	if w, _, _ := r.d.g.counts(); w > lim.total {
		t.Fatalf("waiting %d past the total", w)
	}
	if r.d.st.evicted.Load() == 0 {
		t.Fatal("nothing was taken back for the member")
	}
	_ = held
}

func TestOneNetworkCantHoldMoreThanItsPlaces(t *testing.T) {
	lim := quick()
	lim.wait, lim.pressureWait = 5*time.Second, 3*time.Second
	r := newRig(t, 3, lim, 1)
	var held []net.Conn
	closed := 0
	for range 60 {
		if c, err := r.tryDial("127.0.30.1"); err == nil {
			held = append(held, c)
		} else {
			closed++
		}
	}
	time.Sleep(150 * time.Millisecond)
	if w, _, _ := r.d.g.counts(); w != 48 {
		t.Fatalf("one network holds %d waiting places, want its 48", w)
	}
	for _, c := range held {
		if closedWithin(c, 20*time.Millisecond) {
			closed++
		}
	}
	if closed != 12 {
		t.Fatalf("%d of the 60 closed at once, want the 12 past the network's places", closed)
	}
}

func TestHandedPastTheCapIsRefused(t *testing.T) {
	lim := quick()
	lim.handedPerNet = 2
	r := newRig(t, 3, lim, 1)
	var ups []net.Conn
	for i := range 3 {
		c := r.dial("127.0.40." + strconv.Itoa(1+i))
		_, _ = c.Write(slotRequest(t, 1))
		if i < 2 {
			select {
			case up := <-r.slots[1].conns:
				ups = append(ups, up)
			case <-time.After(2 * time.Second):
				t.Fatalf("connection %d wasn't handed", i)
			}
		} else if !closedWithin(c, time.Second) {
			t.Fatal("a third connection from the network was handed past its cap")
		}
	}
	_ = ups[0].Close()
	time.Sleep(100 * time.Millisecond)
	c := r.dial("127.0.40.9")
	_, _ = c.Write(slotRequest(t, 1))
	select {
	case up := <-r.slots[1].conns:
		_ = up.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("a place given back wasn't taken again")
	}
	_ = ups[1].Close()
}
