package fakedesk

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
)

// RealHelper runs the real desk-data for each request, as desk-data.socket does: one process per connection,
// with the connection on stdin. Runner is rehearsal/helper-run.py, which runs the helper's own code with Root as
// /data and this user as deskd, and leaves its log of requests in Logs. Tests only, never on a desk.
type RealHelper struct {
	Python, Runner, Program, Root, Logs string
}

// exchange sends one request and returns everything the helper sent back. A helper that couldn't run sends nothing.
func (h *RealHelper) exchange(req map[string]any) []byte {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil
	}
	ours, theirs := os.NewFile(uintptr(fds[0]), "deskd's end"), os.NewFile(uintptr(fds[1]), "desk-data's end")
	defer ours.Close()
	cmd := exec.Command(h.Python, "-I", h.Runner, h.Program, h.Root, h.Logs)
	cmd.Stdin = theirs
	err = cmd.Start()
	_ = theirs.Close()
	if err != nil {
		return nil
	}
	defer func() { _ = cmd.Wait() }()
	line, err := json.Marshal(req)
	if err != nil {
		return nil
	}
	if _, err := ours.Write(append(line, '\n')); err != nil {
		return nil
	}
	raw, _ := io.ReadAll(ours)

	return raw
}

// code is the RPC error deskd answers for a helper's reply that isn't ok (DataMethods.toRpc).
func code(helperCode string) string {
	switch helperCode {
	case "not_found", "invalid", "bad_request":
		return helperCode
	default:
		return "unavailable"
	}
}

// Manifest answers one page, unchanged, or the RPC error it comes to.
func (h *RealHelper) Manifest(part string, cursor *string) (json.RawMessage, string) {
	req := map[string]any{"v": 1, "op": "manifest", "part": fsname.Name(part), "limit": 2000}
	if cursor != nil {
		req["cursor"] = fsname.Name(*cursor) // as deskd sends it: a byte that isn't UTF-8 as \udcXX
	}
	line, _, ok := bytes.Cut(h.exchange(req), []byte("\n"))
	if !ok {
		return nil, "unavailable"
	}
	var head struct {
		OK   bool   `json:"ok"`
		Code string `json:"code"`
	}
	if json.Unmarshal(line, &head) != nil {
		return nil, "unavailable"
	}
	if !head.OK {
		return nil, code(head.Code)
	}

	return line, ""
}

// Read answers one read, or the RPC error it comes to. A body that stops short gives no trailer, which deskd
// turns into an END with an empty payload.
func (h *RealHelper) Read(part, rel string, offset int64) (body, string) {
	req := map[string]any{"v": 1, "op": "read", "part": fsname.Name(part), "path": fsname.Name(rel), "offset": offset}
	line, rest, ok := bytes.Cut(h.exchange(req), []byte("\n"))
	if !ok {
		return body{}, "unavailable"
	}
	var head struct {
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Size    int64  `json:"size"`
		MtimeMs int64  `json:"mtimeMs"`
	}
	if json.Unmarshal(line, &head) != nil {
		return body{}, "unavailable"
	}
	if !head.OK {
		return body{}, code(head.Code)
	}
	b := body{size: head.Size, mtimeMs: head.MtimeMs, sent: []byte{}, trailer: []byte{}}
	for len(rest) >= 4 {
		n := binary.BigEndian.Uint32(rest)
		rest = rest[4:]
		if n == 0 {
			if len(rest) == 40 {
				b.trailer = rest
			}

			return b, ""
		}
		if uint64(len(rest)) < uint64(n) {
			break
		}
		b.sent = append(b.sent, rest[:n]...)
		rest = rest[n:]
	}

	return b, ""
}
