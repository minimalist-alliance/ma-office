// measure runs bible-app as deskd would (its environment, the socket, HELLO) and reports what docs/sub-status asks:
// HELLO time, memory (VmRSS, with RssAnon and RssFile) at each step, and chapter and search latency, wall and CPU.
// It reads the process's /proc files, so it needs Linux and no privileges. Numbers are for the machine it runs on.
//
//	go run ./tools/measure -bin dist/files/bin/bible-app -texts texts [-fill notes|highlights] [-data DIR]
//
// -fill fills the store to its cap first, through the socket; -members N fills N members' buckets of a Guild Desk
// instead of the owner's, each to its cap or until the desk's is reached; -data keeps the data folder, so a second
// run without -fill measures the same store loaded from disk.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/wire"
)

type link struct {
	c     *wire.Conn
	mu    sync.Mutex
	next  uint32
	wait  map[uint32]chan wire.Frame
	guild bool
}

func (l *link) read() {
	for {
		f, err := wire.Read(l.c.R)
		if err != nil {
			return
		}
		if f.Kind == wire.Req { // the app's desk.info.get
			_ = l.c.Send(wire.Res, f.ID, 0, map[string]any{"appApi": "1.0", "deskApi": "1.4", "timeZone": "UTC", "guildDesk": l.guild})
			continue
		}
		l.mu.Lock()
		ch := l.wait[f.ID]
		delete(l.wait, f.ID)
		l.mu.Unlock()
		if ch != nil && (f.Kind == wire.Res || f.Kind == wire.Err) {
			ch <- f
		}
	}
}

var ownerCaller = map[string]any{"kind": "owner"}

func memberCaller(i int) map[string]any {
	return map[string]any{"kind": "guild_member", "member": fmt.Sprintf("p-member%016d", i), "role": "member", "grants": []string{}, "teen": false}
}

func (l *link) call(m string, p any) (json.RawMessage, error) { return l.callAs(ownerCaller, m, p) }

func (l *link) callAs(caller map[string]any, m string, p any) (json.RawMessage, error) {
	l.mu.Lock()
	l.next++
	id := l.next
	ch := make(chan wire.Frame, 1)
	l.wait[id] = ch
	l.mu.Unlock()
	if err := l.c.Send(wire.Req, id, 0, map[string]any{"m": m, "p": p, "deadlineMs": 30000, "idem": fmt.Sprintf("measure-%d", id),
		"from": map[string]any{"kind": "view", "caller": caller}}); err != nil {
		return nil, err
	}
	f := <-ch
	if f.Kind == wire.Err {
		return nil, fmt.Errorf("%s: %s", m, f.Payload)
	}
	return f.Payload, nil
}

type proc struct{ pid int }

func (p proc) mem() string {
	b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/status", p.pid))
	vals := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			vals[k] = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), " kB"))
		}
	}
	mib := func(k string) string {
		n, _ := strconv.ParseFloat(vals[k], 64)
		return fmt.Sprintf("%.1f", n/1024)
	}
	return fmt.Sprintf("VmRSS %s MiB (anon %s, file %s), VmHWM %s MiB", mib("VmRSS"), mib("RssAnon"), mib("RssFile"), mib("VmHWM"))
}

// cpu is the process's user and system time.
func (p proc) cpu() time.Duration {
	b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", p.pid))
	s := string(b)
	f := strings.Fields(s[strings.LastIndexByte(s, ')')+2:])
	u, _ := strconv.ParseInt(f[11], 10, 64)
	k, _ := strconv.ParseInt(f[12], 10, 64)
	return time.Duration(u+k) * time.Second / 100 // USER_HZ
}

// The canon's ids and chapter counts, for filling the store.
var canonIDs = strings.Fields("GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV")

var chapters = func() map[string]int {
	n := []int{50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31, 12, 8, 66, 52, 5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4,
		28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1, 13, 5, 5, 3, 5, 1, 1, 1, 22}
	m := map[string]int{}
	for i, id := range canonIDs {
		m[id] = n[i]
	}
	return m
}()

func pct(d []time.Duration, q float64) time.Duration {
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[int(float64(len(s)-1)*q)]
}

func ms(d time.Duration) string { return fmt.Sprintf("%.1f ms", float64(d.Microseconds())/1000) }

func main() {
	log.SetFlags(0)
	bin := flag.String("bin", "", "bible-app")
	texts := flag.String("texts", "", "the texts folder")
	runs := flag.Int("runs", 20, "runs per search")
	fill := flag.String("fill", "", "notes or highlights: fill the store to its cap first")
	data := flag.String("data", "", "the data folder to use and keep (default: a temporary one)")
	members := flag.Int("members", 0, "with -fill: fill this many Guild Desk members' data instead of the owner's")
	flag.Parse()
	dir, _ := os.MkdirTemp("", "bibm")
	defer os.RemoveAll(dir)
	dataDir := filepath.Join(dir, "data")
	if *data != "" {
		dataDir = *data
	}
	sock := filepath.Join(dir, "app.sock")
	cmd := exec.Command(*bin, "-texts", *texts)
	cmd.Env = []string{"MA_APP_ID=com.minimalistalliance.bible", "MA_APP_VERSION=1.0.0", "MA_APP_API=1.0", "MA_APP_SOCKET=" + sock,
		"MA_APP_DATA=" + dataDir, "MA_APP_CACHE=" + filepath.Join(dir, "cache"), "MA_APP_MEMORY_MAX=67108864",
		"MA_APP_CPU_MAX=0.25", "MA_DESKD_UID=" + strconv.Itoa(os.Getuid()), "HOME=" + dir}
	cmd.Stderr = os.Stderr
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		log.Fatal(err)
	}
	defer cmd.Process.Kill()
	p := proc{cmd.Process.Pid}
	fatal := func(v ...any) { _ = cmd.Process.Kill(); log.Fatal(v...) }
	var nc net.Conn
	for {
		var err error
		if nc, err = net.Dial("unix", sock); err == nil {
			break
		}
		if time.Since(t0) > 5*time.Second {
			fatal("no socket")
		}
		time.Sleep(time.Millisecond)
	}
	l := &link{c: wire.NewConn(nc), wait: map[uint32]chan wire.Frame{}, guild: *members > 0}
	_ = l.c.Send(wire.Hello, 0, 0, map[string]any{"appApi": "1.0", "deskApi": "1.4"})
	if f, err := wire.Read(l.c.R); err != nil || f.Kind != wire.Hello {
		fatal("hello: ", err)
	}
	fmt.Printf("HELLO %s after exec\n", ms(time.Since(t0)))
	go l.read()
	time.Sleep(200 * time.Millisecond)
	fmt.Println("idle after HELLO:", p.mem())

	must := func(m string, prm any) json.RawMessage {
		b, err := l.call(m, prm)
		if err != nil {
			fatal(err)
		}
		return b
	}
	if *fill != "" {
		tf := time.Now()
		puts := 0
		callers := []map[string]any{ownerCaller}
		if *members > 0 {
			callers = nil
			for i := 0; i < *members; i++ {
				callers = append(callers, memberCaller(i))
			}
		}
		for ci, caller := range callers {
			for i := ci * 7919; ; i++ {
				b := canonIDs[i%len(canonIDs)]
				p := map[string]any{"mark": map[string]any{"kind": "highlight", "book": b, "chapter": 1 + (i/len(canonIDs))%chapters[b],
					"verse": 1, "verseEnd": 176, "color": "amber"}}
				if *fill == "notes" {
					text := (strconv.Itoa(i) + " " + strings.Repeat("A note written while reading, long. ", 280))[:10000]
					p = map[string]any{"mark": map[string]any{"kind": "note", "book": b, "chapter": 1, "verse": 1 + i%176, "text": text}}
				}
				if _, err := l.callAs(caller, "bible.mark.put", p); err != nil {
					if !strings.Contains(err.Error(), `"full"`) {
						fatal(err)
					}
					break
				}
				puts++
			}
		}
		total := 0
		for _, caller := range callers {
			var list struct {
				Total int `json:"total"`
			}
			b, _ := l.callAs(caller, "bible.marks.list", map[string]any{"limit": 1})
			_ = json.Unmarshal(b, &list)
			total += list.Total
		}
		fmt.Printf("filled with %s for %d callers to the caps: %d marks in %d puts, %v; %s\n", *fill, len(callers), total, puts,
			time.Since(tf).Round(time.Millisecond), p.mem())
	}
	t1 := time.Now()
	must("bible.state", map[string]any{})
	fmt.Printf("bible.state, the first (reads BSB): %s\n", ms(time.Since(t1)))
	must("bible.chapter", map[string]any{"translation": "bsb", "book": "JHN", "chapter": 3})
	fmt.Println("after one chapter:", p.mem())
	for _, c := range []string{"web", "kjv", "asv"} {
		must("bible.chapter", map[string]any{"translation": c, "book": "PSA", "chapter": 119})
	}
	fmt.Println("after a chapter in each of the four:", p.mem())

	var books struct {
		Books []struct {
			ID       string `json:"id"`
			Chapters int    `json:"chapters"`
		} `json:"books"`
	}
	_ = json.Unmarshal(must("bible.books", map[string]any{"translation": "bsb"}), &books)
	var chapters []time.Duration
	var size []int
	rng := rand.New(rand.NewSource(1))
	cpu0 := p.cpu()
	for i := 0; i < 300; i++ {
		b := books.Books[rng.Intn(len(books.Books))]
		t := time.Now()
		r := must("bible.chapter", map[string]any{"translation": "bsb", "book": b.ID, "chapter": 1 + rng.Intn(b.Chapters)})
		chapters = append(chapters, time.Since(t))
		size = append(size, len(r))
	}
	cpuCh := (p.cpu() - cpu0) / 300
	t := time.Now()
	ps := must("bible.chapter", map[string]any{"translation": "bsb", "book": "PSA", "chapter": 119})
	fmt.Printf("chapter (BSB, 300 random): p50 %s, p95 %s, CPU %s each; Psalm 119 %s, %d KiB\n", ms(pct(chapters, .5)), ms(pct(chapters, .95)),
		ms(cpuCh), ms(time.Since(t)), len(ps)>>10)

	queries := []string{"love", "faith hope", `"in the beginning"`, "bless*", "god", "the"}
	for _, tr := range []string{"bsb", "kjv", "all"} {
		for _, q := range queries {
			var d []time.Duration
			var total, bytes int
			c0 := p.cpu()
			for i := 0; i < *runs; i++ {
				t := time.Now()
				r := must("bible.search", map[string]any{"translation": tr, "q": q, "limit": 50})
				d = append(d, time.Since(t))
				var res struct {
					Total int `json:"total"`
				}
				_ = json.Unmarshal(r, &res)
				total, bytes = res.Total, len(r)
			}
			fmt.Printf("search %-4s %-20s %6d verses: p50 %s, p95 %s, CPU %s each, reply %d KiB\n", tr, q, total, ms(pct(d, .5)), ms(pct(d, .95)),
				ms((p.cpu()-c0)/time.Duration(*runs)), bytes>>10)
		}
	}
	fmt.Println("after searching all four:", p.mem())
	// A burst: 32 searches at once, as many as deskd lets in flight.
	var wg sync.WaitGroup
	t = time.Now()
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			must("bible.search", map[string]any{"translation": "all", "q": queries[i%len(queries)], "limit": 200})
		}(i)
	}
	wg.Wait()
	fmt.Printf("a burst of 32 searches over all four at once, limit 200: %s; %s\n", ms(time.Since(t)), p.mem())
	_ = cmd.Process.Signal(os.Interrupt)
	_ = cmd.Wait()
}
