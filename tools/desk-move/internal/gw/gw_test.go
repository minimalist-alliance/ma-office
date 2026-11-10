package gw

import "testing"

func TestOfficeOrigin(t *testing.T) {
	cases := map[string]string{
		"wss://gw.staging.minimalistalliance.com/v1/client": "https://office.staging.minimalistalliance.com",
		"wss://gw.minimalistalliance.com/v1/client":         "https://office.minimalistalliance.com",
		"ws://127.0.0.1:8787/v1":                            "",
		"not a url %%":                                      "",
	}
	for in, want := range cases {
		if got := OfficeOrigin(in); got != want {
			t.Errorf("OfficeOrigin(%q) = %q, want %q", in, got, want)
		}
	}
}
