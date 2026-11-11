package rtcserver

import (
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// A shared host's slot (shared.go): the host's address on both candidates, UDP on the slot's port, TCP on 443's stand-in,
// and every local ufrag tagged with the slot, the first and each ICE restart's.

const hostIP = "203.0.113.9"

func candidatesOf(sdp string) [][]string {
	var out [][]string
	for _, l := range strings.Split(sdp, "\r\n") {
		if strings.HasPrefix(l, "a=candidate:") {
			out = append(out, strings.Fields(l))
		}
	}

	return out
}

func TestSharedSlotAnswerNamesTheHostAndTagsTheUfrag(t *testing.T) {
	tcpPort := freePort(t)
	f := startServerWith(t, 30*time.Second, func(c *Config) {
		c.SharedSlot, c.PublicIPv4, c.TCPPort = 7, hostIP, tcpPort
	})
	d := f.deskd()
	d.configure(docIP, 4) // deskd's address (the stand-in's) differs: the candidates still name the host's
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	m := d.expect("session.answer", "cs-a", 5*time.Second)

	cands := candidatesOf(m.Answer)
	if len(cands) != 2 {
		t.Fatalf("want exactly 2 candidates, got %d: %v", len(cands), cands)
	}
	for _, c := range cands {
		want := strconv.Itoa(f.port)
		if strings.EqualFold(c[2], "tcp") {
			want = strconv.Itoa(tcpPort)
			if !strings.Contains(strings.Join(c, " "), "tcptype passive") {
				t.Errorf("tcp candidate isn't passive: %v", c)
			}
		}
		if c[4] != hostIP || c[5] != want || c[7] != "host" {
			t.Errorf("candidate %v: want host %s:%s", c, hostIP, want)
		}
	}
	ufrag, pwd := iceCredentials(m.Answer)
	if !strings.HasPrefix(ufrag, "s07") || len(ufrag) != 16 || SlotOfUfrag(ufrag) != 7 || len(pwd) != 32 {
		t.Fatalf("ufrag %q (password %d long): want s07 and 13 more, slot 7", ufrag, len(pwd))
	}
	p.answer(m.Answer)

	// An ICE restart: new credentials, the same tag.
	restart, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.pc.SetLocalDescription(restart); err != nil {
		t.Fatal(err)
	}
	d.send(&rtcsock.Message{T: "session.ice_restart", SessionID: "cs-a", Offer: restart.SDP})
	again := d.expect("session.answer", "cs-a", 5*time.Second)
	u2, p2 := iceCredentials(again.Answer)
	if !strings.HasPrefix(u2, "s07") || len(u2) != 16 || u2 == ufrag || p2 == pwd {
		t.Fatalf("after the restart ufrag %q (was %q), password changed %v: want a new s07 ufrag and password", u2, ufrag, p2 != pwd)
	}
	for _, c := range candidatesOf(again.Answer) {
		if c[4] != hostIP {
			t.Errorf("after the restart, candidate %v doesn't name the host", c)
		}
	}
}

// A member behind a network that blocks UDP: ICE over TCP alone, to the slot's TCP port (443 on a host), with the tagged
// ufrag in its first request, through the gate, and every channel opens.
func TestSharedSlotConnectsOverTCPAlone(t *testing.T) {
	tcpPort := freePort(t)
	f := startServerWith(t, 30*time.Second, func(c *Config) {
		c.SharedSlot, c.PublicIPv4, c.TCPPort = 3, "127.0.0.1", tcpPort
	})
	// TCP only on the TCP port, UDP only on the slot's port.
	if c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)), time.Second); err == nil {
		_ = c.Close()
		t.Fatalf("something takes TCP on the UDP port %d", f.port)
	}
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p := newPeer(t, peerOpts{tcpOnly: true})
	d.send(createMsg("cs-t", p))
	ans := d.expect("session.answer", "cs-t", 5*time.Second)
	ufrag, _ := iceCredentials(ans.Answer)
	if SlotOfUfrag(ufrag) != 3 {
		t.Fatalf("ufrag %q isn't slot 3's", ufrag)
	}
	p.answer(ans.Answer)
	p.waitOpen(15 * time.Second)
	pair, err := p.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Remote.Protocol != webrtc.ICEProtocolTCP || pair.Remote.Port != uint16(tcpPort) {
		t.Fatalf("selected pair %v (%v): want TCP to port %d", pair, err, tcpPort)
	}
	if f.srv.gate.refusedAuth.Load() != 0 {
		t.Fatalf("the gate refused %d signed first frames", f.srv.gate.refusedAuth.Load())
	}
}

// The demux's rule (image/host/desk-ice-demux reads the same two digits): s01 to s32 name a slot, nothing else does, and
// Pion's own ufrags (letters only) never do.
func TestSlotTags(t *testing.T) {
	for k := 1; k <= MaxSharedSlot; k++ {
		p := SlotUfragPrefix(k)
		if len(p) != 3 || SlotOfUfrag(p+"abcdefghijklm") != k {
			t.Fatalf("slot %d: prefix %q, read back %d", k, p, SlotOfUfrag(p+"abcdefghijklm"))
		}
	}
	for _, k := range []int{-1, 0, 33, 100} {
		if SlotUfragPrefix(k) != "" {
			t.Fatalf("slot %d has a prefix", k)
		}
	}
	for _, u := range []string{"", "s0", "s01", "s00abcdefghijklm", "s33abcdefghijklm", "S01abcdefghijklm", "sx1abcdefghijklm",
		"cmnsabcdefghijkl", "abcdefghijklmnop", "s-1abcdefghijklm", "s1aabcdefghijklm"} {
		if SlotOfUfrag(u) != 0 {
			t.Fatalf("%q reads as slot %d", u, SlotOfUfrag(u))
		}
	}
}

// A desk of its own: ufrags carry no slot, TCP is on the UDP port, the candidates are configure's.
func TestADeskOfItsOwnIsUnchanged(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure(docIP, 4)
	for i := range 20 {
		p := newPeer(t, peerOpts{})
		id := "cs-" + strconv.Itoa(i)
		d.send(createMsg(id, p))
		m := d.expect("session.answer", id, 5*time.Second)
		ufrag, _ := iceCredentials(m.Answer)
		if SlotOfUfrag(ufrag) != 0 || len(ufrag) != 16 {
			t.Fatalf("ufrag %q on a desk of its own", ufrag)
		}
		for _, c := range candidatesOf(m.Answer) {
			if c[4] != docIP || c[5] != strconv.Itoa(f.port) {
				t.Fatalf("candidate %v", c)
			}
		}
		d.send(&rtcsock.Message{T: "session.close", SessionID: id, Reason: "closed_by_desk"})
		d.expect("session.closed", id, 5*time.Second)
	}
}

func TestSharedSettingsAreChecked(t *testing.T) {
	for _, c := range []Config{
		{SharedSlot: 3},                         // no public address
		{PublicIPv4: hostIP},                    // no slot
		{SharedSlot: 33, PublicIPv4: hostIP},    // past 4462
		{SharedSlot: -1, PublicIPv4: hostIP},    // no such slot
		{SharedSlot: 3, PublicIPv4: "::1"},      // not IPv4
		{SharedSlot: 3, PublicIPv4: "0.0.0.0"},  // unspecified
		{SharedSlot: 3, PublicIPv4: "1.2.3.04"}, // not canonical
		{SharedSlot: 3, PublicIPv4: hostIP, TCPPort: 70000},
	} {
		if err := validateShared(c); err == nil {
			t.Errorf("%+v was taken", c)
		}
	}
	for _, c := range []Config{{}, {TCPPort: 443}, {SharedSlot: 1, PublicIPv4: hostIP, TCPPort: 443}, {SharedSlot: 32, PublicIPv4: hostIP}} {
		if err := validateShared(c); err != nil {
			t.Errorf("%+v: %v", c, err)
		}
	}
}

// The gate sees the first frame's USERNAME as the demux does: the desk's ufrag (the tag) before the colon.
func TestTheTagIsTheFirstUfragOfTheUsername(t *testing.T) {
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest, stun.NewUsername("s05abcdefghijklm:clnt"), stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	var u stun.Username
	if err := u.GetFrom(msg); err != nil {
		t.Fatal(err)
	}
	local, _, _ := strings.Cut(u.String(), ":")
	if SlotOfUfrag(local) != 5 {
		t.Fatalf("username %q: slot %d", u.String(), SlotOfUfrag(local))
	}
}
