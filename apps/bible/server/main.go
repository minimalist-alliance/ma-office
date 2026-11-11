// bible-app is the Bible app's service on a desk (S-150): the desk app contract's app socket, serving the four
// public-domain translations bundled beside it and the member's marks and prefs in its data folder. It needs no
// network and no permission. The wire is apps/bible/API.md.
//
// What the contract asks (section 1.5), and where:
//   - listen on $MA_APP_SOCKET, let only $MA_DESKD_UID in, answer HELLO at once: run, serve
//   - keep state in $MA_APP_DATA so a kill at any moment leaves the old or the new: internal/store
//   - $MA_APP_CACHE may vanish: nothing is kept there
//   - size the runtime to $MA_APP_MEMORY_MAX: fitLimits
//   - exit cleanly on SIGTERM: main
//   - ignore unknown fields and frame kinds: serve
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"syscall"
	"time"
)

type config struct {
	socket, data string
	texts        string // the translations' folder
	manifest     string // the package's ma-app.json, for the texts' hashes; "" if none
	deskdUID     int
	id, version  string
	helloTimeout time.Duration
	stopTimeout  time.Duration
	summaryEvery time.Duration
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("bible-app: ")
	texts := flag.String("texts", "", "the translations' folder (default: texts/ beside bin/)")
	flag.Parse()

	raiseOOMScore()
	fitLimits()
	cfg, err := configFromEnv(*texts)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx, cfg, nil); err != nil {
		log.Fatal(err)
	}
}

func configFromEnv(texts string) (config, error) {
	cfg := config{
		socket: os.Getenv("MA_APP_SOCKET"), data: os.Getenv("MA_APP_DATA"),
		id: os.Getenv("MA_APP_ID"), version: os.Getenv("MA_APP_VERSION"),
		helloTimeout: 5 * time.Second, stopTimeout: 2 * time.Second, summaryEvery: time.Second,
	}
	if cfg.id == "" {
		cfg.id = "com.minimalistalliance.bible"
	}
	if cfg.socket == "" || cfg.data == "" {
		return cfg, errors.New("MA_APP_SOCKET and MA_APP_DATA must be set: deskd starts apps, not people")
	}
	uid, err := strconv.Atoi(os.Getenv("MA_DESKD_UID"))
	if err != nil || uid < 0 {
		return cfg, errors.New("MA_DESKD_UID must be deskd's uid")
	}
	cfg.deskdUID = uid
	// The package is files/bin/bible-app beside files/texts/, with ma-app.json at the release's root or beside
	// bin/ (deskd's own bundle). os.Executable resolves the current -> releases/<version> link.
	exe, err := os.Executable()
	if err != nil {
		return cfg, err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return cfg, err
	}
	root := filepath.Dir(filepath.Dir(exe))
	cfg.texts = texts
	if cfg.texts == "" {
		cfg.texts = filepath.Join(root, "texts")
	}
	for _, m := range []string{filepath.Join(root, "ma-app.json"), filepath.Join(filepath.Dir(root), "ma-app.json")} {
		if fi, err := os.Stat(m); err == nil && fi.Mode().IsRegular() {
			cfg.manifest = m
			break
		}
	}
	return cfg, nil
}

// raiseOOMScore asks the kernel to kill this app before anything else on the desk, deskd above all, if memory runs
// out. Raising one's own score needs no privilege.
func raiseOOMScore() {
	f, err := os.OpenFile("/proc/self/oom_score_adj", os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString("1000")
}

// fitLimits sizes Go's runtime to the box deskd puts the app in: a soft heap limit at 70% of the memory cap (the
// unit's MemoryHigh is 80%, and the mapped texts are page cache on top), a heap that grows by half its live size
// before a collection rather than doubling (the app allocates little, so the extra collections cost next to nothing),
// and one thread per vCPU it may use.
func fitLimits() {
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(50)
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		if v, err := strconv.ParseInt(os.Getenv("MA_APP_MEMORY_MAX"), 10, 64); err == nil && v > 0 {
			debug.SetMemoryLimit(v * 7 / 10)
		}
	}
	if v, err := strconv.ParseFloat(os.Getenv("MA_APP_CPU_MAX"), 64); err == nil && v > 0 && os.Getenv("GOMAXPROCS") == "" {
		runtime.GOMAXPROCS(int(math.Max(1, math.Ceil(v))))
	}
}
