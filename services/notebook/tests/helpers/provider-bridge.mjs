// Real @hocuspocus/provider clients for deskd's RealDeskNotebookCollabIT, over stdin and stdout: the test carries their
// bytes through deskd's real relay on `collab`, and desk-notebook behind it is the real service. One JSON object a line.
//
// In:  {op:'in', b64}       one BIN DATA from deskd, whole
//      {op:'reset'}         deskd's {"t":"reset"}
//      {op:'open', page}    a provider on that page, on the one transport
//      {op:'type', i, text} a paragraph at the end of provider i's page
//      {op:'destroy', i}    provider i goes, as a page the app closes
//      {op:'fresh'}         every provider and the transport go, and a new transport takes their place, as the
//                           release check's read-back does, all on the one session
//      {op:'state'}
// Out: {op:'out', b64}      one message of the virtual socket, for a BIN DATA
//      {op:'opened', i} and {op:'state', ...}
//
// The virtual socket is the app's (web/src/notebook/collabSocket.ts): it opens on a microtask, and a reset or a send with
// no socket fires `close` on the next one. The transport's settings are the app's too, but for the reconnect delay
// (BRIDGE_RECONNECT_MS, the app's 1 s by default).
import readline from 'node:readline';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const reconnectMs = Number(process.env.BRIDGE_RECONNECT_MS ?? 1000);

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
// Libraries' console output goes to stderr, so stdout carries only the protocol.
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => process.stderr.write(`bridge ${k}: ${a.map(String).join(' ')}\n`);

let current = null;
let resets = 0;
let sockets = 0;
let dropped = 0;

class RelaySocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = 2;
  static CLOSED = CLOSED;
  binaryType = 'arraybuffer';
  identifier = 0;
  readyState = CONNECTING;
  listeners = new Map();

  constructor() {
    sockets += 1;
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      current = this;
      this.dispatch('open', { type: 'open' });
    });
  }

  addEventListener(name, fn) {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }

  send(data) {
    if (this.readyState !== OPEN) {
      this.finish(1006, 'no_session');
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    send({ op: 'out', b64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') });
  }

  close() {
    this.finish(1000, 'closed');
  }

  finish(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (current === this) current = null;
    queueMicrotask(() => this.dispatch('close', { code, reason }));
  }

  dispatch(name, event) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn(event);
  }
}

const newTransport = () =>
  new HocuspocusProviderWebsocket({
    url: 'ws://desk-notebook.invalid',
    WebSocketPolyfill: RelaySocket,
    maxAttempts: 0,
    messageReconnectTimeout: 24 * 60 * 60 * 1000,
    delay: reconnectMs,
    minDelay: reconnectMs,
  });
let transport = newTransport();

const providers = [];

function textOf(doc) {
  const out = [];
  const walk = (n) => {
    if (n instanceof Y.XmlText) out.push(n.toString());
    else if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
  };
  walk(doc.getXmlFragment('default'));
  return out.join('\n');
}

const ops = {
  in({ b64 }) {
    const bytes = Buffer.from(b64, 'base64');
    if (current?.readyState === OPEN) current.dispatch('message', { data: new Uint8Array(bytes).buffer });
    else dropped += 1;
  },
  reset() {
    resets += 1;
    current?.finish(1012, 'reset');
  },
  open({ page }) {
    const doc = new Y.Doc();
    const entry = { page, doc, closes: [], provider: null, gone: false };
    entry.provider = new HocuspocusProvider({
      name: page,
      document: doc,
      token: 'desk',
      websocketProvider: transport,
      awareness: null,
      onClose: ({ event }) => entry.closes.push(event?.reason ?? null),
    });
    entry.provider.attach();
    send({ op: 'opened', i: providers.push(entry) - 1 });
  },
  type({ i, text }) {
    const { doc } = providers[i];
    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      paragraph.insert(0, [t]);
      const fragment = doc.getXmlFragment('default');
      fragment.insert(fragment.length, [paragraph]);
    });
    send({ op: 'typed', i });
  },
  destroy({ i }) {
    providers[i].gone = true;
    providers[i].provider.destroy();
    send({ op: 'destroyed', i });
  },
  fresh() {
    for (const x of providers) {
      if (x.gone) continue;
      x.gone = true;
      x.provider.destroy();
    }
    transport.destroy();
    current?.close();
    transport = newTransport();
    send({ op: 'freshed' });
  },
  state() {
    send({
      op: 'state',
      socket: current?.readyState ?? null,
      transport: transport.status,
      resets,
      sockets,
      dropped,
      pages: providers.map((x, i) => ({
        i,
        page: x.page,
        gone: x.gone,
        synced: x.provider.isSynced,
        unsynced: x.provider.unsyncedChanges,
        closes: x.closes,
        text: textOf(x.doc),
      })),
    });
  },
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  ops[m.op](m);
});
process.stdin.on('end', () => process.exit(0));
