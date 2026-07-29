# Mock Factories Quick Reference

**File Location:** `tests/helpers/mock-factories.ts`  
**Documentation:** `docs/MOCK_TESTING_GUIDE.md`

---

## Quick Usage

### Import

```typescript
import {
  createMevEventMock,
  createDexPoolMock,
  createStellarAccountMock,
  createArrayOf,
} from '../helpers/mock-factories';
```

### Create a Mock

```typescript
// Default values
const event = createMevEventMock();

// With customization
const custom = createMevEventMock({
  txHash: 'abc123',
  confidence: 0.99,
});
```

### Create Multiple

```typescript
const events = createArrayOf(createMevEventMock, 5);
```

---

## Available Factories

### MEV Mocks

```typescript
createMevEventMock(overrides?)          // MevEventMock
createMevVictimMock(overrides?)         // MevVictimMock
createMevAttackerMock(overrides?)       // MevAttackerMock
createMevAlertMock(overrides?)          // MevAlertMock
```

### Arbitrage Mocks

```typescript
createDexPoolMock(overrides?)           // DexPoolMock
createPriceGraphNode(token, price?)     // PriceGraphNode
createPriceGraphEdge(from, to, rate?)   // PriceGraphEdge
```

### Stellar Mocks

```typescript
createStellarAssetMock(overrides?)      // StellarAssetMock
createStellarAccountMock(overrides?)    // StellarAccountMock
createStellarTransactionMock(overrides?) // StellarTransactionMock
```

### Helpers

```typescript
createArrayOf(factory, count, overrides?)   // T[]
createAggregateMock(data)                   // T
createGroupedMock(data)                     // T[]
```

---

## Common Patterns

### Pattern 1: Single Mock

```typescript
const event = createMevEventMock();
vi.mocked(prismaRead.mevEvent.findUnique).mockResolvedValue(event);
```

### Pattern 2: Array of Mocks

```typescript
const events = createArrayOf(createMevEventMock, 3);
vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(events);
```

### Pattern 3: With Overrides

```typescript
const specific = createMevEventMock({
  mevType: 'SANDWICH',
  confidence: 0.95,
});
```

### Pattern 4: Aggregate Query

```typescript
const agg = createAggregateMock({ _sum: { profitUsd: 1000 } });
vi.mocked(prismaRead.mevEvent.aggregate).mockResolvedValue(agg);
```

### Pattern 5: GroupBy Query

```typescript
const grouped = createGroupedMock([
  { mevType: 'SANDWICH', _count: { _all: 10 } },
]);
vi.mocked(prismaRead.mevEvent.groupBy).mockResolvedValue(grouped);
```

---

## Type Safety Example

```typescript
// ✅ IDE knows about these properties
const event = createMevEventMock({
  txHash: '...',           // ✅ Valid
  confidence: 0.9,         // ✅ Valid
  wrongField: '...',       // ❌ Compiler error!
});
```

---

## Replacing `as never`

### Before ❌

```typescript
vi.mocked(api).mockResolvedValue(data as never);
```

### After ✅

```typescript
const mockData = createXxxMock(/* overrides */);
vi.mocked(api).mockResolvedValue(mockData);
```

---

## Factory Properties

### MevEventMock
- `txHash`, `ledgerSeq`, `mevType`, `confidence`
- `victimAddress`, `attackerAddress`, `profitUsd`
- `timestamp`, `details`

### DexPoolMock
- `contractAddress`, `token0`, `token1`
- `reserve0`, `reserve1`, `fee`
- `tvlUsd`, `volumeUsd24h`

### StellarAccountMock
- `accountId`, `sequenceNumber`
- `balances` (array of StellarAssetMock)
- `signers`, `flags`

---

## Tips

✅ **Do:**
- Use factories for all mock data
- Override only what you need
- Create arrays with `createArrayOf()`

❌ **Don't:**
- Use `as never` or `as any`
- Mix factory with manual objects
- Forget to override when needed

---

**More Examples:** `docs/MOCK_TESTING_GUIDE.md`  
**Refactoring Guide:** `MOCK_REFACTORING_GUIDE.md`
