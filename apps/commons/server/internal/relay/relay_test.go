package relay

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sock(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "cmr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return filepath.Join(d, "c.sock")
}

func TestPeerCheckAndFraming(t *testing.T) {
	path := sock(t)
	ln, err := Listen(path, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode %v, want 0660", fi.Mode().Perm())
	}
	got := make(chan *Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			got <- c
		}
	}()
	c, err := Dial(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.WriteJSON(map[string]any{"t": "hello", "sessionId": "cs-1", "sub": "gm-abc123", "caller": map[string]any{
		"kind": "guild_member", "memberId": "gm-abc123", "role": "member", "grants": []string{}, "name": "Ana", "badge": nil, "teen": true}}); err != nil {
		t.Fatal(err)
	}
	big := bytes.Repeat([]byte{3}, 4<<20)
	wrote := make(chan error, 1)
	go func() { wrote <- c.WriteFrame(Link, big, time.Second*5) }()
	s := <-got
	defer s.Close()
	h, id, err := s.ReadHello(time.Second)
	if err != nil || h.SessionID != "cs-1" || id.MemberID != "gm-abc123" || id.Name != "Ana" {
		t.Fatalf("hello: %+v %+v %v", h, id, err)
	}
	typ, body, err := s.ReadFrame()
	if err != nil || typ != Link || !bytes.Equal(body, big) {
		t.Fatalf("a 4 MiB room-link frame: %v", err)
	}
	if err := <-wrote; err != nil {
		t.Fatal(err)
	}
	if err := c.WriteFrame(Link, make([]byte, MaxFrame), time.Second); err != ErrTooBig {
		t.Fatalf("an oversize frame went: %v", err)
	}
}

func TestOtherUIDsAreRefused(t *testing.T) {
	path := sock(t)
	ln, err := Listen(path, os.Getuid()+1)
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan struct{})
	go func() {
		if _, err := ln.Accept(); err == nil {
			close(accepted)
		}
	}()
	c, err := Dial(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// The listener closes it: the next read sees the end.
	_ = c.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadFrame(); err == nil {
		t.Fatal("a connection from another uid stayed open")
	}
	ln.Close()
	select {
	case <-accepted:
		t.Fatal("a connection from another uid was accepted")
	default:
	}
}

func TestHelloRules(t *testing.T) {
	path := sock(t)
	ln, _ := Listen(path, os.Getuid())
	defer ln.Close()
	cases := []struct {
		name  string
		frame func(c *Conn) error
	}{
		{"not JSON first", func(c *Conn) error { return c.WriteFrame(Link, []byte{1}, time.Second) }},
		{"an owner caller", func(c *Conn) error {
			return c.WriteJSON(map[string]any{"t": "hello", "sub": "u-1", "caller": map[string]any{"kind": "owner", "memberId": nil, "role": nil}})
		}},
		{"sub isn't the member", func(c *Conn) error {
			return c.WriteJSON(map[string]any{"t": "hello", "sub": "gm-other1", "caller": map[string]any{"kind": "guild_member", "memberId": "gm-abc123", "role": "member"}})
		}},
	}
	for _, tc := range cases {
		got := make(chan error, 1)
		go func() {
			s, err := ln.Accept()
			if err != nil {
				got <- err
				return
			}
			_, _, err = s.ReadHello(time.Second)
			s.Close()
			got <- err
		}()
		c, _ := Dial(path)
		_ = tc.frame(c)
		if err := <-got; err == nil {
			t.Errorf("%s: accepted", tc.name)
		}
		c.Close()
	}
}

func TestAnEarlierTimeoutDoesNotStick(t *testing.T) {
	path := sock(t)
	ln, _ := Listen(path, os.Getuid())
	defer ln.Close()
	go func() {
		s, err := ln.Accept()
		if err != nil {
			return
		}
		for {
			if _, _, err := s.ReadFrame(); err != nil {
				return
			}
		}
	}()
	c, err := Dial(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.WriteFrame(JSON, []byte(`{"t":"x"}`), 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if err := c.WriteFrame(Link, []byte{1}, 0); err != nil {
		t.Fatalf("a write with no limit failed on the last one's deadline: %v", err)
	}
}
