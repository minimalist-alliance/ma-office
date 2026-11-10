// Package testrelay is a small UDP relay for tests. It stands between one client and desk-rtc, limits
// the rate each way, adds delay, and can go silent to imitate a client that vanished. A rate limit is
// what makes a bulk transfer build a real queue while staying light on the workstation's CPU.
package testrelay

import (
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Config sets the link's shape. A zero Bps means no rate limit.
type Config struct {
	Bps        int64
	Delay      time.Duration
	QueueBytes int
}

// Relay forwards one client's packets.
type Relay struct {
	cfg    Config
	front  *net.UDPConn
	back   *net.UDPConn
	client atomic.Pointer[net.UDPAddr]
	cut    atomic.Bool
	done   chan struct{}
	once   sync.Once
	up     *pipe
	down   *pipe
}

// New starts a relay to the target address.
func New(target *net.UDPAddr, cfg Config) (*Relay, error) {
	front, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	back, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, target)
	if err != nil {
		_ = front.Close()

		return nil, err
	}
	r := &Relay{cfg: cfg, front: front, back: back, done: make(chan struct{})}
	r.up = newPipe(cfg, r.done, func(b []byte) { _, _ = r.back.Write(b) })
	r.down = newPipe(cfg, r.done, func(b []byte) {
		if c := r.client.Load(); c != nil {
			_, _ = r.front.WriteToUDP(b, c)
		}
	})
	go r.readFront()
	go r.readBack()

	return r, nil
}

// Port is where the client should send.
func (r *Relay) Port() int { return r.front.LocalAddr().(*net.UDPAddr).Port }

// Cut stops forwarding both ways, or resumes it.
func (r *Relay) Cut(on bool) { r.cut.Store(on) }

// Close stops the relay.
func (r *Relay) Close() {
	r.once.Do(func() {
		close(r.done)
		_ = r.front.Close()
		_ = r.back.Close()
	})
}

func (r *Relay) readFront() {
	buf := make([]byte, 64*1024)
	for {
		n, addr, err := r.front.ReadFromUDP(buf)
		if err != nil {
			return
		}
		r.client.Store(addr)
		if !r.cut.Load() {
			r.up.push(append([]byte(nil), buf[:n]...))
		}
	}
}

func (r *Relay) readBack() {
	buf := make([]byte, 64*1024)
	for {
		n, err := r.back.Read(buf)
		if err != nil {
			select {
			case <-r.done:
				return
			default:
				continue
			}
		}
		if !r.cut.Load() {
			r.down.push(append([]byte(nil), buf[:n]...))
		}
	}
}

type packet struct {
	at time.Time
	b  []byte
}

// pipe is one direction: a serialized link with a drop-tail queue.
type pipe struct {
	cfg      Config
	send     func([]byte)
	done     chan struct{}
	queue    chan packet
	mu       sync.Mutex
	nextFree time.Time
}

func newPipe(cfg Config, done chan struct{}, send func([]byte)) *pipe {
	p := &pipe{cfg: cfg, send: send, done: done, queue: make(chan packet, 16384)}
	go p.run()

	return p
}

func (p *pipe) push(b []byte) {
	now := time.Now()
	p.mu.Lock()
	start := p.nextFree
	if start.Before(now) {
		start = now
	}
	if p.cfg.Bps > 0 && p.cfg.QueueBytes > 0 {
		backlog := int64(start.Sub(now)) * p.cfg.Bps / 8 / int64(time.Second)
		if backlog > int64(p.cfg.QueueBytes) {
			p.mu.Unlock()

			return // drop-tail
		}
	}
	free := start
	if p.cfg.Bps > 0 {
		free = start.Add(time.Duration(int64(len(b)) * 8 * int64(time.Second) / p.cfg.Bps))
	}
	p.nextFree = free
	p.mu.Unlock()

	select {
	case p.queue <- packet{at: free.Add(p.cfg.Delay), b: b}:
	default:
	}
}

func (p *pipe) run() {
	for {
		select {
		case <-p.done:
			return
		case pk := <-p.queue:
			if d := time.Until(pk.at); d > 0 {
				time.Sleep(d)
			}
			p.send(pk.b)
		}
	}
}

// RewriteAnswer points an answer's UDP candidate at the relay and removes the TCP one.
func RewriteAnswer(sdp string, port int) string {
	lines := strings.Split(sdp, "\r\n")
	out := lines[:0]
	for _, l := range lines {
		if strings.HasPrefix(l, "a=candidate:") {
			f := strings.Fields(l)
			if len(f) < 6 || !strings.EqualFold(f[2], "udp") {
				continue
			}
			f[5] = strconv.Itoa(port)
			l = strings.Join(f, " ")
		}
		out = append(out, l)
	}

	return strings.Join(out, "\r\n")
}
