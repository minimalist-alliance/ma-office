package move

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
)

// Phases of a move, in order.
const (
	PhaseCopying    = "copying"
	PhaseSwapping   = "swapping"
	PhaseProving    = "proving"
	PhaseDone       = "done"
	PhaseSuperseded = "superseded"
)

// State is /data/.ma-move/<moveId>/state.json, 0600 root. It holds the move token, so a rerun can
// carry on with the same move.
type State struct {
	MoveID        string          `json:"moveId"`
	MoveToken     string          `json:"moveToken"`
	SourceDeskID  string          `json:"sourceDeskId"`
	TargetDeskID  string          `json:"targetDeskId"`
	SourceName    string          `json:"sourceName,omitempty"`
	TargetName    string          `json:"targetName,omitempty"`
	ExpiresAt     string          `json:"expiresAt,omitempty"`
	Phase         string          `json:"phase"`
	Parts         []string        `json:"parts,omitempty"`    // the parts to swap, fixed once the checks pass
	Swapped       []string        `json:"swapped,omitempty"`  // the parts already in place
	Services      []string        `json:"services,omitempty"` // the units that were running before the swap
	ServicesKnown bool            `json:"servicesKnown,omitempty"`
	Totals        []PartSummary   `json:"totals,omitempty"`      // what was checked, for the summary after a rerun
	Checks        map[string]bool `json:"checks,omitempty"`      // each check that ran: passed or not
	BrowserKept   string          `json:"browserKept,omitempty"` // what became of keeping the cloud desk's Browser held: KeptHeld and the rest
	StartedAt     string          `json:"startedAt"`
	UpdatedAt     string          `json:"updatedAt"`
}

func moveRoot(dataRoot string) string { return filepath.Join(dataRoot, ".ma-move") }

func moveDir(dataRoot, moveID string) string { return filepath.Join(moveRoot(dataRoot), moveID) }

func validMoveID(id string) bool {
	if id == "" || len(id) > 128 || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}

	return true
}

func saveState(dataRoot string, st *State, now time.Time) error {
	dir := moveDir(dataRoot, st.MoveID)
	if err := os.MkdirAll(moveRoot(dataRoot), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	st.UpdatedAt = now.UTC().Format(time.RFC3339)
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}

	return writeFileAtomic(filepath.Join(dir, "state.json"), append(b, '\n'), 0o600)
}

func writeFileAtomic(name string, data []byte, mode fs.FileMode) error {
	tmp := name + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()

		return err
	}
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()

		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()

		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	return os.Rename(tmp, name)
}

// findResumable returns the newest move under dataRoot that isn't done, for this target desk.
func findResumable(dataRoot, target string) (*State, error) {
	des, err := os.ReadDir(moveRoot(dataRoot))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var found []*State
	for _, de := range des {
		if !de.IsDir() || !validMoveID(de.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(moveRoot(dataRoot), de.Name(), "state.json"))
		if err != nil {
			continue
		}
		var st State
		if json.Unmarshal(b, &st) != nil || st.MoveID != de.Name() {
			continue
		}
		if st.Phase == PhaseDone || st.Phase == PhaseSuperseded || st.TargetDeskID != target {
			continue
		}
		found = append(found, &st)
	}
	if len(found) == 0 {
		return nil, nil
	}
	sort.Slice(found, func(i, j int) bool { return found[i].UpdatedAt > found[j].UpdatedAt })

	return found[0], nil
}

// JournalEntry is one finished file: the manifest's size and mtime it was read at, and what was
// written. A rerun skips it while the manifest still says the same. Part and Path are bytes, written as
// desk-data writes names (fsname), so a name that isn't UTF-8 reads back as itself.
type JournalEntry struct {
	Part    string
	Path    string
	Size    int64
	MtimeMs int64
	SHA256  string
	Bytes   int64 // what data.read sent, which for SQLite differs from Size
	Removed bool  // the file has gone from the cloud desk since
}

type journalJSON struct {
	Part    fsname.Name `json:"part"`
	Path    fsname.Name `json:"path"`
	Size    int64       `json:"size"`
	MtimeMs int64       `json:"mtimeMs"`
	SHA256  string      `json:"sha256"`
	Bytes   int64       `json:"bytes"`
	Removed bool        `json:"removed,omitempty"`
}

// MarshalJSON writes one journal line.
func (e JournalEntry) MarshalJSON() ([]byte, error) {
	return json.Marshal(journalJSON{Part: fsname.Name(e.Part), Path: fsname.Name(e.Path), Size: e.Size, MtimeMs: e.MtimeMs,
		SHA256: e.SHA256, Bytes: e.Bytes, Removed: e.Removed})
}

// UnmarshalJSON reads one, as MarshalJSON wrote it or as a journal before fsname did (the same for UTF-8 names).
func (e *JournalEntry) UnmarshalJSON(b []byte) error {
	var w journalJSON
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*e = JournalEntry{Part: string(w.Part), Path: string(w.Path), Size: w.Size, MtimeMs: w.MtimeMs, SHA256: w.SHA256,
		Bytes: w.Bytes, Removed: w.Removed}

	return nil
}

// Journal is journal.jsonl: one JSON line per finished file, the last line for a path winning.
type Journal struct {
	mu      sync.Mutex
	f       *os.File
	entries map[string]JournalEntry
}

func jkey(part, path string) string { return part + "\x00" + path }

// readJournal loads a journal without opening it for writing.
func readJournal(name string) *Journal {
	j := &Journal{entries: map[string]JournalEntry{}}
	if f, err := os.Open(name); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			var e JournalEntry
			if json.Unmarshal(sc.Bytes(), &e) != nil || e.Part == "" {
				continue // a line cut short by a crash
			}
			if e.Removed {
				delete(j.entries, jkey(e.Part, e.Path))
			} else {
				j.entries[jkey(e.Part, e.Path)] = e
			}
		}
		_ = f.Close()
	}

	return j
}

func openJournal(name string) (*Journal, error) {
	j := readJournal(name)
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_APPEND|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	// A line cut short by a crash would join the next one: start on a fresh line.
	if fi, err := f.Stat(); err == nil && fi.Size() > 0 {
		_, _ = f.WriteString("\n")
	}
	j.f = f

	return j, nil
}

func (j *Journal) get(part, path string) (JournalEntry, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	e, ok := j.entries[jkey(part, path)]

	return e, ok
}

func (j *Journal) add(e JournalEntry) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if _, err := j.f.Write(append(b, '\n')); err != nil {
		return err
	}
	if err := j.f.Sync(); err != nil {
		return err
	}
	if e.Removed {
		delete(j.entries, jkey(e.Part, e.Path))
	} else {
		j.entries[jkey(e.Part, e.Path)] = e
	}

	return nil
}

func (j *Journal) remove(part, path string) error {
	if _, ok := j.get(part, path); !ok {
		return nil
	}

	return j.add(JournalEntry{Part: part, Path: path, Removed: true})
}

// forPart lists the journaled paths of one part.
func (j *Journal) forPart(part string) []JournalEntry {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []JournalEntry
	for k, e := range j.entries {
		if strings.HasPrefix(k, part+"\x00") {
			out = append(out, e)
		}
	}

	return out
}

func (j *Journal) close() error {
	if j == nil || j.f == nil {
		return nil
	}

	return j.f.Close()
}

func (j *Journal) String() string { return fmt.Sprintf("journal(%d)", len(j.entries)) }
