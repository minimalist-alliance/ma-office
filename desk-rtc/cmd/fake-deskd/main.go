// Command fake-deskd is a stand-in for deskd, for tests only.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/fakedeskd"
)

func main() {
	var cfg fakedeskd.Config
	flag.StringVar(&cfg.RTCSock, "rtc-sock", "/run/desk/rtc.sock", "rtc.sock path")
	flag.StringVar(&cfg.API, "api", "http://127.0.0.1:8787", "the api. base URL (gateway-shim)")
	flag.StringVar(&cfg.PublicIP, "public-ip", "127.0.0.1", "the public IPv4 to pass in configure")
	flag.StringVar(&cfg.DeskKind, "desk-kind", "", "guild plays a Guild Desk's deskd (with gateway-shim --desk-kind guild); empty is a member's own desk")
	flag.Parse()
	cfg.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := fakedeskd.New(cfg).Run(ctx); err != nil {
		cfg.Log.Error("stopped", "err", err)
		os.Exit(1)
	}
}
