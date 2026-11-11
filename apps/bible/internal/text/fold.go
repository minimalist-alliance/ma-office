package text

import (
	"unicode"
	"unicode/utf8"
)

// The one rule that splits verses and queries into words (API.md, "How search matches"): runs of letters and
// digits, lower-cased, with accented Latin letters folded to their base letters and combining marks dropped.
// Everything else breaks words: spaces, punctuation, quotes, apostrophes, hyphens and dashes.

// asciiFold maps an ASCII byte to its folded letter or digit, or 0 for a break.
var asciiFold = func() (t [128]byte) {
	for c := '0'; c <= '9'; c++ {
		t[c] = byte(c)
	}
	for c := 'a'; c <= 'z'; c++ {
		t[c] = byte(c)
		t[c-'a'+'A'] = byte(c)
	}
	return t
}()

// latin1 folds U+00C0 to U+00FF and latinA U+0100 to U+017F. "." marks a break; digits mark the
// two-letter folds in multi.
const (
	latin1 = "aaaaaa0ceeeeiiiidnooooo.ouuuuy1" + "2aaaaaa0ceeeeiiiidnooooo.ouuuuy1y"
	latinA = "aaaaaaccccccccdd" + "ddeeeeeeeeeegggg" + "gggghhhhiiiiiiii" + "ii33jjkkklllllll" +
		"lllnnnnnnnnnoooo" + "oo44rrrrrrssssss" + "ssttttttuuuuuuuu" + "uuuuwwyyyzzzzzzs"
)

var multi = map[byte]string{'0': "ae", '1': "th", '2': "ss", '3': "ij", '4': "oe"}

// foldRune appends r's folded form to dst. word is false for a break; a dropped mark is a word rune that adds nothing.
func foldRune(dst []byte, r rune) (out []byte, word bool) {
	switch {
	case r < 0x80:
		if c := asciiFold[r]; c != 0 {
			return append(dst, c), true
		}
		return dst, false
	case r >= 0xC0 && r <= 0xFF && r != 0xD7 && r != 0xF7:
		return appendFold(dst, latin1[r-0xC0]), true
	case r >= 0x100 && r <= 0x17F:
		return appendFold(dst, latinA[r-0x100]), true
	case r == 0x2BC || r == 0x2BB: // modifier-letter apostrophes: breaks, like ' and ’
		return dst, false
	case r == 0x2BE || r == 0x2BF: // ʾ ʿ, transliteration marks: dropped
		return dst, true
	case unicode.Is(unicode.Mn, r): // combining marks: dropped
		return dst, true
	case unicode.IsLetter(r) || unicode.IsDigit(r):
		return utf8.AppendRune(dst, unicode.ToLower(r)), true
	}
	return dst, false
}

func appendFold(dst []byte, c byte) []byte {
	if s, ok := multi[c]; ok {
		return append(dst, s...)
	}
	return append(dst, c)
}

// word is one word of a text: its folded form in a shared buffer, and where it is in the source, in bytes.
type word struct {
	fs, fe int // folded bytes, in the buffer
	s, e   int // source bytes
}

// splitWords appends s's words to words and their folded bytes to buf. A word made only of dropped marks is no word.
func splitWords(s []byte, words []word, buf []byte) ([]word, []byte) {
	in := false
	var cur word
	for i := 0; i < len(s); {
		before := len(buf)
		c := s[i]
		size := 1
		var ok bool
		if c < 0x80 {
			if f := asciiFold[c]; f != 0 {
				buf, ok = append(buf, f), true
			}
		} else {
			var r rune
			r, size = utf8.DecodeRune(s[i:])
			buf, ok = foldRune(buf, r)
		}
		if ok {
			if !in {
				in, cur = true, word{fs: before, s: i}
			}
			cur.e = i + size
		} else if in {
			in = false
			if cur.fe = len(buf); cur.fe > cur.fs {
				words = append(words, cur)
			}
		}
		i += size
	}
	if in {
		if cur.fe = len(buf); cur.fe > cur.fs {
			words = append(words, cur)
		}
	}
	return words, buf
}

// Fold returns s's words, folded, for tests and the query parser.
func Fold(s string) []string {
	ws, buf := splitWords([]byte(s), nil, nil)
	out := make([]string, len(ws))
	for i, w := range ws {
		out[i] = string(buf[w.fs:w.fe])
	}
	return out
}
