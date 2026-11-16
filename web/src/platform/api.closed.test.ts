// A 403 account_closed from any API is heard as a closed account (ma-platform contract moderation.md section 8), from
// `api()` and from Maia's own fetch, and nothing else is.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./clientConfig', () => ({ getClientConfig: async () => ({ api: 'https://api.example.test' }) }));
vi.mock('./auth', () => ({ getAccessToken: async () => 'token', SignInRequired: class SignInRequired extends Error {} }));

const { api, ApiError } = await import('./api');
const { maiaFetch } = await import('../maia/net');
const { forgetAccountClosed, useAccountClosed } = await import('./accountClosed');

const answer = (status: number, code: string | null) => async () =>
  new Response(JSON.stringify(code ? { error: { code, message: 'This account is closed.', requestId: 'r', retryable: false } } : { message: 'Forbidden' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  forgetAccountClosed();
});

describe('account_closed from any API', () => {
  it('api(): a 403 account_closed is heard, and still thrown to its caller as it was', async () => {
    vi.stubGlobal('fetch', vi.fn(answer(403, 'account_closed')));
    const err = await api('/v1/me/desk-layout').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('account_closed');
    expect(useAccountClosed.getState().heard).toBe(true);
  });

  it('api(): any other refusal is not', async () => {
    for (const [status, code] of [[403, 'forbidden'], [403, 'account_inactive'], [403, null], [404, 'account_closed'], [409, 'account_closed']] as const) {
      vi.stubGlobal('fetch', vi.fn(answer(status, code)));
      await api('/v1/desks').catch(() => {});
    }
    expect(useAccountClosed.getState().heard).toBe(false);
  });

  it('Maia’s routes: a 403 account_closed is heard, and her caller still reads the answer whole', async () => {
    vi.stubGlobal('fetch', vi.fn(answer(403, 'account_closed')));
    const res = await maiaFetch('https://maia.example.test', '/v1/maia/state');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('account_closed');
    await vi.waitFor(() => expect(useAccountClosed.getState().heard).toBe(true));
  });
});
