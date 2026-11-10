package move

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeKey(t *testing.T, root string) ed25519.PublicKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(root, "selfhost/key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)

	return pub
}

func TestSignClaimIsTheDesksSignatureOverThisCode(t *testing.T) {
	root := t.TempDir()
	pub := writeKey(t, root)
	at := time.Date(2026, 11, 8, 20, 0, 0, 0, time.UTC)
	p, err := DeskSigner(root, "staging", func() time.Time { return at })("ABCD-EFGH-JKMN", "d-target000001")
	if err != nil {
		t.Fatal(err)
	}
	if p.At != "2026-11-08T20:00:00Z" || p.Nonce == "" {
		t.Fatalf("envelope: %+v", p)
	}
	pubB := b64u.EncodeToString(pub)
	sig, _ := b64u.DecodeString(p.Sig)
	msg := strings.Join([]string{"ma-selfhost/v1", "move", "staging", pubB, p.At, p.Nonce,
		ClaimDigest("ABCD-EFGH-JKMN") + ":d-target000001"}, "\n")
	if !ed25519.Verify(pub, []byte(msg), sig) {
		t.Fatal("the signature doesn't verify over the documented message")
	}
	// Another code, another desk, another env: another message.
	for _, other := range []string{
		strings.Replace(msg, ":d-target000001", ":d-target000002", 1),
		strings.Replace(msg, ClaimDigest("ABCD-EFGH-JKMN"), ClaimDigest("ABCD-EFGH-JKMP"), 1),
		strings.Replace(msg, "staging", "prod", 1),
	} {
		if ed25519.Verify(pub, []byte(other), sig) {
			t.Fatal("the signature also fits another claim")
		}
	}
	if ClaimDigest("ABCD-EFGH-JKMN") != ClaimDigest("ABCDEFGHJKMN") {
		t.Fatal("hyphens must not change the digest")
	}
	b, _ := os.ReadFile(filepath.Join(root, "selfhost/key.pem"))
	if strings.Contains(p.Sig+p.Nonce, string(b[:20])) {
		t.Fatal("the key leaked into the proof")
	}
}

func TestSignClaimWithoutAKey(t *testing.T) {
	_, err := DeskSigner(t.TempDir(), "staging", time.Now)("ABCD-EFGH-JKMN", "d-target000001")
	if err == nil || !strings.Contains(err.Error(), "key isn't there") {
		t.Fatalf("error: %v", err)
	}
	root := t.TempDir()
	put(t, filepath.Join(root, "selfhost/key.pem"), []byte("not a key"), 0o600)
	if _, err := DeskSigner(root, "staging", time.Now)("ABCD-EFGH-JKMN", "d-x"); err == nil || strings.Contains(err.Error(), "not a key") {
		t.Fatalf("error: %v", err)
	}
}

func TestTheMoveClaimsWithTheDesksProof(t *testing.T) {
	h := newHarness(t)
	keys := t.TempDir()
	pub := writeKey(t, keys)
	h.env.SignClaim = DeskSigner(keys, "staging", time.Now)
	if code := h.run(t.Context()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if len(h.api.proofs) != 1 || h.api.proofs[0] == nil {
		t.Fatalf("proofs: %+v", h.api.proofs)
	}
	p := h.api.proofs[0]
	sig, _ := b64u.DecodeString(p.Sig)
	msg := strings.Join([]string{"ma-selfhost/v1", "move", "staging", b64u.EncodeToString(pub), p.At, p.Nonce, ClaimDigest("ABCD-EFGH-JKMN") + ":" + targetDesk}, "\n")
	if !ed25519.Verify(pub, []byte(msg), sig) {
		t.Fatal("the claim's signature doesn't verify for the code and desk the run used")
	}
}
