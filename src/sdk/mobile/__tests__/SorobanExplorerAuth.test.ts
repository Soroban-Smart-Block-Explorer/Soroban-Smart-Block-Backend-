import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SorobanExplorerAuth } from '../SorobanExplorerAuth';
import type { WalletSigner } from '../types';

const mockStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

const mockBiometric = {
  authenticate: vi.fn(),
  getBiometricType: vi.fn().mockResolvedValue('faceid' as const),
  isAvailable: vi.fn().mockResolvedValue(true),
};

const signer: WalletSigner = {
  getAddress: () => 'GABC123',
  sign: vi.fn().mockResolvedValue('c2lnbmF0dXJl'),
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
  } as unknown as Response;
}

describe('SorobanExplorerAuth', () => {
  let auth: SorobanExplorerAuth;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.setItem.mockResolvedValue(undefined);
    mockStorage.removeItem.mockResolvedValue(undefined);
    mockBiometric.getBiometricType.mockResolvedValue('faceid' as const);
    mockBiometric.isAvailable.mockResolvedValue(true);
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    auth = new SorobanExplorerAuth(
      { baseUrl: 'https://api.soroban.network' },
      mockStorage,
      mockBiometric,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes from a stored session', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await auth.initialize();
    expect(await auth.getValidToken()).toBe('access-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no credentials are stored', async () => {
    mockStorage.getItem.mockResolvedValueOnce(null);
    await auth.initialize();
    expect(await auth.getValidToken()).toBeNull();
  });

  it('logs in through the backend challenge/verify flow and stores the session', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ challenge: 'nonce-abc', challengeId: 'ch_1', type: 'stellar_message' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: 'access-2',
          refreshToken: 'refresh-2',
          sessionId: 'sess_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      );

    const session = await auth.login(signer);

    // Challenge request carries the wallet address + network.
    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0];
    expect(challengeUrl).toBe('https://api.soroban.network/api/v1/auth/challenge');
    expect(JSON.parse(challengeInit.body)).toMatchObject({
      address: 'GABC123',
      network: 'testnet',
      appId: 'explorer-mobile',
    });

    // The raw challenge message is what gets signed.
    expect(signer.sign).toHaveBeenCalledWith('nonce-abc');

    // Verify request sends the base64 signature.
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1];
    expect(verifyUrl).toBe('https://api.soroban.network/api/v1/auth/verify');
    expect(JSON.parse(verifyInit.body)).toMatchObject({
      address: 'GABC123',
      challengeId: 'ch_1',
      signature: 'c2lnbmF0dXJl',
    });

    expect(session.accessToken).toBe('access-2');
    expect(mockStorage.setItem).toHaveBeenCalledWith(
      'soroban_auth',
      expect.stringContaining('refresh-2'),
    );
    expect(await auth.getValidToken()).toBe('access-2');
  });

  it('throws when the challenge response is malformed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    await expect(auth.login(signer)).rejects.toThrow(/challenge/i);
  });

  it('reports whether a stored session exists without prompting biometrics', async () => {
    mockStorage.getItem.mockResolvedValueOnce('{"accessToken":"a","refreshToken":"r"}');
    expect(await auth.hasStoredSession()).toBe(true);
    expect(mockBiometric.authenticate).not.toHaveBeenCalled();

    mockStorage.getItem.mockResolvedValueOnce(null);
    expect(await auth.hasStoredSession()).toBe(false);
  });

  it('does not unlock when biometrics fail', async () => {
    mockBiometric.authenticate.mockResolvedValueOnce({ success: false, error: 'cancelled' });
    expect(await auth.authenticate('Test')).toBe(false);
  });

  it('re-hydrates the stored session after a successful biometric unlock', async () => {
    mockBiometric.authenticate.mockResolvedValueOnce({ success: true, biometricType: 'faceid' });
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'access-3',
        refreshToken: 'refresh-3',
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    expect(await auth.authenticate('Unlock')).toBe(true);
    expect(await auth.getValidToken()).toBe('access-3');
  });

  it('refreshes the access token when it is close to expiry', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'stale',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 1_000,
      }),
    );
    await auth.initialize();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        token: 'access-new',
        refreshToken: 'refresh-new',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );

    expect(await auth.getValidToken()).toBe('access-new');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.soroban.network/api/v1/auth/refresh');
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'refresh-old' });
    expect(mockStorage.setItem).toHaveBeenCalledWith(
      'soroban_auth',
      expect.stringContaining('refresh-new'),
    );
  });

  it('coalesces concurrent refreshes into a single request', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() - 1 }),
    );
    await auth.initialize();

    fetchMock.mockResolvedValue(
      jsonResponse({
        token: 'access-new',
        refreshToken: 'refresh-new',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );

    const [a, b] = await Promise.all([auth.getValidToken(), auth.getValidToken()]);
    expect(a).toBe('access-new');
    expect(b).toBe('access-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the session and fires onLock when the refresh token is rejected', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'stale', refreshToken: 'revoked', expiresAt: Date.now() - 1 }),
    );
    await auth.initialize();

    const onLock = vi.fn();
    auth.onLock(onLock);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Invalid or expired refresh token' }, false),
    );

    expect(await auth.getValidToken()).toBeNull();
    expect(onLock).toHaveBeenCalled();
    expect(mockStorage.removeItem).toHaveBeenCalledWith('soroban_auth');
  });

  it('maps backend entitlements and gates premium features behind biometrics', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'access-4',
        refreshToken: 'refresh-4',
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await auth.initialize();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tier: 'premium',
        features: ['webhooks', 'priority_rate_limit'],
        rateLimit: { requestsPerMinute: 1000, burstLimit: 2000 },
      }),
    );

    const entitlements = await auth.getEntitlements();
    expect(entitlements).toMatchObject({ tier: 'premium', isPremium: true });
    expect(auth.hasPremiumAccess()).toBe(true);
    expect(auth.hasFeature('webhooks')).toBe(true);

    mockBiometric.authenticate.mockResolvedValueOnce({ success: true, biometricType: 'faceid' });
    expect(await auth.unlockPremium()).toBe(true);
  });

  it('denies premium access for free-tier users without a biometric prompt', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
    );
    await auth.initialize();
    fetchMock.mockResolvedValueOnce(jsonResponse({ tier: 'free', features: [] }));

    await auth.getEntitlements();
    expect(await auth.unlockPremium()).toBe(false);
    expect(mockBiometric.authenticate).not.toHaveBeenCalled();
  });

  it('returns the biometric type', async () => {
    expect(await auth.getBiometricType()).toBe('faceid');
  });

  it('locks without deleting the stored refresh token', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
    );
    await auth.initialize();
    expect(await auth.getValidToken()).toBe('a');

    await auth.lock();
    expect(await auth.getValidToken()).toBeNull();
    expect(mockStorage.removeItem).not.toHaveBeenCalled();
  });

  it('clears credentials on logout', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
    );
    await auth.initialize();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));

    await auth.logout();
    expect(mockStorage.removeItem).toHaveBeenCalledWith('soroban_auth');
    expect(await auth.getValidToken()).toBeNull();
  });
});
