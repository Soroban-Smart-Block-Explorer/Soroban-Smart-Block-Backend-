export type GasOpCategory =
  | 'cpu_arith'
  | 'cpu_logic'
  | 'cpu_control'
  | 'memory_read'
  | 'memory_write'
  | 'memory_grow'
  | 'host_get_ledger'
  | 'host_put_contract_data'
  | 'host_get_contract_data'
  | 'host_invoke_contract'
  | 'host_events'
  | 'host_auth';

export type HostFunction =
  | 'get_ledger_sequence'
  | 'get_ledger_timestamp'
  | 'get_ledger_network_id'
  | 'get_ledger_protocol_version'
  | 'get_ledger_base_reserve'
  | 'get_contract_instance'
  | 'get_contract_code'
  | 'get_contract_data'
  | 'put_contract_data'
  | 'del_contract_data'
  | 'has_contract_data'
  | 'invoke_contract'
  | 'invoke_host_function'
  | 'emit_event'
  | 'create_contract'
  | 'upload_contract_wasm'
  | 'get_auth_context'
  | 'require_auth'
  | 'require_auth_for_args'
  | 'verify_ed25519_sig'
  | 'verify_soroban_auth'
  | 'crypto_sha256'
  | 'crypto_ed25519_verify'
  | 'crypto_ecdsa_secp256r1_verify';

export interface GasCostTable {
  cpu: {
    arith: number;
    logic: number;
    control: number;
    div: number;
    mul: number;
    rem: number;
  };
  memory: {
    read_per_byte: number;
    write_per_byte: number;
    grow_per_page: number;
  };
  host: Record<HostFunction, number>;
}

export const DEFAULT_GAS_COST_TABLE: GasCostTable = {
  cpu: {
    arith: 1,
    logic: 1,
    control: 2,
    div: 5,
    mul: 3,
    rem: 5,
  },
  memory: {
    read_per_byte: 1,
    write_per_byte: 2,
    grow_per_page: 100,
  },
  host: {
    get_ledger_sequence: 50,
    get_ledger_timestamp: 50,
    get_ledger_network_id: 50,
    get_ledger_protocol_version: 50,
    get_ledger_base_reserve: 50,
    get_contract_instance: 200,
    get_contract_code: 200,
    get_contract_data: 300,
    put_contract_data: 500,
    del_contract_data: 400,
    has_contract_data: 200,
    invoke_contract: 1000,
    invoke_host_function: 500,
    emit_event: 100,
    create_contract: 2000,
    upload_contract_wasm: 5000,
    get_auth_context: 100,
    require_auth: 200,
    require_auth_for_args: 300,
    verify_ed25519_sig: 400,
    verify_soroban_auth: 600,
    crypto_sha256: 300,
    crypto_ed25519_verify: 400,
    crypto_ecdsa_secp256r1_verify: 500,
  },
};

export interface GasBudget {
  cpuInsnLimit: number;
  memBytesLimit: number;
}

export const DEFAULT_GAS_BUDGET: GasBudget = {
  cpuInsnLimit: 10_000_000,
  memBytesLimit: 1_048_576,
};

export interface PrepayResult {
  prepayCpu: number;
  prepayMem: number;
  refundCpu: number;
  refundMem: number;
}

export function prepayGas(
  estimate: { cpu: number; mem: number },
  budget: GasBudget = DEFAULT_GAS_BUDGET,
): PrepayResult {
  const prepayCpu = Math.min(estimate.cpu, budget.cpuInsnLimit);
  const prepayMem = Math.min(estimate.mem, budget.memBytesLimit);
  return {
    prepayCpu,
    prepayMem,
    refundCpu: 0,
    refundMem: 0,
  };
}

export function refundGas(
  prepay: PrepayResult,
  actual: { cpu: number; mem: number },
): PrepayResult {
  const refundCpu = Math.max(0, prepay.prepayCpu - actual.cpu);
  const refundMem = Math.max(0, prepay.prepayMem - actual.mem);
  return {
    prepayCpu: prepay.prepayCpu,
    prepayMem: prepay.prepayMem,
    refundCpu,
    refundMem,
  };
}

export function consumeGas(
  prepay: PrepayResult,
  actual: { cpu: number; mem: number },
): { cpuUsed: number; memUsed: number; cpuOverBudget: boolean; memOverBudget: boolean } {
  const cpuUsed = actual.cpu;
  const memUsed = actual.mem;
  return {
    cpuUsed,
    memUsed,
    cpuOverBudget: cpuUsed > prepay.prepayCpu,
    memOverBudget: memUsed > prepay.prepayMem,
  };
}

export function estimateTemplateCall(
  templateId: string,
  argsCount: number,
): { cpu: number; mem: number } {
  const baseCpu = 1500;
  const perArgCpu = 250;
  const baseMem = 1024;
  const perArgMem = 128;
  return {
    cpu: baseCpu + argsCount * perArgCpu,
    mem: baseMem + argsCount * perArgMem,
  };
}

export function calculateGasUsed(opCounts: {
  cpuArith: number;
  cpuLogic: number;
  cpuControl: number;
  cpuDiv: number;
  cpuMul: number;
  cpuRem: number;
  memReadBytes: number;
  memWriteBytes: number;
  memGrowPages: number;
  hostCalls: Record<HostFunction, number>;
}): { cpu: number; mem: number } {
  const table = DEFAULT_GAS_COST_TABLE;
  let cpu = 0;
  cpu += opCounts.cpuArith * table.cpu.arith;
  cpu += opCounts.cpuLogic * table.cpu.logic;
  cpu += opCounts.cpuControl * table.cpu.control;
  cpu += opCounts.cpuDiv * table.cpu.div;
  cpu += opCounts.cpuMul * table.cpu.mul;
  cpu += opCounts.cpuRem * table.cpu.rem;

  let mem = 0;
  mem += opCounts.memReadBytes * table.memory.read_per_byte;
  mem += opCounts.memWriteBytes * table.memory.write_per_byte;
  mem += opCounts.memGrowPages * table.memory.grow_per_page;

  for (const [fn, count] of Object.entries(opCounts.hostCalls)) {
    cpu += count * table.host[fn as HostFunction];
  }

  return { cpu, mem };
}
