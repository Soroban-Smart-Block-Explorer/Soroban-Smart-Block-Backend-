import { describe, it, expect, vi } from 'vitest';
import { ReputationClient } from './reputation';
import { NotFoundError, RateLimitError, ValidationError, errorFromResponse, retryOnRateLimit } from './errors';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
});

describe('SDK errors', () => {
  it('maps statuses to typed errors', () => {
    expect(errorFromResponse(404, { error: 'nope' })).toBeInstanceOf(NotFoundError);
    expect(errorFromResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'bad' } })).toBeInstanceOf(ValidationError);
  });

  it('client throws RateLimitError with retryAfter', async () => {
    const fetcher = vi.fn().mockResolvedValue(res(429, { error: 'slow' }, { 'retry-after': '2' }));
    const client = new ReputationClient({ baseUrl: 'http://x', fetcher });
    await expect(client.badges('G')).rejects.toMatchObject({ category: 'rate_limit', retryAfter: 2 });
  });

  it('retryOnRateLimit retries then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow', 429, undefined, undefined, 1))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await retryOnRateLimit(fn, { sleep })).toBe('ok');
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not retry other errors', async () => {
    const fn = vi.fn().mockRejectedValue(new NotFoundError('x', 404));
    await expect(retryOnRateLimit(fn)).rejects.toBeInstanceOf(NotFoundError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
