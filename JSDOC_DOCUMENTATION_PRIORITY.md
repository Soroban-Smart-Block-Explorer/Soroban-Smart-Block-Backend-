# JSDoc Documentation Priority Plan

## Overview
Total of 1,180 route handlers across 124 API files. This document prioritizes documentation efforts based on impact and frequency of use.

## Priority Tier 1: Critical Paths (52 handlers)
**Focus**: Core Soroban functionality - heavily used by all integrations

### Tier 1A: Transaction & Contract APIs (15 handlers)
- **src/api/transactions.ts** (2 handlers)
  - GET / - List transactions
  - GET /:hash - Get transaction detail

- **src/api/contracts.ts** (6 handlers)
  - GET / - List contracts
  - GET /:address - Get contract detail
  - GET /:address/stats - Contract stats
  - GET /:address/simulate/functions - Simulate functions
  - POST / - Register contract ABI
  - POST /:address - Update contract

- **src/api/events.ts** (2 handlers)
  - GET / - List events
  - GET /:id - Get event detail

- **src/api/tokens.ts** (4 handlers)
  - GET / - List tokens
  - GET /:address - Token details
  - GET /:address/transfers - Token transfers
  - GET /:address/holders - Token holders

- **src/api/wallets.ts** (3 handlers)
  - GET /:address/transactions - Wallet transactions
  - GET /:address/events - Wallet events
  - GET /:address/portfolio - Wallet portfolio

### Tier 1B: DEX & Swap Analytics (12 handlers)
- **src/api/dex.ts** (2 handlers) ✓ DONE
- **src/api/dex-analytics.ts** (8 handlers)
- **src/api/arbitrage.ts** (42 handlers) - Large file, high impact

### Tier 1C: MEV Detection (45+ handlers)
- **src/api/sandwich.ts** (6 handlers) ✓ DONE
- **src/api/mev.ts** (33 handlers)
- **src/api/flash-loans.ts** (13 handlers)

### Tier 1D: Verification & Auth (25 handlers)
- **src/api/verify.ts** (4 handlers)
- **src/api/auth.ts** (14 handlers)
- **src/api/authSecurity.ts** (3 handlers)
- **src/api/authWebhooks.ts** (4 handlers)

## Priority Tier 2: High-Value Features (150 handlers)
**Focus**: Specialized features used by many dApps

### Tier 2A: Analytics & Data (20+ handlers)
- **src/api/analytics.ts** (2 handlers)
- **src/api/analytics-query.ts** (6 handlers)
- **src/api/lakehouse.ts** (7 handlers)
- **src/api/dashboards.ts** (19 handlers)

### Tier 2B: NFT & Asset Management (60+ handlers)
- **src/api/nft.ts** (29 handlers)
- **src/api/assets.ts** (1 handler)
- **src/api/token-metadata.ts** (5 handlers)
- **src/api/token-holders.ts** (5 handlers)
- **src/api/sac-trustlines.ts** (7 handlers)

### Tier 2C: Compliance & Governance (60+ handlers)
- **src/api/compliance.ts** (43 handlers)
- **src/api/audit.ts** (26 handlers)
- **src/api/governance.ts** (16 handlers)

### Tier 2D: Advanced Features (100+ handlers)
- **src/api/privacy.ts** (40 handlers)
- **src/api/agents.ts** (35 handlers)
- **src/api/composability.ts** (31 handlers)
- **src/api/nlq.ts** (30 handlers)
- **src/api/market.ts** (14 handlers)

## Priority Tier 3: Specialized Services (150+ handlers)
**Focus**: Domain-specific features with smaller user base

### Tier 3A: Data Services
- **src/api/data-market.ts** (35 handlers)
- **src/api/forecasting.ts** (10 handlers)
- **src/api/feed.ts** (10 handlers)

### Tier 3B: Operational Tools
- **src/api/schedule.ts** (27 handlers)
- **src/api/emergency.ts** (7 handlers)
- **src/api/monitoring.ts** (various)

### Tier 3C: Infrastructure APIs
- **src/api/webhooks.ts** (5 handlers)
- **src/api/contracts.ts** submodules
- **src/api/audit-*.ts** (various files)

## Priority Tier 4: Admin & Developer Portal (50+ handlers)
**Focus**: Internal tools and developer-facing features

- **src/api/developer/** (8 files)
  - keys.ts, billing.ts, usage.ts, etc.
- **src/api/admin/** (2 files)
  - api-keys.ts, errors.ts

## Implementation Strategy

### Phase 1: Foundation (Week 1)
1. ✓ Create JSDoc standards document (`docs/JSDOC_STANDARDS.md`)
2. Document Tier 1A (Transaction/Contract/Event APIs) - 10 handlers
3. Document Tier 1B-1D (DEX, MEV, Auth) - 42 handlers
4. **Target**: ~50 handlers documented

### Phase 2: High-Value (Week 2-3)
1. Document Tier 2A (Analytics) - 20 handlers
2. Document Tier 2B (NFT/Assets) - 60 handlers
3. Document Tier 2C (Compliance) - 60 handlers
4. **Target**: ~140 handlers documented

### Phase 3: Specialized Services (Week 3-4)
1. Document Tier 2D (Advanced) - 100 handlers
2. Document Tier 3 (Specialized) - 150 handlers
3. **Target**: ~250 handlers documented

### Phase 4: Admin & Portal (Week 4+)
1. Document Tier 4 (Admin/Developer)
2. Verify all routes have JSDoc
3. **Target**: All 1,180 handlers documented

## Coverage Metrics

### Current Status
- Total files: 124
- Total handlers: 1,180
- Documented: 8 (0.7%)
- Coverage: 0.7%

### Target Milestones
- **After Phase 1**: 50 handlers (4.2% coverage)
- **After Phase 2**: 190 handlers (16% coverage)
- **After Phase 3**: 440 handlers (37% coverage)
- **After Phase 4**: 1,180 handlers (100% coverage)

## Quality Standards

All JSDoc must include:
- [ ] Clear description of what the route does
- [ ] HTTP method and path specification
- [ ] All query parameters with types and descriptions
- [ ] All path parameters documented
- [ ] Request body schema (if applicable)
- [ ] All possible HTTP status codes
- [ ] Response schema examples
- [ ] Error documentation
- [ ] Usage examples
- [ ] Type annotations

## Tools & Resources

1. **JSDoc Generator**: `scripts/generate-jsdoc.ts`
   - Analyzes files for documentation gaps
   - Generates templates
   - Provides coverage reports

2. **Standards Template**: `docs/JSDOC_STANDARDS.md`
   - Provides consistent format
   - Examples for common patterns
   - Best practices and tips

3. **CI Integration**: Can fail builds if coverage < threshold

## Success Criteria

✓ All Tier 1 routes (52 handlers) fully documented with examples  
✓ All Tier 2 routes (150 handlers) documented with parameter details  
✓ All Tier 3 routes (150 handlers) documented  
✓ Automated checker prevents undocumented routes from merging  
✓ Documentation review included in PR process  

## Next Steps

1. ✓ Create standards document
2. ✓ Analyze all files and create priority list
3. → Begin Tier 1A documentation (this phase)
4. → Implement coverage reporting in CI
5. → Complete remaining tiers

## Documentation Examples

### Transaction List Route
```typescript
/**
 * List indexed transactions with optional filtering and pagination.
 *
 * @route {GET} /api/v1/transactions
 * @queryparam {string} [contract] - Filter by contract address
 * @queryparam {string} [account] - Filter by source account
 * @queryparam {string} [status] - Filter by status (success|failed)
 * @queryparam {number} [limit=20] - Page size (1-100)
 * @queryparam {number} [page=1] - Page number (1-based)
 * @returns {object} 200 - Success with transaction list
 * @returns {object} 400 - Bad request (validation error)
 * @returns {object} 500 - Internal server error
 * @example
 * GET /api/v1/transactions?contract=CXXX&limit=10
 * Response: { data: [...], pagination: {...} }
 */
```

---

**Created**: 2026-07-28  
**Last Updated**: 2026-07-28  
**Status**: In Progress  
