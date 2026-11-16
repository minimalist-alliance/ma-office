package main

import (
	"os"
	"sort"
	"strings"
	"testing"
)

// The list the image ships, exactly: each provider desk-agent calls (services/desk-agent/docker/desk-agent.env), every
// line a plain host name, and nothing else. verify-agent-filter.sh's F-UNIT holds a desk's copy to the same names.
func TestTheShippedListIsExactlyTheProviders(t *testing.T) {
	raw, err := os.ReadFile("../files/etc/ma/agent-egress.conf")
	if err != nil {
		t.Fatal(err)
	}
	var skipped []string
	names := parseNames(string(raw), func(f string, a ...any) { skipped = append(skipped, f) })
	if len(skipped) != 0 {
		t.Errorf("lines skipped: %d", len(skipped))
	}
	got := make([]string, 0, len(names))
	for name := range names {
		got = append(got, name)
	}
	sort.Strings(got)
	want := []string{"api.anthropic.com", "api.moonshot.ai", "api.openai.com", "api.x.ai",
		"generativelanguage.googleapis.com", "openrouter.ai"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v, want %v", got, want)
	}
	// Exact names only: nothing under a listed one, and no other Google API host.
	for _, other := range []string{"googleapis.com", "storage.googleapis.com", "www.googleapis.com", "moonshot.ai",
		"platform.moonshot.ai", "api.moonshot.cn", "aiplatform.googleapis.com"} {
		if _, ok := names[other]; ok {
			t.Errorf("%s is listed", other)
		}
	}
}
