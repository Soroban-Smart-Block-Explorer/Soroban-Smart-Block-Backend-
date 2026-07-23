import { SmtSolver } from './smt-solver';
import {
  SymbolicExecutor,
  type WasmFunction,
  type AnalysisResult,
} from './symbolic-executor';

export interface ConcreteValue {
  type: 'i32' | 'i64' | 'address';
  value: number | bigint | string;
}

export interface TestCase {
  args: ConcreteValue[];
  expectedResult?: ConcreteValue;
  coverage: string[];
  constraints: string[];
}

export class ConcolicExecutor {
  private symExec: SymbolicExecutor;
  private solver: SmtSolver;

  constructor(solver: SmtSolver) {
    this.solver = solver;
    this.symExec = new SymbolicExecutor(solver, {
      concolicTesting: true,
      maxPaths: 100,
    });
  }

  async explore(
    funcName: string,
    functions: WasmFunction[],
    concreteSeeds: ConcreteValue[][] = [],
  ): Promise<{
    analysis: AnalysisResult;
    testCases: TestCase[];
    seedsUsed: number;
  }> {
    this.symExec.loadContract(functions);

    const testCases: TestCase[] = [];

    for (const seed of concreteSeeds) {
      const args = seed.map((cv) => {
        switch (cv.type) {
          case 'i32':
            return {
              name: 'arg',
              type: 'i32' as const,
              symbolic: false,
              concreteValue: BigInt(cv.value as number),
            };
          case 'i64':
            return {
              name: 'arg',
              type: 'i64' as const,
              symbolic: false,
              concreteValue: BigInt(cv.value as number),
            };
          case 'address':
            return {
              name: 'arg',
              type: 'i64' as const,
              symbolic: false,
              concreteValue: BigInt(String(cv.value).length),
            };
        }
      });

      const result = await this.symExec.executeFunction(funcName, []);

      const constraints = result.pathConstraints;

      testCases.push({
        args: seed,
        coverage: Object.entries(result.coverage)
          .filter(([, v]) => v)
          .map(([k]) => k),
        constraints,
      });
    }

    const analysis = await this.symExec.executeSymbolic(
      funcName,
      functions
        .find((f) => f.name === funcName)
        ?.params.map((p, i) => ({
          name: p.name,
          type: p.type as 'i32' | 'i64',
          symbolic: true,
        })) ?? [],
    );

    const symbolicPaths = analysis.pathConstraints;
    for (const path of symbolicPaths) {
      const solverQuery = `(set-logic QF_BV)\n(declare-const x (_ BitVec 32))\n(assert ${path})\n(check-sat)\n(get-model)`;
      try {
        const result = await this.solver.solve(solverQuery, 5000);
        if (result.sat === true && result.model) {
          const concreteArgs: ConcreteValue[] = Object.entries(result.model).map(([name, mv]) => ({
            type: mv.sort.includes('32') ? ('i32' as const) : ('i64' as const),
            value: parseInt(mv.value.replace(/[^0-9-]/g, ''), 10) || 0,
          }));
          if (concreteArgs.length > 0) {
            testCases.push({
              args: concreteArgs,
              coverage: [],
              constraints: [path],
            });
          }
        }
      } catch {
        // skip infeasible paths
      }
    }

    return {
      analysis,
      testCases,
      seedsUsed: concreteSeeds.length,
    };
  }
}
