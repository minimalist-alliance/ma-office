// The member's avatar (task 45): initials on their tint, and their tier's badge as option 1's corner seal, cut out of
// the circle so it reads on any surface. Sizes, colors and marks are the Product Designer's spec: colors are tokens
// (`avatar`, `seal`), the marks are the spec's own SVG files in `assets/badges/`, and every size is in `app.css`.
// The avatar is a picture of what's said beside it or by its control, so it's hidden from screen readers, and its
// initials are drawn by CSS from `data-initials`, so they aren't text a control's name must contain (WCAG 2.5.3 counts
// visible text, aria-hidden or not). `title` is its tooltip. No tier name is drawn into it, ever.
import { useEffect, useState } from 'react';
import type { BadgeId } from '../platform/tiers';
import { hueOf, initialsOf } from './avatar';
import { builtAvatarSrc } from './avatarKit';
import { Icon } from './icons';

export type AvatarSize = 32 | 40;

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
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [picture]);
  const [kitSrc, setKitSrc] = useState<string | null>(null);
  const builtKey = built ? JSON.stringify(built) : '';
  useEffect(() => {
    setKitSrc(null);
    if (!built || picture) return;
    let live = true;
    void builtAvatarSrc(built, size).then((s) => live && setKitSrc(s));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `builtKey` is the recipe's value
  }, [builtKey, size, picture]);
  const shown = (picture && failed !== picture ? picture : null) ?? (kitSrc && failed !== kitSrc ? kitSrc : null);
  return (
    <span
      className={`avatar s${size}${badge ? ' has-seal' : ''}`}
      data-hue={hueOf(userId)}
      data-badge={badge ?? 'none'}
      aria-hidden="true"
      {...(title ? { title } : {})}
    >
      <span className="avatar-face" data-initials={shown ? '' : initials}>
        {shown ? <img className="avatar-picture" src={shown} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(shown)} /> : !initials && <Icon name="account" size={size / 2} />}
      </span>
      {badge && <span className={`avatar-seal ${badge}`} />}
    </span>
  );
}
