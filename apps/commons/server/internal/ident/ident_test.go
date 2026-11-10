package ident

import "testing"

func str(s string) *string { return &s }

func TestCallerAndGrants(t *testing.T) {
	c := Caller{Kind: "guild_member", MemberID: str("gm-c2d3f6h2j5k7"), Role: str("officer"), Grants: []string{"moderate"}, Name: str(" Ana‮ "), Badge: str("officer"), Teen: true}
	id, err := c.Identity()
	if err != nil {
		t.Fatal(err)
	}
	if id.Name != "Ana" || id.Badge != "officer" || !id.Can(Moderate) || id.Can(ManageSpaces) {
		t.Fatalf("officer: %+v", id)
	}
	c.Role = str("lead")
	c.Grants = nil
	if id, _ := c.Identity(); !id.Can(Moderate) || !id.Can(ManageSpaces) {
		t.Fatal("the Founder holds every grant")
	}
	c.Role = str("member")
	c.Grants = []string{"moderate", "manage_spaces"}
	if id, _ := c.Identity(); id.Can(Moderate) || id.Can(ManageSpaces) {
		t.Fatal("a member holds no grant, whatever the list says")
	}
	c.Badge = str("teen")
	if id, _ := c.Identity(); id.Badge != "" {
		t.Fatal("only officer and lead badges are kept")
	}
	for _, bad := range []Caller{
		{Kind: "owner", MemberID: str("gm-c2d3f6h2j5k7"), Role: str("member")},
		{Kind: "guild_member", Role: str("member")},
		{Kind: "guild_member", MemberID: str("gm-c2d3f6h2j5k7"), Role: str("admin")},
		{Kind: "guild_member", MemberID: str("GM bad"), Role: str("member")},
	} {
		if _, err := bad.Identity(); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}
