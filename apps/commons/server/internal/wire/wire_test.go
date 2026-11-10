package wire

import (
	"bytes"
	"testing"
)

func TestSplitAndJoin(t *testing.T) {
	var buf []byte
	small := Append(nil, Ctrl, []byte(`{"t":"x"}`))
	big := Append(nil, BoardEntry, bytes.Repeat([]byte{7}, 3*MaxMessage+123))
	for i := 0; i < 1000; i++ {
		buf = append(buf, small...)
	}
	buf = append(buf, big...)
	buf = append(buf, small...)
	msgs := Split(buf, MaxMessage)
	var got [][]byte
	var j Joiner
	for _, m := range msgs {
		if len(m) > MaxMessage {
			t.Fatalf("a message of %d bytes", len(m))
		}
		if err := Each(m, func(typ byte, p []byte) error {
			if typ == Part {
				rec, done, err := j.Add(p)
				if done {
					got = append(got, rec)
				}
				return err
			}
			got = append(got, Append(nil, typ, p))
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(got) != 1002 || !bytes.Equal(got[1000], big) || !bytes.Equal(got[1001], small) {
		t.Fatalf("got %d records back", len(got))
	}
	if one := Split(small, MaxMessage); len(one) != 1 {
		t.Fatal("a small buffer was split")
	}
}

func TestJoinerRefusesJunk(t *testing.T) {
	var j Joiner
	if _, _, err := j.Add([]byte{1, 2, 0, 0, 0, 9}); err != ErrPart {
		t.Fatalf("a record whose length is wrong: %v", err)
	}
	if _, _, err := j.Add(nil); err != ErrPart {
		t.Fatal("an empty part")
	}
}
