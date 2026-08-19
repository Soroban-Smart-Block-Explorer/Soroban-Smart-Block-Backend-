# Test Coverage Assessment — Soroban Smart Block Backend

**Date:** July 28, 2026  
**Test Files:** 140 total test files  
**Source Files:** 557 total TypeScript source files  
**Overall Coverage:** ~25% (significant gaps in critical modules)

---

## Executive Summary

The codebase exhibits substantial test coverage gaps in security-critical and high-complexity modules. Priority focus on **auth**, **middleware**, and **feed** systems is essential given their direct involvement in user-facing security, rate limiting, and real-time data delivery.

---

## Coverage by Category

### 🔴 CRITICAL — Security & Access Control

**Status:** ~15% tested

#### Auth Module (5 files, 0% tested)
- `src/auth/challenge.ts` — Challenge generation & verification
- `src/auth/middleware.ts` — Auth middleware chain
- `src/auth/rbac.ts` — Role-based access control
- `src/auth/keys.ts` — Key pair rotation & management
- `src/auth/tokens.ts` — JWT issuance & verification

**Criticality:** 🔴 **CRITICAL**
- Direct involvement in authentication flow
- Token issuance and verification
- RBAC enforcement
- Session security
- Challenge-response nonce management

**Risk:** Undetected auth bypass, privilege escalation, token forgery

---

### 🔴 CRITICAL — Middleware & Request Pipeline

**Status:** ~20% tested

#### Middleware Module (14 files, ~29% tested)

**Fully Tested:**
- ✅ `rateLimit.ts` — Rate limiting (has test file)
- ✅ `sanitize.ts` — Input sanitization (has test file)

**Untested:**
- ❌ `coldStorageRouter.ts` (780 LOC) — Archive data routing
- ❌ `replicaGuard.ts` — Replica read verification
- ❌ `requestContext.ts` — Request context tracking
- ❌ `regionScope.ts` — Multi-region request scoping
- ❌ `correlation.ts` — Request correlation IDs
- ❌ `networkRouter.ts` — Network selection routing
- ❌ `errorHandler.ts` — Global error handling
- ❌ `queryRouter.ts` — Query complexity routing
- ❌ `tokenBucket.ts` — Token bucket algorithm
- ❌ `apiKeyAuth.ts` (341 LOC) — API key validation & tier checking
- ❌ `adminAuth.ts` — Admin authentication
- ❌ `proxyTrust.ts` — Proxy header verification
- ❌ `metricsMiddleware.ts` — Request metrics collection
- ❌ `auditLog.ts` — Audit logging
- ❌ `requestValidation.ts` — Request schema validation
- ❌ `asyncHandler.ts` — Error handling wrapper

**Criticality:** 🔴 **CRITICAL**
- `coldStorageRouter.ts` routes requests to archive, parquet, glacier tiers — data integrity issue
- `apiKeyAuth.ts` enforces billing/tier restrictions — revenue impact
- `errorHandler.ts` global catch-all — security vulns could leak internal state
- `queryRouter.ts` prevents DOS via query complexity — missing tests = DOS vulnerability

**Risk:** DOS attacks, data corruption, billing bypass, auth bypass, information leakage

---

### 🟠 HIGH — Internationalization (i18n)

**Status:** 0% tested

#### i18n Module (2 files)
- ❌ `src/i18n/engine.ts` (219 LOC) — Translation engine & interpolation
- ❌ `src/i18n/middleware.ts` (55 LOC) — Language detection middleware
- ✅ `src/i18n/locales/*.ts` — Translation dictionaries (data-only, not testable)

**Criticality:** 🟠 **HIGH**
- User-facing strings and error messages
- XSS vectors if interpolation not escaped
- Missing translations → user confusion/support tickets

**Risk:** XSS injection via translation keys, missing fallback handling

---

### 🔴 CRITICAL — Feed System (Real-time Streaming)

**Status:** ~40% tested

#### Feed Module (7 files, ~43% tested)

**Fully Tested:**
- ✅ `src/feed/subscriptionManager.ts` (has `feed-subscription.test.ts`)

**Untested:**
- ❌ `channelManager.ts` (213 LOC) — Channel registration & lifecycle
- ❌ `deliveryService.ts` (224 LOC) — Message delivery routing
- ❌ `orchestrator.ts` (231 LOC) — Orchestration & metrics publishing
- ❌ `streamingServer.ts` (189 LOC) — SSE/WebSocket setup
- ❌ `websocketServer.ts` (184 LOC) — WebSocket connection handling
- ❌ `publisher.ts` (65 LOC) — Sequence tracking & publishing

**Criticality:** 🔴 **CRITICAL**
- Real-time data delivery affects trader decision-making
- Missing tests on `deliveryService` = missed events/crashes → data inconsistency
- `websocketServer` handles untrusted client input — potential injection
- `orchestrator` metrics affect monitoring — inaccurate metrics = blind ops

**Risk:** Message loss, connection leaks, memory leaks under load, delivery failures

---

### 🔴 CRITICAL — Indexer (Data Ingestion)

**Status:** ~35% tested

#### Indexer Module Priority (3 high-risk files, 0% tested)

**Most Critical Untested:**
1. ❌ `arbitrage-engine.ts` (979 LOC, 152 complexity score)
   - Detects MEV/sandwich attacks
   - Missing tests = blindness to attack patterns
   
2. ❌ `audit-monitor.ts` (742 LOC, 93 complexity score)
   - Continuous contract audit scheduling
   - Missing tests = audit expiry not detected
   
3. ❌ `composability-engine.ts` (656 LOC, 123 complexity score)
   - Cross-contract call detection
   - Missing tests = composability risks not detected

**Additional High-Risk Untested (40+ files):**
- `audit-pipeline.ts`, `audit-engine.ts` — Core audit logic
- `systemicRisk.ts` (841 LOC) — Network risk scoring
- `flashLoanDetector.ts` (529 LOC) — Attack pattern detection
- `sandwich-detector.ts` (654 LOC) — MEV sandwich detection
- `privacy-detector.ts` (427 LOC) — Privacy technique classification
- `aa-classifier.ts` (556 LOC) — Account abstraction detection
- Token metadata fetching, XDR parsing, upgrade detection

**Criticality:** 🔴 **CRITICAL**
- Core analytics & risk detection
- Missing tests = undetected protocol threats
- Complex business logic with high failure modes

**Risk:** Missed attack patterns, risk scoring failures, audit pipeline crashes

---

### 🟠 HIGH — Services Module

**Status:** ~15% tested

#### Service Modules (Multiple subdirectories)

**Untested Service Categories:**

1. **Compliance** (9 files)
   - `src/services/compliance/`
   - Sanctions screening, risk scoring, transaction blocking
   - Zero tests = compliance violations

2. **Pricing** (8 files)
   - `src/services/pricing/`
   - Price discovery, DEX integration
   - Missing tests = stale/incorrect prices

3. **Governance** (5 files)
   - `src/services/governance/`
   - Voting power calculation, proposal lifecycle
   - Missing tests = voting power miscalculation

4. **Ramp Gateway** (providers + order management)
   - `src/services/ramp/`
   - Fiat on/off-ramp orchestration
   - Missing tests = order reconciliation failures

5. **Graph-based Services** (multiple)
   - Graph sync, analytics, features, templates
   - Complex business logic with no tests

**Criticality:** 🟠 **HIGH**
- `compliance` → regulatory risk
- `pricing` → trader financial loss
- `governance` → consensus manipulation
- `ramp` → revenue loss

---

### 🟠 HIGH — SDK Modules

**Status:** ~0% tested

#### SDK Module (2 subdirectories)

**Untested:**
- ❌ `src/sdk/typescript.ts` — TypeScript client library
- ❌ `src/sdk/reputationClient.ts` — Reputation API client
- ❌ `src/sdk/mobile/*` — React Native mobile SDK (6+ files)

**Criticality:** 🟠 **HIGH**
- External-facing APIs
- Third-party integrations depend on stability
- Breaking changes go undetected

---

## Priority Matrix

| Priority | Category | Files | LOC | Impact |
|----------|----------|-------|-----|--------|
| 🔴 P0 | Auth Module | 5 | 400 | Security bypass, privilege escalation |
| 🔴 P0 | Middleware (API Key + Error) | 4 | 500 | Revenue loss, DOS, data leak |
| 🔴 P0 | Indexer Core (Arbitrage + Audit) | 3 | 2700 | Blindness to attacks |
| 🔴 P0 | Feed (Delivery + WebSocket) | 4 | 600 | Message loss, crashes |
| 🟠 P1 | i18n | 2 | 270 | XSS, user experience |
| 🟠 P1 | Compliance | 9 | 1200+ | Regulatory violation |
| 🟠 P1 | Pricing Services | 8 | 1000+ | Incorrect prices → losses |
| 🟠 P1 | Governance | 5 | 600 | Voting power miscalculation |
| 🟠 P1 | Ramp Services | 8+ | 1500+ | Revenue & order loss |
| 🟠 P1 | SDK | 8 | 900 | Client library instability |

---

## Recommended Test Strategy

### Phase 1: Security Foundation (Weeks 1-2)
**Goal:** Eliminate auth & middleware security risks

1. **Auth Module** (120 tests)
   - Challenge generation & verification
   - Token lifecycle (issue, verify, refresh, revoke)
   - RBAC enforcement (hasRole, getFeatures)
   - Key rotation scenarios
   - Nonce replay protection

2. **Middleware Priority** (100 tests)
   - `apiKeyAuth` — tier enforcement, rate limit override
   - `errorHandler` — error classification, response format
   - `queryRouter` — complexity scoring, routing decision
   - `tokenBucket` — token depletion, refill timing
   - `coldStorageRouter` — tier selection, fallback logic

3. **Feed Core** (80 tests)
   - Message delivery paths (WebSocket, SSE, webhook)
   - Connection lifecycle
   - Subscription filtering
   - Sequence tracking

**Outcome:** 300 new tests, 0 security holes

---

### Phase 2: Critical Business Logic (Weeks 3-4)
**Goal:** Detect attack patterns and audit failures

1. **Indexer Priority** (200 tests)
   - Arbitrage detection (sandwich, direct, negative cycle)
   - Audit pipeline (scheduling, scoring, expiry)
   - Composability risk detection

2. **Risk Detection** (100 tests)
   - Flash loan detection
   - Privacy technique classification
   - Account abstraction patterns

**Outcome:** 300 new tests, early detection of protocol threats

---

### Phase 3: Integration & Revenue (Weeks 5-6)
**Goal:** Prevent revenue loss and compliance violations

1. **Compliance** (150 tests)
2. **Pricing** (100 tests)
3. **Ramp Gateway** (100 tests)
4. **Governance** (80 tests)

**Outcome:** 430 new tests, prevent regulatory & financial incidents

---

### Phase 4: External APIs (Week 7)
**Goal:** Stabilize client SDKs

1. **TypeScript SDK** (80 tests)
2. **Mobile SDK** (80 tests)
3. **Reputation Client** (40 tests)

**Outcome:** 200 new tests, stable client experience

---

## Test Infrastructure Recommendations

### Test Helpers & Fixtures
- **Auth:** Mock JWT verification, key generation fixtures
- **Feed:** In-memory subscription manager, WebSocket mock
- **Indexer:** Transaction replay fixtures, pool state snapshots
- **Compliance:** Mock sanctions DB, test screening rules

### Coverage Targets
- **Auth:** 90%+
- **Middleware:** 85%+
- **Indexer Core:** 75%+
- **Feed:** 80%+
- **Services:** 70%+
- **SDK:** 75%+

### CI/CD Integration
```bash
# Run critical tests before PR merge
npm run test:critical

# Full suite before release
npm run test
npm run coverage
```

---

## Summary of Impact

| Metric | Current | Target | Gain |
|--------|---------|--------|------|
| Test Files | 140 | 200+ | +60 |
| Total Tests | ~1,500 | ~2,500+ | +1,000 |
| Coverage (%) | 25% | 55%+ | +30% |
| Security Gaps | High | Minimal | 🔒 |
| Audit Risk | High | Low | ✅ |
| Revenue Risk | High | Low | 💰 |

---

## Next Steps

1. ✅ This assessment document
2. → Phase 1: Auth + Middleware tests (start immediately)
3. → Integrate into CI/CD before phase 2
4. → Establish coverage baselines & alerts
5. → Quarterly coverage reviews

---

**Assessment by:** Test Coverage Analysis  
**Recommendation:** Begin Phase 1 immediately. Security risks cannot be deferred.
