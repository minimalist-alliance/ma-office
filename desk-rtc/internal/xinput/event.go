// Package xinput decodes the input and keys channels (desk-runtime.md section 8.6) and injects them
// into the desk's X display with XTEST. Pure Go, so desk-rtc stays CGO_ENABLED=0.
package xinput

import "encoding/binary"

// EventSize is the size of every event on channels 6 and 7.
const EventSize = 16

// Kind is an event's type.
type Kind uint8

// The event types of section 8.6.
const (
	Move       Kind = 1
	Button     Kind = 2
	Wheel      Kind = 3
	Key        Kind = 4
	ReleaseAll Kind = 5
	// Hold isn't input: it asks for this session's picture to be shown HoldMs later than it could be, so it matches the
	// sound while nobody uses the mouse or keys (ADR 0037). 0 lets go. desk-rtc handles it; it never reaches X.
	Hold Kind = 6
)

// Event is one decoded input event.
type Event struct {
	Kind   Kind
	Down   bool
	Button uint8
	// Island is byte 3: the epoch of the island the client's picture showed (section 8.8), 0 for the whole screen.
	Island uint8
	Seq    uint32
	X, Y   uint16
	Keysym uint32
	DX, DY int16
	HoldMs uint16
}

// Parse decodes one message. It's false for any other size or type, or a button X doesn't have here.
func Parse(b []byte) (Event, bool) {
	if len(b) != EventSize {
		return Event{}, false
	}
	e := Event{
		Kind:   Kind(b[0]),
		Down:   b[1] == 1,
		Button: b[2],
		Island: b[3],
		Seq:    binary.BigEndian.Uint32(b[4:]),
		X:      binary.BigEndian.Uint16(b[8:]),
		Y:      binary.BigEndian.Uint16(b[10:]),
	}
	switch e.Kind {
	case Move, ReleaseAll:
	case Button:
		switch e.Button {
		case 1, 2, 3, 8, 9:
		default:
			return Event{}, false
		}
	case Wheel:
		e.DX = int16(binary.BigEndian.Uint16(b[12:]))
		e.DY = int16(binary.BigEndian.Uint16(b[14:]))
	case Hold:
		e.HoldMs = binary.BigEndian.Uint16(b[12:])
	case Key:
		e.Keysym = binary.BigEndian.Uint32(b[12:])
		if e.Keysym == 0 {
			return Event{}, false
		}
	default:
		return Event{}, false
	}

	return e, true
}

// newerSeq is a wrapping compare: true when a is after b.
func newerSeq(a, b uint32) bool { return int32(a-b) > 0 }
