// A test's `desk-stream` (docs/interfaces/desk-runtime.md 8.2): real H.264 and Opus from ffmpeg, as RTP over
// RFC 4571 on the stream socket. It follows `resume` and `pause` as the real one does, so what reaches the
// page has come through the real desk-rtc. Keyframes come every second rather than on `keyframe`.
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect, type Socket } from 'node:net';

// A smaller desk's size, so the real path proves nothing assumes 1080p or 16:9.
const SIZE = '1280x800';
const FPS = 30;

export class FakeDeskStream {
  /** Every line desk-rtc has sent. */
  readonly commands: string[] = [];
  /** The same lines, with when each came and on which connection (1 for the first). `level …` is only recorded. */
  readonly lines: { line: string; at: number; conn: number }[] = [];
  /** Connections made so far: desk-rtc's `level` comes first on each (stream-quality.md section 4). */
  conns = 0;
  /** RTP packets sent, by kind. */
  sent = { video: 0, audio: 0 };
  /** The desk's sound off: Opus packets still go, carrying silence, as `desk-stream` sends from a quiet null sink. */
  silent = false;
  private sending = false;
  private conn: Socket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private readonly udp: UdpSocket[] = [];
  private stopped = false;

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    const video = await this.bind('video');
    const audio = await this.bind('audio');
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=${FPS}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-map', '0:v', '-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-g', String(FPS), '-b:v', '2M', '-bsf:v', 'dump_extra=freq=keyframe', '-payload_type', '96', '-f', 'rtp', `rtp://127.0.0.1:${video}?pkt_size=1200`,
      '-map', '1:a', '-c:a', 'libopus', '-b:a', '64k', '-ac', '2', '-payload_type', '111', '-f', 'rtp', `rtp://127.0.0.1:${audio}?pkt_size=1200`,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    this.dial();
  }

  private bind(kind: 'video' | 'audio'): Promise<number> {
    const udp = createSocket('udp4');
    this.udp.push(udp);
    udp.on('message', (sent) => {
      if (!this.sending || !this.conn) return;
      const packet = kind === 'audio' && this.silent ? silence(sent) : sent;
      const framed = Buffer.alloc(2 + packet.length);
      framed.writeUInt16BE(packet.length, 0);
      packet.copy(framed, 2);
      this.conn.write(framed);
      this.sent[kind] += 1;
    });
    return new Promise((done) => {
      udp.bind(0, '127.0.0.1', () => done(udp.address().port));
    });
  }

  /** As systemd restarts the real one: a dropped connection dials again, paused. */
  private dial(): void {
    if (this.stopped) return;
    this.sending = false;
    const conn = connect(this.socketPath);
    this.conn = conn;
    let rest = '';
    let n = 0;
    conn.on('connect', () => (n = ++this.conns));
    conn.on('data', (d) => {
      rest += d.toString();
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        this.commands.push(line);
        this.lines.push({ line, at: Date.now(), conn: n });
        if (line === 'resume') this.sending = true;
        if (line === 'pause') this.sending = false;
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => {
      if (this.conn === conn) this.conn = null;
      setTimeout(() => this.dial(), 200);
    });
  }

  stop(): void {
    this.stopped = true;
    this.ffmpeg?.kill('SIGKILL');
    this.conn?.destroy();
    for (const u of this.udp) u.close();
  }
}

/** The same RTP packet carrying one Opus frame of digital silence: TOC 0xF8 is CELT, fullband, 20 ms, as libopus sends here. */
function silence(packet: Buffer): Buffer {
  const first = packet[0] ?? 0;
  let header = 12 + 4 * (first & 0x0f);
  if (first & 0x10) header += 4 + 4 * packet.readUInt16BE(header + 2);
  return Buffer.concat([packet.subarray(0, header), Buffer.from([0xf8, 0xff, 0xfe])]);
}
