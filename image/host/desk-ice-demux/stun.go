package main

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"strconv"
	"strings"
)

// The first RFC 4571 frame of a connection (a 16-bit length, then the packet), which must be a STUN binding request
// (RFC 5389) whose USERNAME's first part is a slot's ufrag: "s<kk>..." (desk-rtc's rtcserver/shared.go writes the prefix).
// Its MESSAGE-INTEGRITY is desk-rtc's to check: only the slot's desk-rtc holds the session's password. Its FINGERPRINT is
// checked here, which costs a CRC and turns away anything that merely looks like a header.

const (
	stunHeader        = 20
	stunMagic         = 0x2112A442
	stunBindingReq    = 0x0001
	attrUsername      = 0x0006
	attrIntegrity     = 0x0008
	attrFingerprint   = 0x8028
	fingerprintXOR    = 0x5354554e
	maxFirstFrame     = 2048 // desk-rtc's gate reads at most this (gateMaxFirstPacket)
	maxUsername       = 513  // RFC 5389 section 15.3
	maxSlot           = 32   // UDP 4430+32 = 4462, the top of the slots' ports
	errBadFrameString = "not a framed STUN binding request"
)

var (
	errBadFrame   = errors.New(errBadFrameString)
	errNoUsername = errors.New("no USERNAME")
	errNoTag      = errors.New("the USERNAME's ufrag names no slot")
)

// frameLength reads the RFC 4571 length and says whether a first frame that long can be one. A TLS ClientHello (0x16
// 0x03), an HTTP request ("GE", "PO", ...) or an SSH banner ("SS") reads as a length over the cap: closed at once.
func frameLength(hdr [2]byte) (int, bool) {
	n := int(binary.BigEndian.Uint16(hdr[:]))

	return n, n >= stunHeader && n <= maxFirstFrame && n%4 == 0
}

// checkHeader says whether the STUN header can be a binding request of the frame's length, before the rest is read.
func checkHeader(h []byte, frameLen int) bool {
	if len(h) < stunHeader {
		return false
	}
	typ := binary.BigEndian.Uint16(h[0:2])
	mlen := int(binary.BigEndian.Uint16(h[2:4]))

	return typ == stunBindingReq && binary.BigEndian.Uint32(h[4:8]) == stunMagic && mlen == frameLen-stunHeader && mlen%4 == 0
}

// slotOfRequest is the slot a binding request's USERNAME names, from its first ufrag's tag. The packet must be whole
// STUN: every attribute inside the length, USERNAME present once, FINGERPRINT last and right.
func slotOfRequest(pkt []byte) (int, error) {
	if !checkHeader(pkt, len(pkt)) {
		return 0, errBadFrame
	}
	var username []byte
	seenUser, seenFP := false, false
	off := stunHeader
	for off < len(pkt) {
		if seenFP || off+4 > len(pkt) {
			return 0, errBadFrame // nothing may follow FINGERPRINT (RFC 5389 section 15.5)
		}
		typ := binary.BigEndian.Uint16(pkt[off : off+2])
		alen := int(binary.BigEndian.Uint16(pkt[off+2 : off+4]))
		end := off + 4 + alen
		if end > len(pkt) {
			return 0, errBadFrame
		}
		val := pkt[off+4 : end]
		switch typ {
		case attrUsername:
			if seenUser || alen == 0 || alen > maxUsername {
				return 0, errBadFrame
			}
			username, seenUser = val, true
		case attrFingerprint:
			if alen != 4 {
				return 0, errBadFrame
			}
			// The CRC covers the message up to FINGERPRINT, with the header's length already counting it.
			want := crc32.ChecksumIEEE(pkt[:off]) ^ fingerprintXOR
			if binary.BigEndian.Uint32(val) != want {
				return 0, errBadFrame
			}
			seenFP = true
		}
		off = end + (4-alen%4)%4 // padded to 4 bytes
		if off > len(pkt) {
			return 0, errBadFrame
		}
	}
	if !seenFP {
		return 0, errBadFrame
	}
	if !seenUser {
		return 0, errNoUsername
	}
	local, _, _ := strings.Cut(string(username), ":")
	k := slotOfUfrag(local)
	if k == 0 {
		return 0, errNoTag
	}

	return k, nil
}

// slotOfUfrag is desk-rtc's SlotOfUfrag (rtcserver/shared.go): "s" and two digits, 01 to 32, then at least one more
// character; anything else names no slot.
func slotOfUfrag(u string) int {
	if len(u) < 4 || u[0] != 's' || u[1] < '0' || u[1] > '9' || u[2] < '0' || u[2] > '9' {
		return 0
	}
	k, err := strconv.Atoi(u[1:3])
	if err != nil || k < 1 || k > maxSlot {
		return 0
	}

	return k
}
