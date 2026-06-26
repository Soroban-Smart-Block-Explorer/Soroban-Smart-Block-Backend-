import { prismaRead, prismaWrite } from '../../db';
import { recordAudit } from './audit';

const TRAVEL_RULE_THRESHOLD_XLM = 10000;

export interface TravelRuleSubmission {
  txHash: string;
  originatorVasp?: string;
  beneficiaryVasp?: string;
  originatorInfo?: Record<string, unknown>;
  beneficiaryInfo?: Record<string, unknown>;
  transferValue: string;
}

export async function submitTravelRule(data: TravelRuleSubmission): Promise<any> {
  const thresholdExceeded = parseFloat(data.transferValue) >= TRAVEL_RULE_THRESHOLD_XLM;

  const existing = await prismaRead.travelRuleRecord.findUnique({
    where: { txHash: data.txHash },
  });

  if (existing) {
    return prismaWrite.travelRuleRecord.update({
      where: { txHash: data.txHash },
      data: {
        originatorVasp: data.originatorVasp ?? existing.originatorVasp,
        beneficiaryVasp: data.beneficiaryVasp ?? existing.beneficiaryVasp,
        originatorInfo: data.originatorInfo
          ? JSON.parse(JSON.stringify(data.originatorInfo))
          : existing.originatorInfo,
        beneficiaryInfo: data.beneficiaryInfo
          ? JSON.parse(JSON.stringify(data.beneficiaryInfo))
          : existing.beneficiaryInfo,
        transferValue: data.transferValue,
        thresholdExceeded,
        travelRuleStatus: 'compliant',
        verifiedAt: new Date(),
      },
    });
  }

  const result = await prismaWrite.travelRuleRecord.create({
    data: {
      txHash: data.txHash,
      originatorVasp: data.originatorVasp,
      beneficiaryVasp: data.beneficiaryVasp,
      originatorInfo: data.originatorInfo
        ? JSON.parse(JSON.stringify(data.originatorInfo))
        : undefined,
      beneficiaryInfo: data.beneficiaryInfo
        ? JSON.parse(JSON.stringify(data.beneficiaryInfo))
        : undefined,
      transferValue: data.transferValue,
      thresholdExceeded,
      travelRuleStatus: thresholdExceeded ? 'pending_verification' : 'compliant',
    },
  });

  recordAudit({
    action: 'submit_travel_rule',
    resourceType: 'travel_rule_record',
    resourceId: result.id,
    details: { txHash: data.txHash, thresholdExceeded, value: data.transferValue },
  });

  return result;
}

export async function getTravelRule(txHash: string): Promise<any> {
  const record = await prismaRead.travelRuleRecord.findUnique({
    where: { txHash },
  });

  if (!record) {
    return {
      txHash,
      exists: false,
      message: 'No travel rule data found for this transaction',
    };
  }

  return record;
}

export async function getPendingTravelRules(
  limit: number = 50,
  offset: number = 0,
): Promise<{ records: any[]; total: number }> {
  const [records, total] = await Promise.all([
    prismaRead.travelRuleRecord.findMany({
      where: { travelRuleStatus: { in: ['pending_verification', 'missing_info'] } },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prismaRead.travelRuleRecord.count({
      where: { travelRuleStatus: { in: ['pending_verification', 'missing_info'] } },
    }),
  ]);

  return { records, total };
}

export async function getTravelRuleSummary(): Promise<{
  totalRecords: number;
  compliant: number;
  pendingVerification: number;
  nonCompliant: number;
  thresholdExceeded: number;
  lastSubmission: string | null;
}> {
  const [
    totalRecords,
    compliant,
    pendingVerification,
    nonCompliant,
    thresholdExceeded,
    lastSubmission,
  ] = await Promise.all([
    prismaRead.travelRuleRecord.count(),
    prismaRead.travelRuleRecord.count({ where: { travelRuleStatus: 'compliant' } }),
    prismaRead.travelRuleRecord.count({ where: { travelRuleStatus: 'pending_verification' } }),
    prismaRead.travelRuleRecord.count({ where: { travelRuleStatus: 'non_compliant' } }),
    prismaRead.travelRuleRecord.count({ where: { thresholdExceeded: true } }),
    prismaRead.travelRuleRecord.findFirst({
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true },
    }),
  ]);

  return {
    totalRecords,
    compliant,
    pendingVerification,
    nonCompliant,
    thresholdExceeded,
    lastSubmission: lastSubmission?.submittedAt.toISOString() ?? null,
  };
}
