// The member's avatar (task 45): initials on their tint, and their tier's badge as option 1's corner seal, cut out of
// the circle so it reads on any surface. Sizes, colors and marks are the Product Designer's spec: colors are tokens
// (`avatar`, `seal`), the marks are the spec's own SVG files in `assets/badges/`, and every size is in `app.css`.
// The avatar is a picture of what's said beside it or by its control, so it's hidden from screen readers, and its
// initials are drawn by CSS from `data-initials`, so they aren't text a control's name must contain (WCAG 2.5.3 counts
// visible text, aria-hidden or not). `title` is its tooltip. No tier name is drawn into it, ever.
// A new picture or built avatar comes in place: the one drawn stays until the new one is decoded (`avatarSwap.ts`).
import { useEffect, useState } from 'react';
import type { BadgeId } from '../platform/tiers';
import { hueOf, initialsOf } from './avatar';
import { builtAvatarSrc, cachedBuiltSrc } from './avatarKit';
import { decode, isDecoded, nextDrawn } from './avatarSwap';
import { Icon } from './icons';

/** 32 is the account button's avatar, which fills its round button (38 px, 36 in short-viewport mode); 40 the menu's. */
export type AvatarSize = 32 | 40;

/**
 * The kit's artwork each size takes. The built art is framed a little closer than the kit draws it (`.avatar-built` in
 * `app.css`, 1.14 times), so the button's face is drawn at the 40 px art's own scale and both take the full artwork:
 * one image for the button and the menu, decoded once.
 */
const ART: Record<AvatarSize, number> = { 32: 40, 40: 40 };

export interface AvatarProps {
  /** The member's id, which picks the tint. */
  userId: string;
  displayName?: string | null | undefined;
  email?: string | null | undefined;
  /** The seal to show, or null: none for `alliance`, for a membership that isn't live. This file is the one place the seal is drawn: swap the owner's new symbol here. */
  badge: BadgeId | null;
  size: AvatarSize;
  /** The tooltip, "Dana Example, Officer". */
  title?: string | undefined;
  /** The member's checked picture (`pictureOf(me)`), over the initials. A picture that fails to load is the initials again. */
  picture?: string | null | undefined;
  /** The member's built avatar (`builtRecipeOf(me)`), drawn by the lazy kit over the initials; the initials while it loads or if it fails. A `picture` wins. */
  built?: Record<string, unknown> | null | undefined;
}

export function Avatar({ userId, displayName, email, badge, size, title, picture, built }: AvatarProps) {
  const initials = initialsOf(displayName, email);
  const art = ART[size];
  const builtKey = built && !picture ? `${art}:${JSON.stringify(built)}` : '';
  // The kit's address for the recipe it was asked for (null: the kit failed), the cache's at once when this page has
  // drawn it before. Another recipe's, or none, while the kit is still drawing this one.
  const [kit, setKit] = useState<{ key: string; src: string | null } | null>(() => {
    const hit = built && !picture ? cachedBuiltSrc(built, art) : null;
    return hit ? { key: builtKey, src: hit } : null;
  });
  const kitAnswered = kit?.key === builtKey;
  useEffect(() => {
    if (!built || picture || kitAnswered) return undefined;
    let live = true;
    const key = builtKey;
    void builtAvatarSrc(built, art).then((src) => live && setKit({ key, src }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `builtKey` is the recipe's value
  }, [builtKey, kitAnswered]);
  /** An image that failed to load or decode: the initials, until another comes. */
  const [failed, setFailed] = useState<string | null>(null);
  const wanted: string | null | undefined = picture ? picture : built ? (kitAnswered ? kit.src : undefined) : null;
  const want = wanted === failed ? null : wanted;
  const [drawn, setDrawn] = useState<string | null>(() => (want && isDecoded(want) ? want : null));
  const step = nextDrawn(drawn, want, isDecoded);
  // In this render, not an effect's: the initials, or an image already decoded, never wait a frame.
  if (step.draw !== drawn) setDrawn(step.draw);
  useEffect(() => {
    const src = step.load;
    if (!src) return undefined;
    let live = true;
    void decode(src).then((ok) => {
      if (live) (ok ? setDrawn : setFailed)(src);
    });
    return () => {
      live = false;
    };
  }, [step.load]);
  const shown = step.draw;
  const builtArt = !!shown && shown.startsWith('data:');
  return (
    <span
      className={`avatar s${size}${badge ? ' has-seal' : ''}`}
      data-hue={hueOf(userId)}
      data-badge={badge ?? 'none'}
      aria-hidden="true"
      {...(title ? { title } : {})}
    >
      <span className="avatar-face" data-initials={shown ? '' : initials}>
        {shown ? (
          <img className={`avatar-picture${builtArt ? ' avatar-built' : ''}`} src={shown} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(shown)} />
        ) : (
          !initials && <Icon name="account" size={size / 2} />
        )}
      </span>
      {badge && <span className={`avatar-seal ${badge}`} />}
    </span>
  );
}
