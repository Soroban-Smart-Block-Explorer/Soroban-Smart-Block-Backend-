/**
 * Audit PDF Report Renderer
 *
 * Generates a professional multi-page PDF audit report with:
 *   Page 1  — Cover: logo block, contract info, overall score badge, QR hint
 *   Page 2  — Executive Summary: key findings, top recommendations
 *   Page 3  — Score Dashboard: radar chart (SVG-style polygons), bar charts, trend
 *   Page 4+ — Findings: every finding with severity chip, CWE, recommendation
 *   Page N  — Category Deep-Dives: one section per dimension
 *   Page N  — Dependency Analysis
 *   Page N  — Certificate & Cryptographic Attestation
 *   Page N  — Appendices: methodology, static analysis, transaction evidence
 *
 * Multi-language: pass `lang` ('en' | 'es' | 'ko') to switch all labels.
 * Uses only the built-in PdfDocument/PdfPage engine — zero external deps.
 */

import { PdfDocument, PdfPage } from './pdf-engine';

// ── Colour palette ─────────────────────────────────────────────────────────────

const C = {
  // Brand
  primary: { r: 30, g: 64, b: 175 }, // deep blue
  accent: { r: 99, g: 179, b: 237 }, // sky blue
  // Risk levels
  low: { r: 34, g: 197, b: 94 }, // green
  medium: { r: 234, g: 179, b: 8 }, // amber
  high: { r: 239, g: 68, b: 68 }, // red
  critical: { r: 127, g: 29, b: 29 }, // dark red
  // Neutrals
  white: { r: 255, g: 255, b: 255 },
  lightGray: { r: 243, g: 244, b: 246 },
  midGray: { r: 156, g: 163, b: 175 },
  darkGray: { r: 55, g: 65, b: 81 },
  black: { r: 17, g: 24, b: 39 },
  // Scores
  scoreA: { r: 34, g: 197, b: 94 },
  scoreB: { r: 132, g: 204, b: 22 },
  scoreC: { r: 234, g: 179, b: 8 },
  scoreD: { r: 249, g: 115, b: 22 },
  scoreF: { r: 239, g: 68, b: 68 },
};

// ── Localisation ───────────────────────────────────────────────────────────────

type Lang = 'en' | 'es' | 'ko';

const I18N: Record<Lang, Record<string, string>> = {
  en: {
    coverTitle: 'Smart Contract Audit Report',
    coverSubtitle: 'Continuous Security & Compliance Assessment',
    execSummary: 'Executive Summary',
    scoreDashboard: 'Score Dashboard',
    findingsSection: 'Findings',
    categorySection: 'Category Analysis',
    dependencySection: 'Dependency Analysis',
    certSection: 'Cryptographic Certificate',
    appendixSection: 'Appendices',
    overallScore: 'Overall Score',
    grade: 'Grade',
    riskLevel: 'Risk Level',
    auditVersion: 'Audit Version',
    generatedOn: 'Generated On',
    expiresOn: 'Expires On',
    contractAddress: 'Contract Address',
    findingCount: 'Total Findings',
    criticalFindings: 'Critical',
    highFindings: 'High',
    mediumFindings: 'Medium',
    lowFindings: 'Low',
    openFindings: 'Open',
    resolvedFindings: 'Resolved',
    severity: 'Severity',
    category: 'Category',
    recommendation: 'Recommendation',
    cweId: 'CWE',
    cvssScore: 'CVSS',
    status: 'Status',
    score: 'Score',
    weight: 'Weight',
    trend: 'Trend',
    dimension: 'Dimension',
    certHash: 'Certificate Hash',
    signature: 'Signature',
    publicKey: 'Public Key',
    algorithm: 'Algorithm',
    anchorTx: 'On-Chain Anchor',
    verifyAt: 'Verify at',
    methodology: 'Methodology',
    staticAnalysis: 'Static Analysis',
    txEvidence: 'Transaction Evidence',
    noFindings: 'No findings in this category.',
    pageOf: 'Page',
    confidential: 'CONFIDENTIAL — FOR AUTHORIZED USE ONLY',
    keyFindings: 'Key Findings',
    topRecommendations: 'Top Recommendations',
    scoreWeights: 'Score Weights',
    notAnchored: 'Not anchored on-chain',
    externalAudits: 'External Audit Reports',
    auditorName: 'Auditor',
    auditorVerified: 'Verified Auditor',
    overallGrade: 'Overall Grade',
    reportType: 'Report Type',
    noExternalAudits: 'No verified external audits on record.',
    trustScore: 'Trust Score',
    badgeTier: 'Badge Tier',
    formalVerif: 'Formal Verification',
    fvTool: 'Tool',
    fvStatus: 'Status',
    fvProperties: 'Properties',
    fvProven: 'Proven',
    fvViolated: 'Violations',
    fvCoverage: 'Coverage',
    noFormalVerif: 'No formal verification results on record.',
    fvCounterExample: 'Counter-examples',
  },
  es: {
    coverTitle: 'Informe de Auditoría de Contrato Inteligente',
    coverSubtitle: 'Evaluación Continua de Seguridad y Cumplimiento',
    execSummary: 'Resumen Ejecutivo',
    scoreDashboard: 'Panel de Puntuación',
    findingsSection: 'Hallazgos',
    categorySection: 'Análisis por Categoría',
    dependencySection: 'Análisis de Dependencias',
    certSection: 'Certificado Criptográfico',
    appendixSection: 'Apéndices',
    overallScore: 'Puntuación General',
    grade: 'Calificación',
    riskLevel: 'Nivel de Riesgo',
    auditVersion: 'Versión de Auditoría',
    generatedOn: 'Generado el',
    expiresOn: 'Vence el',
    contractAddress: 'Dirección del Contrato',
    findingCount: 'Hallazgos Totales',
    criticalFindings: 'Críticos',
    highFindings: 'Altos',
    mediumFindings: 'Medios',
    lowFindings: 'Bajos',
    openFindings: 'Abiertos',
    resolvedFindings: 'Resueltos',
    severity: 'Severidad',
    category: 'Categoría',
    recommendation: 'Recomendación',
    cweId: 'CWE',
    cvssScore: 'CVSS',
    status: 'Estado',
    score: 'Puntuación',
    weight: 'Peso',
    trend: 'Tendencia',
    dimension: 'Dimensión',
    certHash: 'Hash del Certificado',
    signature: 'Firma',
    publicKey: 'Clave Pública',
    algorithm: 'Algoritmo',
    anchorTx: 'Ancla en Cadena',
    verifyAt: 'Verificar en',
    methodology: 'Metodología',
    staticAnalysis: 'Análisis Estático',
    txEvidence: 'Evidencia de Transacciones',
    noFindings: 'Sin hallazgos en esta categoría.',
    pageOf: 'Página',
    confidential: 'CONFIDENCIAL — SOLO PARA USO AUTORIZADO',
    keyFindings: 'Hallazgos Clave',
    topRecommendations: 'Principales Recomendaciones',
    scoreWeights: 'Pesos de Puntuación',
    notAnchored: 'No anclado en cadena',
    externalAudits: 'Informes de Auditoría Externos',
    auditorName: 'Auditor',
    auditorVerified: 'Auditor Verificado',
    overallGrade: 'Calificación General',
    reportType: 'Tipo de Informe',
    noExternalAudits: 'Sin auditorías externas verificadas registradas.',
    trustScore: 'Puntuación de Confianza',
    badgeTier: 'Nivel de Insignia',
    formalVerif: 'Verificación Formal',
    fvTool: 'Herramienta',
    fvStatus: 'Estado',
    fvProperties: 'Propiedades',
    fvProven: 'Probadas',
    fvViolated: 'Violaciones',
    fvCoverage: 'Cobertura',
    noFormalVerif: 'Sin resultados de verificación formal registrados.',
    fvCounterExample: 'Contraejemplos',
  },
  ko: {
    coverTitle: '스마트 계약 감사 보고서',
    coverSubtitle: '지속적 보안 및 규정 준수 평가',
    execSummary: '경영진 요약',
    scoreDashboard: '점수 대시보드',
    findingsSection: '발견 사항',
    categorySection: '카테고리 분석',
    dependencySection: '의존성 분석',
    certSection: '암호화 인증서',
    appendixSection: '부록',
    overallScore: '종합 점수',
    grade: '등급',
    riskLevel: '위험 수준',
    auditVersion: '감사 버전',
    generatedOn: '생성일',
    expiresOn: '만료일',
    contractAddress: '계약 주소',
    findingCount: '총 발견 사항',
    criticalFindings: '치명적',
    highFindings: '높음',
    mediumFindings: '중간',
    lowFindings: '낮음',
    openFindings: '열림',
    resolvedFindings: '해결됨',
    severity: '심각도',
    category: '카테고리',
    recommendation: '권고 사항',
    cweId: 'CWE',
    cvssScore: 'CVSS',
    status: '상태',
    score: '점수',
    weight: '가중치',
    trend: '추세',
    dimension: '차원',
    certHash: '인증서 해시',
    signature: '서명',
    publicKey: '공개 키',
    algorithm: '알고리즘',
    anchorTx: '온체인 앵커',
    verifyAt: '확인 위치',
    methodology: '방법론',
    staticAnalysis: '정적 분석',
    txEvidence: '거래 증거',
    noFindings: '이 카테고리에서 발견 사항 없음.',
    pageOf: '페이지',
    confidential: '기밀 — 인가된 사용자만',
    keyFindings: '주요 발견 사항',
    topRecommendations: '주요 권고 사항',
    scoreWeights: '점수 가중치',
    notAnchored: '온체인 미고정',
    externalAudits: '외부 감사 보고서',
    auditorName: '감사인',
    auditorVerified: '검증된 감사인',
    overallGrade: '전체 등급',
    reportType: '보고서 유형',
    noExternalAudits: '기록된 검증된 외부 감사 없음.',
    trustScore: '신뢰 점수',
    badgeTier: '배지 등급',
    formalVerif: '형식 검증',
    fvTool: '도구',
    fvStatus: '상태',
    fvProperties: '속성',
    fvProven: '증명됨',
    fvViolated: '위반',
    fvCoverage: '커버리지',
    noFormalVerif: '형식 검증 결과 없음.',
    fvCounterExample: '반례',
  },
};

function t(lang: Lang, key: string): string {
  return I18N[lang][key] ?? I18N.en[key] ?? key;
}

// ── Shared drawing helpers ─────────────────────────────────────────────────────

const PAGE_W = 595; // A4
const PAGE_H = 842;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

function riskColor(level: string) {
  if (level === 'low') return C.low;
  if (level === 'medium') return C.medium;
  if (level === 'high') return C.high;
  if (level === 'critical') return C.critical;
  return C.midGray;
}

function sevColor(sev: string) {
  if (sev === 'critical') return C.critical;
  if (sev === 'high') return C.high;
  if (sev === 'medium') return C.medium;
  if (sev === 'low') return C.low;
  return C.midGray;
}

function scoreColor(s: number) {
  if (s >= 85) return C.scoreA;
  if (s >= 70) return C.scoreB;
  if (s >= 55) return C.scoreC;
  if (s >= 40) return C.scoreD;
  return C.scoreF;
}

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}

function riskLabel(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}

/** Header strip at top of every non-cover page. */
function drawHeader(
  page: PdfPage,
  title: string,
  pageNum: number,
  totalPages: number,
  lang: Lang,
): void {
  page.fillColor(C.primary).rect(0, 0, PAGE_W, 36, true);
  page.setFont('bold', 9).fillColor(C.white).text('SOROBAN AUDIT', MARGIN, 23);
  page.setFont('regular', 9).textRight(title, PAGE_W - MARGIN, 23);
  // footer
  page.fillColor(C.lightGray).rect(0, PAGE_H - 28, PAGE_W, 28, true);
  page
    .setFont('regular', 8)
    .fillColor(C.midGray)
    .text(t(lang, 'confidential'), MARGIN, PAGE_H - 10)
    .textRight(`${t(lang, 'pageOf')} ${pageNum} / ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 10);
}

/** Section heading with coloured left bar. */
function drawSectionHeading(page: PdfPage, title: string, y: number): number {
  page.fillColor(C.primary).rect(MARGIN, y, 4, 18, true);
  page
    .setFont('bold', 14)
    .fillColor(C.black)
    .text(title, MARGIN + 10, y + 14);
  return y + 30;
}

/** Two-cell key/value info row. */
function infoRow(
  page: PdfPage,
  label: string,
  value: string,
  x: number,
  y: number,
  colW: number,
): void {
  page.setFont('bold', 9).fillColor(C.darkGray).text(label, x, y);
  page
    .setFont('regular', 9)
    .fillColor(C.black)
    .text(value, x + colW, y);
}

/** Score pill chip (e.g. severity badge). */
function drawChip(
  page: PdfPage,
  label: string,
  x: number,
  y: number,
  col: { r: number; g: number; b: number },
): number {
  const w = label.length * 6 + 14;
  page.fillColor(col).roundRect(x, y - 11, w, 14, 4, true, false);
  page
    .setFont('bold', 8)
    .fillColor(C.white)
    .text(label.toUpperCase(), x + 7, y);
  return x + w + 6;
}

/** Horizontal score bar (label, score 0-100, y pos). Returns new Y. */
function drawScoreBar(
  page: PdfPage,
  label: string,
  score: number,
  y: number,
  barWidth = 200,
): number {
  const filled = Math.round((score / 100) * barWidth);
  const col = scoreColor(score);
  // label
  page
    .setFont('regular', 9)
    .fillColor(C.darkGray)
    .text(label, MARGIN, y + 9);
  // background bar
  page.fillColor(C.lightGray).rect(MARGIN + 120, y, barWidth, 12, true);
  // filled bar
  page.fillColor(col).rect(MARGIN + 120, y, Math.max(4, filled), 12, true);
  // score text
  page
    .setFont('bold', 9)
    .fillColor(C.black)
    .text(`${score}`, MARGIN + 120 + barWidth + 8, y + 9);
  return y + 20;
}

/** Draw a radar chart as a filled polygon. cx,cy = center, radius, 5 dimensions. */
function drawRadarChart(
  page: PdfPage,
  cx: number,
  cy: number,
  radius: number,
  scores: number[], // 5 values 0-100
  labels: string[],
): void {
  const n = scores.length;
  const step = (2 * Math.PI) / n;
  // start at top (-π/2)
  const angle = (i: number) => -Math.PI / 2 + i * step;

  // Grid rings
  for (const ring of [0.25, 0.5, 0.75, 1.0]) {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      pts.push([cx + Math.cos(angle(i)) * radius * ring, cy + Math.sin(angle(i)) * radius * ring]);
    }
    page.fillColor(C.white).strokeColor(C.lightGray).lineWidth(0.5).polygon(pts, false, true);
  }

  // Axis lines
  page.strokeColor(C.lightGray).lineWidth(0.5);
  for (let i = 0; i < n; i++) {
    page.line(cx, cy, cx + Math.cos(angle(i)) * radius, cy + Math.sin(angle(i)) * radius);
  }

  // Score polygon
  const scorePts: [number, number][] = scores.map((s, i) => [
    cx + Math.cos(angle(i)) * radius * (s / 100),
    cy + Math.sin(angle(i)) * radius * (s / 100),
  ]);
  page.fillColor({ r: 30, g: 64, b: 175 }); // primary with opacity approximation
  page.strokeColor(C.primary).lineWidth(1.5).polygon(scorePts, true, true);

  // Dots at vertices
  for (const [px, py] of scorePts) {
    page.fillColor(C.primary).circle(px, py, 3, true, false);
  }

  // Labels
  page.setFont('bold', 8).fillColor(C.darkGray);
  for (let i = 0; i < n; i++) {
    const lx = cx + Math.cos(angle(i)) * (radius + 18);
    const ly = cy + Math.sin(angle(i)) * (radius + 18);
    const label = `${labels[i]} ${scores[i]}`;
    page.textCentered(label, lx - 30, 60, ly + 4);
  }
}

/** Horizontal mini trend line (sparkline) from score array. */
function drawTrendLine(
  page: PdfPage,
  scores: number[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (scores.length < 2) return;
  const step = w / (scores.length - 1);
  const scaleY = (s: number) => y + h - (s / 100) * h;

  page.fillColor(C.lightGray).rect(x, y, w, h, true);

  // Line segments
  page.strokeColor(C.primary).lineWidth(1.5);
  for (let i = 0; i < scores.length - 1; i++) {
    page.line(x + i * step, scaleY(scores[i]), x + (i + 1) * step, scaleY(scores[i + 1]));
  }

  // Dots
  for (let i = 0; i < scores.length; i++) {
    page.fillColor(C.primary).circle(x + i * step, scaleY(scores[i]), 2.5, true, false);
  }
}

// ── Data types ─────────────────────────────────────────────────────────────────

export interface AuditFindingData {
  id: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  detail?: string | null;
  recommendation?: string | null;
  status: string;
  cweId?: string | null;
  cvssScore?: number | null;
  txHash?: string | null;
}

export interface ExternalAuditData {
  id: string;
  auditorName: string;
  auditorSlug: string | null;
  auditorWebsite: string | null;
  isAuditorVerified: boolean;
  auditorBadgeTier: string | null;
  auditorTrustScore: number | null;
  reportType: string;
  reportUrl: string | null;
  reportHash: string | null;
  overallGrade: string | null;
  summary: string | null;
  findingCount: number;
  findings: Array<{
    severity: string;
    title: string;
    description: string;
    recommendation?: string;
  }>;
  submittedAt: Date;
  verifiedAt: Date | null;
}

export interface FormalVerificationData {
  id: string;
  tool: string; // "certora" | "scribble" | "halo2" | "smtchecker" | "manual"
  status: string; // "passed" | "failed" | "timeout" | "unsupported" | "running"
  passed: boolean | null;
  propertyCount: number | null;
  provenCount: number | null;
  violatedCount: number | null;
  unknownCount: number | null;
  coveragePercent: number | null;
  counterExamples: Array<{ property: string; description: string }>;
  reportUrl: string | null;
  durationSeconds: number | null;
  completedAt: Date | null;
}

export interface AuditReportData {
  // Certificate
  certId: string;
  contractAddress: string;
  contractName?: string | null;
  version: number;
  status: string;
  generatedAt: Date;
  expiresAt: Date | null;
  // Scores
  overallScore: number;
  securityScore: number;
  governanceScore: number;
  economicScore: number;
  complianceScore: number;
  liquidityScore: number;
  // Findings
  findings: AuditFindingData[];
  // History (for trend line — most recent N overall scores, oldest first)
  scoreHistory?: number[];
  // Dependency graph snapshot
  dependencyGraph?: {
    childCount: number;
    parentCount: number;
    peerCount: number;
    nodes: Array<{ address: string; role: string }>;
  } | null;
  // Verified external audits
  externalAudits?: ExternalAuditData[];
  // Formal verification results
  formalVerifications?: FormalVerificationData[];
  // Certificate crypto
  certificateHash: string;
  signature: string;
  publicKey: string;
  signatureAlgorithm: string;
  anchorTxHash?: string | null;
  // Dimension detail scores (from `scores` JSON)
  dimensionDetails?: Record<string, Record<string, unknown>> | null;
  // Language
  lang?: Lang;
}

// ── Page builders ──────────────────────────────────────────────────────────────

/** Page 1: Cover */
function buildCoverPage(doc: PdfDocument, data: AuditReportData, lang: Lang): void {
  const page = doc.addPage();
  const grade = scoreGrade(data.overallScore);
  const risk = riskLabel(data.overallScore);
  const scoreCol = scoreColor(data.overallScore);
  const riskCol = riskColor(risk);

  // Full-bleed header block
  page.fillColor(C.primary).rect(0, 0, PAGE_W, 200, true);

  // Title
  page.setFont('bold', 28).fillColor(C.white).textCentered(t(lang, 'coverTitle'), 0, PAGE_W, 80);
  page
    .setFont('regular', 13)
    .fillColor(C.accent)
    .textCentered(t(lang, 'coverSubtitle'), 0, PAGE_W, 108);

  // Score badge (large circle)
  const bx = PAGE_W / 2,
    by = 270;
  page.fillColor(scoreCol).circle(bx, by, 62, true, false);
  page
    .fillColor(C.white)
    .setFont('bold', 36)
    .textCentered(String(data.overallScore), bx - 30, 60, by - 6);
  page.setFont('regular', 11).textCentered(`/ 100`, bx - 20, 40, by + 16);

  // Grade ring
  page.strokeColor(C.white).lineWidth(3).circle(bx, by, 68, false, true);
  page
    .setFont('bold', 22)
    .fillColor(C.white)
    .textCentered(grade, bx - 12, 24, by - 78);

  // Risk label chip
  page.fillColor(riskCol).roundRect(bx - 45, 330, 90, 22, 6, true, false);
  page
    .setFont('bold', 11)
    .fillColor(C.white)
    .textCentered(risk.toUpperCase(), bx - 45, 90, 345);

  // Contract info box
  const infoY = 380;
  page.fillColor(C.lightGray).roundRect(MARGIN, infoY, CONTENT_W, 170, 6, true, false);
  const lh = 26;
  let iy = infoY + 22;
  infoRow(page, t(lang, 'contractAddress'), data.contractAddress, MARGIN + 16, iy, 130);
  iy += lh;
  if (data.contractName) {
    infoRow(page, 'Contract Name', data.contractName, MARGIN + 16, iy, 130);
    iy += lh;
  }
  infoRow(page, t(lang, 'auditVersion'), `v${data.version}`, MARGIN + 16, iy, 130);
  iy += lh;
  infoRow(
    page,
    t(lang, 'generatedOn'),
    data.generatedAt.toISOString().slice(0, 10),
    MARGIN + 16,
    iy,
    130,
  );
  iy += lh;
  infoRow(
    page,
    t(lang, 'expiresOn'),
    data.expiresAt ? data.expiresAt.toISOString().slice(0, 10) : 'N/A',
    MARGIN + 16,
    iy,
    130,
  );

  // Certificate hash (truncated)
  const hashY = infoY + 178;
  page
    .setFont('italic', 8)
    .fillColor(C.midGray)
    .textCentered(
      `${t(lang, 'certHash')}: ${data.certificateHash.slice(0, 32)}...`,
      0,
      PAGE_W,
      hashY,
    );

  // QR prompt
  page
    .setFont('regular', 9)
    .fillColor(C.darkGray)
    .textCentered(
      `${t(lang, 'verifyAt')}: /api/v1/audit/verify/${data.certId}`,
      0,
      PAGE_W,
      hashY + 18,
    );

  // Footer
  page.fillColor(C.lightGray).rect(0, PAGE_H - 28, PAGE_W, 28, true);
  page
    .setFont('regular', 8)
    .fillColor(C.midGray)
    .textCentered(t(lang, 'confidential'), 0, PAGE_W, PAGE_H - 10);

  page.seal();
}

/** Page 2: Executive Summary */
function buildExecSummaryPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'execSummary'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'execSummary'), y);

  // Finding count grid
  const cols = [
    {
      label: t(lang, 'criticalFindings'),
      value: data.findings.filter((f) => f.severity === 'critical').length,
      col: C.critical,
    },
    {
      label: t(lang, 'highFindings'),
      value: data.findings.filter((f) => f.severity === 'high').length,
      col: C.high,
    },
    {
      label: t(lang, 'mediumFindings'),
      value: data.findings.filter((f) => f.severity === 'medium').length,
      col: C.medium,
    },
    {
      label: t(lang, 'lowFindings'),
      value: data.findings.filter((f) => f.severity === 'low').length,
      col: C.low,
    },
    {
      label: t(lang, 'openFindings'),
      value: data.findings.filter((f) => f.status === 'open').length,
      col: C.darkGray,
    },
    {
      label: t(lang, 'resolvedFindings'),
      value: data.findings.filter((f) => f.status === 'resolved').length,
      col: C.midGray,
    },
  ];

  const cellW = CONTENT_W / 3;
  let cx = MARGIN;
  let row = 0;
  for (const col of cols) {
    const bx = cx;
    const by = y + Math.floor(row / 3) * 70; // always single row for 6 cols
    page.fillColor(C.lightGray).roundRect(bx, by, cellW - 8, 56, 4, true, false);
    page
      .fillColor(col.col)
      .setFont('bold', 22)
      .text(String(col.value), bx + 16, by + 32);
    page
      .setFont('regular', 9)
      .fillColor(C.darkGray)
      .text(col.label, bx + 16, by + 48);
    cx += cellW;
    row++;
    if (cx + cellW > PAGE_W - MARGIN) {
      cx = MARGIN;
    }
  }
  y += 78;

  // Key Findings list (top 5 by severity)
  y = drawSectionHeading(page, t(lang, 'keyFindings'), y);
  const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const topFindings = [...data.findings]
    .sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity))
    .slice(0, 6);

  for (const f of topFindings) {
    if (y > PAGE_H - 100) break;
    let fx = MARGIN;
    fx = drawChip(page, f.severity, fx, y, sevColor(f.severity));
    page
      .setFont('regular', 10)
      .fillColor(C.black)
      .text(f.title.slice(0, 70), fx + 4, y);
    y += 18;
  }
  y += 10;

  // Top recommendations
  y = drawSectionHeading(page, t(lang, 'topRecommendations'), y);
  const recs = topFindings.filter((f) => f.recommendation).slice(0, 5);

  for (let i = 0; i < recs.length; i++) {
    if (y > PAGE_H - 80) break;
    page
      .setFont('bold', 9)
      .fillColor(C.primary)
      .text(`${i + 1}.`, MARGIN, y + 1);
    y = page
      .setFont('regular', 9)
      .fillColor(C.darkGray)
      .textWrapped(recs[i].recommendation!.slice(0, 120), MARGIN + 16, y, CONTENT_W - 16, 13);
    y += 4;
  }

  page.seal();
}

/** Page 3: Score Dashboard */
function buildScoreDashboardPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'scoreDashboard'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'scoreDashboard'), y);

  // Radar chart (left half)
  const dims = ['Security', 'Governance', 'Economic', 'Compliance', 'Liquidity'];
  const scores = [
    data.securityScore,
    data.governanceScore,
    data.economicScore,
    data.complianceScore,
    data.liquidityScore,
  ];
  drawRadarChart(page, 175, y + 110, 90, scores, dims);

  // Score bars (right half)
  let bary = y + 12;
  const bars = [
    { label: t(lang, 'overallScore'), score: data.overallScore },
    { label: 'Security', score: data.securityScore },
    { label: 'Governance', score: data.governanceScore },
    { label: 'Economic', score: data.economicScore },
    { label: 'Compliance', score: data.complianceScore },
    { label: 'Liquidity', score: data.liquidityScore },
  ];

  // Weights table header
  page
    .setFont('bold', 9)
    .fillColor(C.darkGray)
    .text(t(lang, 'dimension'), 310, bary)
    .text(t(lang, 'score'), 440, bary)
    .text(t(lang, 'weight'), 490, bary);
  bary += 14;
  page.fillColor(C.lightGray).rect(305, bary - 2, CONTENT_W - 250, 1, true);
  bary += 6;

  const weights: Record<string, string> = {
    [t(lang, 'overallScore')]: '—',
    Security: '30%',
    Governance: '25%',
    Economic: '20%',
    Compliance: '15%',
    Liquidity: '10%',
  };

  for (const bar of bars) {
    const col = scoreColor(bar.score);
    page.fillColor(col).roundRect(300 + MARGIN - MARGIN, bary - 1, 6, 14, 2, true, false);
    page
      .setFont(bar.label === t(lang, 'overallScore') ? 'bold' : 'regular', 9)
      .fillColor(C.black)
      .text(bar.label, 310, bary + 9);
    page
      .setFont('bold', 9)
      .fillColor(col)
      .text(String(bar.score), 440, bary + 9);
    page
      .setFont('regular', 8)
      .fillColor(C.midGray)
      .text(weights[bar.label] ?? '—', 492, bary + 9);
    bary += 20;
  }

  // Trend line (if history available)
  if (data.scoreHistory && data.scoreHistory.length >= 2) {
    const ty = y + 240;
    y = drawSectionHeading(page, t(lang, 'trend'), ty);
    drawTrendLine(page, data.scoreHistory, MARGIN, y, CONTENT_W, 60);
    y += 72;

    // Trend labels
    page.setFont('regular', 8).fillColor(C.midGray);
    page.text(`v1: ${data.scoreHistory[0]}`, MARGIN, y);
    page.textRight(
      `v${data.scoreHistory.length}: ${data.scoreHistory[data.scoreHistory.length - 1]}`,
      MARGIN + CONTENT_W,
      y,
    );
    y += 16;
  }

  page.seal();
}

/** Findings pages (multiple if needed — 6 findings per page) */
function buildFindingsPages(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  startPage: number,
  total: number,
): number {
  const FINDINGS_PER_PAGE = 5;
  const sorted = [...data.findings].sort((a, b) => {
    const order = ['critical', 'high', 'medium', 'low', 'info'];
    return order.indexOf(a.severity) - order.indexOf(b.severity);
  });

  for (let i = 0; i < sorted.length; i += FINDINGS_PER_PAGE) {
    const batch = sorted.slice(i, i + FINDINGS_PER_PAGE);
    const page = doc.addPage();
    const pNum = startPage + Math.floor(i / FINDINGS_PER_PAGE);
    drawHeader(
      page,
      `${t(lang, 'findingsSection')} (${i + 1}–${Math.min(i + FINDINGS_PER_PAGE, sorted.length)} / ${sorted.length})`,
      pNum,
      total,
      lang,
    );

    let y = 60;
    y = drawSectionHeading(page, t(lang, 'findingsSection'), y);

    for (const f of batch) {
      if (y > PAGE_H - 110) break;

      // Finding card background
      page.fillColor(C.lightGray).roundRect(MARGIN, y, CONTENT_W, 90, 4, true, false);
      page.fillColor(sevColor(f.severity)).rect(MARGIN, y, 4, 90, true);

      // Title row
      let fx = MARGIN + 12;
      fx = drawChip(page, f.severity, fx, y + 16, sevColor(f.severity));
      drawChip(page, f.category, fx, y + 16, C.primary);

      page
        .setFont('bold', 10)
        .fillColor(C.black)
        .text(f.title.slice(0, 68), MARGIN + 12, y + 32);

      // CWE + CVSS
      if (f.cweId || f.cvssScore) {
        let metaX = MARGIN + 12;
        if (f.cweId) {
          page
            .setFont('regular', 8)
            .fillColor(C.midGray)
            .text(`${t(lang, 'cweId')}: ${f.cweId}`, metaX, y + 46);
          metaX += 80;
        }
        if (f.cvssScore) {
          page
            .setFont('regular', 8)
            .fillColor(C.midGray)
            .text(`${t(lang, 'cvssScore')}: ${f.cvssScore.toFixed(1)}`, metaX, y + 46);
        }
      }

      // Description
      const desc = (f.detail ?? f.description).slice(0, 120);
      page
        .setFont('regular', 8)
        .fillColor(C.darkGray)
        .textWrapped(desc, MARGIN + 12, y + 58, CONTENT_W - 24, 11);

      // Status chip (top right)
      const statusCol = f.status === 'resolved' ? C.low : f.status === 'open' ? C.high : C.midGray;
      drawChip(page, f.status, PAGE_W - MARGIN - 65, y + 10, statusCol);

      y += 96;
    }

    if (sorted.length === 0) {
      page
        .setFont('italic', 11)
        .fillColor(C.midGray)
        .textCentered(t(lang, 'noFindings'), 0, PAGE_W, 200);
    }

    page.seal();
  }

  return startPage + Math.ceil(sorted.length / FINDINGS_PER_PAGE);
}

/** Category deep-dive pages — one per dimension */
function buildCategoryPages(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  startPage: number,
  total: number,
): number {
  const categories = [
    { key: 'vulnerability', label: 'Security', score: data.securityScore },
    { key: 'governance', label: 'Governance', score: data.governanceScore },
    { key: 'economics', label: 'Economic', score: data.economicScore },
    { key: 'compliance', label: 'Compliance', score: data.complianceScore },
    { key: 'liquidity', label: 'Liquidity', score: data.liquidityScore },
  ];

  let pageNum = startPage;

  for (const cat of categories) {
    const page = doc.addPage();
    drawHeader(page, `${t(lang, 'categorySection')}: ${cat.label}`, pageNum++, total, lang);

    let y = 60;
    y = drawSectionHeading(page, cat.label, y);

    // Score pill
    const col = scoreColor(cat.score);
    page.fillColor(col).roundRect(MARGIN, y, 80, 40, 6, true, false);
    page
      .setFont('bold', 24)
      .fillColor(C.white)
      .text(String(cat.score), MARGIN + 14, y + 28);
    page
      .setFont('regular', 11)
      .fillColor(C.white)
      .text('/ 100', MARGIN + 46, y + 28);

    // Grade
    page
      .setFont('bold', 20)
      .fillColor(col)
      .text(scoreGrade(cat.score), MARGIN + 96, y + 28);
    page
      .setFont('regular', 9)
      .fillColor(C.midGray)
      .text(riskLabel(cat.score).toUpperCase(), MARGIN + 120, y + 28);

    y += 56;

    // Detail from dimension details
    const detail =
      data.dimensionDetails?.[
        cat.key === 'vulnerability' ? 'security' : cat.key === 'economics' ? 'economic' : cat.key
      ] ?? {};

    if (Object.keys(detail).length > 0) {
      page
        .fillColor(C.lightGray)
        .roundRect(MARGIN, y, CONTENT_W, Object.keys(detail).length * 18 + 16, 4, true, false);
      let dy = y + 14;
      for (const [k, v] of Object.entries(detail)) {
        const valStr =
          typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 80);
        infoRow(page, k, valStr, MARGIN + 12, dy, 140);
        dy += 18;
      }
      y += Object.keys(detail).length * 18 + 26;
    }

    // Findings in this category
    const catFindings = data.findings.filter(
      (f) =>
        f.category === cat.key || (f.category === 'code_quality' && cat.key === 'vulnerability'),
    );

    if (catFindings.length === 0) {
      page
        .setFont('italic', 10)
        .fillColor(C.midGray)
        .text(t(lang, 'noFindings'), MARGIN, y + 20);
    } else {
      page
        .setFont('bold', 10)
        .fillColor(C.darkGray)
        .text(`${catFindings.length} finding(s)`, MARGIN, y);
      y += 18;
      for (const f of catFindings.slice(0, 8)) {
        if (y > PAGE_H - 60) break;
        let fx = MARGIN;
        fx = drawChip(page, f.severity, fx, y, sevColor(f.severity));
        page
          .setFont('regular', 9)
          .fillColor(C.black)
          .text(f.title.slice(0, 65), fx + 4, y + 1);
        y += 16;
      }
    }

    page.seal();
  }

  return pageNum;
}

/** Dependency analysis page */
function buildDependencyPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'dependencySection'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'dependencySection'), y);

  const dep = data.dependencyGraph;
  if (!dep) {
    page
      .setFont('italic', 11)
      .fillColor(C.midGray)
      .text('No dependency data available.', MARGIN, y + 20);
    page.seal();
    return;
  }

  // Summary row
  const cells = [
    { label: 'Parent contracts', value: dep.parentCount },
    { label: 'Child contracts', value: dep.childCount },
    { label: 'Peer interactions', value: dep.peerCount },
  ];
  const cw = CONTENT_W / 3;
  for (let i = 0; i < cells.length; i++) {
    const bx = MARGIN + i * cw;
    page.fillColor(C.lightGray).roundRect(bx, y, cw - 8, 50, 4, true, false);
    page
      .setFont('bold', 22)
      .fillColor(C.primary)
      .text(String(cells[i].value), bx + 14, y + 32);
    page
      .setFont('regular', 9)
      .fillColor(C.darkGray)
      .text(cells[i].label, bx + 14, y + 46);
  }
  y += 62;

  // Node list
  if (dep.nodes && dep.nodes.length > 0) {
    page.setFont('bold', 10).fillColor(C.darkGray).text('Associated Addresses', MARGIN, y);
    y += 16;
    page.fillColor(C.lightGray).rect(MARGIN, y, CONTENT_W, 1, true);
    y += 8;

    for (const node of dep.nodes.slice(0, 18)) {
      if (y > PAGE_H - 60) break;
      drawChip(page, node.role, MARGIN, y, C.primary);
      page
        .setFont('regular', 8)
        .fillColor(C.darkGray)
        .text(node.address.slice(0, 56), MARGIN + 70, y);
      y += 16;
    }
    if (dep.nodes.length > 18) {
      page
        .setFont('italic', 8)
        .fillColor(C.midGray)
        .text(`... and ${dep.nodes.length - 18} more`, MARGIN, y);
    }
  }

  page.seal();
}

/** Certificate & cryptographic attestation page */
function buildCertificatePage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'certSection'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'certSection'), y);

  const rows: [string, string][] = [
    [t(lang, 'certHash'), data.certificateHash],
    [t(lang, 'algorithm'), data.signatureAlgorithm],
    [t(lang, 'publicKey'), data.publicKey],
    [t(lang, 'anchorTx'), data.anchorTxHash ?? t(lang, 'notAnchored')],
    [t(lang, 'verifyAt'), `/api/v1/audit/verify/${data.certId}`],
  ];

  page
    .fillColor(C.lightGray)
    .roundRect(MARGIN, y, CONTENT_W, rows.length * 26 + 20, 4, true, false);
  let ry = y + 18;
  for (const [label, value] of rows) {
    const truncVal = value.length > 65 ? `${value.slice(0, 62)}...` : value;
    infoRow(page, label, truncVal, MARGIN + 12, ry, 120);
    ry += 26;
  }
  y = ry + 18;

  // Signature block (truncated)
  y = drawSectionHeading(page, t(lang, 'signature'), y);
  page.fillColor({ r: 17, g: 24, b: 39 }).roundRect(MARGIN, y, CONTENT_W, 64, 4, true, false);
  const sigChunks = data.signature.match(/.{1,72}/g) ?? [];
  page.setFont('regular', 7).fillColor({ r: 110, g: 231, b: 183 }); // green monospace feel
  let sy = y + 14;
  for (const chunk of sigChunks.slice(0, 3)) {
    page.text(chunk, MARGIN + 10, sy);
    sy += 12;
  }
  y += 74;

  // Verification instructions
  y = drawSectionHeading(page, 'Verification Instructions', y + 10);
  const instructions = [
    '1. Visit the verification URL above in any browser.',
    '2. The platform recomputes SHA-256 from stored fields and compares to certificateHash.',
    '3. HMAC-SHA256 is computed over certificateHash using the platform signing key.',
    '4. Expiry and revocation are checked server-side.',
    '5. If on-chain anchored: the anchor tx hash is deterministically re-derived and compared.',
    '6. API response includes step-by-step verification status and Merkle proof.',
  ];

  for (const ins of instructions) {
    if (y > PAGE_H - 60) break;
    page.setFont('regular', 9).fillColor(C.darkGray).text(ins, MARGIN, y);
    y += 15;
  }

  page.seal();
}

/** Appendix page: methodology + static analysis + tx evidence */
function buildAppendixPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'appendixSection'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'appendixSection'), y);

  // Methodology
  y = drawSectionHeading(page, t(lang, 'methodology'), y);
  const methodology = [
    'Security (30%): WASM decompilation, reentrancy detection, flash loan analysis, threat advisories, source verification.',
    'Governance (25%): Upgrade authority model, timelock configuration, decentralization score, suspicious upgrade flags.',
    'Economic (20%): TVL 30-day trend, MEV sandwich exposure, user diversity, volume analysis.',
    'Compliance (15%): OFAC/EU/UN sanctions screening of contract, deployer, and all admin keys.',
    'Liquidity (10%): Pool depth, concentration risk, impermanent loss indicator, yield risk score.',
    'Overall = Security*0.30 + Governance*0.25 + Economic*0.20 + Compliance*0.15 + Liquidity*0.10.',
    'Scores are 0-100 where 100 = safest. Grade A >= 85, B >= 70, C >= 55, D >= 40, F < 40.',
    'Certificates expire after 90 days. Re-audit triggers: upgrade, sanctions hit, scheduled (daily/weekly).',
  ];

  for (const line of methodology) {
    if (y > 480) break;
    y = page
      .setFont('regular', 8)
      .fillColor(C.darkGray)
      .textWrapped(line, MARGIN, y, CONTENT_W, 12);
    y += 4;
  }

  // Static Analysis summary
  y = drawSectionHeading(page, t(lang, 'staticAnalysis'), y + 10);
  const secDetail = data.dimensionDetails?.security ?? {};
  if (Object.keys(secDetail).length > 0) {
    page
      .fillColor(C.lightGray)
      .roundRect(
        MARGIN,
        y,
        CONTENT_W,
        Math.min(6, Object.keys(secDetail).length) * 16 + 12,
        3,
        true,
        false,
      );
    let dy = y + 12;
    for (const [k, v] of Object.entries(secDetail).slice(0, 6)) {
      const valStr = String(v).slice(0, 70);
      infoRow(page, k, valStr, MARGIN + 10, dy, 130);
      dy += 16;
    }
    y = dy + 8;
  }

  // Transaction evidence
  y = drawSectionHeading(page, t(lang, 'txEvidence'), y + 6);
  const txFindings = data.findings.filter((f) => f.txHash);
  if (txFindings.length === 0) {
    page
      .setFont('italic', 9)
      .fillColor(C.midGray)
      .text('No transaction evidence attached to findings.', MARGIN, y);
  } else {
    for (const f of txFindings.slice(0, 6)) {
      if (y > PAGE_H - 60) break;
      page
        .setFont('bold', 8)
        .fillColor(C.darkGray)
        .text(`[${f.severity.toUpperCase()}]`, MARGIN, y);
      page
        .setFont('regular', 8)
        .fillColor(C.black)
        .text(`${f.title.slice(0, 40)} — tx: ${f.txHash!.slice(0, 32)}...`, MARGIN + 60, y);
      y += 14;
    }
  }

  page.seal();
}

// ── External Audits page ───────────────────────────────────────────────────────

/** Renders one page listing all verified external audit submissions. */
function buildExternalAuditsPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'externalAudits'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'externalAudits'), y);

  const audits = data.externalAudits ?? [];

  if (audits.length === 0) {
    page
      .setFont('italic', 11)
      .fillColor(C.midGray)
      .textCentered(t(lang, 'noExternalAudits'), 0, PAGE_W, y + 30);
    page.seal();
    return;
  }

  // Grade colour helper
  const gradeColor = (g: string | null) => {
    if (g === 'pass') return C.low;
    if (g === 'conditional_pass') return C.medium;
    if (g === 'fail') return C.high;
    return C.midGray;
  };

  const tierColor: Record<string, { r: number; g: number; b: number }> = {
    platinum: { r: 148, g: 163, b: 184 },
    gold: { r: 234, g: 179, b: 8 },
    silver: { r: 156, g: 163, b: 175 },
    bronze: { r: 180, g: 83, b: 9 },
  };

  for (const audit of audits) {
    if (y > PAGE_H - 130) break;

    // Card background
    const cardH = audit.summary ? 110 : 90;
    page.fillColor(C.lightGray).roundRect(MARGIN, y, CONTENT_W, cardH, 5, true, false);

    // Left accent stripe: colour by grade
    const gc = gradeColor(audit.overallGrade);
    page.fillColor(gc).rect(MARGIN, y, 4, cardH, true);

    // Auditor name + verified checkmark
    page
      .setFont('bold', 11)
      .fillColor(C.black)
      .text(audit.auditorName.slice(0, 40), MARGIN + 12, y + 18);

    if (audit.isAuditorVerified) {
      page
        .setFont('bold', 8)
        .fillColor(C.low)
        .text(
          `✓ ${t(lang, 'auditorVerified')}`,
          MARGIN + 12 + audit.auditorName.length * 6.5,
          y + 18,
        );
    }

    // Badge tier chip
    if (audit.auditorBadgeTier) {
      const bc = tierColor[audit.auditorBadgeTier] ?? C.midGray;
      drawChip(page, audit.auditorBadgeTier, PAGE_W - MARGIN - 80, y + 8, bc);
    }

    // Trust score
    if (audit.auditorTrustScore !== null) {
      page
        .setFont('regular', 8)
        .fillColor(C.midGray)
        .text(
          `${t(lang, 'trustScore')}: ${audit.auditorTrustScore}/100`,
          PAGE_W - MARGIN - 80,
          y + 26,
        );
    }

    // Meta row: reportType | grade | findings | date
    let mx = MARGIN + 12;
    page
      .setFont('regular', 8)
      .fillColor(C.darkGray)
      .text(audit.reportType.replace('_', ' '), mx, y + 34);
    mx += 120;

    if (audit.overallGrade) {
      drawChip(
        page,
        audit.overallGrade.replace('_', ' '),
        mx,
        y + 34,
        gradeColor(audit.overallGrade),
      );
      mx += audit.overallGrade.length * 6 + 20;
    }

    page
      .setFont('regular', 8)
      .fillColor(C.midGray)
      .text(`${audit.findingCount} finding(s)`, mx, y + 34);

    page
      .setFont('italic', 8)
      .fillColor(C.midGray)
      .textRight(audit.submittedAt.toISOString().slice(0, 10), PAGE_W - MARGIN - 8, y + 34);

    // Report URL (truncated)
    if (audit.reportUrl) {
      page
        .setFont('regular', 8)
        .fillColor(C.primary)
        .text(audit.reportUrl.slice(0, 72), MARGIN + 12, y + 50);
    }

    // Report hash (truncated for tamper-detection reference)
    if (audit.reportHash) {
      page
        .setFont('regular', 7)
        .fillColor(C.midGray)
        .text(
          `SHA256: ${audit.reportHash.replace('sha256:', '').slice(0, 40)}…`,
          MARGIN + 12,
          y + 62,
        );
    }

    // Summary (if present)
    if (audit.summary) {
      page
        .setFont('regular', 8)
        .fillColor(C.darkGray)
        .textWrapped(audit.summary.slice(0, 150), MARGIN + 12, y + 75, CONTENT_W - 24, 11);
    }

    // Top 3 external findings listed compactly
    const extFindings = audit.findings.slice(0, 3);
    if (extFindings.length > 0 && !audit.summary) {
      let fy = y + 72;
      for (const ef of extFindings) {
        if (fy > y + cardH - 8) break;
        let fx = MARGIN + 12;
        fx = drawChip(page, ef.severity, fx, fy, sevColor(ef.severity));
        page
          .setFont('regular', 8)
          .fillColor(C.black)
          .text(ef.title.slice(0, 62), fx + 4, fy);
        fy += 14;
      }
    }

    y += cardH + 10;
  }

  page.seal();
}

// ── Formal Verification page ──────────────────────────────────────────────────

function buildFormalVerifPage(
  doc: PdfDocument,
  data: AuditReportData,
  lang: Lang,
  pageNum: number,
  total: number,
): void {
  const page = doc.addPage();
  drawHeader(page, t(lang, 'formalVerif'), pageNum, total, lang);

  let y = 60;
  y = drawSectionHeading(page, t(lang, 'formalVerif'), y);

  const results = data.formalVerifications ?? [];

  if (results.length === 0) {
    page
      .setFont('italic', 11)
      .fillColor(C.midGray)
      .textCentered(t(lang, 'noFormalVerif'), 0, PAGE_W, y + 30);
    page.seal();
    return;
  }

  // Tool status colours
  const statusColor = (s: string) => {
    if (s === 'passed') return C.low;
    if (s === 'failed') return C.high;
    if (s === 'timeout') return C.medium;
    if (s === 'unsupported') return C.midGray;
    return C.accent;
  };

  // Tool display names
  const toolLabel: Record<string, string> = {
    certora: 'Certora Prover',
    scribble: 'Scribble',
    halo2: 'Halo2',
    smtchecker: 'SMT Checker',
    manual: 'Manual Review',
  };

  for (const fv of results) {
    if (y > PAGE_H - 130) break;

    const cardH = 100 + ((fv.counterExamples as unknown[])?.length > 0 ? 20 : 0);
    const col = statusColor(fv.status);

    // Card
    page.fillColor(C.lightGray).roundRect(MARGIN, y, CONTENT_W, cardH, 5, true, false);
    page.fillColor(col).rect(MARGIN, y, 4, cardH, true);

    // Tool name + status chip
    const toolName = toolLabel[fv.tool] ?? fv.tool;
    page
      .setFont('bold', 11)
      .fillColor(C.black)
      .text(toolName, MARGIN + 12, y + 18);
    drawChip(page, fv.status.toUpperCase(), PAGE_W - MARGIN - 80, y + 8, col);

    // Metrics row
    let mx = MARGIN + 12;
    const metrics = [
      { label: t(lang, 'fvProperties'), val: fv.propertyCount ?? '?' },
      { label: t(lang, 'fvProven'), val: fv.provenCount ?? '?' },
      { label: t(lang, 'fvViolated'), val: fv.violatedCount ?? '?' },
    ];
    if (fv.coveragePercent !== null && fv.coveragePercent !== undefined) {
      metrics.push({
        label: t(lang, 'fvCoverage'),
        val: `${Number(fv.coveragePercent).toFixed(1)}%`,
      });
    }

    for (const m of metrics) {
      page
        .setFont('regular', 8)
        .fillColor(C.midGray)
        .text(m.label, mx, y + 34);
      page
        .setFont('bold', 11)
        .fillColor(m.label === t(lang, 'fvViolated') && Number(m.val) > 0 ? C.high : C.black)
        .text(String(m.val), mx, y + 50);
      mx += 90;
    }

    // Duration + date
    if (fv.durationSeconds) {
      page
        .setFont('italic', 8)
        .fillColor(C.midGray)
        .text(`${fv.durationSeconds}s`, mx, y + 50);
    }
    if (fv.completedAt) {
      page
        .setFont('italic', 8)
        .fillColor(C.midGray)
        .textRight(
          (fv.completedAt as Date).toISOString().slice(0, 10),
          PAGE_W - MARGIN - 8,
          y + 34,
        );
    }

    // Report URL
    if (fv.reportUrl) {
      page
        .setFont('regular', 8)
        .fillColor(C.primary)
        .text(fv.reportUrl.slice(0, 72), MARGIN + 12, y + 64);
    }

    // Counter-examples (up to 2)
    const ces = (fv.counterExamples as Array<{ property: string; description: string }>) ?? [];
    if (ces.length > 0) {
      let cy = y + (fv.reportUrl ? 78 : 68);
      page
        .setFont('bold', 8)
        .fillColor(C.high)
        .text(`${t(lang, 'fvCounterExample')}: ${ces.length}`, MARGIN + 12, cy);
      cy += 12;
      for (const ce of ces.slice(0, 2)) {
        if (cy > y + cardH - 4) break;
        page
          .setFont('regular', 7)
          .fillColor(C.darkGray)
          .text(`• ${ce.property.slice(0, 80)}`, MARGIN + 16, cy);
        cy += 11;
      }
    }

    y += cardH + 10;
  }

  page.seal();
}

// ── Main assembler ─────────────────────────────────────────────────────────────

/**
 * Assemble all pages into a single PDF Buffer.
 *
 * Page plan:
 *   1            — Cover
 *   2            — Executive Summary
 *   3            — Score Dashboard
 *   4…N          — Findings (5 per page)
 *   N+1…N+5      — Category deep-dives (5 dimensions)
 *   N+6          — Dependency Analysis
 *   N+7          — External Audit Reports
 *   N+8          — Formal Verification Results
 *   N+9          — Certificate & Cryptographic Attestation
 *   N+10         — Appendices
 */
export function generateAuditPdf(data: AuditReportData): Buffer {
  const lang: Lang = (data.lang ?? 'en') as Lang;

  // Calculate total page count upfront so headers show "Page X / N"
  const findingPages = Math.max(1, Math.ceil(data.findings.length / 5));
  // cover + exec + dash + findings + 5 cats + dep + external + formalverif + cert + appendix
  const totalPages = 3 + findingPages + 5 + 1 + 1 + 1 + 1 + 1;

  const doc = new PdfDocument();

  // 1 — Cover
  buildCoverPage(doc, data, lang);

  // 2 — Executive Summary
  buildExecSummaryPage(doc, data, lang, 2, totalPages);

  // 3 — Score Dashboard
  buildScoreDashboardPage(doc, data, lang, 3, totalPages);

  // 4…N — Findings
  const afterFindings = buildFindingsPages(doc, data, lang, 4, totalPages);

  // N+1…N+5 — Category deep-dives
  const afterCats = buildCategoryPages(doc, data, lang, afterFindings, totalPages);

  // N+6 — Dependency Analysis
  buildDependencyPage(doc, data, lang, afterCats, totalPages);

  // N+7 — External Audit Reports
  buildExternalAuditsPage(doc, data, lang, afterCats + 1, totalPages);

  // N+8 — Formal Verification Results
  buildFormalVerifPage(doc, data, lang, afterCats + 2, totalPages);

  // N+9 — Certificate & Cryptographic Attestation
  buildCertificatePage(doc, data, lang, afterCats + 3, totalPages);

  // N+10 — Appendices
  buildAppendixPage(doc, data, lang, afterCats + 4, totalPages);

  return doc.build();
}
