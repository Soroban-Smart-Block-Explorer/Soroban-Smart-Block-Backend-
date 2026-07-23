import { SmtSolver } from './smt-solver';
import { type WasmFunction, type WasmInstr } from './symbolic-executor';

export interface GasCost {
  cpuInsn: number;
  memBytes: number;
  ledgerOps: number;
}

export interface GasResult {
  functionName: string;
  worstCaseCpu: number;
  worstCaseMem: number;
  worstCaseLedgerOps: number;
  averageCaseCpu: number;
  paths: Array<{
    pathId: number;
    cpuCost: number;
    memCost: number;
    constraints: string;
    isWorstCase: boolean;
  }>;
  hotspots: Array<{
    instruction: string;
    cost: number;
    context: string;
  }>;
  estimatedFee: string;
}

const INSTR_COST: Record<string, number> = {
  'i32.add': 1,
  'i32.sub': 1,
  'i32.mul': 2,
  'i32.div_s': 10,
  'i32.rem_s': 10,
  'i32.eq': 1,
  'i32.ne': 1,
  'i32.lt_s': 1,
  'i32.le_s': 1,
  'i32.gt_s': 1,
  'i32.ge_s': 1,
  'i32.eqz': 1,
  'i64.add': 1,
  'i64.sub': 1,
  'i64.mul': 2,
  'i64.div_s': 10,
  'i64.rem_s': 10,
  'i64.eq': 1,
  'i64.ne': 1,
  'i64.lt_s': 1,
  'i64.le_s': 1,
  'i64.gt_s': 1,
  'i64.ge_s': 1,
  'i64.eqz': 1,
  'local.get': 1,
  'local.set': 1,
  'local.tee': 1,
  'global.get': 1,
  'global.set': 1,
  'i32.const': 1,
  'i64.const': 1,
  block: 1,
  loop: 2,
  br: 2,
  br_if: 2,
  return: 1,
  call: 20,
  drop: 1,
  select: 2,
  host_fn: 100,
};

const HOST_FN_COST: Record<string, { cpu: number; mem: number; ledger: number }> = {
  put_contract_data: { cpu: 500, mem: 1024, ledger: 1 },
  get_contract_data: { cpu: 300, mem: 512, ledger: 0 },
  call_contract: { cpu: 2000, mem: 4096, ledger: 0 },
  emit_event: { cpu: 200, mem: 256, ledger: 1 },
  require_auth: { cpu: 1000, mem: 128, ledger: 0 },
  panic: { cpu: 50, mem: 0, ledger: 0 },
  assert: { cpu: 10, mem: 0, ledger: 0 },
  transfer: { cpu: 1500, mem: 512, ledger: 2 },
  mint: { cpu: 2000, mem: 512, ledger: 2 },
  burn: { cpu: 1500, mem: 512, ledger: 2 },
  balance_of: { cpu: 200, mem: 256, ledger: 1 },
  total_supply: { cpu: 100, mem: 128, ledger: 1 },
};

export class GasAnalyzer {
  private solver: SmtSolver;

  constructor(solver: SmtSolver) {
    this.solver = solver;
  }

  async analyzeFunction(func: WasmFunction): Promise<GasResult> {
    const paths: GasResult['paths'] = [];
    const hotspots: GasResult['hotspots'] = [];
    const baseCost = this.computeCost(func.body);

    for (let pathId = 0; pathId < Math.min(baseCost.branchPaths, 10); pathId++) {
      const cpuCost = this.computePathCost(func.body, pathId, 'cpu');
      const memCost = this.computePathCost(func.body, pathId, 'mem');

      paths.push({
        pathId,
        cpuCost,
        memCost,
        constraints: `path_${pathId}`,
        isWorstCase: false,
      });
    }

    this.extractHotspots(func.body, hotspots);

    const worstCaseCpu = Math.max(...paths.map((p) => p.cpuCost), 0);
    const worstCaseMem = Math.max(...paths.map((p) => p.memCost), 0);
    const worstCaseLedgerOps = this.computeLedgerOps(func.body);

    const worstPath = paths.find((p) => p.cpuCost === worstCaseCpu);
    if (worstPath) worstPath.isWorstCase = true;

    const avgCpu =
      paths.length > 0
        ? Math.round(paths.reduce((s, p) => s + p.cpuCost, 0) / paths.length)
        : worstCaseCpu;

    const estimatedFee = this.estimateFee(worstCaseCpu, worstCaseMem, worstCaseLedgerOps);

    return {
      functionName: func.name,
      worstCaseCpu,
      worstCaseMem,
      worstCaseLedgerOps,
      averageCaseCpu: avgCpu,
      paths,
      hotspots,
      estimatedFee,
    };
  }

  private computeCost(body: WasmInstr[]): { total: number; branchPaths: number } {
    let total = 0;
    let branchPaths = 1;

    for (const instr of body) {
      total += INSTR_COST[instr.op] ?? 5;

      if (instr.op === 'if_else') {
        const thenCost = this.computeCost(instr.then);
        const elseCost = this.computeCost(instr.else);
        total += Math.max(thenCost.total, elseCost.total);
        branchPaths += thenCost.branchPaths + elseCost.branchPaths;
      } else if (instr.op === 'block') {
        const blockCost = this.computeCost(instr.body);
        total += blockCost.total;
        branchPaths += blockCost.branchPaths;
      } else if (instr.op === 'loop') {
        total += 20;
        branchPaths += 5;
      }
    }

    return { total, branchPaths };
  }

  private computePathCost(body: WasmInstr[], pathId: number, metric: 'cpu' | 'mem'): number {
    let cost = 0;

    for (const instr of body) {
      if (instr.op === 'host_fn') {
        const hostCost = HOST_FN_COST[instr.name];
        if (hostCost) {
          cost += metric === 'cpu' ? hostCost.cpu : hostCost.mem;
        } else {
          cost += metric === 'cpu' ? 100 : 256;
        }
      } else if (instr.op === 'if_else') {
        const branchPath = pathId % 2;
        if (branchPath === 0 && instr.then.length > 0) {
          cost += this.computePathCost(instr.then, pathId, metric);
        } else if (instr.else.length > 0) {
          cost += this.computePathCost(instr.else, pathId, metric);
        }
      } else if (instr.op === 'block') {
        cost += this.computePathCost(instr.body, pathId, metric);
      } else if (instr.op === 'loop') {
        cost += this.computePathCost(instr.body, pathId, metric) * 3;
      } else {
        cost += metric === 'cpu' ? (INSTR_COST[instr.op] ?? 5) : 0;
      }
    }

    return cost;
  }

  private computeLedgerOps(body: WasmInstr[]): number {
    let ops = 0;

    for (const instr of body) {
      if (instr.op === 'host_fn') {
        const hostCost = HOST_FN_COST[instr.name];
        if (hostCost) ops += hostCost.ledger;
      } else if (instr.op === 'block') {
        ops += this.computeLedgerOps(instr.body);
      } else if (instr.op === 'if_else') {
        ops += Math.max(this.computeLedgerOps(instr.then), this.computeLedgerOps(instr.else));
      } else if (instr.op === 'loop') {
        ops += this.computeLedgerOps(instr.body) * 3;
      }
    }

    return ops;
  }

  private extractHotspots(body: WasmInstr[], hotspots: GasResult['hotspots']): void {
    for (const instr of body) {
      const baseCost = INSTR_COST[instr.op] ?? 5;
      if (instr.op === 'host_fn') {
        const hostCost = HOST_FN_COST[instr.name];
        if (hostCost && hostCost.cpu > 500) {
          hotspots.push({
            instruction: `host_fn:${instr.name}`,
            cost: hostCost.cpu,
            context: `Host function call to ${instr.name}`,
          });
        }
      } else if (instr.op === 'call') {
        hotspots.push({
          instruction: 'call',
          cost: INSTR_COST.call,
          context: `Cross-contract call (idx: ${instr.funcIdx})`,
        });
      } else if (instr.op === 'loop') {
        hotspots.push({
          instruction: 'loop',
          cost: 20,
          context: 'Loop (multiplied by iteration count)',
        });
        this.extractHotspots(instr.body, hotspots);
      } else if (instr.op === 'block') {
        this.extractHotspots(instr.body, hotspots);
      } else if (instr.op === 'if_else') {
        this.extractHotspots(instr.then, hotspots);
        this.extractHotspots(instr.else, hotspots);
      } else if (baseCost > 5) {
        hotspots.push({
          instruction: instr.op,
          cost: baseCost,
          context: `Instruction at cost ${baseCost}`,
        });
      }
    }
  }

  private estimateFee(cpu: number, mem: number, ledger: number): string {
    const cpuFee = cpu * 100;
    const memFee = mem * 1;
    const ledgerFee = ledger * 5000;
    const total = cpuFee + memFee + ledgerFee;
    const totalStroops = BigInt(total);
    return `${totalStroops.toString()} stroops (${(Number(totalStroops) / 1e7).toFixed(7)} XLM)`;
  }
}
