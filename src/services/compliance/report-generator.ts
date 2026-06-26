import { prismaRead, prismaWrite } from '../../db';
import { recordAudit } from './audit';

interface ReportParams {
  reportType: string;
  periodStart: Date;
  periodEnd: Date;
  format?: string;
  address?: string;
  createdBy?: string;
}

export async function generateReport(params: ReportParams): Promise<any> {
  const format = params.format ?? 'pdf';
  const reportType = params.reportType;

  const screeningData = await prismaRead.screeningResult.findMany({
    where: {
      screenedAt: { gte: params.periodStart, lte: params.periodEnd },
      ...(params.address ? { address: params.address } : {}),
    },
    orderBy: { screenedAt: 'desc' },
    take: 10000,
  });

  const totalScreenings = screeningData.length;
  const matches = screeningData.filter((s) => s.status !== 'clear');
  const blocked = screeningData.filter((s) => s.status === 'blocked');
  const highRisk = screeningData.filter((s) => s.status === 'high_risk');
  const falsePositives = screeningData.filter((s) => s.reviewAction === 'false_positive');
  const confirmed = screeningData.filter((s) => s.reviewAction === 'confirmed_positive');

  const matchesByDay = new Map<string, number>();
  const screeningsByDay = new Map<string, number>();
  for (const s of screeningData) {
    const day = s.screenedAt.toISOString().split('T')[0];
    screeningsByDay.set(day, (screeningsByDay.get(day) ?? 0) + 1);
    if (s.status !== 'clear') {
      matchesByDay.set(day, (matchesByDay.get(day) ?? 0) + 1);
    }
  }

  const reportData = {
    reportType,
    periodStart: params.periodStart.toISOString(),
    periodEnd: params.periodEnd.toISOString(),
    generatedAt: new Date().toISOString(),
    summary: {
      totalScreenings,
      totalMatches: matches.length,
      matchRate:
        totalScreenings > 0 ? ((matches.length / totalScreenings) * 100).toFixed(2) : '0.00',
      blockedCount: blocked.length,
      highRiskCount: highRisk.length,
      falsePositives: falsePositives.length,
      confirmedMatches: confirmed.length,
      falsePositiveRate:
        matches.length > 0 ? ((falsePositives.length / matches.length) * 100).toFixed(2) : '0.00',
    },
    matchesByDay: Array.from(matchesByDay.entries()).map(([date, count]) => ({ date, count })),
    screeningsByDay: Array.from(screeningsByDay.entries()).map(([date, count]) => ({
      date,
      count,
    })),
    topMatches: matches.slice(0, 20).map((m) => ({
      address: m.address,
      status: m.status,
      riskScore: m.riskScore,
      matchType: m.matchType,
      screenedAt: m.screenedAt.toISOString(),
      txHash: m.txHash,
    })),
    totalRecords: screeningData.length,
  };

  const report = await prismaWrite.complianceReport.create({
    data: {
      reportType,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      format,
      reportData: JSON.parse(JSON.stringify(reportData)),
      parameters: JSON.parse(JSON.stringify(params)),
      createdBy: params.createdBy,
      fileData: null,
    },
  });

  recordAudit({
    action: 'generate_report',
    resourceType: 'compliance_report',
    resourceId: report.id,
    details: { reportType, periodStart: params.periodStart, periodEnd: params.periodEnd },
  });

  return report;
}

export async function generateDailyReport(): Promise<any> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  return generateReport({
    reportType: 'daily_screening',
    periodStart: startOfDay,
    periodEnd: endOfDay,
  });
}

export async function generateWeeklyReport(): Promise<any> {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const endOfWeek = new Date(startOfWeek.getTime() + 7 * 86400000);

  return generateReport({
    reportType: 'weekly_summary',
    periodStart: startOfWeek,
    periodEnd: endOfWeek,
  });
}

export async function generateMonthlyReport(): Promise<any> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return generateReport({
    reportType: 'monthly_audit',
    periodStart: startOfMonth,
    periodEnd: endOfMonth,
  });
}

export async function generateAddressReport(address: string): Promise<any> {
  const now = new Date();
  const startDate = new Date(now.getTime() - 90 * 86400000);

  return generateReport({
    reportType: 'address_history',
    periodStart: startDate,
    periodEnd: now,
    address,
  });
}

export async function listReports(
  limit: number = 20,
  offset: number = 0,
  reportType?: string,
): Promise<{ reports: any[]; total: number }> {
  const where: any = {};
  if (reportType) where.reportType = reportType;

  const [reports, total] = await Promise.all([
    prismaRead.complianceReport.findMany({
      where,
      orderBy: { generatedAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        reportType: true,
        generatedAt: true,
        periodStart: true,
        periodEnd: true,
        format: true,
        fileUrl: true,
        createdBy: true,
      },
    }),
    prismaRead.complianceReport.count({ where }),
  ]);

  return { reports, total };
}

export async function getReport(id: string): Promise<any> {
  const report = await prismaWrite.complianceReport.findUnique({ where: { id } });
  if (!report) {
    throw new Error(`Report not found: ${id}`);
  }
  return report;
}

export async function generateSarReport(params: {
  subjectAddress: string;
  activityType: string;
  description: string;
  relatedTxHashes?: string[];
  reportedBy?: string;
  filingType?: string;
}): Promise<any> {
  const now = new Date();

  const screeningHistory = await prismaRead.screeningResult.findMany({
    where: { address: params.subjectAddress },
    orderBy: { screenedAt: 'desc' },
    take: 100,
  });

  const sarData = {
    sarId: `SAR_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    filingType: params.filingType ?? 'initial',
    subjectAddress: params.subjectAddress,
    activityType: params.activityType,
    description: params.description,
    relatedTxHashes: params.relatedTxHashes ?? [],
    reportedBy: params.reportedBy,
    filedAt: now.toISOString(),
    screeningHistory: screeningHistory.map((s) => ({
      status: s.status,
      riskScore: s.riskScore,
      matchType: s.matchType,
      screenedAt: s.screenedAt.toISOString(),
    })),
  };

  const report = await prismaWrite.complianceReport.create({
    data: {
      reportType: 'sar',
      periodStart: new Date(now.getTime() - 365 * 86400000),
      periodEnd: now,
      format: 'json',
      reportData: JSON.parse(JSON.stringify(sarData)),
      parameters: JSON.parse(JSON.stringify(params)),
    },
  });

  recordAudit({
    action: 'sar_filing',
    resourceType: 'compliance_report',
    resourceId: report.id,
    details: { subjectAddress: params.subjectAddress, activityType: params.activityType },
  });

  return report;
}

export async function generateRegulatoryReport(params: {
  jurisdiction: string;
  reportType: string;
  periodStart: Date;
  periodEnd: Date;
  template: string;
}): Promise<any> {
  const report = await generateReport({
    reportType: 'regulatory',
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });

  await prismaWrite.complianceReport.update({
    where: { id: report.id },
    data: {
      reportData: {
        ...(report.reportData as any),
        jurisdiction: params.jurisdiction,
        regulatoryTemplate: params.template,
      },
    },
  });

  recordAudit({
    action: 'regulatory_filing',
    resourceType: 'compliance_report',
    resourceId: report.id,
    details: { jurisdiction: params.jurisdiction, template: params.template },
  });

  return report;
}
