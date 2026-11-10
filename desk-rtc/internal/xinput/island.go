package xinput

// Video islands (ADR 0075, desk-runtime.md section 8.8): while deskd has the stream cropped to one element of the page,
// the client's picture is that rectangle, so its normalized coordinates are mapped into it rather than onto the whole
// screen. Every positional event and key carries the island's epoch in byte 3, and only events for the island in effect
// reach X: input aimed at an island that has since moved on, or at the whole screen while an island streams, is dropped.

// CropMin and CropMax bound an island's sides, in pixels, as desk-stream's CROP_MIN and CROP_MAX do.
const (
	CropMin = 32
	CropMax = 16384
)

// Rect is a rectangle on the X screen, in pixels.
type Rect struct{ X, Y, W, H int }

// Island is the crop in effect: Epoch is 1 to 255 and matches byte 3 of the events meant for it; Rect is what deskd
// asked for, before ClipCrop; Keys lets KEY events through, which deskd allows only while the page's focus is inside
// the island's element.
type Island struct {
	Epoch uint8
	Rect  Rect
	Keys  bool
}

// ClipCrop is the rectangle desk-stream's videocrop gets for r on a screen of sw x sh, so that input lands exactly where
// the picture came from: inside the screen, on even pixels (NV12's chroma is 2x2), and at least CropMin a side, as near
// r as that allows. It is desk-stream's clip_crop(), line for line; both are checked against the same table
// (image/tests/test_desk_stream_islands.py, island_test.go).
func ClipCrop(r Rect, sw, sh int) Rect {
	span := func(start, length, size int) (int, int) {
		size &^= 1
		lo := min(start&^1, size-CropMin)
		hi := min(size, start+length)
		if hi-lo < CropMin {
			hi = lo + CropMin
		}

		return lo, (hi - lo) &^ 1
	}
	x, w := span(r.X, r.W, sw)
	y, h := span(r.Y, r.H, sh)

	return Rect{X: x, Y: y, W: w, H: h}
}

// Crosses is true when r and o share any pixel.
func (r Rect) Crosses(o Rect) bool {
	return r.W > 0 && r.H > 0 && o.W > 0 && o.H > 0 && r.X < o.X+o.W && o.X < r.X+r.W && r.Y < o.Y+o.H && o.Y < r.Y+r.H
}

// Contains is true when r holds all of o.
func (r Rect) Contains(o Rect) bool {
	return r.X <= o.X && r.Y <= o.Y && r.X+r.W >= o.X+o.W && r.Y+r.H >= o.Y+o.H
}
