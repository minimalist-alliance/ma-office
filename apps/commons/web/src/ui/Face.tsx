// The inside of a member's avatar circle: their checked profile picture when the guild roster carries one, else their
// built avatar (the vendored avatar kit, drawn once its lazy chunk has loaded), else their initials. A picture that fails
// to load, a kit that fails, or a recipe the check refuses is the initials again. Only Platform's public avatar route is
// ever drawn as a picture (names.ts). `size` is the circle's size in px: the kit's 24 px artwork up to 24, else its 32 px.
import { useEffect, useState } from 'react';
import { builtAvatarSrc } from './avatarKit.ts';
import { builtRecipeOf, initials, pictureOf } from './names.ts';

export function Face({ name, url, recipe, size = 28 }: { name: string; url?: string | undefined; recipe?: unknown; size?: number }) {
  const picture = pictureOf(url);
  const built = picture ? null : builtRecipeOf(recipe);
  const key = built ? JSON.stringify(built) : '';
  const kitSize = size <= 24 ? 24 : 32;
  const [kit, setKit] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setKit(null);
    if (!built) return;
    let live = true;
    void builtAvatarSrc(built, kitSize).then((s) => live && setKit(s));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the recipe's value
  }, [key, kitSize]);
  const src = picture ?? kit;
  useEffect(() => setFailed(null), [src]);
  if (src && failed !== src) return <img className="ma-cm-avatar-img" src={src} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
  return <>{initials(name)}</>;
}
