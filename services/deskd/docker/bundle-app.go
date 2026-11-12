// bundle-app lays out a first-party app as deskd bundles it in its image (deskd's API.md section 19, "Bundled apps"):
// exactly what a package unpacks to, ma-app.json and files/, with every file's SHA-256, size and mode filled into the
// manifest and arch set to this build's. deskd checks them all again at start. deskd's Dockerfile and its tests run it;
// it needs only Go's standard library, so `go run bundle-app.go` works anywhere Go does.
//
//	go run bundle-app.go -manifest apps/bible/ma-app.json -exec /tmp/bible \
//	    -add texts=apps/bible/texts -add view=apps/bible/view -out /out/bundled-apps
//
// -exec is the app's executable, placed at the manifest's run.exec[0] with mode 0755. Each -add copies a file, or a
// directory's tree, to files/<dest>: files 0644, or 0755 where the source is executable, directories 0755. A link, a
// special file, a duplicate path or an unclean one refuses. The manifest's other fields are kept as written, and so is
// its JSON's shape apart from arch and files. A declared window whose three files aren't there refuses too, so a build
// never ships a view that can't open. It writes <out>/<id>/, which must not exist yet.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type adds []string

func (a *adds) String() string     { return strings.Join(*a, ",") }
func (a *adds) Set(v string) error { *a = append(*a, v); return nil }

var idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$`)

type fileEntry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   string `json:"mode"`
}

func main() {
	manifestPath := flag.String("manifest", "", "the app's ma-app.json, with run.exec and no need for arch or files")
	exe := flag.String("exec", "", "the built executable, placed at run.exec[0]")
	arch := flag.String("arch", runtime.GOARCH, "arm64 or amd64: the arch the executable was built for")
	out := flag.String("out", "", "where <id>/ goes")
	var extra adds
	flag.Var(&extra, "add", "dest=src: a file or directory to copy to files/dest (repeatable)")
	flag.Parse()
	if err := run(*manifestPath, *exe, *arch, *out, extra); err != nil {
		fmt.Fprintln(os.Stderr, "bundle-app: "+err.Error())
		os.Exit(1)
	}
}

func run(manifestPath, exe, arch, out string, extra adds) error {
	if manifestPath == "" || exe == "" || out == "" {
		return errors.New("needs -manifest, -exec and -out")
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	id, _ := m["id"].(string)
	if !idPattern.MatchString(id) || len(id) > 64 {
		return errors.New("manifest: id")
	}
	runSection, _ := m["run"].(map[string]any)
	execList, _ := runSection["exec"].([]any)
	if len(execList) == 0 {
		return errors.New("manifest: run.exec")
	}
	execPath, _ := execList[0].(string)
	if !clean(execPath) {
		return errors.New("manifest: run.exec[0] must be a clean relative path")
	}

	dir := filepath.Join(out, id)
	if _, err := os.Lstat(dir); err == nil {
		return fmt.Errorf("%s exists", dir)
	}
	files := filepath.Join(dir, "files")
	if err := os.MkdirAll(files, 0o755); err != nil {
		return err
	}
	if err := fill(m, dir, files, execPath, exe, arch, extra); err != nil {
		os.RemoveAll(dir) // nothing half-made is left for a build to pick up
		return err
	}
	return nil
}

// fill copies the files, checks the window's, and writes the manifest with arch and files filled in.
func fill(m map[string]any, dir, files, execPath, exe, arch string, extra adds) error {
	entries := map[string]fileEntry{}
	if err := place(files, execPath, exe, true, entries); err != nil {
		return err
	}
	for _, a := range extra {
		dest, src, ok := strings.Cut(a, "=")
		if !ok || !clean(dest) {
			return fmt.Errorf("-add %q: want dest=src with a clean dest", a)
		}
		if err := add(files, dest, src, entries); err != nil {
			return err
		}
	}
	if views, _ := m["views"].(map[string]any); views != nil {
		if window, _ := views["window"].(map[string]any); window != nil {
			for _, key := range []string{"html", "script", "style"} {
				p, _ := window[key].(string)
				if _, ok := entries[p]; !ok {
					return fmt.Errorf("views.window.%s isn't in files/", key)
				}
			}
		}
	}
	m["arch"] = arch
	m["files"] = entries

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "ma-app.json"), buf.Bytes(), 0o644); err != nil {
		return err
	}
	// Whatever the umask took, the tree ends as deskd's check and the image want it.
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err
		}
		return os.Chmod(p, 0o755)
	})
}

// clean is the manifest's rule for a path: relative, /-separated, with no empty, . or .. part.
func clean(p string) bool {
	if p == "" || len(p) > 255 || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") || path.Clean(p) != p {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// add copies src, a file or a directory's tree, to files/dest.
func add(files, dest, src string, entries map[string]fileEntry) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode().IsRegular() {
		return place(files, dest, src, info.Mode()&0o111 != 0, entries)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s: not a file or directory", src)
	}
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("%s: a link or special file", p)
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		return place(files, path.Join(dest, filepath.ToSlash(rel)), p, fi.Mode()&0o111 != 0, entries)
	})
}

// place copies one file to files/rel, and records its hash, size and mode.
func place(files, rel, src string, executable bool, entries map[string]fileEntry) error {
	if !clean(rel) {
		return fmt.Errorf("%q: not a clean path", rel)
	}
	if _, dup := entries[rel]; dup {
		return fmt.Errorf("%q: twice", rel)
	}
	mode, perm := "0644", os.FileMode(0o644)
	if executable {
		mode, perm = "0755", 0o755
	}
	target := filepath.Join(files, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	outFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(outFile, h), in)
	if cerr := outFile.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := os.Chmod(target, perm); err != nil {
		return err
	}
	entries[rel] = fileEntry{SHA256: hex.EncodeToString(h.Sum(nil)), Size: n, Mode: mode}
	return nil
}
