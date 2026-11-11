// SPDX-FileCopyrightText: 2026 Minimalist Alliance
// SPDX-License-Identifier: MIT

//go:build !js

package webrtc

import "github.com/pion/randutil"

// desk-rtc's patch (desk-rtc/third_party/README.md): SetICEUfragPrefix's credentials. Pion's own are 16 letters of ufrag
// and 32 of password (pion/ice rand.go); these keep both lengths, the prefix taking the ufrag's first characters.
const (
	prefixedUfragLen = 16
	prefixedPwdLen   = 32
	prefixedRunes    = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

// prefixedICECredentials returns a fresh ufrag that starts with the prefix and a fresh password, or ok false when no
// prefix is set (or it leaves fewer than 8 random characters, which SetICEUfragPrefix's callers never ask for).
func (e *SettingEngine) prefixedICECredentials() (ufrag, pwd string, ok bool) {
	prefix := e.candidates.ufragPrefix
	if prefix == "" || len(prefix) > prefixedUfragLen-8 {
		return "", "", false
	}
	tail, err := randutil.GenerateCryptoRandomString(prefixedUfragLen-len(prefix), prefixedRunes)
	if err != nil {
		return "", "", false
	}
	pwd, err = randutil.GenerateCryptoRandomString(prefixedPwdLen, prefixedRunes)
	if err != nil {
		return "", "", false
	}

	return prefix + tail, pwd, true
}
