package main

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"time"
)

// placeholder is the only address uid 1103 ever learns. It's TEST-NET-1, which is never routed. nftables redirects uid
// 1103's TCP 443 whatever the address, so the name in the hello decides, and this address never reaches the wire.
var placeholder = [4]byte{192, 0, 2, 1}

const (
	dnsTTL       = 60
	typeA        = 1
	typeAAAA     = 28
	typeOPT      = 41
	classIN      = 1
	rcodeNoError = 0
	rcodeFormErr = 1
	rcodeNXName  = 3
	maxDNSQuery  = 1500
	headerLen    = 12
)

// dnsServer is the DNS side: uid 1103's only DNS, a fixed answer for each query. It never forwards, so uid 1103 has no
// real DNS and nothing to tunnel through.
type dnsServer struct {
	names       map[string]struct{}
	refusals    *refusalLog
	slots       chan struct{}
	connTimeout time.Duration
}

// answer returns the reply to one query, or nil to drop it: anything too short to carry an ID, or that isn't a query.
func (d *dnsServer) answer(q []byte) []byte {
	if len(q) < headerLen || q[2]&0x80 != 0 {
		return nil
	}
	id, rd := q[:2], q[2]&0x01
	reply := func(rcode byte, question []byte, answers uint16) []byte {
		r := make([]byte, headerLen, headerLen+len(question)+16)
		copy(r, id)
		r[2] = 0x84 | rd // response, authoritative
		r[3] = 0x80 | rcode
		if question != nil {
			binary.BigEndian.PutUint16(r[4:], 1)
		}
		binary.BigEndian.PutUint16(r[6:], answers)
		return append(r, question...)
	}
	formErr := func() []byte { return reply(rcodeFormErr, nil, 0) }

	h := q[headerLen:]
	if q[2]&0x78 != 0 || binary.BigEndian.Uint16(q[4:]) != 1 || binary.BigEndian.Uint16(q[6:]) != 0 ||
		binary.BigEndian.Uint16(q[8:]) != 0 || binary.BigEndian.Uint16(q[10:]) > 1 {
		return formErr() // not QUERY, or not one question and at most an OPT record
	}
	name, n, ok := dnsName(h)
	if !ok || len(h) < n+4 {
		return formErr()
	}
	question, rest := h[:n+4], h[n+4:]
	qtype, qclass := binary.BigEndian.Uint16(question[n:]), binary.BigEndian.Uint16(question[n+2:])
	if binary.BigEndian.Uint16(q[10:]) == 1 {
		if !isOPT(rest) {
			return formErr()
		}
	} else if len(rest) != 0 {
		return formErr()
	}
	lower := strings.ToLower(name)
	_, listed := d.names[lower]
	switch {
	case !listed:
		if validName(lower) {
			d.refusals.refused("refused DNS: %s isn't on the list", lower)
		} else {
			d.refusals.refused("refused DNS: not a host name")
		}
		return reply(rcodeNXName, question, 0)
	case qclass == classIN && qtype == typeA:
		r := reply(rcodeNoError, question, 1)
		r = append(r, 0xc0, headerLen) // the name in the question
		r = binary.BigEndian.AppendUint16(r, typeA)
		r = binary.BigEndian.AppendUint16(r, classIN)
		r = binary.BigEndian.AppendUint32(r, dnsTTL)
		r = binary.BigEndian.AppendUint16(r, 4)
		return append(r, placeholder[:]...)
	case qclass == classIN && qtype == typeAAAA:
		return reply(rcodeNoError, question, 0) // no IPv6: the placeholder is enough
	}
	d.refusals.refused("refused DNS: query type %d for %s", qtype, lower)
	return reply(rcodeNXName, question, 0)
}

// dnsName reads an uncompressed name at the start of b: its text, without a trailing dot, and the bytes it took. A query
// has nothing to point back to, so a compression pointer is malformed.
func dnsName(b []byte) (string, int, bool) {
	var sb strings.Builder
	for i := 0; ; {
		if i >= len(b) || i > 255 {
			return "", 0, false
		}
		n := int(b[i])
		if n == 0 {
			return sb.String(), i + 1, i+1 <= 255
		}
		if n > 63 || i+1+n > len(b) {
			return "", 0, false // 64 and up are pointers and reserved forms
		}
		if sb.Len() > 0 {
			sb.WriteByte('.')
		}
		sb.Write(b[i+1 : i+1+n])
		i += 1 + n
	}
}

// isOPT: b is exactly one EDNS OPT record. It gets no OPT back, which RFC 6891 allows and a client handles.
func isOPT(b []byte) bool {
	if len(b) < 11 || b[0] != 0 || binary.BigEndian.Uint16(b[1:]) != typeOPT {
		return false
	}
	return len(b) == 11+int(binary.BigEndian.Uint16(b[9:]))
}

func (d *dnsServer) serveUDP(c *net.UDPConn) error {
	buf := make([]byte, maxDNSQuery+1)
	for {
		n, from, err := c.ReadFromUDPAddrPort(buf)
		if errors.Is(err, net.ErrClosed) {
			return err
		}
		if err != nil || n > maxDNSQuery {
			continue
		}
		if r := d.answer(buf[:n]); r != nil {
			c.WriteToUDPAddrPort(r, from)
		}
	}
}

func (d *dnsServer) serveTCP(l *net.TCPListener) error {
	for {
		c, err := l.AcceptTCP()
		if errors.Is(err, net.ErrClosed) {
			return err
		}
		if err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case d.slots <- struct{}{}:
			go func() {
				defer func() { <-d.slots }()
				defer c.Close()
				// A query and its answer are a few hundred bytes, so a client that sends and never reads can't pile up more.
				if bound(c, dnsBuffer, dnsBuffer) != nil {
					return
				}
				d.handleTCP(c)
			}()
		default:
			c.SetLinger(0)
			c.Close()
		}
	}
}

// handleTCP answers queries on one connection until the client ends it or connTimeout passes, whichever is first.
func (d *dnsServer) handleTCP(c *net.TCPConn) {
	c.SetDeadline(time.Now().Add(d.connTimeout))
	var size [2]byte
	for {
		if _, err := io.ReadFull(c, size[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(size[:]))
		if n > maxDNSQuery {
			return
		}
		q := make([]byte, n)
		if _, err := io.ReadFull(c, q); err != nil {
			return
		}
		r := d.answer(q)
		if r == nil {
			return
		}
		if _, err := c.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(r))), r...)); err != nil {
			return
		}
	}
}
