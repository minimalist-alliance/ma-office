package rtcsock

import (
	"bufio"
	"bytes"
	"errors"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	var stream bytes.Buffer
	j, err := EncodeJSON(&Message{T: "configure", PublicIPv4: "203.0.113.7", MaxSessions: 4})
	if err != nil {
		t.Fatal(err)
	}
	stream.Write(j)
	stream.Write(EncodeData(7, ChBulk, []byte("frame")))
	stream.Write(EncodeCredit(7, ChCtl, 4096))
	r := bufio.NewReader(&stream)

	typ, body, err := ReadEnvelope(r)
	if err != nil || typ != TypeJSON || !bytes.Contains(body, []byte(`"t":"configure"`)) {
		t.Fatalf("json: %d %q %v", typ, body, err)
	}
	typ, body, err = ReadEnvelope(r)
	if err != nil || typ != TypeData {
		t.Fatalf("data: %d %v", typ, err)
	}
	h, ch, frame, err := ParseData(body)
	if err != nil || h != 7 || ch != ChBulk || string(frame) != "frame" {
		t.Fatalf("parse data: %d %d %q %v", h, ch, frame, err)
	}
	typ, body, err = ReadEnvelope(r)
	if err != nil || typ != TypeCredit {
		t.Fatalf("credit: %d %v", typ, err)
	}
	h, ch, n, err := ParseCredit(body)
	if err != nil || h != 7 || ch != ChCtl || n != 4096 {
		t.Fatalf("parse credit: %d %d %d %v", h, ch, n, err)
	}
}

func TestEnvelopeWireFormat(t *testing.T) {
	got := EncodeCredit(0x01020304, 5, 0x00040000)
	want := []byte{0, 0, 0, 10, TypeCredit, 1, 2, 3, 4, 5, 0, 4, 0, 0}
	if !bytes.Equal(got, want) {
		t.Fatalf("got % x want % x", got, want)
	}
}

func TestEnvelopeLimit(t *testing.T) {
	over := []byte{0, 1, 0, 1, TypeJSON}
	if _, _, err := ReadEnvelope(bufio.NewReader(bytes.NewReader(over))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	if _, err := EncodeJSON(&Message{T: "x", Offer: string(make([]byte, MaxEnvelope))}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
}
