// Command ma-move moves a member's cloud desk onto their own self-hosted desk. It runs as root on
// the self-hosted desk and reaches the cloud desk only through its deskd, with an export-only token
// (docs/decisions/draft-data-export-and-transfer.md, section 9; tools/desk-move/README.md).
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/client"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/move"
)

const usage = `Usage: sudo ma-move [flags]

Moves your cloud desk onto this self-hosted desk: every file, checked, then swapped in. Install the
self-hosted desk first, then make a move code in your office (Download your data, then "Move a desk
to your own computer"); this asks for it.

Flags:
`

func main() { os.Exit(run()) }

func run() int {
	fs := flag.NewFlagSet("ma-move", flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		fs.PrintDefaults()
	}
	api := fs.String("api", "", "the Minimalist Alliance API (default: the one this desk was paired with, "+move.ProdAPI+" or "+move.StagingAPI+")")
	staging := fs.Bool("staging", false, "use the staging API ("+move.StagingAPI+")")
	target := fs.String("target-desk", "", "this desk's ID; read from /data/selfhost/desk.json, so only needed to double-check it")
	dataRoot := fs.String("data-root", "/data", "this desk's data volume")
	dryRun := fs.Bool("dry-run", false, "use the code and list what would move; change nothing")
	codeFile := fs.String("code-file", "", "read the move code from this file instead of asking (for tests)")
	transport := fs.String("transport", "any", "any, udp or tcp")
	verbose := fs.Bool("v", false, "say what it's doing")
	version := fs.Bool("version", false, "print the version")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return move.ExitUsage
	}
	if *version {
		fmt.Println("ma-move", move.Version)

		return move.ExitDone
	}
	if fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "ma-move: the move code is never taken on the command line, so it stays out of your shell's history. Run it without arguments and type the code when asked.")

		return move.ExitUsage
	}
	if os.Geteuid() != 0 && *dataRoot == "/data" {
		fmt.Fprintln(os.Stderr, "ma-move: run it as root: sudo ma-move")

		return move.ExitUsage
	}
	local, err := move.ResolveTarget(*dataRoot, *target)
	if err != nil {
		fmt.Println(err)
		var r *move.Refusal
		if errors.As(err, &r) {
			return move.ExitRefused
		}

		return move.ExitFailed
	}
	base := move.APIBase(*api, *staging, local.Env)

	logf := func(string, ...any) {}
	if *verbose {
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, time.Now().Format("15:04:05 ")+format+"\n", args...)
		}
	}
	cert, err := client.NewCertificate()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ma-move:", err)

		return move.ExitFailed
	}
	sd := move.Systemctl{}
	env := move.Env{
		DataRoot:        *dataRoot,
		API:             &move.HTTPAPI{Base: base},
		Dial:            move.PionDial(cert, *transport, logf),
		Systemd:         sd,
		Chown:           os.Lchown,
		FreeBytes:       move.FreeBytes,
		ChromiumVersion: move.ChromiumVersion,
		BrowserLaunch:   move.BrowserLaunch(sd),
		LocalCookies:    move.LocalCookies,
		SignClaim:       move.DeskSigner(*dataRoot, local.Env, time.Now),
		Out:             os.Stdout,
		Progress:        os.Stderr,
		Log:             logf,
	}
	if on, err := testEnv(&env, *dataRoot); err != nil {
		fmt.Fprintln(os.Stderr, "ma-move:", err)

		return move.ExitUsage
	} else if on {
		fmt.Fprintln(os.Stderr, "ma-move: "+testSwitch+"=1: a rehearsal on "+*dataRoot+", with systemctl and chown stood in for")
	}
	logf("this desk is %s; API %s", local.DeskID, base)
	opts := move.Options{TargetDesk: local.DeskID, DryRun: *dryRun, Code: func() (string, error) { return readCode(*codeFile) }}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return move.Run(ctx, env, opts)
}

// readCode asks for the move code on the terminal, or reads --code-file.
func readCode(file string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}

		return strings.TrimSpace(string(b)), nil
	}
	in := io.Reader(os.Stdin)
	out := io.Writer(os.Stderr)
	if tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0); err == nil {
		defer tty.Close()
		in, out = tty, tty
	}
	fmt.Fprint(out, "Move code from your office (like ABCD-EFGH-JKMN): ")
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && line != "") {
		return "", err
	}

	return strings.TrimSpace(line), nil
}
