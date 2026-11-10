// Runs in the client browser: the media and input half of what the Desk app does (desk-runtime.md
// section 8.5, 8.6). Session setup is the same as ../browser/page.js. Exposes window.D.
window.openDesk = async function openDesk({ api, deskId, tcpOnly }) {
  const KIND = { HELLO: 1, REQ: 7, RES: 8, ERR: 9 };
  const enc = new TextEncoder(), dec = new TextDecoder();
  const frame = (kind, id, payload) => {
    const body = enc.encode(JSON.stringify(payload));
    const buf = new Uint8Array(12 + body.length);
    const v = new DataView(buf.buffer);
    buf[0] = 1; buf[1] = kind; v.setUint32(4, id);
    buf.set(body, 12);
    return buf;
  };
  const parse = (data) => {
    const b = new Uint8Array(data), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { kind: b[1], id: v.getUint32(4), payload: b.subarray(12) };
  };
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  const fp = cert.getFingerprints().find((f) => f.algorithm === 'sha-256').value.toUpperCase();
  const conn = await (await fetch(`${api}/v1/desks/${deskId}/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'owner', start: false, clientDtlsFingerprint: 'sha-256 ' + fp }),
  })).json();
  const ws = new WebSocket(conn.gateway, 'ma.gw.v1');
  const inbox = [], waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  };
  const next = (match) => {
    const i = inbox.findIndex(match);
    return i >= 0 ? Promise.resolve(inbox.splice(i, 1)[0]) : new Promise((resolve) => waiters.push({ match, resolve }));
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('gateway refused')); });
  ws.send(JSON.stringify({ type: 'session.open', id: 'o1', deskId, deskToken: conn.deskToken }));
  const opened = await next((m) => m.type === 'session.opened' || m.type === 'error');
  if (opened.type === 'error') throw new Error(JSON.stringify(opened));

  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [cert] });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const channels = {}, opens = [];
  for (const [label, id, extra] of [['ctl', 0, {}], ['rpc', 1, {}], ['events', 2, {}], ['collab', 3, {}], ['mdoc', 4, {}], ['bulk', 5, {}],
    ['input', 6, { ordered: false, maxRetransmits: 0 }], ['keys', 7, {}]]) {
    const dc = pc.createDataChannel(label, { negotiated: true, id, ...extra });
    dc.binaryType = 'arraybuffer';
    channels[label] = dc;
    opens.push(new Promise((res) => { dc.onopen = res; }));
  }
  const tracks = {};
  const gotTracks = new Promise((res) => {
    pc.ontrack = (e) => {
      tracks[e.track.kind] = e.track;
      if (e.track.kind === 'video') e.receiver.jitterBufferTarget = 0; // design 6.5
      if (tracks.audio && tracks.video) res();
    };
  });
  await pc.setLocalDescription(await pc.createOffer());
  ws.send(JSON.stringify({ type: 'signal', sessionId: opened.sessionId, data: { type: 'offer', sdp: pc.localDescription.sdp } }));
  const sig = await next((m) => m.type === 'signal' || m.type === 'session.closed');
  if (sig.type !== 'signal' || sig.data.type !== 'answer') throw new Error('no answer: ' + JSON.stringify(sig));
  const answer = sig.data.sdp;
  const munge = (sdp) => (tcpOnly ? sdp.split('\r\n').filter((l) => !/^a=candidate:\S+ \d+ udp /i.test(l)).join('\r\n') : sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: munge(answer) });
  await gotTracks;
  const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}: ice ${pc.iceConnectionState}, conn ${pc.connectionState}, offer candidates ${(pc.localDescription.sdp.match(/^a=candidate:.*$/gm) || []).join(' | ')}, answer candidates ${(answer.match(/^a=candidate:.*$/gm) || []).join(' | ')}`)), ms));
  await Promise.race([Promise.all(opens), timeout(20000, 'channels')]);

  const pending = new Map();
  let nextId = 1;
  channels.ctl.onmessage = channels.rpc.onmessage = (e) => {
    const f = parse(e.data), w = pending.get(f.id);
    if (w) { pending.delete(f.id); w(f); }
  };
  const request = (ch, kind, payload) => new Promise((res) => { const id = nextId++; pending.set(id, res); channels[ch].send(frame(kind, id, payload)); });
  const call = async (m, p = {}) => {
    const f = await request('rpc', KIND.REQ, { m, p });
    const body = JSON.parse(dec.decode(f.payload));
    if (f.kind === KIND.ERR) throw new Error(m + ': ' + JSON.stringify(body));
    return body;
  };
  await request('ctl', KIND.HELLO, { deskApi: '1.0', appVersion: 'stream-proof' });

  // Section 8.6.
  let seq = 0;
  const TYPE = { MOVE: 1, BUTTON: 2, WHEEL: 3, KEY: 4, RELEASE_ALL: 5 };
  const ev = (type, f = {}) => {
    const b = new ArrayBuffer(16), v = new DataView(b);
    v.setUint8(0, type); v.setUint8(1, f.down ? 1 : 0); v.setUint8(2, f.button || 0);
    v.setUint32(4, ++seq); v.setUint16(8, f.x || 0); v.setUint16(10, f.y || 0);
    if (type === TYPE.KEY) v.setUint32(12, f.keysym);
    if (type === TYPE.WHEEL) { v.setInt16(12, f.dx || 0); v.setInt16(14, f.dy || 0); }
    if (type === TYPE.MOVE) {
      if (channels.input.bufferedAmount > 0) return; // dropped, never queued
      channels.input.send(b);
    } else channels.keys.send(b);
  };

  // Everything arriving on keys is CURSOR.
  const cursors = [];
  channels.keys.onmessage = (e) => {
    const v = new DataView(e.data);
    cursors.push({ type: v.getUint8(0), hotX: v.getUint16(2), hotY: v.getUint16(4), w: v.getUint16(6), h: v.getUint16(8), png: e.data.byteLength - 10, at: performance.now() });
  };

  const video = document.createElement('video');
  video.playsInline = true; video.autoplay = true;
  video.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;object-fit:contain;background:#000';
  video.srcObject = new MediaStream([tracks.video, tracks.audio]);
  document.body.append(video);

  // Photon probe (design 2.2): a center pixel read off every decoded frame.
  const px = document.createElement('canvas'); px.width = 8; px.height = 8;
  const pctx = px.getContext('2d', { willReadFrequently: true });
  const P = { frames: 0, changed: 0, lastLum: null, arm: null, results: [], firstAfter: null, firstAt: null, lastMedia: -1, repeats: 0 };
  // Frames whose picture actually changed, on a 96x54 thumbnail: decoded fps alone can't tell a repeat from new content.
  const TW = 96, TH = 54;
  const thumb = document.createElement('canvas'); thumb.width = TW; thumb.height = TH;
  const tctx = thumb.getContext('2d', { willReadFrequently: true });
  let prevThumb = null;
  const onFrame = (now, m) => {
    P.frames++;
    if (P.firstAfter !== null && P.firstAt === null) P.firstAt = { now, display: m.expectedDisplayTime };
    if (m.mediaTime === P.lastMedia) P.repeats++;
    P.lastMedia = m.mediaTime;
    tctx.drawImage(video, 0, 0, TW, TH);
    const td = tctx.getImageData(0, 0, TW, TH).data;
    const g = new Uint8Array(TW * TH);
    let diff = 0;
    for (let i = 0, j = 0; i < td.length; i += 4, j++) { g[j] = (td[i] * 3 + td[i + 1] * 6 + td[i + 2]) / 10; if (prevThumb) diff += Math.abs(g[j] - prevThumb[j]); }
    if (prevThumb && diff / (TW * TH) > 0.3) P.changed++;
    prevThumb = g;
    const vw = video.videoWidth, vh = video.videoHeight;
    pctx.drawImage(video, vw / 2 - 4, vh / 2 - 4, 8, 8, 0, 0, 8, 8);
    const d = pctx.getImageData(0, 0, 8, 8).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
    const lum = s / 64;
    if (P.arm && (lum > 128) === P.arm.white) {
      P.results.push({ cb: now - P.arm.t0, display: m.expectedDisplayTime - P.arm.t0, recv: m.receiveTime ? m.receiveTime - P.arm.t0 : null, processing: m.processingDuration ?? null });
      P.arm = null;
    }
    P.lastLum = lum;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  // A real keydown, as the app would see it. The stamp is taken in the listener.
  addEventListener('keydown', (e) => {
    const t0 = performance.now();
    if (P.armed) { P.arm = { t0, white: !(P.lastLum > 128) }; P.armed = false; }
    if (e.key.length === 1 && e.key.charCodeAt(0) < 0x100) ev(TYPE.KEY, { down: true, keysym: e.key.charCodeAt(0) });
    e.preventDefault();
  }, true);
  addEventListener('keyup', (e) => {
    if (e.key.length === 1 && e.key.charCodeAt(0) < 0x100) ev(TYPE.KEY, { down: false, keysym: e.key.charCodeAt(0) });
    e.preventDefault();
  }, true);

  const stats = async () => {
    const out = { t: performance.now(), frames: P.frames, changed: P.changed };
    const s = await pc.getStats();
    const byId = {}; s.forEach((r) => { byId[r.id] = r; });
    s.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        out.video = { framesDecoded: r.framesDecoded, framesDropped: r.framesDropped || 0, framesReceived: r.framesReceived, framesPerSecond: r.framesPerSecond,
          bytes: r.bytesReceived, packetsLost: r.packetsLost, packetsReceived: r.packetsReceived, jitter: r.jitter, totalDecodeTime: r.totalDecodeTime,
          jitterBufferDelay: r.jitterBufferDelay, jitterBufferEmittedCount: r.jitterBufferEmittedCount, w: r.frameWidth, h: r.frameHeight, decoder: r.decoderImplementation,
          codec: byId[r.codecId]?.mimeType, fmtp: byId[r.codecId]?.sdpFmtpLine, freezeCount: r.freezeCount, totalFreezesDuration: r.totalFreezesDuration, nackCount: r.nackCount, pliCount: r.pliCount, firCount: r.firCount,
          keyFramesDecoded: r.keyFramesDecoded, totalProcessingDelay: r.totalProcessingDelay };
      }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audio = { bytes: r.bytesReceived, packetsReceived: r.packetsReceived, concealedSamples: r.concealedSamples, energy: r.totalAudioEnergy, samples: r.totalSamplesReceived, jitterBufferDelay: r.jitterBufferDelay, emitted: r.jitterBufferEmittedCount };
      if (r.type === 'transport' && r.selectedCandidatePairId) {
        const p = byId[r.selectedCandidatePairId];
        out.pair = { rtt: p?.currentRoundTripTime, bytes: p?.bytesReceived, local: byId[p?.localCandidateId]?.protocol };
      }
    });
    return out;
  };

  window.D = { pc, call, ev, TYPE, video, P, cursors, stats, answer, tracks, sessionId: opened.sessionId, channels,
    h264Offered: /^a=rtpmap:\d+ H264\//m.test(pc.localDescription.sdp),
    playoutDelayOffered: pc.localDescription.sdp.includes('playout-delay'), playoutDelayAnswered: answer.includes('playout-delay') };
  return { sessionId: opened.sessionId, sections: answer.split(/\r\n(?=m=)/).slice(1).map((s) => s.split('\r\n').filter((l) => /^m=|^a=(sendonly|inactive|msid)/.test(l))),
    h264Offered: window.D.h264Offered, playoutDelayOffered: window.D.playoutDelayOffered, playoutDelayAnswered: window.D.playoutDelayAnswered };
};
