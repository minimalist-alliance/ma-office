package e2e

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/client"
)

const guildID = "g-dev000000000"

// A Guild Desk end to end (task 48): members open sessions with their own ma-guild+jwt tokens through the gateway,
// deskd checks each and hands desk-rtc the member's id, desk-rtc counts each member's bytes and closes all of one
// member's sessions at once.
func TestGuildDeskMembers(t *testing.T) {
	s := startStack(t, stackOpts{shimArgs: []string{"--desk-kind", "guild"}, deskdArgs: []string{"--desk-kind", "guild"}})
	member := func(id string, dataOnly bool) *client.Conn {
		return s.dial(t, func(o *client.Options) { o.GuildID, o.MemberID, o.NoMediaOffer = guildID, id, dataOnly })
	}
	ana1 := member("gm-ana", true)
	ana2 := member("gm-ana", false) // the Desk app's own offer, audio and video included
	ben := member("gm-ben", true)
	s.waitSessions(t, 3, 5*time.Second)
	for _, c := range []*client.Conn{ana1, ana2, ben} {
		callOK(t, c, "desk.status.get", nil)
	}

	var st struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
			MemberID  string `json:"memberId"`
			BytesSent uint64 `json:"bytesSent"`
		} `json:"sessions"`
		Members []struct {
			MemberID  string `json:"memberId"`
			Sessions  int    `json:"sessions"`
			BytesSent uint64 `json:"bytesSent"`
		} `json:"members"`
	}
	if err := json.Unmarshal(callOK(t, ben, "test.rtc.stats", nil), &st); err != nil {
		t.Fatal(err)
	}
	byID := map[string]string{}
	for _, r := range st.Sessions {
		byID[r.SessionID] = r.MemberID
	}
	if len(st.Sessions) != 3 || byID[ana1.SessionID] != "gm-ana" || byID[ana2.SessionID] != "gm-ana" || byID[ben.SessionID] != "gm-ben" {
		t.Fatalf("sessions %+v", st.Sessions)
	}
	if len(st.Members) != 2 || st.Members[0].MemberID != "gm-ana" || st.Members[0].Sessions != 2 || st.Members[1].Sessions != 1 || st.Members[0].BytesSent == 0 {
		t.Fatalf("members %+v", st.Members)
	}

	// gm-ana leaves the guild: both of her sessions close at once, gm-ben's stays.
	callOK(t, ben, "test.member.close", map[string]any{"memberId": "gm-ana", "reason": "guild_removed"})
	for _, c := range []*client.Conn{ana1, ana2} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		reason, err := c.WaitClosed(ctx)
		cancel()
		if err != nil {
			t.Fatalf("%s still open: %v", c.SessionID, err)
		}
		t.Logf("%s closed: %s", c.SessionID, reason)
	}
	s.waitSessions(t, 1, 5*time.Second)
	callOK(t, ben, "desk.status.get", nil)

	// An owner's way in isn't there on a Guild Desk.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := client.Dial(ctx, client.Options{API: s.api, Gateway: s.gateway, DeskID: deskID, Transport: "udp"}); err == nil {
		t.Fatal("an owner's connect worked on a Guild Desk")
	}
}
