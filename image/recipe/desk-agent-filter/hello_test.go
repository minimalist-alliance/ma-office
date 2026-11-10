package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

// A ClientHello, field by field, so a test can break any one of them.
type helloSpec struct {
	version     uint16
	session     []byte
	suites      []byte
	compression []byte
	extensions  []ext // nil: the extensions block is left out altogether
	noExtBlock  bool
	trailing    []byte
}

type ext struct {
	kind uint16
	body []byte
}

func sniBody(names ...string) []byte {
	var list []byte
	for _, n := range names {
		list = append(list, sniHostName)
		list = binary.BigEndian.AppendUint16(list, uint16(len(n)))
		list = append(list, n...)
	}
	return append(binary.BigEndian.AppendUint16(nil, uint16(len(list))), list...)
}

func defaultSpec(name string) helloSpec {
	return helloSpec{
		version: 0x0303, session: bytes.Repeat([]byte{7}, 32), suites: []byte{0x13, 0x01, 0x13, 0x02}, compression: []byte{0},
		extensions: []ext{{0x000a, []byte{0, 2, 0, 29}}, {extServerName, sniBody(name)}, {0x002b, []byte{2, 3, 4}}},
	}
}

func (h helloSpec) message() []byte {
	var b []byte
	b = binary.BigEndian.AppendUint16(b, h.version)
	b = append(b, bytes.Repeat([]byte{9}, 32)...)
	b = append(b, byte(len(h.session)))
	b = append(b, h.session...)
	b = binary.BigEndian.AppendUint16(b, uint16(len(h.suites)))
	b = append(b, h.suites...)
	b = append(b, byte(len(h.compression)))
	b = append(b, h.compression...)
	if !h.noExtBlock {
		var e []byte
		for _, x := range h.extensions {
			e = binary.BigEndian.AppendUint16(e, x.kind)
			e = binary.BigEndian.AppendUint16(e, uint16(len(x.body)))
			e = append(e, x.body...)
		}
		b = binary.BigEndian.AppendUint16(b, uint16(len(e)))
		b = append(b, e...)
	}
	b = append(b, h.trailing...)
	msg := []byte{handshakeClientHello, byte(len(b) >> 16), byte(len(b) >> 8), byte(len(b))}
	return append(msg, b...)
}

func record(fragment []byte) []byte {
	r := []byte{recordHandshake, 3, 1, byte(len(fragment) >> 8), byte(len(fragment))}
	return append(r, fragment...)
}

func records(msg []byte, size int) []byte {
	var out []byte
	for len(msg) > 0 {
		n := min(size, len(msg))
		out = append(out, record(msg[:n])...)
		msg = msg[n:]
	}
	return out
}

func nameOf(t *testing.T, raw []byte) (string, error) {
	t.Helper()
	msg, err := helloMessage(raw)
	if err != nil {
		return "", err
	}
	return parseClientHello(msg)
}

func TestHelloName(t *testing.T) {
	raw := record(defaultSpec("api.openai.com").message())
	got, err := nameOf(t, raw)
	if err != nil || got != "api.openai.com" {
		t.Fatalf("got %q, %v", got, err)
	}
	got, err = nameOf(t, record(defaultSpec("API.OpenAI.COM").message()))
	if err != nil || got != "api.openai.com" {
		t.Fatalf("mixed case: got %q, %v", got, err)
	}
}

// What real clients send, from Go's TLS stack: TLS 1.2 and 1.3, with session tickets and a big post-quantum key share.
func TestHelloFromRealClient(t *testing.T) {
	for _, cfg := range []*tls.Config{
		{ServerName: "api.x.ai"},
		{ServerName: "api.x.ai", MaxVersion: tls.VersionTLS12},
		{ServerName: "api.x.ai", CurvePreferences: []tls.CurveID{tls.X25519MLKEM768, tls.X25519}},
	} {
		raw := captureHello(t, cfg)
		got, err := nameOf(t, raw)
		if err != nil || got != "api.x.ai" {
			t.Errorf("%+v: got %q, %v", cfg.CurvePreferences, got, err)
		}
	}
	if _, err := nameOf(t, captureHello(t, &tls.Config{InsecureSkipVerify: true})); !errors.Is(err, errNoSNI) {
		t.Errorf("a client with no server name: %v", err)
	}
}

func captureHello(t *testing.T, cfg *tls.Config) []byte {
	t.Helper()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go tls.Client(a, cfg).Handshake()
	var raw []byte
	buf := make([]byte, 16<<10)
	b.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		n, err := b.Read(buf)
		raw = append(raw, buf[:n]...)
		if _, perr := helloMessage(raw); perr == nil {
			return raw
		} else if !errors.Is(perr, errNeedMore) || err != nil {
			t.Fatalf("captured hello: %v, %v", perr, err)
		}
	}
}

func TestHelloSplitAcrossRecords(t *testing.T) {
	msg := defaultSpec("api.anthropic.com").message()
	for _, size := range []int{1, 2, 3, 4, 5, 17, 100} {
		got, err := nameOf(t, records(msg, size))
		if err != nil || got != "api.anthropic.com" {
			t.Errorf("records of %d: got %q, %v", size, got, err)
		}
	}
}

// Every proper prefix of a good hello is "not yet", and never a name.
func TestHelloEveryPrefixIsIncomplete(t *testing.T) {
	for _, raw := range [][]byte{record(defaultSpec("api.x.ai").message()), records(defaultSpec("api.x.ai").message(), 7)} {
		for i := 0; i < len(raw); i++ {
			if _, err := helloMessage(raw[:i]); !errors.Is(err, errNeedMore) {
				t.Fatalf("prefix of %d of %d: %v", i, len(raw), err)
			}
		}
		if _, err := helloMessage(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHelloRefused(t *testing.T) {
	spec := func(f func(*helloSpec)) []byte {
		h := defaultSpec("api.x.ai")
		f(&h)
		return record(h.message())
	}
	good := defaultSpec("api.x.ai").message()
	cases := []struct {
		name string
		raw  []byte
		want error
	}{
		{"http", []byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), errMalformed},
		{"application data record", append([]byte{23, 3, 3, 0, 1}, 0), errMalformed},
		{"SSLv2", []byte{0x80, 0x2e, 1, 0, 2}, errMalformed},
		{"record version 2", append([]byte{recordHandshake, 2, 0, 0, 5}, good[:5]...), errMalformed},
		{"empty record", []byte{recordHandshake, 3, 1, 0, 0}, errMalformed},
		{"record over 2^14", []byte{recordHandshake, 3, 1, 0x40, 1}, errMalformed},
		{"not a ClientHello", record(append([]byte{2}, good[1:]...)), errMalformed},
		{"second record's type is wrong", append(record(good[:10]), append([]byte{23, 3, 3, 0, 1}, good[10])...), errMalformed},
		{"extra handshake bytes in the last record", record(append(append([]byte{}, good...), 1, 0, 0, 0)), errMalformed},
		{"hello longer than the limit", record([]byte{1, 0, 0x40, 0x01, 0}), errTooLong},
		{"old version", spec(func(h *helloSpec) { h.version = 0x0300 }), errMalformed},
		{"future version", spec(func(h *helloSpec) { h.version = 0x0304 }), errMalformed},
		{"session ID over 32", spec(func(h *helloSpec) { h.session = make([]byte, 33) }), errMalformed},
		{"no cipher suites", spec(func(h *helloSpec) { h.suites = nil }), errMalformed},
		{"odd cipher suites", spec(func(h *helloSpec) { h.suites = []byte{0x13, 1, 2} }), errMalformed},
		{"no compression methods", spec(func(h *helloSpec) { h.compression = nil }), errMalformed},
		{"no extensions at all", spec(func(h *helloSpec) { h.noExtBlock = true }), errNoSNI},
		{"bytes after the extensions", spec(func(h *helloSpec) { h.trailing = []byte{1} }), errMalformed},
		{"extension runs past the block", func() []byte {
			m := append([]byte{}, good...) // the last extension has 3 bytes, and its length says 255
			m[len(m)-5], m[len(m)-4] = 0, 0xff
			return record(m)
		}(), errMalformed},
		{"block runs past the hello", func() []byte {
			m := defaultSpec("api.x.ai")
			m.noExtBlock = true
			m.trailing = []byte{0xff, 0xff, 0, 0}
			return record(m.message())
		}(), errMalformed},
		{"no SNI", spec(func(h *helloSpec) { h.extensions = []ext{{0x000a, []byte{0, 2, 0, 29}}} }), errNoSNI},
		{"ECH after SNI", spec(func(h *helloSpec) { h.extensions = append(h.extensions, ext{extECH, []byte{0}}) }), errECH},
		{"ECH before SNI", spec(func(h *helloSpec) { h.extensions = append([]ext{{extECH, []byte{0}}}, h.extensions...) }), errECH},
		{"ECH empty", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("api.x.ai")}, {extECH, nil}} }), errECH},
		{"ECH and no SNI", spec(func(h *helloSpec) { h.extensions = []ext{{extECH, []byte{0}}} }), errECH},
		{"two SNI extensions", spec(func(h *helloSpec) {
			h.extensions = []ext{{extServerName, sniBody("api.x.ai")}, {extServerName, sniBody("evil.example.com")}}
		}), errMalformed},
		{"two names in one SNI", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("api.x.ai", "evil.example.com")}} }), errMalformed},
		{"empty SNI list", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, []byte{0, 0}}} }), errMalformed},
		{"SNI list length wrong", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, []byte{0, 9, 0, 0, 1, 'a'}}} }), errMalformed},
		{"SNI with bytes after the list", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, append(sniBody("api.x.ai"), 0)}} }), errMalformed},
		{"name type isn't host_name", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, []byte{0, 4, 1, 0, 1, 'a'}}} }), errMalformed},
		{"empty name", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("")}} }), errMalformed},
		{"trailing dot", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("api.x.ai.")}} }), errMalformed},
		{"NUL inside the name", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("api.x.ai\x00.evil.example.com")}} }), errMalformed},
		{"space in the name", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("api.x.ai ")}} }), errMalformed},
		{"a wildcard as the name", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("*.x.ai")}} }), errMalformed},
		{"one label", spec(func(h *helloSpec) { h.extensions = []ext{{extServerName, sniBody("localhost")}} }), errMalformed},
	}
	for _, c := range cases {
		if got, err := nameOf(t, c.raw); !errors.Is(err, c.want) {
			t.Errorf("%s: got %q, %v; want %v", c.name, got, err, c.want)
		}
	}
}

// Bytes this parser has never seen must end in a refusal, not a panic. The seeds run as a test; go test -fuzz does more.
func FuzzHello(f *testing.F) {
	f.Add(record(defaultSpec("api.x.ai").message()))
	f.Add(records(defaultSpec("api.x.ai").message(), 3))
	f.Add([]byte{recordHandshake, 3, 1, 0, 4, 1, 0, 0, 0})
	f.Fuzz(func(t *testing.T, raw []byte) {
		msg, err := helloMessage(raw)
		if err != nil {
			return
		}
		name, err := parseClientHello(msg)
		if err == nil && !validName(name) {
			t.Fatalf("accepted a name that isn't valid: %q", name)
		}
	})
}

// A real socket: the hello arrives in pieces, and what comes back is every byte read, including what followed it.
func TestReadHelloSplitAcrossSegments(t *testing.T) {
	raw := records(defaultSpec("api.x.ai").message(), 50)
	following := []byte{23, 3, 3, 0, 2, 0xaa, 0xbb} // early data, say: it has to reach the provider
	client, srv := tcpPair(t)
	go func() {
		for _, b := range append(append([]byte{}, raw...), following...) {
			client.Write([]byte{b})
			time.Sleep(50 * time.Microsecond)
		}
	}()
	got, name, err := readHello(srv, time.Now().Add(5*time.Second))
	if err != nil || name != "api.x.ai" {
		t.Fatalf("got %q, %v", name, err)
	}
	if !bytes.HasPrefix(got, raw) {
		t.Fatal("what it read isn't what was sent")
	}
	rest := got[len(raw):]
	want := following[:]
	if !bytes.HasPrefix(want, rest) {
		t.Fatalf("after the hello: %x", rest)
	}
}

func TestReadHelloLimits(t *testing.T) {
	big := defaultSpec("api.x.ai")
	big.extensions = append(big.extensions, ext{0x0015, make([]byte, 12<<10)}) // padding, under the limit
	t.Run("large but under the limit", func(t *testing.T) {
		client, srv := tcpPair(t)
		go client.Write(records(big.message(), 1<<14))
		if name, err := readBack(srv); err != nil || name != "api.x.ai" {
			t.Fatalf("got %q, %v", name, err)
		}
	})
	t.Run("record headers count toward the limit", func(t *testing.T) {
		client, srv := tcpPair(t)
		go client.Write(records(big.message(), 1)) // 12 KiB in one-byte records is over 60 KiB on the wire
		if _, err := readBack(srv); !errors.Is(err, errTooLong) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("oversized", func(t *testing.T) {
		huge := defaultSpec("api.x.ai")
		huge.extensions = append(huge.extensions, ext{0x0015, make([]byte, 20<<10)})
		client, srv := tcpPair(t)
		go client.Write(records(huge.message(), 1<<14))
		if _, err := readBack(srv); !errors.Is(err, errTooLong) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("truncated, then closed", func(t *testing.T) {
		client, srv := tcpPair(t)
		raw := record(defaultSpec("api.x.ai").message())
		client.Write(raw[:len(raw)/2])
		client.Close()
		if _, err := readBack(srv); !errors.Is(err, errMalformed) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("garbage is refused at once", func(t *testing.T) {
		client, srv := tcpPair(t)
		client.Write([]byte("garbage"))
		start := time.Now()
		if _, err := readBack(srv); !errors.Is(err, errMalformed) || time.Since(start) > time.Second {
			t.Fatalf("%v after %v", err, time.Since(start))
		}
	})
	t.Run("slow: the deadline is for the whole hello", func(t *testing.T) {
		client, srv := tcpPair(t)
		raw := record(defaultSpec("api.x.ai").message())
		stop := make(chan struct{})
		defer close(stop)
		go func() { // a byte every 10 ms would finish in seconds, and it never gets there
			for _, b := range raw[:len(raw)-1] {
				select {
				case <-stop:
					return
				case <-time.After(10 * time.Millisecond):
					client.Write([]byte{b})
				}
			}
		}()
		start := time.Now()
		_, _, err := readHello(srv, time.Now().Add(150*time.Millisecond))
		if !errors.Is(err, os.ErrDeadlineExceeded) || time.Since(start) > time.Second {
			t.Fatalf("%v after %v", err, time.Since(start))
		}
	})
}

func readBack(c net.Conn) (string, error) {
	_, name, err := readHello(c, time.Now().Add(5*time.Second))
	return name, err
}

func tcpPair(t *testing.T) (client, server *net.TCPConn) {
	t.Helper()
	l, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	c, err := net.DialTCP("tcp", nil, l.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	s, err := l.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); s.Close() })
	return c, s
}
