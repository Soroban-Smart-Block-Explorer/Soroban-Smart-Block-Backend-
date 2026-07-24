/**
 * Audit Badge & Embed API
 *
 * GET /api/v1/audit/embed/widget.js
 *   Self-contained JavaScript widget — embed on any website with one script tag.
 *   Renders a live audit score card for one or more contract addresses.
 *
 * GET /api/v1/audit/embed/widget.css
 *   Standalone CSS for the widget (also inlined in widget.js when ?inline=true)
 *
 * GET /api/v1/audit/embed/data/:address
 *   JSON data endpoint used by the widget — CORS-open, cached 5 min.
 *   Returns minimal audit data safe for public consumption.
 *
 * GET /api/v1/audit/embed/wordpress-plugin.zip
 *   WordPress plugin archive (PHP + readme.txt) for embedding audit results
 *   on WordPress sites via a [soroban_audit] shortcode.
 *
 * GET /api/v1/audit/embed/snippet/:address
 *   Returns copy-paste HTML/JS/Markdown embed snippets for a contract.
 */

import { Router, Request, Response } from 'express';
import { prismaRead } from '../db';
import { cacheGet, cacheSet } from '../cache';

export const auditEmbedRouter = Router();

const BASE_URL = () => process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

// ── Shared score helpers ───────────────────────────────────────────────────────

function scoreGrade(s: number) {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}
function riskLabel(s: number) {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}
function riskColor(s: number) {
  if (s >= 85) return '#22c55e';
  if (s >= 70) return '#eab308';
  if (s >= 55) return '#ef4444';
  return '#7f1d1d';
}

// ── GET /data/:address — public JSON for the widget ───────────────────────────

auditEmbedRouter.get('/data/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const cacheKey = `embed:data:${address}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.json(cached);
    }

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        overallScore: true,
        securityScore: true,
        governanceScore: true,
        economicScore: true,
        complianceScore: true,
        liquidityScore: true,
        totalFindings: true,
        criticalFindings: true,
        highFindings: true,
        openFindings: true,
        generatedAt: true,
        expiresAt: true,
        certificateHash: true,
        anchorTxHash: true,
      },
    });

    const contract = await prismaRead.contract.findUnique({
      where: { address },
      select: { name: true, tokenSymbol: true, isToken: true },
    });

    if (!cert) {
      const result = { audited: false, contractAddress: address };
      await cacheSet(cacheKey, result, 60);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(result);
    }

    const result = {
      audited: true,
      contractAddress: address,
      contractName: contract?.name ?? contract?.tokenSymbol ?? null,
      version: cert.version,
      overallScore: cert.overallScore,
      grade: scoreGrade(cert.overallScore),
      riskLevel: riskLabel(cert.overallScore),
      riskColor: riskColor(cert.overallScore),
      scores: {
        security: cert.securityScore,
        governance: cert.governanceScore,
        economic: cert.economicScore,
        compliance: cert.complianceScore,
        liquidity: cert.liquidityScore,
      },
      findings: {
        total: cert.totalFindings,
        critical: cert.criticalFindings,
        high: cert.highFindings,
        open: cert.openFindings,
      },
      anchored: !!cert.anchorTxHash,
      generatedAt: cert.generatedAt,
      expiresAt: cert.expiresAt,
      certId: cert.id,
      verifyUrl: `${BASE_URL()}/api/v1/audit/verify/${cert.id}`,
      reportUrl: `${BASE_URL()}/api/v1/contracts/${address}/audit`,
      badgeUrl: `${BASE_URL()}/api/v1/contracts/${address}/audit/badge.svg`,
    };

    await cacheSet(cacheKey, result, 300);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /widget.css — standalone widget stylesheet ───────────────────────────

const WIDGET_CSS = `
.soroban-audit-widget{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:inline-block;border-radius:10px;padding:18px 22px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.10);border:1px solid #e5e7eb;min-width:220px;max-width:340px;text-decoration:none;color:inherit;transition:box-shadow .2s}
.soroban-audit-widget:hover{box-shadow:0 4px 20px rgba(0,0,0,.15)}
.soroban-audit-widget .saw-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.soroban-audit-widget .saw-score-circle{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff;flex-shrink:0}
.soroban-audit-widget .saw-title{flex:1;min-width:0}
.soroban-audit-widget .saw-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#111}
.soroban-audit-widget .saw-risk{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.soroban-audit-widget .saw-scores{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-bottom:10px}
.soroban-audit-widget .saw-dim{text-align:center;padding:4px 2px;background:#f9fafb;border-radius:5px}
.soroban-audit-widget .saw-dim-val{font-weight:700;font-size:13px;display:block}
.soroban-audit-widget .saw-dim-lbl{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
.soroban-audit-widget .saw-findings{display:flex;gap:8px;font-size:11px;color:#6b7280;margin-bottom:10px;flex-wrap:wrap}
.soroban-audit-widget .saw-finding-badge{display:inline-flex;align-items:center;gap:3px;background:#fee2e2;color:#991b1b;border-radius:4px;padding:2px 6px;font-weight:600}
.soroban-audit-widget .saw-finding-badge.saw-high{background:#fef3c7;color:#92400e}
.soroban-audit-widget .saw-footer{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:8px;margin-top:4px}
.soroban-audit-widget .saw-brand{font-weight:600;color:#1e40af}
.soroban-audit-widget .saw-anchor{display:inline-flex;align-items:center;gap:3px}
.soroban-audit-widget.saw-compact{padding:10px 14px;min-width:0}
.soroban-audit-widget.saw-compact .saw-scores{display:none}
.soroban-audit-widget.saw-compact .saw-findings{display:none}
.soroban-audit-widget.saw-dark{background:#1e293b;border-color:#334155;color:#e2e8f0}
.soroban-audit-widget.saw-dark .saw-name{color:#f1f5f9}
.soroban-audit-widget.saw-dark .saw-dim{background:#0f172a}
.soroban-audit-widget.saw-dark .saw-footer{border-color:#334155;color:#64748b}
`;

auditEmbedRouter.get('/widget.css', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(WIDGET_CSS);
});

// ── GET /widget.js — self-contained JavaScript widget ────────────────────────
// Usage:
//   <script src="https://explorer.soroban.network/api/v1/audit/embed/widget.js"></script>
//   <div class="soroban-audit" data-address="C..." data-theme="dark" data-compact="false"></div>
//
// Or programmatic:
//   SorobanAudit.render(document.getElementById('audit'), { address: 'C...' });

function buildWidgetJs(baseUrl: string): string {
  return `
(function(global){
'use strict';

var BASE_URL = '${baseUrl}';
var CACHE = {};

var CSS = ${JSON.stringify(WIDGET_CSS)};

function injectCss(){
  if(document.getElementById('soroban-audit-css')) return;
  var s = document.createElement('style');
  s.id = 'soroban-audit-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function scoreColor(s){
  if(s>=85) return '#22c55e';
  if(s>=70) return '#eab308';
  if(s>=55) return '#ef4444';
  return '#7f1d1d';
}
function riskLabel(s){
  if(s>=85) return 'Low Risk';
  if(s>=70) return 'Medium Risk';
  if(s>=55) return 'High Risk';
  return 'Critical';
}
function grade(s){ return s>=85?'A':s>=70?'B':s>=55?'C':s>=40?'D':'F'; }

function fetchData(address, cb){
  if(CACHE[address]){ cb(null, CACHE[address]); return; }
  var xhr = new XMLHttpRequest();
  xhr.open('GET', BASE_URL+'/api/v1/audit/embed/data/'+address);
  xhr.onload = function(){
    try{
      var d = JSON.parse(xhr.responseText);
      CACHE[address] = d;
      cb(null, d);
    }catch(e){ cb(e); }
  };
  xhr.onerror = function(){ cb(new Error('Network error')); };
  xhr.send();
}

function renderLoading(el){
  el.innerHTML = '<div class="soroban-audit-widget" style="min-height:80px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:13px">Loading audit data...</div>';
}

function renderError(el, msg){
  el.innerHTML = '<div class="soroban-audit-widget" style="color:#ef4444;font-size:12px;padding:12px">'+msg+'</div>';
}

function renderWidget(el, data, opts){
  var compact = opts.compact === 'true' || opts.compact === true;
  var dark    = opts.theme   === 'dark';
  var addr    = data.contractAddress || '';
  var addrShort = addr.slice(0,10)+'...';

  if(!data.audited){
    el.innerHTML = '<a class="soroban-audit-widget'+(dark?' saw-dark':'')+(compact?' saw-compact':'')+'" href="'+BASE_URL+'/api/v1/contracts/'+addr+'/audit/refresh" target="_blank">'
      +'<div class="saw-header">'
      +'<div class="saw-score-circle" style="background:#9ca3af">N/A</div>'
      +'<div class="saw-title"><div class="saw-name">'+addrShort+'</div>'
      +'<div class="saw-risk" style="color:#9ca3af">Not Audited</div></div></div>'
      +'<div class="saw-footer"><span class="saw-brand">Soroban Audit</span><span>Trigger audit →</span></div>'
      +'</a>';
    return;
  }

  var sc = data.overallScore;
  var col = scoreColor(sc);
  var g   = grade(sc);
  var risk = riskLabel(sc);
  var name = data.contractName || addrShort;
  var dims = ['Security','Governance','Economic','Compliance','Liquidity'];
  var dimKeys = ['security','governance','economic','compliance','liquidity'];
  var dimHtml = dimKeys.map(function(k,i){
    return '<div class="saw-dim"><span class="saw-dim-val">'+data.scores[k]+'</span>'
      +'<span class="saw-dim-lbl">'+dims[i].slice(0,3)+'</span></div>';
  }).join('');

  var critBadge = data.findings.critical > 0
    ? '<span class="saw-finding-badge">'+data.findings.critical+' critical</span>'
    : '';
  var highBadge = data.findings.high > 0
    ? '<span class="saw-finding-badge saw-high">'+data.findings.high+' high</span>'
    : '';
  var openBadge = data.findings.open > 0
    ? '<span>'+data.findings.open+' open</span>'
    : '<span style="color:#22c55e">✓ all resolved</span>';

  var anchorIcon = data.anchored ? '⛓ on-chain' : '';
  var expiry = data.expiresAt
    ? 'expires '+new Date(data.expiresAt).toISOString().slice(0,10)
    : '';

  el.innerHTML = '<a class="soroban-audit-widget'+(dark?' saw-dark':'')+(compact?' saw-compact':'')+'" '
    +'href="'+data.reportUrl+'" target="_blank" title="View audit for '+name+'">'
    +'<div class="saw-header">'
    +'<div class="saw-score-circle" style="background:'+col+'">'+g+'</div>'
    +'<div class="saw-title">'
    +'<div class="saw-name">'+name+'</div>'
    +'<div class="saw-risk" style="color:'+col+'">'+sc+'/100 · '+risk+'</div>'
    +'</div></div>'
    +(compact ? '' : '<div class="saw-scores">'+dimHtml+'</div>')
    +(compact ? '' : '<div class="saw-findings">'+critBadge+highBadge+openBadge+'</div>')
    +'<div class="saw-footer">'
    +'<span class="saw-brand">Soroban Audit</span>'
    +'<span class="saw-anchor">'+[anchorIcon,expiry].filter(Boolean).join(' · ')+'</span>'
    +'</div></a>';
}

function init(){
  injectCss();
  var els = document.querySelectorAll('[data-soroban-audit],[class~="soroban-audit"],.soroban-audit-widget-auto');
  for(var i=0;i<els.length;i++){
    (function(el){
      var address = el.getAttribute('data-address') || el.getAttribute('data-soroban-audit');
      if(!address) return;
      var opts = {
        compact: el.getAttribute('data-compact') || 'false',
        theme:   el.getAttribute('data-theme')   || 'light',
      };
      renderLoading(el);
      fetchData(address, function(err, data){
        if(err){ renderError(el, 'Could not load audit data'); return; }
        renderWidget(el, data, opts);
      });
    })(els[i]);
  }
}

var SorobanAudit = {
  render: function(el, opts){
    if(!el || !opts.address) return;
    injectCss();
    renderLoading(el);
    fetchData(opts.address, function(err, data){
      if(err){ renderError(el, 'Could not load audit data'); return; }
      renderWidget(el, data, opts);
    });
  },
  fetchData: fetchData,
  version: '1.0.0',
};

if(typeof module !== 'undefined' && module.exports){
  module.exports = SorobanAudit;
} else {
  global.SorobanAudit = SorobanAudit;
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})(typeof window !== 'undefined' ? window : this);
`.trim();
}

auditEmbedRouter.get('/widget.js', (_req: Request, res: Response) => {
  const js = buildWidgetJs(BASE_URL());
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(js);
});

// ── GET /snippet/:address — embed code snippets ───────────────────────────────

auditEmbedRouter.get('/snippet/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const base = BASE_URL();
    const format = (req.query.format as string) ?? 'all';

    // Verify contract has an audit
    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
      select: { overallScore: true, id: true },
    });

    const score = cert?.overallScore ?? null;
    const grade = score !== null ? scoreGrade(score) : '?';

    const snippets = {
      html: `<!-- Soroban Audit Widget -->
<script src="${base}/api/v1/audit/embed/widget.js" async></script>
<div data-soroban-audit="${address}" data-theme="light"></div>`,

      html_dark: `<!-- Soroban Audit Widget (dark theme) -->
<script src="${base}/api/v1/audit/embed/widget.js" async></script>
<div data-soroban-audit="${address}" data-theme="dark"></div>`,

      html_compact: `<!-- Soroban Audit Badge (compact) -->
<script src="${base}/api/v1/audit/embed/widget.js" async></script>
<div data-soroban-audit="${address}" data-compact="true"></div>`,

      badge_img: `<a href="${base}/api/v1/contracts/${address}/audit" target="_blank">
  <img src="${base}/api/v1/contracts/${address}/audit/badge.svg" alt="Soroban Audit Score: ${score ?? 'N/A'}" />
</a>`,

      markdown: `[![Soroban Audit](${base}/api/v1/contracts/${address}/audit/badge.svg)](${base}/api/v1/contracts/${address}/audit)`,

      react: `import { useEffect, useRef } from 'react';

export function AuditWidget({ address }) {
  const ref = useRef(null);
  useEffect(() => {
    const script = document.createElement('script');
    script.src = '${base}/api/v1/audit/embed/widget.js';
    script.async = true;
    script.onload = () => window.SorobanAudit?.render(ref.current, { address });
    document.head.appendChild(script);
    return () => script.remove();
  }, [address]);
  return <div ref={ref} />;
}

// Usage: <AuditWidget address="${address}" />`,

      wordpress: `[soroban_audit address="${address}" theme="light"]`,

      javascript: `<script>
  // Programmatic usage — call after the script loads
</script>
<div id="my-audit"></div>
<script src="${base}/api/v1/audit/embed/widget.js" onload="
  SorobanAudit.render(document.getElementById('my-audit'), {
    address: '${address}',
    theme: 'light',
    compact: false
  });
"></script>`,

      json_api: `curl "${base}/api/v1/audit/embed/data/${address}"`,
    };

    if (format !== 'all' && format in snippets) {
      return res.type('text/plain').send(snippets[format as keyof typeof snippets]);
    }

    res.json({
      contractAddress: address,
      auditScore: score,
      grade,
      snippets,
      widgetScriptUrl: `${base}/api/v1/audit/embed/widget.js`,
      badgeUrl: `${base}/api/v1/contracts/${address}/audit/badge.svg`,
      dataApiUrl: `${base}/api/v1/audit/embed/data/${address}`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /wordpress-plugin.zip — WordPress plugin archive ─────────────────────
// Serves a ready-to-install WordPress plugin that adds a [soroban_audit] shortcode.
// ZIP is built in-memory from two files — no filesystem writes, no dependencies.

auditEmbedRouter.get('/wordpress-plugin.zip', (_req: Request, res: Response) => {
  const base = BASE_URL();

  // Build plugin PHP source
  const phpPlugin = buildWordPressPlugin(base);
  const readmeTxt = buildWordPressReadme(base);

  // Build a minimal ZIP archive in memory (PKZIP format)
  const zip = buildZip([
    { path: 'soroban-audit/soroban-audit.php', data: phpPlugin },
    { path: 'soroban-audit/readme.txt', data: readmeTxt },
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="soroban-audit-plugin.zip"');
  res.setHeader('Content-Length', zip.length);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(zip);
});

// ── WordPress plugin PHP ───────────────────────────────────────────────────────

function buildWordPressPlugin(baseUrl: string): string {
  return `<?php
/**
 * Plugin Name:       Soroban Audit Widget
 * Plugin URI:        ${baseUrl}
 * Description:       Embed live Soroban smart contract audit scores on your WordPress site using the [soroban_audit] shortcode.
 * Version:           1.0.0
 * Author:            Soroban Explorer
 * Author URI:        ${baseUrl}
 * License:           MIT
 * Text Domain:       soroban-audit
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'SOROBAN_AUDIT_BASE_URL', '${baseUrl}' );
define( 'SOROBAN_AUDIT_VERSION',  '1.0.0' );

// ── Enqueue widget script ──────────────────────────────────────────────────────

function soroban_audit_enqueue_scripts() {
    wp_enqueue_script(
        'soroban-audit-widget',
        SOROBAN_AUDIT_BASE_URL . '/api/v1/audit/embed/widget.js',
        array(),
        SOROBAN_AUDIT_VERSION,
        true  // load in footer
    );
}
add_action( 'wp_enqueue_scripts', 'soroban_audit_enqueue_scripts' );

// ── Shortcode: [soroban_audit address="C..." theme="light" compact="false"] ───

function soroban_audit_shortcode( $atts ) {
    $atts = shortcode_atts(
        array(
            'address' => '',
            'theme'   => 'light',
            'compact' => 'false',
            'width'   => '',
            'class'   => '',
        ),
        $atts,
        'soroban_audit'
    );

    if ( empty( $atts['address'] ) ) {
        return '<p class="soroban-audit-error">Soroban Audit: please provide a contract address.</p>';
    }

    $address = esc_attr( sanitize_text_field( $atts['address'] ) );
    $theme   = in_array( $atts['theme'], array( 'light', 'dark' ) ) ? $atts['theme'] : 'light';
    $compact = $atts['compact'] === 'true' ? 'true' : 'false';
    $style   = $atts['width'] ? 'style="max-width:' . esc_attr( $atts['width'] ) . '"' : '';
    $extra_class = $atts['class'] ? ' ' . esc_attr( $atts['class'] ) : '';

    return '<div'
        . ' data-soroban-audit="' . $address . '"'
        . ' data-theme="' . $theme . '"'
        . ' data-compact="' . $compact . '"'
        . ' class="soroban-audit-shortcode' . $extra_class . '"'
        . ( $style ? ' ' . $style : '' )
        . '></div>';
}
add_shortcode( 'soroban_audit', 'soroban_audit_shortcode' );

// ── Gutenberg block (optional, registered as legacy block) ───────────────────

function soroban_audit_register_block() {
    if ( ! function_exists( 'register_block_type' ) ) return;

    register_block_type( 'soroban-audit/widget', array(
        'editor_script'   => 'soroban-audit-widget',
        'render_callback' => 'soroban_audit_shortcode',
        'attributes'      => array(
            'address' => array( 'type' => 'string', 'default' => '' ),
            'theme'   => array( 'type' => 'string', 'default' => 'light' ),
            'compact' => array( 'type' => 'string', 'default' => 'false' ),
        ),
    ));
}
add_action( 'init', 'soroban_audit_register_block' );

// ── Settings page ─────────────────────────────────────────────────────────────

function soroban_audit_admin_menu() {
    add_options_page(
        'Soroban Audit Widget',
        'Soroban Audit',
        'manage_options',
        'soroban-audit',
        'soroban_audit_settings_page'
    );
}
add_action( 'admin_menu', 'soroban_audit_admin_menu' );

function soroban_audit_settings_page() {
    ?>
    <div class="wrap">
        <h1>Soroban Audit Widget</h1>
        <p>Use the shortcode <code>[soroban_audit address="YOUR_CONTRACT_ADDRESS"]</code> on any page or post.</p>
        <h2>Shortcode Parameters</h2>
        <table class="widefat">
            <thead><tr><th>Parameter</th><th>Values</th><th>Default</th><th>Description</th></tr></thead>
            <tbody>
                <tr><td><code>address</code></td><td>Stellar contract address (C...)</td><td>—</td><td>Required. The Soroban smart contract address to display.</td></tr>
                <tr><td><code>theme</code></td><td>light | dark</td><td>light</td><td>Widget colour theme.</td></tr>
                <tr><td><code>compact</code></td><td>true | false</td><td>false</td><td>Show compact single-line badge.</td></tr>
                <tr><td><code>width</code></td><td>e.g. 300px</td><td>—</td><td>Optional max-width constraint.</td></tr>
            </tbody>
        </table>
        <h2>Examples</h2>
        <pre>[soroban_audit address="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"]</pre>
        <pre>[soroban_audit address="C..." theme="dark" compact="true" width="300px"]</pre>
        <h2>Badge (img tag)</h2>
        <p>You can also embed a static badge anywhere HTML is allowed:</p>
        <pre>&lt;img src="<?php echo esc_url( SOROBAN_AUDIT_BASE_URL ); ?>/api/v1/contracts/YOUR_ADDRESS/audit/badge.svg" /&gt;</pre>
        <p>API Base: <strong><?php echo esc_url( SOROBAN_AUDIT_BASE_URL ); ?></strong></p>
    </div>
    <?php
}
`;
}

function buildWordPressReadme(baseUrl: string): string {
  return `=== Soroban Audit Widget ===
Contributors: soroban-explorer
Tags: blockchain, smart-contract, audit, security, stellar, soroban
Requires at least: 5.0
Tested up to: 6.5
Stable tag: 1.0.0
License: MIT

Embed live Soroban smart contract audit scores on your WordPress site.

== Description ==

The Soroban Audit Widget plugin lets you display real-time audit scores for
Soroban smart contracts anywhere on your WordPress site using a simple shortcode.

**Features:**
* [soroban_audit] shortcode for any page, post, or widget area
* Supports light and dark themes
* Compact badge mode
* Gutenberg block support
* Live data fetched from the Soroban Explorer audit platform
* No API key required for public display

**Shortcode usage:**

  [soroban_audit address="C..."]
  [soroban_audit address="C..." theme="dark"]
  [soroban_audit address="C..." compact="true"]

**Data source:** ${baseUrl}

== Installation ==

1. Download soroban-audit-plugin.zip from ${baseUrl}/api/v1/audit/embed/wordpress-plugin.zip
2. In WordPress admin: Plugins → Add New → Upload Plugin
3. Upload the zip file and activate the plugin
4. Add [soroban_audit address="YOUR_CONTRACT_ADDRESS"] to any page

== Changelog ==

= 1.0.0 =
* Initial release
`;
}

// ── Minimal ZIP builder (PKZIP, store compression) ────────────────────────────

function buildZip(files: Array<{ path: string; data: string }>): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const fileData = Buffer.from(file.data, 'utf8');
    const fileName = Buffer.from(file.path, 'utf8');
    const crc = crc32(fileData);
    const dosDate = 0x5346; // 2024-10-06 placeholder
    const dosTime = 0x0000;

    // Local file header
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression (store)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(fileData.length, 18); // compressed size
    localHeader.writeUInt32LE(fileData.length, 22); // uncompressed size
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    fileName.copy(localHeader, 30);

    parts.push(localHeader, fileData);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + fileName.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // signature
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(0, 8); // flags
    cdEntry.writeUInt16LE(0, 10); // compression
    cdEntry.writeUInt16LE(dosTime, 12);
    cdEntry.writeUInt16LE(dosDate, 14);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(fileData.length, 20);
    cdEntry.writeUInt32LE(fileData.length, 24);
    cdEntry.writeUInt16LE(fileName.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra
    cdEntry.writeUInt16LE(0, 32); // comment
    cdEntry.writeUInt16LE(0, 34); // disk start
    cdEntry.writeUInt16LE(0, 36); // int attributes
    cdEntry.writeUInt32LE(0, 38); // ext attributes
    cdEntry.writeUInt32LE(offset, 42); // local header offset
    fileName.copy(cdEntry, 46);

    centralDir.push(cdEntry);
    offset += localHeader.length + fileData.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, cdBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  const table = crc32Table();
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
