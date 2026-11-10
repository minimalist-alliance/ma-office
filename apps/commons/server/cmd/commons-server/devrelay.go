package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/relay"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/room"
)

// devChannel is a stand-in for deskd's relay, for -dev only: the page's WebSocket at /dev/channel plays the guild
// desk's `commons` data channel, and this plays deskd. It connects to Commons' relay socket as deskd does, sends the
// hello with a caller made from the URL (?name=, member=, role=, grants=, badge=), and passes room-link messages both
// ways, one WebSocket message per DATA. When Commons closes the connection it sends the page {"t":"reset"} as text, and
// the page's next message opens a new one with a new hello, as deskd does.
//
// Test hooks, as text from the page: {"t":"caller", "role", "grants", "name", "badge"} sends a caller frame, as a
// token refresh would; {"t":"drop"} closes the connection, as a removal would.
func devChannel(socket string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		id := room.DevIdentity(q.Get("name"), q.Get("member"), q.Get("role"), q.Get("grants"), q.Get("badge"))
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ws.SetReadLimit(relay.MaxFrame)
		defer ws.CloseNow()
		ctx := r.Context()
		caller := map[string]any{"kind": "guild_member", "memberId": id.MemberID, "role": id.Role, "grants": orEmpty(id.Grants),
			"name": id.Name, "badge": nilIfEmpty(id.Badge), "teen": false}

		var mu sync.Mutex
		var rc *relay.Conn
		connect := func() (*relay.Conn, error) {
			mu.Lock()
			defer mu.Unlock()
			if rc != nil {
				return rc, nil
			}
			c, err := relay.Dial(socket)
			if err != nil {
				return nil, err
			}
			if err := c.WriteJSON(map[string]any{"t": "hello", "sessionId": "cs-dev", "sub": id.MemberID, "caller": caller}); err != nil {
				c.Close()
				return nil, err
			}
			rc = c
			go func() {
				for {
					typ, body, err := c.ReadFrame()
					if err != nil {
						break
					}
					if typ == relay.Link {
						wctx, cancel := context.WithTimeout(ctx, 30e9)
						err = ws.Write(wctx, websocket.MessageBinary, body)
						cancel()
						if err != nil {
							break
						}
					}
				}
				c.Close()
				mu.Lock()
				if rc == c {
					rc = nil
				}
				mu.Unlock()
				_ = ws.Write(ctx, websocket.MessageText, []byte(`{"t":"reset"}`))
			}()
			return c, nil
		}
		for {
			typ, msg, err := ws.Read(ctx)
			if err != nil {
				break
			}
			if typ == websocket.MessageText {
				var hook map[string]any
				if json.Unmarshal(msg, &hook) != nil {
					continue
				}
				mu.Lock()
				c := rc
				mu.Unlock()
				switch hook["t"] {
				case "caller":
					for _, k := range []string{"role", "grants", "name", "badge"} {
						if v, ok := hook[k]; ok {
							caller[k] = v
						}
					}
					if c != nil {
						_ = c.WriteJSON(map[string]any{"t": "caller", "caller": caller})
					}
				case "drop":
					if c != nil {
						c.Close()
					}
				}
				continue
			}
			c, err := connect()
			if err != nil {
				log.Printf("dev channel: %v", err)
				break
			}
			if err := c.WriteFrame(relay.Link, msg, 0); err != nil {
				c.Close()
			}
		}
		mu.Lock()
		if rc != nil {
			rc.Close()
		}
		mu.Unlock()
	}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
