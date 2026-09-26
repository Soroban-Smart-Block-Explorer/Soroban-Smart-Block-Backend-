import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const auditReportRouter = Router();

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AuditFinding {
  id: string;
  title: string;
  severity: Severity;
  explanation: string;
  evidence: string[];
}

export interface AuditReport {
  contractAddress: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: Record<Severity, number>;
  findings: AuditFinding[];
  stats: { functions: number; events: number };
  generatedFrom: 'abi+events';
}

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 30,
  high: 15,
  medium: 7,
  low: 3,
  info: 0,
};
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const PRIVILEGED = /^(set_admin|upgrade|mint|burn_from|pause|unpause|set_owner|transfer_ownership|withdraw|set_fee|set_oracle|clawback|freeze|update_wasm)/i;
const EXTERNAL_CALL = /(invoke|call|cross_call|callback|flash|hook)/i;
const ARITH = /^(add|sub|mul|div|mint|deposit|withdraw|swap|scale|multiply)/i;

interface AbiFn {
  name: string;
  inputs: { name?: string; type?: string }[];
}

function extractFunctions(abi: unknown): AbiFn[] {
  const list = Array.isArray(abi)
    ? abi
    : abi && typeof abi === 'object' && Array.isArray((abi as any).functions)
      ? (abi as any).functions
      : [];
  return list
    .filter((f: any) => f && typeof f.name === 'string')
    .map((f: any) => ({ name: f.name, inputs: Array.isArray(f.inputs) ? f.inputs : [] }));
}

/** Deterministic static analysis: same inputs always produce the same report. */
export function generateAuditReport(
  contractAddress: string,
  abi: unknown,
  eventTopics: string[],
): AuditReport {
  const fns = extractFunctions(abi).sort((a, b) => a.name.localeCompare(b.name));
  const topics = new Set(eventTopics);
  const findings: AuditFinding[] = [];
  const evidence = (name: string) => [
    `/api/v1/contracts/${contractAddress}/abi#${encodeURIComponent(name)}`,
  ];

  for (const fn of fns.filter((f) => PRIVILEGED.test(f.name))) {
    const hasAuth = fn.inputs.some((i) => /addr|admin|caller|owner/i.test(`${i.name}${i.type}`));
    findings.push({
      id: `privileged-call:${fn.name}`,
      title: `Privileged function "${fn.name}"`,
      severity: hasAuth ? 'medium' : 'high',
      explanation: hasAuth
        ? 'Privileged entrypoint takes a caller/admin address; verify require_auth is enforced.'
        : 'Privileged entrypoint exposes no caller/admin parameter, so authorization may be missing.',
      evidence: evidence(fn.name),
    });
  }
  for (const fn of fns.filter((f) => EXTERNAL_CALL.test(f.name))) {
    findings.push({
      id: `reentrancy:${fn.name}`,
      title: `Possible reentrancy surface in "${fn.name}"`,
      severity: 'medium',
      explanation:
        'Function name suggests an external call or callback; state must be updated before calling out.',
      evidence: evidence(fn.name),
    });
  }
  for (const fn of fns.filter((f) => ARITH.test(f.name))) {
    const wide = fn.inputs.filter((i) => /^(i|u)(128|256)$/i.test(i.type ?? ''));
    if (wide.length > 0) {
      findings.push({
        id: `overflow:${fn.name}`,
        title: `Unchecked arithmetic risk in "${fn.name}"`,
        severity: 'low',
        explanation: `Accepts ${wide.length} wide integer argument(s); confirm checked arithmetic is used.`,
        evidence: evidence(fn.name),
      });
    }
  }
  if (fns.some((f) => PRIVILEGED.test(f.name)) && ![...topics].some((t) => /admin|upgrade|owner/i.test(t))) {
    findings.push({
      id: 'no-admin-events',
      title: 'Privileged actions are not observable',
      severity: 'low',
      explanation: 'No admin/upgrade/ownership events were observed, which limits monitoring.',
      evidence: [`/api/v1/contracts/${contractAddress}/events`],
    });
  }
  if (fns.length === 0) {
    findings.push({
      id: 'no-abi',
      title: 'No ABI available',
      severity: 'info',
      explanation: 'Static analysis could not run because the contract has no known ABI.',
      evidence: [`/api/v1/contracts/${contractAddress}`],
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.id.localeCompare(b.id),
  );
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  let penalty = 0;
  for (const f of findings) {
    summary[f.severity]++;
    penalty += SEVERITY_PENALTY[f.severity];
  }
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';
  const riskLevel =
    summary.critical > 0 ? 'critical' : summary.high > 0 ? 'high' : summary.medium > 0 ? 'medium' : 'low';

  return {
    contractAddress,
    score,
    grade,
    riskLevel,
    summary,
    findings,
    stats: { functions: fns.length, events: topics.size },
    generatedFrom: 'abi+events',
  };
}

export function renderMarkdown(r: AuditReport): string {
  const lines = [
    `# Audit report: ${r.contractAddress}`,
    '',
    `Score **${r.score}/100** (grade ${r.grade}, risk ${r.riskLevel})`,
    '',
    ...SEVERITY_ORDER.map((s) => `- ${s}: ${r.summary[s]}`),
    '',
    '## Findings',
  ];
  for (const f of r.findings) {
    lines.push('', `### [${f.severity.toUpperCase()}] ${f.title}`, '', f.explanation, '');
    for (const e of f.evidence) lines.push(`- Evidence: ${e}`);
  }
  return lines.join('\n') + '\n';
}

const ADDRESS_RE = /^C[A-Z2-7]{55}$/;

/**
 * GET /audit-reports/:address?format=json|markdown
 */
auditReportRouter.get(
  '/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = String(req.params.address);
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: 'Invalid contract address' });
    }
    const format = String(req.query.format ?? 'json');
    if (format !== 'json' && format !== 'markdown') {
      return res.status(400).json({ error: 'format must be json or markdown' });
    }
    const contract = await prisma.contract.findUnique({ where: { address } });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    const events = await prisma.event.findMany({
      where: { contractAddress: address },
      select: { topicSymbol: true },
      distinct: ['topicSymbol'],
      take: 500,
    });
    const topics = events.map((e: { topicSymbol: string | null }) => e.topicSymbol).filter(
      (t: string | null): t is string => !!t,
    );
    const report = generateAuditReport(address, contract.abi, topics);
    if (format === 'markdown') {
      res.type('text/markdown').send(renderMarkdown(report));
      return;
    }
    res.json(report);
  }),
);
