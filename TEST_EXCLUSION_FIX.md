# Test Exclusion Fix: Implementation Guide

**Date:** July 28, 2026  
**Status:** Ready for Implementation

---

## Summary

The integration test file `tests/orphaned-routers-integration.test.ts` (81 tests) is excluded from the main test suite. This guide implements a proper solution through:

1. ✅ Documentation (explaining why)
2. ✅ npm scripts (making it easy to run)
3. ✅ CI/CD integration (ensuring coverage)

**No code changes needed** — just configuration and documentation.

---

## What to Do

### Step 1: Add npm Script for Comprehensive Testing

**File:** `package.json`

Find the "scripts" section and add:

```json
"test:all": "npm test && npm run test:routes",
```

**Before:**
```json
{
  "scripts": {
    "test": "DATABASE_URL=... vitest run tests/...",
    "test:routes": "vitest run tests/orphaned-routers-integration.test.ts",
    "test:full": "vitest run"
  }
}
```

**After:**
```json
{
  "scripts": {
    "test": "DATABASE_URL=... vitest run tests/...",
    "test:routes": "vitest run tests/orphaned-routers-integration.test.ts",
    "test:all": "npm test && npm run test:routes",
    "test:full": "vitest run"
  }
}
```

### Step 2: Update README.md

Add a "Test Suites" section:

```markdown
## Running Tests

### Unit Tests (Main Suite)
```bash
npm test                # Run unit tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
```

### Integration Tests (API Endpoints)
```bash
# Start API server first
docker-compose up

# Then in another terminal:
npm run test:routes    # Run endpoint integration tests
```

### All Tests
```bash
npm run test:all       # Run unit tests + integration tests (requires server)
npm run test:full      # Run ALL tests via vitest (slowest)
```

### Test Patterns

- **Local development:** `npm test` (fast feedback)
- **Before pushing PR:** `npm run test:all` (comprehensive)
- **Quick check:** `npm test` (unit tests only)
- **Full verification:** `npm run test:all` (everything)
```

### Step 3: Update CONTRIBUTING.md

Add a "Testing" section:

```markdown
## Testing

### Test Organization

We have two test suites:

**Unit Tests** (`npm test`)
- Location: `tests/` and `src/**/*.test.ts`
- Speed: Fast (~30 seconds)
- Dependencies: None (all mocked)
- Run in CI/CD: Always

**Integration Tests** (`npm run test:routes`)
- Location: `tests/orphaned-routers-integration.test.ts`
- Speed: Moderate (~1-2 minutes)
- Dependencies: Running API server
- Run in CI/CD: Yes (separate step)

### Before Committing

1. Run unit tests: `npm test`
2. Fix any failures
3. Run integration tests (optional, if server is running): `npm run test:routes`

### Before Pushing PR

```bash
npm run test:all       # Run both suites
```

If you don't have the API server running locally:
```bash
npm test               # Just run unit tests (CI will run integration)
```

### Troubleshooting

**Unit tests fail:**
Check that all dependencies are installed and mocked properly.

**Integration tests fail:**
Ensure the API server is running: `docker-compose up`

**Can't run integration tests locally:**
That's OK — CI/CD will run them automatically.
```

### Step 4: Verify GitHub Actions Workflow (if exists)

**File:** `.github/workflows/test.yml` (if it exists)

Check that it runs both:

```yaml
- name: Run unit tests
  run: npm test

- name: Run integration tests
  run: npm run test:routes
  # (may need different environment setup)
```

If the workflow doesn't exist, create one:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test

  # Optional: Add integration tests if infrastructure available
```

---

## Implementation Checklist

### Phase 1: Configuration (30 minutes)
- [ ] Add `test:all` npm script to package.json
- [ ] Verify `test:routes` script works locally
- [ ] Test: `npm test && npm run test:routes`

### Phase 2: Documentation (1 hour)
- [ ] Update README.md with test suites section
- [ ] Update CONTRIBUTING.md with testing guidance
- [ ] Verify documentation is clear
- [ ] Review with team

### Phase 3: CI/CD (30 minutes)
- [ ] Check/create `.github/workflows/test.yml`
- [ ] Ensure it runs `npm test`
- [ ] Ensure it runs `npm run test:routes` (or `npm run test:all`)
- [ ] Verify CI passes

### Phase 4: Communication (15 minutes)
- [ ] Notify team of changes
- [ ] Point to documentation
- [ ] Answer questions

**Total Time:** ~2 hours

---

## Verification Steps

### Local Verification

```bash
# 1. Run unit tests
npm test
# Expected: Tests pass ✓

# 2. Run integration tests (with server)
npm run test:routes
# Expected: Tests pass ✓ or server unavailable error

# 3. Run both with new script
npm run test:all
# Expected: Both suites run in sequence

# 4. Check npm scripts
npm run
# Expected: See test:all in list
```

### CI/CD Verification

1. Push a branch with changes
2. Check GitHub Actions (or your CI system)
3. Verify both test suites run
4. Check that failure in either suite fails the build

---

## Common Issues & Solutions

### Issue 1: API Server Not Running

```bash
$ npm run test:routes
Error: GET http://localhost:3000/api/v1/... failed: connect ECONNREFUSED
```

**Solution:**
```bash
# Start the server first
docker-compose up

# In another terminal
npm run test:routes
```

### Issue 2: Both Test Scripts Fail

```bash
$ npm run test:all
npm ERR! code ENOENT
npm ERR! path /workspaces/.../tests/orphaned-routers-integration.test.ts
```

**Solution:**
Check that file exists and script name is correct in package.json.

### Issue 3: Tests Hang

```bash
$ npm test
# ... hangs after 10 seconds
```

**Solution:**
- Check `testTimeout` in vitest.config.ts
- Check for unresolved promises
- Use `npm run test:watch` to debug

---

## Optional: Simplify for Developers

### Option A: Default to All Tests

Change main `test` script to run everything:

```json
"test": "npm run test:all",
"test:fast": "npm run test:unit"
```

Pros: Everyone runs all tests  
Cons: Slow for quick feedback

### Option B: Conditional Integration

Modify integration tests to skip if server unavailable:

```typescript
// tests/orphaned-routers-integration.test.ts
const serverUrl = process.env.TEST_API_URL ?? 'http://localhost:3000';
let serverAvailable = false;

// Check server before running
try {
  await fetch(serverUrl);
  serverAvailable = true;
} catch {
  serverAvailable = false;
}

describe.skipIf(!serverAvailable)('Integration: API Routes', () => {
  // tests...
});
```

Pros: Tests skip gracefully  
Cons: May hide missing infrastructure

### Option C: Docker Compose Test Service

Add to docker-compose.yml:

```yaml
services:
  test-runner:
    image: node:18
    working_dir: /app
    command: npm run test:all
    depends_on:
      - postgres
      - api
```

Pros: Reproducible test environment  
Cons: Added complexity

---

## Minimal Implementation

If you just want to get started quickly:

### Step 1: Update package.json
```json
"test:all": "npm test && npm run test:routes"
```

### Step 2: Update README

Add one sentence:
```
To run all tests (unit + integration): npm run test:all
```

**Done!** That's the minimum.

---

## Extended Implementation

For comprehensive coverage:

### All Steps Above Plus:

1. ✅ Add to CONTRIBUTING.md
2. ✅ Create GitHub Actions workflow
3. ✅ Add test badges to README
4. ✅ Create .github/TESTING.md
5. ✅ Set up Slack notifications for test failures

---

## Success Criteria

✅ Can run all tests: `npm run test:all`  
✅ Unit tests run: `npm test`  
✅ Integration tests run: `npm run test:routes`  
✅ Documentation explains both  
✅ CI/CD runs both suites  
✅ Team knows how to use them  

---

## Estimated Timeline

- **Minimal:** 30 minutes
- **Standard:** 1-2 hours
- **Comprehensive:** 2-3 hours

---

## Questions?

See: `TEST_EXCLUSION_ANALYSIS.md` for more details

---

**Status:** ✅ Ready to implement  
**Complexity:** LOW (configuration only)  
**Risk:** MINIMAL (no code changes)
