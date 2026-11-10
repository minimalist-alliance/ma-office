//go:build race

package rtcserver

// raceEnabled says the race detector is on, which makes the heavy tests ten times slower.
const raceEnabled = true
