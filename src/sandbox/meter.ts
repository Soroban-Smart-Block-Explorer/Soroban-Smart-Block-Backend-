import { CallOutcome } from './runtime';
import { estimateTemplateCall, prepayGas, refundGas } from './gas-model';

export interface CallMetrics {
  cpuInsnUsed: number;
  memBytesUsed: number;
  readBytes: number;
  writeBytes: number;
  prepayCpu: number;
  prepayMem: number;
  refundCpu: number;
  refundMem: number;
}

export function buildCallMetrics(
  outcome: Pick<CallOutcome, 'cpuInsnUsed' | 'memBytesUsed' | 'readBytes' | 'writeBytes'>,
): CallMetrics {
  const estimate = estimateTemplateCall('generic', 0);
  const prepay = prepayGas(estimate, DEFAULT_GAS_BUDGET);
  const refund = refundGas(prepay, { cpu: outcome.cpuInsnUsed, mem: outcome.memBytesUsed });

  return {
    cpuInsnUsed: outcome.cpuInsnUsed,
    memBytesUsed: outcome.memBytesUsed,
    readBytes: outcome.readBytes,
    writeBytes: outcome.writeBytes,
    prepayCpu: prepay.prepayCpu,
    prepayMem: prepay.prepayMem,
    refundCpu: refund.refundCpu,
    refundMem: refund.refundMem,
  };
}

export function serializeMetrics(metrics: CallMetrics): Record<string, unknown> {
  return {
    cpuInsnUsed: metrics.cpuInsnUsed,
    memBytesUsed: metrics.memBytesUsed,
    readBytes: metrics.readBytes,
    writeBytes: metrics.writeBytes,
    prepayCpu: metrics.prepayCpu,
    prepayMem: metrics.prepayMem,
    refundCpu: metrics.refundCpu,
    refundMem: metrics.refundMem,
  };
}

export function formatMetricsForDebug(metrics: CallMetrics): string {
  return (
    `cpu=${metrics.cpuInsnUsed}/${metrics.prepayCpu} (refund ${metrics.refundCpu}) ` +
    `mem=${metrics.memBytesUsed}/${metrics.prepayMem} (refund ${metrics.refundMem}) ` +
    `io=r${metrics.readBytes}/w${metrics.writeBytes}`
  );
}
