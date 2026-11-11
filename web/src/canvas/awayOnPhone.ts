/** A desk a phone doesn't draw: in desk mode, every desk but the one in front. The overview and larger screens draw all. */
export const awayOnPhone = (phone: boolean, mode: string, active: string | null, id: string): boolean => phone && mode === 'desk' && !!active && active !== id;
