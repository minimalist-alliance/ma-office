// storecap fills a store to its caps and reports the process's memory, then after a restart (a load from disk), with
// the soft heap limit the app sets for a 64 MiB box.
//
//	go run ./tools/measure/storecap -kind notes|highlights
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/store"
)

func rss() string {
	runtime.GC()
	b, _ := os.ReadFile("/proc/self/status")
	out := []string{}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "VmRSS") || strings.HasPrefix(l, "RssAnon") {
			out = append(out, strings.Join(strings.Fields(l), " "))
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return fmt.Sprintf("%s, heap in use %.1f MiB", strings.Join(out, ", "), float64(m.HeapInuse)/(1<<20))
}

func main() {
	kind := flag.String("kind", "notes", "notes (32 MiB of 10,000-character notes) or highlights (100,000 marks)")
	flag.Parse()
	debug.SetMemoryLimit(64 << 20 * 7 / 10)
	dir, _ := os.MkdirTemp("", "bibcap")
	defer os.RemoveAll(dir)
	s, err := store.Open(dir, store.Options{})
	if err != nil {
		panic(err)
	}
	fmt.Println("empty:", rss())
	t0 := time.Now()
	n := 0
	for i := 0; ; i++ {
		b := canon.Books[i%66]
		// A highlight over 176 verses is 176 marks in one put; each of its chapters is new.
		in := store.MarkInput{Kind: "highlight", Book: b.ID, Chapter: 1 + (i/66)%b.Chapters, Verse: 1, VerseEnd: 176, Color: "amber"}
		if *kind == "notes" {
			text := (strconv.Itoa(i) + " " + strings.Repeat("A note written while reading, long. ", 280))[:10000]
			in = store.MarkInput{Kind: "note", Book: b.ID, Chapter: 1, Verse: 1 + i%176, Text: &text}
		}
		if _, _, err := s.PutMark(store.Owner, "", in); err != nil {
			break
		}
		n++
	}
	count, bytes := s.Count(store.Owner)
	fmt.Printf("full after %d puts in %v: %d marks, %.1f MiB stored: %s\n", n, time.Since(t0).Round(time.Millisecond), count, float64(bytes)/(1<<20), rss())
	s.Close()
	t1 := time.Now()
	s, err = store.Open(dir, store.Options{})
	if err != nil {
		panic(err)
	}
	count, _ = s.Count(store.Owner)
	fmt.Printf("loaded again in %v, %d marks: %s\n", time.Since(t1).Round(time.Millisecond), count, rss())
	runtime.KeepAlive(s)
}
