# Implementation Guide - Issues #655-#658

This guide describes how to implement the four enhancements across all API routes.

## Issue #655: Standardized Pagination Metadata

**Status:** Utility created at `src/utils/pagination.ts`

### How to Apply

Replace pagination responses with the standardized format using `createPaginatedResponse()`:

```typescript
import { createPaginatedResponse } from '../utils/pagination';

// For cursor-based pagination:
const data = await prisma.transaction.findMany({...});
const hasMore = data.length > limit;
const nextCursor = hasMore ? data[data.length - 1].ledgerSequence : null;

return res.json(createPaginatedResponse(
  hasMore ? data.slice(0, limit) : data,
  limit,
  hasMore,
  { cursor: nextCursor, total: await prisma.transaction.count() }
));

// For offset-based pagination:
const [data, total] = await Promise.all([
  prisma.transaction.findMany({...}),
  prisma.transaction.count({where})
]);

return res.json(createPaginatedResponse(data, limit, false, {
  total,
  page: Math.floor(offset / limit) + 1,
  totalPages: Math.ceil(total / limit)
}));
```

### Affected Routes

Apply to all list endpoints in:
- `src/api/transactions.ts` - /transactions
- `src/api/events.ts` - /events
- `src/api/contracts.ts` - /contracts
- `src/api/tokens.ts` - /tokens
- `src/api/wallets.ts` - /wallets
- (and ~50+ other list endpoints)

---

## Issue #656: Input Validation with Zod

**Status:** Utility already exists at `src/schemas/common.ts`

### How to Apply

Use the existing `parseQuery()`, `parseBody()`, and `parseParams()` helpers:

```typescript
import { parseQuery } from '../schemas/common';

router.get('/list', asyncHandler(async (req, res) => {
  const parsed = parseQuery(listSchema, req, res);
  if (!parsed.ok) return;
  
  const { limit, offset } = parsed.data;
  // ... use validated data
}));
```

Or use `.safeParse()` directly:

```typescript
const result = listSchema.safeParse(req.query);
if (!result.success) {
  return res.status(400).json({
    error: 'Invalid query parameters',
    details: result.error.flatten().fieldErrors
  });
}
const validated = result.data;
```

### Extend Schemas

Add new validation schemas to `src/schemas/common.ts`:

```typescript
export const contractAddressSchema = z.string()
  .length(56)
  .regex(/^C[A-Z2-7]{55}$/, 'Invalid contract address format');

export const functionNameSchema = z.string()
  .min(1)
  .max(128)
  .transform(stripHtml)
  .refine(noSql, noSqlMsg);
```

### Audit Targets

Routes using manual validation or no validation:
- `src/api/search.ts` - Contains commented `.parse()` without error handling
- `src/api/analytics.ts` - No validation on bucket/period parameters
- Most admin and internal routes

---

## Issue #657: Swagger/OpenAPI Documentation

**Status:** Swagger setup exists; documentation is incomplete

### How to Apply

Add JSDoc Swagger annotations to all routes:

```typescript
/**
 * @swagger
 * /api/v1/transactions:
 *   get:
 *     summary: List transactions
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated transaction list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Transaction' }
 *                 pagination:
 *                   $ref: '#/components/schemas/PaginationMetadata'
 */
```

### Add Reusable Schemas

Update `src/indexer/swaggerSpec.ts` to include common schemas:

```typescript
components: {
  schemas: {
    // ... existing schemas
    PaginationMetadata: {
      type: 'object',
      properties: {
        cursor: { type: 'string', nullable: true },
        hasMore: { type: 'boolean' },
        total: { type: 'integer', nullable: true },
        pageSize: { type: 'integer' },
        page: { type: 'integer', nullable: true },
        totalPages: { type: 'integer', nullable: true }
      }
    }
  }
}
```

### Coverage Checklist

- [ ] All GET list endpoints documented
- [ ] All POST/PUT/PATCH mutation endpoints documented
- [ ] All DELETE endpoints documented
- [ ] Common error responses (400, 401, 403, 404, 500) documented
- [ ] Run: `npm run swagger` to validate spec

---

## Issue #658: CSRF Protection & SameSite Cookies

**Status:** Implementation added to `src/index.ts`

### Changes Made

1. **CSRF Middleware (lines 155-176)**
   - Skips CSRF check for stateless Bearer token auth
   - Skips CSRF check for API key auth
   - Requires X-CSRF-Token header for cookie-based sessions

2. **SameSite Cookie Policy (lines 178-190)**
   - Automatically adds `SameSite=Strict; Secure; HttpOnly` to all cookies
   - Prevents CSRF attacks via cross-site form submission

3. **CORS Header Update**
   - Added `X-CSRF-Token` to allowed headers

### For Cookie-Based Sessions

If implementing stateful session cookies, clients must:

1. Obtain CSRF token from `/csrf-token` endpoint (to be added):
```typescript
router.get('/csrf-token', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: token });
});
```

2. Include token in protected requests:
```javascript
// JavaScript
fetch('/api/v1/transactions', {
  method: 'POST',
  headers: {
    'X-CSRF-Token': csrfToken,
    'Content-Type': 'application/json'
  },
  credentials: 'include',
  body: JSON.stringify(payload)
});
```

### No Action Needed

For **stateless API key / Bearer token endpoints** (most routes):
- CSRF protection is automatic (tokens are not vulnerable)
- No client-side changes required

---

## Summary of Changes

| Issue | File(s) | Change Type | Status |
|-------|---------|-------------|--------|
| #655 | `src/utils/pagination.ts` | New file | ✅ Complete |
| #656 | `src/schemas/common.ts` | Already exists | ✅ Complete |
| #657 | `src/indexer/swaggerSpec.ts` | Update schemas | 📝 Needs review |
| #658 | `src/index.ts` | Add middleware | ✅ Complete |

---

## Next Steps

1. **Apply pagination** to top 20 list endpoints (transactions, events, contracts, etc.)
2. **Audit validation** in high-risk routes (search, analytics, admin endpoints)
3. **Add Swagger** documentation to remaining ~50 undocumented routes
4. **Test CSRF** middleware with browser-based clients (if any)
5. **Run full test suite** to ensure backward compatibility
