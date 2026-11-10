// The agent's mark as DOM: a rounded square in the tone with the icon in FOREGROUND.
import type { CSSProperties } from 'react';
import { PNG_ICON, RADIUS_SHARE, glyphSize, strokeFor } from './draw';
import { FOREGROUND } from './foreground';
import { GRID, iconById } from './icons';
import { toneColor, type LookTheme } from './tones';

export interface AgentMarkProps {
  icon: string;
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

export function AgentMark({ icon, tone, theme, pngUrl, size, title }: AgentMarkProps) {
  const glyph = glyphSize(size);
  const style: CSSProperties = { width: size, height: size, borderRadius: size * RADIUS_SHARE, background: toneColor(tone, theme), color: FOREGROUND };
  const label = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  if (icon === PNG_ICON && pngUrl) {
    const url = `url("${pngUrl.replace(/["\\\n]/g, encodeURIComponent)}")`;
    const mask: CSSProperties = {
      width: glyph,
      height: glyph,
      backgroundColor: FOREGROUND,
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
      <span className="ag-look-mark" style={style} {...label}>
        <span className="ag-look-png" style={mask} />
      </span>
    );
  }
  return (
    <span className="ag-look-mark" style={style} {...label}>
      <svg width={glyph} height={glyph} viewBox={`0 0 ${GRID} ${GRID}`} fill="none" stroke="currentColor" strokeWidth={strokeFor(glyph)} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
        <IconPaths icon={icon} />
      </svg>
    </span>
  );
}
