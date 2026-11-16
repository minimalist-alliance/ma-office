// The agent's mark as DOM. The hat (every agent's, unless the member picked another): the Agent app's own 3D icon in the
// agent's colour on a tile tinted by that colour, bevelled and lifted as an app's tile is (`HatMark`). A library icon or an
// upload the member picked: the same tile, the icon in the colour. From a desk that says no colour, a library icon or upload is the old tone square.
import { useEffect, useRef, type CSSProperties } from 'react';
import { eggCss, tileShadowCss } from '../../../src/theme/tileFace';
import { glassOpacity } from '../../../src/theme/tileGlass';
import { GLASS_FACE, THEMES, type ShadowLayer, type ThemeId } from '../../../src/theme/tokens';
import { agentColorHex, agentTileTint } from './colors';
import { PNG_ICON, RADIUS_SHARE, glyphSize, strokeFor } from './draw';
import { FOREGROUND } from './foreground';
import { drawHat } from './hat';
import { GRID, iconById, wearsHat } from './icons';
import { toneColor, type LookTheme } from './tones';

export interface AgentMarkProps {
  icon: string;
  /** The agent's colour (`colors.ts`); null or absent: grey, as a desk that hasn't said. */
  color?: string | null;
  tone: string;
  theme: LookTheme;
  /** With `icon === 'png'`: the uploaded mask. Only its alpha is used. */
  pngUrl?: string | null;
  size: number;
  title?: string;
}

/** Strokes of one icon, for use inside any <svg viewBox="0 0 24 24">. */
export function IconPaths({ icon }: { icon: string }) {
  return (
    <>
      {iconById(icon).paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </>
  );
}

/** The hat's share of its mark: the 3D glyphs carry their own air inside their 48 box. */
export const hatSize = (size: number): number => Math.round(size * (size < 32 ? 0.86 : 0.72));

/** The Agent app's own icon in the agent's colour, drawn by the office's 3D drawing on a canvas this size. */
export function HatMark({ color, theme, size }: { color: string | null | undefined; theme: LookTheme; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    c.width = Math.round(size * dpr);
    c.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    drawHat(ctx, color, theme, size);
  }, [color, theme, size]);
  return <canvas ref={ref} className="ag-look-hat" style={{ width: size, height: size }} data-color={color ?? ''} aria-hidden="true" />;
}

const px = (v: number): string => `${Math.round(v * 100) / 100}px`;
/** The glass's contact shadow, scaled down under 40 px as the solid tile's lift is (`tileShadowCss`), where a full one would smudge. */
const liftCss = (theme: ThemeId, size: number): string => {
  const k = Math.min(1, size / 40);
  return GLASS_FACE[theme].lift.map((l: ShadowLayer) => `0 ${px(Math.max(0.5, l.dy * k))} ${px(Math.max(1, l.blur * k))} ${l.color}`).join(', ');
};

export function AgentMark({ icon, color, tone, theme, pngUrl, size, title }: AgentMarkProps) {
  const label = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  const hex = agentColorHex(color, theme);
  // The hat, or with a colour any other pick: the agent's tile, the same face as every app's: in the office, its glass (the
  // owner's pick C, Nov 16; the class `ma-glass`, `web/src/styles/glass.css`), the agent's own colour's egg as its body, as
  // opaque as its icon's 3:1 on the window under it needs (`glassOpacity`); under reduced transparency or more contrast, and
  // without the office's stylesheet, the solid tile (APP-TILES): tinted by the colour as a very subtle egg, the bevel and the
  // lift (`web/src/theme/tileFace.ts`).
  const tinted = (): CSSProperties => {
    const id = theme as ThemeId;
    const fill = agentTileTint(color, theme);
    const t = THEMES[id];
    const alpha = Math.max(...[t.surface.window, t.surface.panel].map((ground) => glassOpacity(GLASS_FACE[id], fill.centre, ground, id, hex)));
    return {
      width: size,
      height: size,
      borderRadius: size * RADIUS_SHARE,
      '--ma-glass-fill': eggCss(fill, alpha),
      '--ma-glass-lift': liftCss(id, size),
      '--ma-glass-solid-bg': eggCss(fill),
      // The tile's own hairline first (so a light tile still has an edge on a light window), then the bevel and lift.
      '--ma-glass-solid-shadow': `inset 0 0 0 1px var(--ma-border-hairline), ${tileShadowCss(id, size)}`,
    } as CSSProperties;
  };
  if (wearsHat(icon)) {
    return (
      <span className="ag-look-mark hat ma-glass" style={tinted()} data-color={color ?? ''} {...label}>
        <HatMark color={color} theme={theme} size={hatSize(size)} />
      </span>
    );
  }
  // A library icon or an upload the member picked: drawn in the agent's colour on its tile (3:1 or more on the tile, as an
  // app's accent is), the way the hat's band is. From a desk that says no colour: the tone square and the one foreground.
  const glyph = hex ? hatSize(size) : glyphSize(size);
  const ink = hex ?? FOREGROUND;
  const style: CSSProperties = hex ? { ...tinted(), color: ink } : { width: size, height: size, borderRadius: size * RADIUS_SHARE, background: toneColor(tone, theme), color: ink };
  const cls = hex ? 'ag-look-mark hat ma-glass' : 'ag-look-mark';
  if (icon === PNG_ICON && pngUrl) {
    const url = `url("${pngUrl.replace(/["\\\n]/g, encodeURIComponent)}")`;
    const mask: CSSProperties = {
      width: glyph,
      height: glyph,
      backgroundColor: ink,
      maskImage: url,
      WebkitMaskImage: url,
      maskSize: 'contain',
      WebkitMaskSize: 'contain',
      maskRepeat: 'no-repeat',
      WebkitMaskRepeat: 'no-repeat',
      maskPosition: 'center',
      WebkitMaskPosition: 'center',
    };
    return (
      <span className={cls} style={style} data-color={color ?? ''} {...label}>
        <span className="ag-look-png" style={mask} />
      </span>
    );
  }
  return (
    <span className={cls} style={style} data-color={color ?? ''} {...label}>
      <svg width={glyph} height={glyph} viewBox={`0 0 ${GRID} ${GRID}`} fill="none" stroke="currentColor" strokeWidth={strokeFor(glyph)} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
        <IconPaths icon={icon} />
      </svg>
    </span>
  );
}
