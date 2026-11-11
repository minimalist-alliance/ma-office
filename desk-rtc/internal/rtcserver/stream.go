package rtcserver

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// desk-stream to desk-rtc (desk-runtime.md section 8.2): RFC 4571 RTP one way, ASCII commands the other.
// Encoded once here, then copied to every session viewing.

const (
	ptH264 = 96
	ptOpus = 111

	maxStreamRTP = 8 * 1024

	streamDown = "down"
	streamWarm = "warm"
	streamLive = "live"

	streamReadBuffer = 256 * 1024
	cmdWriteTimeout  = 250 * time.Millisecond

	// How often a keyframe may be asked for. A joining viewer waits on one directly, and B13 is 300 ms.
	// PLIs come from loss, where a keyframe (5-10x the normal rate) may make things worse.
	keyframeGapJoin = 100 * time.Millisecond
	keyframeGapPLI  = 500 * time.Millisecond
	// A joining viewer asks again this often until a keyframe arrives.
	keyframeRetry = 150 * time.Millisecond
)

type streamHub struct {
	srv  *Server
	log  *slog.Logger
	path string
	uid  int
	ln   *net.UnixListener
	// profileFile is where desk-egress names the allowance profile (quality.go), read at start and on each desk-stream
	// connection. Empty means none: every level as asked, as before.
	profileFile string

	mu      sync.Mutex
	conn    *net.UnixConn
	viewers map[*session]*viewer
	state   string
	lastKey time.Time
	q       qualityState  // quality.go
	crop    *rtcsock.Crop // crop.go: the island in effect, nil for the whole screen

	current atomic.Pointer[[]*viewer] // what the read loop forwards to

	videoPackets atomic.Uint64
	videoBytes   atomic.Uint64
	audioPackets atomic.Uint64
	keyRequests  atomic.Uint64
}

func newStreamHub(s *Server) *streamHub {
	h := &streamHub{
		srv:     s,
		log:     s.log.With("part", "stream"),
		path:    s.cfg.StreamSocket,
		uid:     s.cfg.StreamUID,
		viewers: map[*session]*viewer{},
		state:   streamDown,
		q:       newQualityState(),

		profileFile: s.cfg.ProfileFile,
	}
	empty := []*viewer{}
	h.current.Store(&empty)
	h.mu.Lock()
	h.readProfileLocked() // no viewers and no desk-stream yet: this only sets the level a first connection hears
	h.mu.Unlock()
	if h.path != "" {
		if err := h.listen(); err != nil {
			// A desk on an older image has no /run/desk-media. Sessions and data channels still work.
			h.log.Warn("no stream socket: this desk can't stream video", "path", h.path, "err", err)
		}
	}

	return h
}

func (h *streamHub) listen() error {
	if err := os.Remove(h.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: h.path, Net: "unix"})
	if err != nil {
		return err
	}
	// The directory is the gate (0750 rtc:stream), and serve checks the peer's uid.
	if err := os.Chmod(h.path, 0o666); err != nil {
		_ = ln.Close()

		return err
	}
	h.ln = ln

	return nil
}

func (h *streamHub) close() {
	if h.ln != nil {
		_ = h.ln.Close()
	}
	h.mu.Lock()
	if h.conn != nil {
		_ = h.conn.Close()
	}
	h.stopLevelLocked()
	h.mu.Unlock()
}

func peerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var opErr error
	err = raw.Control(func(fd uintptr) {
		u, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if e != nil {
			opErr = e

			return
		}
		uid = int(u.Uid)
	})
	if err != nil {
		return -1, err
	}

	return uid, opErr
}

func (h *streamHub) serve() {
	if h.ln == nil {
		return
	}
	for {
		c, err := h.ln.AcceptUnix()
		if err != nil {
			return
		}
		uid, err := peerUID(c)
		if err != nil || uid != h.uid {
			h.log.Warn("refused a stream connection", "uid", uid, "want", h.uid, "err", err)
			_ = c.Close()

			continue
		}
		h.attach(c)
		go h.readLoop(c)
	}
}

// attach makes c the one desk-stream. A new process has a new timeline, so everyone restarts on its
// first keyframe. It starts paused, so anyone already viewing needs resume.
func (h *streamHub) attach(c *net.UnixConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conn != nil {
		h.log.Info("replacing the desk-stream connection")
		_ = h.conn.Close()
	}
	// A profile change restarts desk-stream after desk-egress has named the new one, so this connection runs that
	// profile's conf. Read it with no connection set: viewers hear the new level and ceiling, and the line below is the
	// only one desk-stream gets.
	h.conn = nil
	h.readProfileLocked()
	h.conn = c
	// Always first, before resume, with or without viewers, asks or a limit: a new process starts at the level in
	// effect. An older desk-stream logs "unknown command: level ..." and carries on as High.
	h.sendLevelLocked()
	if h.crop != nil {
		h.writeCmdLocked(cropLine(h.crop)) // a new process starts on the whole screen
	}
	for _, v := range h.viewers {
		v.restartTimeline()
	}
	if len(h.viewers) > 0 {
		h.writeCmdLocked("resume\n")
		h.forceKeyLocked()
	}
	h.log.Info("desk-stream connected")
	h.updateStateLocked()
}

func (h *streamHub) detach(c *net.UnixConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = c.Close()
	if h.conn == c {
		h.conn = nil
		h.log.Info("desk-stream disconnected")
		h.updateStateLocked()
	}
}

func (h *streamHub) updateStateLocked() {
	state := streamWarm
	switch {
	case h.conn == nil:
		state = streamDown
	case len(h.viewers) > 0:
		state = streamLive
	}
	if state == h.state {
		return
	}
	h.state = state
	h.srv.toDeskd(&rtcsock.Message{T: "stream.state", State: state})
}

// stateMessage is what a deskd that just connected needs to hear.
func (h *streamHub) stateMessage() *rtcsock.Message {
	h.mu.Lock()
	defer h.mu.Unlock()

	return &rtcsock.Message{T: "stream.state", State: h.state}
}

func (h *streamHub) writeCmdLocked(cmd string) {
	if h.conn == nil {
		return
	}
	_ = h.conn.SetWriteDeadline(time.Now().Add(cmdWriteTimeout))
	if _, err := h.conn.Write([]byte(cmd)); err != nil {
		// desk-stream isn't reading, so it's stuck. systemd restarts it when it exits; force that.
		h.log.Warn("desk-stream isn't taking commands", "err", err)
		_ = h.conn.Close()
	}
}

func (h *streamHub) forceKeyLocked() {
	h.lastKey = time.Now()
	h.keyRequests.Add(1)
	h.writeCmdLocked("keyframe\n")
}

// requestKeyframe asks desk-stream for a keyframe unless one was asked for within minGap.
func (h *streamHub) requestKeyframe(minGap time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conn == nil || time.Since(h.lastKey) < minGap {
		return
	}
	h.forceKeyLocked()
}

// setViewer starts or stops forwarding to a session. Idempotent.
func (h *streamHub) setViewer(s *session, want bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, has := h.viewers[s]
	switch {
	case want && !has:
		v = newViewer(h, s, s.lastViewerDone)
		s.lastViewerDone = v.done
		h.viewers[s] = v
		h.viewersChangedLocked(s) // before resume, so a first viewer's level needs no keyframe of its own
		go v.run()
		h.publishLocked()
		if len(h.viewers) == 1 {
			h.writeCmdLocked("resume\n")
		}
		if h.conn != nil {
			h.forceKeyLocked()
		}
	case !want && has:
		delete(h.viewers, s)
		h.viewersChangedLocked(s)
		close(v.stop)
		h.publishLocked()
		if len(h.viewers) == 0 {
			h.writeCmdLocked("pause\n")
		}
	default:
		return
	}
	h.updateStateLocked()
}

func (h *streamHub) publishLocked() {
	cur := make([]*viewer, 0, len(h.viewers))
	for _, v := range h.viewers {
		cur = append(cur, v)
	}
	h.current.Store(&cur)
}

func (h *streamHub) readLoop(c *net.UnixConn) {
	defer h.detach(c)
	r := bufio.NewReaderSize(c, streamReadBuffer)
	var hdr [2]byte
	prevMarker := true
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[:]))
		if n < 12 || n > maxStreamRTP {
			h.log.Warn("closing desk-stream: bad RTP length", "bytes", n)

			return
		}
		raw := make([]byte, n)
		if _, err := io.ReadFull(r, raw); err != nil {
			return
		}
		if raw[0]>>6 != 2 {
			h.log.Warn("closing desk-stream: not RTP")

			return
		}
		pt := raw[1] & 0x7f
		marker := raw[1]&0x80 != 0
		it := rtpItem{raw: raw}
		switch pt {
		case ptH264:
			it.video = true
			it.key = startsKeyframe(rtpPayload(raw), prevMarker)
			prevMarker = marker
			h.videoPackets.Add(1)
			h.videoBytes.Add(uint64(n))
		case ptOpus:
			h.audioPackets.Add(1)
		default:
			h.log.Warn("closing desk-stream: unknown payload type", "pt", pt)

			return
		}
		for _, v := range *h.current.Load() {
			v.push(it)
		}
	}
}

// rtpPayload skips the fixed header, CSRCs and any extension. Nil when the packet is malformed.
func rtpPayload(raw []byte) []byte {
	off := 12 + 4*int(raw[0]&0x0f)
	if len(raw) < off {
		return nil
	}
	if raw[0]&0x10 != 0 {
		if len(raw) < off+4 {
			return nil
		}
		off += 4 + 4*int(binary.BigEndian.Uint16(raw[off+2:]))
		if len(raw) < off {
			return nil
		}
	}

	return raw[off:]
}

// startsKeyframe is true when an H.264 RTP payload begins a keyframe a decoder can start from: SPS
// (x264's headers precede an IDR here, config-interval=-1), or an IDR slice at an access unit boundary.
func startsKeyframe(p []byte, atBoundary bool) bool {
	if len(p) < 2 {
		return false
	}
	switch p[0] & 0x1f {
	case 7:
		return true
	case 5:
		return atBoundary
	case 24: // STAP-A: the NAL units inside it
		for i := 1; i+2 < len(p); {
			size := int(binary.BigEndian.Uint16(p[i:]))
			t := p[i+2] & 0x1f
			if t == 7 || (t == 5 && atBoundary) {
				return true
			}
			i += 2 + size
		}
	case 28: // FU-A: the start of a fragmented IDR slice
		return p[1]&0x80 != 0 && p[1]&0x1f == 5 && atBoundary
	}

	return false
}

func (h *streamHub) stats() *rtcsock.StreamStats {
	h.mu.Lock()
	state, viewers := h.state, len(h.viewers)
	lvl, limit := h.q.level.String(), h.q.limit.name()
	var profile *string
	if h.q.profile != "" {
		p := h.q.profile
		profile = &p
	}
	h.mu.Unlock()

	st := &rtcsock.StreamStats{
		State:            state,
		Viewers:          viewers,
		VideoPackets:     h.videoPackets.Load(),
		VideoBytes:       h.videoBytes.Load(),
		AudioPackets:     h.audioPackets.Load(),
		KeyframeRequests: h.keyRequests.Load(),
		Level:            lvl,
		Limit:            limit,
		Profile:          profile,
	}
	h.cropStats(st)

	return st
}

// LookupStreamUID resolves --stream-user. It's separate so main can run with video off when the image
// has no such user.
func LookupStreamUID(name string) (int, error) {
	u, err := lookupUID(name)
	if err != nil {
		return -1, fmt.Errorf("stream user %q: %w", name, err)
	}

	return u, nil
}
