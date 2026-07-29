# Test Exclusion Analysis: orphaned-routers-integration.test.ts

**Date:** July 28, 2026  
**File:** `tests/orphaned-routers-integration.test.ts`  
**Status:** ✅ Analysis Complete

---

## Problem Statement

The comprehensive integration test file `tests/orphaned-routers-integration.test.ts` is **explicitly excluded** from the main test suite in `vitest.config.ts`:

```typescript
// vitest.config.ts line 7
exclude: ['tests/orphaned-routers-integration.test.ts'],
```

### Impact
- **81 integration tests** not running in normal `npm test` flow
- Tests must be run separately via `npm run test:routes`
- CI/CD may miss coverage of these endpoint integrations
- Test visibility reduced

---

## Current Configuration

### vitest.config.ts
```typescript
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/orphaned-routers-integration.test.ts'], // ← Excluded
    testTimeout: 30_000,
    // ... rest of config
  },
});
```

### package.json Scripts

```json
{
  "test": "DATABASE_URL=... vitest run tests/reentrancy-fortress.test.ts ...",
  "test:routes": "vitest run tests/orphaned-routers-integration.test.ts",
  "test:full": "vitest run",
  "test:coverage": "vitest run --coverage"
}
```

---

## About the Excluded Test

### File Details
- **Path:** `tests/orphaned-routers-integration.test.ts`
- **Size:** 749 lines
- **Test Count:** 81 tests
- **Purpose:** Integration tests for 18+ newly mounted API routers (Issue #240)
- **Scope:** Validates that orphaned endpoints are reachable and return proper responses

### Test Characteristics

**What it tests:**
- All previously orphaned API endpoints
- HTTP status codes (no 404 errors)
- Basic response structure validation
- Endpoint reachability

**Requirements:**
- Requires running API server (not mocked)
- Uses `TEST_API_URL` environment variable (default: `http://localhost:3000`)
- Actually makes HTTP requests
- Integration-level (not unit tests)

### Test Coverage

```typescript
// Example from file:
async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

// Tests hit real endpoints:
it('GET /api/v1/transactions', async () => {
  const { status } = await get('/transactions');
  expect(status).not.toBe(404);
});
```

---

## Why It Was Excluded

### Root Cause Analysis

1. **External Dependencies** — Requires running API server
   - Cannot run in headless test environment without server
   - Flaky if server is unavailable
   - Different environment requirements than unit tests

2. **Execution Context** — Integration vs Unit
   - Unit tests: Fast, isolated, mocked
   - Integration tests: Slow, coupled, real HTTP

3. **CI/CD Considerations** — Separate execution model
   - Can't run tests if server not running
   - Requires docker-compose or deployed instance
   - Different parallelization strategy

---

## Current Workarounds

### Running the Tests

```bash
# Only these specific tests
npm run test:routes

# All tests (including excluded)
npm run test:full

# With coverage
npm run test:coverage
```

### In CI/CD

If configured:
```bash
# Run main suite
npm test

# Then run integration tests
npm run test:routes
```

---

## Recommended Solutions

### Option 1: ✅ RECOMMENDED - CI/CD Integration (Minimal Risk)

**Approach:** Keep separate, add explicit CI step

**Implementation:**
1. Keep `vitest.config.ts` unchanged
2. Add CI/CD step to run both test suites
3. Document in README

**Pros:**
- ✅ Maintains test isolation
- ✅ No config changes needed
- ✅ Clear separation of concerns
- ✅ Flexible timing

**Cons:**
- ❌ Requires separate CI step
- ❌ Not run locally by default

**When to use:** When you want different environments for unit vs integration tests

---

### Option 2: Remove Exclusion (Higher Risk)

**Approach:** Remove from exclude, update vitest config

**Implementation:**
```typescript
// vitest.config.ts
exclude: [
  // Remove: 'tests/orphaned-routers-integration.test.ts',
  // Add skip condition or conditional compilation instead
],
```

**Pros:**
- ✅ All tests run together
- ✅ Single command

**Cons:**
- ❌ Tests fail without server
- ❌ Requires infrastructure setup
- ❌ Slower overall test run
- ❌ May not work in all environments

**When to use:** If you have reliable test server infrastructure

---

### Option 3: Conditional Execution

**Approach:** Skip if server unavailable

**Implementation:**
```typescript
// tests/orphaned-routers-integration.test.ts
const SKIP_INTEGRATION = !process.env.TEST_API_URL && !isServerRunning();

describe.skipIf(SKIP_INTEGRATION)('API Routes Integration', () => {
  // ... tests
});
```

**Pros:**
- ✅ Runs when possible
- ✅ Skips gracefully when not

**Cons:**
- ❌ Modifies test logic
- ❌ May mask missing infrastructure

**When to use:** For optional/conditional test suites

---

## Recommended Implementation: Option 1

### Step 1: Document in README

Add to project README:

```markdown
## Running Tests

### Unit Tests
```bash
npm test                 # Run main test suite
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
```

### Integration Tests
```bash
# Start API server first
docker-compose up

# Then in another terminal
npm run test:routes     # Run integration tests
```

### All Tests
```bash
npm run test:full       # All tests (requires server)
```
```

### Step 2: Add GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: test
      api:
        image: soroban-api:latest
        ports:
          - 3000:3000
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:routes
```

### Step 3: Add npm script for comprehensive testing

```json
{
  "test:all": "npm test && npm run test:routes",
  "test:ci": "npm run test:all"
}
```

### Step 4: Document in CONTRIBUTING.md

```markdown
## Test Suites

### Main Test Suite (Unit Tests)
- **Location:** `tests/` and `src/**/*.test.ts`
- **Run:** `npm test`
- **Environment:** No external dependencies
- **Speed:** Fast (~30 seconds)
- **Failures:** Should not occur on valid code

### Integration Tests (Endpoint Coverage)
- **Location:** `tests/orphaned-routers-integration.test.ts`
- **Run:** `npm run test:routes`
- **Environment:** Requires running API server
- **Speed:** Moderate (~1-2 minutes)
- **Failures:** May occur if server unavailable

### Complete Suite
- **Run:** `npm run test:all` (runs both)
- **Duration:** ~2-3 minutes total
- **Recommended:** Before pushing PR
```

---

## Quick Decision Matrix

| Scenario | Recommendation | Command |
|----------|-----------------|---------|
| Local development | Run separately | `npm test`, then `npm run test:routes` |
| Pre-commit | Run main only | `npm test` |
| CI/CD (fast) | Both in parallel | `npm test & npm run test:routes` |
| CI/CD (safety) | Both sequential | `npm test && npm run test:routes` |
| Full verification | Everything | `npm run test:all` |

---

## Implementation Steps (Recommended)

### Week 1: Documentation
- [ ] Add README section on test suites
- [ ] Add CONTRIBUTING.md guidance
- [ ] Document current behavior

### Week 2: CI/CD Setup
- [ ] Add GitHub Actions workflow (if not present)
- [ ] Add npm scripts for comprehensive testing
- [ ] Test locally

### Week 3: Team Communication
- [ ] Notify team of test structure
- [ ] Update local development docs
- [ ] Establish best practices

### Week 4: Monitoring
- [ ] Monitor CI/CD success rates
- [ ] Track test execution times
- [ ] Adjust if needed

---

## Risk Analysis

### Option 1 (Recommended): Separate Test Suites
- **Implementation Risk:** ⬜ MINIMAL
- **Execution Risk:** ⬜ MINIMAL
- **Maintenance Risk:** ⬜ LOW

### Option 2: Remove Exclusion
- **Implementation Risk:** ⬜ MINIMAL
- **Execution Risk:** 🟥 HIGH (test failures without infrastructure)
- **Maintenance Risk:** 🟡 MEDIUM

### Option 3: Conditional Execution
- **Implementation Risk:** 🟡 MEDIUM
- **Execution Risk:** 🟡 MEDIUM
- **Maintenance Risk:** 🟡 MEDIUM

---

## Cost-Benefit Analysis

### Keeping Separate (Option 1)
```
Costs:
  - Requires two commands to run all tests
  - CI/CD needs separate step
  - Developer needs to remember to run

Benefits:
  - Fast feedback from unit tests
  - Integration tests don't block development
  - Clear separation of concerns
  - No environment coupling
  - Can skip if server unavailable
```

### Integrating (Option 2)
```
Costs:
  - Tests fail without infrastructure
  - Slower overall test execution
  - Coupling between test environments
  - May break CI/CD unexpectedly

Benefits:
  - Single test command
  - Complete coverage in one run
  - Everyone runs all tests
```

---

## Current State Assessment

| Aspect | Status | Notes |
|--------|--------|-------|
| Tests exist | ✅ Yes | 81 integration tests |
| Tests runnable | ✅ Yes | Via `npm run test:routes` |
| Documentation | ❌ No | No guidance for developers |
| CI/CD coverage | ❓ Unknown | Depends on CI setup |
| Developer awareness | ❌ Low | Not obvious from `npm test` |

---

## Recommended Next Steps

1. **Immediate (This Week):**
   - [ ] Document current test structure
   - [ ] Add guidance to README
   - [ ] Verify CI/CD runs both suites

2. **Short-term (Next Week):**
   - [ ] Add npm script for comprehensive testing
   - [ ] Update CONTRIBUTING.md
   - [ ] Communicate to team

3. **Long-term (Month 1):**
   - [ ] Monitor test execution patterns
   - [ ] Optimize infrastructure if needed
   - [ ] Adjust based on team feedback

---

## FAQ

**Q: Should I run this test before committing?**  
A: Only if you have the API server running locally. The CI/CD pipeline will run it.

**Q: Why is it excluded?**  
A: Because it requires a running API server, unlike unit tests that are self-contained.

**Q: Will CI/CD catch issues if I skip it locally?**  
A: Yes, if CI/CD runs the test. Check your CI/CD configuration.

**Q: Should this test be included in coverage reports?**  
A: Only if running against a live server. For development, run unit tests.

**Q: What if the integration test fails in CI?**  
A: Check server availability, endpoint definitions, or test expectations.

---

## Conclusion

**Recommended Action:** Keep the test excluded but document and ensure CI/CD runs it.

**Rationale:**
- Unit tests should be fast and always runnable locally
- Integration tests need infrastructure setup
- Both are valuable but serve different purposes
- Documentation and CI/CD configuration solve the coverage gap

**No code changes needed** — Documentation update only.

---

## Files to Update

1. **README.md** — Add test suites section
2. **CONTRIBUTING.md** — Add testing guidance
3. **.github/workflows/test.yml** (if exists) — Ensure integration tests run
4. **package.json** — Add `test:all` npm script

---

**Status:** ✅ Ready for implementation  
**Priority:** MEDIUM (good practice, not blocking)  
**Effort:** LOW (mostly documentation)

