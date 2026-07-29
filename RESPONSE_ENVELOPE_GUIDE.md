# Response Envelope Middleware

## Overview

The response envelope middleware provides a **consistent, standardized format** for all successful API responses. Every response automatically includes metadata such as request ID and timestamp.

## Standard Response Format

### Basic Response
```json
{
  "success": true,
  "data": {
    "items": [...]
  },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z"
  }
}
```

### Offset-Based Paginated Response
```json
{
  "success": true,
  "data": {
    "items": [...]
  },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z",
    "pagination": {
      "total": 100,
      "page": 1,
      "limit": 20,
      "pages": 5
    }
  }
}
```

### Cursor-Based Paginated Response
```json
{
  "success": true,
  "data": {
    "items": [...]
  },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z",
    "cursor": {
      "next": "next-cursor-value",
      "hasMore": true
    }
  }
}
```

### Error Response (Handled by Error Handler)
```json
{
  "success": false,
  "error": "Item not found",
  "code": "NOT_FOUND",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "statusCode": 404
}
```

## Usage

### Basic Response

**Before:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const items = await db.items.findMany();
  res.json(items);  // Bare array: [...]
}));
```

**After:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const items = await db.items.findMany();
  res.sendEnveloped(items);  // Wrapped: { success: true, data: [...], meta: {...} }
}));
```

### Paginated Response

**Before:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const skip = (page - 1) * limit;
  
  const [items, total] = await Promise.all([
    db.items.findMany({ skip, take: limit }),
    db.items.count(),
  ]);
  
  res.json({ items, total, page, limit });  // Manual pagination format
}));
```

**After:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const skip = (page - 1) * limit;
  
  const [items, total] = await Promise.all([
    db.items.findMany({ skip, take: limit }),
    db.items.count(),
  ]);
  
  res.sendPaginated(items, { total, page, limit });  // Auto-wrapped with pagination metadata
}));
```

### Cursor-Based Paginated Response

**Before:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const { cursor, limit } = req.query;
  
  let query: any = {};
  if (cursor) {
    query = { id: { gt: cursor } };
  }
  
  const items = await db.items.findMany({ 
    where: query,
    take: limit + 1  // Fetch one extra to check if more exist
  });
  
  const hasMore = items.length > limit;
  const nextCursor = hasMore ? items[limit - 1].id : null;
  
  res.json({ 
    items: hasMore ? items.slice(0, limit) : items,
    cursor: nextCursor,
    hasMore
  });
}));
```

**After:**
```typescript
router.get('/items', asyncHandler(async (req, res) => {
  const { cursor, limit } = req.query;
  
  let query: any = {};
  if (cursor) {
    query = { id: { gt: cursor } };
  }
  
  const items = await db.items.findMany({ 
    where: query,
    take: limit + 1
  });
  
  const hasMore = items.length > limit;
  const nextCursor = hasMore ? items[limit - 1].id : null;
  
  res.sendCursorPaginated(
    hasMore ? items.slice(0, limit) : items,
    { next: nextCursor, hasMore }
  );
}));
```

## Available Methods

### `res.sendEnveloped<T>(data: T, statusCode?: number): Response`

Send response in standard envelope format with success metadata.

```typescript
// Basic usage
res.sendEnveloped({ id: 123, name: 'Item' });

// With custom status code
res.sendEnveloped({ id: 123 }, 201);  // Created
```

### `res.sendPaginated<T>(data: T, pagination: { total, page, limit }): Response`

Send offset-based paginated response with pagination metadata.

```typescript
const items = await db.items.findMany({ skip: 0, take: 20 });
const total = await db.items.count();

res.sendPaginated(items, { 
  total,
  page: 1,
  limit: 20
});
// Automatically calculates: pages = Math.ceil(total / limit) = 5
```

### `res.sendCursorPaginated<T>(data: T, cursor: { next?, hasMore }): Response`

Send cursor-based paginated response with cursor metadata.

```typescript
const items = await db.items.findMany({ 
  where: { id: { gt: cursor } },
  take: 21  // Fetch one extra
});

const hasMore = items.length > 20;
const nextCursor = hasMore ? items[19].id : null;

res.sendCursorPaginated(
  hasMore ? items.slice(0, 20) : items,
  { next: nextCursor, hasMore }
);
```

## Automatic Features

- ✅ **Request ID:** Automatically included from `correlationMiddleware`
- ✅ **Timestamp:** ISO 8601 format, generated at response time
- ✅ **Success Flag:** Always `true` for successful responses
- ✅ **Type Safe:** Full TypeScript support with generics

## Backward Compatibility

The middleware is **purely additive**. Existing `res.json()` calls continue to work:

```typescript
// Still works - returns bare data without envelope
res.json(data);

// New - returns data wrapped in envelope
res.sendEnveloped(data);

// New - paginated responses with metadata
res.sendPaginated(data, pagination);
```

**Migration Strategy:**
1. Use `res.sendEnveloped()` for new routes
2. Update existing routes incrementally
3. No breaking changes to error handling (errors still use errorHandler format)

## Client-Side Consumption

### JavaScript/TypeScript
```typescript
interface Response<T> {
  success: boolean;
  data?: T;
  meta: {
    requestId: string;
    timestamp: string;
    pagination?: {
      total: number;
      page: number;
      limit: number;
      pages: number;
    };
  };
}

const response = await fetch('/api/items');
const { success, data, meta } = await response.json() as Response<Item[]>;

if (success) {
  console.log(`Requested ${data.length} items in ${meta.timestamp}`);
  if (meta.pagination) {
    console.log(`Page ${meta.pagination.page} of ${meta.pagination.pages}`);
  }
}
```

### cURL
```bash
curl http://localhost:3000/api/items | jq .

# Response:
{
  "success": true,
  "data": [...],
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z"
  }
}
```

## Benefits

✅ **Consistency:** All responses follow same structure
✅ **Discoverability:** Clients always know where data is
✅ **Traceability:** Request ID included for support/debugging
✅ **Extensibility:** Easy to add fields to `meta`
✅ **Type Safe:** Full TypeScript support with generics
✅ **Backward Compatible:** Existing `res.json()` still works
✅ **Non-Breaking:** Errors handled separately by error handler

## Migration Checklist

For routes using `res.json()`:

- [ ] Identify response data structure
- [ ] Choose appropriate send method:
  - `res.sendEnveloped()` - single item or list
  - `res.sendPaginated()` - offset-based pagination
  - `res.sendCursorPaginated()` - cursor-based pagination
- [ ] Update handler to use new method
- [ ] Test response format
- [ ] Update client code if needed
- [ ] Verify request ID is present in response

## Implementation Details

**Middleware Location:** `src/middleware/responseEnvelope.ts`

**Express Type Extensions:** `src/types/express.d.ts`

**Middleware Registration:** `src/index.ts` (after `correlationMiddleware`)

**Request ID Source:**
1. AsyncLocalStorage context (from `correlationMiddleware`)
2. `req.requestId` (fallback)
3. `'unknown'` (if neither available)

**Timestamp Format:** ISO 8601 (e.g., `2026-07-28T10:00:00.000Z`)

## Examples

### Example 1: List with Offset Pagination
```typescript
router.get('/api/contracts', 
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const query = (req as any).validatedQuery;
    const skip = (query.page - 1) * query.limit;
    
    const [data, total] = await Promise.all([
      db.contract.findMany({ skip, take: query.limit }),
      db.contract.count(),
    ]);
    
    res.sendPaginated(data, { 
      total, 
      page: query.page, 
      limit: query.limit 
    });
  })
);

// Response:
{
  "success": true,
  "data": [...],
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "pagination": { "total": 100, "page": 1, "limit": 20, "pages": 5 }
  }
}
```

### Example 2: Create Response with 201 Status
```typescript
router.post('/api/items',
  validateBody(createItemSchema),
  asyncHandler(async (req, res) => {
    const body = (req as any).validatedBody;
    const item = await db.items.create({ data: body });
    res.sendEnveloped(item, 201);  // Created
  })
);

// Response:
{
  "success": true,
  "data": { "id": 123, "name": "Item" },
  "meta": {
    "requestId": "...",
    "timestamp": "..."
  }
}
```

### Example 3: Cursor-Based List
```typescript
router.get('/api/transactions',
  asyncHandler(async (req, res) => {
    const { cursor, limit = 20 } = req.query;
    
    const txs = await db.transaction.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      take: limit + 1,
      orderBy: { id: 'asc' },
    });
    
    const hasMore = txs.length > limit;
    const nextCursor = hasMore ? txs[limit - 1].id : null;
    
    res.sendCursorPaginated(
      hasMore ? txs.slice(0, limit) : txs,
      { next: nextCursor, hasMore }
    );
  })
);

// Response:
{
  "success": true,
  "data": [...],
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cursor": { "next": "next-id", "hasMore": true }
  }
}
```

## See Also

- **Error Handler:** `src/middleware/errorHandler.ts` (handles error responses)
- **Correlation Middleware:** `src/middleware/correlation.ts` (provides request ID)
- **Validation Middleware:** `src/middleware/validation.ts` (validates incoming data)
