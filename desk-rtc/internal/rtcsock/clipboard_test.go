package rtcsock

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func wire(t *testing.T, m *Message) string {
	t.Helper()
	b, err := EncodeJSON(m)
	if err != nil {
		t.Fatal(err)
	}

	return string(b[5:])
}

// What deskd reads has to say part 0, last: false and on: false out loud, and nothing it doesn't mean.
func TestClipboardWire(t *testing.T) {
	cases := []struct {
		m    *Message
		want string
	}{
		{ClipSet(0, 0, false, []byte("hi")), `{"t":"clipboard.set","id":0,"part":0,"last":false,"data":"aGk="}`},
		{ClipSet(7, 2, true, nil), `{"t":"clipboard.set","id":7,"part":2,"last":true}`},
		{ClipGet(9, 1000000), `{"t":"clipboard.get","id":9,"maxBytes":1000000}`},
		{ClipWatch(false), `{"t":"clipboard.watch","on":false}`},
		{ClipWatch(true), `{"t":"clipboard.watch","on":true}`},
		{ClipOK(0), `{"t":"clipboard.ok","id":0}`},
		{ClipError(3, ClipTooLarge), `{"t":"clipboard.error","code":"too_large","id":3}`},
		{ClipText(4, 0, true, []byte("hi")), `{"t":"clipboard.text","id":4,"part":0,"last":true,"data":"aGk="}`},
		{ClipText(4, 1, false, []byte("hi")), `{"t":"clipboard.text","id":4,"part":1,"last":false,"data":"aGk="}`},
		{ClipNone(5), `{"t":"clipboard.text","id":5,"part":0,"last":true,"none":true}`},
		{ClipChanged(), `{"t":"clipboard.changed"}`},
	}
	for _, c := range cases {
		if got := wire(t, c.m); got != c.want {
			t.Errorf("got  %s\nwant %s", got, c.want)
		}
	}
	// The fields a clipboard message doesn't use stay off every other message.
	if got := wire(t, &Message{T: "stats.get"}); got != `{"t":"stats.get"}` {
		t.Errorf("stats.get: %s", got)
	}
}

// A whole part with the largest id a client can send still fits one envelope.
func TestClipboardPartFitsEnvelope(t *testing.T) {
	big := bytes.Repeat([]byte{0xff}, ClipPartMax)
	for _, m := range []*Message{ClipSet(MaxClipID, 1<<30, false, big), ClipText(MaxClipID, 1<<30, false, big)} {
		if _, err := EncodeJSON(m); err != nil {
			t.Fatalf("%s: %v", m.T, err)
		}
	}
}

func TestClipboardRoundTrip(t *testing.T) {
	text := bytes.Repeat([]byte("héllo\n"), 40000)
	var parts int
	var j ClipJoiner
	var got *ClipReply
	ClipEachPart(text, func(part int, last bool, chunk []byte) bool {
		parts++
		if len(chunk) > ClipPartMax {
			t.Fatalf("part of %d bytes", len(chunk))
		}
		var m Message
		if err := json.Unmarshal([]byte(wire(t, ClipText(11, part, last, chunk))), &m); err != nil {
			t.Fatal(err)
		}
		r, err := j.Add(&m)
		if err != nil {
			t.Fatal(err)
		}
		if last != (r != nil) {
			t.Fatalf("part %d last=%v reply=%v", part, last, r)
		}
		got = r

		return true
	})
	if want := len(text)/ClipPartMax + 1; parts != want {
		t.Fatalf("%d parts, want %d", parts, want)
	}
	if got == nil || got.ID != 11 || !bytes.Equal(got.Text, text) {
		t.Fatalf("got back something else")
	}
}

func TestClipboardEmptyIsOneLastPart(t *testing.T) {
	n := 0
	ClipEachPart(nil, func(part int, last bool, chunk []byte) bool {
		n++
		if part != 0 || !last || len(chunk) != 0 {
			t.Fatalf("part %d last %v, %d bytes", part, last, len(chunk))
		}

		return true
	})
	if n != 1 {
		t.Fatalf("%d parts", n)
	}
}

func TestClipJoinerRefusesWrongOrder(t *testing.T) {
	var j ClipJoiner
	var m Message
	if err := json.Unmarshal([]byte(wire(t, ClipText(1, 1, true, []byte("x")))), &m); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Add(&m); err == nil || !strings.Contains(err.Error(), "order") {
		t.Fatalf("got %v", err)
	}
}

// A clipboard field of the wrong type is left unset and marked, never an error: an error here closes rtc.sock and
// every session on it.
func TestClipboardFieldsNeverFailTheDecode(t *testing.T) {
	cases := []struct {
		in  string
		bad bool
		id  *uint64
	}{
		{`{"t":"clipboard.get","id":-1,"maxBytes":100}`, true, nil},
		{`{"t":"clipboard.get","id":7,"maxBytes":1e6}`, true, u64(7)},
		{`{"t":"clipboard.get","id":7,"maxBytes":1000000.0}`, true, u64(7)},
		{`{"t":"clipboard.get","id":7,"maxBytes":"100"}`, true, u64(7)},
		{`{"t":"clipboard.get","id":7,"maxBytes":99999999999999999999}`, true, u64(7)},
		{`{"t":"clipboard.get","id":1e3}`, true, nil},
		{`{"t":"clipboard.get","id":1.5}`, true, nil},
		{`{"t":"clipboard.get","id":"7"}`, true, nil},
		{`{"t":"clipboard.get","id":9007199254740992}`, true, nil},
		{`{"t":"clipboard.get","id":18446744073709551615}`, true, nil},
		{`{"t":"clipboard.get","id":{}}`, true, nil},
		{`{"t":"clipboard.set","id":8,"part":"0","last":true,"data":""}`, true, u64(8)},
		{`{"t":"clipboard.set","id":8,"part":0,"last":"yes","data":""}`, true, u64(8)},
		{`{"t":"clipboard.set","id":8,"part":0,"last":true,"data":5}`, true, u64(8)},
		{`{"t":"clipboard.set","id":8,"part":0.5,"last":true}`, true, u64(8)},
		{`{"t":"clipboard.text","id":8,"part":0,"last":true,"none":1}`, true, u64(8)},
		{`{"t":"clipboard.watch","on":1}`, true, nil},
		{`{"t":"clipboard.watch","on":"true"}`, true, nil},
		// Good ones, including the edges and null, which is the same as leaving the field out.
		{`{"t":"clipboard.get","id":9007199254740991,"maxBytes":0}`, false, u64(MaxClipID)},
		{`{"t":"clipboard.get","id":0,"maxBytes":-5}`, false, u64(0)},
		{`{"t":"clipboard.get","id":-0}`, false, u64(0)},
		{`{"t":"clipboard.get","id":null,"maxBytes":null}`, false, nil},
		{`{"t":"clipboard.set","id":3,"part":-1,"last":false,"data":null,"none":null,"on":null}`, false, u64(3)},
		{`{"t":"clipboard.watch","on":false}`, false, nil},
		// A message that isn't the clipboard's doesn't fail on a clipboard field either.
		{`{"t":"stats.get","id":-1,"part":"x"}`, true, nil},
	}
	for _, c := range cases {
		var m Message
		if err := json.Unmarshal([]byte(c.in), &m); err != nil {
			t.Errorf("%s: %v", c.in, err)

			continue
		}
		if m.ClipBad != c.bad {
			t.Errorf("%s: bad=%v", c.in, m.ClipBad)
		}
		switch {
		case (m.ID == nil) != (c.id == nil):
			t.Errorf("%s: id %v", c.in, m.ID)
		case m.ID != nil && *m.ID != *c.id:
			t.Errorf("%s: id %d", c.in, *m.ID)
		}
		if m.T == "" {
			t.Errorf("%s: lost t", c.in)
		}
	}
}

// What a good message decodes to is what encoding/json would have made of it, and it goes back out the same.
func TestClipboardDecodeRoundTrip(t *testing.T) {
	for _, m := range []*Message{
		ClipSet(0, 0, false, []byte("hi")), ClipSet(MaxClipID, 45, true, nil), ClipGet(9, 1000000), ClipWatch(false),
		ClipWatch(true), ClipOK(0), ClipError(3, ClipTooLarge), ClipText(4, 1, false, []byte("hi")), ClipNone(5),
		ClipChanged(),
		{T: "session.create", SessionID: "s1", Offer: "v=0", Permissions: &Permissions{Video: true}},
		{T: "configure", PublicIPv4: "203.0.113.7", MaxSessions: 4},
	} {
		w := wire(t, m)
		var got Message
		if err := json.Unmarshal([]byte(w), &got); err != nil {
			t.Fatalf("%s: %v", w, err)
		}
		if got.ClipBad {
			t.Errorf("%s: bad", w)
		}
		if again := wire(t, &got); again != w {
			t.Errorf("got  %s\nwant %s", again, w)
		}
	}
}

// The other fields fail as they always did: only the clipboard's are forgiven.
func TestOtherFieldsStillFailTheDecode(t *testing.T) {
	for _, in := range []string{
		`{"t":"configure","maxSessions":"4"}`,
		`{"t":5}`,
		`{"t":"session.create","permissions":true}`,
		`{"t":"clipboard.get","id":1`,
	} {
		var m Message
		if err := json.Unmarshal([]byte(in), &m); err == nil {
			t.Errorf("%s: no error", in)
		}
	}
}

func TestClipJoinerRefusesABadField(t *testing.T) {
	var j ClipJoiner
	var m Message
	if err := json.Unmarshal([]byte(`{"t":"clipboard.text","id":1,"part":0,"last":"yes","data":""}`), &m); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Add(&m); err == nil {
		t.Fatal("joined a part with a bad field")
	}
}

func u64(v uint64) *uint64 { return &v }
