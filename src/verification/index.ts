export * from './dsl';
export * from './spec-compiler';
export * from './smt-solver';
export * from './symbolic-executor';
export * from './concolic-executor';
export * from './reentrancy-analyzer';
export * from './gas-analyzer';
export * from './verifier';
export * from './badge-system';
export * from './exploit-trace-generator';
export * from './wasm-cfg-extractor';

import { createSolver } from './smt-solver';
import { createVerifier } from './verifier';
import { globalBadgeSystem } from './badge-system';

export const verification = {
  verifier: createVerifier,
  solver: createSolver,
  badgeSystem: globalBadgeSystem,
  createSolver,
  createVerifier,
};

export default verification;
