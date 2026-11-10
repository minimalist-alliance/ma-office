// Package xext sets up XFIXES on an xgb connection in a way that's safe with more than one connection in the
// process.
//
// xfixes.Init writes xgb's process-wide event and error tables on every call, without a lock, and every
// connection's reader looks events and errors up in those same tables. With two connections, one dialing while
// the other receives an event is a concurrent map read and write, which Go treats as fatal: it would take
// desk-rtc and every session down. So only the first connection writes them.
package xext

import (
	"errors"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

const xfixesName = "XFIXES"

var (
	mu         sync.Mutex
	firstEvent = -1
	firstError = -1
)

// InitXFixes does what xfixes.Init does. Use it in place of xfixes.Init everywhere in this module.
//
// The tables only need writing when the numbers change, and those belong to the X server, so that's the first
// connection in the process. A later X server of the same build gives the same numbers. Each connection comes
// through here before it creates a window or selects anything, so the first write can't race an event it asked
// for, nor an error.
//
// It can race a MappingNotify, though: the server sends one to every client when the keymap changes, with nothing
// selected, so a connection still setting up can be reading one while this writes. On a desk that's safe, because
// desk-xorg-ready runs setxkbmap before rtc gets X access, so the keymap is settled before desk-rtc connects. After
// that only desk-rtc's own injector remaps keys, and only once its own setup is past here, by when they're written.
func InitXFixes(c *xgb.Conn) error {
	reply, err := xproto.QueryExtension(c, uint16(len(xfixesName)), xfixesName).Reply()
	if err != nil {
		return err
	}
	if reply == nil || !reply.Present {
		return errors.New("the X server has no XFIXES")
	}
	c.ExtLock.Lock()
	c.Extensions[xfixesName] = reply.MajorOpcode
	c.ExtLock.Unlock()

	mu.Lock()
	defer mu.Unlock()
	if firstEvent == int(reply.FirstEvent) && firstError == int(reply.FirstError) {
		return nil
	}
	for n, f := range xgb.NewExtEventFuncs[xfixesName] {
		xgb.NewEventFuncs[int(reply.FirstEvent)+n] = f
	}
	for n, f := range xgb.NewExtErrorFuncs[xfixesName] {
		xgb.NewErrorFuncs[int(reply.FirstError)+n] = f
	}
	firstEvent, firstError = int(reply.FirstEvent), int(reply.FirstError)

	return nil
}
