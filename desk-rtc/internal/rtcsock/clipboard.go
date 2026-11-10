package rtcsock

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// The clipboard messages (see internal/xclip). Text travels in parts: data is base64 of at most ClipPartMax
// bytes, which fits one 64 KiB envelope with room for the rest of the JSON. A part can end in the middle of a
// UTF-8 character, so only the joined bytes are text.
const (
	MsgClipSet     = "clipboard.set"
	MsgClipGet     = "clipboard.get"
	MsgClipWatch   = "clipboard.watch"
	MsgClipOK      = "clipboard.ok"
	MsgClipError   = "clipboard.error"
	MsgClipText    = "clipboard.text"
	MsgClipChanged = "clipboard.changed"

	ClipPartMax = 45 * 1024

	ClipNoDisplay = "no_display"
	ClipTimeout   = "timeout"
	ClipTooLarge  = "too_large"
	ClipInternal  = CodeInternal
)

func clipPart(t string, id uint64, part int, last bool, chunk []byte) *Message {
	return &Message{T: t, ID: &id, Part: &part, Last: &last, Data: base64.StdEncoding.EncodeToString(chunk)}
}

// ClipSet is one part of a clipboard.set.
func ClipSet(id uint64, part int, last bool, chunk []byte) *Message {
	return clipPart(MsgClipSet, id, part, last, chunk)
}

// ClipGet asks for the clipboard's text, up to maxBytes.
func ClipGet(id uint64, maxBytes int) *Message {
	return &Message{T: MsgClipGet, ID: &id, MaxBytes: maxBytes}
}

// ClipWatch starts or stops clipboard.changed.
func ClipWatch(on bool) *Message { return &Message{T: MsgClipWatch, On: &on} }

// ClipOK says the X server has confirmed this desk-rtc as CLIPBOARD's owner, holding set id.
func ClipOK(id uint64) *Message { return &Message{T: MsgClipOK, ID: &id} }

// ClipError answers a set or a get.
func ClipError(id uint64, code string) *Message {
	return &Message{T: MsgClipError, ID: &id, Code: code}
}

// ClipText is one part of the answer to a get.
func ClipText(id uint64, part int, last bool, chunk []byte) *Message {
	return clipPart(MsgClipText, id, part, last, chunk)
}

// ClipNone answers a get when the clipboard holds no text.
func ClipNone(id uint64) *Message {
	part, last := 0, true

	return &Message{T: MsgClipText, ID: &id, Part: &part, Last: &last, None: true}
}

// ClipChanged says something on the desk took the clipboard. It carries nothing else, ever.
func ClipChanged() *Message { return &Message{T: MsgClipChanged} }

// ClipEachPart calls f for each part of text, in order, until f returns false. Empty text is one empty last part.
func ClipEachPart(text []byte, f func(part int, last bool, chunk []byte) bool) {
	for part := 0; ; part++ {
		n := min(len(text), ClipPartMax)
		last := n == len(text)
		if !f(part, last, text[:n]) || last {
			return
		}
		text = text[n:]
	}
}

// ClipboardSet sends text as a clipboard.set, in parts, for fake-deskd and tests.
func (c *Client) ClipboardSet(id uint64, text []byte) error {
	var err error
	ClipEachPart(text, func(part int, last bool, chunk []byte) bool {
		err = c.Send(ClipSet(id, part, last, chunk))

		return err == nil
	})

	return err
}

// ClipboardGet sends a clipboard.get.
func (c *Client) ClipboardGet(id uint64, maxBytes int) error { return c.Send(ClipGet(id, maxBytes)) }

// ClipboardWatch sends a clipboard.watch.
func (c *Client) ClipboardWatch(on bool) error { return c.Send(ClipWatch(on)) }

// ClipReply is the whole answer to one clipboard.set or clipboard.get.
type ClipReply struct {
	ID   uint64
	OK   bool   // clipboard.ok
	Code string // clipboard.error
	None bool   // clipboard.text with no text
	Text []byte // clipboard.text, joined
}

// ClipJoiner puts clipboard.text parts back together, for fake-deskd and tests.
type ClipJoiner struct {
	partial map[uint64]*clipPartial
}

type clipPartial struct {
	next int
	text []byte
}

var errClipPart = errors.New("rtcsock: clipboard.text part out of order")

// Add takes any message and returns a reply once one is complete. It returns nil for anything else.
func (j *ClipJoiner) Add(m *Message) (*ClipReply, error) {
	if m.ClipBad && strings.HasPrefix(m.T, "clipboard.") {
		return nil, fmt.Errorf("rtcsock: %s with a field of the wrong type", m.T)
	}
	if m.ID == nil {
		return nil, nil //nolint:nilnil // not a clipboard reply
	}
	id := *m.ID
	switch m.T {
	case MsgClipOK:
		return &ClipReply{ID: id, OK: true}, nil
	case MsgClipError:
		return &ClipReply{ID: id, Code: m.CodeString()}, nil
	case MsgClipText:
	default:
		return nil, nil //nolint:nilnil // not a clipboard reply
	}
	if m.Part == nil || m.Last == nil {
		return nil, fmt.Errorf("rtcsock: clipboard.text without part or last")
	}
	if m.None {
		if *m.Part != 0 || !*m.Last || m.Data != "" {
			return nil, fmt.Errorf("rtcsock: clipboard.text says none and carries more")
		}

		return &ClipReply{ID: id, None: true}, nil
	}
	if j.partial == nil {
		j.partial = map[uint64]*clipPartial{}
	}
	p := j.partial[id]
	if p == nil {
		p = &clipPartial{}
		j.partial[id] = p
	}
	if *m.Part != p.next {
		return nil, errClipPart
	}
	p.next++
	var err error
	if p.text, err = base64.StdEncoding.AppendDecode(p.text, []byte(m.Data)); err != nil {
		return nil, fmt.Errorf("rtcsock: clipboard.text data: %w", err)
	}
	if !*m.Last {
		return nil, nil //nolint:nilnil // more parts to come
	}
	delete(j.partial, id)

	return &ClipReply{ID: id, Text: p.text}, nil
}
