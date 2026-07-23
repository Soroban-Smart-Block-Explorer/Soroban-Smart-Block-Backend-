/**
 * Audit Score Badge Generator
 *
 * GET /api/v1/contracts/:address/audit/badge.svg
 *
 * Returns a shields.io-style SVG badge showing the contract's audit score,
 * grade, and risk level. Zero external dependencies — pure SVG string.
 *
 * Query params:
 *   style   flat (default) | flat-square | plastic
 *   compact true — single-line compact badge (default false)
 */

// ── Colour palette ────────────────────────────────────────────────────────────

const RISK_COLORS: Record<string, { bg: string; shadow: string; text: string }> = {
  low: { bg: '#44cc11', shadow: '#44b511', text: '#fff' },
  medium: { bg: '#dfb317', shadow: '#c9a003', text: '#fff' },
  high: { bg: '#e05d44', shadow: '#c9432f', text: '#fff' },
  critical: { bg: '#9b0000', shadow: '#7a0000', text: '#fff' },
  unknown: { bg: '#9f9f9f', shadow: '#888', text: '#fff' },
};

const LABEL_BG = '#555';
const LABEL_SHADOW = '#333';
const LABEL_TEXT = '#fff';

// ── SVG font metrics (Verdana 11px approximation) ────────────────────────────

const CHAR_WIDTH_AVG = 6.5; // average px per character at 11px Verdana

function textWidth(s: string): number {
  return Math.ceil(s.length * CHAR_WIDTH_AVG + 10);
}

// ── Badge renderers ───────────────────────────────────────────────────────────

interface BadgeData {
  label: string; // left section text
  message: string; // right section text
  riskLevel: string;
  score: number;
  grade: string;
  contractAddress: string;
  verifyUrl: string;
  generatedAt: string;
}

function renderFlat(d: BadgeData, square: boolean): string {
  const lw = textWidth(d.label);
  const rw = textWidth(d.message);
  const totalW = lw + rw;
  const h = 20;
  const r = square ? 0 : 3;
  const colors = RISK_COLORS[d.riskLevel] ?? RISK_COLORS.unknown;

  const lx = (lw / 2 + 1).toFixed(1);
  const rx = (lw + rw / 2 - 1).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" role="img"
  aria-label="Soroban Audit: ${d.message}">
  <title>Soroban Audit: ${d.message} — ${d.contractAddress.slice(0, 8)}…</title>
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about="">
        <dc:subject xmlns:dc="http://purl.org/dc/elements/1.1/">${d.contractAddress}</dc:subject>
        <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${d.generatedAt}</dc:date>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
  <defs>
    <linearGradient id="s" x2="0" y2="100%">
      <stop offset="0"   stop-color="#bbb" stop-opacity=".1"/>
      <stop offset="1"                     stop-opacity=".1"/>
    </linearGradient>
    <clipPath id="r">
      <rect width="${totalW}" height="${h}" rx="${r}" fill="#fff"/>
    </clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="${LABEL_BG}"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${colors.bg}"/>
    <rect width="${totalW}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="${LABEL_TEXT}" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${parseFloat(lx) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(lw - 10) * 10}">${d.label}</text>
    <text x="${parseFloat(lx) * 10}" y="140" transform="scale(.1)" textLength="${(lw - 10) * 10}">${d.label}</text>
  </g>
  <g fill="${colors.text}" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${parseFloat(rx) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(rw - 10) * 10}">${d.message}</text>
    <text x="${parseFloat(rx) * 10}" y="140" transform="scale(.1)" textLength="${(rw - 10) * 10}">${d.message}</text>
  </g>
  <a xlink:href="${d.verifyUrl}" target="_blank">
    <rect width="${totalW}" height="${h}" fill-opacity="0"/>
  </a>
</svg>`;
}

function renderPlastic(d: BadgeData): string {
  const lw = textWidth(d.label) + 4;
  const rw = textWidth(d.message) + 4;
  const totalW = lw + rw;
  const h = 18;
  const colors = RISK_COLORS[d.riskLevel] ?? RISK_COLORS.unknown;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" role="img"
  aria-label="Soroban Audit: ${d.message}">
  <title>Soroban Audit: ${d.message} — ${d.contractAddress.slice(0, 8)}…</title>
  <defs>
    <linearGradient id="s" x2="0" y2="100%">
      <stop offset="0"   stop-color="#fff" stop-opacity=".7"/>
      <stop offset=".1"  stop-color="#aaa" stop-opacity=".1"/>
      <stop offset=".9"                    stop-opacity=".3"/>
      <stop offset="1"                     stop-opacity=".5"/>
    </linearGradient>
    <clipPath id="r">
      <rect width="${totalW}" height="${h}" rx="4" fill="#fff"/>
    </clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="${LABEL_BG}"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${colors.bg}"/>
    <rect width="${totalW}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${(lw / 2) * 10}" y="140" transform="scale(.1)" textLength="${(lw - 12) * 10}" fill="#010101" fill-opacity=".3">${d.label}</text>
    <text x="${(lw / 2) * 10}" y="130" transform="scale(.1)" textLength="${(lw - 12) * 10}">${d.label}</text>
    <text x="${(lw + rw / 2) * 10}" y="140" transform="scale(.1)" textLength="${(rw - 12) * 10}" fill="#010101" fill-opacity=".3">${d.message}</text>
    <text x="${(lw + rw / 2) * 10}" y="130" transform="scale(.1)" textLength="${(rw - 12) * 10}">${d.message}</text>
  </g>
  <a xlink:href="${d.verifyUrl}" target="_blank">
    <rect width="${totalW}" height="${h}" fill-opacity="0"/>
  </a>
</svg>`;
}

function renderCompact(d: BadgeData): string {
  const colors = RISK_COLORS[d.riskLevel] ?? RISK_COLORS.unknown;
  const text = `Audit ${d.score}`;
  const w = textWidth(text) + 8;
  const h = 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
  aria-label="Audit score ${d.score}">
  <title>Soroban Audit Score: ${d.score}/100 (${d.riskLevel})</title>
  <rect width="${w}" height="${h}" rx="3" fill="${colors.bg}"/>
  <g fill="${colors.text}" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${(w / 2) * 10}" y="145" transform="scale(.1)" textLength="${(w - 10) * 10}">${text}</text>
  </g>
  <a xlink:href="${d.verifyUrl}" target="_blank">
    <rect width="${w}" height="${h}" fill-opacity="0"/>
  </a>
</svg>`;
}

// ── Audit not-found badge ─────────────────────────────────────────────────────

function renderNotAudited(contractAddress: string, style: string): string {
  const label = 'soroban audit';
  const message = 'not audited';
  const lw = textWidth(label);
  const rw = textWidth(message);
  const totalW = lw + rw;
  const h = 20;
  const r = style === 'flat-square' ? 0 : 3;

  return `<svg xmlns="http://www.w3.org/2000/svg"
  width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" role="img"
  aria-label="Not audited — ${contractAddress.slice(0, 8)}">
  <title>Soroban Audit: not audited — ${contractAddress.slice(0, 8)}…</title>
  <defs><clipPath id="r"><rect width="${totalW}" height="${h}" rx="${r}" fill="#fff"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="${LABEL_BG}"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${RISK_COLORS.unknown.bg}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${(lw / 2) * 10}" y="140" transform="scale(.1)" textLength="${(lw - 10) * 10}">${label}</text>
    <text x="${(lw + rw / 2) * 10}" y="140" transform="scale(.1)" textLength="${(rw - 10) * 10}">${message}</text>
  </g>
</svg>`;
}

// ── Public export ─────────────────────────────────────────────────────────────

export type BadgeStyle = 'flat' | 'flat-square' | 'plastic';

export interface BadgeOptions {
  style: BadgeStyle;
  compact: boolean;
}

export function generateBadgeSvg(
  cert: {
    id: string;
    contractAddress: string;
    overallScore: number;
    securityScore: number;
    governanceScore: number;
    economicScore: number;
    complianceScore: number;
    liquidityScore: number;
    generatedAt: Date;
    expiresAt: Date | null;
    certificateHash: string;
  } | null,
  contractAddress: string,
  opts: BadgeOptions,
): string {
  if (!cert) return renderNotAudited(contractAddress, opts.style);

  const score = cert.overallScore;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  const risk = score >= 85 ? 'low' : score >= 70 ? 'medium' : score >= 55 ? 'high' : 'critical';
  const isExpired = !!cert.expiresAt && cert.expiresAt < new Date();
  const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

  const data: BadgeData = {
    label: 'soroban audit',
    message: isExpired ? `${score} (expired)` : `${score} ${grade}`,
    riskLevel: isExpired ? 'unknown' : risk,
    score,
    grade,
    contractAddress: cert.contractAddress,
    verifyUrl: `${baseUrl}/api/v1/audit/verify/${cert.id}`,
    generatedAt: cert.generatedAt.toISOString(),
  };

  if (opts.compact) return renderCompact(data);
  if (opts.style === 'plastic') return renderPlastic(data);
  if (opts.style === 'flat-square') return renderFlat(data, true);
  return renderFlat(data, false);
}
