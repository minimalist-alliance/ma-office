package move

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func thousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}

	return b.String()
}

func humanBytes(n int64) string {
	switch {
	case n < 1000:
		return plural(int(n), "byte", "bytes")
	case n < 1000*1000:
		return fmt.Sprintf("%.1f KB", float64(n)/1e3)
	case n < 1000*1000*1000:
		return fmt.Sprintf("%.1f MB", float64(n)/1e6)
	case n < 1000*1000*1000*1000:
		return fmt.Sprintf("%.1f GB", float64(n)/1e9)
	default:
		return fmt.Sprintf("%.1f TB", float64(n)/1e12)
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}

	return thousands(int64(n)) + " " + many
}

func pick(n int, one, many string) string {
	if n == 1 {
		return one
	}

	return many
}

// PartSummary is one part in report.json.
type PartSummary struct {
	Part  string `json:"part"`
	Label string `json:"label"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}

// LocalReport is /data/.ma-move/<moveId>/report.json. It stays on this desk.
type LocalReport struct {
	FormatVersion int             `json:"formatVersion"`
	MoveID        string          `json:"moveId"`
	State         string          `json:"state"`
	Error         string          `json:"error,omitempty"`
	Message       string          `json:"message,omitempty"`
	SourceName    string          `json:"sourceName,omitempty"`
	TargetName    string          `json:"targetName,omitempty"`
	StartedAt     string          `json:"startedAt,omitempty"`
	FinishedAt    string          `json:"finishedAt"`
	Parts         []PartSummary   `json:"parts"`
	Files         int             `json:"files"`
	Bytes         int64           `json:"bytes"`
	Checks        map[string]bool `json:"checks"`
	Cookies       CookieResult    `json:"cookies"`
	LinksLeftOut  int             `json:"linksLeftOut"`
	Before        string          `json:"before,omitempty"`
	BrowserKept   string          `json:"browserKept,omitempty"` // KeptHeld, KeptUnsupported, KeptFailed, or none without a Browser
}

// totals counts what's moved: parts, files and bytes as last listed.
func totals(plans []*partPlan) (parts []PartSummary, files int, size int64) {
	for _, p := range plans {
		f, b := p.counts()
		parts = append(parts, PartSummary{Part: p.Name, Label: p.Label, Files: f, Bytes: b})
		files += f
		size += b
	}

	return parts, files, size
}

// platformReport is what goes to the platform: counts and a fixed state, nothing else.
func platformReport(state string, parts []PartSummary, checks map[string]bool, errCode string) PlatformReport {
	r := PlatformReport{State: state, Parts: len(parts), Error: errCode}
	for _, p := range parts {
		r.Files += p.Files
		r.Bytes += p.Bytes
	}
	for _, ok := range checks {
		if ok {
			r.Checks.Passed++
		} else {
			r.Checks.Failed++
		}
	}
	if state != "failed" {
		r.Error = "" // the platform takes an error only with failed
	}

	return r
}

func sumParts(parts []PartSummary) (files int, size int64) {
	for _, p := range parts {
		files += p.Files
		size += p.Bytes
	}

	return files, size
}

func (m *mover) writeLocalReport(r LocalReport) error {
	r.FormatVersion = 1
	r.MoveID = m.st.MoveID
	r.SourceName, r.TargetName, r.StartedAt = m.st.SourceName, m.st.TargetName, m.st.StartedAt
	r.FinishedAt = m.env.Now().UTC().Format(time.RFC3339)
	r.LinksLeftOut = len(m.refusedLinks)
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}

	return writeFileAtomic(filepath.Join(m.dir, "report.json"), append(b, '\n'), 0o600)
}

// summary is what the member reads at the end.
// keptLine is what a member reads about their cloud desk's Browser once the move has kept it stopped (Security's NE-2).
const keptLine = "Your cloud desk's Browser stays stopped, so your sign-ins are only used here, where a site that changes them won't sign you out. To use it there again, open that desk in your office and start its Browser; nothing else starts it."

func summary(parts, files int, size int64, cookies CookieResult, linksLeftOut int, before, browserKept string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Your desk is moved. %s, %s, %s, every file checked.", plural(parts, "part", "parts"), plural(files, "file", "files"), humanBytes(size))
	switch {
	case !cookies.Checked:
		b.WriteString(" Your sign-ins couldn't be checked here")
		if cookies.Note != "" {
			b.WriteString(": " + cookies.Note)
		}
		b.WriteString(".")
	case cookies.Total == 0:
		b.WriteString(" There were no sign-in cookies to check.")
	case cookies.Readable == cookies.Total:
		fmt.Fprintf(&b, " %s of %s sign-in cookies work here.", thousands(int64(cookies.Readable)), thousands(int64(cookies.Total)))
	default:
		rest := cookies.Total - cookies.Readable
		fmt.Fprintf(&b, " %s of %s sign-in cookies work here; %s (%s not found, %s unreadable) will ask you to sign in again.",
			thousands(int64(cookies.Readable)), thousands(int64(cookies.Total)), pick(rest, "the site of the other one", "the sites of the other "+thousands(int64(rest))),
			thousands(int64(cookies.Missing)), thousands(int64(cookies.Different)))
	}
	switch browserKept {
	case KeptHeld:
		b.WriteString(" Your cloud desk's files are unchanged. " + keptLine + " It stays in your office until you choose to remove it.")
	case KeptUnsupported, KeptFailed:
		b.WriteString(" Your cloud desk is unchanged, and its Browser started again there: use the Browser on one desk only, or a site may sign you out on the other. It stays in your office until you choose to remove it.")
	default:
		b.WriteString(" Your cloud desk is unchanged. It stays in your office until you choose to remove it.")
	}
	if linksLeftOut > 0 {
		fmt.Fprintf(&b, "\n%s that pointed outside %s folder %s left out.", plural(linksLeftOut, "shortcut", "shortcuts"), pick(linksLeftOut, "its", "their"), pick(linksLeftOut, "was", "were"))
	}
	if before != "" {
		fmt.Fprintf(&b, "\nWhat this desk had before is kept in %s.", before)
	}

	return b.String()
}
