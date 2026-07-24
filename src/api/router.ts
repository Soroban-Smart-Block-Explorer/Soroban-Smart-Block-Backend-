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

// ── Pricing & Market Intelligence ──────────────────────────────────────────────
import { marketRouter } from './market';
import { tokenPricesRouter } from './token-prices';
import { portfolioRouter } from './portfolio';
import { exportsRouter } from './exports';
import { syncStateRouter } from './sync-state';
import { governanceRouter } from './governance';
import { systemicRouter } from './systemic';
import { benchmarkRouter } from './benchmarks';
import { networkRouter } from './network';
import { emergencyBaseRouter } from './emergency-router';
import { stellarRouter } from './stellar';
import { privacyRouter } from './privacy';
import { mevRouter } from './mev';
import { developerRouter } from './developer/router';
import { scheduleRouter } from './schedule';
import feedRouter from './feed';
import backfillRouter from './backfill';
import marketRouter from './market';
import feedSSERouter from './feedSSE';
import { arbitrageRouter } from './arbitrage';
import { auditRouter } from './audit';
import { rateLimitAdminRouter } from './rate-limits';
import { alertsRouter } from './alerts';
import { oracleIntelligenceRouter } from './oracle-intelligence';

// ── Admin ─────────────────────────────────────────────────────────────────────
import { adminErrorsRouter } from './admin/errors';
// ── CSV Exports ───────────────────────────────────────────────────────────────
import { requireApiKey, requireKeyTier } from '../middleware/apiKeyAuth';
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

// ── Token Pricing & Valuation ─────────────────────────────────────────────────
router.use('/token-prices', tokenPricesRouter);
router.use('/market', marketRouter);
router.use('/portfolio', portfolioRouter);
router.use('/exports', exportsRouter);
router.use('/admin/rate-limits', rateLimitAdminRouter);
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

// ── Admin Dashboards ──────────────────────────────────────────────────────────
router.use('/admin/errors', adminErrorsRouter);
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

// ── Governance & DAO Framework (#567) ─────────────────────────────────────────
// Reads are public; writes are signature-authenticated inside the router.
// Treasury mounts before the base router so /governance/treasury/... wins
// over the /governance/:wildcard-style proposal routes.
import { governanceTreasuryRouter } from './governance-treasury';
router.use('/governance/treasury', governanceTreasuryRouter);
import { governanceRouter } from './governance';
router.use('/governance', governanceRouter);
router.use('/systemic', systemicRouter);
router.use('/benchmarks', benchmarkRouter);
router.use('/network', networkRouter);
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
router.use('/market', marketRouter);
// Arbitrage Intelligence Platform
router.use('/arbitrage', arbitrageRouter);
// Smart Contract Audit Trail & Certificate Platform
router.use('/audit', auditRouter);

// ── Multi-Layer Data Lakehouse (#551) ─────────────────────────────────────────
// Stream + OLAP + cold-storage query gateway. Compute-heavy — key required.
import { lakehouseRouter } from './lakehouse';
router.use('/lakehouse', requireApiKey, lakehouseRouter);
