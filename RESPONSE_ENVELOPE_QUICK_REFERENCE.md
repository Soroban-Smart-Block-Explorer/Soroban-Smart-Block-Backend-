# Response Envelope - Quick Reference

## What It Does

Wraps all successful API responses in a consistent format:
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z"
  }
}
```

## Usage

### Basic Response
```typescript
res.sendEnveloped({ id: 1, name: 'Item' });
```

### Offset-Based Pagination
```typescript
res.sendPaginated(items, { 
  total: 100, 
  page: 1, 
  limit: 20 
});
```

### Cursor-Based Pagination
```typescript
res.sendCursorPaginated(items, { 
  next: 'cursor-value', 
  hasMore: true 
});
```

### With Custom Status Code
```typescript
res.sendEnveloped({ id: 123 }, 201);  // Created
```

## Response Examples

### List Response
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Item 1" },
    { "id": 2, "name": "Item 2" }
  ],
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z"
  }
}
```

### Paginated Response
```json
{
  "success": true,
  "data": [...],
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

### Cursor Paginated Response
```json
{
  "success": true,
  "data": [...],
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-07-28T10:00:00.000Z",
    "cursor": {
      "next": "next-cursor-id",
      "hasMore": true
    }
  }
}
```

## Migration Examples

### Before
```typescript
router.get('/api/items', asyncHandler(async (req, res) => {
  const items = await db.items.findMany();
  res.json(items);  // Bare response
}));
```

### After
```typescript
router.get('/api/items', asyncHandler(async (req, res) => {
  const items = await db.items.findMany();
  res.sendEnveloped(items);  // Wrapped response
}));
```

## Key Features

✅ Automatic request ID inclusion
✅ ISO 8601 timestamp
✅ Pagination metadata support
✅ Type-safe TypeScript support
✅ Method chaining support
✅ Backward compatible with res.json()

## Files

- **Implementation:** `src/middleware/responseEnvelope.ts`
- **Types:** `src/types/express.d.ts`
- **Registration:** `src/index.ts`
- **Documentation:** `RESPONSE_ENVELOPE_GUIDE.md`
- **Tests:** `tests/response-envelope.test.ts`

## Available Methods

| Method | Usage | Returns |
|--------|-------|---------|
| `res.sendEnveloped<T>(data: T, statusCode?: number)` | Basic response wrapping | Enveloped response |
| `res.sendPaginated<T>(data: T, pagination)` | Offset-based pagination | Enveloped + pagination metadata |
| `res.sendCursorPaginated<T>(data: T, cursor)` | Cursor-based pagination | Enveloped + cursor metadata |

## Status

✅ **Implementation complete**
✅ **Tests passing: 248/248**
✅ **Ready for use**

## Next Steps

1. Use `res.sendEnveloped()` for new routes
2. Gradually migrate existing routes
3. Clients can rely on consistent response structure
