// commons-server is Commons' service on a guild desk: the room link (from deskd's relay socket), boards, chat and the
// voice SFU, in one process. With -dev it's also the stand-in guild server for running
// locally: a WebSocket room link with names from the URL, the built page, and a stand-in for deskd's relay.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/relay"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/room"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/stats"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/voice"
)

// CSP is the Desk harness's default policy (web/harness/serve.mjs), as the Notebook demo uses.
//
// img-src also names Platform's API origin (COMMONS_AVATAR_ORIGIN, such as https://api.example.test) when set, for the
// members' checked profile pictures (acct-picture), and nothing else.
const cspFmt = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:%s; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'"

var avatarOrigin = regexp.MustCompile(`^https://[a-z0-9.-]{1,253}$`)

// csp is the policy with the avatar origin if it is a bare https origin.
func csp() string {
	o := os.Getenv("COMMONS_AVATAR_ORIGIN")
	if !avatarOrigin.MatchString(o) {
		o = ""
	} else {
		o = " " + o
	}
	return fmt.Sprintf(cspFmt, o)
}

func main() {
	dev := flag.Bool("dev", false, "development: the WebSocket room link with names from the URL (?name=), the page (-web) and a stand-in for deskd's relay (/dev/channel). Never on a guild desk")
	addr := flag.String("addr", "127.0.0.1:8790", "HTTP address: /healthz and /stats; with -dev also the room link and the page. Empty for none")
	relaySocket := flag.String("relay-socket", envOr("COMMONS_RELAY_SOCKET", ""), "deskd's relay socket (default /run/desk-commons/commons.sock; with -dev, commons.sock in -data)")
	relayUID := flag.Int("relay-uid", -1, "the one uid the relay socket accepts, by SO_PEERCRED (default deskd's, 1100; with -dev, this process's)")
	roomID := flag.String("room", "commons", "the guild's room")
	ceiling := flag.Int("max-channels", envInt("COMMONS_MAX_CHANNELS", room.DefaultMaxChannels), "the roster's maxCommonsChannels: the most channels the guild may set")
	iceRelay := flag.String("ice-relay", envOr("COMMONS_ICE_RELAY", ""), "where desk-rtc relays voice ICE from the guild desk's port 443, UDP and ICE-TCP, such as 127.0.0.1:8799 (empty: off)")
	iceRelayPort := flag.Int("ice-relay-port", envInt("COMMONS_ICE_RELAY_PORT", 443), "the public port desk-rtc takes that ICE on: answers name it, UDP and TCP, for -advertise")
	udp := flag.String("udp", "127.0.0.1:8791", "UDP address for voice")
	advertise := flag.String("advertise", envOr("COMMONS_ADVERTISE", ""), "the IP members reach the UDP port on, if not -udp's")
	data := flag.String("data", envOr("MA_APP_DATA", "data"), "where boards are kept ($MA_APP_DATA under the desk app contract)")
	web := flag.String("web", "", "the built page to serve (apps/commons/web/dist); empty serves none")
	slots := flag.Int("slots", 10, "voices a member hears at once")
	batch := flag.Bool("batch", true, "send voice with sendmmsg, many packets per system call")
	noDTX := flag.Bool("no-dtx", false, "don't offer Opus DTX (for comparison)")
	sockets := flag.Int("udp-sockets", 0, "spread members over this many UDP ports, from -udp's port up (0: one per core, at most 8)")
	policeKbps := flag.Int("police-kbps", envInt("COMMONS_POLICE_KBPS", voice.DefaultPoliceKbps), "most kbit/s of RTP a talker may send before packets are dropped (negative: no policing)")
	policePPS := flag.Int("police-pps", envInt("COMMONS_POLICE_PPS", voice.DefaultPolicePPS), "most RTP packets a second a talker may send")
	policeMax := flag.Int("police-max-bytes", envInt("COMMONS_POLICE_MAX_BYTES", voice.DefaultPoliceMaxBytes), "biggest RTP packet forwarded, header included")
	policeSecs := flag.Int("police-abuse-secs", envInt("COMMONS_POLICE_ABUSE_SECS", voice.DefaultPoliceAbuse), "seconds in a row over the limits before a talker's voice connection is closed")
	statsOn := flag.Bool("stats", true, "serve /stats (process CPU, memory, network) for the load test")
	cpuProfile := flag.String("cpuprofile", "", "write a CPU profile here (load test only)")
	profileAfter := flag.Duration("cpuprofile-after", 30*time.Second, "start the CPU profile this long after start")
	profileFor := flag.Duration("cpuprofile-for", 15*time.Second, "how long the CPU profile runs")
	flag.Parse()
	if *relayUID < 0 {
		*relayUID = relay.DeskdUID
		if *dev {
			*relayUID = os.Getuid()
		}
	}
	if *relaySocket == "" {
		*relaySocket = "/run/desk-commons/commons.sock"
		if *dev {
			*relaySocket = filepath.Join(*data, "commons.sock")
		}
	}
	// Under the desk app contract (task 18) the desk says how much memory the app has.
	if mib, err := strconv.Atoi(os.Getenv("MA_APP_MEMORY_MAX")); err == nil && mib > 0 {
		debug.SetMemoryLimit(int64(mib) << 20 * 9 / 10)
	}
	if *cpuProfile != "" {
		go profile(*cpuProfile, *profileAfter, *profileFor)
	}

	opts := room.Options{Ceiling: *ceiling}
	ua, err := net.ResolveUDPAddr("udp4", *udp)
	if err != nil {
		log.Fatal(err)
	}
	srv := room.New(*data, opts)
	if *iceRelay != "" && !strings.HasPrefix(*iceRelay, "127.") {
		log.Fatal("-ice-relay must be a loopback address: only desk-rtc on this machine relays to it")
	}
	sfu, err := voice.New(voice.Config{UDP: ua, Advertise: *advertise, Slots: *slots, Batch: *batch, Sockets: *sockets, NoDTX: *noDTX,
		Police:   voice.Police{Kbps: *policeKbps, PPS: *policePPS, MaxBytes: *policeMax, AbuseSecs: *policeSecs},
		RelayUDP: *iceRelay, RelayTCP: *iceRelay, RelayPort: *iceRelayPort}, srv.VoiceEvents())
	if err != nil {
		log.Fatal(err)
	}
	srv.SetSFU(sfu)
	if _, err := srv.Room(*roomID); err != nil {
		log.Fatal(err)
	}
	ln, err := relay.Listen(*relaySocket, *relayUID)
	if err != nil {
		log.Fatalf("relay socket: %v", err)
	}
	go func() {
		if err := srv.ServeRelay(ln, *roomID); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("relay: %v", err)
		}
	}()

	mux := http.NewServeMux()
	if *dev {
		mux.HandleFunc("/ws", srv.ServeWS)
		mux.HandleFunc("/dev/channel", devChannel(ln.Path()))
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	if *statsOn {
		mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
			st := srv.Stats()
			c := &sfu.C
			qMean, qMax := sfu.QueueStats()
			fMean, fMax := sfu.ForwardStats()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"proc": stats.Sample(), "rooms": st.Rooms, "conns": st.Conns, "inRoom": st.InRoom, "muted": st.Muted,
				"voicePeers": sfu.Peers(), "rtpPacketsIn": c.PacketsIn.Load(), "rtpBytesIn": c.BytesIn.Load(),
				"policedPackets": c.PolicedPackets.Load(), "policedBytes": c.PolicedBytes.Load(), "policedCloses": c.PolicedCloses.Load(),
				"rtpPacketsOut": c.PacketsOut.Load(), "rtpBytesOut": c.BytesOut.Load(),
				"channels":  st.Channels,
				"wsBytesIn": room.WSBytesIn.Load(), "wsBytesOut": room.WSBytesOut.Load(), "wsMsgsOut": room.WSMsgsOut.Load(),
				"dropped": room.Dropped.Load(), "voiceSendDrops": sfu.SendDrops(), "relayRefused": voice.GateRefused.Load(), "boardPaced": room.BoardPaced.Load(),
				"sendQueueMeanMs": qMean, "sendQueueMaxMs": qMax, "forwardMeanMs": fMean, "forwardMaxMs": fMax,
				"gomaxprocs": runtime.GOMAXPROCS(0),
			})
		})
	}
	if *web != "" && *dev {
		mux.Handle("/", page(*web))
	}

	hs := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	var hl net.Listener
	if *addr != "" {
		if hl, err = net.Listen("tcp", *addr); err != nil {
			log.Fatal(err)
		}
	}
	mode := "relay"
	if *dev {
		mode = "dev"
	}
	log.Printf("commons-server (%s) on %s (http %v; voice on udp %s, %d ports from there, %d slots; data in %s)", mode, ln.Path(), addrOf(hl), *udp, sfu.Sockets(), sfu.Slots(), *data)

	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		n := 0
		for {
			select {
			case <-stop:
				return
			case <-t.C:
			}
			n++
			srv.Flush(n%5 == 0)
		}
	}()

	done := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		close(stop)
		ln.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		hs.Shutdown(ctx)
		close(done)
	}()
	if hl != nil {
		if err := hs.Serve(hl); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Print(err)
		}
	}
	<-done
	sfu.Close()
	srv.Close()
	log.Print("commons-server stopped; boards and chat flushed")
}

func addrOf(l net.Listener) string {
	if l == nil {
		return "off"
	}
	return "http://" + l.Addr().String()
}

func envInt(k string, d int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return d
}

// page serves the built Commons page with the Desk harness's CSP, and index.html for any path.
func page(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp())
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		p := filepath.Clean(r.URL.Path)
		if strings.HasPrefix(p, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil || p == "/" {
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
}

// profile writes one CPU profile, for finding where a load test's time goes.
func profile(path string, after, length time.Duration) {
	time.Sleep(after)
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	f, err := os.Create(path)
	if err != nil {
		log.Printf("cpuprofile: %v", err)
		return
	}
	defer f.Close()
	if err := pprof.StartCPUProfile(f); err != nil {
		log.Printf("cpuprofile: %v", err)
		return
	}
	time.Sleep(length)
	pprof.StopCPUProfile()
	log.Printf("cpuprofile: wrote %s", path)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
