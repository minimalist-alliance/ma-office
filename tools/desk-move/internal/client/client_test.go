package client

import (
	"strings"
	"testing"
)

func TestAnswerFingerprints(t *testing.T) {
	id := []string{"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}
	good := "v=0\r\na=fingerprint:sha-256 9F:86:D0:81:88:4C:7D:65:9A:2F:EA:A0:C5:5A:D0:15:A3:BF:4F:1B:2B:0B:82:2C:D1:5D:6C:15:B0:F0:0A:08\r\n"
	if err := checkAnswerFingerprints(good, id); err != nil {
		t.Fatal(err)
	}
	other := strings.Replace(good, "9F:86", "9F:87", 1)
	for name, sdp := range map[string]string{"another desk": other, "none": "v=0\r\n", "sha-1": strings.Replace(good, "sha-256", "sha-1", 1)} {
		if err := checkAnswerFingerprints(sdp, id); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestFingerprintFormat(t *testing.T) {
	cert, err := NewCertificate()
	if err != nil {
		t.Fatal(err)
	}
	fp, err := Fingerprint(cert)
	if err != nil {
		t.Fatal(err)
	}
	hexPart, ok := strings.CutPrefix(fp, "sha-256 ")
	if !ok || len(hexPart) != 95 || strings.ToUpper(hexPart) != hexPart {
		t.Fatalf("connect wants \"sha-256 AB:CD:…\": %q", fp)
	}
}
