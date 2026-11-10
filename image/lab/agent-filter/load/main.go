// load is ADR 0070's measuring tool, outside any bake: a stand-in provider, and the clients that measure the filter on it.
//
//	load serve -addr :443                                     TLS, self-signed: /ttfb, /sse, /bytes, /sink
//	load ttfb -url https://name/ttfb -n 300 [-gap 100ms] [-raw file]   a new connection per request: lookup to first byte, p50 and p95
//	load streams -url 'https://name/sse?hz=60&size=150' -c 20 -for 60s
//	load bulk -url https://name/bytes?n=500000000             how fast one GET comes down
//	load bulk -url https://name/sink -up 500000000            how fast one POST goes up
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("load serve | ttfb | streams | bulk")
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	addr := fs.String("addr", ":443", "serve: listen address")
	url := fs.String("url", "", "the URL")
	n := fs.Int("n", 100, "ttfb: samples")
	gap := fs.Duration("gap", 100*time.Millisecond, "ttfb: pause between samples")
	c := fs.Int("c", 20, "streams: how many")
	dur := fs.Duration("for", 60*time.Second, "streams: how long")
	up := fs.Int64("up", 0, "bulk: bytes to POST")
	verify := fs.Bool("verify", false, "check the server's certificate")
	raw := fs.String("raw", "", "ttfb: append each sample, in ms, to this file")
	fs.Parse(os.Args[2:])
	client := func() *http.Client {
		return &http.Client{Transport: &http.Transport{
			DisableKeepAlives: true, ForceAttemptHTTP2: false, TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{},
			TLSClientConfig: &tls.Config{InsecureSkipVerify: !*verify},
			DialContext:     (&net.Dialer{Resolver: &net.Resolver{PreferGo: true}}).DialContext,
		}}
	}
	switch os.Args[1] {
	case "serve":
		serve(*addr)
	case "ttfb":
		ttfb(client(), *url, *n, *gap, *raw)
	case "streams":
		streams(client(), *url, *c, *dur)
	case "bulk":
		bulk(client(), *url, *up)
	}
}

func serve(addr string) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "stand-in"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(72 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ttfb", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	mux.HandleFunc("/sse", func(w http.ResponseWriter, r *http.Request) { // hz events a second of size bytes, for as long as the client stays
		hz, _ := strconv.Atoi(r.URL.Query().Get("hz"))
		size, _ := strconv.Atoi(r.URL.Query().Get("size"))
		event := append(append([]byte("data: "), make([]byte, size)...), "\n\n"...)
		for i := 6; i < 6+size; i++ {
			event[i] = 'x'
		}
		w.Header().Set("Content-Type", "text/event-stream")
		t := time.NewTicker(time.Second / time.Duration(hz))
		defer t.Stop()
		f := w.(http.Flusher)
		for {
			select {
			case <-r.Context().Done():
				return
			case <-t.C:
				if _, err := w.Write(event); err != nil {
					return
				}
				f.Flush()
			}
		}
	})
	mux.HandleFunc("/bytes", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.ParseInt(r.URL.Query().Get("n"), 10, 64)
		buf := make([]byte, 256<<10)
		for n > 0 {
			m := min(n, int64(len(buf)))
			if _, err := w.Write(buf[:m]); err != nil {
				return
			}
			n -= m
		}
	})
	mux.HandleFunc("/sink", func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		fmt.Fprintln(w, n)
	})
	s := &http.Server{Addr: addr, Handler: mux, TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}}
	log.Fatal(s.ListenAndServeTLS("", ""))
}

func ttfb(c *http.Client, url string, n int, gap time.Duration, raw string) {
	var samples []time.Duration
	failed := 0
	for i := 0; i < n; i++ {
		start := time.Now()
		resp, err := c.Get(url)
		if err != nil {
			failed++
			continue
		}
		samples = append(samples, time.Since(start)) // c.Get returns on the first bytes of the response
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		time.Sleep(gap)
	}
	if raw != "" {
		f, err := os.OpenFile(raw, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		for _, d := range samples {
			fmt.Fprintf(f, "%.3f\n", float64(d.Microseconds())/1000)
		}
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	if len(samples) == 0 {
		fmt.Printf("n=0 failed=%d\n", failed)
		return
	}
	at := func(p float64) float64 { return float64(samples[int(p*float64(len(samples)-1))].Microseconds()) / 1000 }
	fmt.Printf("n=%d failed=%d p50=%.2fms p95=%.2fms min=%.2fms max=%.2fms\n", len(samples), failed, at(.5), at(.95), at(0), at(1))
}

func streams(c *http.Client, url string, count int, dur time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), dur)
	defer cancel()
	var wg sync.WaitGroup
	var bytes atomic.Int64
	var open, failed atomic.Int32
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
			resp, err := c.Do(req)
			if err != nil {
				failed.Add(1)
				return
			}
			defer resp.Body.Close()
			open.Add(1)
			buf := make([]byte, 4096)
			for {
				n, err := resp.Body.Read(buf)
				bytes.Add(int64(n))
				if err != nil {
					return
				}
			}
		}()
	}
	wg.Wait()
	fmt.Printf("streams=%d failed=%d bytes=%d over %v\n", open.Load(), failed.Load(), bytes.Load(), dur)
}

func bulk(c *http.Client, url string, up int64) {
	start := time.Now()
	var resp *http.Response
	var err error
	if up > 0 {
		resp, err = c.Post(url, "application/octet-stream", io.LimitReader(zero{}, up))
	} else {
		resp, err = c.Get(url)
	}
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	n, err := io.Copy(io.Discard, resp.Body)
	if up > 0 {
		n = up
	}
	secs := time.Since(start).Seconds()
	fmt.Printf("%d bytes in %.1f s, %.0f Mbit/s, err=%v\n", n, secs, float64(n)*8/secs/1e6, err)
}

type zero struct{}

func (zero) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
