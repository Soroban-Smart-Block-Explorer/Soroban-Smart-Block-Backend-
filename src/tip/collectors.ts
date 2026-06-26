/**
 * Threat collectors: CVE (NVD), GitHub Security Advisories, on-chain bridge,
 * and community / manual submission ingestion.
 */
import axios from 'axios';
import { prismaRead as prisma } from '../db';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ─── NVD CVE collector ────────────────────────────────────────────────────────

const NVD_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

export async function fetchCves(
  keywordSearch = 'soroban OR stellar smart contract',
): Promise<number> {
  const src = await db.vulnerabilitySource.upsert({
    where: { name: 'NVD_CVE' },
    update: {},
    create: { name: 'NVD_CVE', sourceType: 'cve', feedUrl: NVD_BASE },
  });

  const resp = await axios.get(NVD_BASE, {
    params: { keywordSearch, resultsPerPage: 50 },
    timeout: 15_000,
  });

  const items: any[] = resp.data?.vulnerabilities ?? [];
  let imported = 0;

  for (const { cve } of items) {
    const cveId: string = cve.id;
    const desc: string = cve.descriptions?.find((d: any) => d.lang === 'en')?.value ?? cveId;
    const cvss: number | undefined =
      cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore ??
      cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseScore;
    const severity = cvssToSeverity(cvss);

    await db.threatAdvisory.upsert({
      where: { cveId },
      update: { cvssScore: cvss, severity, updatedAt: new Date() },
      create: {
        title: cveId,
        description: desc,
        severity,
        cvssScore: cvss,
        cveId,
        sourceId: src.id,
        affectedContracts: [],
        affectedChains: ['stellar'],
        mitigations: [],
        tags: ['cve', 'nvd'],
        publishedAt: cve.published ? new Date(cve.published) : undefined,
      },
    });
    imported++;
  }

  await db.vulnerabilitySource.update({
    where: { id: src.id },
    data: { lastFetchAt: new Date() },
  });

  return imported;
}

// ─── GitHub Security Advisory (GHSA) collector ───────────────────────────────

const GHSA_GQL = 'https://api.github.com/graphql';

export async function fetchGhsa(token?: string): Promise<number> {
  const src = await db.vulnerabilitySource.upsert({
    where: { name: 'GHSA' },
    update: {},
    create: { name: 'GHSA', sourceType: 'ghsa', feedUrl: GHSA_GQL },
  });

  const query = `{ securityAdvisories(first: 50, classifications: [GENERAL]) {
    nodes { ghsaId summary severity cvss { score } publishedAt
      references { url } vulnerabilities(first: 5) { nodes { package { name ecosystem } } } }
  } }`;

  const resp = await axios.post(
    GHSA_GQL,
    { query },
    { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 15_000 },
  );

  const nodes: any[] = resp.data?.data?.securityAdvisories?.nodes ?? [];
  let imported = 0;

  for (const node of nodes) {
    await db.threatAdvisory.upsert({
      where: { ghsaId: node.ghsaId },
      update: { updatedAt: new Date() },
      create: {
        title: node.ghsaId,
        description: node.summary ?? '',
        severity: (node.severity ?? 'UNKNOWN').toLowerCase(),
        cvssScore: node.cvss?.score,
        ghsaId: node.ghsaId,
        sourceId: src.id,
        affectedContracts: [],
        affectedChains: ['stellar'],
        mitigations: [],
        tags: ['ghsa', 'github'],
        publishedAt: node.publishedAt ? new Date(node.publishedAt) : undefined,
        externalUrl: node.references?.[0]?.url,
      },
    });
    imported++;
  }

  await db.vulnerabilitySource.update({
    where: { id: src.id },
    data: { lastFetchAt: new Date() },
  });

  return imported;
}

// ─── On-chain detector bridge ─────────────────────────────────────────────────
// Reads flash-loan alerts and protocol-guard events already stored by the indexer
// and promotes them to ThreatAdvisory records.

export async function ingestOnChainAlerts(): Promise<number> {
  const src = await db.vulnerabilitySource.upsert({
    where: { name: 'ON_CHAIN' },
    update: {},
    create: { name: 'ON_CHAIN', sourceType: 'onchain' },
  });

  // Flash-loan alerts
  const flashTxs = await (prisma as any).transaction.findMany({
    where: { flashLoanAlert: true },
    select: { hash: true, contractAddress: true, ledgerCloseTime: true },
    take: 100,
    orderBy: { ledgerCloseTime: 'desc' },
  });

  let imported = 0;
  for (const tx of flashTxs) {
    const title = `Flash-loan attack detected (${tx.hash.slice(0, 10)}…)`;
    const existing = await db.threatAdvisory.findFirst({ where: { title } });
    if (existing) continue;

    await db.threatAdvisory.create({
      data: {
        title,
        description: `On-chain flash-loan pattern detected in tx ${tx.hash}`,
        severity: 'high',
        affectedContracts: tx.contractAddress ? [tx.contractAddress] : [],
        affectedChains: ['stellar'],
        mitigations: ['Review contract for reentrancy', 'Add flash-loan guards'],
        sourceId: src.id,
        tags: ['flash-loan', 'on-chain'],
        publishedAt: tx.ledgerCloseTime,
      },
    });
    imported++;
  }

  await db.vulnerabilitySource.update({
    where: { id: src.id },
    data: { lastFetchAt: new Date() },
  });

  return imported;
}

// ─── Community / manual submission handler ────────────────────────────────────

export interface ManualSubmission {
  title: string;
  description: string;
  severity: string;
  cvssScore?: number;
  affectedContracts?: string[];
  affectedChains?: string[];
  mitigations?: string[];
  tags?: string[];
  externalUrl?: string;
  submittedBy: string;
}

export async function submitManual(data: ManualSubmission): Promise<string> {
  const src = await db.vulnerabilitySource.upsert({
    where: { name: 'COMMUNITY' },
    update: {},
    create: { name: 'COMMUNITY', sourceType: 'manual' },
  });

  const advisory = await db.threatAdvisory.create({
    data: {
      title: data.title,
      description: data.description,
      severity: normaliseSeverity(data.severity),
      cvssScore: data.cvssScore,
      affectedContracts: data.affectedContracts ?? [],
      affectedChains: data.affectedChains ?? ['stellar'],
      mitigations: data.mitigations ?? [],
      tags: [...(data.tags ?? []), 'community'],
      externalUrl: data.externalUrl,
      submittedBy: data.submittedBy,
      sourceId: src.id,
      status: 'open',
    },
  });

  return advisory.id;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cvssToSeverity(score?: number): string {
  if (score === undefined) return 'info';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function normaliseSeverity(s: string): string {
  const v = s.toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info'].includes(v)) return v;
  return 'info';
}
