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
 *
 * NOTE: Only routers that compile against the current Prisma schema are
 * mounted here. Additional routers exist in src/api/ for advanced features
 * (arbitrage, MEV, privacy, etc.) but depend on Prisma models not yet in
 * the schema. Those will be mounted once the models are added.
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
router.use('/simulate', simulateRouter);
router.use('/verify', verifyRouter);
router.use('/sync-state', syncStateRouter);
router.use('/network', networkRouter);
router.use('/token-metadata', tokenMetadataRouter);
router.use('/protocol', protocolRouter);
router.use('/aa', aaRouter);
router.use('/compliance', complianceRouter);

// ── Token Pricing & Valuation ─────────────────────────────────────────────────
router.use('/tokens', tokenPricesRouter);
router.use('/market', marketRouter);
router.use('/portfolio', portfolioRouter);
router.use('/market/alerts', alertsRouter);

// ── Natural Language Query Interface (#328) ───────────────────────────────────
router.use('/query', nlqRouter);

// ── Historical Data Market (#327) ─────────────────────────────────────────────
router.use('/data-market', dataMarketRouter);

// ── NFT Collection Discovery, Rarity Engine, Marketplace Analytics & Portfolio ──
import { nftRouter } from './nft';
router.use('/nft', nftRouter);

// ── Bridge Tracker ─────────────────────────────────────────────────────────────
import { bridgeTrackerRouter } from './bridge-tracker';
router.use('/bridge-tracker', bridgeTrackerRouter);

// ── Governance ─────────────────────────────────────────────────────────────────
import { governanceRouter } from './governance';
router.use('/governance', governanceRouter);

// ── Reputation ─────────────────────────────────────────────────────────────────
import { reputationRouter } from './reputation';
router.use('/reputation', reputationRouter);
