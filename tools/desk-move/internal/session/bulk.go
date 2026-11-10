package session

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/frame"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fsname"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/rtcsock"
)

// InitialWindow is the credit data.read grants by itself (draft ADR, section 7).
const InitialWindow = 1 << 20

// Chunk is one CHUNK frame of a transfer. The END chunk carries the trailer, not file bytes.
type Chunk struct {
	Seq  uint32
	Data []byte
	End  bool
}

type chunkQueue struct {
	mu     sync.Mutex
	items  []Chunk
	err    error
	signal chan struct{}
}

func newChunkQueue() *chunkQueue { return &chunkQueue{signal: make(chan struct{}, 1)} }

func (q *chunkQueue) push(c Chunk) {
	q.mu.Lock()
	q.items = append(q.items, c)
	q.mu.Unlock()
	q.wake()
}

func (q *chunkQueue) fail(err error) {
	q.mu.Lock()
	if q.err == nil {
		q.err = err
	}
	q.mu.Unlock()
	q.wake()
}

func (q *chunkQueue) wake() {
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *chunkQueue) pop(ctx context.Context) (Chunk, error) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			c := q.items[0]
			q.items[0] = Chunk{}
			q.items = q.items[1:]
			q.mu.Unlock()

			return c, nil
		}
		err := q.err
		q.mu.Unlock()
		if err != nil {
			return Chunk{}, err
		}
		select {
		case <-q.signal:
		case <-ctx.Done():
			return Chunk{}, ctx.Err()
		}
	}
}

// Transfer is one data.read: its CHUNK frames arrive on bulk with id = ID.
type Transfer struct {
	ID      uint32
	Size    int64
	MtimeMs int64

	s    *Session
	q    *chunkQueue
	once sync.Once
}

type readReply struct {
	TransferID uint32 `json:"transferId"`
	Size       int64  `json:"size"`
	MtimeMs    int64  `json:"mtimeMs"`
}

// Read starts data.read of one file from offset. Chunks that arrived before the reply are kept. part and path are
// bytes, as the manifest gave them: a name that isn't UTF-8 goes as desk-data listed it (fsname).
func (s *Session) Read(ctx context.Context, part, path string, offset int64) (*Transfer, error) {
	var r readReply
	params := map[string]any{"part": fsname.Name(part), "path": fsname.Name(path), "offset": offset}
	if err := s.Call(ctx, "data.read", params, &r); err != nil {
		return nil, err
	}
	if r.TransferID == 0 && r.Size == 0 && r.MtimeMs == 0 {
		return nil, errors.New("data.read: empty reply")
	}
	t := &Transfer{ID: r.TransferID, Size: r.Size, MtimeMs: r.MtimeMs, s: s}
	s.mu.Lock()
	if s.Err() != nil {
		s.mu.Unlock()

		return nil, s.err
	}
	if q := s.orphans[r.TransferID]; q != nil {
		delete(s.orphans, r.TransferID)
		q.mu.Lock()
		for _, c := range q.items {
			s.orphanN -= len(c.Data)
		}
		q.mu.Unlock()
		t.q = q
	} else {
		t.q = newChunkQueue()
	}
	s.xfers[r.TransferID] = t
	s.mu.Unlock()

	return t, nil
}

// Next returns the next chunk, in order. It fails once the session ends.
func (t *Transfer) Next(ctx context.Context) (Chunk, error) { return t.q.pop(ctx) }

// Grant sends CREDIT for n more bytes.
func (t *Transfer) Grant(n int64) error {
	if n <= 0 {
		return nil
	}
	if err := t.s.Err(); err != nil {
		return err
	}
	if err := t.s.t.Send(rtcsock.ChBulk, frame.EncodeCredit(t.ID, n)); err != nil {
		return fmt.Errorf("%w: %v", ErrDisconnected, err)
	}

	return nil
}

// Finish forgets the transfer after its END chunk.
func (t *Transfer) Finish() {
	t.once.Do(func() {
		t.s.mu.Lock()
		delete(t.s.xfers, t.ID)
		t.s.finished[t.ID] = true
		t.s.mu.Unlock()
	})
}

// Stop ends the transfer early with data.read.stop, then forgets it.
func (t *Transfer) Stop(ctx context.Context) error {
	t.Finish()
	if t.s.Err() != nil {
		return nil
	}

	return t.s.Call(ctx, "data.read.stop", map[string]any{"transferId": t.ID}, nil)
}
