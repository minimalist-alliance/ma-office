package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func encodeName(name string) []byte {
	var b []byte
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	return append(b, 0)
}

func query(name string, qtype uint16) []byte {
	q := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0}
	q = append(q, encodeName(name)...)
	q = binary.BigEndian.AppendUint16(q, qtype)
	return binary.BigEndian.AppendUint16(q, classIN)
}

func testDNS() *dnsServer {
	return &dnsServer{names: map[string]struct{}{"api.x.ai": {}}, refusals: &refusalLog{printf: func(string, ...any) {}},
		slots: make(chan struct{}, 4), connTimeout: time.Second}
}

func rcode(r []byte) byte     { return r[3] & 0x0f }
func ancount(r []byte) uint16 { return binary.BigEndian.Uint16(r[6:]) }

func TestDNSListedA(t *testing.T) {
	q := query("api.x.ai", typeA)
	r := testDNS().answer(q)
	if r == nil || !bytes.Equal(r[:2], q[:2]) || r[2]&0x80 == 0 || rcode(r) != rcodeNoError || ancount(r) != 1 {
		t.Fatalf("%x", r)
	}
	if !bytes.Equal(r[headerLen:len(q)], q[headerLen:]) {
		t.Fatalf("the question isn't echoed: %x", r)
	}
	a := r[len(q):]
	if !bytes.Equal(a[:2], []byte{0xc0, headerLen}) || binary.BigEndian.Uint16(a[2:]) != typeA || binary.BigEndian.Uint16(a[4:]) != classIN ||
		binary.BigEndian.Uint32(a[6:]) != dnsTTL || binary.BigEndian.Uint16(a[10:]) != 4 {
		t.Fatalf("the answer: %x", a)
	}
	if !bytes.Equal(a[12:], placeholder[:]) || len(a) != 16 {
		t.Fatalf("the address: %x", a[12:])
	}
}

func TestDNSCaseIsMatchedAndEchoed(t *testing.T) {
	q := query("aPi.X.aI", typeA) // DNS 0x20
	r := testDNS().answer(q)
	if rcode(r) != rcodeNoError || ancount(r) != 1 || !bytes.Equal(r[headerLen:len(q)], q[headerLen:]) {
		t.Fatalf("%x", r)
	}
}

func TestDNSListedAAAAIsEmpty(t *testing.T) {
	r := testDNS().answer(query("api.x.ai", typeAAAA))
	if rcode(r) != rcodeNoError || ancount(r) != 0 {
		t.Fatalf("%x", r)
	}
}

func TestDNSRefused(t *testing.T) {
	d := testDNS()
	for name, q := range map[string][]byte{
		"unlisted A":      query("www.cloudflare.com", typeA),
		"unlisted AAAA":   query("www.cloudflare.com", typeAAAA),
		"subdomain":       query("x.api.x.ai", typeA),
		"parent":          query("x.ai", typeA),
		"TXT, listed":     query("api.x.ai", 16),
		"TXT, unlisted":   query("tunnel.example.com", 16),
		"HTTPS, listed":   query("api.x.ai", 65),
		"ANY, listed":     query("api.x.ai", 255),
		"CHAOS class":     append(query("api.x.ai", typeA)[:len(query("api.x.ai", typeA))-2], 0, 3),
		"PTR":             query("1.2.0.192.in-addr.arpa", 12),
		"root":            append(append([]byte{0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}, 0), 0, 1, 0, 1),
		"not a host name": query("a b.example.com", typeA),
	} {
		r := d.answer(q)
		if r == nil || rcode(r) != rcodeNXName || ancount(r) != 0 {
			t.Errorf("%s: %x", name, r)
		}
	}
}

func TestDNSMalformed(t *testing.T) {
	d := testDNS()
	good := query("api.x.ai", typeA)
	two := append([]byte{}, good...)
	two[5] = 2
	two = append(two, encodeName("other.example.com")...)
	two = append(two, 0, 1, 0, 1)
	none := append([]byte{}, good[:headerLen]...)
	none[5] = 0
	pointer := append(append([]byte{}, good[:headerLen]...), 0xc0, 0x0c, 0, 1, 0, 1)
	long := append([]byte{}, good[:headerLen]...)
	for i := 0; i < 5; i++ {
		long = append(long, 63)
		long = append(long, bytes.Repeat([]byte{'a'}, 63)...)
	}
	long = append(long, 0, 0, 1, 0, 1)
	withAnswer := append([]byte{}, good...)
	withAnswer[7] = 1
	notQuery := append([]byte{}, good...)
	notQuery[2] |= 0x08 // IQUERY
	badOPT := append(append([]byte{}, good...), 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0)
	badOPT[11] = 1
	trailing := append(append([]byte{}, good...), 9)
	for name, q := range map[string][]byte{
		"two questions": two, "no question": none, "a pointer in the question": pointer, "name over 255": long, "an answer in a query": withAnswer,
		"another opcode": notQuery, "additional that isn't OPT": badOPT, "bytes after the question": trailing,
		"name runs off the end": good[:headerLen+3], "no type": good[:len(good)-4],
	} {
		r := d.answer(q)
		if r == nil || rcode(r) != rcodeFormErr || ancount(r) != 0 || len(r) != headerLen || !bytes.Equal(r[:2], q[:2]) {
			t.Errorf("%s: %x", name, r)
		}
	}
	for name, q := range map[string][]byte{"empty": {}, "short": good[:headerLen-1], "a response": func() []byte { r := append([]byte{}, good...); r[2] |= 0x80; return r }()} {
		if r := d.answer(q); r != nil {
			t.Errorf("%s isn't dropped: %x", name, r)
		}
	}
}

func TestDNSAcceptsEDNS(t *testing.T) {
	q := append(query("api.x.ai", typeA), 0, 0, typeOPT, 0x10, 0, 0, 0, 0, 0, 0, 0)
	q[11] = 1
	r := testDNS().answer(q)
	if rcode(r) != rcodeNoError || ancount(r) != 1 {
		t.Fatalf("%x", r)
	}
	if binary.BigEndian.Uint16(r[10:]) != 0 {
		t.Fatal("it says it answers with an additional record")
	}
}

func FuzzDNS(f *testing.F) {
	f.Add(query("api.x.ai", typeA))
	f.Add([]byte{0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1})
	d := testDNS()
	f.Fuzz(func(t *testing.T, q []byte) {
		r := d.answer(q)
		if r == nil {
			return
		}
		if len(r) > 512 {
			t.Fatalf("a reply of %d", len(r))
		}
		if ancount(r) != 0 && !bytes.Contains(bytes.ToLower(q), []byte("\x03api\x01x\x02ai\x00")) {
			t.Fatalf("an answer to %x", q)
		}
	})
}

func TestDNSRealClientOverUDPAndTCP(t *testing.T) {
	d := testDNS()
	// UDP and TCP on one port, as a resolver expects. A free UDP port can be in use for TCP, so try a few.
	var pc *net.UDPConn
	var l *net.TCPListener
	for i := 0; l == nil; i++ {
		var err error
		if pc, err = net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}); err != nil {
			t.Fatal(err)
		}
		if l, err = net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: pc.LocalAddr().(*net.UDPAddr).Port}); err != nil {
			pc.Close()
			if i == 20 {
				t.Fatal(err)
			}
		}
	}
	defer pc.Close()
	defer l.Close()
	go d.serveUDP(pc)
	go d.serveTCP(l)
	for _, network := range []string{"udp", "tcp"} {
		r := &net.Resolver{PreferGo: true, Dial: func(ctx context_, _, _ string) (net.Conn, error) {
			var nd net.Dialer
			return nd.DialContext(ctx, network, pc.LocalAddr().String())
		}}
		ctx, cancel := testContext()
		addrs, err := r.LookupHost(ctx, "api.x.ai.")
		if err != nil || len(addrs) != 1 || addrs[0] != "192.0.2.1" {
			t.Errorf("%s: %v, %v", network, addrs, err)
		}
		if _, err := r.LookupHost(ctx, "www.cloudflare.com."); err == nil {
			t.Errorf("%s: an unlisted name resolved", network)
		}
		if txt, err := r.LookupTXT(ctx, "api.x.ai."); err == nil {
			t.Errorf("%s: TXT answered: %v", network, txt)
		}
		cancel()
	}
}

func TestDNSTCPEndsAtItsDeadline(t *testing.T) {
	d := testDNS()
	d.connTimeout = 100 * time.Millisecond
	l, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go d.serveTCP(l)
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadAll(c); err != nil {
		t.Fatalf("idle connection isn't closed by the server: %v", err)
	}
}
