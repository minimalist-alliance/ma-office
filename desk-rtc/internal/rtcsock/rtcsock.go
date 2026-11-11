// Package rtcsock implements the rtc.sock protocol v1 (docs/interfaces/desk-runtime.md section 4):
// the envelope, the JSON messages and the channel table shared by desk-rtc and its clients.
package rtcsock

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
)

// Envelope types.
const (
	TypeJSON   byte = 0x01
	TypeData   byte = 0x02
	TypeCredit byte = 0x03
)

const (
	// MaxEnvelope is the largest value of the length field (type byte plus body).
	MaxEnvelope = 64 * 1024
	// InitialCredit is what each side starts with, per channel of each session.
	InitialCredit = 256 * 1024
	// MaxFrame is the largest design 4.2.4 frame, header included.
	MaxFrame = 16 * 1024
	// CreditGrantStep is how much drained data desk-rtc collects before it grants credit back.
	CreditGrantStep = 32 * 1024
)

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

	// NumBridged is the number of channels bridged to deskd (ids 0-5).
	NumBridged = 6
	// NumChannels is the number of pre-negotiated channels.
	NumChannels = 8
)

// SendPriority lists the bridged channels from most to least urgent (design 4.2.6). keys and input
// sit between ctl and rpc in the design, but only ever flow client to desk and never reach deskd.
var SendPriority = [NumBridged]uint8{ChCtl, ChRPC, ChMdoc, ChEvents, ChCollab, ChBulk}

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

// Error codes of session.error.
const (
	CodeNotConfigured       = "not_configured"
	CodeSessionLimitReached = "session_limit_reached"
	CodeIdentityMismatch    = "identity_mismatch"
	CodeBadOffer            = "bad_offer"
	CodeInternal            = "internal"
)

// Permissions are what deskd grants a session.
type Permissions struct {
	Video bool `json:"video"`
	Input bool `json:"input"`
}

// SessionStats is one row of the stats reply.
type SessionStats struct {
	SessionID     string  `json:"sessionId"`
	Transport     string  `json:"transport"`
	RTTMs         float64 `json:"rttMs"`
	BytesSent     uint64  `json:"bytesSent"`
	BytesReceived uint64  `json:"bytesReceived"`
	// InputDropped and KeysDropped count channel 6 and 7 events that weren't injected (section 8.6).
	InputDropped uint64 `json:"inputDropped,omitempty"`
	KeysDropped  uint64 `json:"keysDropped,omitempty"`
	Viewing      bool   `json:"viewing,omitempty"`
	RTPDropped   uint64 `json:"rtpDropped,omitempty"`
	// Quality is the session's QUALITY ask (stream-quality.md section 3), absent when it hasn't asked.
	Quality *string `json:"quality,omitempty"`
	// MemberID is the guild member the session belongs to, on a Guild Desk only (desk-rtc README, "Guild mode").
	MemberID string `json:"memberId,omitempty"`
	// Closed marks a Guild Desk session that has closed: its bytes are final. It stays in every stats until deskd
	// lists it in stats.get's ack (desk-rtc README, "Guild mode").
	Closed bool `json:"closed,omitempty"`
}

// MemberStats is one row of a Guild Desk's stats: one member's bytes over this desk-rtc's life, closed sessions
// included, and how many sessions the member has open now. deskd turns them into each member's share of the guild's
// traffic for the heartbeat (desk-rtc README, "Guild mode").
type MemberStats struct {
	MemberID      string `json:"memberId"`
	Sessions      int    `json:"sessions"`
	BytesSent     uint64 `json:"bytesSent"`
	BytesReceived uint64 `json:"bytesReceived"`
}

// VoiceRelayStats is a Guild Desk's relay of Commons' voice ICE on 443, in stats: mappings and connections open now,
// and what a cap turned away since desk-rtc started (desk-rtc README, "Guild mode"). Commons counts the bytes.
type VoiceRelayStats struct {
	UDPMappings    int    `json:"udpMappings"`
	TCPConnections int    `json:"tcpConnections"`
	Refused        uint64 `json:"refused"`
	// UDPPending and TCPPending are those Commons hasn't answered yet, and Evicted the pending ones a newer one
	// pushed out when the pending places were full.
	UDPPending int    `json:"udpPending"`
	TCPPending int    `json:"tcpPending"`
	Evicted    uint64 `json:"evicted"`
}

// BudgetStats is a Guild Desk's memory budget in stats (desk-rtc README, "Guild mode"): the session bytes desk-rtc holds
// now each way, its limits, the most it has held, and how often each limit acted since desk-rtc started.
type BudgetStats struct {
	// RxBytes is client-to-deskd data waiting for rtc.sock, and RxMax its limit. Past it, readers wait.
	RxBytes int64 `json:"rxBytes"`
	RxMax   int64 `json:"rxMax"`
	RxPeak  int64 `json:"rxPeak"`
	// TxBytes is deskd-to-client data queued or not yet acknowledged by the client. Past TxSoft, the sessions holding
	// the most get no credit back until it falls; past TxMax, the session holding the most is closed (over_budget).
	TxBytes int64 `json:"txBytes"`
	TxSoft  int64 `json:"txSoft"`
	TxMax   int64 `json:"txMax"`
	TxPeak  int64 `json:"txPeak"`
	// RxWaits, TxWithheld and Shed count the times readers waited, grants were held back, and sessions were closed.
	RxWaits    uint64 `json:"rxWaits"`
	TxWithheld uint64 `json:"txWithheld"`
	Shed       uint64 `json:"shed"`
	// ClosedKept is the closed sessions' rows kept for deskd, and ClosedDropped those dropped unread (cap or age).
	ClosedKept    int    `json:"closedKept"`
	ClosedDropped uint64 `json:"closedDropped"`
}

// DeskKindGuild is the only deskKind in configure that changes what desk-rtc does: a Guild Desk's many members, data
// channels only. Any other value, or none, is a desk as before.
const DeskKindGuild = "guild"

// StreamStats is the stats reply's view of desk-stream (section 8.4).
type StreamStats struct {
	State            string `json:"state"`
	Viewers          int    `json:"viewers"`
	VideoPackets     uint64 `json:"videoPackets"`
	VideoBytes       uint64 `json:"videoBytes"`
	AudioPackets     uint64 `json:"audioPackets"`
	KeyframeRequests uint64 `json:"keyframeRequests"`
	// Level is the quality level in effect, and Limit deskd's stream.limit, null when there's none
	// (stream-quality.md section 4).
	Level string  `json:"level"`
	Limit *string `json:"limit"`
	// Profile is the allowance profile desk-egress has picked (ADR 0036), "capped" or "deep", absent for the normal
	// picture. Its ceiling (capped Medium, deep Low) holds the level as Limit does (stream-quality.md section 4).
	Profile *string `json:"profile,omitempty"`
	// Crop is the island in effect (section 8.8), absent for the whole screen. InputStale counts events dropped for
	// being meant for another island or the whole screen, and IslandBlocked presses dropped with something over the
	// island; both cumulative.
	Crop          *Crop  `json:"crop,omitempty"`
	InputStale    uint64 `json:"inputStale,omitempty"`
	IslandBlocked uint64 `json:"islandBlocked,omitempty"`
}

// Crop is a video island (ADR 0075, section 8.8): the rectangle of the X screen the stream shows, in pixels, and the
// largest picture it may be sent at. Epoch, 1 to 255, names it to the client, which puts it in byte 3 of every input
// event for it. Keys lets KEY events through: deskd sets it only while the page's focus is inside the island's element.
type Crop struct {
	Epoch int  `json:"epoch"`
	X     int  `json:"x"`
	Y     int  `json:"y"`
	W     int  `json:"w"`
	H     int  `json:"h"`
	OutW  int  `json:"outW"`
	OutH  int  `json:"outH"`
	Keys  bool `json:"keys,omitempty"`
}

// Message is every JSON message of section 4.3. Unused fields are omitted on the wire.
type Message struct {
	T string `json:"t"`

	// configure. deskKind and maxSessionsPerMember are a Guild Desk's (desk-rtc README, "Guild mode"); configured
	// echoes deskKind, maxSessions and maxSessionsPerMember as they took effect, on a Guild Desk only.
	PublicIPv4           string `json:"publicIpv4,omitempty"`
	MaxSessions          int    `json:"maxSessions,omitempty"`
	DeskKind             string `json:"deskKind,omitempty"`
	MaxSessionsPerMember int    `json:"maxSessionsPerMember,omitempty"`
	// Credit, on a Guild Desk: deskd's credit per channel toward desk-rtc for this connection's sessions, in place of
	// InitialCredit. deskd may ask in configure; configured says what's in effect (desk-rtc README, "Guild mode").
	Credit int `json:"credit,omitempty"`

	// configured
	FingerprintsSha256 []string `json:"fingerprintsSha256,omitempty"`
	Version            string   `json:"version,omitempty"`
	NotAfter           string   `json:"notAfter,omitempty"`

	// session.*
	SessionID           string       `json:"sessionId,omitempty"`
	Offer               string       `json:"offer,omitempty"`
	Answer              string       `json:"answer,omitempty"`
	ExpectedFingerprint string       `json:"expectedFingerprint,omitempty"`
	Permissions         *Permissions `json:"permissions,omitempty"`
	Handle              uint32       `json:"handle,omitempty"`
	Video               *bool        `json:"video,omitempty"`
	View                *bool        `json:"view,omitempty"`
	Input               *bool        `json:"input,omitempty"`
	Code                any          `json:"code,omitempty"`
	Message             string       `json:"message,omitempty"`
	Reason              string       `json:"reason,omitempty"`
	State               string       `json:"state,omitempty"`
	Transport           string       `json:"transport,omitempty"`
	At                  string       `json:"at,omitempty"`

	// stream.limit: a level name, or null or absent for no limit (stream-quality.md section 4)
	Level *string `json:"level,omitempty"`

	// stream.crop: the island, or null or absent for the whole screen (section 8.8). island.blocked: Epoch.
	Crop  *Crop `json:"crop,omitempty"`
	Epoch int   `json:"epoch,omitempty"`

	// session.create, member.close and member.closed on a Guild Desk: the member's id, the token's sub. member.closed
	// lists the sessions it closed.
	MemberID   string   `json:"memberId,omitempty"`
	SessionIDs []string `json:"sessionIds,omitempty"`

	// stats. Members, VoiceRelay and Budget are a Guild Desk's only. bytesSent and bytesReceived are also a Guild
	// Desk's session.closed: the session's final counts.
	Sessions      []SessionStats   `json:"sessions,omitempty"`
	Members       []MemberStats    `json:"members,omitempty"`
	VoiceRelay    *VoiceRelayStats `json:"voiceRelay,omitempty"`
	Budget        *BudgetStats     `json:"budget,omitempty"`
	PeerBytesSent *uint64          `json:"peerBytesSent,omitempty"`
	BytesSent     *uint64          `json:"bytesSent,omitempty"`
	BytesReceived *uint64          `json:"bytesReceived,omitempty"`
	Stream        *StreamStats     `json:"stream,omitempty"`
	// Ack, in a Guild Desk's stats.get: closed sessions whose final rows deskd has recorded. desk-rtc forgets them.
	Ack []string `json:"ack,omitempty"`

	// clipboard.*, built with the Clip functions in clipboard.go. id 0, part 0, last: false and on: false
	// all mean something, so they're pointers and stay on the wire. none is only ever sent as true.
	// Decoding never fails on these: see UnmarshalJSON and ClipBad.
	ID       *uint64 `json:"id,omitempty"`
	Part     *int    `json:"part,omitempty"`
	Last     *bool   `json:"last,omitempty"`
	None     bool    `json:"none,omitempty"`
	Data     string  `json:"data,omitempty"`
	MaxBytes int     `json:"maxBytes,omitempty"`
	On       *bool   `json:"on,omitempty"`

	// ClipBad says a clipboard field above came with the wrong type, or out of range, and was left unset. It's
	// never on the wire.
	ClipBad bool `json:"-"`
}

// MaxClipID is the largest clipboard id: ids are integers from 0 to 2^53-1, which a JavaScript number holds exactly.
const MaxClipID = 1<<53 - 1

// UnmarshalJSON decodes a message the way encoding/json would, except that a clipboard field can't fail it. One
// that's the wrong type is left unset and ClipBad says so: a mistake in one clipboard message mustn't close rtc.sock,
// and every session with it. Every other field fails it as before.
//
// id must be an integer from 0 to MaxClipID, and part and maxBytes plain integers, so 1e6, 1.0 and "1" are all
// wrong. last, none and on are booleans, and data a string. null is the same as leaving a field out.
func (m *Message) UnmarshalJSON(b []byte) error {
	type plain Message // no methods, so no recursion
	var aux struct {
		*plain
		// These are shallower than plain's, so they're the ones decoded.
		ID       json.RawMessage `json:"id"`
		Part     json.RawMessage `json:"part"`
		Last     json.RawMessage `json:"last"`
		None     json.RawMessage `json:"none"`
		Data     json.RawMessage `json:"data"`
		MaxBytes json.RawMessage `json:"maxBytes"`
		On       json.RawMessage `json:"on"`
	}
	*m = Message{}
	aux.plain = (*plain)(m)
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	ok := true
	if v, set, good := clipInt(aux.ID); set && good && v >= 0 && v <= MaxClipID {
		id := uint64(v)
		m.ID = &id
	} else if set {
		ok = false
	}
	if v, set, good := clipInt(aux.Part); good && set {
		part := int(v)
		m.Part = &part
	} else if !good {
		ok = false
	}
	if v, set, good := clipInt(aux.MaxBytes); good && set {
		m.MaxBytes = int(v)
	} else if !good {
		ok = false
	}
	ok = clipField(aux.Last, &m.Last) && ok
	ok = clipField(aux.On, &m.On) && ok
	ok = clipField(aux.Data, &m.Data) && ok
	ok = clipField(aux.None, &m.None) && ok
	m.ClipBad = !ok

	return nil
}

// isNull is true for a field that's absent or null.
func isNull(raw json.RawMessage) bool { return len(raw) == 0 || string(raw) == "null" }

// clipInt reads a plain JSON integer: set is false for absent or null, and good false for anything else that isn't
// one. The value is valid JSON already, and strconv refuses a fraction, an exponent, a string and an overflow.
func clipInt(raw json.RawMessage) (v int64, set, good bool) {
	if isNull(raw) {
		return 0, false, true
	}
	v, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil || v < math.MinInt || v > math.MaxInt {
		return 0, true, false
	}

	return v, true, true
}

// clipField decodes a string or a boolean, and says false if it's the wrong type. into is left as it was then.
func clipField[T any](raw json.RawMessage, into *T) bool {
	if isNull(raw) {
		return true
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return false
	}
	*into = v

	return true
}

// CodeString returns Code when it is a string (session.error), or "" otherwise.
func (m *Message) CodeString() string {
	s, _ := m.Code.(string)

	return s
}

// ErrTooLarge means the peer announced an envelope over MaxEnvelope.
var ErrTooLarge = errors.New("rtcsock: envelope over 64 KiB")

// ErrMalformed means a body doesn't fit its type.
var ErrMalformed = errors.New("rtcsock: malformed envelope")

func envelope(typ byte, bodyLen int) []byte {
	buf := make([]byte, 5, 5+bodyLen)
	binary.BigEndian.PutUint32(buf, uint32(bodyLen+1))
	buf[4] = typ

	return buf
}

// EncodeJSON builds a complete JSON envelope.
func EncodeJSON(m *Message) ([]byte, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("rtcsock: encode: %w", err)
	}
	if len(body)+1 > MaxEnvelope {
		return nil, ErrTooLarge
	}

	return append(envelope(TypeJSON, len(body)), body...), nil
}

// EncodeData builds a complete DATA envelope.
func EncodeData(handle uint32, channel uint8, frame []byte) []byte {
	buf := envelope(TypeData, 5+len(frame))
	buf = binary.BigEndian.AppendUint32(buf, handle)
	buf = append(buf, channel)

	return append(buf, frame...)
}

// EncodeCredit builds a complete CREDIT envelope.
func EncodeCredit(handle uint32, channel uint8, n uint32) []byte {
	buf := envelope(TypeCredit, 9)
	buf = binary.BigEndian.AppendUint32(buf, handle)
	buf = append(buf, channel)

	return binary.BigEndian.AppendUint32(buf, n)
}

// ReadEnvelope reads one envelope.
func ReadEnvelope(r *bufio.Reader) (byte, []byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 {
		return 0, nil, ErrMalformed
	}
	if n > MaxEnvelope {
		return 0, nil, ErrTooLarge
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}

	return buf[0], buf[1:], nil
}

// ParseData splits a DATA body. The frame aliases body.
func ParseData(body []byte) (uint32, uint8, []byte, error) {
	if len(body) < 5 {
		return 0, 0, nil, ErrMalformed
	}

	return binary.BigEndian.Uint32(body), body[4], body[5:], nil
}

// ParseCredit splits a CREDIT body.
func ParseCredit(body []byte) (uint32, uint8, uint32, error) {
	if len(body) != 9 {
		return 0, 0, 0, ErrMalformed
	}

	return binary.BigEndian.Uint32(body), body[4], binary.BigEndian.Uint32(body[5:]), nil
}
