// Command gateway-shim is a DEV-ONLY stand-in for gw. and a few api. routes. Not for production.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/shim"
)

func main() {
	var cfg shim.Config
	var origins string
	flag.StringVar(&cfg.Addr, "addr", "127.0.0.1:8787", "listen address")
	flag.BoolVar(&cfg.AllowNonLoopback, "allow-non-loopback", false, "allow binding a non-loopback address; anyone who can reach it gets tokens")
	flag.StringVar(&cfg.DeskID, "desk-id", "d-dev0000000000", "the one desk this shim serves")
	flag.StringVar(&cfg.OwnerID, "owner-id", "00000000-0000-4000-8000-000000000001", "the desk owner's user ID (ma_owner)")
	flag.StringVar(&cfg.OwnerName, "owner-name", "Dev User", "ma_name")
	flag.StringVar(&cfg.Issuer, "issuer", "https://api.dev.invalid", "token iss")
	flag.StringVar(&origins, "origins", "", "comma-separated Origins allowed on client connections; empty allows any")
	flag.DurationVar(&cfg.MaxConnAge, "max-conn-age", 2*time.Hour, "close connections with 1001 at this age")
	flag.DurationVar(&cfg.IdleTimeout, "idle-timeout", 10*time.Minute, "drop connections silent this long")
	flag.DurationVar(&cfg.ResumeHold, "resume-hold", 60*time.Second, "how long a gone client's sessions wait for session.resume")
	flag.IntVar(&cfg.MaxSessions, "max-sessions", 0, "open client sessions per desk; 0 means 4, or --max-guild-members x 3 on a Guild Desk")
	flag.StringVar(&cfg.DeskKind, "desk-kind", "", "guild serves a Guild Desk: members' ma-guild+jwt tokens from POST /v1/guilds/{guild-id}/desk/token; empty is a member's own desk")
	flag.StringVar(&cfg.GuildID, "guild-id", "g-dev000000000", "the guild, with --desk-kind guild (ma_gid)")
	flag.IntVar(&cfg.MaxGuildMembers, "max-guild-members", 200, "with --desk-kind guild: the guild's size cap")
	flag.Parse()
	if origins != "" {
		cfg.AllowedOrigins = strings.Split(origins, ",")
	}
	cfg.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	s, err := shim.New(cfg)
	if err != nil {
		cfg.Log.Error("startup failed", "err", err)
		os.Exit(1)
	}
	if err := s.Run(ctx); err != nil {
		cfg.Log.Error("stopped", "err", err)
		os.Exit(1)
	}
}
