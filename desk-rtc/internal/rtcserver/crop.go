package rtcserver

import (
	"errors"
	"fmt"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xinput"
)

// Video islands (ADR 0075, desk-runtime.md section 8.8). deskd's stream.crop names a rectangle of the screen and the
// largest picture to send it at; desk-stream crops to it in its running pipeline ("crop X Y W H OUTW OUTH", or "crop
// none"), and the injector maps every input event carrying the island's epoch into it. The crop is the desk's, not a
// session's: there's one encoder, so every session viewing gets the island.

// blockedEvery is the least time between two island.blocked messages to deskd.
const blockedEvery = time.Second

func checkCrop(c *rtcsock.Crop) error {
	switch {
	case c.Epoch < 1 || c.Epoch > 255:
		return fmt.Errorf("epoch %d isn't 1 to 255", c.Epoch)
	case c.X < 0 || c.Y < 0 || c.X >= xinput.CropMax || c.Y >= xinput.CropMax:
		return errors.New("x and y must be 0 to 16383")
	}
	for _, v := range []int{c.W, c.H, c.OutW, c.OutH} {
		if v < xinput.CropMin || v > xinput.CropMax {
			return errors.New("w, h, outW and outH must be 32 to 16384")
		}
	}

	return nil
}

// cropLine is the command desk-stream takes for c.
func cropLine(c *rtcsock.Crop) string {
	if c == nil {
		return "crop none\n"
	}

	return fmt.Sprintf("crop %d %d %d %d %d %d\n", c.X, c.Y, c.W, c.H, c.OutW, c.OutH)
}

// sameCrop is true when desk-stream would send the same picture for both: the epoch and keys don't reach it.
func sameCrop(a, b *rtcsock.Crop) bool {
	if a == nil || b == nil {
		return a == b
	}

	return a.X == b.X && a.Y == b.Y && a.W == b.W && a.H == b.H && a.OutW == b.OutW && a.OutH == b.OutH
}

// setCrop is stream.crop. A bad crop is logged and changes nothing. The injector hears it first, so input meant for the
// old picture is dropped from now on, even what's already queued.
func (h *streamHub) setCrop(c *rtcsock.Crop) {
	if c != nil {
		if err := checkCrop(c); err != nil {
			h.log.Warn("ignoring a bad stream.crop", "err", err)

			return
		}
		cc := *c
		c = &cc
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	old := h.crop
	h.crop = c
	if in := h.srv.input; in != nil {
		var isl *xinput.Island
		if c != nil {
			isl = &xinput.Island{Epoch: uint8(c.Epoch), Rect: xinput.Rect{X: c.X, Y: c.Y, W: c.W, H: c.H}, Keys: c.Keys}
		}
		in.SetIsland(isl)
	}
	// A moving island sends a crop each frame it moves: only its start, its end and a new epoch are logged.
	switch {
	case c == nil && old != nil:
		h.log.Info("island ended: the whole screen")
	case c != nil && (old == nil || old.Epoch != c.Epoch):
		h.log.Info("island", "epoch", c.Epoch, "w", c.W, "h", c.H, "outW", c.OutW, "outH", c.OutH)
	}
	if !sameCrop(old, c) {
		h.writeCmdLocked(cropLine(c))
	}
}

// cropStats is the crop and the island counters, for stats.
func (h *streamHub) cropStats(st *rtcsock.StreamStats) {
	h.mu.Lock()
	if h.crop != nil {
		c := *h.crop
		st.Crop = &c
	}
	h.mu.Unlock()
	if in := h.srv.input; in != nil {
		st.InputStale, st.IslandBlocked = in.IslandDrops()
	}
}

// onIslandBlocked tells deskd a press was dropped because something else was over the island, at most once a second:
// deskd then shows the element's last frame and offers the full stream (design section 7.4, T47-4).
func (s *Server) onIslandBlocked(epoch uint8) {
	now := time.Now().UnixNano()
	last := s.lastBlocked.Load()
	if now-last < int64(blockedEvery) || !s.lastBlocked.CompareAndSwap(last, now) {
		return
	}
	s.toDeskd(&rtcsock.Message{T: "island.blocked", Epoch: int(epoch)})
}
