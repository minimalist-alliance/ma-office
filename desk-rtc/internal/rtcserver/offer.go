package rtcserver

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net/netip"
	"strings"

	"github.com/pion/sdp/v3"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// offerError carries a session.error code.
type offerError struct {
	code string
	msg  string
}

func (e *offerError) Error() string { return e.code + ": " + e.msg }

// offerInfo is what session setup needs to know about an offer before it builds a PeerConnection.
type offerInfo struct {
	hasH264 bool
}

// parseExpected decodes expectedFingerprint: 64 lowercase hex chars (desk-runtime.md section 4.4).
func parseExpected(expected string) ([]byte, error) {
	if len(expected) != 64 || expected != strings.ToLower(expected) {
		return nil, errors.New("expectedFingerprint must be 64 lowercase hex chars")
	}
	b, err := hex.DecodeString(expected)
	if err != nil {
		return nil, errors.New("expectedFingerprint must be 64 lowercase hex chars")
	}

	return b, nil
}

// checkFingerprints applies section 4.4: every a=fingerprint line, at session or media level, is
// SHA-256 and decodes to the expected bytes. There must be at least one.
func checkFingerprints(parsed *sdp.SessionDescription, expected []byte) *offerError {
	var seen int
	check := func(attrs []sdp.Attribute) *offerError {
		for _, a := range attrs {
			if a.Key != "fingerprint" {
				continue
			}
			seen++
			alg, value, ok := strings.Cut(strings.TrimSpace(a.Value), " ")
			if !ok || !strings.EqualFold(alg, "sha-256") {
				return &offerError{rtcsock.CodeIdentityMismatch, "a=fingerprint is not SHA-256"}
			}
			got, err := hex.DecodeString(strings.ReplaceAll(strings.TrimSpace(value), ":", ""))
			if err != nil || !bytes.Equal(got, expected) {
				return &offerError{rtcsock.CodeIdentityMismatch, "a=fingerprint differs from expectedFingerprint"}
			}
		}

		return nil
	}
	if err := check(parsed.Attributes); err != nil {
		return err
	}
	for _, m := range parsed.MediaDescriptions {
		if err := check(m.Attributes); err != nil {
			return err
		}
	}
	if seen == 0 {
		return &offerError{rtcsock.CodeBadOffer, "offer has no a=fingerprint"}
	}

	return nil
}

// parseOffer validates an offer without allocating anything for it.
func parseOffer(offer string, expected []byte) (offerInfo, *offerError) {
	var info offerInfo
	var parsed sdp.SessionDescription
	if err := parsed.UnmarshalString(offer); err != nil {
		return info, &offerError{rtcsock.CodeBadOffer, "SDP does not parse: " + err.Error()}
	}
	if oerr := checkFingerprints(&parsed, expected); oerr != nil {
		return info, oerr
	}

	var hasData bool
	for _, m := range parsed.MediaDescriptions {
		switch m.MediaName.Media {
		case "application":
			hasData = true
		case "audio":
			// Audio is never rejected, because the first section carries the BUNDLE tag. An offer
			// we would have to reject it for is refused as a whole.
			if !hasCodec(m, "opus") {
				return info, &offerError{rtcsock.CodeBadOffer, "audio section offers no Opus"}
			}
		case "video":
			info.hasH264 = info.hasH264 || hasConstrainedBaselineH264(m)
		}
	}
	if !hasData {
		return info, &offerError{rtcsock.CodeBadOffer, "offer has no data section"}
	}

	return info, nil
}

func rtpmaps(m *sdp.MediaDescription) map[string]string {
	out := map[string]string{}
	for _, a := range m.Attributes {
		if a.Key != "rtpmap" {
			continue
		}
		pt, codec, ok := strings.Cut(a.Value, " ")
		if !ok {
			continue
		}
		name, _, _ := strings.Cut(codec, "/")
		out[pt] = strings.ToLower(name)
	}

	return out
}

func hasCodec(m *sdp.MediaDescription, name string) bool {
	for _, n := range rtpmaps(m) {
		if n == name {
			return true
		}
	}

	return false
}

// hasConstrainedBaselineH264 is true when the section offers the one video format we can send.
// It has to be exact: with no match, Pion falls back to answering with every codec registered
// on its engine, even ones the offer never named, so we leave H.264 off the engine in that case.
func hasConstrainedBaselineH264(m *sdp.MediaDescription) bool {
	maps := rtpmaps(m)
	for _, a := range m.Attributes {
		if a.Key != "fmtp" {
			continue
		}
		pt, params, ok := strings.Cut(a.Value, " ")
		if !ok || maps[pt] != "h264" {
			continue
		}
		params = strings.ToLower(params)
		if strings.Contains(params, "packetization-mode=1") && strings.Contains(params, "profile-level-id=42e0") {
			return true
		}
	}

	return false
}

// iceCredentials returns the first a=ice-ufrag and a=ice-pwd of an SDP.
func iceCredentials(sdpText string) (ufrag, pwd string) {
	for _, l := range strings.Split(sdpText, "\n") {
		l = strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(l, "a=ice-ufrag:"); ok && ufrag == "" {
			ufrag = v
		} else if v, ok := strings.CutPrefix(l, "a=ice-pwd:"); ok && pwd == "" {
			pwd = v
		}
	}

	return ufrag, pwd
}

// offerNetworks are the client networks an offer says the client can be reached from, for the ICE-TCP gate's reserved
// places: the addresses of its server-reflexive and peer-reflexive candidates, and of host candidates that are public
// (a loopback one only when loopback is allowed, for the dev tools). Private, link-local, mDNS and relay candidates say
// nothing about the address a connection will come from. At most gateMaxHints, never logged.
func offerNetworks(offer string, loopback bool) []netip.Prefix {
	var out []netip.Prefix
	for _, l := range strings.Split(offer, "\n") {
		f := strings.Fields(strings.TrimSpace(l))
		if len(f) < 8 || !strings.HasPrefix(f[0], "a=candidate:") || f[6] != "typ" {
			continue
		}
		a, err := netip.ParseAddr(f[4])
		if err != nil {
			continue // a .local name, or garbage
		}
		a = a.Unmap()
		switch f[7] {
		case "srflx", "prflx":
		case "host":
			if a.IsLoopback() && !loopback {
				continue
			}
			if !a.IsLoopback() && !publicAddr(a) {
				continue
			}
		default:
			continue
		}
		if a.IsUnspecified() || a.IsMulticast() {
			continue
		}
		n := clientNetwork(a)
		if !slicesContains(out, n) {
			out = append(out, n)
		}
		if len(out) >= gateMaxHints {
			break
		}
	}

	return out
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// publicAddr is true for an address that can be a client's public one.
func publicAddr(a netip.Addr) bool {
	return a.IsGlobalUnicast() && !a.IsPrivate() && !a.IsLinkLocalUnicast() && !cgnat.Contains(a)
}
