package move

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Refusal is a check that failed before anything on this desk changed. It exits 3.
type Refusal struct {
	Check   string // chromium, password_store, space, unverified
	Message string
}

func (r *Refusal) Error() string { return r.Message }

var versionRE = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,3}$`)

// parseVersion reads a dotted Chromium version, as desk-browser-start does.
func parseVersion(s string) ([]int, bool) {
	s = strings.TrimSpace(s)
	if !versionRE.MatchString(s) {
		return nil, false
	}
	var out []int
	for _, p := range strings.Split(s, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}

	return out, true
}

func compareVersions(a, b []int) int {
	for i := 0; i < max(len(a), len(b)); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x < y {
				return -1
			}

			return 1
		}
	}

	return 0
}

var chromiumVersionRE = regexp.MustCompile(`[0-9]+(\.[0-9]+){1,3}`)

// CleanChromiumVersion takes `chromium --version` output or a Debian package version (1:156.0.8078.79-1)
// and returns the dotted version.
func CleanChromiumVersion(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, ":"); i >= 0 && i < 4 {
		s = s[i+1:]
	}

	return chromiumVersionRE.FindString(s)
}

// checkChromium is ADR 0035: this desk's Chromium must be the same as or newer than the one the profile
// last ran, or it would raze the cookies. A profile with no Last Version has never finished a start.
func checkChromium(local string, lastVersion []byte) error {
	last := strings.TrimSpace(string(lastVersion))
	if last == "" {
		return nil
	}
	lv, ok := parseVersion(last)
	if !ok {
		return &Refusal{Check: "chromium", Message: "Your cloud desk's Browser profile has a version this program can't read, " +
			"so it can't tell whether this desk's Browser is new enough to open it. Nothing on this desk was changed."}
	}
	loc := CleanChromiumVersion(local)
	cv, ok := parseVersion(loc)
	if !ok {
		return &Refusal{Check: "chromium", Message: "This program couldn't find out which version of Chromium this desk has, " +
			"so it can't tell whether it's new enough for your Browser profile. Nothing on this desk was changed."}
	}
	if compareVersions(cv, lv) < 0 {
		return &Refusal{Check: "chromium", Message: fmt.Sprintf("This desk's Chromium (%s) is older than the one your cloud desk's Browser last ran (%s). "+
			"An older Chromium would sign you out of every site, so nothing on this desk was changed. "+
			"Update Chromium on this desk, then run sudo ma-move again.", loc, last)}
	}

	return nil
}

// checkPasswordStore is the draft ADR's section 9 step 4: this desk's Browser must use
// --password-store=basic, as cloud desks do, so the cookies decrypt here. text is `systemctl cat
// desk-browser` and the wrapper it runs. Comment lines don't count.
func checkPasswordStore(text string) error {
	var basic, other bool
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "#") || strings.HasPrefix(l, ";") {
			continue
		}
		for _, f := range strings.Fields(l) {
			f = strings.Trim(f, `"'\`)
			v, ok := strings.CutPrefix(f, "--password-store=")
			if !ok {
				continue
			}
			if v == "basic" {
				basic = true
			} else {
				other = true
			}
		}
	}
	if basic && !other {
		return nil
	}

	return &Refusal{Check: "password_store", Message: "This desk's Browser doesn't keep sign-ins the way cloud desks do (Chromium's --password-store=basic). " +
		"Without it your sign-ins couldn't be read here, so nothing on this desk was changed. " +
		"Run the self-hosted desk's install again to update its Browser, then run sudo ma-move again."}
}

// SpaceMargin is what a move leaves free on /data beyond what it copies.
const SpaceMargin = 2 << 30

func checkSpace(free uint64, need int64) error {
	if need < 0 {
		need = 0
	}
	want := uint64(need) + SpaceMargin
	if free >= want {
		return nil
	}

	return &Refusal{Check: "space", Message: fmt.Sprintf("This desk needs %s free for the move and has %s. "+
		"Nothing on this desk was changed. Free some space, then run sudo ma-move again.", humanBytes(int64(want)), humanBytes(int64(free)))}
}

func unverified(bad int) error {
	return &Refusal{Check: CheckFiles, Message: fmt.Sprintf("%s couldn't be checked against your cloud desk's copy, "+
		"so nothing on this desk was changed. Run sudo ma-move again to fetch %s again.", plural(bad, "file", "files"), pick(bad, "it", "them"))}
}
