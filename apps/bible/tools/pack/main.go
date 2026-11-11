// pack builds a .maapp from an assembled files/ folder: the manifest template with arch and every file's SHA-256,
// size and mode filled in, the developer's Ed25519 signature over the manifest's exact bytes, and the tar.gz with
// ma-app.json and ma-app.sig first (the contract §1.1 and the Desk Engineer's review C2).
//
// It writes exactly what the sample's ma-app pack writes (spikes/app-contract-sample/internal/manifest.Write), but
// takes every file under files/: ma-app pack takes only the executable and view/, so it can't carry the texts. The
// key is a file from ma-app keygen, and the key id is the sample's (the first 8 bytes of SHA-256 over the raw key),
// so ma-app sign, trust and verify read the result. deskd computes key ids over the SubjectPublicKeyInfo instead
// (review C3): a package for a desk is signed by MA's pipeline, not by this.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
)

// The manifest's fields, in the sample's order (internal/manifest.Manifest), read strictly as deskd does.
type manifest struct {
	Manifest    int             `json:"manifest"`
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Publisher   string          `json:"publisher"`
	Description string          `json:"description"`
	Source      string          `json:"source"`
	License     string          `json:"license"`
	AppAPI      string          `json:"appApi"`
	Arch        string          `json:"arch"`
	Run         json.RawMessage `json:"run"`
	Resources   json.RawMessage `json:"resources"`
	Permissions []string        `json:"permissions"`
	Net         json.RawMessage `json:"net,omitempty"`
	Views       json.RawMessage `json:"views"`
	Methods     json.RawMessage `json:"methods"`
	Topics      []string        `json:"topics"`
	Files       map[string]file `json:"files"`
}

type file struct {
	SHA256 string `json:"sha256"`
	Mode   string `json:"mode"`
	Size   int64  `json:"size"`
}

type sigFile struct {
	Signatures []sig `json:"signatures"`
}

type sig struct {
	Role  string `json:"role"`
	KeyID string `json:"keyId"`
	Sig   string `json:"sig"`
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("pack: ")
	tmpl := flag.String("manifest", "ma-app.json", "the manifest template")
	dir := flag.String("files", "", "the assembled files/ folder")
	arch := flag.String("arch", "", "arm64 or amd64")
	key := flag.String("key", "", "the developer key, from ma-app keygen")
	out := flag.String("out", "", "the package to write")
	flag.Parse()
	if *dir == "" || *arch == "" || *key == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}

	var m manifest
	b, err := os.ReadFile(*tmpl)
	if err != nil {
		log.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		log.Fatalf("%s: %v", *tmpl, err)
	}
	m.Arch = *arch
	m.Files = map[string]file{}
	contents := map[string][]byte{}
	err = filepath.WalkDir(*dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("%s: only regular files go in a package", p)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(*dir, p)
		rel = filepath.ToSlash(rel)
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		mode := "0644"
		if info.Mode()&0o111 != 0 {
			mode = "0755"
		}
		sum := sha256.Sum256(data)
		m.Files[rel] = file{SHA256: hex.EncodeToString(sum[:]), Mode: mode, Size: int64(len(data))}
		contents[rel] = data
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		log.Fatal(err)
	}

	var k struct {
		PrivateKey string `json:"privateKey"`
	}
	kb, err := os.ReadFile(*key)
	if err == nil {
		err = json.Unmarshal(kb, &k)
	}
	priv, derr := base64.StdEncoding.DecodeString(k.PrivateKey)
	if err != nil || derr != nil || len(priv) != ed25519.PrivateKeySize {
		log.Fatalf("%s: not an Ed25519 key from ma-app keygen", *key)
	}
	pub := ed25519.PrivateKey(priv).Public().(ed25519.PublicKey)
	id := sha256.Sum256(pub)
	sigs := sigFile{Signatures: []sig{{Role: "developer", KeyID: hex.EncodeToString(id[:8]),
		Sig: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw))}}}
	sb, _ := json.MarshalIndent(sigs, "", "  ")

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	put := func(name string, mode int64, data []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(data)), Typeflag: tar.TypeReg, Format: tar.FormatPAX}); err != nil {
			log.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			log.Fatal(err)
		}
	}
	put("ma-app.json", 0o644, raw)
	put("ma-app.sig", 0o644, sb)
	names := make([]string, 0, len(contents))
	for n := range contents {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		mode := int64(0o644)
		if m.Files[n].Mode == "0755" {
			mode = 0o755
		}
		put("files/"+n, mode, contents[n])
	}
	if err := tw.Close(); err != nil {
		log.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
	var total int64
	for _, f := range m.Files {
		total += f.Size
	}
	fmt.Printf("%s: %d files, %.1f MiB unpacked, %.1f MiB packed\n", filepath.Base(*out), len(m.Files), float64(total)/(1<<20), float64(buf.Len())/(1<<20))
}
