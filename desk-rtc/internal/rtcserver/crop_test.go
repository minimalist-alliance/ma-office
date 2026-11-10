package rtcserver

import (
	"os"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// next is the next command line desk-rtc sends, whatever it is.
func (s *fakeStream) next() string {
	s.t.Helper()
	select {
	case got, ok := <-s.cmds:
		if !ok {
			s.t.Fatal("connection closed")
		}

		return got
	case <-time.After(3 * time.Second):
		s.t.Fatal("no command from desk-rtc")
	}

	return ""
}

func crop(epoch, x, y, w, h, ow, oh int) *rtcsock.Crop {
	return &rtcsock.Crop{Epoch: epoch, X: x, Y: y, W: w, H: h, OutW: ow, OutH: oh}
}

// stream.crop from deskd to desk-stream: the line, only when the picture changes, kept across a desk-stream restart,
// ended by a new deskd connection, and in stats.
func TestStreamCropReachesDeskStream(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	if got := s.next(); got != "level high" {
		t.Fatalf("first line %q", got)
	}

	d.send(&rtcsock.Message{T: "stream.crop", Crop: crop(5, 320, 180, 1280, 720, 640, 360)})
	if got := s.next(); got != "crop 320 180 1280 720 640 360" {
		t.Fatalf("got %q", got)
	}
	// The same picture with keys allowed, or a bad crop: nothing for desk-stream. A move: its line.
	keys := crop(5, 320, 180, 1280, 720, 640, 360)
	keys.Keys = true
	d.send(&rtcsock.Message{T: "stream.crop", Crop: keys})
	for _, bad := range []*rtcsock.Crop{crop(0, 0, 0, 64, 64, 64, 64), crop(256, 0, 0, 64, 64, 64, 64), crop(1, -2, 0, 64, 64, 64, 64),
		crop(1, 0, 0, 31, 64, 64, 64), crop(1, 0, 0, 64, 64, 64, 16385), crop(1, 16384, 0, 64, 64, 64, 64)} {
		d.send(&rtcsock.Message{T: "stream.crop", Crop: bad})
	}
	d.send(&rtcsock.Message{T: "stream.crop", Crop: crop(5, 320, 100, 1280, 720, 640, 360)})
	if got := s.next(); got != "crop 320 100 1280 720 640 360" {
		t.Fatalf("after the same picture and bad crops, got %q", got)
	}

	d.send(&rtcsock.Message{T: "stats.get"})
	st := d.expect("stats", "", 3*time.Second).Stream
	if st == nil || st.Crop == nil || *st.Crop != *crop(5, 320, 100, 1280, 720, 640, 360) {
		t.Fatalf("stats crop %+v", st)
	}

	// A new desk-stream starts on the whole screen: it hears the level, then the island.
	s2 := f.dialStream()
	if got := s2.next(); got != "level high" {
		t.Fatalf("restart: first line %q", got)
	}
	if got := s2.next(); got != "crop 320 100 1280 720 640 360" {
		t.Fatalf("restart: got %q", got)
	}

	// null is the whole screen.
	d.send(&rtcsock.Message{T: "stream.crop"})
	if got := s2.next(); got != "crop none" {
		t.Fatalf("null: got %q", got)
	}
	d.send(&rtcsock.Message{T: "stream.crop", Crop: crop(6, 0, 0, 640, 360, 640, 360)})
	if got := s2.next(); got != "crop 0 0 640 360 640 360" {
		t.Fatalf("got %q", got)
	}

	// An island lasts as long as the deskd connection that set it.
	d2 := f.deskd()
	d2.configure("127.0.0.1", 4)
	if got := s2.next(); got != "crop none" {
		t.Fatalf("new deskd: got %q", got)
	}
	d2.send(&rtcsock.Message{T: "stats.get"})
	if st := d2.expect("stats", "", 3*time.Second).Stream; st == nil || st.Crop != nil {
		t.Fatalf("stats after a new deskd %+v", st)
	}
}

func TestCropLine(t *testing.T) {
	if got := cropLine(nil); got != "crop none\n" {
		t.Fatal(got)
	}
	if got := cropLine(crop(1, 2, 4, 640, 360, 320, 180)); got != "crop 2 4 640 360 320 180\n" {
		t.Fatal(got)
	}
	if !sameCrop(nil, nil) || sameCrop(nil, crop(1, 0, 0, 64, 64, 64, 64)) || !sameCrop(crop(1, 0, 0, 64, 64, 64, 64), crop(2, 0, 0, 64, 64, 64, 64)) {
		t.Fatal("sameCrop")
	}
}
