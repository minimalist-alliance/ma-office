// Package identity loads or creates the desk's long-lived DTLS identity (desk-endpoint.md section 2):
// one ECDSA P-256 key and self-signed certificate on the data volume, key mode 0600.
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/pion/webrtc/v4"
)

// FileName is the identity's file inside the data directory.
const FileName = "dtls-identity.pem"

// validity is the contract's limit of 397 days.
const validity = 397 * 24 * time.Hour

// Identity is a loaded DTLS identity.
type Identity struct {
	Certificate webrtc.Certificate
	// FingerprintHex is sha256(DER) as 64 lowercase hex chars.
	FingerprintHex string
	NotAfter       time.Time
}

// LoadOrCreate returns the identity in dir, creating it when missing.
//
// TODO(rotation): desk-endpoint.md section 2 rotates when under 30 days remain, reporting
// [current, next] in hello. Until that lands, an expired certificate is replaced at startup, which
// changes the fingerprint the next hello registers. Pion refuses to use an expired certificate, so
// keeping it would leave the desk unable to accept any session.
func LoadOrCreate(dir string, log *slog.Logger) (*Identity, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("identity: %w", err)
	}
	path := filepath.Join(dir, FileName)

	id, err := load(path, log)
	switch {
	case err == nil && time.Now().Before(id.NotAfter):
		return id, nil
	case err == nil:
		log.Warn("DTLS certificate expired, replacing it", "notAfter", id.NotAfter)
		if err := os.Rename(path, path+".expired"); err != nil {
			return nil, fmt.Errorf("identity: %w", err)
		}
	case !errors.Is(err, os.ErrNotExist):
		// A damaged identity needs a person: replacing it silently would change the desk's fingerprint.
		return nil, err
	}

	if err := create(path); err != nil {
		return nil, err
	}
	log.Info("created DTLS identity", "path", path)

	return load(path, log)
}

func load(path string, log *slog.Logger) (*Identity, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("identity: %w", err)
	}
	if info.Mode().Perm() != 0o600 {
		log.Warn("DTLS identity had loose permissions, fixing", "mode", info.Mode().Perm().String())
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("identity: %w", err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("identity: %w", err)
	}

	var (
		key  *ecdsa.PrivateKey
		cert *x509.Certificate
	)
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		switch block.Type {
		case "EC PRIVATE KEY":
			if key, err = x509.ParseECPrivateKey(block.Bytes); err != nil {
				return nil, fmt.Errorf("identity: %s: %w", path, err)
			}
		case "CERTIFICATE":
			if cert, err = x509.ParseCertificate(block.Bytes); err != nil {
				return nil, fmt.Errorf("identity: %s: %w", path, err)
			}
		}
	}
	if key == nil || cert == nil {
		return nil, fmt.Errorf("identity: %s holds no key and certificate", path)
	}
	if key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("identity: %s is not P-256", path)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return nil, fmt.Errorf("identity: %s: certificate and key don't match", path)
	}

	sum := sha256.Sum256(cert.Raw)

	return &Identity{
		Certificate:    webrtc.CertificateFromX509(key, cert),
		FingerprintHex: hex.EncodeToString(sum[:]),
		NotAfter:       cert.NotAfter,
	}, nil
}

func create(path string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	notBefore := time.Now().Add(-time.Hour)
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "desk-rtc"},
		NotBefore:    notBefore,
		NotAfter:     notBefore.Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)

	tmp, err := os.CreateTemp(filepath.Dir(path), ".dtls-identity-*")
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	defer os.Remove(tmp.Name())
	// CreateTemp opens with mode 0600.
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()

		return fmt.Errorf("identity: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()

		return fmt.Errorf("identity: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("identity: %w", err)
	}

	return nil
}
