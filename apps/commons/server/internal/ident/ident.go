// Package ident is who a member is in Commons: on a guild desk, exactly what deskd verified from their token and
// passed in the relay's hello and caller frames (README, "On a guild desk"); in -dev, what the URL says.
package ident

import (
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
