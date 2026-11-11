// Command desk-rtc is the desk's single WebRTC endpoint: ICE-lite on UDP and TCP 443 (or the port the desk's
// config sets, config.go), and the rtc.sock bridge to deskd. See docs/interfaces/desk-runtime.md and this module's README.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcserver"
)

// version is set by build.sh.
var version = "dev"

func main() {
	var (
		socket  = flag.String("socket", "/run/desk/rtc.sock", "rtc.sock path")
		group   = flag.String("socket-group", "", "group to own rtc.sock (production: desk); empty leaves it alone")
		dataDir = flag.String("data-dir", "/data/rtc", "directory of the DTLS identity")
		bind    = flag.String("bind", "auto", "IPv4 address to bind, or auto for the default route's source address")
		port    = flag.Int("port", 443, "UDP and TCP port; below 1024 needs CAP_NET_BIND_SERVICE, so use a high port in dev. Given here, it wins over --config's")
		conf    = flag.String("config", "", "the desk's settings file (production: /etc/ma/desk-rtc.conf); no file there means the defaults")
		prPort  = flag.Bool("print-port", false, "print the port from --port and --config, and exit (release/health uses it)")
		tcpPort = flag.Int("tcp-port", 0, "the passive ICE-TCP listener's port when it isn't --port's; 0 means --config's tcp_port, else --port. Given here, it wins")
		prTCP   = flag.Bool("print-tcp-port", false, "print the ICE-TCP port from --tcp-port, --port and --config, and exit (release/health uses it)")
		consent = flag.Duration("consent-timeout", 30*time.Second, "close a session whose client has been silent this long")
		stream  = flag.String("stream-socket", "", "Unix socket desk-stream connects to; empty means no video")
		sUser   = flag.String("stream-user", "stream", "the only user allowed on --stream-socket")
		profile = flag.String("profile-file", "", "where desk-egress names the stream's allowance profile (production: /run/desk-egress/profile); empty means none")
		display = flag.String("display", "", "X display to inject input into and hold the clipboard on; empty means input is decoded and dropped, and the clipboard answers no_display")
		noPlay  = flag.Bool("no-playout-delay", false, "leave the playout-delay extension off (for measuring)")
		voice   = flag.String("guild-voice-relay", "", "where a Guild Desk relays Commons' voice ICE from 443, TCP and UDP: a loopback address; empty means "+rtcserver.DefaultVoiceRelayAddr)
		guildN  = flag.Int("guild-max-sessions", 0, "the most sessions a Guild Desk takes at once; 0 means --config's guild_max_sessions, else 600 (maxGuildMembers x 3). Given here, it wins over --config's")
		verbose = flag.Bool("v", false, "debug logging")
		showVer = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *showVer {
		fmt.Println(version)

		return
	}
	dc, err := loadConfig(*conf)
	if err != nil {
		fmt.Fprintf(os.Stderr, "desk-rtc: config: %v\n", err)
		os.Exit(1)
	}
	portGiven, guildGiven, tcpGiven := false, false, false
	flag.Visit(func(f *flag.Flag) {
		portGiven = portGiven || f.Name == "port"
		guildGiven = guildGiven || f.Name == "guild-max-sessions"
		tcpGiven = tcpGiven || f.Name == "tcp-port"
	})
	*port = effectivePort(*port, portGiven, dc)
	if *tcpPort < 0 || *tcpPort > 65535 {
		fmt.Fprintf(os.Stderr, "desk-rtc: --tcp-port %d: want 0 to 65535\n", *tcpPort)
		os.Exit(2)
	}
	*tcpPort = effectiveTCPPort(*tcpPort, tcpGiven, dc, *port)
	if *guildN < 0 || *guildN > maxGuildSessionsSetting {
		fmt.Fprintf(os.Stderr, "desk-rtc: --guild-max-sessions %d: want 0 to %d\n", *guildN, maxGuildSessionsSetting)
		os.Exit(2)
	}
	*guildN = effectiveGuildMaxSessions(*guildN, guildGiven, dc)
	if *prPort {
		fmt.Println(*port)

		return
	}
	if *prTCP {
		fmt.Println(*tcpPort)

		return
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	for _, k := range dc.Unknown {
		log.Warn("config: a setting this version doesn't know, ignored", "file", *conf, "key", k)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	streamUID := -1
	if *stream != "" {
		if streamUID, err = rtcserver.LookupStreamUID(*sUser); err != nil {
			// An older image has no stream user. Sessions and data channels still work.
			log.Warn("no video on this desk", "err", err)
			*stream = ""
		}
	}

	srv, err := rtcserver.New(rtcserver.Config{
		SocketPath:     *socket,
		SocketGroup:    *group,
		DataDir:        *dataDir,
		Bind:           *bind,
		Port:           *port,
		TCPPort:        *tcpPort,
		SharedSlot:     dc.Slot,
		PublicIPv4:     dc.PublicIPv4,
		ConsentTimeout: *consent,
		Version:        version,
		Log:            log,
		StreamSocket:   *stream,
		StreamUID:      streamUID,
		ProfileFile:    *profile,
		Display:        *display,
		NoPlayoutDelay: *noPlay,
		// Only a Guild Desk uses it (configure's deskKind), so every other desk runs exactly as before.
		GuildMaxSessions: *guildN,
		VoiceRelayAddr:   *voice,
	})
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}
	if dc.Slot > 0 {
		log.Info("on a shared desk host", "slot", dc.Slot, "ufragPrefix", rtcserver.SlotUfragPrefix(dc.Slot), "udpPort", *port, "tcpPort", *tcpPort, "candidateIpv4", dc.PublicIPv4)
	}
	log.Info("desk-rtc listening", "version", version, "ice", srv.BindAddr(), "iceTcp", srv.TCPAddr(), "port", *port, "socket", *socket, "fingerprintSha256", srv.Fingerprint())
	if err := srv.Serve(ctx); err != nil {
		log.Error("stopped", "err", err)
		os.Exit(1)
	}
}
