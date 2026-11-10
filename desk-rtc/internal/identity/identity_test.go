package identity

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestCreatePersistAndMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rtc")
	first, err := LoadOrCreate(dir, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if len(first.FingerprintHex) != 64 {
		t.Fatalf("fingerprint %q", first.FingerprintHex)
	}
	if d := time.Until(first.NotAfter); d > 397*24*time.Hour || d < 390*24*time.Hour {
		t.Fatalf("validity %v", d)
	}
	path := filepath.Join(dir, FileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}

	second, err := LoadOrCreate(dir, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if second.FingerprintHex != first.FingerprintHex {
		t.Fatal("identity changed across a reload")
	}

	fps, err := second.Certificate.GetFingerprints()
	if err != nil || len(fps) == 0 {
		t.Fatalf("fingerprints: %v %v", fps, err)
	}
	var found bool
	for _, fp := range fps {
		if fp.Algorithm == "sha-256" {
			found = strings.EqualFold(strings.ReplaceAll(fp.Value, ":", ""), first.FingerprintHex)
		}
	}
	if !found {
		t.Fatalf("FingerprintHex %s isn't the certificate's sha-256 fingerprint %v", first.FingerprintHex, fps)
	}
}

func TestLooseModeIsFixed(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreate(dir, quiet()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, FileName)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(dir, quiet()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
}

func TestDamagedIdentityIsAnError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(dir, quiet()); err == nil {
		t.Fatal("want an error")
	}
}
