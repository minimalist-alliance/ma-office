// Package devtoken mints and checks ma-desk+jwt tokens, and a Guild Desk's ma-guild+jwt, with a dev ES256 key
// (auth.md section 4; the guild token's claims are ~/ma-coord/guild-eng.md section 3.2's, task 48). Dev tooling only:
// Platform signs real tokens with KMS.
package devtoken

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// TokenType is the JWT typ of a desk token.
const TokenType = "ma-desk+jwt"

// GuildTokenType is the JWT typ of a Guild Desk member's token, and ScopeGuildMember its only scope.
const (
	GuildTokenType   = "ma-guild+jwt"
	ScopeGuildMember = "guild_member"
)

// Guild roles (ma_grole) and the grants an officer can hold (ma_grants). A lead has every grant.
var (
	GuildRoles  = []string{"lead", "officer", "member"}
	GuildGrants = []string{"moderate", "invite", "remove_member", "manage_spaces", "manage_agents"}
)

// Cnf binds a token to a DTLS certificate.
type Cnf struct {
	X5tS256 string `json:"x5t#S256"`
}

// Claims are the desk token's claims.
type Claims struct {
	Iss            string `json:"iss"`
	Aud            string `json:"aud"`
	Sub            string `json:"sub"`
	Scope          string `json:"scope"`
	Sid            string `json:"sid"`
	Jti            string `json:"jti"`
	Iat            int64  `json:"iat"`
	Nbf            int64  `json:"nbf"`
	Exp            int64  `json:"exp"`
	AuthTime       int64  `json:"auth_time"`
	Cnf            Cnf    `json:"cnf"`
	MaOwner        string `json:"ma_owner,omitempty"`
	MaKind         string `json:"ma_kind,omitempty"`
	MaName         string `json:"ma_name,omitempty"`
	MaSupportUntil string `json:"ma_support_until,omitempty"`

	// A guild token's (ma-guild+jwt): sub is the gm- member id, scope guild_member. A desk token has none of them.
	MaGid    string    `json:"ma_gid,omitempty"`
	MaGrole  string    `json:"ma_grole,omitempty"`
	MaGrants *[]string `json:"ma_grants,omitempty"`
	MaBadge  *string   `json:"ma_badge,omitempty"`
	MaTeen   *bool     `json:"ma_teen,omitempty"`
}

// JWK is one public key.
type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// JWKS is the key set document.
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// Signer holds a dev signing key.
type Signer struct {
	key *ecdsa.PrivateKey
	kid string
}

var b64 = base64.RawURLEncoding

// NewSigner makes a fresh key. Its kid comes from the key, so a restart looks like a key rotation.
func NewSigner() (*Signer, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	x := key.PublicKey.X.Bytes()
	sum := sha256.Sum256(x)

	return &Signer{key: key, kid: "dev-" + hex.EncodeToString(sum[:4])}, nil
}

// JWKS returns the public key set.
func (s *Signer) JWKS() JWKS {
	coord := func(v *big.Int) string {
		buf := make([]byte, 32)
		v.FillBytes(buf)

		return b64.EncodeToString(buf)
	}

	return JWKS{Keys: []JWK{{
		Kty: "EC", Crv: "P-256", Kid: s.kid, Use: "sig", Alg: "ES256",
		X: coord(s.key.PublicKey.X), Y: coord(s.key.PublicKey.Y),
	}}}
}

// Sign returns a compact JWS: a desk token.
func (s *Signer) Sign(c *Claims) (string, error) { return s.sign(TokenType, c) }

// SignGuild returns a Guild Desk member's token, typ ma-guild+jwt.
func (s *Signer) SignGuild(c *Claims) (string, error) { return s.sign(GuildTokenType, c) }

func (s *Signer) sign(typ string, c *Claims) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "ES256", "typ": typ, "kid": s.kid})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := b64.EncodeToString(header) + "." + b64.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signingInput))
	r, sig, err := ecdsa.Sign(rand.Reader, s.key, digest[:])
	if err != nil {
		return "", err
	}
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	sig.FillBytes(raw[32:])

	return signingInput + "." + b64.EncodeToString(raw), nil
}

// Rejection codes of auth.md section 4.4.
var (
	ErrInvalidToken = errors.New("invalid_token")
	ErrWrongDesk    = errors.New("wrong_desk")
)

// Expect is what Verify checks claims against.
type Expect struct {
	Issuer string
	DeskID string
	Owner  string // empty skips the check
	Now    time.Time
}

// Verify runs auth.md section 4.4 rows 1-7 and 9 (cnf present). Revocation (row 8) is not modeled.
func Verify(token string, keys JWKS, want Expect) (*Claims, error) {
	c, err := verifyTyped(token, keys, want, TokenType)
	if err != nil {
		return nil, err
	}
	if c.Scope != "owner" && c.Scope != "support" {
		return nil, fmt.Errorf("%w: scope", ErrInvalidToken)
	}
	if want.Owner != "" && c.MaOwner != want.Owner {
		return nil, fmt.Errorf("%w: ma_owner", ErrWrongDesk)
	}

	return c, nil
}

// ExpectGuild is what VerifyGuild checks a member's token against.
type ExpectGuild struct {
	Issuer  string
	DeskID  string // the Guild Desk's id: the token's aud
	GuildID string // empty skips the check of ma_gid
	Now     time.Time
}

// VerifyGuild checks a Guild Desk member's token as Verify does a desk token: typ ma-guild+jwt, the same key, issuer,
// aud, times and cnf, then scope guild_member, a sub, ma_gid and a known ma_grole. A desk token is refused here, and a
// guild token by Verify, so neither kind of desk takes the other's.
func VerifyGuild(token string, keys JWKS, want ExpectGuild) (*Claims, error) {
	c, err := verifyTyped(token, keys, Expect{Issuer: want.Issuer, DeskID: want.DeskID, Now: want.Now}, GuildTokenType)
	if err != nil {
		return nil, err
	}
	if c.Scope != ScopeGuildMember {
		return nil, fmt.Errorf("%w: scope", ErrInvalidToken)
	}
	if c.Sub == "" {
		return nil, fmt.Errorf("%w: sub", ErrInvalidToken)
	}
	if c.MaGid == "" || (want.GuildID != "" && c.MaGid != want.GuildID) {
		return nil, fmt.Errorf("%w: ma_gid", ErrWrongDesk)
	}
	known := false
	for _, r := range GuildRoles {
		known = known || c.MaGrole == r
	}
	if !known {
		return nil, fmt.Errorf("%w: ma_grole", ErrInvalidToken)
	}

	return c, nil
}

// verifyTyped runs the checks both kinds of token share.
func verifyTyped(token string, keys JWKS, want Expect, typ string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("%w: not a compact JWS", ErrInvalidToken)
	}
	headerBytes, err := b64.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("%w: header encoding", ErrInvalidToken)
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, fmt.Errorf("%w: header", ErrInvalidToken)
	}
	if header.Alg != "ES256" || header.Typ != typ {
		return nil, fmt.Errorf("%w: alg or typ", ErrInvalidToken)
	}
	var key *JWK
	for i := range keys.Keys {
		if keys.Keys[i].Kid == header.Kid {
			key = &keys.Keys[i]
		}
	}
	if key == nil {
		return nil, fmt.Errorf("%w: unknown kid", ErrInvalidToken)
	}
	if err := verifySignature(parts, key); err != nil {
		return nil, err
	}

	payload, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("%w: payload encoding", ErrInvalidToken)
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, fmt.Errorf("%w: payload", ErrInvalidToken)
	}
	if c.Iss != want.Issuer {
		return nil, fmt.Errorf("%w: iss", ErrInvalidToken)
	}
	if c.Aud != want.DeskID {
		return nil, fmt.Errorf("%w: aud", ErrWrongDesk)
	}
	now := want.Now
	if now.IsZero() {
		now = time.Now()
	}
	if now.Unix() < c.Nbf-30 || now.Unix() >= c.Exp+30 || c.Exp-c.Iat > 300 {
		return nil, fmt.Errorf("%w: outside its validity", ErrInvalidToken)
	}
	if c.Cnf.X5tS256 == "" {
		return nil, fmt.Errorf("%w: cnf missing", ErrInvalidToken)
	}

	return &c, nil
}

func verifySignature(parts []string, key *JWK) error {
	raw, err := b64.DecodeString(parts[2])
	if err != nil || len(raw) != 64 {
		return fmt.Errorf("%w: signature encoding", ErrInvalidToken)
	}
	x, errX := b64.DecodeString(key.X)
	y, errY := b64.DecodeString(key.Y)
	if errX != nil || errY != nil {
		return fmt.Errorf("%w: key encoding", ErrInvalidToken)
	}
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:])) {
		return fmt.Errorf("%w: signature", ErrInvalidToken)
	}

	return nil
}

// ParseClientFingerprint decodes connect's clientDtlsFingerprint ("sha-256 AA:BB:…"; hex case doesn't
// matter) to the 32 bytes.
func ParseClientFingerprint(s string) ([]byte, error) {
	alg, value, ok := strings.Cut(strings.TrimSpace(s), " ")
	if !ok || !strings.EqualFold(alg, "sha-256") {
		return nil, errors.New(`want "sha-256 " followed by the fingerprint`)
	}
	raw, err := hex.DecodeString(strings.ReplaceAll(value, ":", ""))
	if err != nil || len(raw) != 32 {
		return nil, errors.New("want 32 bytes of hex")
	}

	return raw, nil
}

// CnfFromBytes encodes a certificate hash as cnf's x5t#S256.
func CnfFromBytes(raw []byte) string { return b64.EncodeToString(raw) }

// CnfToHex converts cnf's x5t#S256 to the 64 lowercase hex chars rtc.sock wants.
func CnfToHex(cnf string) (string, error) {
	raw, err := b64.DecodeString(cnf)
	if err != nil || len(raw) != 32 {
		return "", errors.New("cnf is not 32 bytes of base64url")
	}

	return hex.EncodeToString(raw), nil
}
