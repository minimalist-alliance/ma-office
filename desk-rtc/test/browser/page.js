// Runs in the browser. This is the Desk app's session setup (design 4.2.1, 4.2.2) with no framework.
// Exposes runScenario(options) and returns everything it saw, for check.mjs to judge.
window.runScenario = async function runScenario({ api, deskId, tcpOnly, badCnf, restart, bulkBytes, noH264, holdIdleMs, vanish }) {
  const out = { steps: [] };
  const step = (s) => out.steps.push(s);
  const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms));
  const withTimeout = (p, ms, what) => Promise.race([p, timeout(ms, what)]);

  const KIND = { HELLO: 1, PING: 4, PONG: 5, REQ: 7, RES: 8, ERR: 9, CHUNK: 15 };
  const FLAG_BIN = 2, FLAG_END = 4;
  const enc = new TextEncoder(), dec = new TextDecoder();
  function frame(kind, id, payload, flags = 0, seq = 0) {
    const body = payload instanceof Uint8Array ? payload : enc.encode(JSON.stringify(payload));
    const buf = new Uint8Array(12 + body.length);
    const v = new DataView(buf.buffer);
    buf[0] = 1; buf[1] = kind; buf[2] = flags;
    v.setUint32(4, id); v.setUint32(8, seq);
    buf.set(body, 12);
    return buf;
  }
  function parse(data) {
    const b = new Uint8Array(data), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { kind: b[1], flags: b[2], id: v.getUint32(4), seq: v.getUint32(8), payload: b.subarray(12) };
  }
  const hexBytes = (s) => s.replace(/:/g, '').toLowerCase();

  // 1. Certificate and connect.
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  let fp = cert.getFingerprints().find((f) => f.algorithm === 'sha-256').value.toUpperCase();
  if (badCnf) fp = fp.split(':').map((x) => (x === '00' ? '01' : '00')).join(':');
  const connectResp = await fetch(`${api}/v1/desks/${deskId}/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'owner', start: false, clientDtlsFingerprint: 'sha-256 ' + fp }),
  });
  const conn = await connectResp.json();
  out.connect = { status: connectResp.status, phase: conn.phase, identity: conn.deskIdentity };
  step('connect');

  // 2. Gateway.
  const ws = new WebSocket(conn.gateway, 'ma.gw.v1');
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  const nextMsg = (match, what) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return withTimeout(new Promise((resolve) => waiters.push({ match, resolve })), 15000, what);
  };
  await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('gateway refused')); }), 5000, 'ws open');
  out.subprotocol = ws.protocol;
  step('gateway');

  ws.send(JSON.stringify({ type: 'session.open', id: 'o1', deskId, deskToken: conn.deskToken }));
  const opened = await nextMsg((m) => m.type === 'session.opened' || m.type === 'error', 'session.opened');
  if (opened.type === 'error') { out.openError = opened; return out; }
  const sessionId = opened.sessionId;
  out.sessionId = sessionId;
  out.iceServers = opened.iceServers;
  out.iceServersExpireAt = opened.iceServersExpireAt;
  step('session.opened');

  // 3. PeerConnection: audio, video, data, in that order.
  const pc = new RTCPeerConnection({ iceServers: opened.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [cert] });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const video = pc.addTransceiver('video', { direction: 'recvonly' });
  // A browser build without H.264 offers exactly this.
  if (noH264) video.setCodecPreferences(RTCRtpReceiver.getCapabilities('video').codecs.filter((c) => !/h264/i.test(c.mimeType)));
  const defs = [
    ['ctl', 0, {}], ['rpc', 1, {}], ['events', 2, {}], ['collab', 3, {}], ['mdoc', 4, {}], ['bulk', 5, {}],
    ['input', 6, { ordered: false, maxRetransmits: 0 }], ['keys', 7, {}],
  ];
  const channels = {};
  const opens = [];
  for (const [label, id, extra] of defs) {
    const dc = pc.createDataChannel(label, { negotiated: true, id, ...extra });
    dc.binaryType = 'arraybuffer';
    channels[label] = dc;
    opens.push(new Promise((res) => { dc.onopen = res; }));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const offerSdp = pc.localDescription.sdp;
  out.offer = {
    bytes: offerSdp.length,
    fingerprintLines: (offerSdp.match(/^a=fingerprint:/gm) || []).length,
    sectionOrder: (offerSdp.match(/^m=\w+/gm) || []).map((s) => s.slice(2)),
    hasH264: /^a=rtpmap:\d+ H264\//m.test(offerSdp),
    candidates: (offerSdp.match(/^a=candidate:/gm) || []).length,
  };
  const signalFrame = JSON.stringify({ type: 'signal', sessionId, data: { type: 'offer', sdp: offerSdp } });
  out.offer.signalFrameBytes = signalFrame.length;
  ws.send(signalFrame);
  step('offer sent');

  // 4. The answer, or a refusal.
  const sig = await nextMsg((m) => m.type === 'signal' || m.type === 'session.closed', 'answer');
  if (sig.type === 'session.closed') { out.closedEarly = sig.reason; return out; }
  if (sig.data.type !== 'answer') {
    out.refusal = sig.data;
    const closed = await nextMsg((m) => m.type === 'session.closed', 'session.closed');
    out.closedReason = closed.reason;
    return out;
  }
  const answerSdp = sig.data.sdp;
  const sections = answerSdp.split(/\r\n(?=m=)/);
  out.answer = {
    iceLite: /^a=ice-lite/m.test(answerSdp),
    bundle: (answerSdp.match(/^a=group:BUNDLE.*$/m) || [''])[0],
    candidates: (answerSdp.match(/^a=candidate:.*$/gm) || []),
    fingerprints: (answerSdp.match(/^a=fingerprint:.*$/gm) || []),
    audio: sections[1].split('\r\n').filter((l) => /^m=|^a=(inactive|sendonly|recvonly|sendrecv|mid)/.test(l)),
    video: sections[2].split('\r\n').filter((l) => /^m=|^a=(inactive|sendonly|recvonly|sendrecv|mid)/.test(l)),
    data: sections[3].split('\r\n').filter((l) => /^m=|^a=(mid|max-message-size)/.test(l)),
  };
  out.answer.fingerprintOk = out.answer.fingerprints.length > 0 && out.answer.fingerprints.every((l) =>
    conn.deskIdentity.fingerprintsSha256.includes(hexBytes(l.replace('a=fingerprint:sha-256 ', ''))));

  const munge = (sdp) => (tcpOnly ? sdp.split('\r\n').filter((l) => !/^a=candidate:\S+ \d+ udp /i.test(l)).join('\r\n') : sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: munge(answerSdp) });
  step('answer applied');

  await withTimeout(Promise.all(opens), 20000, `channels (ice ${pc.iceConnectionState}, conn ${pc.connectionState})`);
  step('channels open');

  // 5. Protocol.
  const pending = new Map();
  let nextId = 1;
  let bulkBytesIn = 0;
  let bulkEnd;
  const bulkDone = new Promise((res) => { bulkEnd = res; });
  const onFrame = (e) => {
    const f = parse(e.data);
    if (f.kind === KIND.CHUNK) {
      bulkBytesIn += f.payload.length;
      if (f.flags & FLAG_END) bulkEnd();
      return;
    }
    const w = pending.get(f.id);
    if (w) { pending.delete(f.id); w(f); }
  };
  channels.ctl.onmessage = onFrame;
  channels.rpc.onmessage = onFrame;
  channels.bulk.onmessage = onFrame;
  const request = (ch, kind, payload) => {
    const id = nextId++;
    const p = withTimeout(new Promise((res) => pending.set(id, res)), 10000, 'reply on ' + ch);
    channels[ch].send(frame(kind, id, payload));
    return p;
  };
  const call = async (m, p = {}) => {
    const f = await request('rpc', KIND.REQ, { m, p });
    const body = JSON.parse(dec.decode(f.payload));
    if (f.kind === KIND.ERR) throw new Error('RPC ' + m + ': ' + JSON.stringify(body));
    return body;
  };
  const pingMs = async () => { const t = performance.now(); await request('ctl', KIND.PING, {}); return performance.now() - t; };
  const summary = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: +s[s.length >> 1].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1) }; };

  const hello = await request('ctl', KIND.HELLO, { deskApi: '1.0', appVersion: 'browser-check' });
  out.hello = JSON.parse(dec.decode(hello.payload));
  const t0 = performance.now();
  out.status = await call('desk.status.get');
  out.statusRttMs = +(performance.now() - t0).toFixed(1);
  step('status');

  async function selectedPair() {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
    return { local: { protocol: local.protocol, type: local.candidateType, tcpType: local.tcpType },
             remote: { protocol: remote.protocol, type: remote.candidateType, address: remote.address, port: remote.port, tcpType: remote.tcpType },
             rttMs: pair.currentRoundTripTime === undefined ? null : pair.currentRoundTripTime * 1000 };
  }
  out.pair = await selectedPair();
  out.states = { ice: pc.iceConnectionState, conn: pc.connectionState, dtls: pc.sctp.transport.state, sctpMaxMessage: pc.sctp.maxMessageSize };
  out.transceivers = pc.getTransceivers().map((t) => ({ mid: t.mid, kind: t.receiver.track.kind, direction: t.direction, current: t.currentDirection }));

  // A session with no traffic of its own stays up on the browser's ICE consent checks alone.
  if (holdIdleMs) {
    await new Promise((r) => setTimeout(r, holdIdleMs));
    out.afterHold = { conn: pc.connectionState, ice: pc.iceConnectionState };
    out.afterHoldStatus = (await call('desk.status.get')).deskId;
    step('held idle');
  }
  // The tab goes away without saying anything. check.mjs closes the page.
  if (vanish) return out;

  // 6. ctl while idle, then during a download, then during an upload.
  const idle = [];
  for (let i = 0; i < 20; i++) { idle.push(await pingMs()); await new Promise((r) => setTimeout(r, 20)); }
  out.ctlIdleMs = summary(idle);

  await call('test.bulk.download', { bytes: bulkBytes });
  const busy = [];
  const tBulk = performance.now();
  let bulkFinished = false;
  bulkDone.then(() => { bulkFinished = true; });
  while (!bulkFinished && performance.now() - tBulk < 25000) { busy.push(await pingMs()); await new Promise((r) => setTimeout(r, 20)); }
  await withTimeout(bulkDone, 5000, 'end of the download');
  const bulkSecs = (performance.now() - tBulk) / 1000;
  out.download = { bytes: bulkBytesIn, want: bulkBytes, mbit: +((bulkBytesIn * 8) / bulkSecs / 1e6).toFixed(1), ctlMs: busy.length ? summary(busy) : null };
  step('download');

  const bulk = channels.bulk;
  bulk.bufferedAmountLowThreshold = 32 * 1024;
  const chunk = new Uint8Array(16 * 1024 - 12);
  const tUp = performance.now();
  const before = (await call('test.counters')).bulkIn;
  const upBusy = [];
  let sent = 0, seq = 0, upDone = false;
  const uploading = (async () => {
    while (sent < bulkBytes) {
      if (bulk.bufferedAmount >= 64 * 1024) { await new Promise((res) => { bulk.onbufferedamountlow = res; }); continue; }
      bulk.send(frame(KIND.CHUNK, 2, chunk, FLAG_BIN, seq++));
      sent += chunk.length;
    }
    upDone = true;
  })();
  while (!upDone && performance.now() - tUp < 25000) { upBusy.push(await pingMs()); await new Promise((r) => setTimeout(r, 20)); }
  await uploading;
  let c = await call('test.counters');
  const deadline = performance.now() + 10000;
  while (c.bulkIn - before < sent + seq * 12 && performance.now() < deadline) { await new Promise((r) => setTimeout(r, 50)); c = await call('test.counters'); }
  const upSecs = (performance.now() - tUp) / 1000;
  out.upload = { bytes: c.bulkIn - before, want: sent + seq * 12, mbit: +(((c.bulkIn - before) * 8) / upSecs / 1e6).toFixed(1), ctlMs: upBusy.length ? summary(upBusy) : null };
  step('upload');

  // 7. input and keys reach desk-rtc and stop there.
  const event = (type) => { const b = new Uint8Array(16); b[0] = type; b[7] = 1; return b; };
  channels.input.send(new Uint8Array([1, 2, 3])); // malformed: dropped and counted
  channels.keys.send(new Uint8Array([4, 5, 6]));
  channels.input.send(event(1)); // MOVE
  channels.keys.send(event(5)); // RELEASE_ALL
  await new Promise((r) => setTimeout(r, 200));
  const stats = await call('test.rtc.stats');
  const counters = await call('test.counters');
  out.deskStats = stats.sessions.find((s) => s.sessionId === sessionId);
  out.inputActivity = counters.inputActivity;
  out.deskSideTransport = counters.transport;

  // 8. ICE restart on the same PeerConnection.
  if (restart) {
    pc.restartIce();
    const re = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(re);
    ws.send(JSON.stringify({ type: 'signal', sessionId, data: { type: 'offer', sdp: pc.localDescription.sdp, restart: true } }));
    const again = await nextMsg((m) => m.type === 'signal', 'restart answer');
    const ufragOf = (s) => s.match(/^a=ice-ufrag:(.*)$/m)[1];
    out.restart = { newCredentials: ufragOf(again.data.sdp) !== ufragOf(answerSdp), candidates: (again.data.sdp.match(/^a=candidate:/gm) || []).length };
    await pc.setRemoteDescription({ type: 'answer', sdp: munge(again.data.sdp) });
    const t = performance.now();
    while (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed' && performance.now() - t < 10000) await new Promise((r) => setTimeout(r, 50));
    out.restart.iceState = pc.iceConnectionState;
    out.restart.status = (await call('desk.status.get')).deskId;
    out.restart.channelStillOpen = channels.ctl.readyState === 'open';
    out.restart.pair = await selectedPair();
    step('ice restart');
  }

  // 9. Close through the gateway.
  ws.send(JSON.stringify({ type: 'session.close', sessionId, reason: 'closed_by_client' }));
  const closed = await nextMsg((m) => m.type === 'session.closed', 'session.closed');
  out.closedReason = closed.reason;
  pc.close();
  ws.close();
  step('closed');
  return out;
};
