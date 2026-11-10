// Package wire is Commons' framing on the room link: one WebSocket here, a data channel on a desk.
//
// A link message holds one or more records, each [type u8][length u32 LE][payload]. The server packs
// whatever is queued for a member into one message, so a busy room costs one write per member per
// flush instead of one per event. The client's twin is web/src/net/protocol.ts.
package wire

import (
	"encoding/binary"
	"errors"
	"math"
)

// Record types. Keep in step with web/src/net/protocol.ts.
const (
	Ctrl          byte = 1 // JSON, both ways
	BoardUpdate   byte = 2 // c→s [board][ref u32][yjs update]
	BoardEntry    byte = 3 // s→c [board][seq u32][yjs update]
	BoardAck      byte = 4 // s→c [board][seq u32][ref u32]
	BoardSnapshot byte = 5 // c→s [board][upto u32][yjs state]
	Cursor        byte = 6 // c→s [x f32][y f32]; s→c [member u16][x f32][y f32]. NaN hides it
	Live          byte = 7 // c→s [opaque]; s→c [member u16][opaque]: strokes and moves in progress
	Speaking      byte = 8 // s→c [n u16][member u16]×n
	Part          byte = 9 // both ways [last u8][bytes]: a piece of one record too big for a message
)

// MaxMessage caps one link message on a desk: deskd's relay takes at most 4 MiB, and smaller messages keep a big board
// from holding up cursors and voice signalling. A record bigger than this goes as Part records.
const MaxMessage = 1 << 20

// partBody is how much of a big record each Part carries: one Part record fills a message.
const partBody = MaxMessage - header - 1

// MaxRecord caps one record: a board snapshot is the largest thing on the link.
const MaxRecord = 16 << 20

const header = 5

var ErrShort = errors.New("wire: short record")

// Append adds one record made of the parts, in order, to dst.
func Append(dst []byte, typ byte, parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	dst = append(dst, typ, 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(dst[len(dst)-4:], uint32(n))
	for _, p := range parts {
		dst = append(dst, p...)
	}
	return dst
}

// Each calls fn for every record in msg.
func Each(msg []byte, fn func(typ byte, payload []byte) error) error {
	for len(msg) > 0 {
		if len(msg) < header {
			return ErrShort
		}
		n := binary.LittleEndian.Uint32(msg[1:5])
		if n > MaxRecord || int(n) > len(msg)-header {
			return ErrShort
		}
		if err := fn(msg[0], msg[header:header+int(n)]); err != nil {
			return err
		}
		msg = msg[header+int(n):]
	}
	return nil
}

// BoardID reads the [len u8][id] prefix of a board record.
func BoardID(p []byte) (id string, rest []byte, err error) {
	if len(p) < 1 || len(p) < 1+int(p[0]) {
		return "", nil, ErrShort
	}
	return string(p[1 : 1+int(p[0])]), p[1+int(p[0]):], nil
}

// BoardPrefix is the [len u8][id] prefix for id.
func BoardPrefix(id string) []byte {
	return append([]byte{byte(len(id))}, id...)
}

func U32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

func U16(v uint16) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, v)
	return b
}

// ReadU32 reads a little-endian u32 at the start of p.
func ReadU32(p []byte) (uint32, []byte, error) {
	if len(p) < 4 {
		return 0, nil, ErrShort
	}
	return binary.LittleEndian.Uint32(p), p[4:], nil
}

// CursorOut is the server's cursor record body for member idx.
func CursorOut(idx uint16, body []byte) []byte {
	out := make([]byte, 2+len(body))
	binary.LittleEndian.PutUint16(out, idx)
	copy(out[2:], body)
	return out
}

// ValidCursor checks a client cursor body: two finite floats, or NaN for hidden.
func ValidCursor(p []byte) bool {
	if len(p) != 8 {
		return false
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(p))
	y := math.Float32frombits(binary.LittleEndian.Uint32(p[4:]))
	if math.IsNaN(float64(x)) {
		return true
	}
	return !math.IsInf(float64(x), 0) && !math.IsInf(float64(y), 0) && !math.IsNaN(float64(y))
}

// Split cuts buf, a run of whole records, into link messages of at most max bytes, cutting only between records. A
// record bigger than max goes as a run of Part records, each in its own message.
func Split(buf []byte, max int) [][]byte {
	if len(buf) <= max {
		return [][]byte{buf}
	}
	var out [][]byte
	start := 0
	at := 0
	for at < len(buf) {
		if len(buf)-at < header {
			break
		}
		n := header + int(binary.LittleEndian.Uint32(buf[at+1:at+5]))
		if at+n > len(buf) {
			break
		}
		if n > max {
			if at > start {
				out = append(out, buf[start:at])
			}
			out = append(out, Parts(buf[at:at+n], max)...)
			at += n
			start = at
			continue
		}
		if at+n-start > max {
			out = append(out, buf[start:at])
			start = at
		}
		at += n
	}
	if start < len(buf) {
		out = append(out, buf[start:])
	}
	return out
}

// Parts wraps one whole record in Part records, each at most max bytes long.
func Parts(rec []byte, max int) [][]byte {
	body := max - header - 1
	if body < 1 {
		body = partBody
	}
	var out [][]byte
	for len(rec) > 0 {
		n := min(body, len(rec))
		last := byte(0)
		if n == len(rec) {
			last = 1
		}
		out = append(out, Append(nil, Part, []byte{last}, rec[:n]))
		rec = rec[n:]
	}
	return out
}

// Joiner puts Part records back together into the record they carry.
type Joiner struct {
	buf []byte
}

// ErrPart is a Part run that's too big or doesn't hold one whole record.
var ErrPart = errors.New("wire: bad part")

// Add takes one Part body. When it's the last, it returns the whole record (header included).
func (j *Joiner) Add(p []byte) (rec []byte, done bool, err error) {
	if len(p) < 1 {
		return nil, false, ErrPart
	}
	if len(j.buf)+len(p)-1 > MaxRecord+header {
		j.buf = nil
		return nil, false, ErrPart
	}
	j.buf = append(j.buf, p[1:]...)
	if p[0] == 0 {
		return nil, false, nil
	}
	rec, j.buf = j.buf, nil
	if len(rec) < header || int(binary.LittleEndian.Uint32(rec[1:5])) != len(rec)-header || rec[0] == Part {
		return nil, false, ErrPart
	}
	return rec, true, nil
}
