// Command deskctl speaks the desk protocol from the command line, for tests and debugging. There is no
// HTTP surface on a desk to curl.
package main

import (
	"context"
	"crypto/rand"
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
--call '<method> [<JSON params>]' (repeatable) makes more calls on the same session after it, in order, such
as --call 'files.list {"path":""}', each with its own idem key (a UUIDv7, so a mutation is taken): each result or
error is printed, and any error exits 1.
`

// calls is --call, repeatable.
type calls []string

func (c *calls) String() string { return strings.Join(*c, "; ") }

func (c *calls) Set(v string) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("--call needs a method")
	}
	*c = append(*c, v)

	return nil
}

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
	var more calls
	fs.Var(&more, "call", "after desk.status.get: '<method> [<JSON params>]', repeatable")
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
	if err := status(opts, *timeout, *asJSON, more); err != nil {
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

func status(opts client.Options, timeout time.Duration, asJSON bool, more calls) error {
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

	type made struct {
		Method string          `json:"method"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  string          `json:"error,omitempty"`
	}
	var done []made
	failed := 0
	for _, c := range more {
		method, raw, _ := strings.Cut(strings.TrimSpace(c), " ")
		var params any = map[string]any{}
		if strings.TrimSpace(raw) != "" {
			params = json.RawMessage(raw)
		}
		res, err := conn.CallIdem(ctx, method, params, uuid7())
		if err != nil {
			failed++
			done = append(done, made{Method: method, Error: err.Error()})
		} else {
			done = append(done, made{Method: method, Result: res})
		}
	}

	if asJSON {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
			"status": json.RawMessage(result), "rttMs": float64(rtt.Microseconds()) / 1000,
			"setupMs": setup.Milliseconds(), "transport": conn.Transport(), "sessionId": conn.SessionID, "calls": done,
		}); err != nil {
			return err
		}
	} else {
		fmt.Printf("status: %s\n", result)
		fmt.Printf("transport: %s\n", conn.Transport())
		fmt.Printf("setup: %d ms\n", setup.Milliseconds())
		fmt.Printf("rtt: %.2f ms\n", float64(rtt.Microseconds())/1000)
		for _, d := range done {
			if d.Error != "" {
				fmt.Printf("call %s: error: %s\n", d.Method, d.Error)
			} else {
				fmt.Printf("call %s: %s\n", d.Method, d.Result)
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d call(s) failed", failed, len(more))
	}

	return nil
}

// uuid7 is a new UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, the version, 74 random bits and the variant.
func uuid7() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(time.Now().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80

	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
