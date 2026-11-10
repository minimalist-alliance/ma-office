package voice

import "time"

// Police is how strictly the SFU holds each talker to what Opus voice needs (Security's NET031-2). A talker's packets
// are charged to every listener's weekly allowance, so the SFU must not forward more than a microphone can honestly
// send. Zero fields take the defaults; a negative Kbps turns policing off (tests and comparison only).
//
// What a browser sends: 20 ms Opus frames, 50 packets a second, about 32 to 64 kbit/s with the RTP header, less with
// DTX in silence. The defaults leave about 2x headroom on both counts.
type Police struct {
	// Kbps is the most RTP bytes per second a talker may send, in kbit/s, headers and extension included. Default 128.
	Kbps int
	// PPS is the most packets a second. Default 100.
	PPS int
	// MaxBytes is the biggest RTP packet forwarded, header included. Default 400.
	MaxBytes int
	// AbuseSecs is how many seconds in a row a talker may be over the limits before its voice connection is closed.
	// Default 5. A second counts as over when it dropped DropsPerSec or more packets.
	AbuseSecs int
	// DropsPerSec is how many drops make a second "over". Default 5, so a stray late burst or one big packet never
	// counts.
	DropsPerSec int
}

// Defaults for Police, and the burst a bucket holds (a stalled network delivering its backlog at once).
const (
	DefaultPoliceKbps     = 128
	DefaultPolicePPS      = 100
	DefaultPoliceMaxBytes = 400
	DefaultPoliceAbuse    = 5
	DefaultPoliceDrops    = 5
	policeBurst           = 500 * time.Millisecond
)

func (p Police) withDefaults() Police {
	if p.Kbps == 0 {
		p.Kbps = DefaultPoliceKbps
	}
	if p.PPS <= 0 {
		p.PPS = DefaultPolicePPS
	}
	if p.MaxBytes <= 0 {
		p.MaxBytes = DefaultPoliceMaxBytes
	}
	if p.AbuseSecs <= 0 {
		p.AbuseSecs = DefaultPoliceAbuse
	}
	if p.DropsPerSec <= 0 {
		p.DropsPerSec = DefaultPoliceDrops
	}
	return p
}

// policer is one talker's token buckets. Only that talker's read goroutine uses it.
type policer struct {
	off       bool
	maxBytes  int
	byteRate  float64 // bytes a second
	byteCap   float64
	pktRate   float64
	pktCap    float64
	bytes     float64
	pkts      float64
	last      int64
	winStart  int64
	winDrops  int
	overRun   int // seconds in a row over
	needDrops int
	needRun   int
}

func newPolicer(c Police, now int64) *policer {
	br := float64(c.Kbps) * 1000 / 8
	pr := float64(c.PPS)
	b := policeBurst.Seconds()
	return &policer{
		off: c.Kbps < 0, maxBytes: c.MaxBytes,
		byteRate: br, byteCap: br * b, pktRate: pr, pktCap: max(pr*b, 1),
		bytes: br * b, pkts: max(pr*b, 1), last: now, winStart: now,
		needDrops: c.DropsPerSec, needRun: c.AbuseSecs,
	}
}

// allow decides one packet of n bytes arriving at mono time now. ok is false to drop it; abusive is true once the
// talker has been over the limits for the abuse time, and its connection should close.
func (p *policer) allow(n int, now int64) (ok, abusive bool) {
	if p.off {
		return true, false
	}
	if dt := float64(now-p.last) / 1e9; dt > 0 {
		p.bytes = min(p.byteCap, p.bytes+dt*p.byteRate)
		p.pkts = min(p.pktCap, p.pkts+dt*p.pktRate)
		p.last = now
	}
	// Seconds are counted on arrival. A talker silent for a whole second or more starts over.
	if now-p.winStart >= int64(time.Second) {
		if (now-p.winStart)/int64(time.Second) > 1 || p.winDrops < p.needDrops {
			p.overRun = 0
		} else {
			p.overRun++
		}
		p.winStart, p.winDrops = now, 0
	}
	ok = n <= p.maxBytes && p.bytes >= float64(n) && p.pkts >= 1
	if ok {
		p.bytes -= float64(n)
		p.pkts--
	} else {
		p.winDrops++
	}
	return ok, p.overRun >= p.needRun
}
