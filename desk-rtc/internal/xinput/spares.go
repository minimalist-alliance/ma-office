package xinput

import "time"

// chromiumFreeCodes are the only X keycodes a spare keysym may go on. Chromium decides what a key does
// from its keycode as well as its keysym, and it reads keycodes as evdev+8 whatever the keymap says: a
// keysym put on 181 reloads the page (BrowserRefresh), on 166 goes back, on 114 is an arrow key. On these
// codes the page sees e.code "" and keyCode 0, and nothing happens but the text.
//
// Measured with test/keyproof on Chromium 156, keycode by keycode, against the image's keymap. Left out
// on purpose, though e.code is "" there too: 103, 109, 212, 237 and 238, whose keyCode isn't 0 (109 is
// 229, "Process", which a page reads as an IME). image/verify.sh checks this list on every new image.
var chromiumFreeCodes = []byte{
	120, 126, 138, 147, 149, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 165, 168, 170, 177, 178,
	182, 183, 184, 185, 186, 189, 190, 208, 210, 211, 213, 214, 217, 218, 219, 220, 221, 222, 223, 224,
	226, 227, 228, 229, 230, 231, 234, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
}

const (
	// mapSettle is how long a key waits after its keysym goes on a code. The text Chromium inserts comes
	// from a copy of the keymap that follows X on its own time, not in order with key events, so a press
	// right after the remap types what was on the code before, or nothing. Measured with keyproof race,
	// 100 presses each on 2 cores with 8 busy loops: 5 wrong at 10 ms, 1 at 20 ms, none at 30, 50 or 75 ms.
	// Idle, 8 of 100 at 0 ms and none at 5 ms. It's paid once per character, the first time it's typed.
	mapSettle = 60 * time.Millisecond

	// reuseAfter is how long a keycode rests after its last key event before it can carry another keysym,
	// so no earlier press of that code can still be waiting in Chromium's queue when the code changes.
	// Going through the whole pool in half a second is far beyond typing, and costs only this wait.
	reuseAfter = 500 * time.Millisecond
)

// sparePool hands out keycodes for keysyms missing from the keymap. A keysym stays on its code until the
// code is needed for another, and the code reused is the one idle longest, so with more distinct
// characters than codes the ones in use keep theirs. Only the injector's goroutine touches it.
type sparePool struct {
	codes []byte
	last  map[byte]time.Time // the code's last use; the zero time means never
}

// newSparePool keeps the codes of chromiumFreeCodes that usable says it may take.
func newSparePool(usable func(code byte) bool) *sparePool {
	p := &sparePool{last: map[byte]time.Time{}}
	for _, c := range chromiumFreeCodes {
		if usable(c) {
			p.codes = append(p.codes, c)
			p.last[c] = time.Time{}
		}
	}

	return p
}

// pick chooses the code for a new keysym: never one in avoid, the one idle longest. wait is how long
// reuseAfter says to hold off first. ok is false when every code is in avoid.
func (p *sparePool) pick(avoid map[byte]bool, now time.Time) (code byte, wait time.Duration, ok bool) {
	var oldest time.Time
	for _, c := range p.codes {
		if avoid[c] {
			continue
		}
		t := p.last[c]
		if !ok || t.Before(oldest) {
			code, oldest, ok = c, t, true
		}
	}
	if ok && !oldest.IsZero() {
		if idle := now.Sub(oldest); idle < reuseAfter {
			wait = reuseAfter - idle
		}
	}

	return code, wait, ok
}

// touch records a use of a code. Codes outside the pool are ignored.
func (p *sparePool) touch(code byte, now time.Time) {
	if _, in := p.last[code]; in {
		p.last[code] = now
	}
}
