// The real `ImageCheck`: the platform's shared image-check service (ma-platform `docs/contracts/image-check.md`, sections 1 to
// 4), used by the Files app for feature `files`. The member's browser PUTs a copy of the image to the service (the service
// strips, downscales and converts it on its side), polls its place in line every 2 seconds, and on `ok` or `unchecked` asks
// for the verdict token (`POST /v1/image-check/{imageId}/token {deskId}`) that binds the SHA-256 of the exact bytes to this
// desk and this member. The desk gets the ORIGINAL bytes and the token; deskd checks the token against the platform's JWKS.
//
// The token route is the platform's to add (Lead decision 4, Nov 8). Until it exists the call answers 404 and the member sees
// an error they can retry: nothing is added to the drive without a verdict, as designed.
//
// Files never refuses an image for its type or size (Lead decision 3): nothing here looks at either. The contract's `failed`
// reasons are only said back in plain words.
import { sniffFile } from '../apps/files/sniff';
import type { api as ApiFn, ApiError } from './api';
import { CHECKING_WORDS, queuedWords, rejectedWords, serviceRejectedWords, SENDING_WORDS, type CheckEvent, type ImageCheck } from './imageCheck';

const POLL_MS = 2000;

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
};

interface Created {
  imageId: string;
  upload: { method: string; url: string; headers?: Record<string, string> };
  statusUrl: string;
}

interface Status {
  state: string;
  place?: number;
  message?: string;
  code?: string;
  guideline?: string;
  guidelinesUrl?: string;
  reason?: string;
}

const FAILED_WORDS: Record<string, string> = {
  too_large: "That image is too large for the check just now. We're working on it. Nothing was added.",
  bad_type: "The check can't read that kind of image yet. We're working on it. Nothing was added.",
  undecodable: "We couldn't read that image to check it. It may be damaged. Nothing was added.",
  too_small: "That image is too small to check. Nothing was added.",
  too_many_pixels: "That image is too large for the check just now. We're working on it. Nothing was added.",
  animated: "The check can't read animated images yet. We're working on it. Nothing was added.",
  unavailable: "We couldn't check your image just now. Nothing was added. Try again in a moment.",
};

const TRY_AGAIN = "We couldn't check your image just now. Nothing was added. Try again in a moment.";

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (window.clearTimeout(t), resolve()), { once: true });
  });

function errorEvent(err: unknown): CheckEvent {
  // An `ApiError` (`platform/api.ts`), told by its name so this module imports nothing that module's group would drag in.
  if (err instanceof Error && err.name === 'ApiError') {
    const e = err as ApiError;
    if (e.status === 429) {
      const wait = typeof e.details?.['retryAfterSeconds'] === 'number' ? (e.details['retryAfterSeconds'] as number) : e.retryAfterSec;
      const when = wait ? (wait >= 3600 ? 'in about an hour' : wait >= 120 ? `in ${Math.ceil(wait / 60)} minutes` : 'in a minute') : 'later';
      return { type: 'error', retryable: true, words: `You've sent a lot of images to be checked. Try again ${when}. Nothing was added.`, ...(wait ? { retryAfterSeconds: wait } : {}) };
    }
    if (e.status === 403) return { type: 'error', retryable: false, words: "Image uploads aren't available for your account right now. Nothing was added." };
    return { type: 'error', retryable: e.retryable || e.status === 404, words: TRY_AGAIN };
  }
  return { type: 'error', retryable: true, words: TRY_AGAIN };
}

/** `platform/api.ts`'s `api`, handed in by the shell: this module is part of a lazy chunk and imports nothing that would change how the bundle splits. */
export type ApiCall = typeof ApiFn;

export class ImageCheckClient implements ImageCheck {
  constructor(private readonly api: ApiCall) {}

  async *check(file: Blob, deskId: string, signal: AbortSignal): AsyncGenerator<CheckEvent> {
    try {
      yield { type: 'checking', words: SENDING_WORDS };
      const sniffed = await sniffFile(file);
      const contentType = (sniffed.kind === 'image' && MIME[sniffed.format]) || 'image/jpeg';
      const created = (await this.api<Created>('/v1/image-check/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'files', contentType, bytes: file.size, context: {} }), signal })).data;
      if (!created) throw new Error('no answer');
      const put = await fetch(created.upload.url, { method: created.upload.method || 'PUT', headers: created.upload.headers ?? {}, body: file, signal });
      if (!put.ok) throw new Error(`upload ${put.status}`);
      let last = '';
      for (;;) {
        if (signal.aborted) return;
        const status = (await this.api<Status>(created.statusUrl, { signal })).data;
        if (!status) throw new Error('no answer');
        switch (status.state) {
          case 'uploading':
          case 'processing':
            if (last !== status.state) yield { type: 'checking', words: CHECKING_WORDS };
            break;
          case 'checking':
            yield { type: 'queued', position: Math.max(1, status.place ?? 1), words: queuedWords(Math.max(1, status.place ?? 1)) };
            break;
          case 'ok':
          case 'unchecked':
          case 'not_image': {
            const t = (await this.api<{ token: string; sha256: string; bytes: number }>(`/v1/image-check/${encodeURIComponent(created.imageId)}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deskId }), signal })).data;
            if (!t) throw new Error('no token');
            yield { type: 'passed', token: t.token, sha256: t.sha256, bytes: t.bytes, unchecked: status.state !== 'ok', imageId: created.imageId };
            return;
          }
          case 'rejected': {
            const code = status.code ?? 'G?';
            const guideline = status.guideline ?? '';
            yield { type: 'rejected', code, guideline, words: status.message ? serviceRejectedWords(status.message, guideline) : rejectedWords(code, guideline), guidelinesUrl: status.guidelinesUrl ?? '' };
            return;
          }
          case 'failed': {
            const reason = status.reason ?? 'unavailable';
            yield { type: 'error', retryable: reason === 'unavailable', words: FAILED_WORDS[reason] ?? TRY_AGAIN };
            return;
          }
          default:
            break;
        }
        last = status.state;
        await sleep(POLL_MS, signal);
      }
    } catch (err) {
      if (signal.aborted) return;
      yield errorEvent(err);
    }
  }

  async settle(imageId: string): Promise<void> {
    await this.api(`/v1/image-check/${encodeURIComponent(imageId)}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/** Which check the Files app uses: the real client, except in the dev server and the test harness (the mock link), where the stub is. */
export async function chooseImageCheck(api: ApiCall): Promise<ImageCheck> {
  if (import.meta.env.MODE !== 'production' && new URLSearchParams(window.location.search).get('link') !== 'real') {
    const { StubImageCheck, newStubControl } = await import('./stubImageCheck');
    // One control for the page, so a test steers the same stub every window uses.
    const w = window as unknown as { __maImageStub?: ReturnType<typeof newStubControl> };
    w.__maImageStub ??= newStubControl();
    return new StubImageCheck(w.__maImageStub);
  }
  return new ImageCheckClient(api);
}
