# Zod Validation Middleware - Quick Reference

## Common Schemas (Ready to Use)

```typescript
import {
  // Pagination
  paginationSchema,                // { page: number, limit: number }
  cursorPaginationSchema,          // cursor-based with page/limit
  
  // Filtering & Sorting
  filterSchema,                    // { search?, status?, type?, tags? }
  sortSchema,                      // { sortBy?, sortOrder? }
  listQuerySchema,                 // pagination + filters + sorting
  
  // Domain-specific
  contractFilterSchema,            // { contract?, account?, token? }
  addressFilterSchema,             // { address? | addresses? }
  txStatusFilterSchema,            // { status?, minFeeCharged?, maxFeeCharged? }
  
  // Types
  stellarAddress,                  // G/C address (56 chars, base32)
  txHash,                          // 64 hex chars
  safeLabel,                       // max 256 chars, sanitized
  safeDescription,                 // max 4096 chars, sanitized
  
  // Financial
  amountSchema,                    // non-negative number
  usdValueSchema,                  // USD value with validation
} from '../schemas/common';
```

## Middleware (In Routes)

```typescript
import {
  validateQuery,
  validateBody,
  validateParams,
  validateQueryAndBody,
} from '../middleware/validation';

// GET with query validation
router.get(
  '/items',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const query = (req as any).validatedQuery;
    // query.page, query.limit, query.search, etc.
  })
);

// POST with body validation
router.post(
  '/items',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const body = (req as any).validatedBody;
  })
);

// GET with path params
router.get(
  '/items/:id',
  validateParams(z.object({ id: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const params = (req as any).validatedParams;
  })
);

// POST with both query and body
router.post(
  '/batch',
  validateQueryAndBody(querySchema, bodySchema),
  asyncHandler(async (req, res) => {
    const query = (req as any).validatedQuery;
    const body = (req as any).validatedBody;
  })
);
```

## Creating Custom Schemas

```typescript
import { z } from 'zod';
import { safeLabel, stellarAddress } from '../schemas/common';

// Simple composition
const myListSchema = paginationSchema.merge(
  z.object({
    search: safeLabel.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
);

// For POST bodies
const myCreateSchema = z.object({
  name: safeLabel,
  description: z.string().optional(),
  owner: stellarAddress,
  tags: z.array(safeLabel).optional(),
});

// For path params
const myParamSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().min(1),
});
```

## Type Inference

```typescript
import { z } from 'zod';

const schema = listQuerySchema;
type Query = z.infer<typeof schema>;
// Query = { page: number; limit: number; search?: string; ... }

// In handlers
const query: Query = (req as any).validatedQuery;
```

## Error Response Format

```json
{
  "error": "Invalid query parameters",
  "details": {
    "limit": ["Number must be less than or equal to 100"],
    "page": ["Number must be greater than or equal to 1"]
  }
}
```

## Manual Validation (Non-Middleware)

```typescript
import { safeParse, strictParse } from '../middleware/validation';

// With error handling
const result = safeParse(schema, data);
if (result.ok) {
  const validated = result.data;
} else {
  console.log(result.errors); // { field: ["error message"] }
}

// Strict (throws)
try {
  const validated = strictParse(schema, data);
} catch (error) {
  // Handle validation error
}
```

## Common Patterns

### Pattern 1: List with Filters
```typescript
router.get(
  '/',
  validateQuery(
    paginationSchema.merge(
      z.object({
        contract: stellarAddress.optional(),
        status: z.enum(['pending', 'success', 'failed']).optional(),
      })
    )
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, contract, status } = (req as any).validatedQuery;
    // Build WHERE clause
  })
);
```

### Pattern 2: Create with Validation
```typescript
router.post(
  '/',
  validateBody(
    z.object({
      name: safeLabel,
      description: safeDescription.optional(),
      owner: stellarAddress,
    })
  ),
  asyncHandler(async (req, res) => {
    const { name, description, owner } = (req as any).validatedBody;
    // Create item
  })
);
```

### Pattern 3: Detail Endpoint
```typescript
router.get(
  '/:id',
  validateParams(z.object({ id: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const { id } = (req as any).validatedParams;
    // Fetch and return
  })
);
```

## What's Automatic

✅ Type coercion (`'20'` → `20` for numbers)
✅ HTML stripping from strings
✅ SQL injection pattern blocking
✅ Prototype pollution prevention
✅ Max length enforcement
✅ Format validation (UUID, hex, base32, emails, URLs)
✅ Enum validation
✅ 400 error responses on failure

## Testing

```typescript
const middleware = validateQuery(paginationSchema);
const req = mockReq({ query: { page: '1', limit: '20' } });
const res = mockRes();
const next = mockNext();

middleware(req, res, next);

expect(next).toHaveBeenCalled();
expect((req as any).validatedQuery).toEqual({ page: 1, limit: 20 });
```

## Documentation

- **Guide:** `VALIDATION_MIDDLEWARE_GUIDE.md`
- **Examples:** `src/api/examples/validation-samples.ts` (10 patterns)
- **Tests:** `tests/zod-validation-middleware.test.ts`
- **Schemas:** `src/schemas/common.ts`
- **Middleware:** `src/middleware/validation.ts`
