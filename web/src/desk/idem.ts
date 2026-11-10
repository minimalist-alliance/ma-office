// `idem` for a mutation: a UUIDv7 (services/deskd/docs/API.md section 4).

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function uuidv7(now: number = Date.now(), fill: (b: Uint8Array<ArrayBuffer>) => void = (b) => void crypto.getRandomValues(b)): string {
  const b = new Uint8Array(16);
  fill(b);
  for (let i = 0; i < 6; i += 1) b[i] = Math.floor(now / 256 ** (5 - i)) % 256; // 48 bits of milliseconds
  b[6] = ((b[6] as number) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // variant 10
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
