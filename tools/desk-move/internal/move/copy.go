package move

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/frame"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

// GrantStep is the least credit the reader grants at once, after writing (draft ADR, section 7).
const GrantStep = 256 * 1024

var sqliteMagic = []byte("SQLite format 3\x00")

// partPlan is one part being moved: its manifest as last read.
type partPlan struct {
	Name    string
	Label   string
	Entries []Entry
}

func (p *partPlan) counts() (files int, size int64) {
	for _, e := range p.Entries {
		if e.Type == "file" {
			files++
			size += e.Size
		}
	}

	return files, size
}

type job struct {
	part       string
	e          Entry
	offset     int64 // bytes already written to the staged file
	mismatches int   // reads from 0 whose trailer didn't match
	stalls     int
	tries      int
}

func (m *mover) stageRoot() string { return filepath.Join(m.dir, "stage") }

func (m *mover) partStage(part string) string { return filepath.Join(m.stageRoot(), part) }

func (m *mover) stagedPath(part, rel string) string {
	return filepath.Join(m.partStage(part), filepath.FromSlash(rel))
}

// uncarriable is a name the cloud desk listed that this desk can't make exactly. The move stops: a file it
// skipped would be missing from a move that says done.
type uncarriable struct{ part, why string }

func (e *uncarriable) Error() string {
	if e.part == "" {
		return "your cloud desk has a part whose name this desk can't carry (" + e.why + ")"
	}

	return "your cloud desk has a file in " + e.part + " whose name this desk can't carry (" + e.why + ")"
}

func (e *uncarriable) Unwrap() error { return errCopy }

// fetchManifest reads every page of a part's manifest. Names and the cursor are bytes (fsname), so a name that
// isn't UTF-8 is listed, read and paged past as itself.
func (m *mover) fetchManifest(ctx context.Context, part string) ([]Entry, error) {
	var out []Entry
	var cursor *fsname.Name
	for {
		var page struct {
			Entries []Entry      `json:"entries"`
			Next    *fsname.Name `json:"next"`
		}
		err := m.withSession(ctx, func(s *session.Session) error {
			page.Entries, page.Next = nil, nil
			p := map[string]any{"part": fsname.Name(part)}
			if cursor != nil {
				p["cursor"] = *cursor
			}
			cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()

			return s.Call(cctx, "data.manifest", p, &page)
		})
		var bad *fsname.Error
		if errors.As(err, &bad) {
			return nil, &uncarriable{part: part, why: bad.Why}
		}
		if err != nil {
			return nil, fmt.Errorf("listing %s: %w", part, err)
		}
		for _, e := range page.Entries {
			if !validRel(e.Path) {
				return nil, &uncarriable{part: part, why: "a path that isn't inside its part"}
			}
			if machineLocal(part, e.Path) {
				continue // this desk keeps its own (section 4)
			}
			out = append(out, e)
		}
		if page.Next == nil || *page.Next == "" {
			return out, nil
		}
		if cursor != nil && *cursor == *page.Next {
			return nil, fmt.Errorf("listing %s: the cursor didn't move", part)
		}
		cursor = page.Next
	}
}

// prepare makes a staged part match its manifest's directories and links, and removes what has gone.
func (m *mover) prepare(p *partPlan) error {
	root := m.partStage(p.Name)
	if err := ensureDir(m.stageRoot(), p.Name); err != nil {
		return err
	}
	keep := map[string]string{}
	for _, e := range p.Entries {
		switch e.Type {
		case "file", "dir":
			keep[e.Path] = e.Type
		case "link":
			if linkInside(e.Path, e.Target) {
				keep[e.Path] = "link"
			}
		}
	}
	removed, err := prune(root, keep)
	if err != nil {
		return err
	}
	for _, rel := range removed {
		if err := m.journal.remove(p.Name, rel); err != nil {
			return err
		}
	}
	for _, e := range p.Entries {
		switch e.Type {
		case "dir":
			if err := ensureDir(root, e.Path); err != nil {
				return err
			}
		case "link":
			if !linkInside(e.Path, e.Target) {
				m.mu.Lock()
				m.refusedLinks[jkey(p.Name, e.Path)] = true
				m.mu.Unlock()
				m.logf("not making a link that points outside its part")

				continue
			}
			if err := placeLink(root, e.Path, e.Target); err != nil {
				return err
			}
		}
	}
	// Journal entries for files the manifest no longer has go too.
	for _, je := range m.journal.forPart(p.Name) {
		if keep[je.Path] != "file" {
			if err := m.journal.remove(p.Name, je.Path); err != nil {
				return err
			}
		}
	}

	return nil
}

// isSQLite reports whether a staged file is a database, from its first bytes. A file it can't read counts
// as one: the cost is reading it again, and the other way is a database the last pass skips.
func isSQLite(name string) bool {
	f, err := os.Open(name)
	if err != nil {
		return true
	}
	defer f.Close()
	head := make([]byte, len(sqliteMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		return !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF)
	}

	return bytes.Equal(head, sqliteMagic)
}

// planJobs lists the files of a part still to fetch: not journaled, or journaled at another size or
// mtime, or (forceSQLite, the last pass) SQLite, whose -wal the manifest can't show. A forced file starts
// from 0, as what's staged is an older backup, and its journal line goes first: until its new trailer
// passes, nothing vouches for it, so verifyStaged refuses it if the read fails. What it overwrites is
// only the stage, in place, so it needs no more room than the file has grown by.
func (m *mover) planJobs(p *partPlan, forceSQLite bool) []*job {
	var jobs []*job
	for _, e := range p.Entries {
		if e.Type != "file" {
			continue
		}
		staged := m.stagedPath(p.Name, e.Path)
		fi, statErr := os.Lstat(staged)
		je, ok := m.journal.get(p.Name, e.Path)
		if ok && je.Size == e.Size && je.MtimeMs == e.MtimeMs && statErr == nil && fi.Mode().IsRegular() && fi.Size() == je.Bytes {
			if !forceSQLite || !isSQLite(staged) {
				continue
			}
		}
		j := &job{part: p.Name, e: e}
		if !ok && statErr == nil && fi.Mode().IsRegular() && fi.Size() > 0 && !(forceSQLite && isSQLite(staged)) {
			j.offset = fi.Size() // a file a run before this didn't finish: carry on from where it stopped
		}
		if ok {
			if err := m.journal.remove(p.Name, e.Path); err != nil {
				m.logf("journal: %v", err)
			}
		}
		jobs = append(jobs, j)
	}

	return jobs
}

// copyJobs fetches files with up to Workers reads in flight, reconnecting when the session drops.
func (m *mover) copyJobs(ctx context.Context, jobs []*job) error {
	for len(jobs) > 0 {
		s, err := m.session(ctx)
		if err != nil {
			return err
		}
		left, err := m.runPool(ctx, s, jobs)
		if err != nil {
			return err
		}
		if len(left) > 0 {
			m.logf("the session to the cloud desk dropped with %d files to go; reconnecting", len(left))
			m.dropSession(s)
		}
		jobs = left
	}

	return nil
}

func (m *mover) runPool(ctx context.Context, s *session.Session, jobs []*job) ([]*job, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		mu    sync.Mutex
		next  int
		left  []*job
		fatal error
		wg    sync.WaitGroup
	)
	workers := min(max(1, m.env.Workers), len(jobs))
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if fatal != nil || next >= len(jobs) {
					mu.Unlock()

					return
				}
				j := jobs[next]
				next++
				mu.Unlock()
				err := m.fetchFile(ctx, s, j)
				switch {
				case err == nil:
				case errors.Is(err, session.ErrDisconnected) && ctx.Err() == nil:
					mu.Lock()
					left = append(left, j)
					mu.Unlock()
				default:
					mu.Lock()
					if fatal == nil {
						fatal = err
					}
					mu.Unlock()
					cancel()
				}
			}
		}()
	}
	wg.Wait()
	if fatal != nil {
		return nil, fatal
	}
	left = append(left, jobs[next:]...)

	return left, nil
}

func (m *mover) fileFailed(j *job, why string) {
	m.mu.Lock()
	m.failed[jkey(j.part, j.e.Path)] = true
	m.mu.Unlock()
	m.logf("a file in %s couldn't be copied: %s", j.part, why)
}

func (m *mover) fileGone(j *job) error {
	m.mu.Lock()
	m.gone[jkey(j.part, j.e.Path)] = true
	m.mu.Unlock()
	_ = os.Remove(m.stagedPath(j.part, j.e.Path))

	return m.journal.remove(j.part, j.e.Path)
}

// fetchFile reads one file into staging and checks it against its trailer. It returns nil when the
// file is done, verified or given up on (recorded in m.failed), ErrDisconnected when a new session
// should carry on from j.offset, and any other error when the move can't go on.
func (m *mover) fetchFile(ctx context.Context, s *session.Session, j *job) error {
	m.mu.Lock()
	delete(m.failed, jkey(j.part, j.e.Path))
	delete(m.gone, jkey(j.part, j.e.Path))
	m.mu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		res, err := m.readOnce(ctx, s, j)
		switch res {
		case readDone:
			return nil
		case readAgain:
			continue
		case readGone:
			return m.fileGone(j)
		case readFailed:
			m.fileFailed(j, err.Error())

			return nil
		default:
			return err
		}
	}
}

type readResult int

const (
	readError readResult = iota // err says why; the caller decides
	readDone
	readAgain
	readGone
	readFailed
)

func (m *mover) readOnce(ctx context.Context, s *session.Session, j *job) (readResult, error) {
	staged := m.stagedPath(j.part, j.e.Path)
	if err := ensureDir(m.partStage(j.part), path.Dir(j.e.Path)); err != nil {
		return readError, err
	}
	if fi, err := os.Lstat(staged); err == nil && !fi.Mode().IsRegular() {
		if err := os.RemoveAll(staged); err != nil {
			return readError, err
		}
		j.offset = 0
	}
	f, err := os.OpenFile(staged, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return readError, err
	}
	defer f.Close()
	h := sha256.New()
	if j.offset > 0 {
		if n, err := io.CopyN(h, f, j.offset); err != nil || n != j.offset {
			j.offset = 0
			h.Reset()
		}
	}
	if err := f.Truncate(j.offset); err != nil {
		return readError, err
	}
	if _, err := f.Seek(j.offset, io.SeekStart); err != nil {
		return readError, err
	}

	start := j.offset
	rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	t, err := s.Read(rctx, j.part, j.e.Path, start)
	cancel()
	if err != nil {
		return m.readRefused(ctx, j, err)
	}
	if t.Size < start {
		_ = t.Stop(ctx)
		j.offset = 0

		return readAgain, nil
	}
	written, ungranted := start, int64(0)
	var seq uint32
	for {
		cctx, cancel := context.WithTimeout(ctx, m.env.ChunkTimeout)
		c, err := t.Next(cctx)
		cancel()
		if err != nil {
			j.offset = written
			if ctx.Err() != nil {
				return readError, ctx.Err()
			}
			if errors.Is(err, context.DeadlineExceeded) {
				_ = t.Stop(ctx)
				j.stalls++
				if j.stalls > 3 {
					return readFailed, errors.New("the cloud desk stopped sending it")
				}

				return readAgain, nil
			}

			return readError, err
		}
		if c.Seq != seq {
			_ = t.Stop(ctx)

			return m.mismatch(j, start, "chunks out of order")
		}
		seq++
		if c.End {
			t.Finish()
			if len(c.Data) == 0 {
				// deskd's END with no trailer: its helper failed, or it waited too long for credit. What's
				// written is good; ask again from there, and the next trailer covers the whole file.
				j.offset = written
				j.tries++
				if j.tries > 3 {
					return readFailed, errors.New("the cloud desk couldn't finish reading it")
				}
				select {
				case <-time.After(m.env.Backoff(j.tries)):
				case <-ctx.Done():
					return readError, ctx.Err()
				}

				return readAgain, nil
			}

			return m.finish(f, h, j, t, start, written, c.Data)
		}
		if written+int64(len(c.Data)) > t.Size {
			_ = t.Stop(ctx)

			return m.mismatch(j, start, "more bytes than announced")
		}
		if _, err := f.Write(c.Data); err != nil {
			_ = t.Stop(ctx)

			return readError, fmt.Errorf("writing to this desk's disk: %w", err)
		}
		h.Write(c.Data)
		n := int64(len(c.Data))
		written += n
		j.offset = written
		m.bytesDone.Add(n)
		ungranted += n // credit counts file bytes, a frame's payload (deskd's Transfer)
		if ungranted >= GrantStep {
			if err := t.Grant(ungranted); err != nil {
				return readError, err
			}
			ungranted = 0
		}
	}
}

func (m *mover) readRefused(ctx context.Context, j *job, err error) (readResult, error) {
	var re *session.RPCError
	if !errors.As(err, &re) {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			j.tries++
			if j.tries > 3 {
				return readFailed, errors.New("data.read didn't answer")
			}

			return readAgain, nil
		}

		return readError, err
	}
	switch re.Code {
	case "not_found":
		return readGone, nil
	case "too_many", "rate_limited":
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return readError, ctx.Err()
		}

		return readAgain, nil
	case "invalid", "bad_request":
		if j.offset > 0 {
			j.offset = 0

			return readAgain, nil
		}

		return readFailed, err
	case "unavailable", "internal", "deadline_exceeded":
		j.tries++
		if j.tries > 3 {
			return readFailed, err
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return readError, ctx.Err()
		}

		return readAgain, nil
	case "forbidden", "unauthorized":
		return readError, fmt.Errorf("the cloud desk refused to read files for this move: %w: %w", errCopy, err)
	default:
		return readFailed, err
	}
}

// mismatch handles a read that doesn't match its trailer: read it again from 0, once, then give up. A
// read that carried on from an offset gets a read from 0 without counting.
func (m *mover) mismatch(j *job, start int64, why string) (readResult, error) {
	m.logf("a file in %s didn't match its checksum (%s); reading it again", j.part, why)
	if start == 0 {
		j.mismatches++
	}
	j.offset = 0
	if j.mismatches >= 2 {
		return readFailed, errors.New("it changed or arrived damaged twice: " + why)
	}

	return readAgain, nil
}

func (m *mover) finish(f *os.File, h hash.Hash, j *job, t *session.Transfer, start, written int64, trailer []byte) (readResult, error) {
	tr, err := frame.DecodeTrailer(trailer)
	if err != nil {
		return m.mismatch(j, start, "a damaged trailer")
	}
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	if sum != tr.SHA256 || int64(tr.Size) != written || written != t.Size {
		return m.mismatch(j, start, "checksum")
	}
	if err := f.Sync(); err != nil {
		return readError, err
	}
	if err := f.Chmod(j.e.Mode.Perm(0o600)); err != nil {
		return readError, err
	}
	mt := t.MtimeMs
	if mt <= 0 {
		mt = j.e.MtimeMs
	}
	if mt > 0 {
		tm := time.UnixMilli(mt)
		_ = os.Chtimes(f.Name(), tm, tm)
	}
	err = m.journal.add(JournalEntry{
		Part: j.part, Path: j.e.Path, Size: j.e.Size, MtimeMs: j.e.MtimeMs,
		SHA256: hex.EncodeToString(sum[:]), Bytes: written,
	})
	if err != nil {
		return readError, err
	}
	m.filesDone.Add(1)

	return readDone, nil
}

// readSmall reads a small file into memory, checked against its trailer. A missing file is (nil, nil).
func (m *mover) readSmall(ctx context.Context, part, rel string, limit int64) ([]byte, error) {
	var out []byte
	err := m.withSession(ctx, func(s *session.Session) error {
		out = nil
		rctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		t, err := s.Read(rctx, part, rel, 0)
		if session.IsCode(err, "not_found") {
			return nil
		}
		if err != nil {
			return err
		}
		if t.Size > limit {
			_ = t.Stop(rctx)

			return fmt.Errorf("%s is larger than expected", path.Base(rel))
		}
		buf := make([]byte, 0, t.Size)
		for {
			c, err := t.Next(rctx)
			if err != nil {
				return err
			}
			if c.End {
				t.Finish()
				tr, err := frame.DecodeTrailer(c.Data)
				if err != nil || sha256.Sum256(buf) != tr.SHA256 || int64(tr.Size) != int64(len(buf)) {
					return errors.New("a small file didn't match its checksum")
				}
				out = buf

				return nil
			}
			buf = append(buf, c.Data...)
			if int64(len(buf)) > limit {
				_ = t.Stop(rctx)

				return errors.New("a small file was larger than announced")
			}
		}
	})

	return out, err
}

// stagedBytes is what the journal already holds, for the space check.
func (m *mover) stagedBytes(plans []*partPlan) int64 {
	var n int64
	for _, p := range plans {
		for _, e := range p.Entries {
			if e.Type != "file" {
				continue
			}
			if je, ok := m.journal.get(p.Name, e.Path); ok && je.Size == e.Size && je.MtimeMs == e.MtimeMs {
				n += je.Bytes
			}
		}
	}

	return n
}

// verifyStaged hashes every staged file again and compares it with the journal. It returns how many
// files were checked and how many weren't right.
func (m *mover) verifyStaged(plans []*partPlan) (checked, bad int, err error) {
	for _, p := range plans {
		for _, e := range p.Entries {
			if e.Type != "file" {
				continue
			}
			k := jkey(p.Name, e.Path)
			m.mu.Lock()
			gone := m.gone[k]
			m.mu.Unlock()
			if gone {
				continue
			}
			checked++
			je, ok := m.journal.get(p.Name, e.Path)
			if !ok || je.Size != e.Size || je.MtimeMs != e.MtimeMs {
				bad++

				continue
			}
			sum, n, herr := hashFile(m.stagedPath(p.Name, e.Path))
			if herr != nil || n != je.Bytes || sum != je.SHA256 {
				bad++
			}
		}
	}

	return checked, bad, nil
}

func hashFile(name string) (string, int64, error) {
	f, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	if !fi.Mode().IsRegular() {
		return "", 0, fs.ErrInvalid
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}

	return hex.EncodeToString(h.Sum(nil)), n, nil
}
