import { SmtSolver, createSolver, type SolverConfig } from './smt-solver';
import type { SolverResult } from './spec-compiler';
import { SpecCompiler } from './spec-compiler';
import {
  SymbolicExecutor,
  type WasmFunction,
  type AnalysisResult,
  type Vulnerability,
} from './symbolic-executor';
import { ConcolicExecutor, type TestCase } from './concolic-executor';
import { ReentrancyAnalyzer, type ReentrancyAnalysisResult } from './reentrancy-analyzer';
import { GasAnalyzer, type GasResult } from './gas-analyzer';
import {
  type Specification,
  type Property,
  type VerificationBadge,
} from './dsl';
import { logger } from '../logger';

export interface VerificationConfig {
  contractName: string;
  contractAddress: string;
  wasmFunctions: WasmFunction[];
  specifications: Specification[];
  solverConfig?: Partial<SolverConfig>;
  maxPaths?: number;
  timeoutMs?: number;
  generateWitness?: boolean;
  runGasAnalysis?: boolean;
  runConcolicTesting?: boolean;
}

export interface VulnerabilityReport {
  contractName: string;
  contractAddress: string;
  verifiedAt: string;
  summary: {
    totalProperties: number;
    verifiedProperties: number;
    failedProperties: number;
    vulnerabilities: Vulnerability[];
    safetyScore: number;
  };
  propertyResults: Array<{
    property: Property;
    status: 'verified' | 'violated' | 'unknown';
    solverResult?: SolverResult;
    witness?: string[];
    smtQuery?: string;
    executionTimeMs: number;
  }>;
  symbolicAnalysis: AnalysisResult[];
  reentrancyAnalysis: ReentrancyAnalysisResult | null;
  gasAnalysis: GasResult[] | null;
  concolicTestCases: TestCase[];
  badge: VerificationBadge | null;
  ciCompatible: boolean;
}

export interface VerificationJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  report?: VulnerabilityReport;
  error?: string;
  startTime: number;
}

export class Verifier {
  private solver: SmtSolver;
  private symExec: SymbolicExecutor;
  private concolicExec: ConcolicExecutor;
  private reentrancyAnalyzer: ReentrancyAnalyzer;
  private gasAnalyzer: GasAnalyzer;
  private compiler: SpecCompiler;
  private jobs: Map<string, VerificationJob> = new Map();

  constructor(solverConfig?: Partial<SolverConfig>) {
    this.solver = createSolver(solverConfig);
    this.compiler = new SpecCompiler({
      produceProofs: true,
      produceUnsatCores: true,
      incremental: true,
    });
    this.symExec = new SymbolicExecutor(this.solver, {
      maxPaths: 500,
      maxDepth: 100,
      loopUnrollBound: 5,
      abstractionRefinement: true,
      concolicTesting: true,
    });
    this.concolicExec = new ConcolicExecutor(this.solver);
    this.reentrancyAnalyzer = new ReentrancyAnalyzer(this.solver);
    this.gasAnalyzer = new GasAnalyzer(this.solver);
  }

  async verify(config: VerificationConfig): Promise<VulnerabilityReport> {
    const startTime = Date.now();
    const jobId = this.createJob(config.contractName);
    this.updateJob(jobId, { status: 'running', progress: 0 });

    try {
      this.symExec.loadContract(config.wasmFunctions);

      this.updateJob(jobId, { progress: 10 });

      const symbolicResults: AnalysisResult[] = [];
      for (const func of config.wasmFunctions) {
        const result = await this.symExec.executeSymbolic(
          func.name,
          func.params.map((p, i) => ({
            name: p.name,
            type: p.type as 'i32' | 'i64',
            symbolic: true,
          })),
        );
        symbolicResults.push(result);
      }

      this.updateJob(jobId, { progress: 40 });

      const propertyResults: VulnerabilityReport['propertyResults'] = [];
      let verifiedCount = 0;
      let failedCount = 0;

      for (const spec of config.specifications) {
        for (const prop of spec.properties) {
          const propStartTime = Date.now();

          const smtQuery = this.compiler.compile(spec, {
            functionSummaries: this.buildFunctionSummaries(config.wasmFunctions),
          });

          let solverResult: SolverResult | undefined;
          let status: 'verified' | 'violated' | 'unknown' = 'unknown';
          let witness: string[] | undefined;

          try {
            const smtWithPaths = this.embedPathConstraints(smtQuery.smtLib2, symbolicResults);
            solverResult = await this.solver.solve(smtWithPaths, 60000);

            if (solverResult.sat === false) {
              status = 'verified';
              verifiedCount++;
            } else if (solverResult.sat === true) {
              status = 'violated';
              failedCount++;
              witness = this.extractWitness(solverResult, prop, symbolicResults);
            } else {
              status = 'unknown';
            }
          } catch (err: any) {
            logger.warn(`Solver error for property ${prop.name}: ${err.message}`);
            status = 'unknown';
          }

          propertyResults.push({
            property: prop,
            status,
            solverResult,
            witness,
            smtQuery: smtQuery.smtLib2,
            executionTimeMs: Date.now() - propStartTime,
          });
        }
      }

      this.updateJob(jobId, { progress: 60 });

      const reentrancyResult = await this.reentrancyAnalyzer.analyze(
        config.contractAddress,
        config.wasmFunctions,
      );

      this.updateJob(jobId, { progress: 80 });

      let gasResults: GasResult[] | null = null;
      if (config.runGasAnalysis ?? true) {
        gasResults = [];
        for (const func of config.wasmFunctions) {
          const gasResult = await this.gasAnalyzer.analyzeFunction(func);
          gasResults.push(gasResult);
        }
      }

      this.updateJob(jobId, { progress: 85 });

      let concolicTestCases: TestCase[] = [];
      if (config.runConcolicTesting ?? true) {
        const concolicResult = await this.concolicExec.explore(
          config.wasmFunctions[0]?.name ?? 'unknown',
          config.wasmFunctions,
        );
        concolicTestCases = concolicResult.testCases;
      }

      this.updateJob(jobId, { progress: 95 });

      const allVulnerabilities = this.collectVulnerabilities(symbolicResults, reentrancyResult);

      const safetyScore = this.computeOverallSafetyScore(
        propertyResults,
        reentrancyResult.safetyScore,
        allVulnerabilities,
      );

      const badge = this.computeBadge(propertyResults, allVulnerabilities, safetyScore);

      const report: VulnerabilityReport = {
        contractName: config.contractName,
        contractAddress: config.contractAddress,
        verifiedAt: new Date().toISOString(),
        summary: {
          totalProperties: config.specifications.reduce((s, sp) => s + sp.properties.length, 0),
          verifiedProperties: verifiedCount,
          failedProperties: failedCount,
          vulnerabilities: allVulnerabilities,
          safetyScore,
        },
        propertyResults,
        symbolicAnalysis: symbolicResults,
        reentrancyAnalysis: reentrancyResult,
        gasAnalysis: gasResults,
        concolicTestCases,
        badge,
        ciCompatible: true,
      };

      this.updateJob(jobId, { status: 'completed', progress: 100, report });
      return report;
    } catch (err: any) {
      this.updateJob(jobId, { status: 'failed', error: err.message });
      throw err;
    }
  }

  async verifySpecification(
    spec: Specification,
    wasmFunctions: WasmFunction[],
    contractAddress: string,
  ): Promise<{
    status: 'verified' | 'violated' | 'unknown';
    solverResult?: SolverResult;
    smtQuery?: string;
  }> {
    const smtQuery = this.compiler.compile(spec);
    const executor = new SymbolicExecutor(this.solver);
    executor.loadContract(wasmFunctions);

    const result = await this.solver.solve(smtQuery.smtLib2, 60000);

    let status: 'verified' | 'violated' | 'unknown' = 'unknown';
    if (result.sat === false) status = 'verified';
    else if (result.sat === true) status = 'violated';

    return { status, solverResult: result, smtQuery: smtQuery.smtLib2 };
  }

  createJob(name: string): string {
    const id = `verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: VerificationJob = {
      id,
      status: 'pending',
      progress: 0,
      startTime: Date.now(),
    };
    this.jobs.set(id, job);
    return id;
  }

  getJob(id: string): VerificationJob | undefined {
    return this.jobs.get(id);
  }

  private updateJob(id: string, update: Partial<VerificationJob>): void {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, update);
    }
  }

  private buildFunctionSummaries(functions: WasmFunction[]): Map<string, string> {
    const summaries = new Map<string, string>();
    for (const func of functions) {
      const summary = this.buildFunctionSmtSummary(func);
      summaries.set(func.name, summary);
    }
    return summaries;
  }

  private buildFunctionSmtSummary(func: WasmFunction): string {
    const params = func.params.map((p) => `(${p.name} (_ BitVec 64))`).join(' ');
    return `(define-fun ${func.name} (${params}) (_ BitVec 64) #x0000000000000000)`;
  }

  private embedPathConstraints(smtQuery: string, symbolicResults: AnalysisResult[]): string {
    let query = smtQuery;

    for (const result of symbolicResults) {
      for (const pc of result.pathConstraints) {
        if (pc && pc.length > 0) {
          query += `\n(assert ${pc})\n`;
        }
      }
    }

    return query;
  }

  private extractWitness(
    solverResult: SolverResult,
    prop: Property,
    symbolicResults: AnalysisResult[],
  ): string[] {
    const witness: string[] = [];
    if (solverResult.model) {
      for (const [name, mv] of Object.entries(solverResult.model)) {
        witness.push(`${name} = ${(mv as any).value}`);
      }
    }
    if (symbolicResults.length > 0) {
      for (const result of symbolicResults) {
        for (const vuln of result.vulnerabilities) {
          witness.push(...vuln.witness.map((w) => w.constraints));
        }
      }
    }
    return witness;
  }

  private collectVulnerabilities(
    symbolicResults: AnalysisResult[],
    reentrancyResult: ReentrancyAnalysisResult,
  ): Vulnerability[] {
    const vulnMap = new Map<string, Vulnerability>();

    for (const result of symbolicResults) {
      for (const vuln of result.vulnerabilities) {
        const key = `${vuln.type}:${vuln.functionName}`;
        if (!vulnMap.has(key)) {
          vulnMap.set(key, vuln);
        }
      }
    }

    for (const vuln of reentrancyResult.vulnerabilities) {
      const key = `${vuln.type}:${vuln.functionName}`;
      if (!vulnMap.has(key)) {
        vulnMap.set(key, vuln);
      }
    }

    return Array.from(vulnMap.values());
  }

  private computeOverallSafetyScore(
    propertyResults: VulnerabilityReport['propertyResults'],
    reentrancyScore: number,
    vulnerabilities: Vulnerability[],
  ): number {
    let score = 100;

    const totalProps = propertyResults.length;
    const failedProps = propertyResults.filter((p) => p.status === 'violated').length;
    const unknownProps = propertyResults.filter((p) => p.status === 'unknown').length;

    score -= (failedProps / Math.max(totalProps, 1)) * 40;
    score -= (unknownProps / Math.max(totalProps, 1)) * 20;

    score = Math.min(score, reentrancyScore);

    for (const vuln of vulnerabilities) {
      switch (vuln.severity) {
        case 'critical':
          score -= 15;
          break;
        case 'high':
          score -= 10;
          break;
        case 'medium':
          score -= 5;
          break;
        case 'low':
          score -= 2;
          break;
      }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private computeBadge(
    propertyResults: VulnerabilityReport['propertyResults'],
    vulnerabilities: Vulnerability[],
    safetyScore: number,
  ): VerificationBadge | null {
    const criticalVulns = vulnerabilities.filter((v) => v.severity === 'critical').length;
    const allVerified = propertyResults.every((p) => p.status === 'verified');

    if (allVerified && safetyScore >= 90 && criticalVulns === 0) {
      return {
        level: 'gold',
        issuedAt: new Date().toISOString(),
        propertiesVerified: propertyResults.filter((p) => p.status === 'verified').length,
        propertiesTotal: propertyResults.length,
      };
    }

    if (safetyScore >= 70 && criticalVulns === 0) {
      return {
        level: 'silver',
        issuedAt: new Date().toISOString(),
        propertiesVerified: propertyResults.filter((p) => p.status === 'verified').length,
        propertiesTotal: propertyResults.length,
      };
    }

    if (safetyScore >= 50) {
      return {
        level: 'bronze',
        issuedAt: new Date().toISOString(),
        propertiesVerified: propertyResults.filter((p) => p.status === 'verified').length,
        propertiesTotal: propertyResults.length,
      };
    }

    return null;
  }
}

export function createVerifier(solverConfig?: Partial<SolverConfig>): Verifier {
  return new Verifier(solverConfig);
}
