// Package relay is Commons' listener on a guild desk: deskd's Unix socket, one connection per member session
// (README, "On a guild desk"). Framing as notebook.sock: u32be length of what follows, u8 type, body.
package relay

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/ident"
)

// Frame types.
const (
	JSON byte = 0x01 // a JSON object with a "t"
	Link byte = 0x02 // one whole room-link message
)

// MaxFrame is the most a frame may hold after its length: 4 MiB of room link and room for the rest.
const MaxFrame = 4<<20 + 64<<10

// DeskdUID is deskd's uid on a desk (user desk).
const DeskdUID = 1100

var (
	ErrTooBig   = errors.New("relay: frame too big")
	ErrNotHello = errors.New("relay: the first frame isn't a hello")
)

// Hello is deskd's first frame on a connection.
type Hello struct {
	T         string       `json:"t"`
	SessionID string       `json:"sessionId"`
	Sub       string       `json:"sub"`
	Caller    ident.Caller `json:"caller"`
	// Limits is optional: deskd may pass the roster's settings here. Commons takes maxCommonsChannels from it.
	Limits *struct {
		MaxCommonsChannels int `json:"maxCommonsChannels"`
	} `json:"limits,omitempty"`
}

// Listener accepts deskd's connections on the socket.
type Listener struct {
	ln   *net.UnixListener
	path string
	uid  int
}

// Listen opens the socket at path, mode 0660, replacing a stale one. Only peers with uid may stay connected.
func Listen(path string, uid int) (*Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSocket != 0 {
		_ = os.Remove(path)
	}
	old := syscall.Umask(0o117)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	ln.SetUnlinkOnClose(true)
	return &Listener{ln: ln, path: path, uid: uid}, nil
}

// Path is the socket's path.
func (l *Listener) Path() string { return l.path }

// Close stops listening and removes the socket.
func (l *Listener) Close() error { return l.ln.Close() }

// Accept returns the next connection from the allowed uid. Others are closed and logged.
func (l *Listener) Accept() (*Conn, error) {
	for {
		c, err := l.ln.AcceptUnix()
		if err != nil {
			return nil, err
		}
		uid, err := peerUID(c)
		if err != nil || uid != l.uid {
			log.Printf("relay: refused a connection from uid %d (want %d)", uid, l.uid)
			c.Close()
			continue
		}
		return &Conn{c: c, r: bufio.NewReaderSize(c, 64<<10)}, nil
	}
}

func peerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var cerr error
	if err := raw.Control(func(fd uintptr) {
		var cred *syscall.Ucred
		cred, cerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if cerr == nil {
			uid = int(cred.Uid)
		}
	}); err != nil {
		return -1, err
	}
	return uid, cerr
}

// Conn is one member session's connection from deskd.
type Conn struct {
	c   *net.UnixConn
	r   *bufio.Reader
	wmu sync.Mutex
	hdr [5]byte
}

// Dial connects to a relay socket, as deskd does (the -dev harness and tests).
func Dial(path string) (*Conn, error) {
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	return &Conn{c: c, r: bufio.NewReaderSize(c, 64<<10)}, nil
}

// ReadFrame reads one frame.
func (c *Conn) ReadFrame() (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(c.r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[:4])
	if n < 1 || n > MaxFrame {
		return 0, nil, ErrTooBig
	}
	body := make([]byte, n-1)
	if _, err := io.ReadFull(c.r, body); err != nil {
		return 0, nil, err
	}
	return h[4], body, nil
}

// WriteFrame writes one frame whole, within timeout (0: no limit). Safe for concurrent use.
func (c *Conn) WriteFrame(typ byte, body []byte, timeout time.Duration) error {
	if len(body)+1 > MaxFrame {
		return ErrTooBig
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	deadline := time.Time{}
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	_ = c.c.SetWriteDeadline(deadline)
	binary.BigEndian.PutUint32(c.hdr[:4], uint32(len(body)+1))
	c.hdr[4] = typ
	bufs := net.Buffers{c.hdr[:], body}
	_, err := bufs.WriteTo(c.c)
	return err
}

// WriteJSON writes a JSON frame.
func (c *Conn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteFrame(JSON, b, 10*time.Second)
}

// ReadHello reads the first frame, which must be a hello from a guild member.
func (c *Conn) ReadHello(timeout time.Duration) (Hello, ident.Identity, error) {
	_ = c.c.SetReadDeadline(time.Now().Add(timeout))
	defer c.c.SetReadDeadline(time.Time{})
	typ, body, err := c.ReadFrame()
	if err != nil {
		return Hello{}, ident.Identity{}, err
	}
	var h Hello
	if typ != JSON || json.Unmarshal(body, &h) != nil || h.T != "hello" {
		return Hello{}, ident.Identity{}, ErrNotHello
	}
	id, err := h.Caller.Identity()
	if err != nil {
		return Hello{}, ident.Identity{}, err
	}
	if h.Sub != "" && h.Sub != id.MemberID {
		return Hello{}, ident.Identity{}, fmt.Errorf("relay: sub %q isn't the caller's member id", h.Sub)
	}
	return h, id, nil
}

// Close closes the connection.
func (c *Conn) Close() error { return c.c.Close() }
