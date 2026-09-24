# Dependency Injection Migration Guide

## Current State
The codebase currently has direct singleton imports:
```typescript
import { prismaWrite, prismaRead } from '../db';
import { cacheConnect, cacheClose, isCacheReady } from '../cache';
```

## Target State
Use dependency injection via the service container:
```typescript
import { container } from '../services/container';

// Access services
const prismaWrite = container.getPrismaWrite();
const prismaRead = container.getPrismaRead();
const cache = container.getCache();
```

## Migration Strategy

### Phase 1: Low-Risk Files (API Routes)
Start with API route handlers that are relatively standalone. These are good candidates because:
- They have clear boundaries
- They already have route handler patterns
- They're easier to test with mocks

### Phase 2: Services and Indexers
Update service classes and indexer modules that already show some DI usage patterns.

### Phase 3: Complex Refactoring
Update complex modules with many dependencies that may require class-based refactoring.

## Migration Steps for Each File

### Step 1: Replace Import Statements
Replace:
```typescript
import { prismaWrite, prismaRead } from '../db';
import { cacheConnect, cacheClose, isCacheReady } from '../cache';
```

With:
```typescript
import { container } from '../services/container';
```

### Step 2: Use Container Services
Replace direct usage with container methods:
```typescript
// Old
const data = await prismaRead.user.findMany();
await prismaWrite.user.create({ data });
await cacheConnect();

// New
const prismaRead = container.getPrismaRead();
const prismaWrite = container.getPrismaWrite();
const cache = container.getCache();
const data = await prismaRead.user.findMany();
await prismaWrite.user.create({ data });
// cache.connect() if needed (cache is already connected by container)
```

### Step 3: Handle Cache Functions
For cache operations:
- `cacheConnect()` → Already handled by container initialization
- `cacheClose()` → Use `await container.shutdown()` if needed
- `isCacheReady()` → `container.getCache().has()` or check via cache methods

### Step 4: Class-Based Refactoring (Optional)
For better testability, consider converting to class-based services:
```typescript
class MyService {
  constructor(
    private prismaWrite: PrismaClient,
    private prismaRead: PrismaClient,
    private cache: CacheBackend,
    private logger: Logger
  ) {}
  
  async doSomething() {
    // Use injected dependencies
  }
}

// Create instance with container
const service = new MyService(
  container.getPrismaWrite(),
  container.getPrismaRead(),
  container.getCache(),
  container.getLogger()
);
```

## Testing Strategy
Use the existing test helpers:
```typescript
import { createTestContainer } from '../services/test-helpers';

describe('MyService', () => {
  let testContainer;
  
  beforeEach(() => {
    testContainer = createTestContainer({ useMockDb: true, useMemoryCache: true });
  });
  
  afterEach(async () => {
    await testContainer.cleanup();
  });
  
  it('should work with mocks', async () => {
    const service = new MyService(
      testContainer.container.getPrismaWrite(),
      testContainer.container.getPrismaRead(),
      testContainer.container.getCache(),
      testContainer.container.getLogger()
    );
    // test service
  });
});
```

## Common Patterns

### Route Handler Example
```typescript
// Before
import { prismaRead, prismaWrite } from '../db';
import { cacheConnect } from '../cache';

export async function handler(req, res) {
  await cacheConnect();
  const data = await prismaRead.user.findMany();
  res.json(data);
}

// After
import { container } from '../services/container';

export async function handler(req, res) {
  const prismaRead = container.getPrismaRead();
  const cache = container.getCache();
  const data = await prismaRead.user.findMany();
  res.json(data);
}
```

### Class-Based Service Example
```typescript
// Before
import { prismaRead, prismaWrite } from '../db';

export async function processTransaction(txHash: string) {
  const tx = await prismaRead.transaction.findUnique({ where: { hash: txHash } });
  // process...
}

// After
import { container } from '../services/container';
import type { PrismaClient, Logger } from '../services/container';

export class TransactionProcessor {
  constructor(
    private prismaRead: PrismaClient,
    private prismaWrite: PrismaClient,
    private logger: Logger
  ) {}
  
  async process(txHash: string) {
    const tx = await this.prismaRead.transaction.findUnique({ where: { hash: txHash } });
    // process...
  }
}

// Usage
const processor = new TransactionProcessor(
  container.getPrismaRead(),
  container.getPrismaWrite(),
  container.getLogger()
);
```

## Backward Compatibility
During migration, we can maintain backward compatibility by:
1. Updating files incrementally
2. Running tests after each file
3. Using the existing singleton exports alongside DI for gradual transition

## Verification Checklist
- [ ] All imports updated
- [ ] Cache functions handled properly
- [ ] Tests pass with DI
- [ ] No breaking changes to API
- [ ] Performance impact minimal
- [ ] Memory usage patterns unchanged