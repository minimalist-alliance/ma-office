package move

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
)

// Entry is one data.manifest entry (draft ADR, section 7). Path and Target are bytes: a name that isn't UTF-8
// comes as desk-data's \udcXX escapes, which fsname turns back into the bytes they stand for. encoding/json
// would make each U+FFFD, another name, which data.read then can't find.
type Entry struct {
	Path    string
	Type    string // file, dir or link
	Size    int64
	MtimeMs int64
	Mode    FileMode
	Target  string
}

type entryJSON struct {
	Path    fsname.Name `json:"path"`
	Type    string      `json:"type"`
	Size    int64       `json:"size"`
	MtimeMs int64       `json:"mtimeMs"`
	Mode    FileMode    `json:"mode"`
	Target  fsname.Name `json:"target,omitempty"`
}

// UnmarshalJSON reads a manifest entry, its names byte for byte. A name that can't be carried is an error, which
// stops the move: it's never skipped.
func (e *Entry) UnmarshalJSON(b []byte) error {
	var w entryJSON
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*e = Entry{Path: string(w.Path), Type: w.Type, Size: w.Size, MtimeMs: w.MtimeMs, Mode: w.Mode, Target: string(w.Target)}

	return nil
}

// MarshalJSON writes it as the manifest does.
func (e Entry) MarshalJSON() ([]byte, error) {
	return json.Marshal(entryJSON{Path: fsname.Name(e.Path), Type: e.Type, Size: e.Size, MtimeMs: e.MtimeMs, Mode: e.Mode, Target: fsname.Name(e.Target)})
}

// FileMode is a manifest mode: a JSON number, or an octal string such as "0600".
type FileMode uint32

// UnmarshalJSON accepts both forms.
func (m *FileMode) UnmarshalJSON(b []byte) error {
	var n uint32
	if json.Unmarshal(b, &n) == nil {
		*m = FileMode(n)

		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	if s == "" {
		*m = 0

		return nil
	}
	v, err := strconv.ParseUint(s, 8, 32)
	if err != nil {
		return fmt.Errorf("mode %q: %w", s, err)
	}
	*m = FileMode(v)

	return nil
}

// Perm is the mode as this desk sets it: permission bits only. Set-id and sticky bits never come
// across from another machine.
func (m FileMode) Perm(fallback fs.FileMode) fs.FileMode {
	p := fs.FileMode(m) & 0o777
	if p == 0 {
		return fallback
	}

	return p
}

// validRel is a path inside a part: relative, /-separated, clean, never leaving the part.
func validRel(p string) bool {
	if p == "" || p == "." || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || path.Clean(p) != p {
		return false
	}
	for _, c := range strings.Split(p, "/") {
		if c == ".." || c == "." || c == "" {
			return false
		}
	}

	return true
}

// linkInside reports whether a link at rel pointing at target stays inside its part.
func linkInside(rel, target string) bool {
	if target == "" || strings.HasPrefix(target, "/") || strings.ContainsRune(target, 0) {
		return false
	}
	r := path.Clean(path.Join(path.Dir(rel), target))

	return r != ".." && !strings.HasPrefix(r, "../") && r != "."
}

var errNotStaging = errors.New("refusing to write through something that isn't a staging directory")

// ensureDir makes root/rel a real directory, one component at a time, never through a link. root is a
// staging directory only this program writes, so anything in the way is a leftover from an earlier
// manifest and is removed.
func ensureDir(root, rel string) error {
	fi, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errNotStaging
	}
	if rel == "" || rel == "." {
		return nil
	}
	cur := root
	for _, c := range strings.Split(rel, "/") {
		cur = filepath.Join(cur, c)
		fi, err := os.Lstat(cur)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := os.Mkdir(cur, 0o700); err != nil {
				return err
			}
		case err != nil:
			return err
		case !fi.IsDir():
			if err := os.RemoveAll(cur); err != nil {
				return err
			}
			if err := os.Mkdir(cur, 0o700); err != nil {
				return err
			}
		}
	}

	return nil
}

// placeLink makes root/rel a symlink to target, as a link: it's never followed.
func placeLink(root, rel, target string) error {
	if err := ensureDir(root, path.Dir(rel)); err != nil {
		return err
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	if fi, err := os.Lstat(full); err == nil {
		if fi.Mode()&fs.ModeSymlink != 0 {
			if t, err := os.Readlink(full); err == nil && t == target {
				return nil
			}
		}
		if err := os.RemoveAll(full); err != nil {
			return err
		}
	}

	return os.Symlink(target, full)
}

// prune removes from a staged part everything the manifest no longer has, or has as another type. It
// returns the paths of the files it removed.
func prune(partRoot string, keep map[string]string) ([]string, error) {
	var removed []string
	if _, err := os.Lstat(partRoot); errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	err := filepath.WalkDir(partRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == partRoot {
			return nil
		}
		rel, err := filepath.Rel(partRoot, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		typ := "file"
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			typ = "link"
		case d.IsDir():
			typ = "dir"
		case !d.Type().IsRegular():
			typ = "other"
		}
		if want, ok := keep[rel]; ok && want == typ {
			return nil
		}
		if typ == "file" {
			removed = append(removed, rel)
		}
		if typ == "dir" {
			_ = filepath.WalkDir(p, func(q string, e fs.DirEntry, err error) error {
				if err == nil && e.Type().IsRegular() {
					if r, err := filepath.Rel(partRoot, q); err == nil {
						removed = append(removed, filepath.ToSlash(r))
					}
				}

				return nil
			})
		}
		if err := os.RemoveAll(p); err != nil {
			return err
		}
		if typ == "dir" {
			return fs.SkipDir
		}

		return nil
	})

	return removed, err
}

// finishDirs gives a staged part's directories their manifest modes and times, deepest first.
func finishDirs(partRoot string, entries []Entry) error {
	var dirs []Entry
	for _, e := range entries {
		if e.Type == "dir" {
			dirs = append(dirs, e)
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.Count(dirs[i].Path, "/") > strings.Count(dirs[j].Path, "/") })
	for _, e := range dirs {
		full := filepath.Join(partRoot, filepath.FromSlash(e.Path))
		fi, err := os.Lstat(full)
		if err != nil || !fi.IsDir() {
			continue
		}
		if err := os.Chmod(full, e.Mode.Perm(0o750)); err != nil {
			return err
		}
		if e.MtimeMs > 0 {
			t := time.UnixMilli(e.MtimeMs)
			_ = os.Chtimes(full, t, t)
		}
	}

	return nil
}
