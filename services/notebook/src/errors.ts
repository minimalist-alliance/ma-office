// An error the client branches on: the contract's code and, for bad_request, a reason.
export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const badRequest = (reason: string): RpcError => new RpcError('bad_request', { reason });
export const notFound = (): RpcError => new RpcError('not_found');
