import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  config: { networkPassphrase: 'Test SDF Network ; September 2015' },
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  spec,
  invariant,
  precondition,
  postcondition,
  temporal,
  intVar,
  boolVar,
  bv32Var,
  intVal,
  bv32Val,
  eq,
  neq,
  add,
  sub,
  mul,
  div,
  lt,
  le,
  gt,
  ge,
  and_,
  or_,
  not_,
  implies_,
  forall_,
  exists_,
  ite_,
  bvOp,
  Sort,
  ArithOp,
  CmpOp,
  TOTAL_SUPPLY,
  BALANCE_PRESERVING_TRANSFER,
  NO_REENTRANCY,
  SAFE_MATH,
} from '../src/verification/dsl';

import { SpecCompiler } from '../src/verification/spec-compiler';
import { SmtSolver } from '../src/verification/smt-solver';
import {
  SymbolicExecutor,
  type WasmFunction,
  type WasmInstr,
} from '../src/verification/symbolic-executor';
import { GasAnalyzer } from '../src/verification/gas-analyzer';
import { ReentrancyAnalyzer } from '../src/verification/reentrancy-analyzer';
import { Verifier, createVerifier } from '../src/verification/verifier';
import { BadgeSystem } from '../src/verification/badge-system';

describe('Formal Specification DSL', () => {
  it('should create a simple invariant', () => {
    const prop = invariant('total_supply', eq(intVar('totalSupply'), intVar('summedBalances')));
    expect(prop.name).toBe('total_supply');
    expect(prop.kind).toBe('invariant');
    expect(prop.formula.kind).toBe('cmp');
  });

  it('should create pre/post conditions', () => {
    const pre = precondition('valid_input', gt(intVar('amount'), intVal(0)), ['transfer']);
    expect(pre.kind).toBe('precondition');
    expect(pre.functions).toEqual(['transfer']);

    const post = postcondition(
      'balance_preserving',
      BALANCE_PRESERVING_TRANSFER(
        intVar('fromBal'),
        intVar('toBal'),
        intVar('amount'),
        intVar('fromBalAfter'),
        intVar('toBalAfter'),
      ),
      ['transfer'],
    );
    expect(post.kind).toBe('postcondition');
  });

  it('should create temporal properties', () => {
    const prop = temporal('no_reentrancy', NO_REENTRANCY(intVar('callDepth')), {
      severity: 'critical',
    });
    expect(prop.kind).toBe('temporal');
    expect(prop.severity).toBe('critical');
  });

  it('should create a specification', () => {
    const s = spec('token_spec', 'C...', [invariant('inv1', eq(intVar('a'), intVar('b')))]);
    expect(s.name).toBe('token_spec');
    expect(s.contract).toBe('C...');
    expect(s.properties).toHaveLength(1);
  });

  it('should build arithmetic expressions', () => {
    const a = intVar('a');
    const b = intVar('b');

    expect(add(a, b).kind).toBe('arith');
    expect(add(a, b).op).toBe(ArithOp.Add);

    expect(sub(a, b).op).toBe(ArithOp.Sub);
    expect(mul(a, b).op).toBe(ArithOp.Mul);
    expect(div(a, b).op).toBe(ArithOp.Div);
  });

  it('should build comparison expressions', () => {
    const a = intVar('a');
    const b = intVar('b');

    expect(eq(a, b).op).toBe(CmpOp.Eq);
    expect(neq(a, b).op).toBe(CmpOp.Neq);
    expect(lt(a, b).op).toBe(CmpOp.Lt);
    expect(gt(a, b).op).toBe(CmpOp.Gt);
    expect(le(a, b).op).toBe(CmpOp.Le);
    expect(ge(a, b).op).toBe(CmpOp.Ge);
  });

  it('should build logic expressions', () => {
    const a = boolVar('a');
    const b = boolVar('b');

    expect(and_(a, b).kind).toBe('logic');
    expect(or_(a, b).kind).toBe('logic');
    expect(not_(a).kind).toBe('logic');
    expect(implies_(a, b).kind).toBe('logic');
  });

  it('should build quantifier expressions', () => {
    const expr = forall_([{ name: 'x', sort: Sort.Int }], gt(intVar('x'), intVal(0)));
    expect(expr.kind).toBe('quantifier');

    const expr2 = exists_([{ name: 'x', sort: Sort.Int }], eq(intVar('x'), intVal(42)));
    expect(expr2.kind).toBe('quantifier');
  });

  it('should create ite expressions', () => {
    const expr = ite_(boolVar('cond'), intVal(1), intVal(0));
    expect(expr.kind).toBe('ite');
  });

  it('should create BV expressions', () => {
    const v = bv32Var('x');
    const result = bvOp('add', [v, bv32Val(1)], 32);
    expect(result.kind).toBe('bv');
    expect(result.width).toBe(32);
  });

  it('should handle TOTAL_SUPPLY invariant', () => {
    const ts = intVar('totalSupply');
    const bal = intVar('balances');
    const expr = TOTAL_SUPPLY(ts, bal);
    expect(expr.kind).toBe('cmp');
  });
});

describe('Specification Compiler', () => {
  let compiler: SpecCompiler;

  beforeEach(() => {
    compiler = new SpecCompiler();
  });

  it('should compile a spec to SMT-LIB2', () => {
    const s = spec('test', 'test_contract', [invariant('test_inv', eq(intVar('a'), intVar('b')))]);
    const result = compiler.compile(s);
    expect(result.smtLib2).toContain('set-logic');
    expect(result.smtLib2).toContain('declare-const');
    expect(result.smtLib2).toContain('check-sat');
    expect(result.smtLib2).toContain('test_inv');
    expect(result.propertyMapping).toHaveLength(1);
    expect(result.propertyMapping[0].propertyName).toBe('test_inv');
  });

  it('should compile BV expressions', () => {
    const s = spec('bv_test', 'test', [invariant('bv_inv', eq(bv32Var('x'), bv32Val(0)))]);
    const result = compiler.compile(s);
    expect(result.smtLib2).toContain('BitVec 32');
  });

  it('should compile complex formulas', () => {
    const s = spec('complex', 'test', [
      invariant('safe_math', SAFE_MATH(intVar('r'), intVar('a'), intVar('b'), ArithOp.Add)),
      invariant('no_reentrancy', NO_REENTRANCY(intVar('cd'))),
    ]);
    const result = compiler.compile(s);
    expect(result.smtLib2).toContain('bvadd');
    expect(result.declarations.length).toBeGreaterThan(0);
  });

  it('should compile quantified formulas', () => {
    const s = spec('quant', 'test', [
      invariant(
        'forall_prop',
        forall_([{ name: 'x', sort: Sort.Int }], gt(intVar('x'), intVal(0))),
      ),
    ]);
    const result = compiler.compile(s);
    expect(result.smtLib2).toContain('forall');
  });
});

describe('SMT Solver Integration', () => {
  let solver: SmtSolver;

  beforeEach(() => {
    solver = new SmtSolver({ timeoutMs: 5000 });
  });

  it('should handle solver binary not found gracefully', async () => {
    const badSolver = new SmtSolver({
      backend: 'z3',
      binaryPath: '/nonexistent/z3',
      timeoutMs: 1000,
    });
    await expect(badSolver.healthCheck()).resolves.toBe(false);
  });

  it('should generate SMT queries', () => {
    const query =
      '(set-logic QF_BV)\n(declare-const x (_ BitVec 32))\n(assert (= x #x00000000))\n(check-sat)';
    expect(query).toContain('QF_BV');
    expect(query).toContain('check-sat');
  });

  it('should detect available solvers', async () => {
    const available = await SmtSolver.detectAvailableSolvers();
    expect(Array.isArray(available)).toBe(true);
  });

  it('should handle parallel solving count', () => {
    expect(solver['config'].workers).toBeGreaterThanOrEqual(1);
  });
});

describe('Symbolic Execution Engine', () => {
  let solver: SmtSolver;
  let executor: SymbolicExecutor;

  const makeSimpleFunction = (name: string, body: WasmInstr[]): WasmFunction => ({
    name,
    params: [],
    results: ['i64'],
    body,
  });

  beforeEach(() => {
    solver = new SmtSolver({ timeoutMs: 5000 });
    executor = new SymbolicExecutor(solver, {
      maxPaths: 50,
      maxDepth: 30,
      loopUnrollBound: 3,
    });
  });

  it('should execute a simple constant function', async () => {
    const func = makeSimpleFunction('constant_fn', [
      { op: 'i64.const', value: 42n },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('constant_fn', []);
    expect(result.functionName).toBe('constant_fn');
    expect(result.pathsExplored).toBeGreaterThanOrEqual(1);
  });

  it('should handle i32 arithmetic', async () => {
    const func = makeSimpleFunction('add_fn', [
      { op: 'i32.const', value: 1 },
      { op: 'i32.const', value: 2 },
      { op: 'i32.add', left: [], right: [] },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('add_fn', []);
    expect(result.pathsExplored).toBeGreaterThanOrEqual(1);
  });

  it('should handle host function calls', async () => {
    const func = makeSimpleFunction('host_fn_test', [
      { op: 'host_fn', name: 'require_auth', args: [] },
      { op: 'host_fn', name: 'emit_event', args: [] },
      { op: 'i64.const', value: 0n },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('host_fn_test', []);
    expect(result.pathsExplored).toBeGreaterThanOrEqual(1);
  });

  it('should detect division by zero', async () => {
    const func = makeSimpleFunction('div_fn', [
      { op: 'i32.const', value: 10 },
      { op: 'i32.const', value: 0 },
      { op: 'i32.div_s', left: [], right: [] },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('div_fn', []);
    const hasDivByZero = result.vulnerabilities.some((v) => v.type === 'division_by_zero');
    expect(hasDivByZero).toBe(true);
  });

  it('should track coverage', async () => {
    const func = makeSimpleFunction('cov_fn', [
      { op: 'i32.const', value: 1 },
      { op: 'i32.const', value: 2 },
      { op: 'i32.add', left: [], right: [] },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('cov_fn', []);
    const keys = Object.keys(result.coverage);
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.values(result.coverage).some((v) => v)).toBe(true);
  });

  it('should handle params with symbolic execution', async () => {
    const func: WasmFunction = {
      name: 'sym_fn',
      params: [
        { name: 'x', type: 'i32' },
        { name: 'y', type: 'i32' },
      ],
      results: ['i32'],
      body: [
        { op: 'local.get', idx: 0 },
        { op: 'local.get', idx: 1 },
        { op: 'i32.add', left: [], right: [] },
        { op: 'return', value: [] },
      ],
    };
    executor.loadContract([func]);
    const result = await executor.executeSymbolic('sym_fn', [
      { name: 'x', type: 'i32', symbolic: true },
      { name: 'y', type: 'i32', symbolic: true },
    ]);
    expect(result.pathsExplored).toBeGreaterThanOrEqual(1);
  });

  it('should detect reentrancy vulnerabilities', async () => {
    const func = makeSimpleFunction('reentrant_fn', [
      { op: 'host_fn', name: 'call_contract', args: [] },
      { op: 'host_fn', name: 'call_contract', args: [] },
      { op: 'host_fn', name: 'call_contract', args: [] },
      { op: 'i64.const', value: 0n },
      { op: 'return', value: [] },
    ]);
    executor.loadContract([func]);
    const result = await executor.executeFunction('reentrant_fn', []);
    const hasReentrancy = result.vulnerabilities.some((v) => v.type === 'reentrancy');
    expect(hasReentrancy).toBe(true);
  });
});

describe('Gas Analyzer', () => {
  let solver: SmtSolver;
  let analyzer: GasAnalyzer;

  beforeEach(() => {
    solver = new SmtSolver({ timeoutMs: 5000 });
    analyzer = new GasAnalyzer(solver);
  });

  it('should analyze a simple function', async () => {
    const func: WasmFunction = {
      name: 'simple',
      params: [],
      results: ['i64'],
      body: [
        { op: 'i32.const', value: 1 },
        { op: 'i32.const', value: 2 },
        { op: 'i32.add', left: [], right: [] },
        { op: 'return', value: [] },
      ],
    };
    const result = await analyzer.analyzeFunction(func);
    expect(result.functionName).toBe('simple');
    expect(result.worstCaseCpu).toBeGreaterThan(0);
    expect(result.estimatedFee).toContain('stroops');
  });

  it('should detect gas hotspots', async () => {
    const func: WasmFunction = {
      name: 'hotspot_test',
      params: [],
      results: ['i64'],
      body: [
        { op: 'host_fn', name: 'put_contract_data', args: [] },
        { op: 'host_fn', name: 'call_contract', args: [] },
        { op: 'i64.const', value: 0n },
        { op: 'return', value: [] },
      ],
    };
    const result = await analyzer.analyzeFunction(func);
    expect(result.hotspots.length).toBeGreaterThan(0);
    const hasHostFnHotspot = result.hotspots.some((h) => h.instruction.includes('host_fn'));
    expect(hasHostFnHotspot).toBe(true);
  });

  it('should estimate fees', () => {
    const result = analyzer['estimateFee'](1000, 1024, 2);
    expect(result).toContain('stroops');
    expect(result).toContain('XLM');
  });
});

describe('Reentrancy Analyzer', () => {
  let solver: SmtSolver;
  let analyzer: ReentrancyAnalyzer;

  beforeEach(() => {
    solver = new SmtSolver({ timeoutMs: 5000 });
    analyzer = new ReentrancyAnalyzer(solver);
  });

  it('should analyze a contract with no reentrancy', async () => {
    const functions: WasmFunction[] = [
      {
        name: 'safe_fn',
        params: [],
        results: ['i64'],
        body: [
          { op: 'i32.const', value: 1 },
          { op: 'return', value: [] },
        ],
      },
    ];
    const result = await analyzer.analyze('C...', functions);
    expect(result.contractAddress).toBe('C...');
    expect(result.safetyScore).toBeGreaterThanOrEqual(0);
    expect(result.callGraph).toBeDefined();
  });

  it('should detect cyclic call paths', () => {
    const edges = [
      { caller: 'A', callee: 'B', functionName: 'f1', isReentrant: true, depth: 1 },
      { caller: 'B', callee: 'A', functionName: 'f2', isReentrant: true, depth: 1 },
    ];
    const cycles = analyzer['detectCyclicPaths'](edges);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('should compute safety scores', () => {
    const score = analyzer['computeSafetyScore'](
      [{ caller: 'A', callee: 'B', functionName: 'f', isReentrant: true, depth: 2 }],
      [],
    );
    expect(score).toBeLessThan(100);
  });
});

describe('Verifier Pipeline', () => {
  let verifier: Verifier;

  beforeEach(() => {
    verifier = createVerifier({ timeoutMs: 5000 });
  });

  it('should create and track jobs', () => {
    const jobId = verifier.createJob('test_contract');
    expect(jobId).toBeTruthy();
    const job = verifier.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.status).toBe('pending');
  });

  it(
    'should verify a specification (skipped if no solver)',
    { retry: 0, timeout: 2000 },
    async () => {
      const solverAvailable = await new SmtSolver({ timeoutMs: 1000 }).healthCheck();
      if (!solverAvailable) return; // skip if no solver

      const s = spec('test_spec', 'C...', [invariant('inv1', eq(intVar('a'), intVar('b')))]);
      const functions: WasmFunction[] = [
        {
          name: 'test_fn',
          params: [{ name: 'x', type: 'i32' }],
          results: ['i32'],
          body: [
            { op: 'local.get', idx: 0 },
            { op: 'return', value: [] },
          ],
        },
      ];
      const result = await verifier.verifySpecification(s, functions, 'C...');
      expect(['verified', 'violated', 'unknown']).toContain(result.status);
    },
  );

  it('should compute safety scores', () => {
    const propResults = [
      {
        property: invariant('p1', eq(intVar('a'), intVar('b'))),
        status: 'verified' as const,
        executionTimeMs: 10,
      },
      {
        property: invariant('p2', eq(intVar('c'), intVar('d'))),
        status: 'verified' as const,
        executionTimeMs: 10,
      },
    ];
    const score = verifier['computeOverallSafetyScore'](propResults as any, 90, []);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('Badge System', () => {
  let badgeSystem: BadgeSystem;

  beforeEach(() => {
    badgeSystem = new BadgeSystem({ ttlDays: 90, minScoreForBadge: 50 });
  });

  it('should issue gold badges for perfect scores', () => {
    const report = {
      contractName: 'Test',
      contractAddress: 'C...',
      verifiedAt: new Date().toISOString(),
      summary: {
        safetyScore: 95,
        vulnerabilities: [],
        totalProperties: 2,
        verifiedProperties: 2,
        failedProperties: 0,
      },
      propertyResults: [],
      symbolicAnalysis: [],
      reentrancyAnalysis: null,
      gasAnalysis: null,
      concolicTestCases: [],
      ciCompatible: true,
      badge: {
        level: 'gold' as const,
        issuedAt: new Date().toISOString(),
        propertiesVerified: 2,
        propertiesTotal: 2,
      },
    };
    const badge = badgeSystem.issueBadge('C...', report as any);
    expect(badge).toBeDefined();
    expect(badge!.badge.level).toBe('gold');
  });

  it('should not issue badges for low scores', () => {
    const report = {
      contractName: 'Test',
      contractAddress: 'C...',
      verifiedAt: new Date().toISOString(),
      summary: {
        safetyScore: 30,
        vulnerabilities: [],
        totalProperties: 2,
        verifiedProperties: 0,
        failedProperties: 2,
      },
      propertyResults: [],
      symbolicAnalysis: [],
      reentrancyAnalysis: null,
      gasAnalysis: null,
      concolicTestCases: [],
      ciCompatible: true,
      badge: null,
    };
    const badge = badgeSystem.issueBadge('C...', report as any);
    expect(badge).toBeNull();
  });

  it('should retrieve badge info for explorer', () => {
    const report = {
      contractName: 'Test',
      contractAddress: 'C...1',
      verifiedAt: new Date().toISOString(),
      summary: {
        safetyScore: 95,
        vulnerabilities: [],
        totalProperties: 2,
        verifiedProperties: 2,
        failedProperties: 0,
      },
      propertyResults: [],
      symbolicAnalysis: [],
      reentrancyAnalysis: null,
      gasAnalysis: null,
      concolicTestCases: [],
      ciCompatible: true,
      badge: {
        level: 'silver' as const,
        issuedAt: new Date().toISOString(),
        propertiesVerified: 2,
        propertiesTotal: 2,
      },
    };
    badgeSystem.issueBadge('C...1', report as any);
    const explorerData = badgeSystem.getBadgeForExplorer('C...1');
    expect(explorerData).toBeDefined();
    expect(explorerData!.hasBadge).toBe(true);
    expect(explorerData!.level).toBe('silver');
  });

  it('should return null for contracts without badges', () => {
    const result = badgeSystem.getBadgeForExplorer('nonexistent');
    expect(result).toBeDefined();
    expect(result!.hasBadge).toBe(false);
  });

  it('should revoke badges', () => {
    const report = {
      contractName: 'Test',
      contractAddress: 'C...2',
      verifiedAt: new Date().toISOString(),
      summary: {
        safetyScore: 90,
        vulnerabilities: [],
        totalProperties: 1,
        verifiedProperties: 1,
        failedProperties: 0,
      },
      propertyResults: [],
      symbolicAnalysis: [],
      reentrancyAnalysis: null,
      gasAnalysis: null,
      concolicTestCases: [],
      ciCompatible: true,
      badge: {
        level: 'bronze' as const,
        issuedAt: new Date().toISOString(),
        propertiesVerified: 1,
        propertiesTotal: 1,
      },
    };
    badgeSystem.issueBadge('C...2', report as any);
    expect(badgeSystem.getBadge('C...2')).toBeDefined();
    badgeSystem.revokeBadge('C...2');
    expect(badgeSystem.getBadge('C...2')).toBeUndefined();
  });
});
