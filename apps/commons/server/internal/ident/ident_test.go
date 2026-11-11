package ident

import (
	"encoding/json"
	"strings"
	"testing"
)

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

func TestAvatarKeepsOnlyPlatformsCheckedRoute(t *testing.T) {
	ok := "https://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2"
	c := Caller{Kind: "guild_member", MemberID: str("gm-c2d3f6h2j5k7"), Role: str("member"), AvatarURL: str(ok)}
	if id, err := c.Identity(); err != nil || id.Avatar != ok {
		t.Fatalf("kept: %+v %v", id, err)
	}
	for _, bad := range []string{"", "http://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2", "https://api.example.test/x.png", ok + "?a=1", "data:image/png;base64,AAAA", "https://a/v1/public/avatars/im_short"} {
		c.AvatarURL = str(bad)
		if id, _ := c.Identity(); id.Avatar != "" {
			t.Fatalf("kept %q", bad)
		}
	}
}

func TestRecipeKeepsOnlyAKitOneBuiltRecipe(t *testing.T) {
	good := `{"kind":"built","kit":1,"skin":4,"face":"smile","hair":"wavy","extras":["freckles","moles"],"bg":3}`
	c := Caller{Kind: "guild_member", MemberID: str("gm-c2d3f6h2j5k7"), Role: str("member"), AvatarRecipe: json.RawMessage(" " + good + " ")}
	if id, err := c.Identity(); err != nil || id.AvatarRecipe != good {
		t.Fatalf("kept: %+v %v", id, err)
	}
	quoted, _ := json.Marshal(good)
	if got := CleanRecipe(quoted); got != good {
		t.Fatalf("string form: %q", got)
	}
	long := `{"kind":"built","kit":1,"face":"` + strings.Repeat("a", 600) + `"}`
	for _, bad := range []string{
		``, `null`, `[]`, `"x"`, `5`, `{}`,
		`{"kind":"built"}`, `{"kit":1}`,
		`{"kind":"upload","kit":1}`, `{"kind":"built","kit":2}`, `{"kind":"built","kit":"1"}`, `{"kind":"built","kit":1.0}`,
		`{"kind":"built","kit":1,"evil":"x"}`, `{"kind":"built","kit":1,"url":"https://x.test/a.png"}`,
		`{"kind":"built","kit":1,"face":"<svg onload=1>"}`, `{"kind":"built","kit":1,"face":"Smile"}`, `{"kind":"built","kit":1,"face":4}`,
		`{"kind":"built","kit":1,"skin":-1}`, `{"kind":"built","kit":1,"skin":64}`, `{"kind":"built","kit":1,"skin":1.5}`, `{"kind":"built","kit":1,"skin":"4"}`,
		`{"kind":"built","kit":1,"extras":"a"}`, `{"kind":"built","kit":1,"extras":["a","b","c","d","e","f","g"]}`, `{"kind":"built","kit":1,"extras":[{"a":1}]}`,
		`{"kind":"built","kit":1}{"kind":"built","kit":1}`, `{"kind":"built","kit":1} x`, long,
	} {
		if got := CleanRecipe(json.RawMessage(bad)); got != "" {
			t.Fatalf("kept %q as %q", bad, got)
		}
	}
	if got := CleanRecipe(json.RawMessage(`{"kind":"built","kit":1}`)); got != `{"kind":"built","kit":1}` {
		t.Fatalf("minimal: %q", got)
	}
}
