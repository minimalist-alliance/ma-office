package main

// The burst profile (the review of guild mode, M1 and H1): with every session open, about a tenth move a large item
// each way at once, a few members' clients stop reading, deskd grants a few sessions' credit a second late, a tenth
// are on ICE-TCP, and one member's three sessions flood 1-byte messages, on keys, on collab and on a stream that isn't
// a channel. Every other session sends a probe on rpc each second, which deskd answers at once: its round trip through
// desk-rtc, both ways, is the latency other members see. desk-rtc's memory is sampled every 200 ms.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

type kind int

const (
	kindRegular kind = iota
	kindTCP
	kindBulk
	kindSlow
	kindAttacker
)

func (k kind) String() string {
	return [...]string{"regular", "tcp", "bulk", "slow", "attacker"}[k]
}

type loadConfig struct {
	duration      time.Duration
	slow          int
	bulkFrac      float64
	bulkBytes     int
	bulkEvery     time.Duration
	slowDeskdFrac float64
	tcpFrac       float64
	attacker      bool
	credit        int
}

// probeFrameLen is a probe's frame: the header and the client's send time.
const probeFrameLen = frame.HeaderSize + 8

type echoJob struct {
	handle uint32
	frame  []byte
}

type loadState struct {
	closeMu sync.Mutex
	closes  map[string]int
	echo    chan echoJob
	late    sync.Map // handle -> true: deskd grants its credit a second late
	probing atomic.Bool
	rttMu   sync.Mutex
	rtt     map[kind][]float64 // ms
	floods  atomic.Int64       // 1-byte messages the attacker sent
	rejoins atomic.Int64       // attacker sessions closed and opened again
}

// kindOf gives session i its part: the first few slow, the next member's three the attacker, then every tenth bulk
// and every tenth (offset) on ICE-TCP. With no burst profile, all regular, as before.
func (h *harness) kindOf(i int) kind {
	lc := h.load
	if lc.duration == 0 {
		return kindRegular
	}
	switch {
	case i < lc.slow:
		return kindSlow
	case lc.attacker && i >= lc.slow && i < lc.slow+h.perMem:
		return kindAttacker
	}
	if lc.bulkFrac > 0 && i%int(1/lc.bulkFrac+0.5) == 0 {
		return kindBulk
	}
	if lc.tcpFrac > 0 && i%int(1/lc.tcpFrac+0.5) == 5 {
		return kindTCP
	}

	return kindRegular
}

func (h *harness) lateGrant(handle uint32) bool {
	_, ok := h.late.Load(handle)

	return ok
}

// echoer is deskd answering a probe on the session's rpc at once.
func (h *harness) echoer() {
	for j := range h.echo {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = h.rtc.SendData(ctx, j.handle, rtcsock.ChRPC, j.frame)
		cancel()
	}
}

func (h *harness) probeAnswered(m *member, b []byte) {
	f, err := frame.Decode(b)
	if err != nil || len(f.Payload) != 8 || !h.probing.Load() {
		return
	}
	sent := int64(binary.BigEndian.Uint64(f.Payload))
	ms := float64(time.Now().UnixNano()-sent) / 1e6
	h.rttMu.Lock()
	h.rtt[m.kind] = append(h.rtt[m.kind], ms)
	h.rttMu.Unlock()
}

// prober sends one probe a second on m's rpc.
func (h *harness) prober(ctx context.Context, m *member) {
	time.Sleep(time.Duration(m.handle%1000) * time.Millisecond)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var payload [8]byte
	for seq := uint32(0); ; seq++ {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if m.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			return
		}
		binary.BigEndian.PutUint64(payload[:], uint64(time.Now().UnixNano()))
		_ = m.channels[rtcsock.ChRPC].Send(frame.Encode(frame.Data, 0, 3, seq, payload[:]))
	}
}

// bulk moves a large item each way every bulkEvery: deskd to the client on bulk, and the client to deskd.
func (h *harness) bulk(ctx context.Context, m *member, deskdOnly bool) {
	payload := make([]byte, rtcsock.MaxFrame-frame.HeaderSize)
	chunk := frame.Encode(frame.Chunk, frame.FlagBin, 9, 0, payload)
	tick := time.NewTicker(h.load.bulkEvery)
	defer tick.Stop()
	for {
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sent := 0; sent < h.load.bulkBytes && ctx.Err() == nil; sent += len(chunk) {
				if h.rtc.SendData(ctx, m.handle, rtcsock.ChBulk, chunk) != nil {
					return
				}
			}
		}()
		if !deskdOnly {
			dc := m.channels[rtcsock.ChBulk]
			for sent := 0; sent < h.load.bulkBytes && ctx.Err() == nil; sent += len(chunk) {
				for dc.BufferedAmount() > 1<<20 && ctx.Err() == nil {
					time.Sleep(5 * time.Millisecond)
				}
				if dc.Send(chunk) != nil {
					break
				}
			}
		}
		wg.Wait()
		if deskdOnly {
			if ctx.Err() != nil {
				return
			}

			continue // a slow member: deskd keeps sending as fast as its credit lets it
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// floodOn sends 1-byte messages on dc until ctx ends or the channel closes, never more than 256 KiB ahead of SCTP.
func (h *harness) floodOn(ctx context.Context, dc *webrtc.DataChannel) {
	msg := []byte{0x42}
	for ctx.Err() == nil {
		for dc.BufferedAmount() > 256*1024 {
			if ctx.Err() != nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
				return
			}
			time.Sleep(time.Millisecond)
		}
		if dc.Send(msg) != nil {
			return
		}
		h.floods.Add(1)
	}
}

// attack is the hostile member: keys and collab flooded on two sessions, and on the third a stream that isn't a
// channel, which desk-rtc ends; it comes back as a new session and tries again, every few seconds.
func (h *harness) attack(ctx context.Context, ms []*member) {
	if len(ms) < 3 {
		return
	}
	go h.floodOn(ctx, ms[0].channels[rtcsock.ChKeys])
	go h.floodOn(ctx, ms[0].channels[rtcsock.ChInput])
	go h.floodOn(ctx, ms[1].channels[rtcsock.ChCollab])
	go func() {
		cur := ms[2]
		for n := 0; ctx.Err() == nil; n++ {
			negotiated, id := true, uint16(20+n%100)
			dc, err := cur.pc.CreateDataChannel("not-ours", &webrtc.DataChannelInit{Negotiated: &negotiated, ID: &id})
			if err == nil {
				opened := make(chan struct{})
				dc.OnOpen(func() { close(opened) })
				select {
				case <-opened:
					fctx, cancel := context.WithTimeout(ctx, 3*time.Second)
					h.floodOn(fctx, dc)
					cancel()
				case <-time.After(3 * time.Second):
				}
			}
			_ = cur.pc.Close()
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			sid := fmt.Sprintf("cs-atk-%04d", n)
			if err := h.connectAs(sid, cur.memberID, kindAttacker); err != nil {
				log.Printf("attacker rejoin: %v", err)

				continue
			}
			h.rejoins.Add(1)
			h.smu.Lock()
			cur = h.sessions[len(h.sessions)-1]
			h.smu.Unlock()
		}
	}()
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(p * float64(len(sorted)-1))

	return round(sorted[i], 2)
}

func (h *harness) latencies() map[string]any {
	h.rttMu.Lock()
	defer h.rttMu.Unlock()
	out := map[string]any{}
	var all []float64
	for k, v := range h.rtt {
		s := append([]float64(nil), v...)
		sort.Float64s(s)
		all = append(all, s...)
		out[k.String()] = map[string]any{"n": len(s), "p50": percentile(s, 0.5), "p95": percentile(s, 0.95), "p99": percentile(s, 0.99), "max": percentile(s, 1)}
	}
	sort.Float64s(all)
	out["all"] = map[string]any{"n": len(all), "p50": percentile(all, 0.5), "p95": percentile(all, 0.95), "p99": percentile(all, 0.99), "max": percentile(all, 1)}

	return out
}

// phase probes for d with whatever runs, and prints one line: latency, desk-rtc's memory and CPU, its stats.
func (h *harness) phase(name string, d time.Duration, gctrace string) {
	h.rttMu.Lock()
	h.rtt = map[kind][]float64{}
	h.rttMu.Unlock()
	h.probing.Store(true)
	a := h.sample()
	var peak int64
	stop := time.Now().Add(d)
	for time.Now().Before(stop) {
		if s := h.sample(); s.rssKiB > peak {
			peak = s.rssKiB
		}
		time.Sleep(200 * time.Millisecond)
	}
	b := h.sample()
	h.probing.Store(false)
	must(h.rtc.Send(&rtcsock.Message{T: "stats.get"}))
	var st *rtcsock.Message
	select {
	case st = <-h.stats:
	case <-time.After(10 * time.Second):
		log.Fatal("no stats")
	}
	live := 0
	for _, r := range st.Sessions {
		if !r.Closed {
			live++
		}
	}
	h.closeMu.Lock()
	closes := map[string]int{}
	for k, v := range h.closes {
		closes[k] = v
	}
	h.closeMu.Unlock()
	out := map[string]any{
		"phase": name, "seconds": d.Seconds(), "liveSessions": live, "rows": len(st.Sessions),
		"rssKiB": b.rssKiB, "peakRssKiB": peak, "hwmKiB": field(fmt.Sprintf("/proc/%d/status", h.pid), "VmHWM"),
		"goHeapLiveMB": heapMB(gctrace), "cpuCores": round(float64(b.cpuTicks-a.cpuTicks)/clkTck/b.at.Sub(a.at).Seconds(), 3),
		"rttMs": h.latencies(), "closes": closes, "budget": st.Budget, "voiceRelay": st.VoiceRelay,
		"attackerMessages": h.floods.Load(), "attackerRejoins": h.rejoins.Load(), "sendErrors": h.sendErrs.Load(),
	}
	j, _ := json.Marshal(out)
	fmt.Println(string(j))
}

func (h *harness) runLoad(gctrace string) {
	h.smu.Lock()
	all := append([]*member(nil), h.sessions...)
	h.smu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Probes from every session that isn't moving anything, attacking or stalled: the other members.
	for _, m := range all {
		if m.kind == kindRegular || m.kind == kindTCP {
			go h.prober(ctx, m)
		}
	}
	h.phase("steady", 30*time.Second, gctrace)

	var attackers []*member
	nBulk := 0
	for _, m := range all {
		switch m.kind {
		case kindBulk:
			if h.load.slowDeskdFrac > 0 && nBulk%int(1/h.load.slowDeskdFrac+0.5) == 0 {
				h.late.Store(m.handle, true)
			}
			nBulk++
			go h.bulk(ctx, m, false)
		case kindSlow:
			go h.bulk(ctx, m, true)
		case kindAttacker:
			attackers = append(attackers, m)
		default:
		}
	}
	h.attack(ctx, attackers)
	h.phase("burst", h.load.duration, gctrace)
	cancel()
	// Everything stops but the probes and the steady traffic: does the desk come back down?
	after, done := context.WithCancel(context.Background())
	defer done()
	h.smu.Lock()
	all = append(all[:0], h.sessions...)
	h.smu.Unlock()
	for _, m := range all {
		if m.kind == kindRegular || m.kind == kindTCP {
			go h.prober(after, m)
		}
	}
	h.phase("after", 20*time.Second, gctrace)
}
