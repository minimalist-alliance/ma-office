package main

import (
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"testing"
)

// A binding request as Pion builds one (USERNAME, ICE-CONTROLLING, PRIORITY, MESSAGE-INTEGRITY, FINGERPRINT), made with
// pion/stun v4 in desk-rtc's module: the demux reads Pion's and the browsers' framing the same.
const pionRequest = "000100502112a4420102030405060708090a0b0c000600157330324162436445664768496a4b6c4d3a436c3165000000802a00081122334455667788002400046e001eff0008001453f7d2aa7a9c55bff1a519689b494e7096af41ab80280004c0791484"

// request builds a binding request with these attributes (type, value), padded, and a FINGERPRINT unless noFP.
func request(t *testing.T, typ uint16, attrs [][2][]byte, noFP bool) []byte {
	t.Helper()
	b := make([]byte, stunHeader)
	binary.BigEndian.PutUint16(b[0:2], typ)
	binary.BigEndian.PutUint32(b[4:8], stunMagic)
	copy(b[8:20], "0123456789ab")
	for _, a := range attrs {
		h := make([]byte, 4)
		copy(h[0:2], a[0])
		binary.BigEndian.PutUint16(h[2:4], uint16(len(a[1])))
		b = append(b, h...)
		b = append(b, a[1]...)
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
	}
	if !noFP {
		binary.BigEndian.PutUint16(b[2:4], uint16(len(b)-stunHeader+8))
		crc := crc32.ChecksumIEEE(b) ^ fingerprintXOR
		fp := []byte{0x80, 0x28, 0, 4, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(fp[4:], crc)
		b = append(b, fp...)
	}
	binary.BigEndian.PutUint16(b[2:4], uint16(len(b)-stunHeader))

	return b
}

func at(typ uint16) []byte { return []byte{byte(typ >> 8), byte(typ)} }

func user(u string) [2][]byte { return [2][]byte{at(attrUsername), []byte(u)} }

func TestPionsRequestNamesItsSlot(t *testing.T) {
	pkt, _ := hex.DecodeString(pionRequest)
	k, err := slotOfRequest(pkt)
	if err != nil || k != 2 {
		t.Fatalf("slot %d, %v: want 2", k, err)
	}
	pkt[len(pkt)-1] ^= 1 // one bit of the FINGERPRINT
	if _, err := slotOfRequest(pkt); err == nil {
		t.Fatal("a wrong FINGERPRINT was taken")
	}
	pkt[len(pkt)-1] ^= 1
	pkt[30] ^= 1 // one bit of the USERNAME: the CRC no longer matches
	if _, err := slotOfRequest(pkt); err == nil {
		t.Fatal("a changed request kept its FINGERPRINT")
	}
}

func TestRequestsThatNameNoSlot(t *testing.T) {
	mi := [2][]byte{at(attrIntegrity), make([]byte, 20)}
	for name, c := range map[string]struct {
		pkt  []byte
		want error
	}{
		"no username":         {request(t, stunBindingReq, [][2][]byte{mi}, false), errNoUsername},
		"Commons' ufrag":      {request(t, stunBindingReq, [][2][]byte{user("cmnsAbCdEfGhIjKl:x"), mi}, false), errNoTag},
		"Pion's own ufrag":    {request(t, stunBindingReq, [][2][]byte{user("AbCdEfGhIjKlMnOp:x"), mi}, false), errNoTag},
		"slot 0":              {request(t, stunBindingReq, [][2][]byte{user("s00AbCdEfGhIjKlM:x"), mi}, false), errNoTag},
		"slot 33":             {request(t, stunBindingReq, [][2][]byte{user("s33AbCdEfGhIjKlM:x"), mi}, false), errNoTag},
		"tag alone":           {request(t, stunBindingReq, [][2][]byte{user("s01:x"), mi}, false), errNoTag},
		"no fingerprint":      {request(t, stunBindingReq, [][2][]byte{user("s01AbCdEfGhIjKlM:x"), mi}, true), errBadFrame},
		"a binding success":   {request(t, 0x0101, [][2][]byte{user("s01AbCdEfGhIjKlM:x")}, false), errBadFrame},
		"an allocate":         {request(t, 0x0003, [][2][]byte{user("s01AbCdEfGhIjKlM:x")}, false), errBadFrame},
		"two usernames":       {request(t, stunBindingReq, [][2][]byte{user("s01AbCdEfGhIjKlM:x"), user("s02AbCdEfGhIjKlM:x")}, false), errBadFrame},
		"an empty username":   {request(t, stunBindingReq, [][2][]byte{user("")}, false), errBadFrame},
		"a 600-byte username": {request(t, stunBindingReq, [][2][]byte{user("s01" + string(make([]byte, 597)))}, false), errBadFrame},
		"something after FP":  {afterFP(t), errBadFrame},
	} {
		k, err := slotOfRequest(c.pkt)
		if err != c.want {
			t.Errorf("%s: slot %d, %v, want %v", name, k, err, c.want)
		}
	}
	good := request(t, stunBindingReq, [][2][]byte{user("s29AbCdEfGhIjKlM:x"), mi}, false)
	if k, err := slotOfRequest(good); err != nil || k != 29 {
		t.Fatalf("slot %d, %v: want 29", k, err)
	}
	// an attribute whose length runs past the message
	bad := append([]byte(nil), good...)
	binary.BigEndian.PutUint16(bad[22:24], 400)
	if _, err := slotOfRequest(bad); err == nil {
		t.Fatal("an attribute past the end was taken")
	}
}

// What other protocols' first bytes read as, as a length: over the cap, so closed at the second byte.
func TestOtherProtocolsFailAtTheLength(t *testing.T) {
	for name, b := range map[string][2]byte{
		"TLS ClientHello": {0x16, 0x03}, "HTTP GET": {'G', 'E'}, "HTTP POST": {'P', 'O'}, "SSH": {'S', 'S'},
		"zero": {0, 0}, "too short": {0, 12}, "unaligned": {0, 0x51},
	} {
		if _, ok := frameLength(b); ok {
			t.Errorf("%s: %x taken as a frame length", name, b)
		}
	}
	if n, ok := frameLength([2]byte{0, 0x50}); !ok || n != 80 {
		t.Fatalf("Pion's request's length: %d %v", n, ok)
	}
}

func TestUfragTags(t *testing.T) {
	for u, want := range map[string]int{"s01x": 1, "s32AbCdEfGhIjKlM": 32, "s09AbCdEfGhIjKlM": 9, "s1xAbCd": 0, "s01": 0,
		"S01AbCd": 0, "s-1AbCd": 0, "s33AbCd": 0, "s00AbCd": 0, "": 0, "cmnsAbCd": 0} {
		if got := slotOfUfrag(u); got != want {
			t.Errorf("%q: %d, want %d", u, got, want)
		}
	}
}

// afterFP is a request with a PRIORITY after its FINGERPRINT, the header's length counting it.
func afterFP(t *testing.T) []byte {
	b := append(request(t, stunBindingReq, [][2][]byte{user("s01AbCdEfGhIjKlM:x")}, false), 0, 0x24, 0, 4, 1, 2, 3, 4)
	binary.BigEndian.PutUint16(b[2:4], uint16(len(b)-stunHeader))

	return b
}
