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
import { alertsRouter } from './alerts';

// ── CSV Exports ───────────────────────────────────────────────────────────────
import { exportsRouter } from './exports';
import { requireApiKey } from '../middleware/apiKeyAuth';

// ── Freeze Management ─────────────────────────────────────────────────────────
import { freezeRouter } from './freeze';

// ── Predictive Analytics ──────────────────────────────────────────────────────
import { predictRouter } from './predict';
import forecastRouter from './forecast';

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
router.use('/market/alerts', alertsRouter);

// ── Natural Language Query Interface (#328) ───────────────────────────────────
// nlq invokes LLM APIs — compute-heavy and billed per request; key required
router.use('/query', requireApiKey, nlqRouter);

// ── Historical Data Market (#327) ─────────────────────────────────────────────
// data-market includes write/purchase operations — key required
router.use('/data-market', requireApiKey, dataMarketRouter);

// ── NFT Collection Discovery, Rarity Engine, Marketplace Analytics & Portfolio ──
import { nftRouter } from './nft';
router.use('/nft', nftRouter);

// ── Bridge Tracker ─────────────────────────────────────────────────────────────
import { bridgeTrackerRouter } from './bridge-tracker';
router.use('/bridge-tracker', bridgeTrackerRouter);

// ── Admin ──────────────────────────────────────────────────────────────────────
import { adminRouter } from './admin';
router.use('/admin', adminRouter);
