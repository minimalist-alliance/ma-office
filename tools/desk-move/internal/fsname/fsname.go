// Package fsname carries file names through JSON without losing a byte, the way desk-data and deskd do.
//
// A Linux file name is bytes, and needn't be UTF-8. desk-data lists each byte that isn't UTF-8 as Python's
// surrogateescape does, as the lone surrogate U+DC80 to U+DCFF, which JSON writes as \udc80 to \udcff, and it reads
// a name back the same way. deskd passes those escapes through as they are (Jackson writes them \uDC80 to \uDCFF).
// encoding/json turns each into U+FFFD, which names another file: a data.read of it is not_found, and before this
// the move counted that file as gone. Name decodes the escapes to the bytes they stand for and encodes those bytes
// back as the same escapes, so a name goes round unchanged. Valid UTF-8 is untouched either way.
package fsname

import (
	"fmt"
	"strconv"
	"unicode/utf8"
)

// Name is a file name or a path as bytes, which JSON carries as desk-data does.
type Name string

// Error is a JSON string that isn't a name desk-data could have sent: a lone surrogate outside U+DC80 to U+DCFF,
// bytes that aren't UTF-8, or JSON that isn't a string. It's never a name to skip: whatever holds it can't be carried.
type Error struct{ Why string }

func (e *Error) Error() string { return "a file name that can't be carried here: " + e.Why }

// MarshalJSON writes the name as a JSON string, each byte that isn't UTF-8 as \udcXX.
func (n Name) MarshalJSON() ([]byte, error) { return Encode(string(n)), nil }

// UnmarshalJSON reads a JSON string, each \udc80 to \udcff as the byte it stands for. null leaves the name as it was.
func (n *Name) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	s, err := Decode(b)
	if err != nil {
		return err
	}
	*n = Name(s)

	return nil
}

const hexdigits = "0123456789abcdef"

// Encode is s as a JSON string literal, each byte that isn't part of valid UTF-8 as \udcXX.
func Encode(s string) []byte {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			b := s[i]
			out = append(out, '\\', 'u', 'd', 'c', hexdigits[b>>4], hexdigits[b&0xf])
		case r == '"' || r == '\\':
			out = append(out, '\\', byte(r))
		case r == '\n':
			out = append(out, '\\', 'n')
		case r == '\r':
			out = append(out, '\\', 'r')
		case r == '\t':
			out = append(out, '\\', 't')
		case r < 0x20, r == 0x7f, r == 0x2028, r == 0x2029:
			out = append(out, '\\', 'u', hexdigits[r>>12&0xf], hexdigits[r>>8&0xf], hexdigits[r>>4&0xf], hexdigits[r&0xf])
		default:
			out = append(out, s[i:i+size]...)
		}
		i += size
	}

	return append(out, '"')
}

// Decode reads a JSON string literal, each \udc80 to \udcff as the byte it stands for and a surrogate pair as the
// character it makes. Anything else that isn't a name desk-data sends is an *Error.
func Decode(b []byte) (string, error) {
	if len(b) < 2 || b[0] != '"' || b[len(b)-1] != '"' {
		return "", &Error{Why: "not a JSON string"}
	}
	b = b[1 : len(b)-1]
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c == '"' || c < 0x20:
			return "", &Error{Why: "not a JSON string"}
		case c != '\\':
			r, size := utf8.DecodeRune(b[i:])
			if r == utf8.RuneError && size == 1 {
				return "", &Error{Why: "bytes that aren't UTF-8 in the JSON itself"}
			}
			out = append(out, b[i:i+size]...)
			i += size

			continue
		}
		if i+1 >= len(b) {
			return "", &Error{Why: "not a JSON string"}
		}
		switch e := b[i+1]; e {
		case '"', '\\', '/':
			out = append(out, e)
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			u, ok := unit(b, i)
			if !ok {
				return "", &Error{Why: "a bad \\u escape"}
			}
			i += 6
			switch {
			case u >= 0xd800 && u <= 0xdbff:
				lo, ok := unit(b, i)
				if !ok || lo < 0xdc00 || lo > 0xdfff {
					return "", &Error{Why: "half a surrogate pair"}
				}
				i += 6
				out = utf8.AppendRune(out, 0x10000+(rune(u)-0xd800)<<10+(rune(lo)-0xdc00))
			case u >= 0xdc80 && u <= 0xdcff:
				out = append(out, byte(u)) // surrogateescape: a byte that wasn't UTF-8
			case u >= 0xdc00 && u <= 0xdfff:
				return "", &Error{Why: fmt.Sprintf("a lone surrogate, U+%04X", u)}
			default:
				out = utf8.AppendRune(out, rune(u))
			}

			continue
		default:
			return "", &Error{Why: "a bad escape"}
		}
		i += 2
	}

	return string(out), nil
}

// unit is the code unit of the \uXXXX at b[i:].
func unit(b []byte, i int) (uint16, bool) {
	if i+6 > len(b) || b[i] != '\\' || b[i+1] != 'u' {
		return 0, false
	}
	v, err := strconv.ParseUint(string(b[i+2:i+6]), 16, 16)
	if err != nil {
		return 0, false
	}

	return uint16(v), true
}
