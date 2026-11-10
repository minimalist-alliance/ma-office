package chat

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func open(t *testing.T, path string) *Log {
	t.Helper()
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestPostPageReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.log")
	l := open(t, path)
	for i := 0; i < 130; i++ {
		if _, fresh, err := l.Post("gm-ana1", "Ana", "officer", "", strings.Repeat("x", i%7+1)); err != nil || !fresh {
			t.Fatal(err, fresh)
		}
	}
	page, more := l.Page(0, 50)
	if len(page) != 50 || !more || page[0].Seq != 81 || page[49].Seq != 130 {
		t.Fatalf("latest page: %d msgs, more %v, %d..%d", len(page), more, page[0].Seq, page[len(page)-1].Seq)
	}
	older, more := l.Page(page[0].Seq, 100)
	if len(older) != 80 || more || older[0].Seq != 1 || older[79].Seq != 80 {
		t.Fatalf("older page: %d msgs, more %v", len(older), more)
	}
	l.Close()
	l = open(t, path)
	defer l.Close()
	if l.Last() != 130 || l.Count() != 130 {
		t.Fatalf("reopened: last %d, count %d", l.Last(), l.Count())
	}
	m, _ := l.Get(7)
	if m.From != "gm-ana1" || m.Name != "Ana" || m.Badge != "officer" || m.Text != "xxxxxxx" {
		t.Fatalf("reopened message: %+v", m)
	}
	if m, _, _ := l.Post("gm-ana1", "Ana", "", "", "next"); m.Seq != 131 {
		t.Fatalf("seq after reopen: %d", m.Seq)
	}
}

func TestEditAndDeleteWipeTheWords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.log")
	l := open(t, path)
	defer l.Close()
	m, _, _ := l.Post("gm-ben1", "Ben", "", "n1", "the first secret draft")
	if _, err := l.Edit(m.Seq, "gm-ana1", "not mine"); err != ErrNotYours {
		t.Fatalf("someone else's edit: %v", err)
	}
	e, err := l.Edit(m.Seq, "gm-ben1", "the second version")
	if err != nil || e.Text != "the second version" || e.Edited == 0 {
		t.Fatalf("edit: %+v %v", e, err)
	}
	b, _ := os.ReadFile(path)
	if bytes.Contains(b, []byte("first secret")) || !bytes.Contains(b, []byte("second version")) {
		t.Fatal("the edited text is still on disk, or the new one isn't")
	}
	if err := l.Delete(m.Seq, "gm-mod1", true); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if bytes.Contains(b, []byte("second version")) {
		t.Fatal("a deleted message's text is still on disk")
	}
	if _, err := l.Get(m.Seq); err != ErrNoMessage {
		t.Fatalf("deleted message: %v", err)
	}
	if page, _ := l.Page(0, 10); len(page) != 0 {
		t.Fatalf("a deleted message is in the page: %+v", page)
	}
	l.Close()
	l2 := open(t, path)
	defer l2.Close()
	if l2.Count() != 0 || l2.Last() != 1 {
		t.Fatalf("after reopen: count %d last %d", l2.Count(), l2.Last())
	}
}

func TestNonceAndLimits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.log")
	l := open(t, path)
	a, fresh, _ := l.Post("gm-cy01", "Cy", "", "same", "hello")
	if !fresh {
		t.Fatal("first post not fresh")
	}
	b, fresh, _ := l.Post("gm-cy01", "Cy", "", "same", "hello")
	if fresh || b.Seq != a.Seq || b.Nonce != "same" {
		t.Fatalf("a resend made a copy: %+v", b)
	}
	if _, fresh, _ := l.Post("gm-dee1", "Dee", "", "same", "hello"); !fresh {
		t.Fatal("another member's nonce collided")
	}
	l.Close()
	l = open(t, path)
	defer l.Close()
	if _, fresh, _ := l.Post("gm-cy01", "Cy", "", "same", "hello"); fresh {
		t.Fatal("a resend after a restart made a copy")
	}
	if _, _, err := l.Post("gm-cy01", "Cy", "", "", "  \n\t "); err != ErrEmpty {
		t.Fatalf("empty: %v", err)
	}
	if _, _, err := l.Post("gm-cy01", "Cy", "", "", strings.Repeat("é", MaxText+1)); err != ErrTooLong {
		t.Fatalf("too long: %v", err)
	}
	if m, _, err := l.Post("gm-cy01", "Cy", "", "", strings.Repeat("é", MaxText)); err != nil || len([]rune(m.Text)) != MaxText {
		t.Fatalf("4000 characters: %v", err)
	}
	if m, _, _ := l.Post("gm-cy01", "Cy", "", "", "a\x00b\x1bc\r\nd"); m.Text != "abc\nd" {
		t.Fatalf("control characters: %q", m.Text)
	}
}

func TestTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.log")
	l := open(t, path)
	l.Post("gm-ana1", "Ana", "", "", "one")
	l.Post("gm-ana1", "Ana", "", "", "two")
	l.Close()
	b, _ := os.ReadFile(path)
	os.WriteFile(path, b[:len(b)-3], 0o600)
	l = open(t, path)
	defer l.Close()
	if l.Count() != 1 || l.Last() != 1 {
		t.Fatalf("torn tail: count %d last %d", l.Count(), l.Last())
	}
	if m, _, _ := l.Post("gm-ana1", "Ana", "", "", "three"); m.Seq != 2 {
		t.Fatalf("seq after a torn tail: %d", m.Seq)
	}
}
