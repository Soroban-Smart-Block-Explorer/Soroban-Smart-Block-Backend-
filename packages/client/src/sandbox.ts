type Fetcher = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status?: number; statusText: string; json: () => Promise<unknown> }>;

export interface SandboxClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetcher?: Fetcher;
}

/** Request schema for a simulation. `transaction` is a base64 XDR transaction envelope. */
export interface SimulationRequest {
  transaction: string;
}

/** Typed simulation result. Semantics are stable: `success` is true iff no `error` was returned. */
export interface SimulationResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/** A named test scenario with expectations on the simulation outcome. */
export interface SimulationScenario {
  name: string;
  request: SimulationRequest;
  expectSuccess: boolean;
  expectErrorIncludes?: string;
}

export interface ScenarioOutcome {
  name: string;
  passed: boolean;
  reason?: string;
  result?: SimulationResult;
}

export class SandboxSimulationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SandboxSimulationError';
  }
}

export function validateSimulationRequest(req: SimulationRequest): void {
  if (!req || typeof req.transaction !== 'string' || req.transaction.length === 0) {
    throw new SandboxSimulationError('transaction must be a non-empty base64 XDR string');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(req.transaction)) {
    throw new SandboxSimulationError('transaction must be valid base64');
  }
}

export class SandboxClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetcher: Fetcher;

  constructor(options: SandboxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetcher =
      options.fetcher ??
      ((input: string, init?: Record<string, unknown>) => fetch(input as any, init as any));
  }

  /** Simulate a transaction via POST /api/v1/simulate. */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    validateSimulationRequest(request);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const response = await this.fetcher(`${this.baseUrl}/api/v1/simulate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    const data = (await response.json()) as SimulationResult;
    if (!response.ok) {
      throw new SandboxSimulationError(
        (data as { error?: string }).error ?? response.statusText,
        response.status,
      );
    }
    return { ...data, success: !data.error };
  }

  /** Run scenarios sequentially and report per-scenario outcomes. */
  async runScenarios(scenarios: SimulationScenario[]): Promise<ScenarioOutcome[]> {
    const outcomes: ScenarioOutcome[] = [];
    for (const s of scenarios) {
      try {
        const result = await this.simulate(s.request);
        let reason: string | undefined;
        if (result.success !== s.expectSuccess) {
          reason = `expected success=${s.expectSuccess}, got ${result.success}`;
        } else if (s.expectErrorIncludes && !(result.error ?? '').includes(s.expectErrorIncludes)) {
          reason = `error did not include "${s.expectErrorIncludes}"`;
        }
        outcomes.push({ name: s.name, passed: !reason, reason, result });
      } catch (err) {
        outcomes.push({ name: s.name, passed: false, reason: (err as Error).message });
      }
    }
    return outcomes;
  }
}
