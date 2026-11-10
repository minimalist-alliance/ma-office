package fsname

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"os/exec"
	"testing"
)

func TestDecodeWhatDeskDataAndDeskdSend(t *testing.T) {
	cases := map[string]string{
		`"caf\udce9.txt"`:              "caf\xe9.txt", // desk-data: Python's json.dumps
		`"caf\uDCE9.txt"`:              "caf\xe9.txt", // through deskd: Jackson's capitals
		`"a\udcff\udc80b"`:             "a\xff\x80b",
		`"\u00e9t\u00e9/\ud83d\ude00"`: "\u00e9t\u00e9/\U0001F600",
		"\"\u00e9t\u00e9/\U0001F600\"": "\u00e9t\u00e9/\U0001F600", // raw UTF-8, as deskd writes it
		`"\ufffd"`:                     "\uFFFD",                   // a real U+FFFD stays one
		`"q\"\\\/\b\f\n\r\t"`:          "q\"\\/\b\f\n\r\t",
		`"\ud83d\udc80"`:               "\U0001F480", // a pair whose low half is in surrogateescape's range is still a pair
		`""`:                           "",
	}
	for in, want := range cases {
		got, err := Decode([]byte(in))
		if err != nil || got != want {
			t.Errorf("Decode(%s) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestDecodeRefusesWhatCantBeCarried(t *testing.T) {
	for _, in := range []string{
		`"\udc00"`, `"\udc7f"`, `"\udfff"`, // lone low surrogates surrogateescape never makes
		`"\ud800"`, `"\ud800x"`, `"\ud800A"`, // half a pair
		`"\u12"`, `"\uzzzz"`, `"\x"`, `"a`, `a"`, `5`, `"` + "\xff" + `"`, `"` + "\n" + `"`,
	} {
		_, err := Decode([]byte(in))
		var e *Error
		if !errors.As(err, &e) {
			t.Errorf("Decode(%q) = %v, want an *Error", in, err)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		b := make([]byte, r.IntN(40))
		for i := range b {
			b[i] = byte(r.IntN(256))
		}
		enc := Encode(string(b))
		if !json.Valid(enc) {
			t.Fatalf("Encode(%q) = %s isn't JSON", b, enc)
		}
		got, err := Decode(enc)
		if err != nil || got != string(b) {
			t.Fatalf("Decode(Encode(%q)) = %q, %v", b, got, err)
		}
	}
}

func TestValidUTF8ReadsAsEncodingJSONReadsIt(t *testing.T) {
	for _, s := range []string{"plain", "\u00c9t\u00e9 <&> \u2028 \x7f \x01 \"q\"", "\U0001F600/\u65e5\u672c", ""} {
		var std string
		if err := json.Unmarshal(Encode(s), &std); err != nil || std != s {
			t.Errorf("encoding/json reads Encode(%q) as %q, %v", s, std, err)
		}
	}
}

func TestNameInStructsAndNull(t *testing.T) {
	var v struct {
		Path Name  `json:"path"`
		Next *Name `json:"next"`
	}
	if err := json.Unmarshal([]byte(`{"path":"d/caf\udce9","next":null}`), &v); err != nil {
		t.Fatal(err)
	}
	if v.Path != "d/caf\xe9" || v.Next != nil {
		t.Fatalf("got %q, %v", v.Path, v.Next)
	}
	out, err := json.Marshal(map[string]any{"path": v.Path})
	if err != nil || !bytes.Equal(out, []byte(`{"path":"d/caf\udce9"}`)) {
		t.Fatalf("Marshal = %s, %v", out, err)
	}
	err = json.Unmarshal([]byte(`{"path":"\udc01"}`), &v)
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("a name that can't be carried decoded: %v", err)
	}
}

// What Python's surrogateescape and json.dumps make of every byte that isn't UTF-8, as desk-data sends it.
func TestAgainstPython(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	var all []byte
	for b := 0x80; b <= 0xff; b++ {
		all = append(all, byte(b))
	}
	name := "x" + string(all) + "\xe2\x82\xac\xed\xa0\x80\xf0\x9f" + "y"
	cmd := exec.Command(py, "-I", "-c", "import json,os,sys; sys.stdout.write(json.dumps(os.fsdecode(sys.stdin.buffer.read())))")
	cmd.Stdin = bytes.NewReader([]byte(name))
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(out)
	if err != nil || got != name {
		t.Fatalf("Decode(python's %s) = %q, %v", out, got, err)
	}
	back := exec.Command(py, "-I", "-c", "import json,os,sys; sys.stdout.buffer.write(os.fsencode(json.loads(sys.stdin.read())))")
	back.Stdin = bytes.NewReader(Encode(name))
	raw, err := back.Output()
	if err != nil || string(raw) != name {
		t.Fatalf("python read Encode back as %q, %v", raw, err)
	}
}
