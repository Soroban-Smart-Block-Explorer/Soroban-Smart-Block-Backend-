import { SorobanDataBuilder, SorobanRpc } from '@stellar/stellar-sdk';

const LIMITS = {
  cpuInstructions: 100_000_000,
  memBytes: 40 * 1024 * 1024,
  ledgerReadBytes: 200 * 1024,
  ledgerWriteBytes: 66 * 1024,
  ledgerReadEntries: 40,
  ledgerWriteEntries: 25,
} as const;

export interface ResourceMetric {
  label: string;
  value: number;
  limit: number;
  unit: string;
  pct: number;
  human: string;
}

export interface FormattedFootprint {
  minResourceFee: string;
  metrics: ResourceMetric[];
  summary: string;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function metric(label: string, value: number, limit: number, unit: string): ResourceMetric {
  const pct = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 0;
  const display = unit === 'bytes' ? fmtBytes(value) : value.toLocaleString();
  const limitDisplay = unit === 'bytes' ? fmtBytes(limit) : limit.toLocaleString();
  return {
    label,
    value,
    limit,
    unit,
    pct,
    human: `Uses ${pct}% of maximum ${label.toLowerCase()} (${display} / ${limitDisplay})`,
  };
}

export function formatFootprint(
  sim: SorobanRpc.Api.SimulateTransactionSuccessResponse,
): FormattedFootprint {
  const resources = (sim.transactionData as SorobanDataBuilder).build().resources();
  const cpuInsns = Number(resources.instructions());
  const memBytes = Number((sim.cost as SorobanRpc.Api.Cost).memBytes);
  const readBytes = Number(resources.readBytes());
  const writeBytes = Number(resources.writeBytes());
  const readEntries =
    (sim.transactionData as SorobanDataBuilder).getReadOnly().length +
    (sim.transactionData as SorobanDataBuilder).getReadWrite().length;
  const writeEntries = (sim.transactionData as SorobanDataBuilder).getReadWrite().length;

  const metrics: ResourceMetric[] = [
    metric('CPU Instructions', cpuInsns, LIMITS.cpuInstructions, 'instructions'),
    metric('RAM Allocation', memBytes, LIMITS.memBytes, 'bytes'),
    metric('Ledger Read Bytes', readBytes, LIMITS.ledgerReadBytes, 'bytes'),
    metric('Ledger Write Bytes', writeBytes, LIMITS.ledgerWriteBytes, 'bytes'),
    metric('Ledger Read Entries', readEntries, LIMITS.ledgerReadEntries, 'entries'),
    metric('Ledger Write Entries', writeEntries, LIMITS.ledgerWriteEntries, 'entries'),
  ];

  const worst = metrics.reduce((a, b) => (a.pct >= b.pct ? a : b));
  const summary =
    worst.pct >= 80
      ? `⚠️  High resource usage: ${worst.label} at ${worst.pct}% of limit`
      : `Resource usage nominal — highest is ${worst.label} at ${worst.pct}% of limit`;

  return { minResourceFee: sim.minResourceFee, metrics, summary };
}
