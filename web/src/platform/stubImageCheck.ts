// A stand-in for the image check: dev build (`npm run dev`) and tests only. It plays the queue (3rd, 2nd, 1st), then checking,
// then passed with the token `stub.<sha256>` that only a deskd started with `DESKD_FILES_IMAGE_GATE=stub` accepts (the test
// rig and test desks, never a release image). It has switches to reject (G2), to fail, and to stand in the line. A build that
// carries it must not reach a member: `chooseImageCheck` picks the real client unless `import.meta.env.DEV` or a test says so.
import { CHECKING_WORDS, queuedWords, rejectedWords, SENDING_WORDS, type CheckEvent, type ImageCheck } from './imageCheck';

export interface StubControl {
  /** The place the first image takes in line. 0 skips the queue. */
  startPlace: number;
  /** Each step of the line takes this long. */
  stepMs: number;
  /** The next image breaks guideline `code`. Cleared once used. */
  rejectNext: string | null;
  /** The next image ends in an error. Cleared once used. */
  failNext: { retryable: boolean } | null;
  /** The next image comes back `unchecked`, as when the checker is offline. */
  uncheckedNext: boolean;
  /** Every image checked, in order: its size and the desk. */
  checked: { bytes: number; deskId: string }[];
  /** `settle` calls. */
  settled: string[];
}

export const newStubControl = (): StubControl => ({ startPlace: 3, stepMs: 400, rejectNext: null, failNext: null, uncheckedNext: false, checked: [], settled: [] });

const GUIDELINES: Record<string, string> = {
  G1: 'Nothing illegal',
  G2: 'No hate or harassment',
  G3: 'Nothing sexually explicit',
  G4: 'No graphic violence or threats',
  G5: 'No private information',
  G6: 'No spam or selling',
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (window.clearTimeout(t), resolve()), { once: true });
  });

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class StubImageCheck implements ImageCheck {
  constructor(readonly control: StubControl = newStubControl()) {}

  async *check(file: Blob, deskId: string, signal: AbortSignal): AsyncGenerator<CheckEvent> {
    const c = this.control;
    c.checked.push({ bytes: file.size, deskId });
    yield { type: 'checking', words: SENDING_WORDS };
    await sleep(c.stepMs / 2, signal);
    if (signal.aborted) return;
    const fail = c.failNext;
    if (fail) {
      c.failNext = null;
      yield { type: 'error', retryable: fail.retryable, words: "We couldn't check your image just now. Nothing was added. Try again in a moment." };
      return;
    }
    for (let place = c.startPlace; place >= 1; place -= 1) {
      yield { type: 'queued', position: place, words: queuedWords(place) };
      await sleep(c.stepMs, signal);
      if (signal.aborted) return;
    }
    yield { type: 'checking', words: CHECKING_WORDS };
    await sleep(c.stepMs, signal);
    if (signal.aborted) return;
    const reject = c.rejectNext;
    if (reject) {
      c.rejectNext = null;
      const guideline = GUIDELINES[reject] ?? '';
      yield { type: 'rejected', code: reject, guideline, words: rejectedWords(reject, guideline), guidelinesUrl: 'https://minimalistalliance.com/guidelines' };
      return;
    }
    const sha256 = await sha256Hex(file);
    const unchecked = c.uncheckedNext;
    c.uncheckedNext = false;
    yield { type: 'passed', token: `stub.${sha256}`, sha256, bytes: file.size, unchecked, imageId: `im_stub_${c.checked.length}` };
  }

  settle(imageId: string): Promise<void> {
    this.control.settled.push(imageId);
    return Promise.resolve();
  }
}
