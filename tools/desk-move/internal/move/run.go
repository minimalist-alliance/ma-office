// Package move is ma-move: it copies a cloud desk's data onto this self-hosted desk through the
// cloud desk's deskd, checks it, swaps it in, and proves the sign-ins work (draft ADR data export and
// transfer, section 9).
package move

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/client"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

// Version is set at build time.
var Version = "dev"

// Exit codes.
const (
	ExitDone    = 0
	ExitFailed  = 1
	ExitUsage   = 2
	ExitRefused = 3
)

// DialFunc opens the data channels of a session with the cloud desk, getting its token from connect.
type DialFunc func(ctx context.Context, deskID string, connect client.ConnectFunc) (session.Transport, error)

// Env is everything the move touches, so tests run it unprivileged against a temp dir and a fake desk.
type Env struct {
	DataRoot        string
	API             API
	Dial            DialFunc
	Systemd         Systemd
	Chown           func(name string, uid, gid int) error // never follows a link
	FreeBytes       func(path string) (uint64, error)
	ChromiumVersion func() (string, error)
	BrowserLaunch   func() (string, error) // desk-browser's unit and the wrapper it runs
	LocalCookies    func(ctx context.Context) ([]cdp.Item, error)
	SignClaim       func(code, targetDeskID string) (*ClaimProof, error) // this desk's key signs the claim; nil in tests that don't check it

	Out      io.Writer                        // what the member reads
	Progress io.Writer                        // progress lines; nil for none
	Log      func(format string, args ...any) // -v; nil for quiet
	Now      func() time.Time

	Workers       int           // reads in flight; 8
	ReconnectFor  time.Duration // how long to keep trying after a drop; 10 min
	Backoff       func(attempt int) time.Duration
	RefreshEvery  time.Duration // desk token refresh; 4 min
	Keepalive     time.Duration // PING interval; 15 s
	ChunkTimeout  time.Duration // a transfer with no chunk this long is asked again; 2 min
	WakePoll      time.Duration // between connect calls while the cloud desk wakes; 3 s
	WakeFor       time.Duration // how long a wake may take; 10 min
	ProgressEvery time.Duration // 30 s
	HoldTries     int           // asks for the Browser's hold, and held passes, before the move stops; 4
	HoldRenew     time.Duration // between renewals of the hold while it's needed; 10 min
	HoldFor       time.Duration // how long deskd keeps a hold that isn't renewed (API.md section 12); 30 min
}

func (e *Env) defaults() {
	if e.Now == nil {
		e.Now = time.Now
	}
	if e.Out == nil {
		e.Out = io.Discard
	}
	if e.Workers == 0 {
		e.Workers = 8
	}
	if e.ReconnectFor == 0 {
		e.ReconnectFor = 10 * time.Minute
	}
	if e.Backoff == nil {
		e.Backoff = func(n int) time.Duration { return min(time.Second<<min(n, 5), 30*time.Second) }
	}
	if e.RefreshEvery == 0 {
		e.RefreshEvery = 4 * time.Minute
	}
	if e.ChunkTimeout == 0 {
		e.ChunkTimeout = 2 * time.Minute
	}
	if e.WakePoll == 0 {
		e.WakePoll = 3 * time.Second
	}
	if e.WakeFor == 0 {
		e.WakeFor = 10 * time.Minute
	}
	if e.ProgressEvery == 0 {
		e.ProgressEvery = 30 * time.Second
	}
	if e.HoldTries == 0 {
		e.HoldTries = 4
	}
	if e.HoldRenew == 0 {
		e.HoldRenew = 10 * time.Minute
	}
	if e.HoldFor == 0 {
		e.HoldFor = 30 * time.Minute
	}
}

// Options are the member's choices.
type Options struct {
	TargetDesk string
	Code       func() (string, error) // asked only when there's no move to carry on with
	DryRun     bool
}

type mover struct {
	env  Env
	opts Options

	st      *State
	dir     string
	journal *Journal
	adopt   *State // an earlier move whose token ran out, whose staged files this one takes over
	plans   []*partPlan

	mu           sync.Mutex
	sess         *session.Session
	fp           string
	holding      bool // the Browser should be held: a new session holds it before it's used
	held         heldState
	failed, gone map[string]bool
	refusedLinks map[string]bool
	cookiesNote  string

	filesDone, bytesDone atomic.Int64
}

func (m *mover) logf(format string, args ...any) {
	if m.env.Log != nil {
		m.env.Log(format, args...)
	}
}

func (m *mover) say(format string, args ...any) { fmt.Fprintf(m.env.Out, format+"\n", args...) }

// endedError means the platform won't let this move go on.
type endedError struct{ err error }

func (e *endedError) Error() string {
	return "this move's sign-in has ended (it lasts 24 hours from when the code was used), or the move was cancelled"
}
func (e *endedError) Unwrap() error { return e.err }

// Run does the whole move and returns the exit code.
func Run(ctx context.Context, env Env, opts Options) int {
	env.defaults()
	m := &mover{env: env, opts: opts, failed: map[string]bool{}, gone: map[string]bool{}, refusedLinks: map[string]bool{}}
	err := m.run(ctx)
	defer m.closeSession()
	defer func() { _ = m.journal.close() }()
	if err == nil {
		return ExitDone
	}
	defer m.sayStillKept()
	var refusal *Refusal
	switch {
	case errors.As(err, &refusal):
		m.say("%s", refusal.Message)
		m.failReport(refusalError[refusal.Check], refusal.Message)

		return ExitRefused
	case ctx.Err() != nil:
		m.say("Stopped. Your data on this desk is as it was, and what's copied so far is kept. Run sudo ma-move again to carry on.")
		m.failReport("interrupted", "stopped")

		return ExitFailed
	default:
		var ended *endedError
		switch {
		case errors.As(err, &ended):
			// The platform no longer takes this move's token, so there's no one to report to.
			m.say("The move stopped: %s. Make a new move code in your office, then run sudo ma-move again; what's copied so far is kept.", err)

			return ExitFailed
		case m.st != nil && (m.st.Phase == PhaseSwapping || m.st.Phase == PhaseProving):
			m.say("The move stopped while putting your data in place: %v. Nothing was deleted: run sudo ma-move again to finish.", err)
		default:
			m.say("The move stopped: %v. Your data on this desk is as it was, and what's copied so far is kept. Run sudo ma-move again to carry on from where it stopped.", err)
		}
		m.failReport(m.errorCode(err), err.Error())

		return ExitFailed
	}
}

// sayStillKept tells a member whose move stopped after its last pass that the cloud desk's Browser stays stopped, so
// they aren't left wondering where it went if they go back to that desk.
func (m *mover) sayStillKept() {
	if m.st == nil || m.st.BrowserKept != KeptHeld || m.st.Phase == PhaseDone {
		return
	}
	m.say("%s", keptLine)
}

func (m *mover) failReport(code, message string) {
	if m.st == nil || m.opts.DryRun {
		return
	}
	parts := m.partSummaries()
	m.report(platformReport("failed", parts, m.st.Checks, code))
	if exists(m.dir) {
		files, size := sumParts(parts)
		_ = m.writeLocalReport(LocalReport{State: "failed", Error: code, Message: message, Parts: parts, Files: files, Bytes: size, Checks: m.st.Checks})
	}
}

// report sends counts to the platform. A report that doesn't arrive never stops the move.
func (m *mover) report(r PlatformReport) {
	if m.st == nil || m.env.API == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := m.env.API.Report(ctx, m.st.MoveID, m.st.MoveToken, r); err != nil {
		m.logf("report %s: %v", r.State, err)
	}
}

// partSummaries is what's being moved: from the manifests, or after a rerun from the state.
func (m *mover) partSummaries() []PartSummary {
	if m.plans == nil && m.st != nil {
		return m.st.Totals
	}
	parts, _, _ := totals(m.plans)

	return parts
}

// The checks a move makes (draft ADR, section 9 step 4, and the sign-in proof).
const (
	CheckChromium      = "chromium"
	CheckPasswordStore = "password_store"
	CheckSpace         = "space"
	CheckFiles         = "files_verified"
	CheckCookies       = "cookies"
)

// refusalError is the platform's error code for each check (ma-platform services/desks/src/moves.ts).
var refusalError = map[string]string{
	CheckChromium: "chromium_older", CheckPasswordStore: "password_store", CheckSpace: "disk_full",
	CheckFiles: "checksum_mismatch", "not_a_desk": "target_mismatch",
}

// checked records a check's outcome on the move and passes err through.
func (m *mover) checked(name string, err error) error {
	if m.st != nil {
		if m.st.Checks == nil {
			m.st.Checks = map[string]bool{}
		}
		m.st.Checks[name] = err == nil
	}

	return err
}

// helperError means the cloud desk has no data helper yet.
type helperError struct{}

func (helperError) Error() string {
	return "your cloud desk can't hand over its files yet (its data helper isn't installed)"
}

// errorCode is the platform's error code for a move that failed: a fixed word, never text.
func (m *mover) errorCode(err error) string {
	var he helperError
	switch {
	case errors.As(err, &he):
		return "helper_unavailable"
	case errors.Is(err, syscall.ENOSPC):
		return "disk_full"
	case m.st != nil && (m.st.Phase == PhaseSwapping || m.st.Phase == PhaseProving):
		return "swap_failed"
	case errors.Is(err, session.ErrDisconnected), errors.Is(err, errUnreachable):
		return "connection_lost"
	case errors.Is(err, errCopy):
		return "copy_failed"
	default:
		return "other"
	}
}

var (
	errUnreachable = errors.New("unreachable")
	errCopy        = errors.New("copy")
)

func (m *mover) save() error { return saveState(m.env.DataRoot, m.st, m.env.Now()) }

func (m *mover) run(ctx context.Context) error {
	if fi, err := os.Stat(m.env.DataRoot); err != nil || !fi.IsDir() {
		return fmt.Errorf("%s isn't there; is this the self-hosted desk", m.env.DataRoot)
	}
	launch, err := m.env.BrowserLaunch()
	if err != nil {
		return &Refusal{Check: "password_store", Message: "This computer doesn't look like a self-hosted desk yet: its Browser isn't installed. Run the install first. Nothing on this desk was changed."}
	}
	if err := checkPasswordStore(launch); err != nil {
		return err
	}

	if !m.opts.DryRun {
		old, err := findResumable(m.env.DataRoot, m.opts.TargetDesk)
		if err != nil {
			return err
		}
		if old != nil {
			if err := m.resume(ctx, old); err != nil {
				return err
			}
			if m.st != nil && (m.st.Phase == PhaseSwapping || m.st.Phase == PhaseProving) {
				return m.finishLocal(ctx)
			}
		}
	}
	if m.st == nil {
		if err := m.claim(ctx); err != nil {
			return err
		}
	}
	m.say("Moving %s to %s.", nameOr(m.st.SourceName, "your cloud desk"), nameOr(m.st.TargetName, "this desk"))

	plans, err := m.listAll(ctx)
	if err != nil {
		return err
	}
	m.plans = plans

	// Read-only checks first: a refusal here changes nothing anywhere.
	_ = m.checked(CheckPasswordStore, nil) // checked before the claim
	if err := m.checkChromiumAgainst(ctx, func() ([]byte, error) {
		if !m.hasPart("browser") {
			return nil, nil
		}

		return m.readSmall(ctx, "browser", "profile/Last Version", 256)
	}); err != nil {
		var r *Refusal
		if errors.As(err, &r) {
			return m.checked(CheckChromium, err)
		}

		return err
	}
	_ = m.checked(CheckChromium, nil)
	_, _, total := totals(plans)
	staged := int64(0)
	if m.journal != nil {
		staged = m.stagedBytes(plans)
	} else if m.adopt != nil {
		staged = (&mover{journal: readJournal(filepath.Join(moveDir(m.env.DataRoot, m.adopt.MoveID), "journal.jsonl"))}).stagedBytes(plans)
	}
	free, err := m.env.FreeBytes(m.env.DataRoot)
	if err != nil {
		return fmt.Errorf("reading free space: %w", err)
	}
	spaceErr := m.checked(CheckSpace, checkSpace(free, total-staged))
	if m.opts.DryRun {
		m.dryRunSummary(plans, free, total-staged)
		if spaceErr != nil {
			return spaceErr
		}
		m.say("That was a dry run: nothing was changed on either desk. The code is used now, so make a new one in your office for the move itself.")

		return nil
	}
	if spaceErr != nil {
		return spaceErr
	}

	// From here on this desk's /data/.ma-move changes; the rest of /data waits for the swap.
	if err := m.save(); err != nil {
		return err
	}
	if m.adopt != nil {
		m.takeOver(m.adopt)
	}
	if m.journal == nil {
		if m.journal, err = openJournal(filepath.Join(m.dir, "journal.jsonl")); err != nil {
			return err
		}
	}
	if err := ensureDir(m.dir, "stage"); err != nil {
		return err
	}
	m.report(platformReport("copying", m.partSummaries(), m.st.Checks, ""))

	if err := m.copyAll(ctx, plans); err != nil {
		return err
	}
	if err := m.lastPass(ctx, plans); err != nil {
		return err
	}
	m.closeSession()

	return m.checkAndSwap(ctx, plans)
}

func nameOr(s, fallback string) string {
	if s == "" {
		return fallback
	}

	return s
}

func (m *mover) hasPart(name string) bool {
	for _, p := range m.plans {
		if p.Name == name {
			return true
		}
	}

	return false
}

// resume picks up a move a run before this didn't finish.
func (m *mover) resume(ctx context.Context, old *State) error {
	m.st = old
	m.dir = moveDir(m.env.DataRoot, old.MoveID)
	m.say("Carrying on with the move that started %s.", old.StartedAt)
	if old.Phase == PhaseSwapping || old.Phase == PhaseProving {
		return nil
	}
	var err error
	if m.journal, err = openJournal(filepath.Join(m.dir, "journal.jsonl")); err != nil {
		return err
	}
	if _, err := m.session(ctx); err != nil {
		var ended *endedError
		if !errors.As(err, &ended) {
			return err
		}
		m.say("That move's sign-in has ended, so it needs a new code. What's copied so far is kept.")
		_ = m.journal.close()
		m.journal = nil
		m.adopt, m.st, m.dir = old, nil, ""
	}

	return nil
}

func (m *mover) claim(ctx context.Context) error {
	if m.opts.Code == nil {
		return errors.New("no move code")
	}
	raw, err := m.opts.Code()
	if err != nil {
		return fmt.Errorf("reading the move code: %w", err)
	}
	code, err := NormalizeCode(raw)
	if err != nil {
		return err
	}
	var proof *ClaimProof
	if m.env.SignClaim != nil {
		if proof, err = m.env.SignClaim(code, m.opts.TargetDesk); err != nil {
			return err
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c, err := m.env.API.Claim(cctx, code, m.opts.TargetDesk, proof)
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) {
			switch {
			case ae.Status == 409:
				return errors.New("that code has been used already. Make a new one in your office")
			case ae.Status == 410:
				return errors.New("that code has run out (codes last 15 minutes). Make a new one in your office")
			case ae.Status == 403:
				return errors.New("that code is for moving to a different desk. Check the desk you picked in your office")
			case ae.Status == 429:
				return errors.New("too many wrong codes were tried from here. Wait 10 minutes, then try again")
			case ae.Status/100 == 4:
				return errors.New("no move has that code. Check it, or make a new one in your office")
			}
		}

		return fmt.Errorf("couldn't reach the Minimalist Alliance API: %w", err)
	}
	if c.TargetDeskID != m.opts.TargetDesk || c.SourceDeskID == m.opts.TargetDesk || !validMoveID(c.MoveID) {
		return errors.New("that code is for a different desk. Check the self-hosted desk you picked in your office")
	}
	m.st = &State{
		MoveID: c.MoveID, MoveToken: c.MoveToken, SourceDeskID: c.SourceDeskID, TargetDeskID: c.TargetDeskID,
		SourceName: c.SourceName, TargetName: c.TargetName, ExpiresAt: c.ExpiresAt,
		Phase: PhaseCopying, StartedAt: m.env.Now().UTC().Format(time.RFC3339),
	}
	m.dir = moveDir(m.env.DataRoot, c.MoveID)

	return nil
}

// takeOver moves an earlier move's staged files and journal into this one, when both are from the same
// cloud desk. The journal still guards every file against the new manifest.
func (m *mover) takeOver(old *State) {
	oldDir := moveDir(m.env.DataRoot, old.MoveID)
	if old.SourceDeskID == m.st.SourceDeskID && !exists(filepath.Join(m.dir, "stage")) {
		if err := os.Rename(filepath.Join(oldDir, "stage"), filepath.Join(m.dir, "stage")); err == nil {
			_ = os.Rename(filepath.Join(oldDir, "journal.jsonl"), filepath.Join(m.dir, "journal.jsonl"))
			m.logf("took over the files the earlier move had copied")
		}
	}
	old.Phase = PhaseSuperseded
	_ = saveState(m.env.DataRoot, old, m.env.Now())
}

var friendly = map[string]string{
	"browser": "Browser", "desk": "Desk settings, Notebook and Chat", "agent": "Agent", "apps": "Apps", "files": "Files",
}

// listAll lists the cloud desk's parts and reads every manifest.
func (m *mover) listAll(ctx context.Context) ([]*partPlan, error) {
	var list struct {
		Parts []struct {
			Part  fsname.Name `json:"part"`
			Label string      `json:"label"`
		} `json:"parts"`
	}
	err := m.withSession(ctx, func(s *session.Session) error {
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()

		return s.Call(cctx, "data.parts.list", nil, &list)
	})
	if session.IsCode(err, "unavailable") {
		return nil, helperError{}
	}
	if err != nil {
		return nil, err
	}
	var plans []*partPlan
	for _, lp := range list.Parts {
		part := string(lp.Part)
		if !movablePart(part) {
			continue
		}
		if !utf8.ValidString(part) {
			// The state file keeps parts by name, as text. Only the desk's own software makes parts.
			return nil, &uncarriable{why: "it isn't UTF-8"}
		}
		label := friendly[part]
		if label == "" {
			label = lp.Label
		}
		if label == "" {
			label = part
		}
		plan := &partPlan{Name: part, Label: label}
		if plan.Entries, err = m.fetchManifest(ctx, part); err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].Name < plans[j].Name })

	return plans, nil
}

func (m *mover) checkChromiumAgainst(_ context.Context, lastVersion func() ([]byte, error)) error {
	lv, err := lastVersion()
	if err != nil {
		return fmt.Errorf("reading your Browser profile's version: %w", err)
	}
	if len(lv) == 0 {
		return nil
	}
	local, err := m.env.ChromiumVersion()
	if err != nil {
		local = ""
	}

	return checkChromium(local, lv)
}

func (m *mover) dryRunSummary(plans []*partPlan, free uint64, need int64) {
	m.say("This would move:")
	for _, p := range plans {
		f, b := p.counts()
		m.say("  %s: %s, %s", p.Label, plural(f, "file", "files"), humanBytes(b))
	}
	_, files, size := totals(plans)
	m.say("In all %s, %s, %s. This desk has %s free and needs %s.", plural(len(plans), "part", "parts"), plural(files, "file", "files"),
		humanBytes(size), humanBytes(int64(free)), humanBytes(max(0, need)+SpaceMargin))
	m.say("This desk's Browser can read your sign-ins, and it's new enough for your profile.")
}

// copyAll is the first pass: every part, up to Workers reads at once across all of them.
func (m *mover) copyAll(ctx context.Context, plans []*partPlan) error {
	var jobs []*job
	for _, p := range plans {
		if err := m.prepare(p); err != nil {
			return err
		}
		jobs = append(jobs, m.planJobs(p, false)...)
	}
	_, files, size := totals(plans)
	m.say("Copying %s, %s. Your cloud desk keeps working while this runs.", plural(files, "file", "files"), humanBytes(size))
	stop := m.progress(jobs)
	defer stop()

	return m.copyJobs(ctx, jobs)
}

func (m *mover) progress(jobs []*job) func() {
	if m.env.Progress == nil || len(jobs) == 0 {
		return func() {}
	}
	var total int64
	for _, j := range jobs {
		total += max(0, j.e.Size-j.offset)
	}
	base := m.bytesDone.Load()
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(m.env.ProgressEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				n := m.bytesDone.Load() - base
				pct := 100.0
				if total > 0 {
					pct = min(100, float64(n)*100/float64(total))
				}
				fmt.Fprintf(m.env.Progress, "Copying: %s of %s (%.0f%%)\n", humanBytes(n), humanBytes(total), pct)
			}
		}
	}()

	return func() { close(done) }
}

// delta is one part's last pass: it reads the part's manifest again and fetches what changed and every
// SQLite file, removing what went.
func (m *mover) delta(ctx context.Context, p *partPlan) error {
	entries, err := m.fetchManifest(ctx, p.Name)
	if err != nil {
		return err
	}
	p.Entries = entries
	if err := m.prepare(p); err != nil {
		return err
	}

	return m.copyJobs(ctx, m.planJobs(p, true))
}

// lastPass catches up every part, then holds the cloud desk's Browser so its profile is still, and
// catches up the Browser. A write to a database's -wal moves neither the main file's size nor its mtime, so
// every SQLite file in every part is read again: without that, a move could be done with an Agent thread
// missing. What's written after a file's last read stays on the cloud desk, which keeps running. The Browser's
// part is done only once a whole pass over it ran under one hold (heldDelta), and the hold is always released,
// an error or not.
func (m *mover) lastPass(ctx context.Context, plans []*partPlan) error {
	var browser *partPlan
	for _, p := range plans {
		if p.Name == "browser" {
			browser = p

			continue
		}
		if err := m.delta(ctx, p); err != nil {
			return err
		}
	}
	if browser == nil {
		m.cookiesNote = "your cloud desk has no Browser profile"

		return nil
	}

	var cookies struct {
		Items []SourceCookie `json:"items"`
	}
	err := m.withSession(ctx, func(s *session.Session) error {
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()

		return s.Call(cctx, "data.browser.cookies", nil, &cookies)
	})
	var re *session.RPCError
	switch {
	case errors.As(err, &re):
		m.cookiesNote = "your cloud desk's Browser wasn't running to compare with"
		m.logf("data.browser.cookies: %v", err)
	case err != nil:
		return err
	default:
		if err := m.saveSourceCookies(cookies.Items); err != nil {
			return err
		}
	}

	m.say("Copying the last changes to your Browser. Your cloud desk's Browser stops for this, and stays stopped after, so your sign-ins are only used here.")
	m.mu.Lock()
	m.holding = true
	m.mu.Unlock()
	defer m.release()
	stop := m.renewHold(ctx)
	defer stop()

	return m.heldDelta(ctx, browser)
}

// heldState is the hold deskd has for this move: on which session, since which hold (gen counts holds that
// weren't renewals of the one before), and until when at the latest, by this machine's clock.
type heldState struct {
	sess  *session.Session
	gen   int
	lost  bool
	until time.Time
}

// holdError is a hold the cloud desk kept refusing, or kept losing. The move stops before anything here changes:
// copying the Browser unheld could catch its files mid-write, and say done.
type holdError struct{ err error }

func (e *holdError) Error() string {
	return "your cloud desk's Browser couldn't be paused to copy its last changes (" + e.err.Error() + ")"
}

func (e *holdError) Unwrap() error { return errCopy }

var errNotHeld = errors.New("the cloud desk didn't say its Browser was held")

// heldDelta is the Browser's last pass, done only once a whole pass, from its listing to its last read, ran under
// one hold. A hold ends with its session, with a renewal deskd refuses, or after HoldFor, and deskd starts Chromium
// again when it ends, so files may have changed since they were listed. Then the profile is listed again and what
// changed is copied under the new hold, HoldTries passes at most. The pass that counts ends with its hold kept
// (keep), so the cloud desk's Chromium never runs again on the cookies this desk now has.
func (m *mover) heldDelta(ctx context.Context, browser *partPlan) error {
	for pass := 1; ; pass++ {
		gen, err := m.ensureHeld(ctx)
		if err != nil {
			return err
		}
		if err := m.delta(ctx, browser); err != nil {
			return err
		}
		if now, ok := m.heldGen(); ok && now == gen {
			m.mu.Lock()
			s := m.held.sess
			m.mu.Unlock()
			if err := m.keep(ctx, s); !errors.Is(err, errKeepLost) {
				return err
			}
		}
		if pass >= m.env.HoldTries {
			return &holdError{err: fmt.Errorf("its hold ended during %d passes in a row", pass)}
		}
		m.logf("the Browser's hold ended during its pass; listing it again under a new hold")
	}
}

// What became of keeping the cloud desk's Browser held after the move (Security's NE-2), in State.BrowserKept.
const (
	// KeptHeld: the cloud desk's deskd keeps its Browser stopped, through restarts, until the member starts it there.
	KeptHeld = "kept"
	// KeptUnsupported: the cloud desk's deskd is from before data.browser.keep, so its Browser started again.
	KeptUnsupported = "unsupported"
	// KeptFailed: the cloud desk's deskd couldn't record the keep, so its Browser started again.
	KeptFailed = "failed"
)

// errKeepLost means the hold ended before deskd kept it, so Chromium may have run since the pass.
var errKeepLost = errors.New("the Browser's hold ended before it could be kept")

// keep asks deskd to keep the hold s has past the move (data.browser.keep), so the cloud desk's Chromium doesn't start
// again on the cookies this desk now has, where a site that rotates its sign-in tokens would sign the member out here.
// deskd answers only if s held the Browser the whole time, so nothing ran between the pass and the keep. A hold that
// ended first is errKeepLost: the caller copies again under a new hold, and keeps that. A deskd that can't keep it
// changes nothing else: every file is here, and the done line says the cloud desk's Browser started again.
func (m *mover) keep(ctx context.Context, s *session.Session) error {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var r struct {
		Kept bool `json:"kept"`
	}
	err := s.CallMutation(cctx, "data.browser.keep", nil, &r)
	var re *session.RPCError
	switch {
	case err == nil && r.Kept:
		return m.keptAs(KeptHeld)
	case err == nil:
		m.logf("data.browser.keep answered without kept")

		return m.keptAs(KeptFailed)
	case errors.As(err, &re) && re.Code == "not_found":
		m.logf("the cloud desk's deskd can't keep its Browser held after the move: %v", err)

		return m.keptAs(KeptUnsupported)
	case errors.As(err, &re) && re.Code == "unavailable" && (re.Reason() == "not_held" || re.Reason() == ""):
		// not_held, or the session ended while it ran: either way the hold may have gone, and Chromium with it.
	case errors.As(err, &re):
		m.logf("data.browser.keep: %v", err)

		return m.keptAs(KeptFailed)
	case errors.Is(err, session.ErrDisconnected) || (errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil):
		// The hold ended with the session. deskd may have kept it first, and keeping it again is the same keep.
	default:
		return err
	}
	m.mu.Lock()
	if m.held.sess == s {
		m.held.lost = true
	}
	m.mu.Unlock()
	m.logf("the Browser's hold ended before it was kept (%v); copying again under a new hold", err)

	return errKeepLost
}

// keptAs records what became of the keep, so a rerun that only finishes the swap still says it.
func (m *mover) keptAs(outcome string) error {
	m.st.BrowserKept = outcome

	return m.save()
}

// heldGen is the hold this move has now, if it has one it can count on: on the session that's open, not known to
// be lost, and not near its end.
func (m *mover) heldGen() (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.held
	if h.sess == nil || h.sess != m.sess || h.sess.Err() != nil || h.lost || !m.env.Now().Before(h.until) {
		return 0, false
	}

	return h.gen, true
}

// ensureHeld holds the Browser unless this move already holds it, and returns that hold's gen.
func (m *mover) ensureHeld(ctx context.Context) (int, error) {
	err := m.withSession(ctx, func(s *session.Session) error {
		if _, ok := m.heldGen(); ok {
			return nil // a new session holds it before it's used
		}

		return m.hold(ctx, s)
	})
	if err != nil {
		return 0, err
	}
	gen, ok := m.heldGen()
	if !ok {
		return 0, &holdError{err: errors.New("it was let go as soon as it was held")}
	}

	return gen, nil
}

// hold asks the cloud desk to keep its Browser stopped, on s, and asks again after a refusal, HoldTries times in
// all. Then it's a *holdError, which stops the move. A session that drops is the caller's: a new one holds again.
func (m *mover) hold(ctx context.Context, s *session.Session) error {
	for attempt := 1; ; attempt++ {
		err := m.holdOnce(ctx, s, false)
		var re *session.RPCError
		switch {
		case err == nil:
			return nil
		case !errors.As(err, &re) && !errors.Is(err, errNotHeld):
			return err
		case attempt >= m.env.HoldTries:
			return &holdError{err: err}
		}
		m.logf("data.browser.hold: %v; asking again", err)
		select {
		case <-time.After(m.env.Backoff(attempt)):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// holdOnce is one data.browser.hold, a new hold or a renewal of this session's: deskd starts its time again. A
// renewal that answers after another session's hold has taken over changes nothing here.
func (m *mover) holdOnce(ctx context.Context, s *session.Session, renewal bool) error {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	asked := m.env.Now()
	var r struct {
		Held bool `json:"held"`
	}
	if err := s.CallMutation(cctx, "data.browser.hold", nil, &r); err != nil {
		return err
	}
	if !r.Held {
		return errNotHeld
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if renewal && m.held.sess != s {
		return nil
	}
	if m.held.sess != s || m.held.lost {
		m.held.gen++ // not a renewal: Chromium may have run since the last hold
	}
	// deskd's own until is from its clock, after this was asked, and to the second: a tenth less is safe from both.
	m.held = heldState{sess: s, gen: m.held.gen, until: asked.Add(m.env.HoldFor - m.env.HoldFor/10)}

	return nil
}

// renewHold renews the hold every HoldRenew while the Browser's pass runs, as a hold lasts HoldFor. A renewal
// deskd refuses means it has let go (BrowserHold drops a hold whose stop fails), and one that doesn't arrive
// can't be counted on either: the hold is lost, and the pass it was under is done again under a new one.
func (m *mover) renewHold(ctx context.Context) func() {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(m.env.HoldRenew)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
			}
			m.mu.Lock()
			s, lost := m.held.sess, m.held.lost
			m.mu.Unlock()
			if s == nil || lost || s.Err() != nil {
				continue // a new session, or the next pass, holds it again
			}
			if err := m.holdOnce(ctx, s, true); err != nil {
				m.mu.Lock()
				if m.held.sess == s {
					m.held.lost = true
				}
				m.mu.Unlock()
				m.logf("renewing the Browser's hold: %v", err)
			}
		}
	}()

	return func() { close(done) }
}

func (m *mover) release() {
	m.mu.Lock()
	m.holding = false
	s := m.sess
	m.mu.Unlock()
	if s == nil || s.Err() != nil {
		return // the hold ended with its session
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.CallMutation(ctx, "data.browser.release", nil, nil); err != nil {
		m.logf("data.browser.release: %v (deskd lets go of it at the session's end anyway)", err)
	}
}

// checkAndSwap runs the checks on what's staged, then swaps.
func (m *mover) checkAndSwap(ctx context.Context, plans []*partPlan) error {
	m.say("Checking every file.")
	m.report(platformReport("checking", m.partSummaries(), m.st.Checks, ""))
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := m.checkChromiumAgainst(ctx, func() ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(m.partStage("browser"), "profile", "Last Version"))
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}

		return b, err
	}); err != nil {
		return m.checked(CheckChromium, err)
	}
	launch, err := m.env.BrowserLaunch()
	if err != nil {
		return m.checked(CheckPasswordStore, &Refusal{Check: CheckPasswordStore, Message: "This desk's Browser has gone since the check, so nothing on this desk was changed. Run the install again, then run sudo ma-move again."})
	}
	if err := m.checked(CheckPasswordStore, checkPasswordStore(launch)); err != nil {
		return err
	}
	_, bad, err := m.verifyStaged(plans)
	if err != nil {
		return err
	}
	if bad > 0 {
		return m.checked(CheckFiles, unverified(bad))
	}
	_ = m.checked(CheckFiles, nil)
	for _, p := range plans {
		if err := finishDirs(m.partStage(p.Name), p.Entries); err != nil {
			return err
		}
	}
	parts, _, _ := totals(plans)
	m.st.Parts = nil
	for _, p := range plans {
		m.st.Parts = append(m.st.Parts, p.Name)
	}
	m.st.Totals = parts
	m.st.Phase = PhaseSwapping
	if err := m.save(); err != nil {
		return err
	}

	return m.finishLocal(ctx)
}

// finishLocal is everything after the checks, none of which needs the cloud desk: the swap, the proof
// and the report. A rerun after a crash comes straight here.
func (m *mover) finishLocal(ctx context.Context) error {
	if m.st.Phase == PhaseSwapping {
		if err := m.swap(); err != nil {
			return err
		}
	}
	cookies := m.prove(ctx)
	if cookies.Checked {
		var err error
		if cookies.Readable != cookies.Total {
			err = errors.New("some sign-in cookies don't work here")
		}
		_ = m.checked(CheckCookies, err)
	}
	m.st.Phase = PhaseDone
	if err := m.save(); err != nil {
		return err
	}
	parts := m.partSummaries()
	files, size := sumParts(parts)
	before := ""
	if exists(filepath.Join(m.dir, "before")) {
		before = filepath.Join(m.dir, "before")
	}
	_ = m.writeLocalReport(LocalReport{
		State: "done", Parts: parts, Files: files, Bytes: size, Cookies: cookies, Before: before, Checks: m.st.Checks,
		BrowserKept: m.st.BrowserKept,
	})
	m.report(platformReport("done", parts, m.st.Checks, ""))
	m.say("%s", summary(len(parts), files, size, cookies, len(m.refusedLinks), before, m.st.BrowserKept))

	return nil
}

func (m *mover) swap() error {
	m.say("Putting your data in place. This desk's Browser and services stop for a moment.")
	if !m.st.ServicesKnown {
		var units []string
		for _, u := range swapUnits {
			if m.env.Systemd.Exists(u) && m.env.Systemd.IsActive(u) {
				units = append(units, u)
			}
		}
		m.st.Services, m.st.ServicesKnown = units, true
		if err := m.save(); err != nil {
			return err
		}
	}
	if err := m.stopServices(); err != nil {
		_ = m.startServices(m.st.Services)

		return err
	}
	for _, part := range m.st.Parts {
		if contains(m.st.Swapped, part) {
			continue
		}
		if err := m.swapPart(part); err != nil {
			if m.allPartsPresent() {
				_ = m.startServices(m.st.Services)
			}

			return err
		}
		m.st.Swapped = append(m.st.Swapped, part)
		if err := m.save(); err != nil {
			return err
		}
	}
	if err := m.startServices(m.st.Services); err != nil {
		m.logf("%v", err)
	}
	m.st.Phase = PhaseProving

	return m.save()
}

func (m *mover) allPartsPresent() bool {
	for _, p := range m.st.Parts {
		if !exists(filepath.Join(m.env.DataRoot, p)) {
			return false
		}
	}

	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}

	return false
}

// prove starts this desk's Browser and compares its cookies with the cloud desk's.
func (m *mover) prove(ctx context.Context) CookieResult {
	src, ok := m.loadSourceCookies()
	if !ok {
		note := m.cookiesNote
		if note == "" {
			note = "there was no list from your cloud desk to compare with"
		}

		return CookieResult{Note: note}
	}
	m.say("Starting this desk's Browser to check your sign-ins.")
	if err := m.env.Systemd.Start("desk-browser"); err != nil {
		m.logf("starting desk-browser: %v", err)

		return CookieResult{Note: "this desk's Browser didn't start"}
	}
	pctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	local, err := m.env.LocalCookies(pctx)
	if err != nil {
		m.logf("reading this desk's cookies: %v", err)

		return CookieResult{Note: "this desk's Browser didn't answer"}
	}

	return compareCookies(src, local, m.env.Now())
}

// session returns the open session, or opens one, trying for ReconnectFor before giving up.
func (m *mover) session(ctx context.Context) (*session.Session, error) {
	m.mu.Lock()
	s := m.sess
	m.mu.Unlock()
	if s != nil && s.Err() == nil {
		return s, nil
	}
	first := m.env.Now()
	for attempt := 0; ; attempt++ {
		s, err := m.open(ctx)
		if err == nil {
			m.mu.Lock()
			m.sess = s
			m.mu.Unlock()

			return s, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if moveEnded(err) {
			return nil, &endedError{err}
		}
		var he *holdError
		if permanentAPI(err) || errors.As(err, &he) {
			return nil, err
		}
		if m.env.Now().Sub(first) > m.env.ReconnectFor {
			return nil, fmt.Errorf("couldn't reach your cloud desk for %s: %w: %w", m.env.ReconnectFor.Round(time.Minute), errUnreachable, err)
		}
		m.logf("reaching the cloud desk: %v", err)
		select {
		case <-time.After(m.env.Backoff(attempt)):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (m *mover) open(ctx context.Context) (*session.Session, error) {
	octx, cancel := context.WithTimeout(ctx, m.env.WakeFor+2*time.Minute)
	defer cancel()
	t, err := m.env.Dial(octx, m.st.SourceDeskID, m.connectReady)
	if err != nil {
		return nil, err
	}
	s, err := session.Open(octx, t, session.Options{AppVersion: "ma-move/" + Version, KeepaliveInterval: m.env.Keepalive, Log: m.env.Log})
	if err != nil {
		_ = t.Close()

		return nil, err
	}
	m.mu.Lock()
	holding := m.holding
	m.mu.Unlock()
	if holding {
		if err := m.hold(octx, s); err != nil {
			s.Close()

			return nil, err
		}
	}
	go m.refresher(s)
	m.logf("session with the cloud desk open")

	return s, nil
}

// connectReady asks for a desk token, waking the cloud desk if it's stopped, and waits until it's ready.
func (m *mover) connectReady(ctx context.Context, fp string) (*client.ConnectReply, error) {
	m.mu.Lock()
	m.fp = fp
	m.mu.Unlock()
	start := true
	deadline := m.env.Now().Add(m.env.WakeFor)
	for {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		r, err := m.env.API.Connect(cctx, m.st.MoveID, m.st.MoveToken, fp, start)
		cancel()
		if err != nil {
			return nil, err
		}
		if r.Phase == "" || r.Phase == "ready" {
			return r, nil
		}
		if r.Phase == "failed" || (r.Phase == "stopped" && !start) {
			return nil, fmt.Errorf("your cloud desk didn't wake (%s)", r.Phase)
		}
		start = false
		if m.env.Now().After(deadline) {
			return nil, errors.New("your cloud desk is taking too long to wake")
		}
		wait := m.env.WakePoll
		if r.RetryAfterSeconds > 0 {
			wait = max(wait, time.Duration(r.RetryAfterSeconds)*time.Second)
		}
		m.logf("cloud desk: %s", r.Phase)
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// refresher keeps the session's desk token fresh: tokens last 5 minutes, a move many hours.
func (m *mover) refresher(s *session.Session) {
	t := time.NewTicker(m.env.RefreshEvery)
	defer t.Stop()
	for {
		select {
		case <-s.Done():
			return
		case <-t.C:
		}
		m.mu.Lock()
		fp := m.fp
		m.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		r, err := m.env.API.Connect(ctx, m.st.MoveID, m.st.MoveToken, fp, false)
		if err == nil {
			err = s.Refresh(ctx, r.DeskToken)
		}
		cancel()
		if err != nil {
			m.logf("refreshing the desk token: %v", err)
		}
	}
}

func (m *mover) dropSession(s *session.Session) {
	m.mu.Lock()
	if m.sess == s {
		m.sess = nil
	}
	m.mu.Unlock()
	s.Close()
}

func (m *mover) closeSession() {
	m.mu.Lock()
	s := m.sess
	m.sess = nil
	m.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

// withSession runs fn on the open session, and again on a new one when the session drops under it.
func (m *mover) withSession(ctx context.Context, fn func(*session.Session) error) error {
	for tries := 0; ; tries++ {
		s, err := m.session(ctx)
		if err != nil {
			return err
		}
		err = fn(s)
		retry := errors.Is(err, session.ErrDisconnected) || (errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil)
		if !retry || tries >= 20 {
			return err
		}
		m.logf("the session to the cloud desk dropped; reconnecting")
		m.dropSession(s)
	}
}
