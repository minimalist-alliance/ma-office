package move

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Systemd is what the swap needs of systemctl. Tests pass a fake.
type Systemd interface {
	Exists(unit string) bool
	IsActive(unit string) bool
	Stop(units ...string) error // one systemctl stop for all of them
	Start(unit string) error
	Cat(unit string) (string, error)
}

// The units stopped for the swap, as the self-hosted desk asks (task 31): deskd, the Browser, the stream,
// and desk-agent and desk-notebook where there are. After it only deskd is started, as it starts the Browser
// and the stream when a session wants them, and desk-agent and desk-notebook again if they were running.
var swapUnits = []string{"deskd", "desk-browser", "desk-stream", "desk-agent", "desk-notebook"}

// The units that run on their own, so a swap starts them again if they were running.
var restartedUnits = []string{"desk-agent", "desk-notebook"}

// Never touched by a move: this desk's own (draft ADR, section 4).
var machineParts = map[string]bool{
	"rtc": true, "desk-egress": true, ".ma-volume": true, "lost+found": true, ".ma-export-tmp": true, ".ma-move": true,
	"selfhost":         true, // a self-hosted desk's key and pairing (task 31): never read, moved or written
	"browser-readable": true, // made by the helper for the export, never stored
}

// movablePart reports whether a part the cloud desk lists may come here.
func movablePart(name string) bool {
	return validRel(name) && !strings.Contains(name, "/") && !machineParts[name] && !strings.HasPrefix(name, ".")
}

// browserMovedFile is deskd's record that a move kept this desk's Browser held (API.md section 12,
// data.browser.keep). It's the cloud desk's, about the cloud desk: brought here, it would keep this desk's Browser
// stopped too.
const browserMovedFile = "browser-moved.json"

// machineLocal reports whether part/rel is this machine's and never comes from the cloud desk.
func machineLocal(part, rel string) bool {
	switch part {
	case "desk":
		return rel == "volume.json" || rel == browserMovedFile
	case "apps":
		if rel == "registry.json" {
			return true
		}
		bits := strings.Split(rel, "/")
		if len(bits) >= 2 {
			switch bits[1] {
			case "releases", "current", "previous":
				return true
			}
		}
	}

	return false
}

// Fixed owners (desk-runtime.md section 1).
var partOwner = map[string]int{"desk": 1100, "browser": 1102, "agent": 1103, "notebook": 1105}

// Modes for a part's own directory when this desk had none.
var partMode = map[string]fs.FileMode{"desk": 0o750, "browser": 0o750, "agent": 0o750, "notebook": 0o750, "apps": 0o755}

func ownerOf(name string) (uid, gid int, ok bool) {
	fi, err := os.Lstat(name)
	if err != nil {
		return 0, 0, false
	}
	st, sok := fi.Sys().(*syscall.Stat_t)
	if !sok {
		return 0, 0, false
	}

	return int(st.Uid), int(st.Gid), true
}

// stopServices stops what uses /data, in one systemctl stop.
func (m *mover) stopServices() error {
	var units []string
	for _, u := range swapUnits {
		if m.env.Systemd.Exists(u) {
			units = append(units, u)
		}
	}
	if len(units) == 0 {
		return nil
	}
	if err := m.env.Systemd.Stop(units...); err != nil {
		return fmt.Errorf("stopping %s: %w", strings.Join(units, ", "), err)
	}

	return nil
}

// startServices starts deskd, which starts the rest when they're wanted, and desk-agent and desk-notebook if
// they were running.
func (m *mover) startServices(wasActive []string) error {
	var errs []error
	if m.env.Systemd.Exists("deskd") {
		if err := m.env.Systemd.Start("deskd"); err != nil {
			errs = append(errs, fmt.Errorf("starting deskd: %w", err))
		}
	}
	for _, unit := range restartedUnits {
		if contains(wasActive, unit) && m.env.Systemd.Exists(unit) {
			if err := m.env.Systemd.Start(unit); err != nil {
				errs = append(errs, fmt.Errorf("starting %s: %w", unit, err))
			}
		}
	}

	return errors.Join(errs...)
}

func exists(name string) bool {
	_, err := os.Lstat(name)

	return err == nil
}

// beforeDir is where this desk's own copy of a part goes. A second one, from an earlier try, gets a
// number, so nothing is ever overwritten.
func (m *mover) freeBeforeDir(part string) string {
	base := filepath.Join(m.dir, "before", part)
	if !exists(base) {
		return base
	}
	for i := 2; ; i++ {
		p := base + "." + strconv.Itoa(i)
		if !exists(p) {
			return p
		}
	}
}

// swapPart puts one staged part in place. Each step checks where it stands, so a rerun after a crash
// carries on: the live part to before/, the staged part in, owners, then this desk's machine files.
func (m *mover) swapPart(part string) error {
	live := filepath.Join(m.env.DataRoot, part)
	staged := m.partStage(part)
	before := filepath.Join(m.dir, "before", part)
	if err := os.MkdirAll(filepath.Join(m.dir, "before"), 0o700); err != nil {
		return err
	}
	if exists(staged) {
		if exists(live) {
			dst := m.freeBeforeDir(part)
			if err := os.Rename(live, dst); err != nil {
				return fmt.Errorf("keeping this desk's %s: %w", part, err)
			}
			if dst != before {
				before = dst
			}
		}
		if err := os.Rename(staged, live); err != nil {
			return fmt.Errorf("putting %s in place: %w", part, err)
		}
	}
	if !exists(before) {
		before = ""
	}
	if err := m.setRootMode(part, live, before); err != nil {
		return err
	}
	if err := m.chownPart(part, live, before); err != nil {
		return err
	}
	if err := fixedModes(part, live); err != nil {
		return err
	}

	return m.carryMachineFiles(part, live, before)
}

// The modes desk-datadirs gives these directories, kept whatever the cloud desk's copy said.
var fixedDirModes = map[string]map[string]fs.FileMode{
	"browser": {"": 0o750, "profile": 0o700, "downloads": 0o750, "home": 0o700},
	"desk":    {"": 0o750},
}

func fixedModes(part, live string) error {
	for rel, mode := range fixedDirModes[part] {
		p := filepath.Join(live, rel)
		fi, err := os.Lstat(p)
		if err != nil || !fi.IsDir() {
			continue
		}
		if err := os.Chmod(p, mode); err != nil {
			return err
		}
	}

	return nil
}

func (m *mover) setRootMode(part, live, before string) error {
	mode, ok := partMode[part]
	if !ok {
		mode = 0o750
	}
	if before != "" {
		if fi, err := os.Lstat(before); err == nil && fi.IsDir() {
			mode = fi.Mode().Perm()
		}
	}

	return os.Chmod(live, mode)
}

func (m *mover) chown(name string, uid, gid int) error {
	if err := m.env.Chown(name, uid, gid); err != nil {
		return fmt.Errorf("setting the owner of a file in /data: %w", err)
	}

	return nil
}

// chownWalk sets one owner on everything under root, root included, never following a link.
func (m *mover) chownWalk(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		return m.chown(p, uid, gid)
	})
}

// chownPart sets owners by part: browser 1102, desk 1100, agent 1103, notebook 1105, each app by the uid this desk's
// registry gives it. Any other part keeps the owner this desk's own copy had, or stays root's.
func (m *mover) chownPart(part, live, before string) error {
	if uid, ok := partOwner[part]; ok {
		return m.chownWalk(live, uid, uid)
	}
	if part == "apps" {
		return m.chownApps(live, before)
	}
	if before == "" {
		return nil
	}
	uid, gid, ok := ownerOf(before)
	if !ok {
		return nil
	}

	return m.chownWalk(live, uid, gid)
}

// appUIDs reads /data/apps/registry.json, whose exact shape the desk app contract hasn't fixed yet:
// {"apps": {"<id>": {"uid": n}}}, {"apps": [{"id", "uid"}]} and {"<id>": {"uid": n}} all work.
func appUIDs(name string) map[string]int {
	out := map[string]int{}
	b, err := os.ReadFile(name)
	if err != nil {
		return out
	}
	type app struct {
		ID  string `json:"id"`
		UID *int   `json:"uid"`
	}
	var wrapped struct {
		Apps json.RawMessage `json:"apps"`
	}
	raw := json.RawMessage(b)
	if json.Unmarshal(b, &wrapped) == nil && len(wrapped.Apps) > 0 {
		raw = wrapped.Apps
	}
	var list []app
	if json.Unmarshal(raw, &list) == nil {
		for _, a := range list {
			if a.ID != "" && a.UID != nil {
				out[a.ID] = *a.UID
			}
		}

		return out
	}
	var byID map[string]app
	if json.Unmarshal(raw, &byID) == nil {
		for id, a := range byID {
			if a.UID != nil {
				out[id] = *a.UID
			}
		}
	}

	return out
}

func (m *mover) chownApps(live, before string) error {
	registry := filepath.Join(live, "registry.json")
	if before != "" && !exists(registry) {
		registry = filepath.Join(before, "registry.json")
	}
	uids := appUIDs(registry)
	ruid, rgid := 0, 0
	if before != "" {
		if u, g, ok := ownerOf(before); ok {
			ruid, rgid = u, g
		}
	}
	if err := m.chown(live, ruid, rgid); err != nil {
		return err
	}
	des, err := os.ReadDir(live)
	if err != nil {
		return err
	}
	for _, de := range des {
		p := filepath.Join(live, de.Name())
		if !de.IsDir() || de.Type()&fs.ModeSymlink != 0 {
			if machineLocal("apps", de.Name()) {
				continue
			}
			if err := m.chown(p, 0, 0); err != nil {
				return err
			}

			continue
		}
		duid, dgid := 0, 0
		if before != "" {
			if u, g, ok := ownerOf(filepath.Join(before, de.Name())); ok {
				duid, dgid = u, g
			}
		}
		if err := m.chown(p, duid, dgid); err != nil {
			return err
		}
		uid, ok := uids[de.Name()]
		gid := uid
		if !ok && before != "" {
			uid, gid, ok = ownerOf(filepath.Join(before, de.Name(), "data"))
		}
		if !ok {
			continue // not installed here: left as it was written, and the desk sets it at install
		}
		subs, err := os.ReadDir(p)
		if err != nil {
			return err
		}
		for _, s := range subs {
			if machineLocal("apps", de.Name()+"/"+s.Name()) {
				continue
			}
			if err := m.chownWalk(filepath.Join(p, s.Name()), uid, gid); err != nil {
				return err
			}
		}
	}

	return nil
}

// carryMachineFiles brings this desk's own files into the new part (draft ADR, section 4): its
// volume record, and its installed apps. Small files are copied, so before/ keeps them too; the
// apps' releases move, and their current and previous links are made again.
func (m *mover) carryMachineFiles(part, live, before string) error {
	if before == "" {
		return nil
	}
	switch part {
	case "desk":
		if err := m.copyKeepOwner(filepath.Join(before, "volume.json"), filepath.Join(live, "volume.json")); err != nil {
			return err
		}

		return m.copyKeepOwner(filepath.Join(before, browserMovedFile), filepath.Join(live, browserMovedFile))
	case "apps":
		if err := m.copyKeepOwner(filepath.Join(before, "registry.json"), filepath.Join(live, "registry.json")); err != nil {
			return err
		}
		des, err := os.ReadDir(before)
		if err != nil {
			return err
		}
		for _, de := range des {
			if !de.IsDir() || de.Type()&fs.ModeSymlink != 0 {
				continue
			}
			for _, name := range []string{"releases", "current", "previous"} {
				src := filepath.Join(before, de.Name(), name)
				dst := filepath.Join(live, de.Name(), name)
				fi, err := os.Lstat(src)
				if err != nil || exists(dst) {
					continue
				}
				if err := os.MkdirAll(filepath.Join(live, de.Name()), 0o755); err != nil {
					return err
				}
				if fi.Mode()&fs.ModeSymlink != 0 {
					t, err := os.Readlink(src)
					if err != nil {
						return err
					}
					if err := os.Symlink(t, dst); err != nil {
						return err
					}
					if u, g, ok := ownerOf(src); ok {
						if err := m.chown(dst, u, g); err != nil {
							return err
						}
					}

					continue
				}
				if err := os.Rename(src, dst); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

func (m *mover) copyKeepOwner(src, dst string) error {
	fi, err := os.Lstat(src)
	if err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	if exists(dst) {
		return nil
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(dst, b, fi.Mode().Perm()); err != nil {
		return err
	}
	if u, g, ok := ownerOf(src); ok {
		return m.chown(dst, u, g)
	}

	return nil
}
