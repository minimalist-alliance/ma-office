// guildscale measures what a Guild Desk's members cost the real desk-rtc: its memory and CPU with 200 and 600
// sessions at once, data channels only, with traffic. It's task 20's spike (spikes/guild-shared-desk/sessions) on the
// real binary: the same traffic, but through rtc.sock and desk-rtc's own channels. See desk-rtc/README.md, "Guild mode".
//
// It plays deskd and every member's browser, in this one process. desk-rtc runs as its own process, so only its
// memory and CPU are read, from /proc/<pid>:
//
//	desk-rtc --socket /tmp/g/rtc.sock --data-dir /tmp/g/rtc --bind 127.0.0.1 --port 18600 2>rtc.log &
//	guildscale --socket /tmp/g/rtc.sock --pid $! --levels 200,600 --settle 30s --gctrace rtc.log
//
// As deskd it sends configure with deskKind guild, then for each session session.create with the member's id
// (sessions go to members 3 at a time: 600 sessions are 200 members), and drains and grants credit. Traffic per
// session, as the spike's: deskd sends a 300-byte awareness batch every second on channel 4 (Commons' room link
// goes there on a Guild Desk) and a 1 KB document update every 5 s on collab; each browser sends 200 bytes of
// presence a second on channel 4 and a 1 KB edit every 10 s on collab. It prints one JSON line per level, and one for
// member.close at the end. Never for a real desk: it binds loopback only.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

const (
	awarenessBytes = 300
	updateBytes    = 1024
	presenceBytes  = 200
	editBytes      = 1024
)

type member struct {
	sessionID string
	memberID  string
	kind      kind
	pc        *webrtc.PeerConnection
	handle    uint32
	channels  [rtcsock.NumChannels]*webrtc.DataChannel
	open      chan struct{}
}

type harness struct {
	rtc     *rtcsock.Client
	api     *webrtc.API
	tcpAPI  *webrtc.API // ICE-TCP only (the review's L5)
	slowAPI *webrtc.API // never reads, 64 KiB SCTP window: a stalled member
	load    loadConfig
	loadState
	grantMu   sync.Mutex
	ungranted map[uint64]uint32
	pid       int
	perMem    int
	mu        sync.Mutex
	waiters   map[string]chan *rtcsock.Message
	partial   *rtcsock.Message // a stats reply's parts so far
	stats     chan *rtcsock.Message
	closed    chan *rtcsock.Message
	confd     chan *rtcsock.Message

	sessions []*member
	smu      sync.Mutex

	deskdIn  atomic.Int64 // frame bytes desk-rtc handed deskd
	clientIn atomic.Int64 // bytes the browsers got
	sendErrs atomic.Int64
}

func main() {
	sock := flag.String("socket", "", "desk-rtc's rtc.sock")
	pid := flag.Int("pid", 0, "desk-rtc's pid, for /proc")
	iface := flag.String("iface", "lo", "the clients' interface for ICE: lo here, or the box's own (ens5) when desk-rtc runs on another box")
	publicIPv4 := flag.String("public-ipv4", "127.0.0.1", "the address configure gives desk-rtc for its candidates: 127.0.0.1 here, or the desk's own when the clients run on another box (rtc.sock forwarded, --pid of no process)")
	levels := flag.String("levels", "200,600", "session counts to measure at")
	settle := flag.Duration("settle", 30*time.Second, "wait at each level before measuring; CPU is measured over the last half")
	perMember := flag.Int("per-member", 3, "sessions per member")
	workers := flag.Int("workers", 8, "sessions set up at once")
	gctrace := flag.String("gctrace", "", "desk-rtc's stderr, run with GODEBUG=gctrace=1: the last line gives its Go heap")
	var lc loadConfig
	flag.DurationVar(&lc.duration, "load", 0, "after the levels, run the burst profile this long (loadtest.go); 0 for none")
	flag.IntVar(&lc.slow, "slow", 6, "sessions whose client never reads")
	flag.Float64Var(&lc.bulkFrac, "bulk-frac", 0.1, "sessions moving a large item each way")
	flag.IntVar(&lc.bulkBytes, "bulk-bytes", 1<<20, "the large item's size")
	flag.DurationVar(&lc.bulkEvery, "bulk-every", 5*time.Second, "how often a bulk session moves one")
	flag.Float64Var(&lc.slowDeskdFrac, "slow-deskd-frac", 0.2, "bulk sessions whose credit deskd grants back a second late")
	flag.Float64Var(&lc.tcpFrac, "tcp-frac", 0.1, "sessions on ICE-TCP")
	flag.BoolVar(&lc.attacker, "attacker", true, "one member's three sessions flood 1-byte messages (the review's H1)")
	flag.IntVar(&lc.credit, "credit", 0, "deskd's credit per channel in configure (0: none, the 256 KiB default)")
	flag.Parse()
	if *sock == "" || *pid == 0 {
		log.Fatal("--socket and --pid are required")
	}

	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetInterfaceFilter(func(name string) bool { return name == *iface })
	tse, sse := se, se
	tse.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	sse.DetachDataChannels()
	sse.SetSCTPMaxReceiveBufferSize(64 * 1024)
	h := &harness{
		api: webrtc.NewAPI(webrtc.WithSettingEngine(se)), pid: *pid, perMem: *perMember, load: lc,
		tcpAPI: webrtc.NewAPI(webrtc.WithSettingEngine(tse)), slowAPI: webrtc.NewAPI(webrtc.WithSettingEngine(sse)),
		waiters: map[string]chan *rtcsock.Message{},
		stats:   make(chan *rtcsock.Message, 1), closed: make(chan *rtcsock.Message, 1), confd: make(chan *rtcsock.Message, 1),
	}
	h.ungranted = map[uint64]uint32{}
	h.echo = make(chan echoJob, 4096)
	for i := 0; i < 4; i++ {
		go h.echoer()
	}
	ctx := context.Background()
	rtc, err := rtcsock.DialRetry(ctx, *sock)
	if err != nil {
		log.Fatal(err)
	}
	h.rtc = rtc
	go func() { log.Fatalf("rtc.sock: %v", rtc.Run(h.onJSON, h.onData)) }()

	var targets []int
	for _, l := range strings.Split(*levels, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(l))
		if err != nil || n <= 0 {
			log.Fatalf("level %q", l)
		}
		targets = append(targets, n)
	}
	most := targets[len(targets)-1]
	must(rtc.Send(&rtcsock.Message{T: "configure", PublicIPv4: *publicIPv4, MaxSessions: most, DeskKind: rtcsock.DeskKindGuild, MaxSessionsPerMember: *perMember, Credit: lc.credit}))
	conf := <-h.confd
	if conf.DeskKind != rtcsock.DeskKindGuild || conf.MaxSessions < most {
		log.Fatalf("desk-rtc isn't in guild mode for %d: %+v", most, conf)
	}
	if conf.Credit > 0 {
		rtc.SetInitialCredit(int64(conf.Credit))
	}
	go h.deskdTraffic()

	time.Sleep(2 * time.Second)
	h.report(0, *settle/2, *gctrace)
	for _, target := range targets {
		began := time.Now()
		h.grow(target, *workers)
		log.Printf("%d sessions open in %v", target, time.Since(began).Round(time.Millisecond))
		time.Sleep(*settle / 2)
		h.report(target, *settle/2, *gctrace)
	}
	if lc.duration > 0 {
		h.runLoad(*gctrace)
	}
	h.memberClose()
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func (h *harness) onJSON(m *rtcsock.Message) {
	switch m.T {
	case "configured":
		h.confd <- m
	case "session.answer", "session.error":
		h.mu.Lock()
		w := h.waiters[m.SessionID]
		delete(h.waiters, m.SessionID)
		h.mu.Unlock()
		if w != nil {
			w <- m
		}
	case "stats":
		// A Guild Desk's stats come in parts: totals in part 0, the rows joined until last.
		h.mu.Lock()
		if h.partial == nil {
			h.partial = m
		} else {
			h.partial.Sessions = append(h.partial.Sessions, m.Sessions...)
			h.partial.Members = append(h.partial.Members, m.Members...)
		}
		whole := h.partial
		done := m.Last == nil || *m.Last
		if done {
			h.partial = nil
			whole.Part = m.Part
		}
		h.mu.Unlock()
		if done {
			h.stats <- whole
		}
	case "member.closed":
		h.closed <- m
	case "session.closed":
		h.closeMu.Lock()
		if h.closes == nil {
			h.closes = map[string]int{}
		}
		h.closes[m.Reason]++
		h.closeMu.Unlock()
		if m.Reason != "guild_removed" && m.Reason != "protocol_error" {
			log.Printf("session %s closed: %s", m.SessionID, m.Reason)
		}
	}
}

// onData is deskd draining: count it and give the credit back at once, or a second late for the sessions playing a
// slow deskd. A probe on rpc is answered at once (loadtest.go).
func (h *harness) onData(handle uint32, channel uint8, b []byte) {
	h.deskdIn.Add(int64(len(b)))
	if channel == rtcsock.ChRPC && len(b) == probeFrameLen {
		select {
		case h.echo <- echoJob{handle, append([]byte(nil), b...)}:
		default:
		}
	}
	// Credit goes back once 32 KiB has drained, as deskd batches it (at 64 KiB), not a write per frame: a flood of
	// 1-byte frames would otherwise make this process, not desk-rtc, the bottleneck.
	key := uint64(handle)<<8 | uint64(channel)
	h.grantMu.Lock()
	h.ungranted[key] += uint32(len(b))
	n := h.ungranted[key]
	if n < 32*1024 {
		h.grantMu.Unlock()

		return
	}
	delete(h.ungranted, key)
	h.grantMu.Unlock()
	if h.lateGrant(handle) {
		time.AfterFunc(time.Second, func() { _ = h.rtc.Grant(handle, channel, n) })

		return
	}
	_ = h.rtc.Grant(handle, channel, n)
}

func (h *harness) grow(target, workers int) {
	jobs := make(chan int)
	var wg sync.WaitGroup
	var failed atomic.Int64
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if err := h.connect(i); err != nil {
					log.Printf("session %d: %v", i, err)
					failed.Add(1)
				}
			}
		}()
	}
	h.smu.Lock()
	from := len(h.sessions)
	h.smu.Unlock()
	for i := from; i < target; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if failed.Load() > 0 {
		log.Fatalf("%d sessions failed", failed.Load())
	}
}

func (h *harness) connect(i int) error {
	return h.connectAs(fmt.Sprintf("cs-%05d", i), fmt.Sprintf("gm-%04d", i/h.perMem), h.kindOf(i))
}

func (h *harness) connectAs(sessionID, memberID string, k kind) error {
	api := h.api
	switch k {
	case kindTCP:
		api = h.tcpAPI
	case kindSlow:
		api = h.slowAPI
	default:
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle, RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire})
	if err != nil {
		return err
	}
	m := &member{sessionID: sessionID, memberID: memberID, kind: k, pc: pc, open: make(chan struct{})}
	var opened atomic.Int32
	// All eight, as the Desk app makes them. A Guild Desk reads input and keys and drops them.
	for id := uint8(0); id < rtcsock.NumChannels; id++ {
		def := rtcsock.Channels[id]
		negotiated, ordered, sid := true, def.Ordered, uint16(def.ID)
		dc, err := pc.CreateDataChannel(def.Label, &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: def.MaxRetransmits, Negotiated: &negotiated, ID: &sid})
		if err != nil {
			return err
		}
		m.channels[id] = dc
		if k != kindSlow {
			ch := id
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				h.clientIn.Add(int64(len(msg.Data)))
				if ch == rtcsock.ChRPC && len(msg.Data) == probeFrameLen {
					h.probeAnswered(m, msg.Data)
				}
			})
		}
		dc.OnOpen(func() {
			if opened.Add(1) == rtcsock.NumChannels {
				close(m.open)
			}
		})
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	<-gathered
	sdp := pc.LocalDescription().SDP
	fp := ""
	for _, l := range strings.Split(sdp, "\r\n") {
		if v, ok := strings.CutPrefix(l, "a=fingerprint:sha-256 "); ok {
			fp = strings.ToLower(strings.ReplaceAll(v, ":", ""))
		}
	}
	w := make(chan *rtcsock.Message, 1)
	h.mu.Lock()
	h.waiters[m.sessionID] = w
	h.mu.Unlock()
	if err := h.rtc.Send(&rtcsock.Message{
		T: "session.create", SessionID: m.sessionID, Offer: sdp, ExpectedFingerprint: fp, MemberID: m.memberID,
		Permissions: &rtcsock.Permissions{},
	}); err != nil {
		return err
	}
	var ans *rtcsock.Message
	select {
	case ans = <-w:
	case <-time.After(15 * time.Second):
		return errors.New("no answer")
	}
	if ans.T != "session.answer" {
		return fmt.Errorf("%s: %v %s", ans.T, ans.Code, ans.Message)
	}
	m.handle = ans.Handle
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: ans.Answer}); err != nil {
		return err
	}
	select {
	case <-m.open:
	case <-time.After(20 * time.Second):
		return fmt.Errorf("channels didn't open: %s", pc.ConnectionState())
	}
	h.smu.Lock()
	h.sessions = append(h.sessions, m)
	h.smu.Unlock()
	if k != kindSlow {
		go h.clientTraffic(m)
	}

	return nil
}

// clientTraffic is one browser: presence every second on channel 4, an edit every 10 s on collab. Spread over the
// second so a level's sessions don't all send at once.
func (h *harness) clientTraffic(m *member) {
	presence := frame.Encode(frame.Data, frame.FlagBin, 1, 0, make([]byte, presenceBytes-frame.HeaderSize))
	edit := frame.Encode(frame.Data, frame.FlagBin, 2, 0, make([]byte, editBytes-frame.HeaderSize))
	time.Sleep(time.Duration(m.handle%1000) * time.Millisecond)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for n := 1; ; n++ {
		<-tick.C
		if m.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			return
		}
		if m.channels[rtcsock.ChMdoc].Send(presence) != nil {
			h.sendErrs.Add(1)
		}
		if n%10 == 0 && m.channels[rtcsock.ChCollab].Send(edit) != nil {
			h.sendErrs.Add(1)
		}
	}
}

// deskdTraffic is deskd's side: an awareness batch to every session every second, a document update every 5 s.
func (h *harness) deskdTraffic() {
	awareness := frame.Encode(frame.Data, frame.FlagBin, 1, 0, make([]byte, awarenessBytes-frame.HeaderSize))
	update := frame.Encode(frame.Data, frame.FlagBin, 2, 0, make([]byte, updateBytes-frame.HeaderSize))
	ctx := context.Background()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for n := 1; ; n++ {
		<-tick.C
		h.smu.Lock()
		all := append([]*member(nil), h.sessions...)
		h.smu.Unlock()
		for _, m := range all {
			if m.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
				continue
			}
			sctx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
			if h.rtc.SendData(sctx, m.handle, rtcsock.ChMdoc, awareness) != nil {
				h.sendErrs.Add(1)
			}
			if n%5 == 0 && h.rtc.SendData(sctx, m.handle, rtcsock.ChCollab, update) != nil {
				h.sendErrs.Add(1)
			}
			cancel()
		}
	}
}

type procSample struct {
	rssKiB, anonKiB, pssKiB, threads int64
	cpuTicks                         int64
	at                               time.Time
}

func (h *harness) sample() procSample {
	s := procSample{at: time.Now()}
	s.rssKiB = field(fmt.Sprintf("/proc/%d/status", h.pid), "VmRSS")
	s.anonKiB = field(fmt.Sprintf("/proc/%d/status", h.pid), "RssAnon")
	s.threads = field(fmt.Sprintf("/proc/%d/status", h.pid), "Threads")
	s.pssKiB = field(fmt.Sprintf("/proc/%d/smaps_rollup", h.pid), "Pss")
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", h.pid))
	if err == nil {
		// Fields after the command's closing parenthesis: utime is the 12th, stime the 13th.
		if i := strings.LastIndexByte(string(b), ')'); i > 0 {
			f := strings.Fields(string(b)[i+2:])
			if len(f) > 12 {
				u, _ := strconv.ParseInt(f[11], 10, 64)
				st, _ := strconv.ParseInt(f[12], 10, 64)
				s.cpuTicks = u + st
			}
		}
	}

	return s
}

func field(path, key string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, key+":"); ok {
			f := strings.Fields(v)
			if len(f) > 0 {
				n, _ := strconv.ParseInt(f[0], 10, 64)

				return n
			}
		}
	}

	return 0
}

var gcLine = regexp.MustCompile(`(\d+)->(\d+)->(\d+) MB, (\d+) MB goal`)

// heapMB is the live heap after desk-rtc's last GC, from its gctrace.
func heapMB(path string) int64 {
	if path == "" {
		return -1
	}
	f, err := os.Open(path)
	if err != nil {
		return -1
	}
	defer f.Close()
	var last int64 = -1
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		if m := gcLine.FindStringSubmatch(sc.Text()); m != nil {
			last, _ = strconv.ParseInt(m[3], 10, 64)
		}
	}

	return last
}

const clkTck = 100 // USER_HZ on Linux

func (h *harness) report(level int, window time.Duration, gctrace string) {
	a := h.sample()
	inA, outA := h.deskdIn.Load(), h.clientIn.Load()
	time.Sleep(window)
	b := h.sample()
	inB, outB := h.deskdIn.Load(), h.clientIn.Load()
	secs := b.at.Sub(a.at).Seconds()

	began := time.Now()
	must(h.rtc.Send(&rtcsock.Message{T: "stats.get"}))
	var st *rtcsock.Message
	select {
	case st = <-h.stats:
	case <-time.After(10 * time.Second):
		log.Fatalf("no stats at %d sessions", level)
	}
	statsMs := float64(time.Since(began).Microseconds()) / 1000
	var withMember int
	for _, r := range st.Sessions {
		if r.MemberID != "" {
			withMember++
		}
	}
	var memberSent, rowsSent uint64
	for _, r := range st.Members {
		memberSent += r.BytesSent
	}
	for _, r := range st.Sessions {
		rowsSent += r.BytesSent
	}
	out := map[string]any{
		"level": level, "sessions": len(st.Sessions), "sessionsWithMemberId": withMember, "members": len(st.Members),
		"rssKiB": b.rssKiB, "anonKiB": b.anonKiB, "pssKiB": b.pssKiB, "threads": b.threads, "goHeapLiveMB": heapMB(gctrace),
		"cpuCores":             round(float64(b.cpuTicks-a.cpuTicks)/clkTck/secs, 3),
		"toDeskdBytesPerSec":   round(float64(inB-inA)/secs, 0),
		"toClientsBytesPerSec": round(float64(outB-outA)/secs, 0),
		"statsGetMs":           statsMs, "statsParts": statsParts(st), "statsMembersSentEqualsRows": memberSent == rowsSent,
		"sendErrors": h.sendErrs.Load(),
	}
	j, _ := json.Marshal(out)
	fmt.Println(string(j))
}

func round(v float64, places int) float64 {
	p := 1.0
	for i := 0; i < places; i++ {
		p *= 10
	}

	return float64(int64(v*p+0.5)) / p
}

// memberClose times member.close for one member's sessions, with everyone else's still open.
func (h *harness) memberClose() {
	h.smu.Lock()
	target := h.sessions[len(h.sessions)/2].memberID
	n := 0
	for _, m := range h.sessions {
		if m.memberID == target {
			n++
		}
	}
	h.smu.Unlock()
	began := time.Now()
	must(h.rtc.Send(&rtcsock.Message{T: "member.close", MemberID: target, Reason: "guild_removed"}))
	var m *rtcsock.Message
	select {
	case m = <-h.closed:
	case <-time.After(10 * time.Second):
		log.Fatal("no member.closed")
	}
	j, _ := json.Marshal(map[string]any{
		"memberClose": target, "sessions": n, "closed": len(m.SessionIDs), "ms": float64(time.Since(began).Microseconds()) / 1000,
	})
	fmt.Println(string(j))
}

func statsParts(m *rtcsock.Message) int {
	if m.Part == nil {
		return 1
	}

	return *m.Part + 1
}
