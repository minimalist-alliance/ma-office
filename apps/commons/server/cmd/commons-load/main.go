// commons-load simulates members in one Commons room, for sizing the guild server (task 20).
//
// Each simulated member does what a browser does: opens the room link, joins, and opens a voice
// connection with the slots the server offers (DTLS-SRTP, Pion as the client). Talkers send an
// Opus-sized packet every 20 ms with an RFC 6464 level that says "talking". Cursor movers send a
// cursor 30 times a second. Drawers send a stroke in progress at 60 Hz for a second, then a real
// Yjs update (from strokes.bin), every few seconds. Every member counts what it receives.
//
// Talkers put their send time in the payload, so a listener in the same process (or on the same
// host's clock) measures the voice path through the server: SRTP, the forwarding, the kernel.
//
// It samples the server's /stats each second and prints a JSON summary of the steady state.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/wire"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

var (
	wsURL    = flag.String("url", "ws://127.0.0.1:8790/ws?room=load", "room link")
	statsURL = flag.String("stats", "", "server /stats URL to sample (empty: don't)")
	members  = flag.Int("members", 50, "members to simulate")
	first    = flag.Int("first", 0, "index of the first member (to split a room across load processes)")
	talkers  = flag.Int("talkers", 10, "members who talk the whole time (counted from index 0 of the room)")
	movers   = flag.Int("movers", 10, "members who move a cursor at 30 Hz")
	drawers  = flag.Int("drawers", 2, "members who draw a stroke every few seconds")
	chatters = flag.Int("chatters", 0, "members who post a chat message every 5 to 15 s (about 100 characters)")
	ramp     = flag.Float64("ramp", 20, "members joining per second")
	warm     = flag.Duration("warm", 10*time.Second, "settle time after the last join, before measuring")
	measure  = flag.Duration("measure", 60*time.Second, "how long to measure")
	payload  = flag.Int("payload", 80, "bytes of Opus payload per 20 ms (80 is about 32 kb/s)")
	fixtures = flag.String("fixtures", "strokes.bin", "Yjs stroke updates for drawers")
	label    = flag.String("label", "", "a name for this run in the summary")
	quiet    = flag.Bool("quiet", false, "no progress lines")
)

// ---------------------------------------------------------------- counters

type hist struct {
	mu sync.Mutex
	v  []float64 // ms, sampled
	n  uint64
}

func (h *hist) add(ms float64) {
	h.mu.Lock()
	h.n++
	// Keep every value up to 200k, then sample, so memory stays bounded.
	if len(h.v) < 200_000 {
		h.v = append(h.v, ms)
	} else if i := rand.IntN(int(h.n)); i < len(h.v) {
		h.v[i] = ms
	}
	h.mu.Unlock()
}

func (h *hist) reset() {
	h.mu.Lock()
	h.v, h.n = h.v[:0], 0
	h.mu.Unlock()
}

func (h *hist) pct(ps ...float64) []float64 {
	h.mu.Lock()
	v := append([]float64(nil), h.v...)
	h.mu.Unlock()
	sort.Float64s(v)
	out := make([]float64, len(ps))
	for i, p := range ps {
		if len(v) == 0 {
			continue
		}
		out[i] = math.Round(v[min(len(v)-1, int(p*float64(len(v))))]*100) / 100
	}
	return out
}

var (
	cJoined, cVoiceUp                                atomic.Int64
	cRTPIn, cRTPBytesIn, cRTPOut, cWSIn              atomic.Uint64
	cWSOut, cCursorsIn, cLiveIn, cEntriesIn, cChatIn atomic.Uint64
	voiceLat, drawLat, chatLat                       hist
	errs                                             atomic.Int64
)

var strokes [][]byte

// ---------------------------------------------------------------- one member

type member struct {
	i      int
	name   string
	ws     *websocket.Conn
	ctx    context.Context
	sendMu sync.Mutex
	pc     *webrtc.PeerConnection
	slots  int
	answer chan string
	talk   bool
	idx    uint16
}

func (m *member) send(rec []byte) {
	m.sendMu.Lock()
	defer m.sendMu.Unlock()
	if err := m.ws.Write(m.ctx, websocket.MessageBinary, rec); err == nil {
		cWSOut.Add(uint64(len(rec)))
	}
}

func (m *member) ctrl(v any) {
	b, _ := json.Marshal(v)
	m.send(wire.Append(nil, wire.Ctrl, b))
}

var api *webrtc.API

func newAPI() *webrtc.API {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		log.Fatal(err)
	}
	if err := me.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI}, webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverDirectionSendonly); err != nil {
		log.Fatal(err)
	}
	reg := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(reg); err != nil {
		log.Fatal(err)
	}
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	return webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(reg), webrtc.WithSettingEngine(se))
}

func (m *member) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	m.ctx = ctx
	ws, _, err := websocket.Dial(ctx, *wsURL, nil)
	if err != nil {
		errs.Add(1)
		log.Printf("%s: dial: %v", m.name, err)
		return
	}
	ws.SetReadLimit(wire.MaxRecord + 1024)
	m.ws = ws
	defer ws.CloseNow()
	welcome := make(chan struct{})
	m.answer = make(chan string, 1)
	go m.read(ctx, welcome)
	m.ctrl(map[string]any{"t": "hello", "v": 2, "name": m.name})
	select {
	case <-welcome:
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
		errs.Add(1)
		return
	}
	m.ctrl(map[string]any{"t": "join", "muted": !m.talk})
	cJoined.Add(1)
	if err := m.voice(ctx); err != nil {
		errs.Add(1)
		log.Printf("%s: voice: %v", m.name, err)
	}
	if m.i < *movers {
		go m.moveCursor(ctx)
	}
	if m.i >= *movers && m.i < *movers+*drawers {
		go m.draw(ctx)
	}
	if m.i >= *movers+*drawers && m.i < *movers+*drawers+*chatters {
		go m.chat(ctx)
	}
	<-ctx.Done()
	if m.pc != nil {
		m.pc.Close()
	}
}

func (m *member) read(ctx context.Context, welcome chan struct{}) {
	once := sync.Once{}
	for {
		_, msg, err := m.ws.Read(ctx)
		if err != nil {
			return
		}
		cWSIn.Add(uint64(len(msg)))
		now := time.Now()
		_ = wire.Each(msg, func(typ byte, p []byte) error {
			switch typ {
			case wire.Ctrl:
				var c struct {
					T     string `json:"t"`
					SDP   string `json:"sdp"`
					Slots int    `json:"slots"`
					You   struct {
						I uint16 `json:"i"`
					} `json:"you"`
					M struct {
						Text string `json:"text"`
					} `json:"m"`
				}
				if json.Unmarshal(p, &c) != nil {
					return nil
				}
				switch c.T {
				case "welcome":
					m.slots = c.Slots
					m.idx = c.You.I
					once.Do(func() { close(welcome) })
				case "chat":
					cChatIn.Add(1)
					if i := strings.Index(c.M.Text, "CMCT"); i >= 0 {
						if sent, err := strconv.ParseInt(strings.Fields(c.M.Text[i+4:])[0], 10, 64); err == nil {
							chatLat.add(float64(now.UnixNano()-sent) / 1e6)
						}
					}
				case "rtc-answer":
					select {
					case m.answer <- c.SDP:
					default:
					}
				}
			case wire.Cursor:
				cCursorsIn.Add(1)
			case wire.Live:
				cLiveIn.Add(1)
				// Drawers stamp their send time after a marker; see draw().
				if len(p) >= 2+5+16 && p[2] == 1 {
					if i := bytes.Index(p, liveMark); i > 0 && len(p) >= i+len(liveMark)+8 {
						t := int64(binary.LittleEndian.Uint64(p[i+len(liveMark):]))
						drawLat.add(float64(now.UnixNano()-t) / 1e6)
					}
				}
			case wire.BoardEntry:
				cEntriesIn.Add(1)
			}
			return nil
		})
	}
}

func (m *member) voice(ctx context.Context) error {
	pc, err := api.NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		return err
	}
	m.pc = pc
	n := max(1, m.slots)
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", m.name)
	if err != nil {
		return err
	}
	tr, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv})
	if err != nil {
		return err
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := tr.Sender().Read(buf); err != nil {
				return
			}
		}
	}()
	for i := 1; i < n; i++ {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			return err
		}
	}
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		buf := make([]byte, 1500)
		var pkt rtp.Packet
		for {
			k, _, err := t.Read(buf)
			if err != nil {
				return
			}
			now := time.Now().UnixNano()
			cRTPIn.Add(1)
			cRTPBytesIn.Add(uint64(k))
			if pkt.Unmarshal(buf[:k]) == nil && len(pkt.Payload) >= 10 && pkt.Payload[0] == 0xC0 && pkt.Payload[1] == 0x55 {
				sent := int64(binary.LittleEndian.Uint64(pkt.Payload[2:]))
				voiceLat.add(float64(now-sent) / 1e6)
			}
		}
	})
	up := make(chan struct{})
	var upOnce sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			upOnce.Do(func() { close(up) })
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	<-gathered
	m.ctrl(map[string]any{"t": "rtc-offer", "sdp": pc.LocalDescription().SDP})
	select {
	case ans := <-m.answer:
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: ans}); err != nil {
			return err
		}
	case <-time.After(20 * time.Second):
		return fmt.Errorf("no answer")
	case <-ctx.Done():
		return nil
	}
	select {
	case <-up:
		cVoiceUp.Add(1)
	case <-time.After(20 * time.Second):
		return fmt.Errorf("never connected")
	case <-ctx.Done():
		return nil
	}
	if m.talk {
		levelID := 0
		for _, e := range tr.Sender().GetParameters().HeaderExtensions {
			if e.URI == sdp.AudioLevelURI {
				levelID = e.ID
			}
		}
		go m.talkLoop(ctx, track, uint8(levelID))
	}
	return nil
}

// talkLoop sends one packet every 20 ms: a marker, the send time, then filler to *payload bytes.
func (m *member) talkLoop(ctx context.Context, track *webrtc.TrackLocalStaticRTP, levelID uint8) {
	t := time.NewTicker(20 * time.Millisecond)
	defer t.Stop()
	seq := uint16(rand.Uint32())
	ts := rand.Uint32()
	body := make([]byte, max(*payload, 10))
	for i := range body {
		body[i] = byte(rand.Uint32())
	}
	body[0], body[1] = 0xC0, 0x55
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		binary.LittleEndian.PutUint64(body[2:], uint64(time.Now().UnixNano()))
		pkt := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts}, Payload: body}
		if levelID != 0 {
			_ = pkt.SetExtension(levelID, []byte{0x80 | 30}) // voice, -30 dBov
		}
		if err := track.WriteRTP(pkt); err == nil {
			cRTPOut.Add(1)
		}
		seq++
		ts += 960
	}
}

func (m *member) moveCursor(ctx context.Context) {
	t := time.NewTicker(time.Second / 30)
	defer t.Stop()
	x, y := rand.Float64()*1000, rand.Float64()*700
	body := make([]byte, 8)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		x += rand.Float64()*12 - 6
		y += rand.Float64()*12 - 6
		binary.LittleEndian.PutUint32(body, math.Float32bits(float32(x)))
		binary.LittleEndian.PutUint32(body[4:], math.Float32bits(float32(y)))
		m.send(wire.Append(nil, wire.Cursor, body))
	}
}

// chat posts a message every 5 to 15 s, stamped with its send time so listeners can time it through the server.
func (m *member) chat(ctx context.Context) {
	for n := 0; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5*time.Second + time.Duration(rand.Int64N(int64(10*time.Second)))):
		}
		text := fmt.Sprintf("Pushed the fix for the flaky upload test, can someone look at the review before standup? CMCT%d %d", time.Now().UnixNano(), n)
		m.ctrl(map[string]any{"t": "chat-send", "ch": "main", "nonce": fmt.Sprintf("%s-%d", m.name, n), "text": text})
	}
}

// liveMark lets a listener find a drawer's send time inside a stroke-in-progress record. The
// browser ignores bytes past the points it reads.
var liveMark = []byte("CMLT")

func (m *member) draw(ctx context.Context) {
	ref := uint32(1)
	board := ""
	// The board id comes from a boards message; ask for it.
	_ = board
	for k := 0; ; k++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(2000+rand.IntN(2000)) * time.Millisecond):
		}
		key := rand.Uint32()
		t := time.NewTicker(time.Second / 60)
		for f := 0; f < 60; f++ {
			<-t.C
			// kind 1: [key u32][ink u8][size u8][n u16][n × (x f32, y f32, p u8)], 2 points, then the mark.
			b := make([]byte, 0, 64)
			b = append(b, 1)
			b = binary.LittleEndian.AppendUint32(b, key)
			b = append(b, 0, 1)
			b = binary.LittleEndian.AppendUint16(b, 2)
			for j := 0; j < 2; j++ {
				b = binary.LittleEndian.AppendUint32(b, math.Float32bits(float32(f*4+j*2)))
				b = binary.LittleEndian.AppendUint32(b, math.Float32bits(float32(math.Sin(float64(f)/6)*30)))
				b = append(b, 128)
			}
			b = append(b, liveMark...)
			b = binary.LittleEndian.AppendUint64(b, uint64(time.Now().UnixNano()))
			m.send(wire.Append(nil, wire.Live, b))
		}
		t.Stop()
		if len(strokes) > 0 && activeBoard.Load() != nil {
			id := *activeBoard.Load()
			u := strokes[(m.i*31+k)%len(strokes)]
			m.send(wire.Append(nil, wire.BoardUpdate, wire.BoardPrefix(id), wire.U32(ref), u))
			ref++
		}
		end := binary.LittleEndian.AppendUint32([]byte{4}, key)
		m.send(wire.Append(nil, wire.Live, end))
	}
}

var activeBoard atomic.Pointer[string]

// ---------------------------------------------------------------- server stats

type sample struct {
	Proc struct {
		At         time.Time `json:"at"`
		CPUSeconds float64   `json:"cpuSeconds"`
		UserSecs   float64   `json:"userSeconds"`
		SysSecs    float64   `json:"systemSeconds"`
		RSSBytes   int64     `json:"rssBytes"`
		NetRx      uint64    `json:"netRx"`
		NetTx      uint64    `json:"netTx"`
		NetRxPkts  uint64    `json:"netRxPkts"`
		NetTxPkts  uint64    `json:"netTxPkts"`
	} `json:"proc"`
	Conns         int     `json:"conns"`
	InRoom        int     `json:"inRoom"`
	VoicePeers    int     `json:"voicePeers"`
	RTPPacketsOut uint64  `json:"rtpPacketsOut"`
	RTPPacketsIn  uint64  `json:"rtpPacketsIn"`
	WSBytesOut    uint64  `json:"wsBytesOut"`
	WSBytesIn     uint64  `json:"wsBytesIn"`
	Dropped       uint64  `json:"dropped"`
	SendDrops     uint64  `json:"voiceSendDrops"`
	QueueMean     float64 `json:"sendQueueMeanMs"`
	QueueMax      float64 `json:"sendQueueMaxMs"`
	FwdMean       float64 `json:"forwardMeanMs"`
	FwdMax        float64 `json:"forwardMaxMs"`
	Procs         int     `json:"gomaxprocs"`
}

func getStats() (*sample, error) {
	r, err := http.Get(*statsURL)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var s sample
	b, _ := io.ReadAll(r.Body)
	return &s, json.Unmarshal(b, &s)
}

// boardID asks the server which board is up, as a viewer would see in its welcome.
func boardID(ctx context.Context) (string, error) {
	ws, _, err := websocket.Dial(ctx, *wsURL, nil)
	if err != nil {
		return "", err
	}
	defer ws.CloseNow()
	b, _ := json.Marshal(map[string]any{"t": "hello", "v": 2, "name": "load-probe"})
	if err := ws.Write(ctx, websocket.MessageBinary, wire.Append(nil, wire.Ctrl, b)); err != nil {
		return "", err
	}
	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return "", err
		}
		id := ""
		_ = wire.Each(msg, func(typ byte, p []byte) error {
			if typ == wire.Ctrl {
				var c struct {
					T      string `json:"t"`
					Boards struct {
						Active string `json:"active"`
					} `json:"boards"`
				}
				if json.Unmarshal(p, &c) == nil && c.T == "welcome" {
					id = c.Boards.Active
				}
			}
			return nil
		})
		if id != "" {
			return id, nil
		}
	}
}

func main() {
	flag.Parse()
	log.SetFlags(log.Ltime)
	if b, err := os.ReadFile(*fixtures); err == nil {
		for len(b) >= 4 {
			n := int(binary.LittleEndian.Uint32(b))
			if len(b) < 4+n {
				break
			}
			strokes = append(strokes, b[4:4+n])
			b = b[4+n:]
		}
	}
	api = newAPI()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if id, err := boardID(ctx); err == nil {
		activeBoard.Store(&id)
	} else {
		log.Printf("no board id: %v", err)
	}

	var wg sync.WaitGroup
	gap := time.Duration(float64(time.Second) / *ramp)
	start := time.Now()
	for i := 0; i < *members; i++ {
		gi := *first + i
		m := &member{i: gi, name: fmt.Sprintf("Load %03d", gi), talk: gi < *talkers}
		wg.Add(1)
		go m.run(ctx, &wg)
		time.Sleep(gap)
	}
	deadline := time.Now().Add(30 * time.Second)
	for cVoiceUp.Load()+errs.Load() < int64(*members) && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	if !*quiet {
		log.Printf("ramped %d members in %s: %d joined, %d with voice, %d errors", *members, time.Since(start).Round(time.Millisecond), cJoined.Load(), cVoiceUp.Load(), errs.Load())
	}
	time.Sleep(*warm)
	voiceLat.reset()
	drawLat.reset()
	chatLat.reset()

	// Measure.
	var s0, s1 *sample
	var samples []*sample
	if *statsURL != "" {
		s0, _ = getStats()
	}
	r0 := [...]uint64{cRTPIn.Load(), cRTPBytesIn.Load(), cWSIn.Load(), cCursorsIn.Load(), cLiveIn.Load(), cRTPOut.Load(), cWSOut.Load(), cChatIn.Load()}
	t0 := time.Now()
	tick := time.NewTicker(time.Second)
	for time.Since(t0) < *measure {
		<-tick.C
		if *statsURL != "" {
			if s, err := getStats(); err == nil {
				samples = append(samples, s)
			}
		}
	}
	tick.Stop()
	el := time.Since(t0).Seconds()
	if *statsURL != "" {
		s1, _ = getStats()
	}
	r1 := [...]uint64{cRTPIn.Load(), cRTPBytesIn.Load(), cWSIn.Load(), cCursorsIn.Load(), cLiveIn.Load(), cRTPOut.Load(), cWSOut.Load(), cChatIn.Load()}
	per := func(i int) float64 { return float64(r1[i]-r0[i]) / el }

	out := map[string]any{
		"label": *label, "members": *members, "first": *first, "talkers": *talkers, "movers": *movers, "drawers": *drawers, "chatters": *chatters,
		"joined": cJoined.Load(), "voiceUp": cVoiceUp.Load(), "errors": errs.Load(), "seconds": math.Round(el*10) / 10,
		"client": map[string]any{
			"rtpPacketsInPerSec": math.Round(per(0)), "rtpPacketsInPerMemberPerSec": math.Round(per(0)/float64(max(1, *members))*10) / 10,
			"rtpKbpsInPerMember": math.Round(per(1)*8/1000/float64(max(1, *members))*10) / 10,
			"wsKbpsInPerMember":  math.Round(per(2)*8/1000/float64(max(1, *members))*10) / 10,
			"cursorsInPerSec":    math.Round(per(3)), "liveInPerSec": math.Round(per(4)),
			"rtpPacketsOutPerSec": math.Round(per(5)), "wsKbpsOut": math.Round(per(6) * 8 / 1000), "chatInPerSec": math.Round(per(7)),
		},
	}
	vp := voiceLat.pct(0.5, 0.95, 0.99)
	dp := drawLat.pct(0.5, 0.95, 0.99)
	out["voiceThroughServerMs"] = map[string]any{"p50": vp[0], "p95": vp[1], "p99": vp[2]}
	out["drawThroughServerMs"] = map[string]any{"p50": dp[0], "p95": dp[1], "p99": dp[2]}
	cp := chatLat.pct(0.5, 0.95, 0.99)
	out["chatThroughServerMs"] = map[string]any{"p50": cp[0], "p95": cp[1], "p99": cp[2]}
	if s0 != nil && s1 != nil {
		dt := s1.Proc.At.Sub(s0.Proc.At).Seconds()
		var maxRSS int64
		for _, s := range samples {
			maxRSS = max(maxRSS, s.Proc.RSSBytes)
		}
		var qMean, qMax, fMean, fMax float64
		for _, s := range samples {
			qMean += s.QueueMean / float64(len(samples))
			fMean += s.FwdMean / float64(len(samples))
			qMax = max(qMax, s.QueueMax)
			fMax = max(fMax, s.FwdMax)
		}
		cpus := make([]float64, 0, len(samples))
		for i := 1; i < len(samples); i++ {
			d := samples[i].Proc.At.Sub(samples[i-1].Proc.At).Seconds()
			if d > 0 {
				cpus = append(cpus, (samples[i].Proc.CPUSeconds-samples[i-1].Proc.CPUSeconds)/d*100)
			}
		}
		sort.Float64s(cpus)
		peak := 0.0
		if len(cpus) > 0 {
			peak = cpus[len(cpus)-1]
		}
		out["server"] = map[string]any{
			"cpuPercentOfOneCore":  math.Round((s1.Proc.CPUSeconds-s0.Proc.CPUSeconds)/dt*1000) / 10,
			"cpuPercentPeakSecond": math.Round(peak*10) / 10,
			"cpuUserPercent":       math.Round((s1.Proc.UserSecs-s0.Proc.UserSecs)/dt*1000) / 10,
			"cpuSystemPercent":     math.Round((s1.Proc.SysSecs-s0.Proc.SysSecs)/dt*1000) / 10,
			"rssMiB":               math.Round(float64(s1.Proc.RSSBytes)/(1<<20)*10) / 10,
			"rssMiBPeak":           math.Round(float64(maxRSS)/(1<<20)*10) / 10,
			"netInMbps":            math.Round(float64(s1.Proc.NetRx-s0.Proc.NetRx)*8/dt/1e6*100) / 100,
			"netOutMbps":           math.Round(float64(s1.Proc.NetTx-s0.Proc.NetTx)*8/dt/1e6*100) / 100,
			"netInPktsPerSec":      math.Round(float64(s1.Proc.NetRxPkts-s0.Proc.NetRxPkts) / dt),
			"netOutPktsPerSec":     math.Round(float64(s1.Proc.NetTxPkts-s0.Proc.NetTxPkts) / dt),
			"rtpPacketsOutPerSec":  math.Round(float64(s1.RTPPacketsOut-s0.RTPPacketsOut) / dt),
			"wsOutMbps":            math.Round(float64(s1.WSBytesOut-s0.WSBytesOut)*8/dt/1e6*100) / 100,
			"conns":                s1.Conns, "inRoom": s1.InRoom, "voicePeers": s1.VoicePeers, "dropped": s1.Dropped - s0.Dropped,
			"voiceSendDrops": s1.SendDrops - s0.SendDrops,
			"sendQueueMs":    map[string]float64{"mean": math.Round(qMean*100) / 100, "max": qMax},
			"forwardMs":      map[string]float64{"mean": math.Round(fMean*100) / 100, "max": fMax},
			"gomaxprocs":     s1.Procs,
		}
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(strings.TrimSpace(string(b)))
	cancel()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}
