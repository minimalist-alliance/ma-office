package rtcserver

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// S-29: desk-egress's allowance profile is a ceiling, like deskd's stream.limit, and the reply says the level is held.

// newProfileHub is newQualityHub with a profile file, which the hub reads at start.
func newProfileHub(t *testing.T, profile string) (*streamHub, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "profile")
	writeProfile(t, path, profile)
	srv := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil)), cfg: Config{ProfileFile: path}}
	srv.hub = newStreamHub(srv)
	t.Cleanup(srv.hub.close)

	return srv.hub, path
}

// writeProfile writes the file as desk-egress does, one word and a newline; "" removes it.
func writeProfile(t *testing.T, path, profile string) {
	t.Helper()
	if profile == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}

		return
	}
	if err := os.WriteFile(path, []byte(profile+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadProfile(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct{ text, want string }{
		{"capped\n", "capped"},
		{"deep\n", "deep"},
		{"deep", "deep"},
		{"  capped \n", "capped"},
		{"normal\n", ""},
		{"", ""},
		{"Capped\n", ""},
		{"sparkly\n", ""},
		{"../../etc/passwd\n", ""},
	} {
		path := filepath.Join(dir, "p")
		if err := os.WriteFile(path, []byte(c.text), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := readProfile(path); got != c.want {
			t.Errorf("%q: %q, want %q", c.text, got, c.want)
		}
	}
	if got := readProfile(filepath.Join(dir, "missing")); got != "" {
		t.Errorf("missing file: %q", got)
	}
	if got := readProfile(""); got != "" {
		t.Errorf("no path: %q", got)
	}
}

// A member on Max past 100 GB: the stream runs Medium (the capped picture) and the reply says held at Medium; a member
// on Low keeps Low, which is inside the cap, with no flag. Past 500 GB everything is held at Low.
func TestProfileHoldsTheLevel(t *testing.T) {
	for _, c := range []struct {
		profile string
		ask     level
		want    []byte
	}{
		{"capped", levelMax, reply(levelMedium, levelMedium, flagHeld)},
		{"capped", levelHigh, reply(levelMedium, levelMedium, flagHeld)},
		{"capped", levelMedium, reply(levelMedium, levelMedium, 0)},
		{"capped", levelLow, reply(levelLow, levelMedium, 0)},
		{"deep", levelMax, reply(levelLow, levelLow, flagHeld)},
		{"deep", levelLow, reply(levelLow, levelLow, 0)},
		{"normal", levelMax, reply(levelMax, levelNone, 0)},
		{"", levelLow, reply(levelLow, levelNone, 0)},
	} {
		h, _ := newProfileHub(t, c.profile)
		a, ka := newQualitySession(t, h, "cs-a", true)
		h.setQuality(a, c.ask)
		h.setViewer(a, true)
		ka.expect(t, c.profile+" asking "+c.ask.String(), c.want)
		if got, want := levelOf(h), level(c.want[1]); got != want {
			t.Errorf("%s asking %s: level %s, want %s", c.profile, c.ask, got, want)
		}
	}
}

// The lower ceiling wins: deskd's limit under the profile's, or the profile's under deskd's.
func TestProfileAndLimit(t *testing.T) {
	h, _ := newProfileHub(t, "capped")
	a, ka := newQualitySession(t, h, "cs-a", true)
	h.setQuality(a, levelMax)
	h.setViewer(a, true)
	ka.expect(t, "capped", reply(levelMedium, levelMedium, flagHeld))
	h.setLimit(str("low"))
	ka.expect(t, "limit low under capped", reply(levelLow, levelLow, flagHeld))
	h.setLimit(str("high"))
	ka.expect(t, "limit high over capped", reply(levelMedium, levelMedium, flagHeld))
	h.setLimit(nil)
	ka.expect(t, "no limit: the same reply, so none")
}

// desk-egress names the new profile and then restarts desk-stream, so the next connection is where desk-rtc reads it:
// the level line it sends first is the held one, and viewers hear the new ceiling. Going back works the same way.
func TestProfileChangesOnTheNextDeskStream(t *testing.T) {
	h, path := newProfileHub(t, "")
	a, ka := newQualitySession(t, h, "cs-a", true)
	h.setQuality(a, levelMax)
	h.setViewer(a, true)
	ka.expect(t, "normal", reply(levelMax, levelNone, 0))
	s := attachStream(t, h)
	if got := s.nextCmd(time.Second); got != "level max" {
		t.Fatalf("normal: %q", got)
	}

	writeProfile(t, path, "capped")
	ka.expect(t, "file changed, desk-stream not restarted yet") // desk-stream still runs stream.conf
	s2 := attachStream(t, h)
	if got := s2.nextCmd(time.Second); got != "level medium" {
		t.Fatalf("capped: first line %q", got)
	}
	ka.expect(t, "capped", reply(levelMedium, levelMedium, flagHeld))
	st := h.stats()
	if st.Profile == nil || *st.Profile != "capped" || st.Level != "medium" || st.Limit != nil {
		t.Fatalf("stats: profile %v level %s limit %v", st.Profile, st.Level, st.Limit)
	}

	writeProfile(t, path, "deep")
	s3 := attachStream(t, h)
	if got := s3.nextCmd(time.Second); got != "level low" {
		t.Fatalf("deep: first line %q", got)
	}
	ka.expect(t, "deep", reply(levelLow, levelLow, flagHeld))

	writeProfile(t, path, "")
	s4 := attachStream(t, h)
	if got := s4.nextCmd(time.Second); got != "level max" {
		t.Fatalf("back to normal: first line %q", got)
	}
	ka.expect(t, "normal again", reply(levelMax, levelNone, 0))
	if st := h.stats(); st.Profile != nil {
		t.Fatalf("stats: profile %q after normal", *st.Profile)
	}
}
