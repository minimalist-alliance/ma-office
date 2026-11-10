// Is the desk playing sound? (task 22, ADR 0038). A hidden tab keeps its desk's stream live while it is, so music
// doesn't cut out after 5 minutes (`browser/driver.ts`), and the 60-minute hidden rule waits for it (`idle.ts`).
// The 24-hour no-input rule doesn't.
//
// The sound itself is heard where the picture hold already listens: the audio receiver's `getStats`, with the same
// threshold (`rtc/pictureHold.ts`). A session says how long it's been silent; this keeps the answer across sessions,
// so a reconnect in a hidden tab isn't taken for the music stopping. It only knows what it's asked, so ask the old
// session before letting it go.
import type { BrowserMedia } from './deskLink';

/**
 * Silent this long, the sound has stopped: a hidden tab's stream goes `warm`, and the 60-minute rule applies again.
 * Longer than any gap between tracks or a player's countdown to the next one. A still page costs about as much
 * picture as its sound while it waits (`image/recipe/desk-stream/stream.conf`).
 */
export const SOUND_QUIET_MS = 60_000;

export class LastSound {
  private at = -Infinity;

  /** `quietMs`: longer for a caller that asks less often than a session could be replaced, as the idle rule does. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly quietMs = SOUND_QUIET_MS,
  ) {}

  /** Milliseconds until the sound counts as stopped, 0 once it has. `media` is the session now, if there is one. */
  left(media: BrowserMedia | null | undefined): number {
    const now = this.now();
    const silent = media?.silentFor?.();
    if (silent !== undefined && silent < Infinity) this.at = Math.max(this.at, now - silent);
    return Math.max(0, this.at + this.quietMs - now);
  }

  playing(media: BrowserMedia | null | undefined): boolean {
    return this.left(media) > 0;
  }
}
