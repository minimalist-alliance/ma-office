package devtoken

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func claims(now time.Time) *Claims {
	return &Claims{
		Iss: "iss", Aud: "d-1", Sub: "u", Scope: "owner", Sid: "s", Jti: "j",
		Iat: now.Unix(), Nbf: now.Unix(), Exp: now.Unix() + 300, AuthTime: now.Unix(),
		Cnf: Cnf{X5tS256: "abc"}, MaOwner: "u", MaKind: "personal", MaName: "Dev",
	}
}

func TestVerify(t *testing.T) {
	s, err := NewSigner()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	want := Expect{Issuer: "iss", DeskID: "d-1", Owner: "u", Now: now}

	tok, err := s.Sign(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(tok, s.JWKS(), want); err != nil {
		t.Fatalf("good token: %v", err)
	}

	other := want
	other.DeskID = "d-2"
	if _, err := Verify(tok, s.JWKS(), other); !errors.Is(err, ErrWrongDesk) {
		t.Fatalf("wrong desk: %v", err)
	}

	late := want
	late.Now = now.Add(331 * time.Second)
	if _, err := Verify(tok, s.JWKS(), late); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expired: %v", err)
	}

	parts := strings.Split(tok, ".")
	tampered := parts[0] + "." + parts[1] + "." + parts[0]
	if _, err := Verify(tampered, s.JWKS(), want); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered: %v", err)
	}

	stranger, err := NewSigner()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(tok, stranger.JWKS(), want); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("unknown key: %v", err)
	}
}

func TestFingerprintForms(t *testing.T) {
	raw, err := ParseClientFingerprint("sha-256 7A:1C:3E:9B:0D:55:2F:61:C8:44:E0:12:9A:B7:3D:F6:08:91:CE:2A:5B:7F:13:D4:66:A0:BC:39:E5:07:F2:8C")
	if err != nil {
		t.Fatal(err)
	}
	// The contract's own example of the same 32 bytes in cnf form.
	if got := CnfFromBytes(raw); got != "ehw-mw1VL2HIROASmrc99giRzipbfxPUZqC8OeUH8ow" {
		t.Fatalf("cnf %s", got)
	}
	h, err := CnfToHex("ehw-mw1VL2HIROASmrc99giRzipbfxPUZqC8OeUH8ow")
	if err != nil {
		t.Fatal(err)
	}
	if h != "7a1c3e9b0d552f61c844e0129ab73df60891ce2a5b7f13d466a0bc39e507f28c" {
		t.Fatalf("hex %s", h)
	}
	if _, err := ParseClientFingerprint("sha-1 AA:BB"); err == nil {
		t.Fatal("sha-1 accepted")
	}
}

func guildClaims(now time.Time) *Claims {
	grants := []string{"moderate"}
	teen := false

	return &Claims{
		Iss: "iss", Aud: "d-g", Sub: "gm-c2d3f6h2j5k7", Scope: ScopeGuildMember, Sid: "s", Jti: "j",
		Iat: now.Unix(), Nbf: now.Unix(), Exp: now.Unix() + 300, AuthTime: now.Unix(),
		Cnf: Cnf{X5tS256: "abc"}, MaGid: "g-1", MaGrole: "officer", MaGrants: &grants, MaName: "Ana", MaTeen: &teen,
	}
}

// A Guild Desk's member token (task 48): its own typ, so neither kind of desk takes the other's token.
func TestVerifyGuild(t *testing.T) {
	s, err := NewSigner()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	want := ExpectGuild{Issuer: "iss", DeskID: "d-g", GuildID: "g-1", Now: now}
	tok, err := s.SignGuild(guildClaims(now))
	if err != nil {
		t.Fatal(err)
	}
	c, err := VerifyGuild(tok, s.JWKS(), want)
	if err != nil {
		t.Fatalf("good token: %v", err)
	}
	if c.Sub != "gm-c2d3f6h2j5k7" || c.MaGrole != "officer" || c.MaGrants == nil || (*c.MaGrants)[0] != "moderate" || c.MaOwner != "" {
		t.Fatalf("claims %+v", c)
	}
	if _, err := Verify(tok, s.JWKS(), Expect{Issuer: "iss", DeskID: "d-g", Now: now}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("a guild token on a desk: %v", err)
	}
	desk, err := s.Sign(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyGuild(desk, s.JWKS(), ExpectGuild{Issuer: "iss", DeskID: "d-1", Now: now}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("a desk token on a Guild Desk: %v", err)
	}

	other := want
	other.GuildID = "g-2"
	if _, err := VerifyGuild(tok, s.JWKS(), other); !errors.Is(err, ErrWrongDesk) {
		t.Fatalf("another guild: %v", err)
	}
	other = want
	other.DeskID = "d-2"
	if _, err := VerifyGuild(tok, s.JWKS(), other); !errors.Is(err, ErrWrongDesk) {
		t.Fatalf("another desk: %v", err)
	}
	for name, edit := range map[string]func(*Claims){
		"scope":   func(c *Claims) { c.Scope = "owner" },
		"no sub":  func(c *Claims) { c.Sub = "" },
		"no gid":  func(c *Claims) { c.MaGid = "" },
		"role":    func(c *Claims) { c.MaGrole = "admin" },
		"no cnf":  func(c *Claims) { c.Cnf.X5tS256 = "" },
		"expired": func(c *Claims) { c.Iat -= 400; c.Nbf -= 400; c.Exp -= 400 },
	} {
		c := guildClaims(now)
		edit(c)
		bad, err := s.SignGuild(c)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyGuild(bad, s.JWKS(), want); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}
