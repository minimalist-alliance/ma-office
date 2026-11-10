// The image check, as the Files app sees it (draft ADR "the Files app", decision 8; Lead decisions, Nov 8). Every image
// added through Files is checked by the platform's shared image-check service as the last step before it reaches the desk.
// The member's file is stored as the ORIGINAL bytes: the check gets its own copy, and what comes back is a verdict and a
// token that binds the SHA-256 of the original to this desk and this member. deskd lets an image into the tree only with
// that token (services/deskd/docs/files.md section 6).
//
// Files never refuses an image for its type or size. A check that can't finish is an `error` the member can retry; nothing
// lands on the drive. The real client is `ImageCheckClient` (`imageCheckClient.ts`); the stub is for the dev build and tests.

/** The words the member reads while an image waits. Never "busy": the line moves, and it is always said as a place in it. */
export const ordinal = (n: number): string => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

export const queuedWords = (position: number): string => `Checking your image: ${ordinal(Math.max(1, Math.round(position)))} in line.`;
export const CHECKING_WORDS = 'Checking your image.';
export const SENDING_WORDS = 'Sending your image to be checked.';

export type CheckEvent =
  /** In line for the guideline check: `position` 1 is next. */
  | { type: 'queued'; position: number; words: string }
  /** Sending, preparing or being looked at right now. */
  | { type: 'checking'; words: string }
  /** It passed (`unchecked`: the checker was offline, which is treated as passed). `token` is for `files.upload.finish`. */
  | { type: 'passed'; token: string; sha256: string; bytes: number; unchecked: boolean; imageId: string }
  /** It broke a guideline (G1 to G6). Nothing lands on the drive. */
  | { type: 'rejected'; code: string; guideline: string; words: string; guidelinesUrl: string }
  /** The check couldn't finish (network, rate limit, a server error). The member can try again; the file isn't added. */
  | { type: 'error'; retryable: boolean; words: string; retryAfterSeconds?: number };

export interface ImageCheck {
  /**
   * Check one image. The events end with `passed`, `rejected` or `error`, and the iterator ends after any of them. Aborting the
   * signal ends it quietly.
   */
  check(file: Blob, deskId: string, signal: AbortSignal): AsyncIterable<CheckEvent>;
  /** The desk has its own copy: the service may drop its. Failing to say so is harmless. */
  settle(imageId: string): Promise<void>;
}

/** A guideline's name in the middle of a sentence: first letter lower case (not an acronym), no closing full stop. */
export const midSentence = (guideline: string): string => {
  const g = guideline.replace(/[.\s]+$/, '');
  return g && !/^[A-Z]{2}/.test(g) ? g.charAt(0).toLowerCase() + g.slice(1) : g;
};

/** The service's own words for a rejection, with the guideline's name (if it appears) put in the same lower-case form. */
export function serviceRejectedWords(message: string, guideline: string): string {
  const g = guideline.replace(/[.\s]+$/, '');
  return g ? message.split(g).join(midSentence(g)) : message;
}

/** The verdict wording for a rejection when the service gave none: the outcome first, then the guideline by code and name. */
export function rejectedWords(code: string, guideline: string): string {
  const name = midSentence(guideline);
  return `This image wasn't added. It goes against guideline ${code}${name ? `: ${name}` : ''}.`;
}
