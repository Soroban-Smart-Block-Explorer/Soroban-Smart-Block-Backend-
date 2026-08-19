import { describe, expect, it } from 'vitest';

describe('gas-model', () => {
  describe('DEFAULT_GAS_COST_TABLE', () => {
    it('has positive costs for all CPU ops', async () => {
      const { DEFAULT_GAS_COST_TABLE } = await import('../../src/sandbox/gas-model');
      expect(DEFAULT_GAS_COST_TABLE.cpu.arith).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.cpu.logic).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.cpu.control).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.cpu.div).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.cpu.mul).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.cpu.rem).toBeGreaterThan(0);
    });

    it('has positive costs for memory ops', async () => {
      const { DEFAULT_GAS_COST_TABLE } = await import('../../src/sandbox/gas-model');
      expect(DEFAULT_GAS_COST_TABLE.memory.read_per_byte).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.memory.write_per_byte).toBeGreaterThan(0);
      expect(DEFAULT_GAS_COST_TABLE.memory.grow_per_page).toBeGreaterThan(0);
    });

    it('has positive costs for all host functions', async () => {
      const { DEFAULT_GAS_COST_TABLE } = await import('../../src/sandbox/gas-model');
      for (const cost of Object.values(DEFAULT_GAS_COST_TABLE.host)) {
        expect(cost).toBeGreaterThan(0);
      }
    });
  });

  describe('DEFAULT_GAS_BUDGET', () => {
    it('has reasonable defaults', async () => {
      const { DEFAULT_GAS_BUDGET } = await import('../../src/sandbox/gas-model');
      expect(DEFAULT_GAS_BUDGET.cpuInsnLimit).toBe(10_000_000);
      expect(DEFAULT_GAS_BUDGET.memBytesLimit).toBe(1_048_576);
    });
  });

  describe('estimateTemplateCall', () => {
    it('scales with arg count', async () => {
      const { estimateTemplateCall } = await import('../../src/sandbox/gas-model');
      const e0 = estimateTemplateCall('generic', 0);
      const e3 = estimateTemplateCall('generic', 3);
      expect(e3.cpu).toBe(e0.cpu + 3 * 250);
      expect(e3.mem).toBe(e0.mem + 3 * 128);
    });

    it('returns base values for zero args', async () => {
      const { estimateTemplateCall } = await import('../../src/sandbox/gas-model');
      const e = estimateTemplateCall('generic', 0);
      expect(e.cpu).toBe(1500);
      expect(e.mem).toBe(1024);
    });
  });

  describe('prepayGas', () => {
    it('returns prepay within budget', async () => {
      const { prepayGas } = await import('../../src/sandbox/gas-model');
      const estimate = { cpu: 1000, mem: 500 };
      const prepay = prepayGas(estimate);
      expect(prepay.prepayCpu).toBe(1000);
      expect(prepay.prepayMem).toBe(500);
      expect(prepay.refundCpu).toBe(0);
      expect(prepay.refundMem).toBe(0);
    });

    it('caps at budget limits', async () => {
      const { prepayGas, DEFAULT_GAS_BUDGET } = await import('../../src/sandbox/gas-model');
      const estimate = { cpu: 20_000_000, mem: 2_000_000 };
      const prepay = prepayGas(estimate);
      expect(prepay.prepayCpu).toBe(DEFAULT_GAS_BUDGET.cpuInsnLimit);
      expect(prepay.prepayMem).toBe(DEFAULT_GAS_BUDGET.memBytesLimit);
    });
  });

  describe('refundGas', () => {
    it('refunds unused gas', async () => {
      const { refundGas } = await import('../../src/sandbox/gas-model');
      const prepay = { prepayCpu: 5000, prepayMem: 2000, refundCpu: 0, refundMem: 0 };
      const actual = { cpu: 3000, mem: 1500 };
      const refund = refundGas(prepay, actual);
      expect(refund.refundCpu).toBe(2000);
      expect(refund.refundMem).toBe(500);
    });

    it('does not refund negative', async () => {
      const { refundGas } = await import('../../src/sandbox/gas-model');
      const prepay = { prepayCpu: 1000, prepayMem: 500, refundCpu: 0, refundMem: 0 };
      const actual = { cpu: 1500, mem: 600 };
      const refund = refundGas(prepay, actual);
      expect(refund.refundCpu).toBe(0);
      expect(refund.refundMem).toBe(0);
    });
  });

  describe('consumeGas', () => {
    it('reports over-budget correctly', async () => {
      const { consumeGas } = await import('../../src/sandbox/gas-model');
      const prepay = { prepayCpu: 1000, prepayMem: 500, refundCpu: 0, refundMem: 0 };
      const actual = { cpu: 1500, mem: 600 };
      const result = consumeGas(prepay, actual);
      expect(result.cpuUsed).toBe(1500);
      expect(result.memUsed).toBe(600);
      expect(result.cpuOverBudget).toBe(true);
      expect(result.memOverBudget).toBe(true);
    });

    it('reports under-budget correctly', async () => {
      const { consumeGas } = await import('../../src/sandbox/gas-model');
      const prepay = { prepayCpu: 5000, prepayMem: 2000, refundCpu: 0, refundMem: 0 };
      const actual = { cpu: 3000, mem: 1500 };
      const result = consumeGas(prepay, actual);
      expect(result.cpuOverBudget).toBe(false);
      expect(result.memOverBudget).toBe(false);
    });
  });

  describe('calculateGasUsed', () => {
    it('sums CPU costs by op category', async () => {
      const { calculateGasUsed, DEFAULT_GAS_COST_TABLE } =
        await import('../../src/sandbox/gas-model');
      const ops = {
        cpuArith: 10,
        cpuLogic: 5,
        cpuControl: 3,
        cpuDiv: 2,
        cpuMul: 4,
        cpuRem: 1,
        memReadBytes: 100,
        memWriteBytes: 50,
        memGrowPages: 1,
        hostCalls: {
          get_contract_data: 2,
          put_contract_data: 1,
        } as Record<string, number>,
      };
      const gas = calculateGasUsed(ops);
      expect(gas.cpu).toBe(
        10 * DEFAULT_GAS_COST_TABLE.cpu.arith +
          5 * DEFAULT_GAS_COST_TABLE.cpu.logic +
          3 * DEFAULT_GAS_COST_TABLE.cpu.control +
          2 * DEFAULT_GAS_COST_TABLE.cpu.div +
          4 * DEFAULT_GAS_COST_TABLE.cpu.mul +
          1 * DEFAULT_GAS_COST_TABLE.cpu.rem +
          2 * DEFAULT_GAS_COST_TABLE.host.get_contract_data +
          1 * DEFAULT_GAS_COST_TABLE.host.put_contract_data,
      );
      expect(gas.mem).toBe(
        100 * DEFAULT_GAS_COST_TABLE.memory.read_per_byte +
          50 * DEFAULT_GAS_COST_TABLE.memory.write_per_byte +
          1 * DEFAULT_GAS_COST_TABLE.memory.grow_per_page,
      );
    });

    it('handles zero ops', async () => {
      const { calculateGasUsed } = await import('../../src/sandbox/gas-model');
      const ops = {
        cpuArith: 0,
        cpuLogic: 0,
        cpuControl: 0,
        cpuDiv: 0,
        cpuMul: 0,
        cpuRem: 0,
        memReadBytes: 0,
        memWriteBytes: 0,
        memGrowPages: 0,
        hostCalls: {},
      };
      const gas = calculateGasUsed(ops);
      expect(gas.cpu).toBe(0);
      expect(gas.mem).toBe(0);
    });
  });
});
