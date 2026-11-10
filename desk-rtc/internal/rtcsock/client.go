package rtcsock

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Client is the deskd side of rtc.sock, for fake-deskd and tests. It tracks the credit desk-rtc
// grants, so SendData blocks instead of overrunning a channel.
type Client struct {
	conn net.Conn

	wmu sync.Mutex

	mu      sync.Mutex
	cond    *sync.Cond
	credits map[creditKey]int64
	closed  bool
	// initial is what each channel starts with: InitialCredit, or a Guild Desk's configured credit (SetInitialCredit).
	initial int64
}

type creditKey struct {
	handle  uint32
	channel uint8
}

// Dial connects to rtc.sock.
func Dial(ctx context.Context, path string) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	c := &Client{conn: conn, credits: map[creditKey]int64{}, initial: InitialCredit}
	c.cond = sync.NewCond(&c.mu)

	return c, nil
}

// Close ends the connection. desk-rtc closes every session when it sees this.
func (c *Client) Close() error {
	c.mu.Lock()
	c.closed = true
	c.cond.Broadcast()
	c.mu.Unlock()

	return c.conn.Close()
}

func (c *Client) write(b []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err := c.conn.Write(b)

	return err
}

// RawWrite writes bytes as they are, for tests of how desk-rtc treats a misbehaving client.
func (c *Client) RawWrite(b []byte) error { return c.write(b) }

// Send writes one JSON message.
func (c *Client) Send(m *Message) error {
	b, err := EncodeJSON(m)
	if err != nil {
		return err
	}

	return c.write(b)
}

// Grant gives desk-rtc credit for n more bytes on a channel.
func (c *Client) Grant(handle uint32, channel uint8, n uint32) error {
	return c.write(EncodeCredit(handle, channel, n))
}

// SendData writes one frame, waiting for credit first. It returns an error once ctx ends.
func (c *Client) SendData(ctx context.Context, handle uint32, channel uint8, frame []byte) error {
	if len(frame) > MaxFrame {
		return fmt.Errorf("rtcsock: frame of %d bytes", len(frame))
	}
	stop := context.AfterFunc(ctx, func() {
		c.mu.Lock()
		c.cond.Broadcast()
		c.mu.Unlock()
	})
	defer stop()

	key := creditKey{handle, channel}
	c.mu.Lock()
	for c.available(key) < int64(len(frame)) {
		if c.closed {
			c.mu.Unlock()

			return net.ErrClosed
		}
		if err := ctx.Err(); err != nil {
			c.mu.Unlock()

			return err
		}
		c.cond.Wait()
	}
	c.credits[key] = c.available(key) - int64(len(frame))
	c.mu.Unlock()

	return c.write(EncodeData(handle, channel, frame))
}

func (c *Client) available(key creditKey) int64 {
	if v, ok := c.credits[key]; ok {
		return v
	}

	return c.initial
}

// SetInitialCredit sets what each new channel starts with, as a Guild Desk's configured says (desk-rtc README, "Guild
// mode"). Call it before the first session.
func (c *Client) SetInitialCredit(n int64) {
	c.mu.Lock()
	c.initial = n
	c.mu.Unlock()
}

// Run reads until the connection ends. Callbacks run on the read goroutine and must not block.
func (c *Client) Run(onJSON func(*Message), onData func(handle uint32, channel uint8, frame []byte)) error {
	r := bufio.NewReaderSize(c.conn, 128*1024)
	for {
		typ, body, err := ReadEnvelope(r)
		if err != nil {
			c.mu.Lock()
			c.closed = true
			c.cond.Broadcast()
			c.mu.Unlock()

			return err
		}
		switch typ {
		case TypeJSON:
			var m Message
			if err := json.Unmarshal(body, &m); err != nil {
				return fmt.Errorf("rtcsock: bad JSON: %w", err)
			}
			onJSON(&m)
		case TypeData:
			handle, ch, frame, err := ParseData(body)
			if err != nil {
				return err
			}
			onData(handle, ch, frame)
		case TypeCredit:
			handle, ch, n, err := ParseCredit(body)
			if err != nil {
				return err
			}
			key := creditKey{handle, ch}
			c.mu.Lock()
			c.credits[key] = c.available(key) + int64(n)
			c.cond.Broadcast()
			c.mu.Unlock()
		default:
			return errors.New("rtcsock: unknown envelope type")
		}
	}
}

// DialRetry keeps dialing until it connects or ctx ends.
func DialRetry(ctx context.Context, path string) (*Client, error) {
	delay := 100 * time.Millisecond
	for {
		c, err := Dial(ctx, path)
		if err == nil {
			return c, nil
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(delay):
		}
		if delay < 2*time.Second {
			delay *= 2
		}
	}
}
