package voice

import (
	"errors"
	"hash/maphash"
	"net"
	"net/netip"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/ipv4"
)

// batchConn sends UDP in batches: one sendmmsg(2) for many packets, instead of one sendto(2) each.
// A room of 200 with 10 talking sends 100,000 packets a second, and a system call per packet was
// two thirds of the server's CPU. Writes return at once; a few sender goroutines, each owning the
// destinations that hash to it (so each member's packets stay in order), drain the queues. A quiet
// room adds no delay: a sender wakes as soon as a packet is queued.
type batchConn struct {
	*net.UDPConn
	pc     *ipv4.PacketConn
	shards []*shard
	seed   maphash.Seed
	Sent   atomic.Uint64
	Drops  atomic.Uint64
	// Time in the queue, for /stats: the worst batch's oldest packet, and the sum, in microseconds.
	QueueMaxUs, QueueSumUs, QueueN atomic.Uint64
}

type shard struct {
	mu    sync.Mutex
	q     []ipv4.Message
	since time.Time // when the oldest queued packet arrived
	wake  chan struct{}
	addrs map[netip.AddrPort]*net.UDPAddr
}

const (
	batchMax   = 64
	shardQueue = 8192 // packets; past this a shard drops (a stalled socket, not a busy room)
)

var bufPool = sync.Pool{New: func() any { b := make([]byte, 0, 1500); return &b }}

func newBatchConn(c *net.UDPConn) *batchConn {
	n := min(max(runtime.GOMAXPROCS(0)/2, 1), 8)
	b := &batchConn{UDPConn: c, pc: ipv4.NewPacketConn(c), seed: maphash.MakeSeed()}
	for i := 0; i < n; i++ {
		s := &shard{wake: make(chan struct{}, 1), addrs: map[netip.AddrPort]*net.UDPAddr{}}
		b.shards = append(b.shards, s)
		go b.run(s)
	}
	return b
}

// ReadFromAddrPort and WriteToAddrPort make this an ice.AddrPortReaderWriter, so the mux uses them.
func (b *batchConn) ReadFromAddrPort(p []byte) (int, netip.AddrPort, error) {
	return b.UDPConn.ReadFromUDPAddrPort(p)
}

func (b *batchConn) WriteToAddrPort(p []byte, addr netip.AddrPort) (int, error) {
	var h maphash.Hash
	h.SetSeed(b.seed)
	a := addr.Addr().As16()
	h.Write(a[:])
	h.WriteByte(byte(addr.Port()))
	h.WriteByte(byte(addr.Port() >> 8))
	s := b.shards[h.Sum64()%uint64(len(b.shards))]

	bp := bufPool.Get().(*[]byte)
	buf := append((*bp)[:0], p...)
	s.mu.Lock()
	if len(s.q) >= shardQueue {
		s.mu.Unlock()
		bufPool.Put(bp)
		b.Drops.Add(1)
		return len(p), nil
	}
	ua := s.addrs[addr]
	if ua == nil {
		ua = net.UDPAddrFromAddrPort(addr)
		if len(s.addrs) > 65536 {
			clear(s.addrs)
		}
		s.addrs[addr] = ua
	}
	if len(s.q) == 0 {
		s.since = time.Now()
	}
	s.q = append(s.q, ipv4.Message{Buffers: [][]byte{buf}, Addr: ua})
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return len(p), nil
}

func (b *batchConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if ua, ok := addr.(*net.UDPAddr); ok {
		return b.WriteToAddrPort(p, ua.AddrPort())
	}
	return b.UDPConn.WriteTo(p, addr)
}

func (b *batchConn) run(s *shard) {
	var out []ipv4.Message
	for range s.wake {
		for {
			s.mu.Lock()
			out, s.q = s.q, out[:0]
			since := s.since
			s.mu.Unlock()
			if len(out) == 0 {
				break
			}
			waited := uint64(time.Since(since).Microseconds())
			b.QueueSumUs.Add(waited)
			b.QueueN.Add(1)
			for {
				m := b.QueueMaxUs.Load()
				if waited <= m || b.QueueMaxUs.CompareAndSwap(m, waited) {
					break
				}
			}
			for at := 0; at < len(out); {
				end := min(at+batchMax, len(out))
				n, err := b.pc.WriteBatch(out[at:end], 0)
				if err != nil || n <= 0 {
					n = end - at // drop what the kernel refused; RTP copes with loss
					if err != nil && isClosed(err) {
						return
					}
				}
				b.Sent.Add(uint64(n))
				at += n
			}
			for i := range out {
				buf := out[i].Buffers[0]
				bufPool.Put(&buf)
				out[i] = ipv4.Message{}
			}
		}
	}
}

func isClosed(err error) bool {
	return errors.Is(err, net.ErrClosed)
}
