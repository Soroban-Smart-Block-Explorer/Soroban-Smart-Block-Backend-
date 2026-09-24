# Mock Refactoring Guide: Eliminating `as never` Casts

**Date:** July 28, 2026  
**Status:** ✅ Refactoring Plan

---

## Overview

This guide provides step-by-step instructions for refactoring tests to eliminate `as never` and `as any` casts.

---

## Files Requiring Refactoring

### High Priority (Most Casts)

| File | Casts | Status |
|------|-------|--------|
| `tests/mev.test.ts` | 8 | 🔴 HIGH |
| `tests/arbitrage-engine.test.ts` | 4 | 🔴 HIGH |
| `tests/stellar-api-integration.test.ts` | 3 | 🟠 MEDIUM |

### Action Items

- [ ] Refactor `tests/mev.test.ts`
- [ ] Refactor `tests/arbitrage-engine.test.ts`
- [ ] Refactor `tests/stellar-api-integration.test.ts`
- [ ] Scan for other `as never` / `as any` occurrences
- [ ] Add linter rule to prevent future casts

---

## Refactoring Pattern

### Step 1: Import Factories

Add to top of test file:

```typescript
import {
  createMevEventMock,
  createMevVictimMock,
  createMevAttackerMock,
  createMevAlertMock,
  createArrayOf,
  createAggregateMock,
} from '../helpers/mock-factories';
```

### Step 2: Find & Replace Pattern

**Pattern to find:**
```typescript
// ❌ As never cast
} as never)
} as any)
```

**Replace with:**
```typescript
// ✅ Mock factory call
createXxxMock(/* overrides */))
```

### Step 3: Verify Types

Run TypeScript compiler:
```bash
npx tsc --noEmit
```

Should have 0 errors.

---

## Detailed Refactoring Examples

### Example 1: `tests/mev.test.ts` Line 84-86

**Before:**
```typescript
vi.mocked(prismaWrite.mevVictim.upsert).mockResolvedValue({} as never);
vi.mocked(prismaWrite.mevAttacker.upsert).mockResolvedValue({} as never);
vi.mocked(prismaWrite.mevEvent.upsert).mockResolvedValue(mockEvent as never);
```

**After:**
```typescript
const victim = createMevVictimMock();
const attacker = createMevAttackerMock();
const event = createMevEventMock(/* keep existing mockEvent overrides */);

vi.mocked(prismaWrite.mevVictim.upsert).mockResolvedValue(victim);
vi.mocked(prismaWrite.mevAttacker.upsert).mockResolvedValue(attacker);
vi.mocked(prismaWrite.mevEvent.upsert).mockResolvedValue(event);
```

### Example 2: `tests/mev.test.ts` Line 155

**Before:**
```typescript
const mockEvents = [/* ... */] as never;
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(mockEvents);
```

**After:**
```typescript
const mockEvents = createArrayOf(createMevEventMock, 3, {
  // Override specific fields if needed
});
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(mockEvents);
```

### Example 3: `tests/mev.test.ts` Line 204-205

**Before:**
```typescript
.mockResolvedValueOnce({ _sum: { profitUsd: 100.5 } } as never)
.mockResolvedValueOnce({ _sum: { lossUsd: 50.25 } } as never);
```

**After:**
```typescript
.mockResolvedValueOnce(createAggregateMock({ _sum: { profitUsd: 100.5 } }))
.mockResolvedValueOnce(createAggregateMock({ _sum: { lossUsd: 50.25 } }));
```

### Example 4: `tests/arbitrage-engine.test.ts` Line 313

**Before:**
```typescript
vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(mockPools as never);
```

**After:**
```typescript
const mockPools = createArrayOf(createDexPoolMock, /* count */);
vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(mockPools);
```

### Example 5: `tests/stellar-api-integration.test.ts` Line 106

**Before:**
```typescript
} as any);
```

**After:**
```typescript
const account = createStellarAccountMock({
  // Override with custom values
});
// Return typed object without cast
```

---

## Refactoring Checklist

### For Each Test File

- [ ] Import mock factories
- [ ] Find all `as never` occurrences
  ```bash
  grep -n "as never" tests/xxxxx.test.ts
  ```
- [ ] Find all `as any` occurrences
  ```bash
  grep -n "as any" tests/xxxxx.test.ts
  ```
- [ ] Replace each cast with appropriate factory
- [ ] Verify no type errors
  ```bash
  npx tsc --noEmit
  ```
- [ ] Run tests to verify functionality
  ```bash
  npm run test -- tests/xxxxx.test.ts
  ```
- [ ] Mark as complete

---

## Preventing Future Casts

### Option 1: ESLint Rule

Add to `.eslintrc.json`:

```json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/as-const": "error"
  }
}
```

This will catch future `as never` / `as any` attempts.

### Option 2: Pre-commit Hook

Add to `.husky/pre-commit`:

```bash
# Check for unsafe type assertions
echo "🔍 Checking for unsafe type assertions..."
if grep -r "as never\|as any" tests/ --include="*.test.ts"; then
  echo "❌ Found unsafe type assertions in tests"
  echo "   Use typed mock factories instead (see docs/MOCK_TESTING_GUIDE.md)"
  exit 1
fi
```

### Option 3: CI Check

Add to GitHub Actions / CI pipeline:

```yaml
- name: Check for unsafe casts
  run: |
    if grep -r "as never\|as any" tests/ --include="*.test.ts"; then
      echo "Unsafe type assertions detected"
      exit 1
    fi
```

---

## Expected Improvements

After refactoring, you'll see:

### Type Safety
- ✅ TypeScript compiler catches incorrect mock properties
- ✅ IDE autocomplete works for mock factories
- ✅ Compile-time errors for wrong types

### Code Quality
- ✅ Self-documenting mock structure
- ✅ Reusable mock definitions
- ✅ Easier to maintain and extend

### Developer Experience
- ✅ Faster test writing (autocomplete)
- ✅ Fewer runtime surprises
- ✅ Clear factory contracts

### Test Reliability
- ✅ Mocks match actual data types
- ✅ Fewer edge case bugs
- ✅ Consistent mock behavior

---

## Implementation Timeline

### Week 1: Setup
- [ ] Create mock factories (DONE ✅)
- [ ] Create testing guide (DONE ✅)
- [ ] Team review of approach

### Week 2: Refactor High Priority
- [ ] `tests/mev.test.ts`
- [ ] `tests/arbitrage-engine.test.ts`
- [ ] `tests/stellar-api-integration.test.ts`

### Week 3: Full Scan & Cleanup
- [ ] Scan all test files for remaining casts
- [ ] Refactor additional files
- [ ] Add ESLint rules

### Week 4: Enforcement
- [ ] Add pre-commit hook
- [ ] Add CI check
- [ ] Team training

---

## Rollout Strategy

### Phase 1: Optional (Week 2-3)
- New tests use mock factories
- Old tests can continue with casts
- Gradual migration

### Phase 2: Recommended (Week 3-4)
- Refactor existing tests
- Add ESLint warnings
- Update CONTRIBUTING.md

### Phase 3: Enforced (Week 4+)
- CI/CD blocks new `as never` / `as any`
- All existing tests refactored
- Pre-commit hook active

---

## Template: Refactored Test

Here's a complete before/after example:

### Before (with `as never`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyAndStore } from '../src/indexer/mev-classifier';

describe('MEV Classifier', () => {
  beforeEach(() => {
    vi.mocked(prismaWrite.mevEvent.upsert).mockResolvedValue({} as never);
  });

  it('should classify sandwich attack', async () => {
    const mockEvent = {
      txHash: 'tx123',
      mevType: 'SANDWICH',
      confidence: 0.95,
    } as never;

    await classifyAndStore(mockEvent);
    expect(prismaWrite.mevEvent.upsert).toHaveBeenCalled();
  });
});
```

### After (with typed factories)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyAndStore } from '../src/indexer/mev-classifier';
import { createMevEventMock } from './helpers/mock-factories';

describe('MEV Classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should classify sandwich attack', async () => {
    const mockEvent = createMevEventMock({
      txHash: 'tx123',
      mevType: 'SANDWICH',
      confidence: 0.95,
    });

    await classifyAndStore(mockEvent);
    expect(prismaWrite.mevEvent.upsert).toHaveBeenCalled();
  });
});
```

---

## Quick Reference

### Find Cast Patterns

```bash
# Find all unsafe casts in tests
grep -r "as never\|as any" tests/ --include="*.test.ts" | wc -l

# Show specific lines
grep -rn "as never\|as any" tests/ --include="*.test.ts"
```

### Refactor Command

```bash
# After refactoring, verify
npx tsc --noEmit && npm run test
```

### Check Progress

```bash
# Count remaining casts (should decrease over time)
grep -r "as never\|as any" tests/ --include="*.test.ts" | wc -l
```

---

## Common Mistakes

### ❌ Don't

```typescript
// Wrong: Still using cast
const event = createMevEventMock() as never;

// Wrong: Partial type
const partial = { txHash: 'tx123' } as never;

// Wrong: Wrong factory
const event = createDexPoolMock({ txHash: 'tx123' });
```

### ✅ Do

```typescript
// Correct: Use factory directly
const event = createMevEventMock();

// Correct: With overrides only
const custom = createMevEventMock({ txHash: 'tx123' });

// Correct: Right factory for type
const pool = createDexPoolMock({ token0: 'USDC' });
```

---

## Support

### Questions?
- See: `docs/MOCK_TESTING_GUIDE.md`
- Examples: `tests/helpers/mock-factories.ts`

### Need new factory?
1. Define interface
2. Create factory function
3. Export from mock-factories.ts
4. Add to guide

---

## Metrics

Track your progress:

```bash
# Baseline (count before refactoring)
grep -r "as never\|as any" tests/ --include="*.test.ts" | wc -l
# Example: 15 occurrences

# After each phase
# Week 2: 12 → 10 → 8
# Week 3: 8 → 5 → 2
# Week 4: 2 → 0 ✅ Complete!
```

---

**Status:** Ready to begin refactoring  
**Priority:** High (improves test reliability)  
**Effort:** Medium (automated tooling can help)  
**ROI:** High (prevents bugs, improves DX)
