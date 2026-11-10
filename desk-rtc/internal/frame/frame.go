// Package frame implements the design 4.2.4 data-channel frame. desk-rtc never parses these;
// deskctl and fake-deskd do.
package frame

import (
	"encoding/binary"
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

// Decode parses one frame.
func Decode(b []byte) (Frame, error) {
	if len(b) < HeaderSize || b[0] != Version {
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
