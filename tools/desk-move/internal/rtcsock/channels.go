// Copied from desk-rtc/internal/rtcsock/rtcsock.go at desk-rtc commit 42e6a09 (Go's internal rule stops
// an import across modules). Trimmed to the channel table: ma-move never speaks rtc.sock itself.

// Package rtcsock holds the fixed table of negotiated data channels (design 4.2.3).
package rtcsock

// Channel ids (design 4.2.3).
const (
	ChCtl    uint8 = 0
	ChRPC    uint8 = 1
	ChEvents uint8 = 2
	ChCollab uint8 = 3
	ChMdoc   uint8 = 4
	ChBulk   uint8 = 5
	ChInput  uint8 = 6
	ChKeys   uint8 = 7

	// NumChannels is the number of pre-negotiated channels.
	NumChannels = 8
)

// ChannelDef is one row of the design 4.2.3 table.
type ChannelDef struct {
	ID             uint8
	Label          string
	Ordered        bool
	MaxRetransmits *uint16
}

var zeroRetransmits uint16

// Channels is the fixed table of negotiated data channels.
var Channels = [NumChannels]ChannelDef{
	{ID: ChCtl, Label: "ctl", Ordered: true},
	{ID: ChRPC, Label: "rpc", Ordered: true},
	{ID: ChEvents, Label: "events", Ordered: true},
	{ID: ChCollab, Label: "collab", Ordered: true},
	{ID: ChMdoc, Label: "mdoc", Ordered: true},
	{ID: ChBulk, Label: "bulk", Ordered: true},
	{ID: ChInput, Label: "input", Ordered: false, MaxRetransmits: &zeroRetransmits},
	{ID: ChKeys, Label: "keys", Ordered: true},
}
