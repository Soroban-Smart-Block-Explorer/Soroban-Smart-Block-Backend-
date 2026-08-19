# Mock Testing Guide: Type-Safe Test Data

**Date:** July 28, 2026  
**Status:** ✅ Best Practices Guide

---

## Overview

This guide explains how to use typed mock factories instead of `as never` / `as any` casts.

### Problem With `as never` Casts

```typescript
// ❌ BAD: Completely bypasses TypeScript checking
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue([] as never);

// ❌ Problems:
// - No type checking on mock data
// - IDE can't provide autocomplete
// - Easy to add wrong properties
// - Compile-time errors go undetected
```

### Solution: Typed Mock Factories

```typescript
// ✅ GOOD: Full type safety
const event = createMevEventMock({ txHash: 'abc123' });
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue([event]);

// ✅ Benefits:
// - Full TypeScript type checking
// - IDE autocomplete works
// - Compiler catches wrong properties
// - Self-documenting code
```

---

## Getting Started

### Import the Factory

```typescript
import {
  createMevEventMock,
  createDexPoolMock,
  createStellarAccountMock,
  createArrayOf,
} from '../helpers/mock-factories';
```

### Location

File: `tests/helpers/mock-factories.ts`

---

## Available Factories

### MEV Classification

#### `createMevEventMock(overrides?)`

**Type:** `MevEventMock`

```typescript
// Minimal
const event = createMevEventMock();

// With overrides
const event = createMevEventMock({
  txHash: 'custom123',
  mevType: 'SANDWICH',
  confidence: 0.95,
  profitUsd: 2000,
});
```

**Default Values:**
- `mevType: 'SANDWICH'`
- `confidence: 0.85`
- `profitUsd: 1500.5`
- `timestamp: 2026-01-01`

#### `createMevVictimMock(overrides?)`

```typescript
const victim = createMevVictimMock({
  address: 'GAVICTIM456',
  totalLossUsd: 10000,
});
```

#### `createMevAttackerMock(overrides?)`

```typescript
const attacker = createMevAttackerMock({
  address: 'GAATTACKER789',
  totalProfitUsd: 100000,
});
```

#### `createMevAlertMock(overrides?)`

```typescript
const alert = createMevAlertMock({
  severity: 'CRITICAL',
  acknowledged: true,
});
```

### Arbitrage

#### `createDexPoolMock(overrides?)`

```typescript
const pool = createDexPoolMock({
  token0: 'USDC',
  token1: 'XLM',
  tvlUsd: 5000000,
  fee: 25,
});
```

#### `createPriceGraphNode(token, price?)`

```typescript
const node = createPriceGraphNode('USDC', 1.0);
```

#### `createPriceGraphEdge(from, to, rate?, poolId?)`

```typescript
const edge = createPriceGraphEdge('USDC', 'XLM', 0.95, 'pool-1');
```

### Stellar Integration

#### `createStellarAssetMock(overrides?)`

```typescript
const asset = createStellarAssetMock({
  code: 'USDC',
  balance: '5000.00',
});
```

#### `createStellarAccountMock(overrides?)`

```typescript
const account = createStellarAccountMock({
  accountId: 'GACUSTOM123',
  balances: [
    createStellarAssetMock({ code: 'XLM', balance: '1000' }),
  ],
});
```

#### `createStellarTransactionMock(overrides?)`

```typescript
const tx = createStellarTransactionMock({
  hash: 'txcustom123',
  ledger: 60000000,
});
```

### Helper Functions

#### `createArrayOf(factory, count, overrides?)`

Create multiple mocks efficiently:

```typescript
// Create 5 MEV events
const events = createArrayOf(createMevEventMock, 5, {
  confidence: 0.9,
});

// Create 10 DEX pools
const pools = createArrayOf(createDexPoolMock, 10, {
  tvlUsd: 1000000,
});
```

#### `createAggregateMock(data)`

For Prisma aggregate query mocks:

```typescript
// ❌ Old: as never cast
vi.mocked(prismaRead.mevEvent.aggregate).mockResolvedValue({
  _sum: { profitUsd: 5000 },
} as never);

// ✅ New: Typed
const result = createAggregateMock({ _sum: { profitUsd: 5000 } });
vi.mocked(prismaRead.mevEvent.aggregate).mockResolvedValue(result);
```

#### `createGroupedMock(data)`

For Prisma groupBy query mocks:

```typescript
// ✅ Typed
const grouped = createGroupedMock([
  { mevType: 'SANDWICH', _count: { _all: 10 } },
  { mevType: 'FRONTRUN', _count: { _all: 5 } },
]);
vi.mocked(prismaRead.mevEvent.groupBy).mockResolvedValue(grouped);
```

---

## Before & After Examples

### Example 1: MEV Event Mock

**Before (with `as never`):**
```typescript
const mockEvent = {
  id: 'mev-1',
  txHash: 'tx123',
  mevType: 'SANDWICH',
  confidence: 0.85,
} as never; // ❌ No type checking

vi.mocked(prismaRead.mevEvent.findUnique).mockResolvedValue(mockEvent);
```

**After (with factory):**
```typescript
const mockEvent = createMevEventMock({
  txHash: 'tx123',
}); // ✅ Full type checking

vi.mocked(prismaRead.mevEvent.findUnique).mockResolvedValue(mockEvent);
```

### Example 2: Array of Mocks

**Before (with `as never`):**
```typescript
const mockPools = [
  { id: 'pool-1', token0: 'USDC', token1: 'XLM', tvlUsd: 1000000 },
  { id: 'pool-2', token0: 'USDC', token1: 'BTC', tvlUsd: 500000 },
] as never; // ❌ Error-prone

vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(mockPools);
```

**After (with factory):**
```typescript
const mockPools = createArrayOf(createDexPoolMock, 2, { tvlUsd: 1000000 });
// ✅ Type-safe, with automatic IDs

vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(mockPools);
```

### Example 3: Aggregate Query

**Before (with `as never`):**
```typescript
vi.mocked(prismaRead.mevEvent.aggregate).mockResolvedValueOnce({
  _sum: { profitUsd: 100.5 },
} as never); // ❌ No checking
```

**After (with factory):**
```typescript
const agg = createAggregateMock({ _sum: { profitUsd: 100.5 } });
vi.mocked(prismaRead.mevEvent.aggregate).mockResolvedValueOnce(agg);
// ✅ Compiler verifies structure
```

---

## Migration Guide

### Step 1: Identify `as never` Casts

```bash
# Find all "as never" casts in tests
grep -r "as never" tests/
```

### Step 2: Replace with Factories

For each occurrence:

1. **Find the type being cast**
   ```typescript
   // ❌ Before
   const data = { field: 'value' } as never;
   ```

2. **Choose matching factory**
   ```typescript
   // ✅ After
   const data = createXxxMock({ field: 'value' });
   ```

3. **Test compilation**
   ```bash
   npm run build
   ```

### Step 3: Add Overrides

Customize mocks with overrides:

```typescript
// Use factory defaults
const basic = createMevEventMock();

// Override specific fields
const custom = createMevEventMock({
  confidence: 0.99,
  profitUsd: 5000,
  mevType: 'FRONTRUN',
});
```

---

## Best Practices

### ✅ Do

1. **Use factories for all mock data**
   ```typescript
   const event = createMevEventMock();
   ```

2. **Override only what you need**
   ```typescript
   const specific = createMevEventMock({ txHash: 'custom' });
   ```

3. **Create arrays with helper**
   ```typescript
   const events = createArrayOf(createMevEventMock, 5);
   ```

4. **Document custom overrides**
   ```typescript
   // Testing high-confidence MEV
   const highConfidence = createMevEventMock({
     confidence: 0.99,
     mevType: 'SANDWICH',
   });
   ```

### ❌ Don't

1. **Don't use `as never` or `as any`**
   ```typescript
   // ❌ BAD
   const data = {} as never;
   ```

2. **Don't create inline objects without factories**
   ```typescript
   // ❌ AVOID
   const mock = { id: '1', name: 'test' }; // No type checking
   ```

3. **Don't override unrelated fields**
   ```typescript
   // ❌ AVOID - confusing
   createMevEventMock({ id: 'unrelated123' });
   ```

4. **Don't duplicate factory logic**
   ```typescript
   // ❌ AVOID - use factory
   const event1 = { ...defaultEvent, custom: true };
   const event2 = { ...defaultEvent, custom: true };
   ```

---

## Type Safety Examples

### Example: IDE Autocomplete

```typescript
const event = createMevEventMock({
  // IDE provides autocomplete:
  // - txHash
  // - mevType
  // - confidence
  // - profitUsd
  // - timestamp
  // - etc.
});
```

### Example: Compile-Time Error Detection

```typescript
// ❌ This won't compile (good!)
const event = createMevEventMock({
  wrongField: 'value', // ❌ Property 'wrongField' does not exist
});

// ✅ This compiles (correct)
const event = createMevEventMock({
  txHash: 'tx123', // ✅ Property exists
});
```

### Example: Type Inference

```typescript
// IDE knows event is MevEventMock
const event = createMevEventMock();

// Type checking works on all properties
const hash: string = event.txHash; // ✅ Correct
const hash2: number = event.txHash; // ❌ Type error
```

---

## Adding New Mock Types

### Step 1: Define Interface

```typescript
export interface CustomMock {
  id: string;
  name: string;
  value: number;
  createdAt: Date;
}
```

### Step 2: Create Factory

```typescript
export function createCustomMock(overrides: Partial<CustomMock> = {}): CustomMock {
  return {
    id: 'custom-1',
    name: 'default-name',
    value: 100,
    createdAt: new Date(),
    ...overrides,
  };
}
```

### Step 3: Export and Use

```typescript
// In test file
import { createCustomMock } from '../helpers/mock-factories';

const mock = createCustomMock({ value: 200 });
```

---

## Troubleshooting

### Q: Type error on override properties

```typescript
// ❌ Error: Property 'foo' does not exist
const mock = createMevEventMock({ foo: 'bar' });
```

**A:** Only use valid properties. Check the interface:

```typescript
// ✅ Correct
const mock = createMevEventMock({ txHash: 'tx123' });
```

### Q: Need a mock with completely different values

```typescript
// Create new factory instead of overriding everything:
export function createMevEventMockLowConfidence(): MevEventMock {
  return createMevEventMock({ confidence: 0.3 });
}
```

### Q: Prisma query mock not working

```typescript
// ✅ Correct pattern
const events = [createMevEventMock(), createMevEventMock()];
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(events);

// ❌ Wrong pattern
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(
  createMevEventMock(), // Single object, not array
);
```

---

## Resources

- **File:** `tests/helpers/mock-factories.ts`
- **Pattern:** Factory Functions with Partial Overrides
- **TypeScript:** Strict Mode recommended
- **Testing Framework:** Vitest with `vi.mocked()`

---

## Summary

| Aspect | `as never` | Mock Factories |
|--------|-----------|----------------|
| Type Safety | ❌ None | ✅ Full |
| IDE Support | ❌ No | ✅ Yes |
| Autocomplete | ❌ No | ✅ Yes |
| Compiler Checks | ❌ Bypassed | ✅ Active |
| Maintainability | ❌ Hard | ✅ Easy |
| Reusability | ❌ Inline | ✅ Centralized |

**Best Practice:** Always use typed mock factories. Never use `as never` or `as any` for mock data.

---

**Created:** July 28, 2026  
**Status:** ✅ Best Practices Guide Complete
