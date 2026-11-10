package rtcserver

import (
	"strings"
	"testing"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

const (
	fpHex   = "7a1c3e9b0d552f61c844e0129ab73df60891ce2a5b7f13d466a0bc39e507f28c"
	fpSDP   = "7A:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C"
	fpOther = "00:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C"
)

// sdpOffer builds a Chrome-shaped offer with chosen fingerprint lines.
func sdpOffer(session string, perSection [3]string, video string) string {
	var b strings.Builder
	b.WriteString("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2\r\n")
	if session != "" {
		b.WriteString("a=fingerprint:" + session + "\r\n")
	}
	section := func(media, fmtp, fp string) {
		b.WriteString(media + "\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwxyz\r\n")
		if fp != "" {
			b.WriteString("a=fingerprint:" + fp + "\r\n")
		}
		b.WriteString(fmtp)
	}
	section("m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0\r\na=recvonly\r\na=rtpmap:111 opus/48000/2\r\n", perSection[0])
	section("m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1\r\na=recvonly\r\n"+video, perSection[1])
	section("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=mid:2\r\na=sctp-port:5000\r\n", perSection[2])

	return b.String()
}

const (
	vp8Only = "a=rtpmap:96 VP8/90000\r\n"
	h264CB  = "a=rtpmap:96 H264/90000\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n"
)

func TestFingerprintRules(t *testing.T) {
	expected, err := parseExpected(fpHex)
	if err != nil {
		t.Fatal(err)
	}
	good := "sha-256 " + fpSDP
	bad := "sha-256 " + fpOther
	lower := "sha-256 " + strings.ToLower(fpSDP)
	sha1 := "sha-1 AA:BB:CC"

	cases := []struct {
		name    string
		session string
		lines   [3]string
		code    string
	}{
		{"Chrome: one per section", "", [3]string{good, good, good}, ""},
		{"Firefox: one at session level", good, [3]string{}, ""},
		{"both levels agree", good, [3]string{good, good, good}, ""},
		{"lowercase hex decodes to the same bytes", "", [3]string{lower, good, lower}, ""},
		{"one section differs", "", [3]string{good, bad, good}, rtcsock.CodeIdentityMismatch},
		{"session level differs", bad, [3]string{good, good, good}, rtcsock.CodeIdentityMismatch},
		{"all differ", "", [3]string{bad, bad, bad}, rtcsock.CodeIdentityMismatch},
		{"one line is SHA-1", "", [3]string{good, sha1, good}, rtcsock.CodeIdentityMismatch},
		{"no lines at all", "", [3]string{}, rtcsock.CodeBadOffer},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, oerr := parseOffer(sdpOffer(c.session, c.lines, h264CB), expected)
			switch {
			case c.code == "" && oerr != nil:
				t.Fatalf("refused: %v", oerr)
			case c.code != "" && (oerr == nil || oerr.code != c.code):
				t.Fatalf("want %s, got %v", c.code, oerr)
			}
		})
	}
}

func TestParseExpected(t *testing.T) {
	if _, err := parseExpected(fpHex); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "abc", strings.ToUpper(fpHex), strings.Repeat("z", 64), fpSDP} {
		if _, err := parseExpected(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestOfferSections(t *testing.T) {
	expected, _ := parseExpected(fpHex)
	good := "sha-256 " + fpSDP
	lines := [3]string{good, good, good}

	info, oerr := parseOffer(sdpOffer("", lines, h264CB), expected)
	if oerr != nil || !info.hasH264 {
		t.Fatalf("H.264 offer: %+v %v", info, oerr)
	}
	info, oerr = parseOffer(sdpOffer("", lines, vp8Only), expected)
	if oerr != nil || info.hasH264 {
		t.Fatalf("VP8 offer: %+v %v", info, oerr)
	}

	noOpus := strings.Replace(sdpOffer("", lines, h264CB), "a=rtpmap:111 opus/48000/2", "a=rtpmap:111 PCMU/8000", 1)
	if _, oerr := parseOffer(noOpus, expected); oerr == nil || oerr.code != rtcsock.CodeBadOffer {
		t.Fatalf("no Opus: %v", oerr)
	}

	noData := strings.Split(sdpOffer("", lines, h264CB), "m=application")[0]
	if _, oerr := parseOffer(noData, expected); oerr == nil || oerr.code != rtcsock.CodeBadOffer {
		t.Fatalf("no data section: %v", oerr)
	}

	if _, oerr := parseOffer("garbage", expected); oerr == nil || oerr.code != rtcsock.CodeBadOffer {
		t.Fatalf("garbage: %v", oerr)
	}
}
