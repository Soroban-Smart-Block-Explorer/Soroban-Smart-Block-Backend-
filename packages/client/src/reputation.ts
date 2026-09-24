type Fetcher = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; statusText: string; json: () => Promise<unknown> }>;

export interface ReputationClientOptions {
  baseUrl: string;
  fetcher?: Fetcher;
}

export class ReputationClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(options: ReputationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetcher =
      options.fetcher ??
      ((input: string, init?: Record<string, unknown>) => fetch(input as any, init as any));
  }

  score(address: string, chainData?: unknown): Promise<unknown> {
    if (chainData) {
      return this.post('/api/v1/reputation/score', { address, chainData });
    }
    return this.get(`/api/v1/reputation/score/${encodeURIComponent(address)}`);
  }

  leaderboard(category = 'overall', limit = 10): Promise<unknown> {
    return this.get(
      `/api/v1/reputation/leaderboards/${encodeURIComponent(category)}?limit=${limit}`,
    );
  }

  badges(address: string): Promise<unknown> {
    return this.get(`/api/v1/reputation/badges/${encodeURIComponent(address)}`);
  }

  oracle(address: string): Promise<unknown> {
    return this.get(`/api/v1/reputation/oracle/${encodeURIComponent(address)}`);
  }

  trustPath(from: string, to: string): Promise<unknown> {
    return this.get(
      `/api/v1/reputation/trust/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  }

  private get(path: string): Promise<unknown> {
    return this.request(path, { method: 'GET' });
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async request(path: string, init: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers:
        path.startsWith('/api/v1/reputation/score') && init.method === 'POST'
          ? { 'content-type': 'application/json' }
          : undefined,
      ...init,
    });
    const data = await response.json();
    if (!response.ok) {
      const errorBody = data as { error?: string };
      throw new Error(errorBody.error ?? response.statusText);
    }
    return data;
  }
}
