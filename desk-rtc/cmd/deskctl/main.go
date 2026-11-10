// Command deskctl speaks the desk protocol from the command line, for tests and debugging. There is no
// HTTP surface on a desk to curl.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/client"
)

const usage = `deskctl status --gateway <ws url> [flags]

Opens a desk session the way the Desk app does (connect, session.open, offer, DTLS, HELLO), calls
desk.status.get, prints the result and the round-trip time, and exits non-zero on any failure.
`

func main() {
	if len(os.Args) < 2 || os.Args[1] != "status" {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	gateway := fs.String("gateway", "", "gateway WebSocket URL, such as ws://127.0.0.1:8787/v1")
	api := fs.String("api", "", "api. base URL; defaults to the gateway's host")
	desk := fs.String("desk", "d-dev0000000000", "desk ID")
	bearer := fs.String("bearer", "", "Cognito access token for a real api.; the shim ignores it")
	transport := fs.String("transport", "any", "any, udp or tcp")
	timeout := fs.Duration("timeout", 20*time.Second, "give up after this long")
	asJSON := fs.Bool("json", false, "print one JSON object")
	badCnf := fs.Bool("bad-cnf", false, "test: ask for a token bound to another certificate; the desk must refuse")
	verbose := fs.Bool("v", false, "log each step")
	guild := fs.String("guild", "", "open a Guild Desk as a member of this guild (gateway-shim --desk-kind guild)")
	member := fs.String("member", "", "with --guild: the member, which only gateway-shim takes")
	_ = fs.Parse(os.Args[2:])

	if *gateway == "" {
		fmt.Fprintln(os.Stderr, "deskctl: --gateway is required")
		os.Exit(2)
	}
	apiBase := *api
	if apiBase == "" {
		var err error
		if apiBase, err = apiFromGateway(*gateway); err != nil {
			fmt.Fprintln(os.Stderr, "deskctl:", err)
			os.Exit(2)
		}
	}
	opts := client.Options{
		API: apiBase, Gateway: *gateway, DeskID: *desk, Bearer: *bearer, Transport: *transport, BadCnf: *badCnf,
		GuildID: *guild, MemberID: *member,
	}
	if *verbose {
		opts.Log = func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
	}
	if err := status(opts, *timeout, *asJSON); err != nil {
		fmt.Fprintln(os.Stderr, "deskctl: status failed:", err)
		os.Exit(1)
	}
}

func apiFromGateway(gateway string) (string, error) {
	u, err := url.Parse(gateway)
	if err != nil {
		return "", fmt.Errorf("--gateway: %w", err)
	}
	scheme := "http"
	if strings.EqualFold(u.Scheme, "wss") {
		scheme = "https"
	}

	return scheme + "://" + u.Host, nil
}

func status(opts client.Options, timeout time.Duration, asJSON bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	start := time.Now()
	conn, err := client.Dial(ctx, opts)
	if err != nil {
		return err
	}
	defer conn.CloseSession()
	setup := time.Since(start)

	callStart := time.Now()
	result, err := conn.Call(ctx, "desk.status.get", nil)
	if err != nil {
		return err
	}
	rtt := time.Since(callStart)

	if asJSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{
			"status": json.RawMessage(result), "rttMs": float64(rtt.Microseconds()) / 1000,
			"setupMs": setup.Milliseconds(), "transport": conn.Transport(), "sessionId": conn.SessionID,
		})
	}
	fmt.Printf("status: %s\n", result)
	fmt.Printf("transport: %s\n", conn.Transport())
	fmt.Printf("setup: %d ms\n", setup.Milliseconds())
	fmt.Printf("rtt: %.2f ms\n", float64(rtt.Microseconds())/1000)

	return nil
}
