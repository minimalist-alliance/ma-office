package session_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fakedesk"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/frame"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

func open(t *testing.T, d *fakedesk.Desk) (*session.Session, *fakedesk.End) {
	t.Helper()
	c, srv := fakedesk.Pipe()
	d.Serve(srv)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := session.Open(ctx, c, session.Options{KeepaliveInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)

	return s, c
}

func writeFile(t *testing.T, name string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func random(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)

	return b
}

func TestFrames(t *testing.T) {
	cf, err := frame.Decode(frame.EncodeCredit(7, 300000))
	if err != nil {
		t.Fatal(err)
	}
	c, err := frame.DecodeCredit(cf.Payload)
	if err != nil || c != 300000 {
		t.Fatalf("credit round trip: %d %v", c, err)
	}
	f, _ := frame.Decode(frame.EncodeCredit(7, 1))
	if f.Kind != frame.Credit || f.ID != 7 || f.Flags != 0 {
		t.Fatalf("credit frame: %+v", f)
	}
	if string(f.Payload) != `{"bytes":1}` {
		t.Fatalf("credit payload %s", f.Payload)
	}
	tr := frame.Trailer{SHA256: sha256.Sum256([]byte("x")), Size: 1 << 40}
	got, err := frame.DecodeTrailer(frame.EncodeTrailer(tr))
	if err != nil || got != tr {
		t.Fatalf("trailer round trip: %+v %v", got, err)
	}
	if _, err := frame.DecodeTrailer(make([]byte, 39)); err == nil {
		t.Fatal("a 39-byte trailer was accepted")
	}
	bad := frame.Encode(frame.Chunk, 0x08, 1, 0, nil)
	if _, err := frame.Decode(bad); err == nil {
		t.Fatal("an unknown flag was accepted")
	}
	bad = frame.Encode(frame.Chunk, 0, 1, 0, nil)
	bad[3] = 1
	if _, err := frame.Decode(bad); err == nil {
		t.Fatal("a set reserved byte was accepted")
	}
	if _, err := frame.Decode(make([]byte, frame.MaxSize+1)); err == nil {
		t.Fatal("an oversize frame was accepted")
	}
}

func TestHelloCallAndErrors(t *testing.T) {
	d := &fakedesk.Desk{Root: t.TempDir()}
	s, _ := open(t, d)
	if s.Hello.SessionID == "" || s.Hello.DeskAPI != "1.0" {
		t.Fatalf("hello: %+v", s.Hello)
	}
	var st map[string]any
	if err := s.Call(context.Background(), "desk.status.get", nil, &st); err != nil || st["deskId"] != "d-source" {
		t.Fatalf("desk.status.get: %v %v", st, err)
	}
	err := s.Call(context.Background(), "no.such", nil, nil)
	if !session.IsCode(err, "not_found") {
		t.Fatalf("want not_found, got %v", err)
	}
}

// The Browser's hold and release are mutations: deskd refuses them without idem, and each call has a key of its own.
func TestMutationsCarryIdem(t *testing.T) {
	d := &fakedesk.Desk{Root: t.TempDir()}
	s, _ := open(t, d)
	if err := s.Call(context.Background(), "data.browser.hold", nil, nil); !session.IsCode(err, "bad_request") {
		t.Fatalf("a hold without idem: %v", err)
	}
	for _, m := range []string{"data.browser.hold", "data.browser.release"} {
		if err := s.CallMutation(context.Background(), m, nil, nil); err != nil {
			t.Fatalf("%s: %v", m, err)
		}
	}
	if st := d.Stats(); st.Holds != 1 || st.Releases != 1 || st.NoIdem != 1 {
		t.Fatalf("holds %d releases %d refused %d", st.Holds, st.Releases, st.NoIdem)
	}
	a, b := session.NewIdem(), session.NewIdem()
	if a == b || len(a) != 36 || a[14] != '7' || !bytes.ContainsAny([]byte(a[19:20]), "89ab") {
		t.Fatalf("not two UUIDv7s: %s %s", a, b)
	}
}

// A manifest page bigger than one frame comes back in MORE fragments and is reassembled.
func TestFragmentedReply(t *testing.T) {
	root := t.TempDir()
	for i := range 300 {
		writeFile(t, filepath.Join(root, "desk", "notes", fmt.Sprintf("a-rather-long-file-name-%04d.md", i)), []byte("x"))
	}
	s, _ := open(t, &fakedesk.Desk{Root: root})
	var page struct {
		Entries []map[string]any `json:"entries"`
		Next    *string          `json:"next"`
	}
	if err := s.Call(context.Background(), "data.manifest", map[string]any{"part": "desk"}, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 301 || page.Next != nil {
		t.Fatalf("got %d entries, next %v", len(page.Entries), page.Next)
	}
}

func readAll(t *testing.T, tr *session.Transfer, grant bool) ([]byte, frame.Trailer) {
	t.Helper()
	var buf bytes.Buffer
	var ungranted int64
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, err := tr.Next(ctx)
		cancel()
		if err != nil {
			t.Fatalf("after %d bytes: %v", buf.Len(), err)
		}
		if c.End {
			tr.Finish()
			got, err := frame.DecodeTrailer(c.Data)
			if err != nil {
				t.Fatal(err)
			}

			return buf.Bytes(), got
		}
		buf.Write(c.Data)
		ungranted += int64(len(c.Data))
		if grant && ungranted >= 256*1024 {
			if err := tr.Grant(ungranted); err != nil {
				t.Fatal(err)
			}
			ungranted = 0
		}
	}
}

// The desk sends only as far as the reader's credit: the 1 MiB that data.read grants, then what the
// reader grants with CREDIT.
func TestCreditFlow(t *testing.T) {
	root := t.TempDir()
	data := random(3<<20 + 1234)
	writeFile(t, filepath.Join(root, "browser", "profile", "History"), data)
	d := &fakedesk.Desk{Root: root}
	s, _ := open(t, d)
	tr, err := s.Read(context.Background(), "browser", "profile/History", 0)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Size != int64(len(data)) {
		t.Fatalf("size %d", tr.Size)
	}
	// Without a grant, exactly the first window arrives, then nothing.
	var got int
	for got < session.InitialWindow {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, err := tr.Next(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		got += len(c.Data)
	}
	if got != session.InitialWindow {
		t.Fatalf("first window was %d bytes", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	_, err = tr.Next(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a chunk came past the window: %v", err)
	}
	// 256 KiB of credit lets exactly 256 KiB more through.
	if err := tr.Grant(256 * 1024); err != nil {
		t.Fatal(err)
	}
	var more int
	for more < 256*1024 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, err := tr.Next(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		more += len(c.Data)
	}
	if more != 256*1024 {
		t.Fatalf("a 256 KiB grant let %d bytes through", more)
	}
	if err := tr.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	// A whole read with grants after each 256 KiB gets every byte and a true trailer.
	tr, err = s.Read(context.Background(), "browser", "profile/History", 0)
	if err != nil {
		t.Fatal(err)
	}
	body, trailer := readAll(t, tr, true)
	if !bytes.Equal(body, data) || trailer.SHA256 != sha256.Sum256(data) || trailer.Size != uint64(len(data)) {
		t.Fatal("the read doesn't match the file")
	}
	for _, g := range d.Stats().Grants {
		if g < 256*1024 {
			t.Fatalf("a grant of %d bytes, under 256 KiB", g)
		}
	}
}

// A read from an offset sends the rest, and the trailer still covers the file from byte 0.
func TestReadFromOffset(t *testing.T) {
	root := t.TempDir()
	data := random(100000)
	writeFile(t, filepath.Join(root, "desk", "chat.db"), data)
	s, _ := open(t, &fakedesk.Desk{Root: root})
	tr, err := s.Read(context.Background(), "desk", "chat.db", 60000)
	if err != nil {
		t.Fatal(err)
	}
	body, trailer := readAll(t, tr, true)
	if !bytes.Equal(body, data[60000:]) || trailer.SHA256 != sha256.Sum256(data) {
		t.Fatal("the rest of the file or its trailer is wrong")
	}
}

// Chunks can arrive before data.read's reply (channels aren't ordered against each other): they're kept.
func TestChunksBeforeReply(t *testing.T) {
	root := t.TempDir()
	data := random(50000)
	writeFile(t, filepath.Join(root, "agent", "memory.json"), data)
	s, _ := open(t, &fakedesk.Desk{Root: root, ChunksBeforeReply: true})
	for range 5 {
		tr, err := s.Read(context.Background(), "agent", "memory.json", 0)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := readAll(t, tr, true)
		if !bytes.Equal(body, data) {
			t.Fatal("chunks sent before the reply were lost")
		}
	}
}

// A dropped transport ends every transfer with ErrDisconnected, so the reader can resume elsewhere.
func TestDropEndsTransfers(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "desk", "big"), random(3<<20))
	s, c := open(t, &fakedesk.Desk{Root: root})
	tr, err := s.Read(context.Background(), "desk", "big", 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := tr.Next(ctx)
		cancel()
		if err != nil {
			if !errors.Is(err, session.ErrDisconnected) {
				t.Fatalf("want ErrDisconnected, got %v", err)
			}

			break
		}
	}
	if err := s.Call(context.Background(), "desk.status.get", nil, nil); !errors.Is(err, session.ErrDisconnected) {
		t.Fatalf("a call after the drop: %v", err)
	}
}

func TestTooMany(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "desk", "big"), random(2<<20))
	s, _ := open(t, &fakedesk.Desk{Root: root})
	for i := range 8 {
		if _, err := s.Read(context.Background(), "desk", "big", 0); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
	}
	if _, err := s.Read(context.Background(), "desk", "big", 0); !session.IsCode(err, "too_many") {
		t.Fatalf("a ninth read: %v", err)
	}
}
