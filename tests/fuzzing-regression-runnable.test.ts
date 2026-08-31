import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateRegressionTest,
  persistRegressionTests,
  fuzzerModule,
} from '../src/fuzzing/fuzzer';
import type { FuzzFinding } from '../src/fuzzing/fuzzer';

const execFileAsync = promisify(execFile);

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ';

const BASE_FINDING: FuzzFinding = {
  functionName: 'transfer',
  args: ['recipient', '0xffffffffffffffffffffffffffffffff'],
  mutation: 'boundary_value',
  result: 'panic',
  error: 'integer overflow',
  severity: 'high',
  exploitable: true,
};

const repoRoot = join(process.cwd(), '.');
const regressionDir = join(repoRoot, 'tests', 'fuzzing', 'regressions');

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function withSharedEnv(): {
  cwd: string;
  env: Record<string, string | undefined>;
} {
  return {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/postgres',
      TESTNET_DATABASE_URL:
        process.env.TESTNET_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/postgres',
    },
  };
}

describe('fuzzer-generated regression tests (#921)', () => {
  describe('generateRegressionTest emits real, runnable code', () => {
    it('replaces the old TODO stub with a live simulateCall path', () => {
      const source = generateRegressionTest(BASE_FINDING, CONTRACT);

      // The stub is gone.
      expect(source).not.toContain('TODO');
      expect(source).not.toContain('Set up contract');
      expect(source).not.toContain('// expect(result)');

      // The generated test drives the shared simulateCall path.
      expect(source).toContain('import { simulateCall }');
      expect(source).toContain('simulateCall(contractAddress,');
      expect(source).toContain('expect(result).toBeDefined()');
      expect(source).toContain("expect(result).not.toContain('panic')");

      // RPC/DB/ABI are replayed deterministically so it runs offline.
      expect(source).toContain("vi.mock('../../../src/indexer/rpc'");
      expect(source).toContain("vi.mock('../../../src/db'");
    });

    it('serializes the contract address and exact mutated args', () => {
      const source = generateRegressionTest(BASE_FINDING, CONTRACT);
      expect(source).toContain(`const contractAddress = ${JSON.stringify(CONTRACT)};`);
      expect(source).toContain('recipient');
      expect(source).toContain('0xffffffffffffffffffffffffffffffff');
    });

    it('uses a valid throwaway account so construction cannot panic', () => {
      const source = generateRegressionTest(BASE_FINDING, CONTRACT);
      expect(source).toContain('Keypair.random().publicKey()');
    });

    it('embeds the finding error for deterministic replay', () => {
      const source = generateRegressionTest(BASE_FINDING, CONTRACT);
      expect(source).toContain('integer overflow');
    });
  });

  describe('persistRegressionTests writes repo fixtures', () => {
    it('writes one runnable .test.ts per finding', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fuzzreg-'));
      cleanups.push(dir);
      const findings = [
        BASE_FINDING,
        { ...BASE_FINDING, functionName: 'mint', error: 'unauthorized' },
      ];
      const { dir: outDir, files } = await persistRegressionTests(findings, CONTRACT, dir);

      expect(outDir).toBe(dir);
      expect(files).toHaveLength(2);
      for (const f of files) {
        expect(existsSync(f)).toBe(true);
        expect(f).toMatch(/\.test\.ts$/);
      }
    });

    it('succeeds with no findings (creates the dir, writes nothing)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fuzzreg-empty-'));
      cleanups.push(dir);
      const { files } = await persistRegressionTests([], CONTRACT, dir);
      expect(files).toEqual([]);
    });
  });

  describe('generated regression tests parse and run', () => {
    it('passes when executed by vitest', async () => {
      const source = generateRegressionTest(BASE_FINDING, CONTRACT);
      await mkdir(regressionDir, { recursive: true });
      const file = join(regressionDir, `.generated-parse-run-${process.pid}.test.ts`);
      await writeFile(file, source, 'utf8');
      cleanups.push(file);

      const { stdout } = await execFileAsync('npx', ['vitest', 'run', file], {
        ...withSharedEnv(),
        timeout: 120_000,
      });

      expect(stdout).toContain('Test Files');
      expect(stdout).toMatch(/Tests.*passed|passed/i);
    }, 180_000);
  });

  describe('public fuzzer module surface', () => {
    it('exposes the programmatic fuzzing API', () => {
      expect(fuzzerModule).toBeDefined();
      expect(typeof fuzzerModule.fuzzContract).toBe('function');
      expect(typeof fuzzerModule.startFuzzJob).toBe('function');
      expect(typeof fuzzerModule.generateRegressionTest).toBe('function');
      expect(typeof fuzzerModule.persistRegressionTests).toBe('function');
      expect(typeof fuzzerModule.simulateCall).toBe('function');
    });
  });
});
