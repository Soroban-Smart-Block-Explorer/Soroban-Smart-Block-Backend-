import { SmtSolver } from './smt-solver';
import { SpecCompiler } from './spec-compiler';
import {
  type Expr,
  bv32Var,
  bv64Var,
  intVar,
  intVal,
  boolVal,
  bv32Val,
  bv64Val,
  add,
  sub,
  mul,
  div,
  mod,
  eq,
  neq,
  lt,
  le,
  gt,
  ge,
  not_,
  ite_,
  and_,
  or_,
} from './dsl';

export type WasmType = 'i32' | 'i64' | 'f32' | 'f64';

export interface SymbolicValue {
  expr: Expr;
  type: WasmType;
  concrete?: number | bigint | boolean;
}

export interface WasmFunction {
  name: string;
  params: Array<{ name: string; type: WasmType }>;
  results: WasmType[];
  body: WasmInstr[];
}

export type WasmInstr =
  | { op: 'block'; label: string; body: WasmInstr[] }
  | { op: 'loop'; label: string; body: WasmInstr[] }
  | { op: 'if_else'; cond: WasmInstr[]; then: WasmInstr[]; else: WasmInstr[] }
  | { op: 'br'; label: string }
  | { op: 'br_if'; label: string; cond: WasmInstr[] }
  | { op: 'return'; value?: WasmInstr[] }
  | { op: 'call'; funcIdx: number; args: WasmInstr[][] }
  | { op: 'call_indirect'; args: WasmInstr[][] }
  | { op: 'local.get'; idx: number }
  | { op: 'local.set'; idx: number; value: WasmInstr[] }
  | { op: 'local.tee'; idx: number; value: WasmInstr[] }
  | { op: 'global.get'; idx: number }
  | { op: 'global.set'; idx: number; value: WasmInstr[] }
  | { op: 'i32.const'; value: number }
  | { op: 'i64.const'; value: bigint }
  | { op: 'i32.add'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.sub'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.mul'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.div_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.rem_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.eq'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.ne'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.lt_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.le_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.gt_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.ge_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i32.eqz'; value: WasmInstr[] }
  | { op: 'i64.add'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.sub'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.mul'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.div_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.rem_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.eq'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.ne'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.lt_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.le_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.gt_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.ge_s'; left: WasmInstr[]; right: WasmInstr[] }
  | { op: 'i64.eqz'; value: WasmInstr[] }
  | { op: 'drop'; value: WasmInstr[] }
  | { op: 'select'; cond: WasmInstr[]; then: WasmInstr[]; else: WasmInstr[] }
  | { op: 'host_fn'; name: string; args: WasmInstr[][] }
  | { op: 'nop' };

export interface PathConstraint {
  condition: Expr;
  branch: 'true' | 'false';
}

export type ExplorationStrategy = 'bfs' | 'dfs' | 'heuristic';

export interface ExecutorOptions {
  maxPaths: number;
  maxDepth: number;
  timeoutMs: number;
  explorationStrategy: ExplorationStrategy;
  loopUnrollBound: number;
  abstractionRefinement: boolean;
  concolicTesting: boolean;
  pathMerging: boolean;
  invariantInference: boolean;
  cegarMaxIterations: number;
}

export interface ExecutionState {
  locals: SymbolicValue[];
  globals: SymbolicValue[];
  stack: SymbolicValue[];
  constraints: PathConstraint[];
  pc: number;
  depth: number;
  functionName: string;
  callStack: Array<{ func: string; pc: number; locals: SymbolicValue[] }>;
  pathId: number;
  storage: Map<string, SymbolicValue>;
  events: Array<{ name: string; args: SymbolicValue[] }>;
  callDepth: number;
  reentrantCalls: Set<string>;
}

export interface ExecutionPath {
  state: ExecutionState;
  constraints: PathConstraint[];
  result?: SymbolicValue;
  terminated:
    | 'return'
    | 'panic'
    | 'assert_fail'
    | 'overflow'
    | 'underflow'
    | 'div_by_zero'
    | 'unreachable';
  error?: string;
}

export interface Vulnerability {
  type:
    | 'assertion_violation'
    | 'integer_overflow'
    | 'integer_underflow'
    | 'division_by_zero'
    | 'panic'
    | 'reentrancy'
    | 'access_control'
    | 'unhandled_error';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  functionName: string;
  pathId: number;
  witness: Array<{ function: string; constraints: string }>;
  smtQuery?: string;
  exploitTrace?: string[];
}

export interface AnalysisResult {
  functionName: string;
  pathsExplored: number;
  totalPaths: number;
  vulnerabilities: Vulnerability[];
  coverage: Record<string, boolean>;
  executionTimeMs: number;
  pathConstraints: string[];
  cegarIterations: number;
  loopInvariants: Array<{ loopLabel: string; invariant: string }>;
  abstractPredicates: string[];
}

export interface SymbolicState {
  locals: SymbolicValue[];
  stack: SymbolicValue[];
  constraints: PathConstraint[];
  depth: number;
  callDepth: number;
  storage: Map<string, SymbolicValue>;
  events: Array<{ name: string; args: SymbolicValue[] }>;
  reentrantCalls: Set<string>;
}

interface AbstractState {
  predicates: Set<string>;
  values: Map<string, 'top' | 'bot' | Expr>;
}

interface _ConcolicValue {
  symbolic: SymbolicValue;
  concrete: number | bigint;
}

export class SymbolicExecutor {
  private solver: SmtSolver;
  private compiler: SpecCompiler;
  private options: ExecutorOptions;
  private nextPathId: number = 0;
  private functions: Map<number, WasmFunction> = new Map();
  private symbolicMap: Map<string, SymbolicValue> = new Map();
  private loopInvariants: Map<string, Expr> = new Map();
  private abstractPredicates: string[] = [];
  private cegarIteration: number = 0;

  constructor(solver: SmtSolver, options?: Partial<ExecutorOptions>) {
    this.solver = solver;
    this.compiler = solver.getCompiler();
    this.options = {
      maxPaths: options?.maxPaths ?? 500,
      maxDepth: options?.maxDepth ?? 100,
      timeoutMs: options?.timeoutMs ?? 600000,
      explorationStrategy: options?.explorationStrategy ?? 'bfs',
      loopUnrollBound: options?.loopUnrollBound ?? 5,
      abstractionRefinement: options?.abstractionRefinement ?? true,
      concolicTesting: options?.concolicTesting ?? true,
      pathMerging: options?.pathMerging ?? true,
      invariantInference: options?.invariantInference ?? true,
      cegarMaxIterations: options?.cegarMaxIterations ?? 10,
    };
  }

  loadContract(functions: WasmFunction[]): void {
    this.functions.clear();
    this.symbolicMap.clear();
    this.loopInvariants.clear();
    this.abstractPredicates = [];
    this.cegarIteration = 0;
    for (let i = 0; i < functions.length; i++) {
      this.functions.set(i, functions[i]);
    }
  }

  async executeFunction(funcName: string, symbolicArgs: SymbolicValue[]): Promise<AnalysisResult> {
    const startTime = Date.now();
    const funcEntry = Array.from(this.functions.values()).find((f) => f.name === funcName);
    if (!funcEntry) {
      throw new Error(`Function ${funcName} not found`);
    }

    const initialState: ExecutionState = {
      locals: symbolicArgs,
      globals: [],
      stack: [],
      constraints: [],
      pc: 0,
      depth: 0,
      functionName: funcName,
      callStack: [],
      pathId: this.nextPathId++,
      storage: new Map(),
      events: [],
      callDepth: 0,
      reentrantCalls: new Set(),
    };

    const allPaths: ExecutionPath[] = [];
    let vuls: Vulnerability[] = [];

    if (this.options.abstractionRefinement) {
      const result = await this.executeWithCEGAR(funcEntry, initialState, allPaths, startTime);
      vuls = result.vulnerabilities;
    } else {
      vuls = await this.executePaths(funcEntry, initialState, allPaths, startTime);
    }

    const coverage = this.computeCoverage(allPaths, funcEntry);
    const pathConstraints = allPaths.map((p) =>
      p.constraints.map((c) => this.compiler.compileExpr(c.condition)).join(' && '),
    );

    const loopInvariants = Array.from(this.loopInvariants.entries()).map(([label, inv]) => ({
      loopLabel: label,
      invariant: this.compiler.compileExpr(inv),
    }));

    return {
      functionName: funcName,
      pathsExplored: allPaths.length,
      totalPaths: this.options.maxPaths,
      vulnerabilities: vuls,
      coverage,
      executionTimeMs: Date.now() - startTime,
      pathConstraints,
      cegarIterations: this.cegarIteration,
      loopInvariants,
      abstractPredicates: this.abstractPredicates,
    };
  }

  private async executeWithCEGAR(
    func: WasmFunction,
    initialState: ExecutionState,
    allPaths: ExecutionPath[],
    startTime: number,
  ): Promise<{ vulnerabilities: Vulnerability[] }> {
    const abstractedStates: ExecutionState[] = [this.buildAbstractState(initialState)];
    const visitedPredicates = new Set<string>();
    const allVulnerabilities: Vulnerability[] = [];

    for (
      this.cegarIteration = 0;
      this.cegarIteration < this.options.cegarMaxIterations;
      this.cegarIteration++
    ) {
      const paths: ExecutionPath[] = [];
      await this.executePaths(func, abstractedStates[0], paths, startTime);

      const spuriousPaths: ExecutionPath[] = [];

      for (const path of paths) {
        if (path.terminated === 'panic' || path.terminated === 'assert_fail') {
          const feasible = await this.isPathFeasibleSmt(path);
          if (feasible) {
            allPaths.push(path);
          } else {
            spuriousPaths.push(path);
          }
        } else {
          allPaths.push(path);
        }
      }

      if (spuriousPaths.length === 0) break;

      const newPredicates = this.discoverPredicates(spuriousPaths, func);
      for (const pred of newPredicates) {
        if (!visitedPredicates.has(pred)) {
          visitedPredicates.add(pred);
          this.abstractPredicates.push(pred);
        }
      }

      abstractedStates[0] = this.refineAbstractState(initialState, this.abstractPredicates);
    }

    const detectedVuls = this.detectVulnerabilities(allPaths, func.name);
    allVulnerabilities.push(...detectedVuls);

    return { vulnerabilities: allVulnerabilities };
  }

  private buildAbstractState(state: ExecutionState): ExecutionState {
    const abs: AbstractState = {
      predicates: new Set(),
      values: new Map(),
    };

    for (const param of state.locals) {
      const key = this.compiler.compileExpr(param.expr);
      abs.values.set(key, 'top');
    }

    return {
      ...state,
      constraints: [],
    };
  }

  private discoverPredicates(spuriousPaths: ExecutionPath[], func: WasmFunction): string[] {
    const predicates: string[] = [];

    for (const path of spuriousPaths) {
      for (const constraint of path.constraints) {
        const compiled = this.compiler.compileExpr(constraint.condition);
        if (!this.abstractPredicates.includes(compiled)) {
          predicates.push(compiled);
        }
      }
    }

    for (const instr of func.body) {
      if (instr.op === 'br_if') {
        const compiled = 'br_cond';
        if (!predicates.includes(compiled) && !this.abstractPredicates.includes(compiled)) {
          predicates.push(compiled);
        }
      }
      if (instr.op === 'i32.eqz' || instr.op === 'i32.eq' || instr.op === 'i32.ne') {
        const pred = `${instr.op}_pred`;
        if (!predicates.includes(pred) && !this.abstractPredicates.includes(pred)) {
          predicates.push(pred);
        }
      }
    }

    return predicates;
  }

  private refineAbstractState(state: ExecutionState, predicates: string[]): ExecutionState {
    return {
      ...state,
      constraints: predicates.map((p) => ({
        condition: { kind: 'var', name: p, sort: 0 as any } as unknown as Expr,
        branch: 'true' as const,
      })),
    };
  }

  private async executePaths(
    func: WasmFunction,
    initialState: ExecutionState,
    allPaths: ExecutionPath[],
    startTime: number,
  ): Promise<Vulnerability[]> {
    const queue: ExecutionState[] = [initialState];
    const visitedBranches = new Set<string>();
    const joinPoints = new Map<string, ExecutionState[]>();

    while (queue.length > 0 && allPaths.length < this.options.maxPaths) {
      const state = this.options.explorationStrategy === 'bfs' ? queue.shift()! : queue.pop()!;

      if (state.depth > this.options.maxDepth) continue;

      const timeElapsed = Date.now() - startTime;
      if (timeElapsed > this.options.timeoutMs) break;

      const body = func.body;
      const path = this.executeBlock(body, { ...state, pathId: this.nextPathId++ }, 0, allPaths);

      if (path) {
        const feasible = await this.isPathFeasibleSmt(path);
        if (feasible) {
          allPaths.push(path);
        }
      }

      const forkPoints = this.findForkPoints(body, state);
      for (const fork of forkPoints) {
        if (allPaths.length >= this.options.maxPaths) break;

        const branchKey = `${state.pathId}:${fork.label}:${fork.branch}`;
        if (visitedBranches.has(branchKey)) continue;
        visitedBranches.add(branchKey);

        const forkedState = this.forkState(state, fork);
        if (this.options.pathMerging) {
          const joinKey = this.computeJoinKey(fork.label, body);
          if (joinKey) {
            const states = joinPoints.get(joinKey) ?? [];
            states.push(forkedState);
            if (states.length >= 2) {
              const merged = this.mergeStates(states);
              if (merged && (await this.checkFeasibility(merged))) {
                queue.push(merged);
              }
              joinPoints.delete(joinKey);
              continue;
            }
            joinPoints.set(joinKey, states);
          }
        }

        if (await this.checkFeasibility(forkedState)) {
          queue.push(forkedState);
        }
      }

      if (forkPoints.length === 0) {
        const contPath = this.executeContinuation(body, state, allPaths);
        if (contPath) queue.push(contPath);
      }
    }

    return this.detectVulnerabilities(allPaths, func.name);
  }

  async executeSymbolic(
    funcName: string,
    args: Array<{
      name: string;
      type: WasmType;
      symbolic: boolean;
      concreteValue?: number | bigint;
    }>,
    _invs?: string[],
  ): Promise<AnalysisResult> {
    const symbolicArgs: SymbolicValue[] = args.map((arg, i) => {
      if (arg.symbolic) {
        const key = `${funcName}_arg_${i}`;
        let expr: Expr;
        const type = arg.type;
        if (arg.type === 'i32') {
          expr = bv32Var(key);
        } else if (arg.type === 'i64') {
          expr = bv64Var(key);
        } else {
          expr = intVar(key);
        }
        return { expr, type, concrete: arg.concreteValue as number | bigint | undefined };
      } else {
        const type = arg.type;
        const expr: Expr =
          type === 'i32'
            ? bv32Val(Number(arg.concreteValue ?? 0))
            : type === 'i64'
              ? bv64Val(BigInt(arg.concreteValue ?? 0))
              : intVal(Number(arg.concreteValue ?? 0));
        return { expr, type, concrete: arg.concreteValue as number | bigint | undefined };
      }
    });

    return this.executeFunction(funcName, symbolicArgs);
  }

  private computeJoinKey(forkLabel: string, body: WasmInstr[]): string | null {
    for (let i = 0; i < body.length; i++) {
      const instr = body[i];
      if (
        (instr.op === 'if_else' || instr.op === 'block' || instr.op === 'loop') &&
        instr.label === forkLabel.replace(/^(br_if_|if_|select_)/, '')
      ) {
        return `join_${forkLabel}`;
      }
    }
    return null;
  }

  private mergeStates(states: ExecutionState[]): ExecutionState | null {
    if (states.length < 2) return states[0] ?? null;

    const base = states[0];

    for (let i = 1; i < states.length; i++) {
      const other = states[i];
      if (base.stack.length !== other.stack.length) continue;

      const mergedConstraints = [...base.constraints, ...other.constraints];

      const mergedStack: SymbolicValue[] = base.stack.map((sv, idx) => {
        if (idx < other.stack.length) {
          const otherSv = other.stack[idx];
          if (this.exprsEqual(sv.expr, otherSv.expr)) return sv;
          const merged: SymbolicValue = {
            expr: ite_(
              base.constraints[base.constraints.length - 1]?.condition ?? boolVal(true),
              sv.expr,
              otherSv.expr,
            ),
            type: sv.type,
          };
          return merged;
        }
        return sv;
      });

      return {
        ...base,
        stack: mergedStack,
        constraints: mergedConstraints,
        pathId: this.nextPathId++,
      };
    }

    return base;
  }

  private exprsEqual(a: Expr, b: Expr): boolean {
    return this.compiler.compileExpr(a) === this.compiler.compileExpr(b);
  }

  private findForkPoints(
    body: WasmInstr[],
    state: ExecutionState,
  ): Array<{ label: string; branch: 'true' | 'false' }> {
    const forks: Array<{ label: string; branch: 'true' | 'false' }> = [];

    for (let i = 0; i < body.length; i++) {
      const instr = body[i];
      if (instr.op === 'br_if') {
        forks.push({ label: `br_if_${i}`, branch: 'true' });
        forks.push({ label: `br_if_${i}`, branch: 'false' });
      } else if (instr.op === 'if_else') {
        forks.push({ label: `if_${i}`, branch: 'true' });
        forks.push({ label: `if_${i}`, branch: 'false' });
      } else if (instr.op === 'select') {
        forks.push({ label: `select_${i}`, branch: 'true' });
        forks.push({ label: `select_${i}`, branch: 'false' });
      }
    }

    return forks;
  }

  private forkState(
    state: ExecutionState,
    fork: { label: string; branch: 'true' | 'false' },
  ): ExecutionState {
    return {
      ...state,
      depth: state.depth + 1,
      constraints: [
        ...state.constraints,
        {
          condition: fork.branch === 'true' ? boolVal(true) : boolVal(false),
          branch: fork.branch as 'true' | 'false',
        },
      ],
      pathId: this.nextPathId++,
      pc: state.pc + 1,
    };
  }

  private async isPathFeasibleSmt(path: ExecutionPath): Promise<boolean> {
    if (path.constraints.length === 0) return true;

    const allConstraints = path.constraints.map((c) => this.compiler.compileExpr(c.condition));
    const query = [
      '(set-logic QF_BV)',
      ...allConstraints.map((c) => `(assert ${c})`),
      '(check-sat)',
    ].join('\n');

    try {
      const result = await this.solver.solve(query, 5000);
      return result.sat !== false;
    } catch {
      return true;
    }
  }

  private async checkFeasibility(state: ExecutionState): Promise<boolean> {
    if (!this.options.concolicTesting) return true;
    if (state.constraints.length === 0) return true;

    const allConstraints = state.constraints.map((c) => this.compiler.compileExpr(c.condition));
    const query = [
      '(set-logic QF_BV)',
      ...allConstraints.map((c) => `(assert ${c})`),
      '(check-sat)',
    ].join('\n');

    try {
      const result = await this.solver.solve(query, 2000);
      return result.sat !== false;
    } catch {
      return true;
    }
  }

  private makePath(
    state: ExecutionState,
    execState: SymbolicState,
    terminated: ExecutionPath['terminated'],
    error?: string,
  ): ExecutionPath {
    return {
      state: {
        ...state,
        callDepth: execState.callDepth,
        reentrantCalls: execState.reentrantCalls,
        constraints: execState.constraints,
      },
      constraints: execState.constraints,
      result: execState.stack[execState.stack.length - 1],
      terminated,
      error,
    };
  }

  private executeBlock(
    body: WasmInstr[],
    state: ExecutionState,
    depth: number,
    allPaths: ExecutionPath[],
  ): ExecutionPath | null {
    const execState: SymbolicState = {
      locals: [...state.locals],
      stack: [...state.stack],
      constraints: [...state.constraints],
      depth: state.depth,
      callDepth: state.callDepth,
      storage: new Map(state.storage),
      events: [...state.events],
      reentrantCalls: new Set(state.reentrantCalls),
    };

    try {
      for (let i = 0; i < body.length; i++) {
        const instr = body[i];

        if (execState.depth > this.options.maxDepth) {
          return this.makePath(state, execState, 'return');
        }

        switch (instr.op) {
          case 'i32.const':
            execState.stack.push({
              expr: bv32Val(instr.value),
              type: 'i32',
              concrete: instr.value,
            });
            break;

          case 'i64.const':
            execState.stack.push({
              expr: bv64Val(instr.value),
              type: 'i64',
              concrete: instr.value,
            });
            break;

          case 'i32.add': {
            const ra = this.popStack(execState);
            const la = this.popStack(execState);
            this.checkOverflowSmt(la, ra, 'add', 'i32', execState, allPaths, state.functionName);
            execState.stack.push({
              expr: add(la.expr, ra.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.sub': {
            const rs = this.popStack(execState);
            const ls = this.popStack(execState);
            this.checkOverflowSmt(ls, rs, 'sub', 'i32', execState, allPaths, state.functionName);
            execState.stack.push({
              expr: sub(ls.expr, rs.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.mul': {
            const rm = this.popStack(execState);
            const lm = this.popStack(execState);
            this.checkOverflowSmt(lm, rm, 'mul', 'i32', execState, allPaths, state.functionName);
            execState.stack.push({
              expr: mul(lm.expr, rm.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.div_s': {
            const rd = this.popStack(execState);
            const ld = this.popStack(execState);
            this.checkDivByZeroSmt(rd, execState, allPaths, state.functionName);
            execState.stack.push({
              expr: div(ld.expr, rd.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.rem_s': {
            const rr = this.popStack(execState);
            const lr = this.popStack(execState);
            this.checkDivByZeroSmt(rr, execState, allPaths, state.functionName);
            execState.stack.push({
              expr: mod(lr.expr, rr.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.eq': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: eq(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.ne': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: neq(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.lt_s': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: lt(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.le_s': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: le(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.gt_s': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: gt(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.ge_s': {
            const r = this.popStack(execState);
            const l = this.popStack(execState);
            execState.stack.push({
              expr: ge(l.expr, r.expr),
              type: 'i32',
            });
            break;
          }

          case 'i32.eqz': {
            const v = this.popStack(execState);
            execState.stack.push({
              expr: eq(v.expr, bv32Val(0)),
              type: 'i32',
            });
            break;
          }

          case 'i64.add': {
            const r64a = this.popStack(execState);
            const l64a = this.popStack(execState);
            this.checkOverflowSmt(
              l64a,
              r64a,
              'add',
              'i64',
              execState,
              allPaths,
              state.functionName,
            );
            execState.stack.push({ expr: add(l64a.expr, r64a.expr), type: 'i64' });
            break;
          }

          case 'i64.sub': {
            const r64s = this.popStack(execState);
            const l64s = this.popStack(execState);
            this.checkOverflowSmt(
              l64s,
              r64s,
              'sub',
              'i64',
              execState,
              allPaths,
              state.functionName,
            );
            execState.stack.push({ expr: sub(l64s.expr, r64s.expr), type: 'i64' });
            break;
          }

          case 'i64.mul': {
            const r64m = this.popStack(execState);
            const l64m = this.popStack(execState);
            this.checkOverflowSmt(
              l64m,
              r64m,
              'mul',
              'i64',
              execState,
              allPaths,
              state.functionName,
            );
            execState.stack.push({ expr: mul(l64m.expr, r64m.expr), type: 'i64' });
            break;
          }

          case 'i64.div_s': {
            const r64d = this.popStack(execState);
            const l64d = this.popStack(execState);
            this.checkDivByZeroSmt(r64d, execState, allPaths, state.functionName);
            execState.stack.push({ expr: div(l64d.expr, r64d.expr), type: 'i64' });
            break;
          }

          case 'i64.rem_s': {
            const r64r = this.popStack(execState);
            const l64r = this.popStack(execState);
            this.checkDivByZeroSmt(r64r, execState, allPaths, state.functionName);
            execState.stack.push({ expr: mod(l64r.expr, r64r.expr), type: 'i64' });
            break;
          }

          case 'i64.eq': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: eq(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.ne': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: neq(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.lt_s': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: lt(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.le_s': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: le(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.gt_s': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: gt(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.ge_s': {
            const r64 = this.popStack(execState);
            const l64 = this.popStack(execState);
            execState.stack.push({ expr: ge(l64.expr, r64.expr), type: 'i32' });
            break;
          }

          case 'i64.eqz': {
            const v = this.popStack(execState);
            execState.stack.push({
              expr: eq(v.expr, bv64Val(0n)),
              type: 'i32',
            });
            break;
          }

          case 'local.get':
            execState.stack.push({ ...execState.locals[instr.idx] });
            break;

          case 'local.set': {
            const val = this.popStack(execState);
            execState.locals[instr.idx] = val;
            break;
          }

          case 'local.tee': {
            const val = this.popStack(execState);
            execState.locals[instr.idx] = val;
            execState.stack.push({ ...val });
            break;
          }

          case 'drop':
            this.popStack(execState);
            break;

          case 'select': {
            const elseV = this.popStack(execState);
            const thenV = this.popStack(execState);
            const cond = this.popStack(execState);
            execState.stack.push({
              expr: ite_(cond.expr, thenV.expr, elseV.expr),
              type: thenV.type,
            });
            break;
          }

          case 'host_fn':
            this.executeHostFunction(
              instr.name,
              instr.args,
              execState,
              allPaths,
              state.functionName,
            );
            break;

          case 'return':
            return this.makePath(state, execState, 'return');

          case 'block': {
            const blockResult = this.executeBlock(
              instr.body,
              { ...state, pc: i, depth: execState.depth + 1 },
              depth + 1,
              allPaths,
            );
            if (blockResult && blockResult.terminated === 'return') {
              return blockResult;
            }
            break;
          }

          case 'loop': {
            if (this.options.invariantInference && this.loopInvariants.has(instr.label)) {
              const inv = this.loopInvariants.get(instr.label)!;
              const invCheck = this.makePath(
                {
                  ...state,
                  constraints: [
                    ...state.constraints,
                    { condition: not_(inv), branch: 'false' as const },
                  ],
                },
                execState,
                'assert_fail',
                `Loop invariant violated: ${instr.label}`,
              );
              allPaths.push(invCheck);
              break;
            }

            for (let iter = 0; iter < this.options.loopUnrollBound; iter++) {
              const loopResult = this.executeBlock(
                instr.body,
                { ...state, pc: i, depth: execState.depth + iter + 1 },
                depth + iter + 1,
                allPaths,
              );
              if (loopResult && loopResult.terminated === 'return') {
                return loopResult;
              }
            }

            if (this.options.invariantInference && this.options.loopUnrollBound > 0) {
              const inferredInv = this.inferLoopInvariant(instr, execState, state);
              if (inferredInv) {
                this.loopInvariants.set(instr.label, inferredInv);
              }
            }
            break;
          }

          case 'if_else': {
            const condVal = execState.stack[execState.stack.length - 1];
            if (condVal.concrete === true || condVal.concrete === undefined) {
              const thenResult = this.executeBlock(
                instr.then,
                { ...state, pc: i, depth: execState.depth + 1 },
                depth + 1,
                allPaths,
              );
              if (thenResult) return thenResult;
            }
            if (instr.else.length > 0) {
              const elseResult = this.executeBlock(
                instr.else,
                { ...state, pc: i, depth: execState.depth + 1 },
                depth + 1,
                allPaths,
              );
              if (elseResult) return elseResult;
            }
            break;
          }

          case 'call': {
            const callee = this.functions.get(instr.funcIdx);
            if (callee) {
              execState.callDepth++;
              const callResult = this.executeBlock(
                callee.body,
                { ...state, pc: i, depth: execState.depth + 1 },
                depth + 1,
                allPaths,
              );
              if (callResult && callResult.result) {
                execState.stack.push(callResult.result);
              }
            }
            break;
          }
        }
      }
    } catch (e: any) {
      return this.makePath(state, execState, 'panic', e.message);
    }

    return this.makePath(state, execState, 'return');
  }

  private inferLoopInvariant(
    _loop: { label: string; body: WasmInstr[] },
    _execState: SymbolicState,
    _state: ExecutionState,
  ): Expr | null {
    return null;
  }

  private executeContinuation(
    _body: WasmInstr[],
    _state: ExecutionState,
    _allPaths: ExecutionPath[],
  ): ExecutionState | null {
    return null;
  }

  private popStack(state: SymbolicState): SymbolicValue {
    const val = state.stack.pop();
    if (!val) throw new Error('Stack underflow');
    return val;
  }

  private makeStubPath(
    state: SymbolicState,
    terminated: ExecutionPath['terminated'],
    error?: string,
  ): ExecutionPath {
    return {
      state: {
        locals: state.locals,
        globals: [],
        stack: state.stack,
        constraints: state.constraints,
        pc: 0,
        depth: 0,
        functionName: '',
        callStack: [],
        pathId: 0,
        storage: state.storage,
        events: state.events,
        callDepth: state.callDepth,
        reentrantCalls: state.reentrantCalls,
      },
      constraints: state.constraints,
      terminated,
      error,
    };
  }

  private async checkOverflowSmt(
    l: SymbolicValue,
    r: SymbolicValue,
    op: string,
    width: string,
    state: SymbolicState,
    allPaths: ExecutionPath[],
    _funcName: string,
  ): Promise<void> {
    const is32 = width === 'i32';

    let overflowCond: Expr | null = null;

    switch (op) {
      case 'add': {
        const maxVal = is32 ? bv32Val(0x7fffffff) : bv64Val(9223372036854775807n);
        const minVal = is32 ? bv32Val(0x80000000) : bv64Val(9223372036854775808n);
        const sum = add(l.expr, r.expr);
        overflowCond = or_(
          and_(gt(l.expr, maxVal), gt(r.expr, maxVal)),
          and_(lt(l.expr, minVal), lt(r.expr, minVal)),
          neq(sub(sum, l.expr), r.expr),
        );
        break;
      }
      case 'sub': {
        const maxVal = is32 ? bv32Val(0x7fffffff) : bv64Val(9223372036854775807n);
        const minVal = is32 ? bv32Val(0x80000000) : bv64Val(9223372036854775808n);
        overflowCond = or_(
          and_(lt(l.expr, minVal), gt(r.expr, intVal(0))),
          and_(gt(l.expr, maxVal), lt(r.expr, intVal(0))),
        );
        break;
      }
      case 'mul': {
        const _negOne = is32 ? bv32Val(0xffffffff) : bv64Val(0xffffffffffffffffn);
        const result = mul(l.expr, r.expr);
        overflowCond = and_(
          neq(l.expr, intVal(0)),
          neq(r.expr, intVal(0)),
          neq(div(result, l.expr), r.expr),
        );
        break;
      }
    }

    if (overflowCond) {
      const overflowState: SymbolicState = {
        ...state,
        constraints: [...state.constraints, { condition: overflowCond, branch: 'true' as const }],
      };
      allPaths.push(this.makeStubPath(overflowState, 'overflow'));
    }
  }

  private async checkDivByZeroSmt(
    divisor: SymbolicValue,
    state: SymbolicState,
    allPaths: ExecutionPath[],
    _funcName: string,
  ): Promise<void> {
    const zeroExpr = divisor.type === 'i32' ? bv32Val(0) : bv64Val(0n);
    const path = this.makeStubPath(
      {
        ...state,
        constraints: [
          ...state.constraints,
          {
            condition: eq(divisor.expr, zeroExpr),
            branch: 'true' as const,
          },
        ],
      },
      'div_by_zero',
    );
    allPaths.push(path);
  }

  private executeHostFunction(
    name: string,
    args: WasmInstr[][],
    state: SymbolicState,
    allPaths: ExecutionPath[],
    funcName: string,
  ): void {
    switch (name) {
      case 'put_contract_data': {
        const key = state.stack.pop();
        const val = state.stack.pop();
        if (key && val) {
          state.storage.set(this.compiler.compileExpr(key.expr), val);
        }
        break;
      }
      case 'get_contract_data': {
        const key = state.stack.pop();
        if (key) {
          const existing = state.storage.get(this.compiler.compileExpr(key.expr));
          if (existing) {
            state.stack.push(existing);
          } else {
            const symVal: SymbolicValue = {
              expr: intVar(`${funcName}_storage_${this.nextPathId++}`),
              type: 'i64',
            };
            state.stack.push(symVal);
          }
        }
        break;
      }
      case 'call_contract': {
        const callee = state.stack.pop();
        const _calleeFn = state.stack.pop();
        state.callDepth++;
        state.reentrantCalls.add(callee ? this.compiler.compileExpr(callee.expr) : 'unknown');

        const symResult: SymbolicValue = {
          expr: intVar(`${funcName}_call_result_${this.nextPathId++}`),
          type: 'i64',
        };
        state.stack.push(symResult);
        break;
      }
      case 'emit_event': {
        const topic = state.stack.pop();
        const data = state.stack.pop();
        state.events.push({
          name: topic ? this.compiler.compileExpr(topic.expr) : 'unknown',
          args: data ? [data] : [],
        });
        break;
      }
      case 'require_auth': {
        break;
      }
      case 'panic_with_error': {
        allPaths.push(this.makeStubPath(state, 'panic', 'Host function panic_with_error'));
        break;
      }
      case 'panic': {
        allPaths.push(this.makeStubPath(state, 'panic', 'Host function panic'));
        break;
      }
      case 'assert': {
        const cond = state.stack.pop();
        const assertState: SymbolicState = {
          ...state,
          constraints: [
            ...state.constraints,
            {
              condition: cond ? not_(cond.expr) : boolVal(true),
              branch: 'false' as const,
            },
          ],
        };
        allPaths.push(this.makeStubPath(assertState, 'assert_fail', 'Assertion violation'));
        break;
      }
      case 'transfer': {
        const _from = state.stack.pop();
        const _to = state.stack.pop();
        const _amount = state.stack.pop();
        break;
      }
      case 'balance': {
        const _addr = state.stack.pop();
        const symBal: SymbolicValue = {
          expr: intVar(`${funcName}_balance_${this.nextPathId++}`),
          type: 'i64',
        };
        state.stack.push(symBal);
        break;
      }
      case 'supply': {
        const symSupply: SymbolicValue = {
          expr: intVar(`${funcName}_supply_${this.nextPathId++}`),
          type: 'i64',
        };
        state.stack.push(symSupply);
        break;
      }
    }
  }

  private detectVulnerabilities(paths: ExecutionPath[], funcName: string): Vulnerability[] {
    const vulnerabilities: Vulnerability[] = [];

    for (const path of paths) {
      switch (path.terminated) {
        case 'assert_fail':
          vulnerabilities.push({
            type: 'assertion_violation',
            severity: 'critical',
            description: `Assertion violation in ${funcName}`,
            functionName: funcName,
            pathId: path.state.pathId,
            witness: path.constraints.map((c) => ({
              function: funcName,
              constraints: this.compiler.compileExpr(c.condition),
            })),
          });
          break;

        case 'overflow':
          vulnerabilities.push({
            type: 'integer_overflow',
            severity: 'high',
            description: `Integer overflow detected in ${funcName}`,
            functionName: funcName,
            pathId: path.state.pathId,
            witness: path.constraints.map((c) => ({
              function: funcName,
              constraints: this.compiler.compileExpr(c.condition),
            })),
          });
          break;

        case 'underflow':
          vulnerabilities.push({
            type: 'integer_underflow',
            severity: 'high',
            description: `Integer underflow detected in ${funcName}`,
            functionName: funcName,
            pathId: path.state.pathId,
            witness: path.constraints.map((c) => ({
              function: funcName,
              constraints: this.compiler.compileExpr(c.condition),
            })),
          });
          break;

        case 'div_by_zero':
          vulnerabilities.push({
            type: 'division_by_zero',
            severity: 'critical',
            description: `Division by zero in ${funcName}`,
            functionName: funcName,
            pathId: path.state.pathId,
            witness: path.constraints.map((c) => ({
              function: funcName,
              constraints: this.compiler.compileExpr(c.condition),
            })),
          });
          break;

        case 'panic':
          vulnerabilities.push({
            type: 'unhandled_error',
            severity: 'high',
            description: `Unhandled panic in ${funcName}: ${path.error ?? 'unknown'}`,
            functionName: funcName,
            pathId: path.state.pathId,
            witness: path.constraints.map((c) => ({
              function: funcName,
              constraints: this.compiler.compileExpr(c.condition),
            })),
          });
          break;
      }
    }

    const revers = this.detectReentrancyVulnerabilities(paths, funcName);
    vulnerabilities.push(...revers);

    return vulnerabilities;
  }

  private detectReentrancyVulnerabilities(
    paths: ExecutionPath[],
    funcName: string,
  ): Vulnerability[] {
    const vulnerabilities: Vulnerability[] = [];
    const callDepths = new Set<number>();
    const reentrantTargets = new Set<string>();

    for (const path of paths) {
      const state = path.state ?? ({} as ExecutionState);
      callDepths.add(state.callDepth ?? 0);
      if (state.reentrantCalls && typeof state.reentrantCalls[Symbol.iterator] === 'function') {
        for (const target of state.reentrantCalls) {
          reentrantTargets.add(target);
        }
      }
    }

    const maxDepth = Math.max(...Array.from(callDepths), 0);
    if (maxDepth >= 2) {
      vulnerabilities.push({
        type: 'reentrancy',
        severity: maxDepth >= 4 ? 'critical' : 'high',
        description: `Cross-contract reentrancy vulnerability in ${funcName}: call depth ${maxDepth} detected across ${reentrantTargets.size} unique targets`,
        functionName: funcName,
        pathId: 0,
        witness: Array.from(reentrantTargets).map((t) => ({
          function: funcName,
          constraints: `call_depth=${maxDepth}, target=${t}`,
        })),
      });
    }

    return vulnerabilities;
  }

  private computeCoverage(paths: ExecutionPath[], func: WasmFunction): Record<string, boolean> {
    const coverage: Record<string, boolean> = {};
    const visited = new Set<number>();

    for (const path of paths) {
      visited.add(path.state.pc);
    }

    for (let i = 0; i < func.body.length; i++) {
      coverage[`instr_${i}_${func.body[i].op}`] = visited.has(i);
    }

    return coverage;
  }

  getStats(): {
    pathsExplored: number;
    maxPaths: number;
    strategies: ExplorationStrategy[];
  } {
    return {
      pathsExplored: this.nextPathId,
      maxPaths: this.options.maxPaths,
      strategies: [this.options.explorationStrategy],
    };
  }
}
