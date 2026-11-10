// Package stats reads this process's CPU and memory, and the network counters of the machine (or
// container) it runs in, for the load test.
package stats

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// clockTicks is USER_HZ, 100 on every Linux this runs on.
const clockTicks = 100

// Proc is one sample.
type Proc struct {
	At         time.Time `json:"at"`
	CPUSeconds float64   `json:"cpuSeconds"` // user + system, since start
	UserSecs   float64   `json:"userSeconds"`
	SysSecs    float64   `json:"systemSeconds"`
	RSSBytes   int64     `json:"rssBytes"`
	Goroutines int       `json:"goroutines"`
	NetRx      uint64    `json:"netRx"` // bytes, every interface but lo
	NetTx      uint64    `json:"netTx"`
	NetRxPkts  uint64    `json:"netRxPkts"`
	NetTxPkts  uint64    `json:"netTxPkts"`
}

// Sample reads /proc now.
func Sample() Proc {
	p := Proc{At: time.Now(), Goroutines: runtime.NumGoroutine()}
	if b, err := os.ReadFile("/proc/self/stat"); err == nil {
		s := string(b)
		if i := strings.LastIndexByte(s, ')'); i > 0 {
			f := strings.Fields(s[i+1:])
			// After the command: state is field 3, utime 14 and stime 15 (1-based in proc(5)).
			if len(f) > 13 {
				u, _ := strconv.ParseFloat(f[11], 64)
				st, _ := strconv.ParseFloat(f[12], 64)
				p.CPUSeconds = (u + st) / clockTicks
				p.UserSecs = u / clockTicks
				p.SysSecs = st / clockTicks
			}
		}
	}
	if f, err := os.Open("/proc/self/status"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if rest, ok := strings.CutPrefix(sc.Text(), "VmRSS:"); ok {
				kb, _ := strconv.ParseInt(strings.Fields(rest)[0], 10, 64)
				p.RSSBytes = kb * 1024
			}
		}
		f.Close()
	}
	if f, err := os.Open("/proc/net/dev"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			name, rest, ok := strings.Cut(sc.Text(), ":")
			if !ok || strings.TrimSpace(name) == "lo" {
				continue
			}
			v := strings.Fields(rest)
			if len(v) < 10 {
				continue
			}
			rx, _ := strconv.ParseUint(v[0], 10, 64)
			rxp, _ := strconv.ParseUint(v[1], 10, 64)
			tx, _ := strconv.ParseUint(v[8], 10, 64)
			txp, _ := strconv.ParseUint(v[9], 10, 64)
			p.NetRx += rx
			p.NetRxPkts += rxp
			p.NetTx += tx
			p.NetTxPkts += txp
		}
		f.Close()
	}
	return p
}
