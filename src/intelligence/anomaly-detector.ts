import { prisma } from '../db';
import { detectAnomalousPatterns, detectAdminFunctions } from './heuristic-classifier';

export interface AnomalyReport {
  address: string;
  flags: AnomalyFlag[];
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

export interface AnomalyFlag {
  type: AnomalyType;
  message: string;
  detail?: string;
}

export type AnomalyType =
  | 'suspicious_function_name'
  | 'excessive_admin_functions'
  | 'no_contract_spec'
  | 'impersonation_risk'
  | 'no_transfer_guard'
  | 'unverified_contract';

export async function detectAnomalies(
  address: string,
  functionNames: string[],
  hasContractSpec: boolean,
): Promise<AnomalyReport> {
  const flags: AnomalyFlag[] = [];

  const suspicious = detectAnomalousPatterns(functionNames);
  for (const msg of suspicious) {
    flags.push({ type: 'suspicious_function_name', message: msg });
  }

  const adminFns = detectAdminFunctions(functionNames);
  if (adminFns.length > 3) {
    flags.push({
      type: 'excessive_admin_functions',
      message: `Contract exposes ${adminFns.length} admin/privileged functions`,
      detail: adminFns.join(', '),
    });
  }

  if (!hasContractSpec) {
    flags.push({
      type: 'no_contract_spec',
      message: 'Contract has no on-chain ABI spec (contractspecv0 section missing)',
    });
  }

  const transferFns = functionNames.filter((f) => /transfer/i.test(f));
  if (transferFns.length > 0) {
    const hasGuard = functionNames.some((f) => /auth|require_auth|check_auth/i.test(f));
    if (!hasGuard) {
      flags.push({
        type: 'no_transfer_guard',
        message: 'Transfer function detected without obvious auth guard pattern',
      });
    }
  }

  await checkImpersonation(address, functionNames, flags);

  const severity = computeSeverity(flags);
  return { address, flags, severity };
}

async function checkImpersonation(
  address: string,
  functionNames: string[],
  flags: AnomalyFlag[],
): Promise<void> {
  try {
    const knownContracts = await prisma.contract.findMany({
      where: { address: { not: address }, name: { not: null } },
      select: { address: true, name: true, abi: true },
      take: 50,
    });

    for (const known of knownContracts) {
      const knownFns: string[] = [];
      if (known.abi && typeof known.abi === 'object') {
        const abi = known.abi as any;
        if (Array.isArray(abi.functions)) {
          for (const f of abi.functions) {
            if (f.name) knownFns.push(f.name);
          }
        }
      }
      if (knownFns.length === 0) continue;

      const overlap = functionNames.filter((f) => knownFns.includes(f)).length;
      const similarity = overlap / Math.max(knownFns.length, functionNames.length);

      if (similarity >= 0.85 && overlap >= 4) {
        flags.push({
          type: 'impersonation_risk',
          message: `High function signature similarity to known contract "${known.name}" (${Math.round(similarity * 100)}%)`,
          detail: known.address,
        });
        break;
      }
    }
  } catch {
    // DB unavailable — skip impersonation check
  }
}

function computeSeverity(flags: AnomalyFlag[]): AnomalyReport['severity'] {
  if (flags.some((f) => f.type === 'suspicious_function_name' || f.type === 'impersonation_risk')) return 'critical';
  if (flags.some((f) => f.type === 'excessive_admin_functions')) return 'high';
  if (flags.some((f) => f.type === 'no_transfer_guard')) return 'medium';
  if (flags.some((f) => f.type === 'no_contract_spec' || f.type === 'unverified_contract')) return 'low';
  return 'none';
}
