package rtcserver

import "github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"

// clipBacklogLimit stops the clipboard adding text to a socket deskd has stopped reading. clipSend never blocks,
// so the clipboard's goroutine can't be held up by it, but its queue has no limit of its own. The socket's write
// deadline closes a stuck link in the end; until then this is the most text that can pile up. It holds a whole
// 2 MiB answer as base64, with room for what's already waiting.
const clipBacklogLimit = 4 << 20

// handleClipboard runs on the socket's reader, so it only hands over. See internal/xclip.
func (l *link) handleClipboard(m *rtcsock.Message) {
	if c := l.srv.clip; c != nil {
		c.Submit(m)

		return
	}
	// desk-rtc was started with no display. A set is answered on its last part, as ever, and a field of the wrong
	// type gets internal.
	switch {
	case m.ID == nil, m.T == rtcsock.MsgClipWatch:
	case m.ClipBad:
		l.sendJSON(rtcsock.ClipError(*m.ID, rtcsock.ClipInternal))
	case m.T == rtcsock.MsgClipGet, m.T == rtcsock.MsgClipSet && m.Last != nil && *m.Last:
		l.sendJSON(rtcsock.ClipError(*m.ID, rtcsock.ClipNoDisplay))
	}
}

// clipSend gives the clipboard's replies to deskd, if it's still the connection named by clipLink. False means
// it isn't, or it's too far behind to take more text. Replies with no text always go: they're small, and they're
// how it hears about that. They all queue below session data, in the order they came.
func (s *Server) clipSend(clipLink uint64, m *rtcsock.Message) bool {
	s.mu.Lock()
	l := s.cur
	s.mu.Unlock()
	if l == nil || l.clipLink != clipLink {
		return false
	}
	if m.Data != "" && l.out.clipBacklog() > clipBacklogLimit {
		return false
	}
	b, err := rtcsock.EncodeJSON(m)
	if err != nil {
		s.log.Error("rtc.sock encode failed", "t", m.T, "err", err)

		return false
	}
	l.out.pushClip(b)

	return true
}
