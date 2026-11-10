package main

import (
	"errors"
	"io"
	"net"
	"strings"
	"time"
)

const (
	maxHelloBytes = 16 << 10 // every record of the hello, headers included

	recordHandshake      = 22
	handshakeClientHello = 1
	extServerName        = 0x0000
	extECH               = 0xfe0d // encrypted_client_hello: a listed name outside could hide another site inside
	sniHostName          = 0
)

var (
	errNeedMore  = errors.New("hello incomplete")
	errMalformed = errors.New("malformed hello")
	errTooLong   = errors.New("hello too long")
	errNoSNI     = errors.New("no SNI")
	errECH       = errors.New("encrypted_client_hello")
)

// helloMessage joins the handshake bytes of the records at the start of raw into the whole ClientHello message, header
// included. errNeedMore: fine so far, but it hasn't all arrived. Bytes after the record that ends the hello aren't
// looked at; they're the client's next records, and they get forwarded. Extra handshake bytes in that record are refused.
func helloMessage(raw []byte) ([]byte, error) {
	var msg []byte
	p := raw
	for {
		if len(p) >= 1 && p[0] != recordHandshake || len(p) >= 2 && p[1] != 3 {
			return nil, errMalformed
		}
		if len(p) < 5 {
			return nil, errNeedMore
		}
		n := int(p[3])<<8 | int(p[4])
		if n == 0 || n > 1<<14 { // RFC 8446 5.1: at most 2^14, and no empty fragments of a handshake
			return nil, errMalformed
		}
		frag := p[5:]
		if len(frag) > n {
			frag = frag[:n]
		}
		if len(msg) == 0 && len(frag) > 0 && frag[0] != handshakeClientHello {
			return nil, errMalformed
		}
		if len(frag) < n {
			return nil, errNeedMore
		}
		msg = append(msg, frag...)
		p = p[5+n:]
		if len(msg) < 4 {
			continue
		}
		if msg[0] != handshakeClientHello {
			return nil, errMalformed
		}
		want := 4 + (int(msg[1])<<16 | int(msg[2])<<8 | int(msg[3]))
		if want > maxHelloBytes {
			return nil, errTooLong
		}
		if len(msg) == want {
			return msg, nil
		}
		if len(msg) > want {
			return nil, errMalformed
		}
	}
}

// cursor reads big-endian fields. Each read says whether the bytes were there, so nothing runs past the end.
type cursor struct{ b []byte }

func (c *cursor) take(n int) ([]byte, bool) {
	if n < 0 || len(c.b) < n {
		return nil, false
	}
	out := c.b[:n]
	c.b = c.b[n:]
	return out, true
}

func (c *cursor) u8() (int, bool) {
	b, ok := c.take(1)
	if !ok {
		return 0, false
	}
	return int(b[0]), true
}

func (c *cursor) u16() (int, bool) {
	b, ok := c.take(2)
	if !ok {
		return 0, false
	}
	return int(b[0])<<8 | int(b[1]), true
}

func (c *cursor) vec8() ([]byte, bool) {
	n, ok := c.u8()
	if !ok {
		return nil, false
	}
	return c.take(n)
}

func (c *cursor) vec16() ([]byte, bool) {
	n, ok := c.u16()
	if !ok {
		return nil, false
	}
	return c.take(n)
}

// parseClientHello returns the lowercased name of a whole ClientHello message. It's strict, because a server that reads
// a hello differently from this could see another name: every length has to fit exactly, and a repeated extension or a
// second name is refused. encrypted_client_hello is refused wherever it sits, whatever else the hello carries.
func parseClientHello(msg []byte) (string, error) {
	if len(msg) < 4 || msg[0] != handshakeClientHello {
		return "", errMalformed
	}
	c := cursor{msg[4:]}
	version, ok := c.u16()
	if !ok || version < 0x0301 || version > 0x0303 {
		return "", errMalformed
	}
	if _, ok = c.take(32); !ok { // random
		return "", errMalformed
	}
	session, ok := c.vec8()
	if !ok || len(session) > 32 {
		return "", errMalformed
	}
	suites, ok := c.vec16()
	if !ok || len(suites) < 2 || len(suites)%2 != 0 {
		return "", errMalformed
	}
	compression, ok := c.vec8()
	if !ok || len(compression) < 1 {
		return "", errMalformed
	}
	if len(c.b) == 0 {
		return "", errNoSNI // a hello may have no extensions at all
	}
	extensions, ok := c.vec16()
	if !ok || len(c.b) != 0 {
		return "", errMalformed
	}
	e := cursor{extensions}
	seen := map[int]bool{}
	name, ech := "", false
	for len(e.b) > 0 {
		kind, ok := e.u16()
		if !ok {
			return "", errMalformed
		}
		body, ok := e.vec16()
		if !ok || seen[kind] {
			return "", errMalformed
		}
		seen[kind] = true
		switch kind {
		case extECH:
			ech = true
		case extServerName:
			if name, ok = parseServerName(body); !ok {
				return "", errMalformed
			}
		}
	}
	switch {
	case ech:
		return "", errECH
	case !seen[extServerName]:
		return "", errNoSNI
	}
	return name, nil
}

// parseServerName: exactly one entry, of type host_name, a valid name, no trailing dot (RFC 6066 3).
func parseServerName(body []byte) (string, bool) {
	c := cursor{body}
	list, ok := c.vec16()
	if !ok || len(c.b) != 0 {
		return "", false
	}
	l := cursor{list}
	kind, ok := l.u8()
	if !ok || kind != sniHostName {
		return "", false
	}
	raw, ok := l.vec16()
	if !ok || len(l.b) != 0 {
		return "", false
	}
	name := strings.ToLower(string(raw))
	return name, validName(name)
}

// readHello reads from c until it holds a whole ClientHello, or the deadline, or maxHelloBytes. It returns everything it
// read, which is what goes to the provider, and the name.
func readHello(c net.Conn, deadline time.Time) ([]byte, string, error) {
	if err := c.SetReadDeadline(deadline); err != nil {
		return nil, "", err
	}
	raw := make([]byte, 0, 4096)
	for {
		if len(raw) == cap(raw) {
			if cap(raw) >= maxHelloBytes {
				return nil, "", errTooLong
			}
			grown := make([]byte, len(raw), min(cap(raw)*2, maxHelloBytes))
			copy(grown, raw)
			raw = grown
		}
		n, err := c.Read(raw[len(raw):cap(raw)])
		raw = raw[:len(raw)+n]
		msg, perr := helloMessage(raw)
		switch {
		case perr == nil:
			name, err := parseClientHello(msg)
			if err != nil {
				return nil, "", err
			}
			return raw, name, c.SetReadDeadline(time.Time{})
		case !errors.Is(perr, errNeedMore):
			return nil, "", perr
		case errors.Is(err, io.EOF):
			return nil, "", errMalformed // it stopped part way through
		case err != nil:
			return nil, "", err // the deadline, or a reset
		}
	}
}
