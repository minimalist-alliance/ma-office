package rtcserver

import (
	"io"
	"os"
	"strings"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xinput"
)

// Stream quality levels (ADR 0039, docs/interfaces/stream-quality.md sections 3 and 4). Each session asks for a
// level with QUALITY on keys. The stream runs at the highest ask among the sessions viewing, a session that never
// asked counting as High, lowered to deskd's stream.limit and to the ceiling of the allowance profile desk-egress has
// picked (profileCeilings). desk-stream hears it as "level <name>", at most once per levelPace, and each session viewing
// hears it as a QUALITY reply on keys.

// level is a quality level. The numbers are the wire's, and their order is what "highest" and "at most" compare.
type level uint8

const (
	levelNone   level = 0 // no ask, or no limit
	levelLow    level = 1
	levelMedium level = 2
	levelHigh   level = 3 // the default: a session that never asks, and where the stream starts
	levelMax    level = 4
)

var levelNames = [...]string{levelLow: "low", levelMedium: "medium", levelHigh: "high", levelMax: "max"}

const (
	// qualityAsk is the client's QUALITY on keys, and qualityReply desk-rtc's.
	qualityAsk   = 7
	qualityReply = 0x82

	// Reply flags: held below this session's ask by the limit, or above it because another viewer asked for more.
	flagHeld   = 1
	flagRaised = 2

	// levelPace is the least time between two level lines to desk-stream. Each one costs a keyframe.
	levelPace = 500 * time.Millisecond
)

// String is the level's name for desk-stream and stats, "" for levelNone.
func (l level) String() string {
	if l > levelMax {
		return ""
	}

	return levelNames[l]
}

// name is the level's name, nil for levelNone: what stats carry for a limit or an ask.
func (l level) name() *string {
	if l == levelNone || l > levelMax {
		return nil
	}
	n := levelNames[l]

	return &n
}

func parseLevel(name string) (level, bool) {
	for l := levelLow; l <= levelMax; l++ {
		if levelNames[l] == name {
			return l, true
		}
	}

	return levelNone, false
}

// parseQuality reads a client's QUALITY: exactly 16 bytes, a level of 0 to 4 (0 withdraws the ask) and stream 0. The
// other bytes, seq included, aren't read.
func parseQuality(b []byte) (level, bool) {
	if len(b) != xinput.EventSize || b[0] != qualityAsk || level(b[1]) > levelMax || b[2] != 0 {
		return levelNone, false
	}

	return level(b[1]), true
}

// onQuality takes a QUALITY from keys. It's true when b is one, well formed or not, and has been dealt with. It isn't
// input: no input permission, no input.activity, and nothing reaches X. A session without video may ask too: its ask
// is kept until the session closes or withdraws it, and counts while the session views.
func (s *session) onQuality(b []byte) bool {
	if len(b) == 0 || b[0] != qualityAsk {
		return false
	}
	l, ok := parseQuality(b)
	if !ok {
		s.keysDropped.Add(1)

		return true
	}
	s.link.srv.hub.setQuality(s, l)

	return true
}

// ask is what the session counts as: its ask, or High when it has none. Under streamHub.mu.
func (s *session) ask() level {
	if s.quality == levelNone {
		return levelHigh
	}

	return s.quality
}

// qualityState is the hub's half. streamHub.mu guards it.
type qualityState struct {
	asked   level       // the highest ask among the sessions viewing, kept while nobody views
	limit   level       // deskd's stream.limit, levelNone for none
	profile string      // desk-egress's allowance profile (ADR 0036) as last read, "" for the normal picture
	level   level       // in effect: asked, lowered to the ceiling
	sent    level       // the last level line on this desk-stream connection
	sentAt  time.Time   // when it went
	timer   *time.Timer // a paced level line, waiting out levelPace
	closed  bool
}

func newQualityState() qualityState {
	return qualityState{asked: levelHigh, level: levelHigh}
}

// Past a member's allowance desk-egress picks a softer profile (ADR 0036 section 5), and desk-stream's run starts the
// conf it names. Each profile's conf holds every level to its own picture (stream-quality.md section 5): capped keeps
// Low as Low and gives Medium, High and Max the capped picture, which is Medium's size and ceiling (1080p, 4 Mbit, a
// quantizer of 28 against Medium's 27); deep gives every level its 540-line picture, at Low's 2.5 Mbit ceiling. So the
// profile is a ceiling here, as deskd's stream.limit is, and the reply says plainly that the level is held (flags bit 0,
// with the ceiling in its limit byte) rather than echo an ask the picture isn't keeping. S-29.
var profileCeilings = map[string]level{"capped": levelMedium, "deep": levelLow}

// profileFileMax is the most of the profile file read: desk-egress writes one word and a newline.
const profileFileMax = 64

// ceiling is the lower of deskd's limit and the allowance profile's, levelNone when neither is set.
func (q *qualityState) ceiling() level {
	c := profileCeilings[q.profile] // levelNone for normal and anything unknown
	if q.limit != levelNone && (c == levelNone || q.limit < c) {
		c = q.limit
	}

	return c
}

// readProfile is the profile named in path: "capped" or "deep", or "" for the normal picture, a missing or unreadable
// file and anything else, as desk-stream's run reads it.
func readProfile(path string) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b := make([]byte, profileFileMax)
	n, _ := io.ReadFull(f, b)
	name := strings.TrimSpace(string(b[:n]))
	if _, known := profileCeilings[name]; !known {
		return ""
	}

	return name
}

// readProfileLocked takes the profile file as it is now, and follows a change. desk-egress writes it before it restarts
// desk-stream, and desk-stream reads it as it starts, so a new desk-stream connection is when both agree.
func (h *streamHub) readProfileLocked() {
	p := readProfile(h.profileFile)
	if p == h.q.profile {
		return
	}
	h.log.Info("stream profile", "profile", profileName(p), "ceiling", profileCeilings[p].String())
	h.q.profile = p
	h.updateLevelLocked()
}

func profileName(p string) string {
	if p == "" {
		return "normal"
	}

	return p
}

func (h *streamHub) setQuality(s *session, l level) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s.quality = l
	h.updateLevelLocked()
}

// setLimit applies stream.limit: a level name, or nil for none. An unknown name is none.
func (h *streamHub) setLimit(name *string) {
	limit := levelNone
	if name != nil {
		var ok bool
		if limit, ok = parseLevel(*name); !ok {
			h.log.Warn("unknown level in stream.limit, so no limit", "level", *name)
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if limit == h.q.limit {
		return
	}
	h.log.Info("stream limit", "limit", limit.String())
	h.q.limit = limit
	h.updateLevelLocked()
}

// askName is s's ask for stats, nil when it has none.
func (h *streamHub) askName(s *session) *string {
	h.mu.Lock()
	defer h.mu.Unlock()

	return s.quality.name()
}

// viewersChangedLocked follows a change to h.viewers: s started or stopped viewing.
func (h *streamHub) viewersChangedLocked(s *session) {
	if _, viewing := h.viewers[s]; !viewing {
		s.qualitySent = [xinput.EventSize]byte{} // so it hears the level again when it next views
	}
	h.updateLevelLocked()
}

// updateLevelLocked works out the level in effect, sends it to desk-stream on pace, and replies to every session
// viewing whose reply has changed.
func (h *streamHub) updateLevelLocked() {
	if len(h.viewers) > 0 {
		asked := levelNone
		for s := range h.viewers {
			asked = max(asked, s.ask())
		}
		h.q.asked = asked
	}
	l, ceiling := h.q.asked, h.q.ceiling()
	if ceiling != levelNone {
		l = min(l, ceiling)
	}
	if l != h.q.level {
		h.log.Info("stream level", "level", l.String(), "limit", h.q.limit.String(), "profile", profileName(h.q.profile))
		h.q.level = l
	}
	h.paceLevelLocked()
	for s := range h.viewers {
		msg := qualityMessage(h.q.level, ceiling, s.ask())
		// Marked sent only if keys is open. Until it is, the client hasn't asked yet, and its QUALITY gets the reply.
		if msg != s.qualitySent && s.sendKeys(msg[:]) {
			s.qualitySent = msg
		}
	}
}

// qualityMessage is the reply on keys: [0x82, level, stream 0, flags, limit, 0...]. limit is the ceiling in effect:
// deskd's stream.limit or the allowance profile's, whichever is lower.
func qualityMessage(l, limit, ask level) [xinput.EventSize]byte {
	var b [xinput.EventSize]byte
	b[0] = qualityReply
	b[1] = byte(l)
	b[4] = byte(limit)
	switch {
	case l < ask:
		b[3] = flagHeld // only a ceiling can put it below a viewer's ask
	case l > ask:
		b[3] = flagRaised
	}

	return b
}

// paceLevelLocked sends the level in effect to desk-stream if it differs from the last one sent: at once if none went
// within levelPace, else when that's up, as the newest value then.
func (h *streamHub) paceLevelLocked() {
	q := &h.q
	if q.closed || h.conn == nil || q.level == q.sent || q.timer != nil {
		return
	}
	if wait := levelPace - time.Since(q.sentAt); wait > 0 {
		q.timer = time.AfterFunc(wait, h.levelDue)

		return
	}
	h.sendLevelLocked()
}

func (h *streamHub) levelDue() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.q.timer = nil
	h.paceLevelLocked()
}

// sendLevelLocked writes the level in effect to desk-stream, paced or not.
func (h *streamHub) sendLevelLocked() {
	h.q.sent, h.q.sentAt = h.q.level, time.Now()
	h.writeCmdLocked("level " + h.q.level.String() + "\n")
}

// stopLevelLocked is for the hub's close: no paced line goes after it.
func (h *streamHub) stopLevelLocked() {
	h.q.closed = true
	if h.q.timer != nil {
		h.q.timer.Stop()
		h.q.timer = nil
	}
}
