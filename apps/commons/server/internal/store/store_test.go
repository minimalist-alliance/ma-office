package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestAppendReloadCompact(t *testing.T) {
	dir := t.TempDir()
	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.List()) != 1 || r.Active == "" {
		t.Fatalf("a new room has one board up, got %v", r.List())
	}
	bd, _ := r.Board(r.Active)
	for i := 0; i < 5; i++ {
		if seq := r.Append(bd, []byte{byte(i)}, "Ana"); seq != uint32(i+1) {
			t.Fatalf("seq %d, want %d", seq, i+1)
		}
	}
	if err := r.Rename(bd.Meta.ID, "  Sprint\x01 plan  "); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}

	r2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	bd2, ok := r2.Board(bd.Meta.ID)
	if !ok || len(bd2.Entries) != 5 || bd2.Seq != 5 || bd2.Meta.Name != "Sprint plan" || bd2.Meta.By != "Ana" {
		t.Fatalf("reload: %+v", bd2)
	}

	// A snapshot covering 1..3 replaces them; 4 and 5 stay.
	if err := r2.Compact(bd2, 3, []byte("snap")); err != nil {
		t.Fatal(err)
	}
	if len(bd2.Entries) != 3 || bd2.Entries[0].Seq != 3 || !bytes.Equal(bd2.Entries[0].Data, []byte("snap")) || bd2.Entries[1].Seq != 4 {
		t.Fatalf("compact: %+v", bd2.Entries)
	}
	if _, err := os.Stat(filepath.Join(dir, "boards", bd.Meta.ID+".prev")); err != nil {
		t.Fatalf("the log before compaction is kept as .prev: %v", err)
	}
	if err := r2.Compact(bd2, 99, nil); err == nil {
		t.Fatal("a snapshot past the board's seq must be refused")
	}
	if seq := r2.Append(bd2, []byte("x"), "Ben"); seq != 6 {
		t.Fatalf("seq after compaction %d, want 6", seq)
	}
	r2.Close()

	r3, _ := Open(dir)
	bd3, _ := r3.Board(bd.Meta.ID)
	if len(bd3.Entries) != 4 || bd3.Seq != 6 {
		t.Fatalf("reload after compaction: %+v", bd3.Entries)
	}
	r3.Close()
}

func TestTornTailIsDropped(t *testing.T) {
	dir := t.TempDir()
	r, _ := Open(dir)
	bd, _ := r.Board(r.Active)
	r.Append(bd, []byte("one"), "")
	r.Append(bd, []byte("two"), "")
	r.Close()
	p := filepath.Join(dir, "boards", bd.Meta.ID+".log")
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.Write([]byte{3, 0, 0, 0, 9, 0, 0, 0, 'h', 'a'}) // a record cut off mid-write
	f.Close()
	r2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	bd2, _ := r2.Board(bd.Meta.ID)
	if len(bd2.Entries) != 2 || bd2.Seq != 2 {
		t.Fatalf("torn tail: %+v", bd2.Entries)
	}
}

func TestBoardsNewSwitchDelete(t *testing.T) {
	r, _ := Open(t.TempDir())
	first := r.Active
	b2, _ := r.Create("Plans")
	if r.Active != b2.Meta.ID {
		t.Fatal("a new board goes up")
	}
	// Leaving a blank, unnamed board drops it.
	if err := r.Switch(first); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Board(b2.Meta.ID); !ok {
		t.Fatal("a named board is kept even if blank")
	}
	b3, _ := r.Create("")
	r.Switch(first)
	if _, ok := r.Board(b3.Meta.ID); ok {
		t.Fatal("a blank unnamed board is dropped when left")
	}
	// Deleting the board that's up puts another up; deleting the last makes a new one.
	r.Delete(first)
	if r.Active != b2.Meta.ID {
		t.Fatalf("after deleting the up board, %s is up", r.Active)
	}
	r.Delete(b2.Meta.ID)
	if len(r.List()) != 1 || r.Active == b2.Meta.ID {
		t.Fatal("the room always keeps one board up")
	}
}

// Security's GDS-6: a channel's boards hold at most ChannelBytes together, and it has at most MaxBoards. A compaction
// that shrinks a board is always taken, so a full channel can give room back.
func TestChannelBudget(t *testing.T) {
	oldBytes, oldBoards := ChannelBytes, MaxBoards
	t.Cleanup(func() { ChannelBytes, MaxBoards = oldBytes, oldBoards })
	ChannelBytes, MaxBoards = 100, 3

	r, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	up, _ := r.Board(r.Active)
	other, err := r.Create("Other")
	if err != nil {
		t.Fatal(err)
	}
	// Updates to a board that isn't up are never compacted, so they count the same as any.
	r.Append(up, bytes.Repeat([]byte("a"), 40), "Ana")
	r.Append(other, bytes.Repeat([]byte("b"), 40), "Ana")
	if !r.Fits(20) || r.Fits(21) {
		t.Fatalf("with 80 of 100 held, Fits(20) %v and Fits(21) %v", r.Fits(20), r.Fits(21))
	}
	r.Append(up, bytes.Repeat([]byte("c"), 20), "Ana")
	if r.Bytes() != 100 || r.Fits(1) {
		t.Fatalf("full at %d bytes, Fits(1) %v", r.Bytes(), r.Fits(1))
	}

	// A snapshot bigger than what it replaces doesn't go past the budget; a smaller one is taken, and frees room.
	if err := r.Compact(up, up.Seq, bytes.Repeat([]byte("s"), 61)); err != ErrFull {
		t.Fatalf("a compaction past the budget: %v, want ErrFull", err)
	}
	if err := r.Compact(up, up.Seq, []byte("small")); err != nil {
		t.Fatal(err)
	}
	if r.Bytes() != 45 || !r.Fits(55) {
		t.Fatalf("after compaction %d bytes held", r.Bytes())
	}

	// Boards: up to MaxBoards, then refused.
	if _, err := r.Create("Third"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Create("Fourth"); err != ErrFull {
		t.Fatalf("a board past the cap: %v, want ErrFull", err)
	}
	if len(r.List()) != 3 {
		t.Fatalf("%d boards, want 3", len(r.List()))
	}
}
