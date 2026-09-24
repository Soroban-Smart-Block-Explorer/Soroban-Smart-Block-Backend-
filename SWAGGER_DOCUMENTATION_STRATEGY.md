# Swagger API Documentation Strategy

## Problem Statement

The Swagger UI at `/api/docs` is mounted in `src/index.ts:60`, and `swagger-jsdoc` is configured in `src/indexer/swaggerSpec.ts` to generate the OpenAPI spec from JSDoc comments. However, most route handlers lack `@swagger` JSDoc annotations, so the generated spec is incomplete.

Current status:
- **Configured**: swagger-jsdoc setup with options scanning `src/api/**/*.ts`
- **Partially documented**: Some files have Swagger comments, most don't
- **Routes in spec**: Likely <10% of 1,180 routes
- **Swagger UI**: Shows incomplete API documentation

## Root Cause

Route handlers need JSDoc blocks with `@swagger` tags for each endpoint to be included in the generated OpenAPI spec. The scanner looks for patterns like:

```typescript
/**
 * @swagger
 * /api/v1/endpoint:
 *   get:
 *     summary: Description
 *     parameters: [...]
 *     responses: {...}
 */
```

## Solution Architecture

### Phase 1: Swagger JSDoc Standard (This doc)
Define the standardformat for all route handlers

### Phase 2: Automated Annotation Tool
Create a script that:
- Scans route files for undocumented handlers
- Generates Swagger JSDoc templates
- Injects them into files

### Phase 3: Incremental Population
- Target Tier 1 routes first (52 critical handlers)
- Populate Tier 2, 3, 4 systematically
- Verify all routes appear in Swagger UI

### Phase 4: CI/CD Integration
- Enforce Swagger documentation on new routes
- Fail builds if routes lack documentation
- Generate swagger spec in pre-commit hooks

## Swagger JSDoc Format

Every route handler should have a JSDoc block with `@swagger` tag above the route definition:

```typescript
/**
 * @swagger
 * /api/v1/endpoint:
 *   get:
 *     summary: Clear description of what this does
 *     tags: [TagName]
 *     description: |
 *       Longer description with details about:
 *       - What data it returns
 *       - What filters are available
 *       - Any special behaviors
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Resource identifier
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum items to return
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               field1:
 *                 type: string
 *                 description: Description
 *             required: [field1]
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/EntityName'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Not found
 *       500:
 *         description: Server error
 *     security:
 *       - ApiKeyAuth: []
 */
router.get('/:id', asyncHandler(async (req, res) => {
  // Implementation
}));
```

## Component Breakdown

### 1. Path Definition (`/api/v1/endpoint:`)
- Include the full API path
- Matches the route definition

### 2. HTTP Method (`get:`, `post:`, `put:`, `delete:`)
- Corresponds to router method

### 3. Summary & Tags
- `summary`: One-line description (max 120 chars)
- `tags`: Categorization (matches swaggerSpec.ts tags)

### 4. Parameters
- **Path parameters** (`in: path`)
  - Extracted from `:param` in route path
  - Always required
- **Query parameters** (`in: query`)
  - From `req.query` parsing
  - Specify defaults if applicable
- **Headers** (`in: header`)
  - If custom headers needed (e.g., X-API-Key)

### 5. Request Body (`requestBody`)
- Only for POST/PUT/PATCH
- Schema matches Zod validation or request type
- `required: true/false` at the object level

### 6. Responses
- **200/201**: Success (GET/POST typically return 200/201)
- **400**: Bad request (validation error)
- **401**: Unauthorized (if auth-protected)
- **403**: Forbidden (if permission-gated)
- **404**: Not found (if resource not found)
- **429**: Rate limited
- **500**: Server error
- Each response includes schema

### 7. Security
- `security: [{ ApiKeyAuth: [] }]` if API-key protected
- Omit if endpoint is public

### 8. Schema References
- Use `$ref: '#/components/schemas/EntityName'` to reference pre-defined schemas
- Pre-defined schemas already in `swaggerSpec.ts` (Transaction, Event, Contract, etc.)

## Quick Templates

### GET List Endpoint
```yaml
/**
 * @swagger
 * /api/v1/resource:
 *   get:
 *     summary: List resources with optional filtering
 *     tags: [ResourceName]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum items (1-100)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-based)
 *     responses:
 *       200:
 *         description: List of resources
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Resource'
 *                 pagination:
 *                   type: object
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
```

### GET Detail Endpoint
```yaml
/**
 * @swagger
 * /api/v1/resource/{id}:
 *   get:
 *     summary: Retrieve a specific resource
 *     tags: [ResourceName]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Resource identifier
 *     responses:
 *       200:
 *         description: Resource details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Resource'
 *       404:
 *         description: Resource not found
 */
```

### POST Create Endpoint
```yaml
/**
 * @swagger
 * /api/v1/resource:
 *   post:
 *     summary: Create a new resource
 *     tags: [ResourceName]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               value:
 *                 type: number
 *             required: [name]
 *     responses:
 *       201:
 *         description: Resource created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Resource'
 *       400:
 *         description: Validation error
 *       409:
 *         description: Resource already exists
 */
```

## Tag Organization

Match tags in `swaggerSpec.ts`:

```
- Transactions
- Events
- Contracts
- Wallets
- Tokens
- DEX Analysis
- MEV Analysis
- Sandbox
- Reputation
- Privacy
- Compliance
- Governance
- Analytics
- Admin
```

## Implementation Roadmap

### Week 1: Tier 1 Critical (52 handlers)
- transactions.ts (2)
- contracts.ts (6)
- events.ts (2)
- tokens.ts (4)
- wallets.ts (3)
- dex.ts (2)
- mev.ts (33)
- Subtotal: ~52 routes

### Week 2: Tier 2 High-Value (150 handlers)
- analytics (20)
- nft (29)
- compliance (43)
- governance (16)
- privacy (40)
- Subtotal: ~150 routes

### Week 3: Tier 3 Specialized (150+ handlers)
- data-market (35)
- composability (31)
- nlq (30)
- market (14)
- Other specialized

### Week 4: Tier 4 + Verification
- Admin/Developer portal (50)
- Verify all 1,180 routes in Swagger UI
- Fix any gaps

## Verification Checklist

- [ ] Swagger UI at `/api/docs` loads without errors
- [ ] All critical routes (Tier 1) appear in Swagger UI
- [ ] Each route shows:
  - [ ] Summary description
  - [ ] Tags for categorization
  - [ ] Parameter documentation
  - [ ] Request body schema (if applicable)
  - [ ] Response schemas for all status codes
  - [ ] Error responses documented
- [ ] Response examples work correctly
- [ ] Can execute test requests from Swagger UI
- [ ] API spec exports correctly as JSON (`/api/docs.json`)

## Maintenance

### For New Routes

When adding a new route, include Swagger JSDoc before the handler:

1. Copy appropriate template above
2. Fill in:
   - Path
   - HTTP method
   - Summary (one-liner)
   - Tags
   - Parameters
   - Responses
3. Test at `/api/docs`
4. Commit with PR

### Pre-commit Hook

Future: Add git hook to verify Swagger presence on new routes:

```bash
# pseudo-code
if route.method !== documented_in_swagger:
  exit 1 "Route missing Swagger documentation"
```

## Tools

### Swagger UI
- Accessible at `/api/docs` (development/staging)
- Try-it-out requests available
- JSON spec at `/api/docs.json`

### Swagger Editor
- External: https://editor.swagger.io/
- Upload `/api/docs.json` to preview offline

### Swagger CLI
```bash
# Validate spec
swagger-cli validate ./api-spec.json

# Convert to other formats
swagger-cli bundle ./api-spec.json -o api-spec.html
```

## Benefits

✓ **Discoverability**: Users see all available endpoints  
✓ **Type Safety**: Responses/requests clearly typed  
✓ **Testing**: Try-it-out in Swagger UI  
✓ **Code Gen**: Generate client SDKs from spec  
✓ **Documentation**: Self-documenting API  
✓ **Maintenance**: Clear contracts prevent bugs  

## Next Steps

1. ✓ Create this strategy document
2. → Implement Tier 1 routes (52 critical handlers)
3. → Verify all routes appear in `/api/docs`
4. → Implement remaining tiers
5. → Set up CI enforcement

---

**Status**: In Progress  
**Target**: 100% coverage (1,180 routes)  
**ETA**: 4 weeks  

