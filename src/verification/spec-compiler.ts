import {
  type Expr,
  type Specification,
  type Property,
  Sort,
  ArithOp,
  CmpOp,
  LogicOp,
  Quantifier,
  SortedVar,
} from './dsl';

export interface CompilerOptions {
  logic?: 'QF_BV' | 'QF_ABV' | 'AUFNIRA' | 'ALL';
  produceProofs?: boolean;
  produceUnsatCores?: boolean;
  incremental?: boolean;
}

export interface CompileResult {
  smtLib2: string;
  propertyMapping: Array<{ propertyName: string; smtLabel: string }>;
  declarations: string[];
}

export interface ModelVariable {
  name: string;
  sort: string;
  value: string;
}

export interface SolverResult {
  sat: boolean | null;
  model?: Record<string, ModelVariable>;
  unsatCore?: string[];
  proof?: string;
  timeMs: number;
}

export class SpecCompiler {
  private logic: string;
  private produceProofs: boolean;
  private produceUnsatCores: boolean;
  private incremental: boolean;

  constructor(opts: CompilerOptions = {}) {
    this.logic = opts.logic ?? 'QF_ABV';
    this.produceProofs = opts.produceProofs ?? false;
    this.produceUnsatCores = opts.produceUnsatCores ?? false;
    this.incremental = opts.incremental ?? false;
  }

  compile(spec: Specification, ctx?: { functionSummaries?: Map<string, string> }): CompileResult {
    const lines: string[] = [];
    const propertyMapping: CompileResult['propertyMapping'] = [];
    const declarations: string[] = [];

    lines.push(
      ';',
      `; Specification: ${spec.name}`,
      `; Contract: ${spec.contract}`,
      ';',
      `(set-logic ${this.logic})`,
    );

    if (this.produceProofs) lines.push('(set-option :produce-proofs true)');
    if (this.produceUnsatCores) lines.push('(set-option :produce-unsat-cores true)');
    if (this.incremental) lines.push('(set-option :incremental true)');

    const collectedVars = this.collectVariables(spec.properties);

    for (const v of collectedVars) {
      const decl = this.declareVar(v);
      lines.push(decl);
      declarations.push(decl);
    }

    if (ctx?.functionSummaries) {
      for (const [fn, summary] of ctx.functionSummaries) {
        lines.push(`; function summary for ${fn}`);
        lines.push(summary);
      }
    }

    const contractSym = `contract_${spec.contract.replace(/[^a-zA-Z0-9]/g, '_')}`;
    lines.push(`(declare-const ${contractSym} (_ BitVec 256))`);

    for (const prop of spec.properties) {
      const label = `${spec.name}_${prop.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const smtFormula = this.compileExpr(prop.formula);
      const smt = `(assert (! ${smtFormula} :named ${label}))`;
      lines.push(smt);
      propertyMapping.push({ propertyName: prop.name, smtLabel: label });
    }

    lines.push('(check-sat)');

    if (this.produceProofs) lines.push('(get-proof)');
    if (this.produceUnsatCores) lines.push('(get-unsat-core)');

    if (this.incremental) {
      lines.push('(get-model)');
    }

    return {
      smtLib2: lines.join('\n'),
      propertyMapping,
      declarations,
    };
  }

  compileExpr(expr: Expr): string {
    switch (expr.kind) {
      case 'const': {
        switch (expr.sort) {
          case Sort.Bool:
            return expr.value ? 'true' : 'false';
          case Sort.Int:
            return `(_ bv${BigInt(expr.value).toString()} 256)`;
          case Sort.BitVec32:
            return `(_ bv${Number(expr.value) >>> 0} 32)`;
          case Sort.BitVec64:
            return `(_ bv${BigInt(expr.value).toString(10)} 64)`;
          default:
            return String(expr.value);
        }
      }
      case 'var': {
        const name = this.escape(expr.name);
        switch (expr.sort) {
          case Sort.Bool:
            return name;
          case Sort.Int:
            return name;
          case Sort.BitVec32:
            return name;
          case Sort.BitVec64:
            return name;
          case Sort.Address:
            return name;
          default:
            return name;
        }
      }
      case 'arith': {
        const l = this.compileExpr(expr.left);
        const r = this.compileExpr(expr.right);
        switch (expr.op) {
          case ArithOp.Add:
            return `(bvadd ${l} ${r})`;
          case ArithOp.Sub:
            return `(bvsub ${l} ${r})`;
          case ArithOp.Mul:
            return `(bvmul ${l} ${r})`;
          case ArithOp.Div:
            return `(bvsdiv ${l} ${r})`;
          case ArithOp.Mod:
            return `(bvsmod ${l} ${r})`;
          case ArithOp.Pow:
            return `(bvmul ${l} ${r})`;
          default:
            return `(bvadd ${l} ${r})`;
        }
      }
      case 'cmp': {
        const l = this.compileExpr(expr.left);
        const r = this.compileExpr(expr.right);
        switch (expr.op) {
          case CmpOp.Eq:
            return `(= ${l} ${r})`;
          case CmpOp.Neq:
            return `(not (= ${l} ${r}))`;
          case CmpOp.Lt:
            return `(bvslt ${l} ${r})`;
          case CmpOp.Le:
            return `(bvsle ${l} ${r})`;
          case CmpOp.Gt:
            return `(bvsgt ${l} ${r})`;
          case CmpOp.Ge:
            return `(bvsge ${l} ${r})`;
          default:
            return `(= ${l} ${r})`;
        }
      }
      case 'logic': {
        const args = expr.args.map((a) => this.compileExpr(a));
        switch (expr.op) {
          case LogicOp.And:
            return args.length === 1 ? args[0] : `(and ${args.join(' ')})`;
          case LogicOp.Or:
            return args.length === 1 ? args[0] : `(or ${args.join(' ')})`;
          case LogicOp.Not:
            return `(not ${args[0]})`;
          case LogicOp.Implies:
            return `(=> ${args[0]} ${args[1]})`;
          default:
            return `(and ${args.join(' ')})`;
        }
      }
      case 'quantifier': {
        const q = expr.quantifier === Quantifier.Forall ? 'forall' : 'exists';
        const vars = expr.vars
          .map((v) => `(${this.escape(v.name)} ${this.sortToSmt(v.sort)})`)
          .join(' ');
        const body = this.compileExpr(expr.body);
        return `(${q} (${vars}) ${body})`;
      }
      case 'ite':
        return `(ite ${this.compileExpr(expr.cond)} ${this.compileExpr(expr.then)} ${this.compileExpr(expr.else_)})`;
      case 'fn_app': {
        const args = expr.args.map((a) => this.compileExpr(a));
        return `(${expr.fn} ${args.join(' ')})`;
      }
      case 'select':
        return `(select ${this.compileExpr(expr.array)} ${this.compileExpr(expr.index)})`;
      case 'store':
        return `(store ${this.compileExpr(expr.array)} ${this.compileExpr(expr.index)} ${this.compileExpr(expr.value)})`;
      case 'bv': {
        const args = expr.args.map((a) => this.compileExpr(a));
        return `(bv${expr.op} ${args.join(' ')})`;
      }
      case 'cast': {
        const inner = this.compileExpr(expr.expr);
        switch (expr.targetSort) {
          case Sort.BitVec32:
            return `((_ extract 31 0) ${inner})`;
          case Sort.BitVec64:
            return `((_ extract 63 0) ${inner})`;
          case Sort.Int:
            return `((_ zero_extend 192) ${inner})`;
          default:
            return inner;
        }
      }
      default:
        return 'true';
    }
  }

  private declareVar(v: SortedVar): string {
    const smtSort = this.sortToSmt(v.sort);
    return `(declare-const ${this.escape(v.name)} ${smtSort})`;
  }

  private sortToSmt(sort: Sort): string {
    switch (sort) {
      case Sort.Bool:
        return 'Bool';
      case Sort.Int:
        return '(_ BitVec 256)';
      case Sort.BitVec32:
        return '(_ BitVec 32)';
      case Sort.BitVec64:
        return '(_ BitVec 64)';
      case Sort.Address:
        return '(_ BitVec 256)';
      case Sort.Bytes:
        return '(_ BitVec 512)';
      case Sort.Array:
        return '(Array (_ BitVec 256) (_ BitVec 256))';
      case Sort.Map:
        return '(Array (_ BitVec 256) (_ BitVec 256))';
      default:
        return '(_ BitVec 256)';
    }
  }

  private escape(name: string): string {
    return name.startsWith('|') ? name : `|${name}|`;
  }

  private collectVariables(properties: Property[]): SortedVar[] {
    const varMap = new Map<string, SortedVar>();
    for (const prop of properties) {
      this.collectVarsFromExpr(prop.formula, varMap);
    }
    return Array.from(varMap.values());
  }

  private collectVarsFromExpr(expr: Expr, acc: Map<string, SortedVar>): void {
    switch (expr.kind) {
      case 'var':
        if (!acc.has(expr.name)) {
          acc.set(expr.name, { name: expr.name, sort: expr.sort });
        }
        break;
      case 'fn_app':
        expr.args?.forEach((a) => this.collectVarsFromExpr(a, acc));
        break;
      case 'arith':
        this.collectVarsFromExpr(expr.left, acc);
        this.collectVarsFromExpr(expr.right, acc);
        break;
      case 'cmp':
        this.collectVarsFromExpr(expr.left, acc);
        this.collectVarsFromExpr(expr.right, acc);
        break;
      case 'logic':
        expr.args.forEach((a) => this.collectVarsFromExpr(a, acc));
        break;
      case 'quantifier':
        for (const v of expr.vars) {
          if (!acc.has(v.name)) acc.set(v.name, v);
        }
        this.collectVarsFromExpr(expr.body, acc);
        break;
      case 'ite':
        this.collectVarsFromExpr(expr.cond, acc);
        this.collectVarsFromExpr(expr.then, acc);
        this.collectVarsFromExpr(expr.else_, acc);
        break;
      case 'select':
        this.collectVarsFromExpr(expr.array, acc);
        this.collectVarsFromExpr(expr.index, acc);
        break;
      case 'store':
        this.collectVarsFromExpr(expr.array, acc);
        this.collectVarsFromExpr(expr.index, acc);
        this.collectVarsFromExpr(expr.value, acc);
        break;
      case 'bv':
        expr.args.forEach((a) => this.collectVarsFromExpr(a, acc));
        break;
      case 'cast':
        this.collectVarsFromExpr(expr.expr, acc);
        break;
    }
  }
}
