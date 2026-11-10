// Calls to Support Maia's member routes (ma-platform contract maia.md), on `maia.url`, a Function URL that isn't api.
// Same token as every other call, refreshed once after a 401, as `platform/api.ts` does. Nothing else rides along:
// no cookies, and never anything from a desk.
import { getAccessToken } from '../platform/auth';

export async function maiaFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (force: boolean): Promise<Response> => {
    const token = await getAccessToken(force);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  };
  const res = await send(false);
  return res.status === 401 ? send(true) : res;
}

/** The error envelope's `code` (contract errors.md), if the body has one. */
export async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}
