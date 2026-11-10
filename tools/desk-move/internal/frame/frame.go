// Copied from desk-rtc/internal/frame/frame.go at desk-rtc commit 42e6a09 (Go's internal rule stops an
// import across modules). Trimmed to what ma-move uses, and extended with the bulk channel's CREDIT
// payload and the END trailer of a data.read (draft ADR data export and transfer, section 7).

// Package frame implements the design 4.2.4 data-channel frame (services/deskd/docs/API.md section 2).
package frame

import (
	"encoding/binary"
	"encoding/json"
	"errors"
)

// Kind is byte 1 of a frame.
type Kind uint8

// Kinds, numbered in design 4.2.4's table order from 1.
const (
	Hello Kind = iota + 1
	Auth
	Activity
	Ping
	Pong
	Close
	Req
	Res
	Err
	Sub
	Unsub
	Evt
	Cancel
	Data
	Chunk
	Credit
)

// Flag bits (byte 2).
const (
	FlagMore uint8 = 1 << 0
	FlagBin  uint8 = 1 << 1
	FlagEnd  uint8 = 1 << 2
)

const (
	// Version is byte 0.
	Version = 1
	// HeaderSize is the size of the fixed header.
	HeaderSize = 12
	// MaxSize is the largest frame, header included.
	MaxSize = 16 * 1024
	// MaxPayload is the largest payload of one frame.
	MaxPayload = MaxSize - HeaderSize
	// TrailerSize is the END chunk's payload: SHA-256 of bytes 0..size, then u64be size.
	TrailerSize = 32 + 8
)

// Frame is one decoded frame. Payload aliases the input of Decode.
type Frame struct {
	Kind    Kind
	Flags   uint8
	ID      uint32
	Seq     uint32
	Payload []byte
}

// ErrBad means the bytes aren't a v1 frame.
var ErrBad = errors.New("frame: not a v1 frame")

// Encode builds one frame.
func Encode(kind Kind, flags uint8, id, seq uint32, payload []byte) []byte {
	buf := make([]byte, HeaderSize, HeaderSize+len(payload))
	buf[0] = Version
	buf[1] = byte(kind)
	buf[2] = flags
	binary.BigEndian.PutUint32(buf[4:], id)
	binary.BigEndian.PutUint32(buf[8:], seq)

	return append(buf, payload...)
}

// Decode parses one frame. Like deskd, it refuses a set reserved byte, an unknown flag or an oversize
// frame.
func Decode(b []byte) (Frame, error) {
	if len(b) < HeaderSize || len(b) > MaxSize || b[0] != Version || b[3] != 0 || b[2]&^(FlagMore|FlagBin|FlagEnd) != 0 {
		return Frame{}, ErrBad
	}

	return Frame{
		Kind:    Kind(b[1]),
		Flags:   b[2],
		ID:      binary.BigEndian.Uint32(b[4:]),
		Seq:     binary.BigEndian.Uint32(b[8:]),
		Payload: b[HeaderSize:],
	}, nil
}

// EncodeCredit builds a CREDIT frame (kind 16, JSON) granting n more bytes to transfer id.
func EncodeCredit(id uint32, n int64) []byte {
	body, _ := json.Marshal(struct {
		Bytes int64 `json:"bytes"`
	}{n})

	return Encode(Credit, 0, id, 0, body)
}

// DecodeCredit reads a CREDIT payload.
func DecodeCredit(payload []byte) (int64, error) {
	var c struct {
		Bytes int64 `json:"bytes"`
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return 0, err
	}
	if c.Bytes <= 0 {
		return 0, errors.New("frame: credit must be positive")
	}

	return c.Bytes, nil
}

// Trailer is what the END chunk of a data.read carries.
type Trailer struct {
	SHA256 [32]byte
	Size   uint64
}

// EncodeTrailer builds the END chunk's payload.
func EncodeTrailer(t Trailer) []byte {
	b := make([]byte, TrailerSize)
	copy(b, t.SHA256[:])
	binary.BigEndian.PutUint64(b[32:], t.Size)

	return b
}

// DecodeTrailer reads the END chunk's payload.
func DecodeTrailer(p []byte) (Trailer, error) {
	if len(p) != TrailerSize {
		return Trailer{}, errors.New("frame: END trailer isn't 40 bytes")
	}
	var t Trailer
	copy(t.SHA256[:], p[:32])
	t.Size = binary.BigEndian.Uint64(p[32:])

	return t, nil
}
