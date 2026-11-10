// Voice: one WebRTC connection to the guild server. The first audio line carries this member's
// microphone and the first voice they hear; the rest only receive. The server deals the room's
// talkers into those lines (server/internal/voice), so nothing renegotiates when people come and go.
// Audio only: no camera is ever asked for, and the server's media engine has no video codec.

/** `blocked`: no connection within BLOCKED_MS, or ICE failed before it ever connected: the member's network lets
 *  nothing through to the guild desk's voice ports, not even through 443. `failed`: a connection that worked, lost. */
export type VoiceState = 'off' | 'connecting' | 'on' | 'listening' | 'failed' | 'blocked';

/** How long voice may take to connect before Commons says the network blocks it. */
export const BLOCKED_MS = 8000;

export interface VoiceHost {
  send(msg: object): void;
  state(s: VoiceState, detail?: string): void;
  /** This member's own level, 0 to 1, about ten times a second while unmuted. */
  level(v: number): void;
}

export class Voice {
  private pc: RTCPeerConnection | null = null;
  private mic: MediaStreamTrack | null = null;
  private first: RTCRtpTransceiver | null = null;
  private players = new Map<string, HTMLAudioElement>();
  private ctx: AudioContext | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private muted = false;
  private gen = 0;
  private giveUp: ReturnType<typeof setTimeout> | null = null;
  /** Slot index → mid, from the server's answer. */
  mids: string[] = [];
  /** Slot index → member index, -1 for none. */
  slots: number[] = [];

  constructor(
    private readonly host: VoiceHost,
    private readonly slotCount: number,
  ) {}

  get hasMic(): boolean {
    return this.mic !== null;
  }

  /** Starts voice. Asks for the microphone first; without it, the member can still listen. */
  async start(muted: boolean): Promise<void> {
    const gen = ++this.gen;
    this.muted = muted;
    this.host.state('connecting');
    if (!this.mic) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        this.mic = stream.getAudioTracks()[0] ?? null;
      } catch {
        this.mic = null;
      }
      if (gen !== this.gen) {
        this.mic?.stop();
        this.mic = null;
        return;
      }
    }
    this.connect(gen);
    this.startMeter();
  }

  private connect(gen: number): void {
    this.pc?.close();
    // No ICE servers: the guild desk answers with its own candidates, direct UDP first, then UDP and TCP on 443 through
    // desk-rtc. If none of them works within BLOCKED_MS, the member's network blocks voice here.
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    let connected = false;
    this.clearGiveUp();
    this.giveUp = setTimeout(() => {
      this.giveUp = null;
      if (gen === this.gen && !connected) this.host.state('blocked');
    }, BLOCKED_MS);
    this.pc = pc;
    const n = Math.max(1, this.slotCount);
    this.first = pc.addTransceiver(this.mic ?? 'audio', { direction: this.mic ? 'sendrecv' : 'recvonly' });
    if (this.mic && this.muted) void this.first.sender.replaceTrack(null);
    for (let i = 1; i < n; i++) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      const mid = e.transceiver.mid ?? '';
      let el = this.players.get(mid);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        this.players.set(mid, el);
      }
      el.srcObject = new MediaStream([e.track]);
      void el.play().catch(() => {});
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && gen === this.gen) this.host.send({ t: 'rtc-ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.gen) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        connected = true;
        this.clearGiveUp();
        this.host.state(this.mic ? 'on' : 'listening');
      } else if (s === 'failed') {
        this.clearGiveUp();
        this.host.state(connected ? 'failed' : 'blocked');
      }
    };
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (gen === this.gen) this.host.send({ t: 'rtc-offer', sdp: pc.localDescription?.sdp ?? offer.sdp });
    })();
  }

  async answer(sdp: string, mids: string[]): Promise<void> {
    this.mids = mids;
    await this.pc?.setRemoteDescription({ type: 'answer', sdp });
  }

  async ice(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc?.addIceCandidate(c);
    } catch {
      // A candidate for an old connection.
    }
  }

  private clearGiveUp(): void {
    if (this.giveUp) clearTimeout(this.giveUp);
    this.giveUp = null;
  }

  /** The server lost the connection: make a new one, keeping the microphone. */
  restart(): void {
    if (!this.pc) return;
    this.host.state('connecting');
    this.connect(++this.gen);
  }

  setSlots(s: number[]): void {
    this.slots = s;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.mic) this.mic.enabled = !m;
    if (this.first && this.mic) void this.first.sender.replaceTrack(m ? null : this.mic);
  }

  private startMeter(): void {
    if (this.meter || !this.mic) return;
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(new MediaStream([this.mic]));
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      this.meter = setInterval(() => {
        if (this.muted) return this.host.level(0);
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        // RMS to a 0..1 level: -60 dBFS is 0, -10 dBFS is 1.
        const db = 10 * Math.log10(sum / buf.length + 1e-12);
        this.host.level(Math.max(0, Math.min(1, (db + 60) / 50)));
      }, 100);
    } catch {
      this.ctx = null;
    }
  }

  /** Inbound audio stats per slot, for tests and the load page. */
  async stats(): Promise<{ mid: string; packets: number; bytes: number; jitterBufferMs: number }[]> {
    const out: { mid: string; packets: number; bytes: number; jitterBufferMs: number }[] = [];
    const rep = await this.pc?.getStats();
    rep?.forEach((r: RTCStats & Record<string, unknown>) => {
      if (r.type === 'inbound-rtp' && r['kind'] === 'audio') {
        const emitted = Number(r['jitterBufferEmittedCount'] ?? 0);
        out.push({
          mid: String(r['mid'] ?? ''),
          packets: Number(r['packetsReceived'] ?? 0),
          bytes: Number(r['bytesReceived'] ?? 0),
          jitterBufferMs: emitted ? (Number(r['jitterBufferDelay'] ?? 0) / emitted) * 1000 : 0,
        });
      }
    });
    return out;
  }

  /** The remote audio track in a slot, for tests. */
  trackFor(slot: number): MediaStreamTrack | null {
    const mid = this.mids[slot];
    const t = this.pc?.getTransceivers().find((x) => x.mid === mid);
    return t?.receiver.track ?? null;
  }

  stop(): void {
    this.gen++;
    this.clearGiveUp();
    this.pc?.close();
    this.pc = null;
    this.first = null;
    for (const el of this.players.values()) {
      el.srcObject = null;
    }
    this.players.clear();
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    void this.ctx?.close();
    this.ctx = null;
    this.mic?.stop();
    this.mic = null;
    this.slots = [];
    this.mids = [];
    this.host.state('off');
  }
}
