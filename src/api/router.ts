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
import { sandboxRouter } from './sandbox';
import { dexRouter } from './dex';
import { protocolRouter } from './protocol';
import { nftRouter } from './nft';
import { alertsRouter } from './alerts';
import { assetsRouter } from './assets';
import { sseRouter } from './sse';
import { graphRouter } from './graph';
import { virtualListRouter } from './virtualList';
import { tokenMetadataRouter } from './token-metadata';
import { webhooksRouter } from './webhooks';
import { analyticsRouter } from './analytics';
import { portfolioRouter } from './portfolio';
import { exportsRouter } from './exports';
import { syncStateRouter } from './sync-state';
import { yieldDistributionRouter } from './yield-distribution';
import { yieldRouter } from './yield';
import { dtccSettlementRouter } from './dtcc-settlement';
import { commodityComplianceRouter } from './commodity-compliance';
import { settlementBatchRouter } from './settlement-batch';
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

// ── Newly mounted routers (Issue #240) ────────────────────────────────────────
import { abiRouter } from './abi';
import { composabilityRouter } from './composability';
import { tipRouter } from './tip';
import { reputationRouter } from './reputation';
import { emergencyRouter } from './emergency';
import { checkedArithmeticRouter } from './checked-arithmetic';
import { protocol26Router } from './protocol26-state-extension';
import { advancedEventsRouter } from './advanced-events';
import { resourceAuditRouter } from './resource-audit';
import { factoryTrackerRouter } from './factory-tracker';
import { upgradeTraceRouter } from './upgrade-trace';
import { oracleAuditRouter } from './oracle-audit';
import { oracleFeedsRouter } from './oracle-feeds';
import { rwaComplianceRouter } from './rwa-compliance';
import { treasuryRouter } from './treasury';
import { signersRouter } from './signers';
import { taxRouter } from './tax';
import { complianceRouter } from './compliance';
import { freezeRouter } from './freeze';
import { sacTrustlinesRouter } from './sac-trustlines';
import { storageRouter } from './storage';
import { storageTrapRouter } from './storage-trap';
import { bn254Router } from './bn254';
import { compilerRouter } from './compiler-router';
import { dexAnalyticsRouter } from './dex-analytics';
import { predictRouter } from './predict';
import { lendingRouter } from './lending';

export const router = Router();

// ── i18n ──────────────────────────────────────────────────────────────────────
router.use('/i18n', i18nRouter);

// ── Core Stellar / Soroban ────────────────────────────────────────────────────
router.use('/transactions', transactionRouter);
router.use('/events', eventRouter);
router.use('/contracts', contractRouter);
router.use('/wallets', walletRouter);
router.use('/tokens', tokenRouter);
router.use('/authorizations', authorizationRouter);
router.use('/render', renderRouter);
router.use('/simulate', simulateRouter);
router.use('/verify', verifyRouter);
router.use('/sandbox', sandboxRouter);
router.use('/dex', dexRouter);
router.use('/dex-analytics', dexAnalyticsRouter);
router.use('/protocol', protocolRouter);
router.use('/nft', nftRouter);
router.use('/abi', abiRouter);
router.use('/stellar', stellarRouter);
router.use('/signers', signersRouter);

// ── Alerts & Monitoring ───────────────────────────────────────────────────────
router.use('/alerts', alertsRouter);
router.use('/assets', assetsRouter);
router.use('/sse', sseRouter);
router.use('/graph', graphRouter);
router.use('/virtual-list', virtualListRouter);
router.use('/token-metadata', tokenMetadataRouter);
router.use('/webhooks', webhooksRouter);
router.use('/analytics', analyticsRouter);
router.use('/portfolio', portfolioRouter);
router.use('/exports', exportsRouter);
router.use('/sync-state', syncStateRouter);

// ── DeFi & Yield ─────────────────────────────────────────────────────────────
router.use('/yield-distributions', yieldDistributionRouter);
router.use('/yield', yieldRouter);
router.use('/tip', tipRouter);

// ── Settlement & Compliance ───────────────────────────────────────────────────
router.use('/dtcc-settlement', dtccSettlementRouter);
router.use('/commodity-compliance', commodityComplianceRouter);
router.use('/settlement-batch', settlementBatchRouter);
router.use('/compliance', complianceRouter);
router.use('/rwa-compliance', rwaComplianceRouter);
router.use('/freeze', freezeRouter);
router.use('/sac-trustlines', sacTrustlinesRouter);
router.use('/tax', taxRouter);

// ── Governance & DAO ──────────────────────────────────────────────────────────
router.use('/governance', governanceRouter);
router.use('/reputation', reputationRouter);
router.use('/treasury', treasuryRouter);

// ── Risk & Security ───────────────────────────────────────────────────────────
router.use('/systemic', systemicRouter);
router.use('/mev', mevRouter);
router.use('/privacy', privacyRouter);
router.use('/composability', composabilityRouter);

// ── Network & Infrastructure ──────────────────────────────────────────────────
router.use('/benchmarks', benchmarkRouter);
router.use('/network', networkRouter);
router.use('/schedule', scheduleRouter);

// ── Oracle ────────────────────────────────────────────────────────────────────
// oracle-audit uses /oracles/audit prefix to avoid root-level /:requestTxHash conflict
router.use('/oracles/audit', oracleAuditRouter);
router.use('/oracle-feeds', oracleFeedsRouter);

// ── Contract Analysis ─────────────────────────────────────────────────────────
router.use('/checked-arithmetic', checkedArithmeticRouter);
router.use('/protocol26', protocol26Router);
router.use('/advanced-events', advancedEventsRouter);
router.use('/resource-audit', resourceAuditRouter);
router.use('/factory-tracker', factoryTrackerRouter);
router.use('/upgrade-trace', upgradeTraceRouter);
router.use('/storage', storageRouter);
router.use('/storage-trap', storageTrapRouter);
router.use('/bn254', bn254Router);
router.use('/compiler', compilerRouter);

// ── Lending & Liquidation Command Center ─────────────────────────────────────
router.use('/lending', lendingRouter);

// ── Developer Portal ─────────────────────────────────────────────────────────
router.use('/developer', developerRouter);

// ── Emergency ─────────────────────────────────────────────────────────────────
router.use('/emergency', emergencyBaseRouter);
router.use('/emergency/full', emergencyRouter);

// ── Data Mesh Platform APIs ───────────────────────────────────────────────────
router.use('/feed', feedRouter);
router.use('/feed/backfill', backfillRouter);
router.use('/feed/sse', feedSSERouter);
router.use('/market', marketRouter);
router.use('/predict', predictRouter);
