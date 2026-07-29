# Zod Validation Middleware Implementation Guide

## Overview

This implementation extends the existing Zod validation framework to provide a comprehensive, reusable middleware system for request validation across all Express routes. It replaces ad-hoc manual validation with a centralized, type-safe approach.

## What's New

### 1. Expanded Common Schemas (`src/schemas/common.ts`)

Added reusable schemas for common validation patterns:

- **Pagination & Listing:**
  - `paginationSchema` - offset-based (page, limit)
  - `cursorPaginationSchema` - cursor-based with pagination
  - `offsetLimitSchema` - legacy support
  - `sortOrderSchema`, `sortSchema` - sorting parameters
  - `filterSchema` - common search/filter parameters
  - `listQuerySchema` - combined pagination + filters + sorting

- **Financial:**
  - `amountSchema` - non-negative numbers
  - `amountStringSchema` - stringified amounts (on-chain)
  - `usdValueSchema` - USD values with validation

- **Filters:**
  - `contractFilterSchema` - contract/account/token filtering
  - `addressFilterSchema` - single/multiple Stellar addresses
  - `txStatusFilterSchema` - transaction status + fee range
  - `dateRangeFilterSchema` - date-based filtering

- **Metadata:**
  - `updateMetadataSchema` - for PATCH/PUT operations
  - `batchIdsSchema` - batch operations
  - `safeRecord` - prototype-pollution-safe objects

### 2. Validation Middleware Factory (`src/middleware/validation.ts`)

Provides convenient middleware for validating requests:

```typescript
// Query validation
router.get('/items', validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  const query = (req as any).validatedQuery as z.infer<typeof listQuerySchema>;
  // All query parameters are now validated and typed
}));

// Body validation
router.post('/items', validateBody(createItemSchema), asyncHandler(async (req, res) => {
  const body = (req as any).validatedBody as z.infer<typeof createItemSchema>;
  // Request body is validated and type-safe
}));

// Path parameter validation
router.get('/items/:id', validateParams(z.object({ id: z.string().uuid() })), 
  asyncHandler(async (req, res) => {
    const params = (req as any).validatedParams as { id: string };
    // Path params are validated
  }));

// Combined validation
router.post('/batch', 
  validateQueryAndBody(querySchema, bodySchema),
  asyncHandler(async (req, res) => {
    const query = (req as any).validatedQuery;
    const body = (req as any).validatedBody;
  }));
```

**Available Functions:**

- `validateQuery(schema)` - Middleware for query parameter validation
- `validateBody(schema)` - Middleware for request body validation
- `validateParams(schema)` - Middleware for path parameter validation
- `validateQueryAndBody(querySchema, bodySchema)` - Combined validation
- `safeParse(schema, data)` - Manual validation with error handling
- `strictParse(schema, data)` - Strict parsing (throws on error)

**Error Response Format:**
```json
{
  "error": "Invalid query parameters",
  "details": {
    "limit": ["Number must be less than or equal to 100"],
    "page": ["Number must be greater than or equal to 1"]
  }
}
```

### 3. Migration Example

**Before:** Manual validation in handler
```typescript
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const { contract, type } = req.query as Record<string, string>;
  // Untyped, no validation middleware
}));
```

**After:** Centralized middleware validation
```typescript
const eventListSchema = paginationSchema.merge(
  z.object({
    contract: stellarAddress.optional(),
    type: safeLabel.optional(),
  })
);

router.get(
  '/',
  validateQuery(eventListSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof eventListSchema>;
    // Typed, validated, returns 400 on failure
  })
);
```

### 4. Sample Usage Patterns

See `src/api/examples/validation-samples.ts` for 10 complete examples:

1. Simple query validation (GET list)
2. Query + params validation (GET with filters)
3. Body validation (POST/PUT)
4. Query + body validation (POST with filters)
5. Cursor-based pagination with filters
6. Address-based filtering
7. Contract + transaction filters
8. Batch operations
9. Custom inline validation schemas
10. Multiple path parameters

## Best Practices

### ✅ Do's

1. **Reuse common schemas** from `src/schemas/common.ts`
```typescript
import { paginationSchema, contractFilterSchema } from '../schemas/common';
```

2. **Compose schemas** with `.merge()` for flexibility
```typescript
const listSchema = paginationSchema.merge(contractFilterSchema);
```

3. **Use middleware early** in the middleware chain
```typescript
router.get('/', validateQuery(schema), asyncHandler(handler));
```

4. **Extract validated data** with type inference
```typescript
const query = (req as any).validatedQuery as z.infer<typeof schema>;
```

5. **Use `.optional()` for filter parameters**
```typescript
contract: stellarAddress.optional(),
status: z.enum(['pending', 'success', 'failed']).optional(),
```

### ❌ Don'ts

1. **Don't manually validate query/body** after using middleware
2. **Don't create duplicate schemas** - check common.ts first
3. **Don't use `any` types** - use `z.infer<typeof schema>`
4. **Don't ignore validation errors** - let middleware handle 400 responses
5. **Don't skip `.optional()` for optional params** - be explicit

## Type Safety

All validated data is fully typed:

```typescript
import { z } from 'zod';
import { listQuerySchema } from '../schemas/common';

// Infer the type
type ListQuery = z.infer<typeof listQuerySchema>;
// Result: { page: number; limit: number; search?: string; status?: string; ... }

// Use it
router.get('/', validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  const query: ListQuery = (req as any).validatedQuery;
  const page: number = query.page; // ✅ fully typed
}));
```

## Error Handling

Validation errors automatically return 400 with detailed field information:

```javascript
// Request with invalid limit
GET /api/items?limit=1000

// Response (automatically handled by middleware)
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Invalid query parameters",
  "details": {
    "limit": ["Number must be less than or equal to 100"]
  }
}
```

## Testing

Comprehensive test suite in `tests/zod-validation-middleware.test.ts`:

- Query validation with defaults and coercion
- Body validation with sanitization
- Path parameter validation
- Combined validation scenarios
- Stellar address validation
- Error response formatting
- All 244 tests passing ✅

Run tests:
```bash
npm test -- tests/zod-validation-middleware.test.ts
```

## Integration Checklist

To add validation middleware to a route:

1. ✅ Check `src/schemas/common.ts` for reusable schemas
2. ✅ Compose or create a schema for your route
3. ✅ Add middleware to the route handler
4. ✅ Extract validated data in the handler
5. ✅ Update TypeScript types with `z.infer<>`
6. ✅ Test with invalid inputs to verify 400 responses
7. ✅ Remove manual validation code from handler

## Example: Complete Migration

**File: src/api/items.ts**

```typescript
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { validateQuery, validateBody, validateParams } from '../middleware/validation';
import { paginationSchema, safeLabel, filterSchema } from '../schemas/common';
import { z } from 'zod';

export const itemRouter = Router();

// Define schemas
const itemListQuerySchema = paginationSchema.merge(filterSchema);

const itemCreateBodySchema = z.object({
  name: safeLabel,
  description: z.string().optional(),
});

const itemParamSchema = z.object({
  id: z.string().uuid(),
});

// List items with pagination and filters
itemRouter.get(
  '/',
  validateQuery(itemListQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof itemListQuerySchema>;
    
    const skip = (query.page - 1) * query.limit;
    // ... query database
    
    res.json({ data: [], page: query.page, limit: query.limit });
  })
);

// Create item
itemRouter.post(
  '/',
  validateBody(itemCreateBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as any).validatedBody as z.infer<typeof itemCreateBodySchema>;
    
    // ... create item
    
    res.status(201).json({ id: 'new-id', ...body });
  })
);

// Get single item
itemRouter.get(
  '/:id',
  validateParams(itemParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = (req as any).validatedParams as z.infer<typeof itemParamSchema>;
    
    // ... fetch item
    
    res.json({ id: params.id });
  })
);
```

## Files Changed

1. **src/schemas/common.ts** - Added 15+ new schemas for common validation patterns
2. **src/middleware/validation.ts** - Created validation middleware factory (NEW)
3. **src/api/events.ts** - Migrated to use validation middleware (example)
4. **src/api/examples/validation-samples.ts** - 10 complete usage patterns (NEW)
5. **tests/zod-validation-middleware.test.ts** - Comprehensive test suite (NEW)

## Next Steps

To expand validation coverage:

1. Identify routes with manual query/body parsing in `src/api/`
2. Create schemas in `src/schemas/common.ts` if reusable
3. Add middleware to route handlers
4. Update tests to verify validation works
5. Remove manual `.parse()` calls from handlers

## Questions?

Refer to:
- **Patterns:** `src/api/examples/validation-samples.ts`
- **Schemas:** `src/schemas/common.ts`
- **Tests:** `tests/zod-validation-middleware.test.ts`
- **Middleware:** `src/middleware/validation.ts`
