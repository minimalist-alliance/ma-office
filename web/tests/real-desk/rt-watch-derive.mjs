// From a watch's events to one record per loss of the live session. Pure: no browser, no clock, no I/O,
// so rt-watch-selftest.mjs can run it through a scripted loss. A session is live once its peer connection
// has answered HELLO. A loss starts at the first trouble on that connection and ends with the status online.
const ONLINE = /online/;
const secs = (ms) => (ms === null || ms === undefined ? null : +(ms / 1000).toFixed(3));

export const statusOf = (label) => (label === null ? '(no button)' : String(label).replace(/^.*? desk, \d+ apps, /, ''));

export class LossTracker {
  constructor(deskId, onRecord) {
    this.deskId = deskId;
    this.onRecord = onRecord;
    this.sessionId = null;
    this.livePc = null;
    this.status = '';
    this.opened = 0;
    this.resumed = 0;
    this.loss = null;
    this.seq = 0;
    this.records = [];
  }

  feed(e) {
    const { at, k } = e;
    if (k === 'panel') {
      if (e.desk !== this.deskId) return;
      this.status = statusOf(e.label);
      if (this.loss) this.loss.statuses.push({ at, status: this.status });
      this.settle(at);
    } else if (k === 'ws') {
      this.onFrame(e);
    } else if (k === 'ctl.close') {
      if (e.pc === this.livePc) this.noteClose(at, `ctl CLOSE ${e.code} ${e.reason ?? ''}`.trim());
    } else if (k === 'ctl.hello') {
      this.livePc = e.pc;
      if (this.loss?.closedAt != null) {
        this.loss.helloAt = at;
        this.settle(at);
      }
    } else if (k === 'pc.state') {
      if (e.pc !== this.livePc) return;
      if (e.connection === 'disconnected' || e.connection === 'failed') this.noteTrouble(at, `connection ${e.connection}`);
      else if (e.ice === 'disconnected' || e.ice === 'failed') this.noteTrouble(at, `ice ${e.ice}`);
      else if (e.connection === 'connected' && this.loss && this.loss.closedAt == null) {
        this.loss.connectedAt ??= at;
        this.settle(at);
      }
    } else if (k === 'pc.close') {
      if (e.pc === this.livePc) {
        this.noteClose(at, 'peer connection closed by the app');
        this.livePc = null;
      }
    } else if (k === 'dc.close') {
      if (e.label === 'ctl' && e.pc === this.livePc) this.noteClose(at, 'ctl channel closed');
    } else if (k === 'pc.createOffer') {
      if (e.iceRestart && this.loss) this.loss.restartOffers += 1;
    } else if (k === 'api.req') {
      if (this.loss && e.action === 'connect' && e.desk === this.deskId) this.loss.connects.push({ at, start: e.start });
    } else if (k === 'pageload') {
      if (this.livePc !== null || this.loss) this.noteClose(at, 'page loaded again');
      this.livePc = null;
      this.sessionId = null;
    }
  }

  onFrame(e) {
    const { at, type, session, dir } = e;
    if (dir === '<-' && type === 'session.opened' && e.desk === 'test') {
      if (session && session === this.sessionId) {
        this.resumed += 1; // the gateway reattached the same session: the connection never noticed
        return;
      }
      this.opened += 1;
      this.sessionId = session ?? null;
      if (this.loss) {
        this.loss.opens.push(at);
      }
    } else if (dir === '<-' && type === 'session.closed') {
      if (session === this.sessionId || session === this.loss?.session) this.noteClose(at, `session.closed ${e.reason ?? ''}`.trim());
    } else if (dir === '->' && type === 'session.close') {
      if (session === this.sessionId || session === this.loss?.session) this.noteClose(at, `session.close sent ${e.reason ?? ''}`.trim());
    }
  }

  open(at, what) {
    this.seq += 1;
    this.loss = {
      n: this.seq,
      session: this.sessionId,
      troubleAt: at,
      trouble: what,
      closedAt: null,
      closes: [],
      opens: [],
      helloAt: null,
      connectedAt: null,
      restartOffers: 0,
      connects: [],
      statuses: [],
      statusAtStart: this.status,
    };
  }

  noteTrouble(at, what) {
    if (this.livePc === null && !this.loss) return;
    if (!this.loss) this.open(at, what);
  }

  noteClose(at, what) {
    if (this.livePc === null && !this.loss) return; // a setup that never went live isn't a loss
    if (!this.loss) this.open(at, what);
    this.loss.closedAt ??= at;
    this.loss.closes.push({ at, what });
  }

  settle(at) {
    const l = this.loss;
    if (!l || !ONLINE.test(this.status)) return;
    if (l.closedAt != null) {
      if (l.helloAt !== null) this.finish(at, 'recovered-new-session');
    } else if (l.connectedAt !== null) {
      this.finish(at, 'recovered-in-place');
    }
  }

  finish(at, outcome) {
    const l = this.loss;
    this.loss = null;
    const base = l.closedAt ?? l.troubleAt;
    const record = {
      loss: l.n,
      outcome,
      firstTrouble: l.trouble,
      troubleToCloseS: l.closedAt != null ? secs(l.closedAt - l.troubleAt) : null,
      closeToNextOpenedS: l.opens.length ? secs(l.opens[0] - base) : null,
      closeToWinningOpenedS: l.opens.length ? secs(l.opens.at(-1) - base) : null,
      closeToOnlineS: outcome === 'not-recovered-at-exit' ? null : l.closedAt != null ? secs(at - l.closedAt) : null,
      troubleToOnlineS: outcome === 'not-recovered-at-exit' ? null : secs(at - l.troubleAt),
      elapsedS: secs(at - l.troubleAt),
      sessionOpened: l.opens.length,
      restartOffers: l.restartOffers,
      connects: l.connects.map((c) => `${secs(c.at - l.troubleAt)}s start=${c.start}`),
      closes: l.closes.map((c) => `${secs(c.at - l.troubleAt)}s ${c.what}`),
      statuses: l.statuses.map((s) => `${secs(s.at - l.troubleAt)}s ${s.status}`),
      statusAtStart: l.statusAtStart,
      statusNow: this.status,
    };
    this.records.push(record);
    this.onRecord?.(record);
    return record;
  }

  /** On exit: a loss that hasn't come back still gets a record. */
  finishOpen(at) {
    if (this.loss) this.finish(at, 'not-recovered-at-exit');
  }
}
