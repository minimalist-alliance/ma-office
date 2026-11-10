// The room client's board sync against a small in-memory stand-in for the server's rules
// (server/internal/room): a seq per update, entries to the others, an ack to the sender, the log
// replayed on hello, and compaction by a client's snapshot.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { CommonsLink, LinkState } from '../../src/net/link.ts';
import { REC, boardPrefix, ctrl, decodeCtrl, eachRecord, readBoardId, readU32, record, u32 } from '../../src/net/protocol.ts';
import { RoomClient } from '../../src/room/client.ts';
import { itemsOf, putItem } from '../../src/board/model.ts';
import { LOCAL } from '../../src/room/client.ts';

const BOARD = 'b1';

class FakeServer {
  log: { seq: number; data: Uint8Array }[] = [];
  seq = 0;
  links = new Set<FakeLink>();
  snapshots = 0;

  hello(l: FakeLink): void {
    l.deliver(ctrl({ t: 'welcome', v: 2, you: { i: l.idx, id: `gm-${l.idx}`, name: 'x', role: 'member', color: 0, ch: 'main', in: true, muted: false }, members: [], ch: 'main', channels: [{ id: 'main', name: 'Main', main: true, created: 0, last: 0 }], boards: { list: [{ id: BOARD, name: '', created: 0, updated: 0, empty: true, bytes: 0 }], active: BOARD }, slots: 0 }));
    for (const e of this.log) l.deliver(record(REC.boardEntry, boardPrefix(BOARD), u32(e.seq), e.data));
    l.deliver(ctrl({ t: 'board-ready', id: BOARD, seq: this.seq }));
  }

  receive(l: FakeLink, msg: Uint8Array): void {
    eachRecord(msg, (t, p) => {
      if (t === REC.ctrl) {
        const m = decodeCtrl(p);
        if (m.t === 'hello') this.hello(l);
      } else if (t === REC.boardUpdate) {
        const { rest } = readBoardId(p);
        const ref = readU32(rest);
        const data = rest.slice(4);
        const seq = ++this.seq;
        this.log.push({ seq, data });
        for (const o of this.links) if (o !== l && o.state === 'open') o.deliver(record(REC.boardEntry, boardPrefix(BOARD), u32(seq), data));
        l.deliver(record(REC.boardAck, boardPrefix(BOARD), u32(seq), u32(ref)));
      } else if (t === REC.boardSnapshot) {
        const { rest } = readBoardId(p);
        const upto = readU32(rest);
        this.log = [{ seq: upto, data: rest.slice(4) }, ...this.log.filter((e) => e.seq > upto)];
        this.snapshots++;
      }
    });
  }

  compact(l: FakeLink): void {
    l.deliver(ctrl({ t: 'compact', id: BOARD }));
  }
}

let nextIdx = 1;
class FakeLink implements CommonsLink {
  state: LinkState = 'connecting';
  buffered = 0;
  idx = nextIdx++;
  onOpen = (): void => {};
  onMessage: (msg: Uint8Array) => void = () => {};
  onClose = (): void => {};
  constructor(private readonly server: FakeServer) {}
  open(): void {
    this.server.links.add(this);
    this.state = 'open';
    this.onOpen();
  }
  drop(): void {
    this.state = 'closed';
    this.server.links.delete(this);
    this.onClose();
  }
  deliver(msg: Uint8Array): void {
    if (this.state === 'open') this.onMessage(msg);
  }
  send(msg: Uint8Array): void {
    if (this.state === 'open') this.server.receive(this, msg);
  }
  close(): void {
    this.drop();
  }
}

function client(server: FakeServer): { c: RoomClient; link: FakeLink } {
  const link = new FakeLink(server);
  const c = new RoomClient(link, { name: 'x' });
  link.open();
  return { c, link };
}

function draw(c: RoomClient, n: number): void {
  c.doc!.transact(() => {
    for (let i = 0; i < n; i++) putItem(c.doc!, { k: 'r', x: i, y: i, w: 10, h: 10, c: 'ink', s: 1, z: i });
  }, LOCAL);
}

const ids = (c: RoomClient) => [...itemsOf(c.doc!).keys()].sort();

describe('board sync', () => {
  it('two members converge, and the server marks each edit saved', () => {
    const s = new FakeServer();
    const a = client(s);
    const b = client(s);
    draw(a.c, 2);
    draw(b.c, 3);
    expect(ids(a.c)).toEqual(ids(b.c));
    expect(ids(a.c)).toHaveLength(5);
    expect(a.c.state.saved).toBe(true);
    expect(s.seq).toBe(2);
  });

  it('a newcomer gets the whole board from the log', () => {
    const s = new FakeServer();
    const a = client(s);
    draw(a.c, 4);
    const late = client(s);
    expect(ids(late.c)).toEqual(ids(a.c));
  });

  it('edits made while the link is down go once it is back, after the server’s copy', () => {
    const s = new FakeServer();
    const a = client(s);
    const b = client(s);
    draw(a.c, 1);
    a.link.drop();
    draw(a.c, 2); // offline
    expect(a.c.state.saved).toBe(false);
    draw(b.c, 1); // meanwhile, someone else
    a.link.open();
    expect(a.c.state.saved).toBe(true);
    expect(ids(a.c)).toEqual(ids(b.c));
    expect(ids(a.c)).toHaveLength(4);
  });

  it('compaction keeps every item: snapshot plus tail rebuild the same board', () => {
    const s = new FakeServer();
    const a = client(s);
    const b = client(s);
    for (let i = 0; i < 20; i++) draw(i % 2 ? a.c : b.c, 1);
    // Delete one, then compact from a, then keep drawing.
    a.c.doc!.transact(() => itemsOf(a.c.doc!).delete(ids(a.c)[0]!), LOCAL);
    s.compact(a.link);
    expect(s.snapshots).toBe(1);
    expect(s.log.length).toBe(1);
    draw(b.c, 2);
    const fresh = new Y.Doc();
    for (const e of s.log) Y.applyUpdate(fresh, e.data);
    expect([...itemsOf(fresh).keys()].sort()).toEqual(ids(a.c));
    expect(ids(a.c)).toHaveLength(21);
    const late = client(s);
    expect(ids(late.c)).toEqual(ids(b.c));
  });
});
