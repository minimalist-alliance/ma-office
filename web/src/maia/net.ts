// Calls to Support Maia's member routes (ma-platform contract maia.md), on `maia.url`, a Function URL that isn't api.
// Same token as every other call, refreshed once after a 401, as `platform/api.ts` does. Nothing else rides along:
// no cookies, and never anything from a desk.
import { heardAccountClosed } from '../platform/accountClosed';
import { getAccessToken } from '../platform/auth';

export async function maiaFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (force: boolean): Promise<Response> => {
    const token = await getAccessToken(force);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  };
  const first = await send(false);
  const res = first.status === 401 ? await send(true) : first;
  // Her routes answer a closed account `403 account_closed` (ma-platform contract moderation.md section 8): the office hears it.
  if (res.status === 403) void errorCode(res.clone()).then(heardAccountClosed);
  return res;
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
