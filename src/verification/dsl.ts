import { z } from 'zod';

export enum Sort {
  Bool = 'Bool',
  Int = 'Int',
  BitVec32 = 'BitVec32',
  BitVec64 = 'BitVec64',
  Address = 'Address',
  Bytes = 'Bytes',
  Array = 'Array',
  Map = 'Map',
}

export enum ArithOp {
  Add = 'add',
  Sub = 'sub',
  Mul = 'mul',
  Div = 'div',
  Mod = 'mod',
  Pow = 'pow',
}

export enum CmpOp {
  Eq = 'eq',
  Neq = 'neq',
  Lt = 'lt',
  Le = 'le',
  Gt = 'gt',
  Ge = 'ge',
}

export enum LogicOp {
  And = 'and',
  Or = 'or',
  Not = 'not',
  Implies = 'implies',
}

export enum Quantifier {
  Forall = 'forall',
  Exists = 'exists',
}

export interface SortedVar {
  name: string;
  sort: Sort;
}

export interface ConstExpr {
  kind: 'const';
  value: string | number | bigint;
  sort: Sort;
}

export interface VarExpr {
  kind: 'var';
  name: string;
  sort: Sort;
}

export interface ArithExpr {
  kind: 'arith';
  op: ArithOp;
  left: Expr;
  right: Expr;
  sort: Sort;
}

export interface CmpExpr {
  kind: 'cmp';
  op: CmpOp;
  left: Expr;
  right: Expr;
  sort: Sort.Bool;
}

export interface LogicExpr {
  kind: 'logic';
  op: LogicOp;
  args: Expr[];
  sort: Sort.Bool;
}

export interface QuantifierExpr {
  kind: 'quantifier';
  quantifier: Quantifier;
  vars: SortedVar[];
  body: Expr;
  sort: Sort.Bool;
}

export interface IteExpr {
  kind: 'ite';
  cond: Expr;
  then: Expr;
  else_: Expr;
  sort: Sort;
}

export interface FnAppExpr {
  kind: 'fn_app';
  fn: string;
  args: Expr[];
  sort: Sort;
}

export interface SelectExpr {
  kind: 'select';
  array: Expr;
  index: Expr;
  sort: Sort;
}

export interface StoreExpr {
  kind: 'store';
  array: Expr;
  index: Expr;
  value: Expr;
  sort: Sort;
}

export interface BvExpr {
  kind: 'bv';
  op: string;
  args: Expr[];
  width: 32 | 64;
  sort: Sort;
}

export interface CastExpr {
  kind: 'cast';
  expr: Expr;
  targetSort: Sort;
}

export type Expr =
  | ConstExpr
  | VarExpr
  | ArithExpr
  | CmpExpr
  | LogicExpr
  | QuantifierExpr
  | IteExpr
  | FnAppExpr
  | SelectExpr
  | StoreExpr
  | BvExpr
  | CastExpr;

export type PropertyKind = 'invariant' | 'precondition' | 'postcondition' | 'temporal';

export interface Specification {
  name: string;
  contract: string;
  properties: Property[];
  imports?: string[];
}

export interface Property {
  name: string;
  kind: PropertyKind;
  description?: string;
  formula: Expr;
  functions?: string[];
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

export function invariant(
  name: string,
  formula: Expr,
  opts?: { description?: string; severity?: Property['severity'] },
): Property {
  return { name, kind: 'invariant', formula, ...opts };
}

export function precondition(
  name: string,
  formula: Expr,
  functions?: string[],
  opts?: { description?: string },
): Property {
  return { name, kind: 'precondition', formula, functions, ...opts };
}

export function postcondition(
  name: string,
  formula: Expr,
  functions?: string[],
  opts?: { description?: string },
): Property {
  return { name, kind: 'postcondition', formula, functions, ...opts };
}

export function temporal(
  name: string,
  formula: Expr,
  opts?: { description?: string; severity?: Property['severity'] },
): Property {
  return { name, kind: 'temporal', formula, ...opts };
}

export function spec(
  name: string,
  contract: string,
  properties: Property[],
  opts?: { imports?: string[] },
): Specification {
  return { name, contract, properties, ...opts };
}

export function prop(name: string, formula: Expr): Property {
  return { name, kind: 'invariant', formula };
}

export function addressExpr(name: string): VarExpr {
  return { kind: 'var', name, sort: Sort.Address };
}

export function intVar(name: string): VarExpr {
  return { kind: 'var', name, sort: Sort.Int };
}

export function bv32Var(name: string): VarExpr {
  return { kind: 'var', name, sort: Sort.BitVec32 };
}

export function bv64Var(name: string): VarExpr {
  return { kind: 'var', name, sort: Sort.BitVec64 };
}

export function boolVar(name: string): VarExpr {
  return { kind: 'var', name, sort: Sort.Bool };
}

export function intVal(n: number | bigint): ConstExpr {
  return { kind: 'const', value: n, sort: Sort.Int };
}

export function boolVal(b: boolean): ConstExpr {
  return { kind: 'const', value: b ? 1 : 0, sort: Sort.Bool };
}

export function bv32Val(n: number): ConstExpr {
  return { kind: 'const', value: n >>> 0, sort: Sort.BitVec32 };
}

export function bv64Val(n: bigint): ConstExpr {
  return { kind: 'const', value: n, sort: Sort.BitVec64 };
}

export function add(left: Expr, right: Expr): ArithExpr {
  return { kind: 'arith', op: ArithOp.Add, left, right, sort: Sort.Int };
}

export function sub(left: Expr, right: Expr): ArithExpr {
  return { kind: 'arith', op: ArithOp.Sub, left, right, sort: Sort.Int };
}

export function mul(left: Expr, right: Expr): ArithExpr {
  return { kind: 'arith', op: ArithOp.Mul, left, right, sort: Sort.Int };
}

export function div(left: Expr, right: Expr): ArithExpr {
  return { kind: 'arith', op: ArithOp.Div, left, right, sort: Sort.Int };
}

export function mod(left: Expr, right: Expr): ArithExpr {
  return { kind: 'arith', op: ArithOp.Mod, left, right, sort: Sort.Int };
}

export function eq(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Eq, left, right, sort: Sort.Bool };
}

export function neq(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Neq, left, right, sort: Sort.Bool };
}

export function lt(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Lt, left, right, sort: Sort.Bool };
}

export function le(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Le, left, right, sort: Sort.Bool };
}

export function gt(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Gt, left, right, sort: Sort.Bool };
}

export function ge(left: Expr, right: Expr): CmpExpr {
  return { kind: 'cmp', op: CmpOp.Ge, left, right, sort: Sort.Bool };
}

export function and_(...args: Expr[]): LogicExpr {
  return { kind: 'logic', op: LogicOp.And, args, sort: Sort.Bool };
}

export function or_(...args: Expr[]): LogicExpr {
  return { kind: 'logic', op: LogicOp.Or, args, sort: Sort.Bool };
}

export function not_(expr: Expr): LogicExpr {
  return { kind: 'logic', op: LogicOp.Not, args: [expr], sort: Sort.Bool };
}

export function implies_(ante: Expr, conseq: Expr): LogicExpr {
  return { kind: 'logic', op: LogicOp.Implies, args: [ante, conseq], sort: Sort.Bool };
}

export function forall_(vars: SortedVar[], body: Expr): QuantifierExpr {
  return { kind: 'quantifier', quantifier: Quantifier.Forall, vars, body, sort: Sort.Bool };
}

export function exists_(vars: SortedVar[], body: Expr): QuantifierExpr {
  return { kind: 'quantifier', quantifier: Quantifier.Exists, vars, body, sort: Sort.Bool };
}

export function ite_(cond: Expr, then: Expr, else_: Expr): IteExpr {
  const thenSort = 'sort' in then ? ((then as any).sort as Sort) : Sort.Int;
  return { kind: 'ite', cond, then, else_, sort: thenSort };
}

export function fnApp(fn: string, args: Expr[], sort: Sort): FnAppExpr {
  return { kind: 'fn_app', fn, args, sort };
}

export function select_(array: Expr, index: Expr): SelectExpr {
  return { kind: 'select', array, index, sort: Sort.Int };
}

export function store_(array: Expr, index: Expr, value: Expr): StoreExpr {
  return { kind: 'store', array, index, value, sort: Sort.Array };
}

export function bvOp(op: string, args: Expr[], width: 32 | 64): BvExpr {
  return { kind: 'bv', op, args, width, sort: width === 32 ? Sort.BitVec32 : Sort.BitVec64 };
}

export function cast(expr: Expr, targetSort: Sort): CastExpr {
  return { kind: 'cast', expr, targetSort };
}

export function sum(arr: Expr, range: { from: Expr; to: Expr }): Expr {
  const idx = intVar('_sum_idx');
  return fnApp('sum', [arr, range.from, range.to], Sort.Int);
}

export function len(arr: Expr): Expr {
  return fnApp('len', [arr], Sort.Int);
}

export const TOTAL_SUPPLY = (totalSupply: Expr, balances: Expr): Expr =>
  eq(totalSupply, sum(balances, { from: intVal(0), to: len(balances) }));

export const BALANCE_PRESERVING_TRANSFER = (
  fromBal: Expr,
  toBal: Expr,
  amount: Expr,
  fromBalAfter: Expr,
  toBalAfter: Expr,
): Expr =>
  and_(
    eq(fromBalAfter, sub(fromBal, amount)),
    eq(toBalAfter, add(toBal, amount)),
    ge(fromBal, amount),
  );

export const NO_REENTRANCY = (callDepth: Expr): Expr => lt(callDepth, intVal(1));

export const SAFE_MATH = (result: Expr, a: Expr, b: Expr, op: ArithOp): Expr => {
  switch (op) {
    case ArithOp.Add:
      return and_(eq(result, add(a, b)), ge(result, a), ge(result, b));
    case ArithOp.Sub:
      return and_(eq(result, sub(a, b)), le(result, a));
    case ArithOp.Mul:
      return eq(result, mul(a, b));
    default:
      return eq(result, add(a, b));
  }
};

export const VERIFIED_CONTRACT_TAG = Symbol('verified_contract');

export interface ContractSpec {
  spec: Specification;
  verified: boolean;
  badge?: VerificationBadge;
  proof?: ProofArtifact;
}

export interface VerificationBadge {
  level: 'gold' | 'silver' | 'bronze';
  issuedAt: string;
  propertiesVerified: number;
  propertiesTotal: number;
}

export interface ProofArtifact {
  solver: string;
  proof: string;
  timeMs: number;
}

export const dslSchema = z.object({
  name: z.string(),
  contract: z.string(),
  properties: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['invariant', 'precondition', 'postcondition', 'temporal']),
      description: z.string().optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
      functions: z.array(z.string()).optional(),
    }),
  ),
});
