// Package ident is who a member is in Commons: on a guild desk, exactly what deskd verified from their token and
// passed in the relay's hello and caller frames (README, "On a guild desk"); in -dev, what the URL says.
package ident

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Roles, as deskd passes them.
const (
	Lead    = "lead" // the guild's Founder
	Officer = "officer"
	Member  = "member"
)

// Grants Commons checks. Everything else in a caller's list is kept but means nothing here.
const (
	Moderate     = "moderate"      // delete anyone's chat message
	ManageSpaces = "manage_spaces" // channels and Commons' settings
)

// Badges shown beside names: the member's tier, never anything about age.
const (
	BadgeOfficer = "officer"
	BadgeLead    = "lead" // shown as the Founder seal
)

// Caller is deskd's verified caller, as it sends it.
type Caller struct {
	Kind     string   `json:"kind"`
	MemberID *string  `json:"memberId"`
	Role     *string  `json:"role"`
	Grants   []string `json:"grants"`
	Name     *string  `json:"name"`
	Badge    *string  `json:"badge"`
	// AvatarURL is the member's checked profile picture, Platform's public avatar route (acct-picture), or absent.
	AvatarURL *string `json:"avatarUrl"`
	// AvatarRecipe is the member's built avatar, the avatar kit's recipe object (acct-avatar), or absent or null. A JSON
	// string holding the object is taken too.
	AvatarRecipe json.RawMessage `json:"avatarRecipe"`
	// Teen is in deskd's caller for services with age rules. Commons has none: it's never kept or shown.
	Teen bool `json:"teen"`
}

// Identity is what Commons keeps of a member.
type Identity struct {
	MemberID string
	Role     string
	Grants   []string
	Name     string
	Badge    string
	// Avatar is a checked profile picture's address, or "" (initials). Only Platform's public avatar route is kept.
	Avatar string
	// AvatarRecipe is a checked built-avatar recipe as compact JSON, or "" (no built avatar). See CleanRecipe.
	AvatarRecipe string
}

var avatarRe = regexp.MustCompile(`^https://[a-z0-9.-]{1,253}/v1/public/avatars/im_[a-z2-7]{26}$`)

// CleanAvatar returns the address if it is exactly Platform's public avatar route over https, else "".
func CleanAvatar(s string) string {
	if avatarRe.MatchString(s) {
		return s
	}
	return ""
}

const maxRecipeBytes = 600

var (
	recipeIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	// The kit's keys (packages/avatar-kit, kit 1): ids are strings, colors are palette indexes, extras a short list of ids.
	recipeIDKeys    = map[string]bool{"face": true, "eyes": true, "brows": true, "nose": true, "hair": true, "facial": true, "top": true, "headwear": true, "glasses": true}
	recipeColorKeys = map[string]bool{"skin": true, "hairColor": true, "topColor": true, "headwearColor": true, "glassesColor": true, "extraColor": true, "bg": true}
)

// CleanRecipe returns the recipe as compact JSON if it is a built-avatar recipe of kit 1 (a JSON object of at most 600
// bytes with only the kit's keys: kind "built", kit 1, ids as short lowercase words, colors as small whole numbers,
// extras as up to six ids), else "". Whether an id exists is the kit's business: it draws an unknown one as the default.
func CleanRecipe(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '"' { // a string holding the object
		var inner string
		if json.Unmarshal(raw, &inner) != nil {
			return ""
		}
		raw = bytes.TrimSpace([]byte(inner))
	}
	if len(raw) == 0 || len(raw) > maxRecipeBytes || raw[0] != '{' {
		return ""
	}
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if dec.Decode(&m) != nil || dec.More() {
		return ""
	}
	if len(m) > 20 {
		return ""
	}
	for k, v := range m {
		switch {
		case k == "kind":
			if string(v) != `"built"` {
				return ""
			}
		case k == "kit":
			if string(v) != "1" {
				return ""
			}
		case recipeIDKeys[k]:
			var s string
			if json.Unmarshal(v, &s) != nil || !recipeIDRe.MatchString(s) {
				return ""
			}
		case recipeColorKeys[k]:
			var n int
			if json.Unmarshal(v, &n) != nil || n < 0 || n > 63 || bytes.ContainsAny(v, ".eE") {
				return ""
			}
		case k == "extras":
			var l []string
			if json.Unmarshal(v, &l) != nil || len(l) > 6 {
				return ""
			}
			for _, s := range l {
				if !recipeIDRe.MatchString(s) {
					return ""
				}
			}
		default:
			return ""
		}
	}
	if _, ok := m["kind"]; !ok {
		return ""
	}
	if _, ok := m["kit"]; !ok {
		return ""
	}
	var out bytes.Buffer
	if json.Compact(&out, raw) != nil || out.Len() > maxRecipeBytes {
		return ""
	}
	return out.String()
}

var memberRe = regexp.MustCompile(`^[a-z][a-z0-9-]{2,63}$`)

// ErrCaller is a caller Commons can't take.
var ErrCaller = errors.New("ident: not a guild member caller")

// Identity checks a caller and returns what Commons keeps of it.
func (c Caller) Identity() (Identity, error) {
	if c.Kind != "guild_member" || c.MemberID == nil || !memberRe.MatchString(*c.MemberID) || c.Role == nil {
		return Identity{}, ErrCaller
	}
	id := Identity{MemberID: *c.MemberID, Role: *c.Role}
	switch id.Role {
	case Lead, Officer, Member:
	default:
		return Identity{}, ErrCaller
	}
	if c.Name != nil {
		id.Name = CleanName(*c.Name)
	}
	if id.Name == "" {
		id.Name = "Member"
	}
	if c.Badge != nil && (*c.Badge == BadgeOfficer || *c.Badge == BadgeLead) {
		id.Badge = *c.Badge
	}
	if c.AvatarURL != nil {
		id.Avatar = CleanAvatar(*c.AvatarURL)
	}
	id.AvatarRecipe = CleanRecipe(c.AvatarRecipe)
	for _, g := range c.Grants {
		if len(g) <= 32 && len(id.Grants) < 16 {
			id.Grants = append(id.Grants, g)
		}
	}
	return id, nil
}

// Can says whether the member holds a grant. The Founder holds every grant and a member none, whatever the list
// says, as deskd computes them.
func (id Identity) Can(grant string) bool {
	switch id.Role {
	case Lead:
		return true
	case Officer:
		for _, g := range id.Grants {
			if g == grant {
				return true
			}
		}
	}
	return false
}

// CleanName drops control characters and trims a display name to 40 characters.
func CleanName(s string) string {
	s = strings.TrimSpace(strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f || (c >= 0x80 && c < 0xa0) || c == 0x2028 || c == 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) {
			return -1
		}
		return c
	}, s))
	if r := []rune(s); len(r) > 40 {
		s = strings.TrimSpace(string(r[:40]))
	}
	return s
}
