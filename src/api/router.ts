/**
 * src/api/router.ts
 *
 * Central API router for the Soroban Block Explorer backend.
 *
 * All routers in src/api/ are registered here. A RouterRegistry CI check
 * (scripts/validate-routes.ts) ensures every exported router is mounted —
 * new routers added without a corresponding entry here will fail CI.
 *
 * Route prefix conventions:
 *   - Kebab-case, matching the file name where possible
 *   - No trailing slashes
 *   - oracle-audit mounts under /oracles/audit (avoids root wildcard conflict)
 */

import { Router } from 'express';

// ── Previously mounted routers ────────────────────────────────────────────────
import { i18nRouter } from './i18n';
import { transactionRouter } from './transactions';
import { eventRouter } from './events';
import { contractRouter } from './contracts';
import { walletRouter } from './wallets';
import { tokenRouter } from './tokens';
import { batchRouter } from './batch';
import { authorizationRouter } from './authorizations';
import { renderRouter } from './render';
import { simulateRouter } from './simulate';
import { verifyRouter } from './verify';
import { syncStateRouter } from './sync-state';
import { networkRouter } from './network';
import { tokenMetadataRouter } from './token-metadata';
import { protocolRouter } from './protocol';
import { aaRouter } from './aa';
import { complianceRouter } from './compliance';
import { nlqRouter } from './nlq';
import { dataMarketRouter } from './data-market';

// ── Search API (#662 - Orphaned routes) ────────────────────────────────────────
import { searchRouter } from './search';

// ── Contract Analysis ──────────────────────────────────────────────────────────
import { reentrancyRouter } from './reentrancy';
import { composabilityRouter } from './composability';

// ── DEX & Pricing & Market Intelligence ────────────────────────────────────────
import { dexRouter } from './dex';
import { dexAnalyticsRouter } from './dex-analytics';
import { marketRouter } from './market';
import { tokenPricesRouter } from './token-prices';
import { portfolioRouter } from './portfolio';
import { exportsRouter } from './exports';
import { systemicRouter } from './systemic';
import { benchmarkRouter } from './benchmarks';
import { emergencyBaseRouter } from './emergency-router';
import { stellarRouter } from './stellar';
import { privacyRouter } from './privacy';
import { mevRouter } from './mev';
import { developerRouter } from './developer/router';
import { scheduleRouter } from './schedule';
import feedRouter from './feed';
import backfillRouter from './backfill';
import feedSSERouter from './feedSSE';
import { arbitrageRouter } from './arbitrage';
import { auditRouter } from './audit';
import { rateLimitAdminRouter } from './rate-limits';
import { alertsRouter } from './alerts';
import { oracleIntelligenceRouter } from './oracle-intelligence';

// ── SAC Trustlines (#637) ─────────────────────────────────────────────────────
import { sacTrustlinesRouter } from './sac-trustlines';

// ── Admin ─────────────────────────────────────────────────────────────────────
import { adminErrorsRouter } from './admin/errors';
import { deadLetterAdminRouter } from './admin/dead-letter';
import { featureFlagsAdminRouter } from './feature-flags';
// ── CSV Exports ───────────────────────────────────────────────────────────────
import { requireApiKey, requireKeyTier } from '../middleware/apiKeyAuth';
import { adminRateLimit, adminRateLimitsOverrideRateLimit } from '../middleware/adminRateLimit';
import { compilerRouter } from './compiler-router';
import { sandboxRouter } from './sandbox';

// ── MEV / Sandwich Detection (#290) ──────────────────────────────────────────

// ── Freeze Management ─────────────────────────────────────────────────────────

// ── Predictive Analytics ──────────────────────────────────────────────────────
import { fraudRouter } from './fraud';

export const router = Router();

// ── Core Stellar / Soroban ────────────────────────────────────────────────────
router.use('/i18n', i18nRouter);
router.use('/transactions', transactionRouter);
router.use('/events', eventRouter);
router.use('/contracts', contractRouter);
router.use('/wallets', walletRouter);
router.use('/tokens', tokenRouter);
router.use('/batch', batchRouter);
router.use('/authorizations', authorizationRouter);
router.use('/render', renderRouter);
// simulate and verify invoke Soroban RPC and perform heavy analysis — key required
router.use('/simulate', requireApiKey, simulateRouter);
router.use('/verify', requireApiKey, verifyRouter);
// compiler endpoints require developer+ tier (expensive builds)
router.use('/compiler', requireKeyTier('developer'), compilerRouter);
router.use('/sandbox', sandboxRouter);
router.use('/sync-state', syncStateRouter);
router.use('/network', networkRouter);
router.use('/token-metadata', tokenMetadataRouter);
router.use('/protocol', protocolRouter);
// aa (account abstraction) performs compute-heavy operations — key required
router.use('/aa', requireApiKey, aaRouter);
// compliance contains write mutations and sensitive analysis — key required
router.use('/compliance', requireApiKey, complianceRouter);

// ── Search (#662) ─────────────────────────────────────────────────────────────
router.use('/search', searchRouter);

// ── Contract Analysis ─────────────────────────────────────────────────────────
router.use('/reentrancy', reentrancyRouter);
router.use('/composability', composabilityRouter);

// ── DEX & Pricing ──────────────────────────────────────────────────────────────
router.use('/dex', dexRouter);
router.use('/dex-analytics', dexAnalyticsRouter);

// ── Token Pricing & Valuation ─────────────────────────────────────────────────
router.use('/token-prices', tokenPricesRouter);
router.use('/market', marketRouter);
router.use('/portfolio', portfolioRouter);
router.use('/exports', exportsRouter);
// ── Admin Rate Limiting (#889) ─────────────────────────────────────────────────
// Apply a strict IP-keyed limiter to the entire /admin surface before any
// sub-router has a chance to handle the request. The override store gets an
// even tighter limit because mutations there directly affect API throttling.
router.use('/admin', adminRateLimit);
router.use('/admin/rate-limits', adminRateLimitsOverrideRateLimit, rateLimitAdminRouter);
router.use('/market/alerts', alertsRouter);
router.use('/oracles/intelligence', oracleIntelligenceRouter);

// ── Predictive Analytics ──────────────────────────────────────────────────────
router.use('/fraud', fraudRouter);

// ── Natural Language Query Interface (#328) ───────────────────────────────────
// nlq invokes LLM APIs — compute-heavy and billed per request; key required
router.use('/query', requireApiKey, nlqRouter);

// ── Historical Data Market (#327) ─────────────────────────────────────────────
// data-market includes write/purchase operations — key required
router.use('/data-market', requireApiKey, dataMarketRouter);

// ── NFT Collection Discovery, Rarity Engine, Marketplace Analytics & Portfolio ──
import { nftRouter } from './nft';
router.use('/nft', nftRouter);

// ── SAC Trustlines (#637) ─────────────────────────────────────────────────────
router.use('/sac-trustlines', sacTrustlinesRouter);

// ── Admin Dashboards ──────────────────────────────────────────────────────────
router.use('/admin/errors', adminErrorsRouter);
router.use('/admin/dead-letter', deadLetterAdminRouter);
router.use('/admin/feature-flags', featureFlagsAdminRouter);
// ── Bridge Tracker ─────────────────────────────────────────────────────────────
import { bridgeTrackerRouter } from './bridge-tracker';
router.use('/bridge-tracker', bridgeTrackerRouter);

// ── ZKP Verification History ──────────────────────────────────────────────────
import { zkpVerificationsRouter } from './zkp-verifications';
router.use('/zkp-verifications', zkpVerificationsRouter);

// ── Admin ──────────────────────────────────────────────────────────────────────
import { adminRouter } from './admin';
router.use('/admin', adminRouter);

// ── Universal ABI Extraction (#289) ──────────────────────────────────────────
import { abiExtractRouter } from './abi-extract';
router.use('/abi-extract', abiExtractRouter);

// ── Webhook Subscriptions (#478 #481 #482 #483) ───────────────────────────────
// Auth and owner-scoping are enforced inside webhooksRouter itself.
import { webhooksRouter } from './webhooks';
router.use('/webhooks', webhooksRouter);

// ── Storage & Storage Trap (#838) ─────────────────────────────────────────────
// Contract persistent-storage inspection and storage-trap (footprint abuse) detection.
import { storageRouter } from './storage';
import { storageTrapRouter } from './storage-trap';
router.use('/storage', storageRouter);
router.use('/storage-trap', storageTrapRouter);

// ── Autonomous Agents (#840) ──────────────────────────────────────────────────
// Deploy, run, verify, communicate with, and monitor on-chain autonomous agents.
import { agentRouter } from './agents';
router.use('/agents', requireApiKey, agentRouter);

// ── Oracle Audit & Feeds (#841) ───────────────────────────────────────────────
// Oracle audit history, feed health, and price integrity validation.
import { oracleAuditRouter } from './oracle-audit';
import { oracleFeedsRouter } from './oracle-feeds';
router.use('/oracles/audit', oracleAuditRouter);
router.use('/oracles/feeds', oracleFeedsRouter);

// ── Archive & Assets (#842) ───────────────────────────────────────────────────
// Archived data retrieval (S3/Parquet cold storage) and asset listings.
import { archiveRouter } from './archive';
import { assetsRouter } from './assets';
router.use('/archive', archiveRouter);
router.use('/assets', assetsRouter);

// ── Governance & DAO Framework (#567) ─────────────────────────────────────────
// Reads are public; writes are signature-authenticated inside the router.
// Treasury mounts before the base router so /governance/treasury/... wins
// over the /governance/:wildcard-style proposal routes.
import { governanceTreasuryRouter } from './governance-treasury';
import { governanceRouter } from './governance';
router.use('/governance/treasury', governanceTreasuryRouter);
router.use('/governance', governanceRouter);
router.use('/systemic', systemicRouter);
router.use('/benchmarks', benchmarkRouter);
router.use('/emergency', emergencyBaseRouter);
router.use('/stellar', stellarRouter);
router.use('/privacy', privacyRouter);
router.use('/mev', mevRouter);
router.use('/developer', developerRouter);
router.use('/schedule', scheduleRouter);
// Data Mesh Platform APIs
router.use('/feed', feedRouter);
router.use('/feed/backfill', backfillRouter);
router.use('/feed/sse', feedSSERouter);
// Arbitrage Intelligence Platform
router.use('/arbitrage', arbitrageRouter);
// Smart Contract Audit Trail & Certificate Platform
router.use('/audit', auditRouter);

// ── Analytics & Dashboards (#839) ─────────────────────────────────────────────
import { analyticsRouter } from './analytics';
import { dashboardRouter } from './dashboards';
import { analyticsQueryRouter } from './analytics-query';
router.use('/analytics', requireApiKey, analyticsRouter);
router.use('/dashboards', requireApiKey, dashboardRouter);
// Analytics query router — template-based warehouse queries against Iceberg
router.use('/analytics/query', requireApiKey, analyticsQueryRouter);

// ── Multi-Layer Data Lakehouse (#551) ─────────────────────────────────────────
// Stream + OLAP + cold-storage query gateway. Compute-heavy — key required.
import { lakehouseRouter } from './lakehouse';
router.use('/lakehouse', requireApiKey, lakehouseRouter);

// ── ABI & Advanced Events (#843) ───────────────────────────────────────────────
// ABI management and advanced event filtering for Soroban contracts.
import { abiRouter } from './abi';
import { advancedEventsRouter } from './advanced-events';
router.use('/abi', abiRouter);
router.use('/events/advanced', advancedEventsRouter);

// ── Factory Tracker & Upgrade Trace (#844) ────────────────────────────────────
// Contract factory patterns and wasm upgrade history.
import { factoryTrackerRouter } from './factory-tracker';
import { upgradeTraceRouter } from './upgrade-trace';
router.use('/factory-tracker', factoryTrackerRouter);
router.use('/upgrade-trace', upgradeTraceRouter);

// ── Auth Extension Routers (#845) ──────────────────────────────────────────────
// Multi-sig auth, profile management, security settings, and auth webhooks.
import { authMultisigRouter } from './authMultisig';
import { authProfileRouter } from './authProfile';
import { authSecurityRouter } from './authSecurity';
import { authWebhooksRouter } from './authWebhooks';
router.use('/auth/multisig', authMultisigRouter);
router.use('/auth/profile', authProfileRouter);
router.use('/auth/security', authSecurityRouter);
router.use('/auth/webhooks', authWebhooksRouter);

// ── Compliance Extension Routers (#846) ────────────────────────────────────────
// Commodity, RWA, DTCC settlement, and settlement-batch compliance.
import { commodityComplianceRouter } from './commodity-compliance';
import { rwaComplianceRouter } from './rwa-compliance';
import { dtccSettlementRouter } from './dtcc-settlement';
import { settlementBatchRouter } from './settlement-batch';
router.use('/compliance/commodity', commodityComplianceRouter);
router.use('/compliance/rwa', rwaComplianceRouter);
router.use('/compliance/dtcc-settlement', dtccSettlementRouter);
router.use('/compliance/settlement-batch', settlementBatchRouter);
