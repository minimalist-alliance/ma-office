package main

import (
	"testing"
	"time"
)

func TestBackoffGrowsFromBaseToMaxAndStays(t *testing.T) {
	base, max := 3*time.Second, 300*time.Second
	want := []float64{3, 5.34, 9.5, 16.9, 30, 53.4, 95, 169, 300, 300, 300}
	prev := time.Duration(0)
	for i, w := range want {
		got := backoff(base, max, 8, i+1)
		if d := got.Seconds() - w; d > w*0.01+0.05 || d < -(w*0.01+0.05) {
			t.Errorf("restart %d: %.2f s, want about %.2f s", i+1, got.Seconds(), w)
		}
		if got < prev {
			t.Errorf("restart %d: %v is shorter than the one before", i+1, got)
		}
		prev = got
	}
	if backoff(base, max, 8, 1000) != max {
		t.Error("a long loop is capped at max")
	}
}

func TestBackoffOffIsFlat(t *testing.T) {
	for n := 1; n < 20; n++ {
		if backoff(2*time.Second, 300*time.Second, 0, n) != 2*time.Second {
			t.Fatalf("restart %d with no steps should be the base", n)
		}
		if backoff(2*time.Second, 2*time.Second, 8, n) != 2*time.Second {
			t.Fatalf("restart %d with max == base should be the base", n)
		}
	}
}
