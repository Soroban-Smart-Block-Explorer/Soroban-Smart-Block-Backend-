import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanExplorerAuth } from '../SorobanExplorerAuth';

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

describe('SorobanExplorerAuth', () => {
  let auth: SorobanExplorerAuth;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = new SorobanExplorerAuth(
      { baseUrl: 'https://api.soroban.network' },
      mockStorage,
      mockBiometric,
    );
  });

  it('should initialize with stored credentials', async () => {
    mockStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        accessToken: 'test',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600000,
      }),
    );
    await auth.initialize();
    const token = await auth.getValidToken();
    expect(token).toBe('test');
  });

  it('should return null when no credentials', async () => {
    mockStorage.getItem.mockResolvedValueOnce(null);
    await auth.initialize();
    const token = await auth.getValidToken();
    expect(token).toBeNull();
  });

  it('should authenticate with biometrics', async () => {
    mockBiometric.authenticate.mockResolvedValueOnce({
      success: true,
      biometricType: 'faceid',
    });
    mockStorage.getItem.mockResolvedValueOnce(null);
    mockStorage.setItem.mockResolvedValueOnce(undefined);
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accessToken: 'test', refreshToken: 'refresh', expiresIn: 3600 }),
    });
    const result = await auth.authenticate('Test');
    expect(result).toBe(true);
  });

  it('should return biometric type', async () => {
    const type = await auth.getBiometricType();
    expect(type).toBeDefined();
  });

  it('should lock and clear credentials', async () => {
    await auth.lock();
    const token = await auth.getValidToken();
    expect(token).toBeNull();
  });
});
