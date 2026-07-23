/**
 * Audit PDF Data Loader
 *
 * Fetches all data needed for the PDF report from the database
 * in a single parallelised pass and returns a typed AuditReportData object
 * ready for generateAuditPdf().
 */

import { prismaRead } from '../db';
import {
  type AuditReportData,
  type AuditFindingData,
  type ExternalAuditData,
} from './audit-pdf-report';
import { getFormalVerificationResults } from './formal-verifier';

export async function loadAuditReportData(
  contractAddress: string,
  version?: number,
  lang?: string,
): Promise<AuditReportData | null> {
  // Resolve the certificate — latest published or explicit version
  const certWhere = version
    ? { contractAddress, version }
    : { contractAddress, status: 'published' };

  const cert = await prismaRead.auditCertificate.findFirst({
    where: certWhere,
    orderBy: { version: 'desc' },
  });

  if (!cert) return null;

  // Parallelise all remaining queries
  const [findings, contract, allCerts, dependencyInfo, externalAudits, formalVerifications] =
    await Promise.all([
      // Live findings (authoritative — may differ from JSON snapshot)
      prismaRead.auditFinding.findMany({
        where: { certificateId: cert.id },
        orderBy: { createdAt: 'asc' },
      }),

      // Contract metadata (name etc.)
      prismaRead.contract.findUnique({
        where: { address: contractAddress },
        select: { address: true, name: true, tokenName: true },
      }),

      // Score history — all versions oldest-first for trend line
      prismaRead.auditCertificate.findMany({
        where: { contractAddress },
        orderBy: { version: 'asc' },
        select: { overallScore: true, version: true },
        take: 20,
      }),

      // Dependency counts from ContractFactory
      Promise.all([
        prismaRead.contractFactory.findMany({
          where: { parentContractAddress: contractAddress },
          select: { childContractAddress: true },
          take: 50,
        }),
        prismaRead.contractFactory.findMany({
          where: { childContractAddress: contractAddress },
          select: { parentContractAddress: true },
          take: 5,
        }),
      ]),

      // Verified external audits for this contract
      prismaRead.externalAudit.findMany({
        where: { contractAddress, verificationStatus: 'verified', isPublic: true },
        orderBy: { submittedAt: 'desc' },
        take: 10,
        include: {
          auditor: {
            select: {
              id: true,
              name: true,
              slug: true,
              website: true,
              isVerified: true,
              trustScore: true,
              badgeTier: true,
            },
          },
        },
      }),

      // Formal verification results
      getFormalVerificationResults(contractAddress),
    ]);

  // Shape findings
  const shapedFindings: AuditFindingData[] = findings.map((f) => ({
    id: f.id,
    category: f.category,
    severity: f.severity,
    title: f.title,
    description: f.description,
    detail: f.detail,
    recommendation: f.recommendation,
    status: f.status,
    cweId: f.cweId,
    cvssScore: f.cvssScore,
    txHash: f.txHash,
  }));

  // Score history array (oldest → newest overall scores)
  const scoreHistory = allCerts.map((c) => c.overallScore);

  // Dependency graph
  const [children, parents] = dependencyInfo;
  const depNodes = [
    ...parents.map((p) => ({ address: p.parentContractAddress, role: 'parent' })),
    ...children.slice(0, 20).map((c) => ({ address: c.childContractAddress, role: 'child' })),
  ];

  // Dimension detail scores from the scores JSON blob
  const scoresBlob = cert.scores as Record<
    string,
    { score: number; detail: Record<string, unknown> }
  > | null;

  const dimensionDetails: Record<string, Record<string, unknown>> = {};
  if (scoresBlob) {
    for (const dim of ['security', 'governance', 'economic', 'compliance', 'liquidity']) {
      if (scoresBlob[dim]?.detail) {
        dimensionDetails[dim] = scoresBlob[dim].detail;
      }
    }
  }

  // Shape external audits for PDF
  const shapedExternalAudits: ExternalAuditData[] = externalAudits.map((ea) => ({
    id: ea.id,
    auditorName: ea.auditorName,
    auditorSlug: ea.auditor?.slug ?? null,
    auditorWebsite: ea.auditor?.website ?? null,
    isAuditorVerified: ea.auditor?.isVerified ?? false,
    auditorBadgeTier: ea.auditor?.badgeTier ?? null,
    auditorTrustScore: ea.auditor?.trustScore ?? null,
    reportType: ea.reportType,
    reportUrl: ea.reportUrl ?? null,
    reportHash: ea.reportHash ?? null,
    overallGrade: ea.overallGrade ?? null,
    summary: ea.summary ?? null,
    findingCount: Array.isArray(ea.findings) ? (ea.findings as unknown[]).length : 0,
    findings: (ea.findings ?? []) as Array<{
      severity: string;
      title: string;
      description: string;
      recommendation?: string;
    }>,
    submittedAt: ea.submittedAt,
    verifiedAt: ea.verifiedAt ?? null,
  }));

  return {
    certId: cert.id,
    contractAddress: cert.contractAddress,
    contractName: contract?.name ?? contract?.tokenName ?? null,
    version: cert.version,
    status: cert.status,
    generatedAt: cert.generatedAt,
    expiresAt: cert.expiresAt,
    overallScore: cert.overallScore,
    securityScore: cert.securityScore,
    governanceScore: cert.governanceScore,
    economicScore: cert.economicScore,
    complianceScore: cert.complianceScore,
    liquidityScore: cert.liquidityScore,
    findings: shapedFindings,
    scoreHistory,
    dependencyGraph: {
      childCount: children.length,
      parentCount: parents.length,
      peerCount: 0,
      nodes: depNodes,
    },
    externalAudits: shapedExternalAudits,
    formalVerifications: formalVerifications,
    certificateHash: cert.certificateHash,
    signature: cert.signature,
    publicKey: cert.publicKey,
    signatureAlgorithm: cert.signatureAlgorithm,
    anchorTxHash: cert.anchorTxHash,
    dimensionDetails,
    lang: (lang as 'en' | 'es' | 'ko' | undefined) ?? 'en',
  };
}
