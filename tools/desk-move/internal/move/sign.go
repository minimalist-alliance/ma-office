package move

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// ClaimProof is the target desk's signature on a move claim (EXP-1; ma-platform contract desks.md, `targetKey` on
// `POST /v1/moves/claim`, 0.3.43): `{at, nonce, sig}`, made with the same key and in the same line format as
// `ma-selfhost`'s signed calls (selfhost.md §3), purpose `move`. It shows that whoever redeems the code holds the key
// of the desk the code was made for, so a code seen by someone else can't be used from another computer. The platform
// knows the public key from the pairing; the private key is read here and signed with, and is never sent, printed or
// logged.
type ClaimProof struct {
	At    string `json:"at"`
	Nonce string `json:"nonce"`
	Sig   string `json:"sig"`
}

const (
	proofPrefix  = "ma-selfhost/v1"
	proofPurpose = "move"
)

var b64u = base64.RawURLEncoding

// ClaimDigest is what the signature names beside the desk: the SHA-256 (hex) of the code as the platform stores it
// (12 characters, upper case, no hyphens), so the signature is good for this code and no other.
func ClaimDigest(normalizedCode string) string {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.ReplaceAll(normalizedCode, "-", ""))))

	return hex.EncodeToString(sum[:])
}

// SignClaim signs "ma-selfhost/v1\nmove\n<env>\n<public key>\n<at>\n<nonce>\n<code digest>:<targetDeskId>".
func SignClaim(key ed25519.PrivateKey, env, targetDeskID, normalizedCode string, now time.Time) (*ClaimProof, error) {
	nonce := make([]byte, 18)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	pub := b64u.EncodeToString(key.Public().(ed25519.PublicKey))
	at := now.UTC().Format("2006-01-02T15:04:05Z")
	n := b64u.EncodeToString(nonce)
	msg := strings.Join([]string{proofPrefix, proofPurpose, env, pub, at, n, ClaimDigest(normalizedCode) + ":" + targetDeskID}, "\n")

	return &ClaimProof{At: at, Nonce: n, Sig: b64u.EncodeToString(ed25519.Sign(key, []byte(msg)))}, nil
}

// ReadDeskKey reads the self-hosted desk's Ed25519 key, <dataRoot>/selfhost/key.pem (PKCS#8, as ma-selfhost writes it).
func ReadDeskKey(dataRoot string) (ed25519.PrivateKey, error) {
	f, err := os.OpenFile(filepath.Join(dataRoot, "selfhost", "key.pem"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, errors.New("this desk's key isn't there. Pair the desk with your office again (sudo ma-selfhost pair --wait), then run sudo ma-move")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 16*1024))
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("this desk's key can't be read")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("this desk's key can't be read")
	}
	ek, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("this desk's key isn't the kind a desk uses")
	}

	return ek, nil
}

// DeskSigner signs claims with the key on <dataRoot>/selfhost, in the desk's env.
func DeskSigner(dataRoot, env string, now func() time.Time) func(code, targetDeskID string) (*ClaimProof, error) {
	return func(code, targetDeskID string) (*ClaimProof, error) {
		key, err := ReadDeskKey(dataRoot)
		if err != nil {
			return nil, err
		}

		return SignClaim(key, env, targetDeskID, code, now())
	}
}
