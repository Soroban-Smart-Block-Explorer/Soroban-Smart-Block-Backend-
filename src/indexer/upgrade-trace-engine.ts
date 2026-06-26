import { prismaRead as prisma } from '../db';

export interface ExecutionStep {
  stepNumber: number;
  type: 'upgrade' | 'migrate' | 'auxiliary';
  contractAddress: string;
  functionName: string;
  description: string;
  args?: Record<string, unknown>;
}

export interface UpgradeOrchestration {
  transactionHash: string;
  ledgerSequence: number;
  sourceAccount: string;
  isMultiCallUpgrade: boolean;
  steps: ExecutionStep[];
  auxiliaryContracts: string[];
  totalSteps: number;
  hasDataMigration: boolean;
}

/**
 * Analyze a transaction to detect multi-call upgrade orchestration.
 * Identifies upgrade logic followed by data migration in same transaction.
 */
export async function analyzeUpgradeOrchestration(
  transactionHash: string,
): Promise<UpgradeOrchestration | null> {
  const transaction = await prisma.transaction.findUnique({
    where: { hash: transactionHash },
    include: { events: true },
  });

  if (!transaction) return null;

  const steps: ExecutionStep[] = [];
  const auxiliaryContracts = new Set<string>();
  let stepCounter = 1;
  let hasUpgrade = false;
  let hasMigration = false;

  // Parse function name to detect upgrade patterns
  if (transaction.functionName?.toLowerCase().includes('upgrade')) {
    steps.push({
      stepNumber: stepCounter++,
      type: 'upgrade',
      contractAddress: transaction.contractAddress || '',
      functionName: transaction.functionName,
      description: 'Upgrade Logic',
      args: transaction.functionArgs as Record<string, unknown>,
    });
    hasUpgrade = true;
  }

  // Detect migration patterns in events
  for (const event of transaction.events) {
    const decoded = event.decoded as any;
    if (
      event.eventType === 'custom' &&
      (event.topicSymbol?.toLowerCase().includes('migrate') ||
        decoded?.type?.toLowerCase().includes('migrate'))
    ) {
      steps.push({
        stepNumber: stepCounter++,
        type: 'migrate',
        contractAddress: event.contractAddress,
        functionName: 'storage_migration',
        description: 'Migrate Storage Schema',
        args: decoded?.data,
      });
      hasMigration = true;
    }
  }

  // Detect auxiliary helper contracts
  if (transaction.functionArgs) {
    const args = transaction.functionArgs as Record<string, unknown>;
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.startsWith('C') && value.length === 56) {
        auxiliaryContracts.add(value);
        steps.push({
          stepNumber: stepCounter++,
          type: 'auxiliary',
          contractAddress: value,
          functionName: key,
          description: `Auxiliary Helper: ${key}`,
        });
      }
    }
  }

  const isMultiCall = steps.length > 1 && (hasUpgrade || hasMigration);

  return {
    transactionHash,
    ledgerSequence: transaction.ledgerSequence,
    sourceAccount: transaction.sourceAccount,
    isMultiCallUpgrade: isMultiCall,
    steps,
    auxiliaryContracts: Array.from(auxiliaryContracts),
    totalSteps: steps.length,
    hasDataMigration: hasMigration,
  };
}

/**
 * Flatten combined execution path for a multi-call upgrade transaction.
 */
export function flattenExecutionPath(orchestration: UpgradeOrchestration): string {
  if (!orchestration.isMultiCallUpgrade) {
    return 'Single-call transaction (not a multi-call upgrade)';
  }

  const lines = [
    `Transaction: ${orchestration.transactionHash}`,
    `Ledger: ${orchestration.ledgerSequence}`,
    `Source: ${orchestration.sourceAccount}`,
    `Total Steps: ${orchestration.totalSteps}`,
    '',
  ];

  for (const step of orchestration.steps) {
    lines.push(
      `Step ${step.stepNumber}: ${step.description}`,
      `  Contract: ${step.contractAddress}`,
      `  Function: ${step.functionName}`,
      '',
    );
  }

  if (orchestration.auxiliaryContracts.length > 0) {
    lines.push('Auxiliary Contracts:');
    for (const aux of orchestration.auxiliaryContracts) {
      lines.push(`  - ${aux}`);
    }
  }

  return lines.join('\n');
}

/**
 * Store upgrade orchestration metadata in transaction record.
 */
export async function storeUpgradeOrchestration(
  transactionHash: string,
  orchestration: UpgradeOrchestration,
): Promise<void> {
  const existingTx = await prisma.transaction.findUnique({
    where: { hash: transactionHash },
    select: { functionArgs: true },
  });

  const updateArgs =
    typeof existingTx?.functionArgs === 'object' && existingTx.functionArgs !== null
      ? existingTx.functionArgs
      : {};

  await prisma.transaction.update({
    where: { hash: transactionHash },
    data: {
      functionArgs: {
        ...updateArgs,
        _upgradeOrchestration: {
          isMultiCall: orchestration.isMultiCallUpgrade,
          steps: orchestration.steps.map((s) => ({
            number: s.stepNumber,
            type: s.type,
            description: s.description,
          })),
          auxiliaryContracts: orchestration.auxiliaryContracts,
        },
      },
    },
  });
}
