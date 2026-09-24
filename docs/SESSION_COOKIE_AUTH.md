# Session Cookie Authentication — Design & Implementation

## Overview

Session cookie authentication provides a complementary authentication method to the existing X-Api-Key header authentication. It enables:

- **Web browser support** — Cookies are automatically sent by browsers, enabling traditional web apps
- **Session management** — User sessions persist across requests without re-sending credentials
- **XSS protection** — HTTP-only cookies are inaccessible to JavaScript
- **CSRF defense** — SameSite cookie policy prevents cross-site request forgery
- **Dual auth** — Both header-based and cookie-based auth can coexist on the same endpoint

### Problem Solved

Previously, only header-based auth (Bearer token) was supported. This limited the backend to:
- API-only clients (mobile apps, backend-to-backend calls)
- SPAs that manually manage authentication tokens in storage or headers

Web browsers couldn't use the API directly because:
1. No automatic cookie handling like traditional web servers
2. No session persistence mechanism
3. No browser-friendly authentication UI

## Architecture

### Authentication Flow

```
Browser Request
    ↓
Cookie sent automatically in request
    ↓
cookie-parser middleware parses cookies
    ↓
sessionCookieAuth middleware validates signature
    ├─ If valid: extract session data, attach to req.session
    └─ If invalid: return 400 error
    ↓
Route handler checks req.session or req.apiKey
    ├─ requireSession() — require valid session
    ├─ requireSessionTier() — require tier level
    ├─ requirePermission() — require specific permission
    ├─ dualAuth() — accept either auth method
    └─ no guard — both auth methods work (implicit)
```

### Cookie Format

Cookies are signed with HMAC-SHA256 to prevent tampering:

```
soroban_session = <base64-encoded-json>.<base64-encoded-signature>

Decoded format:
{
  "sessionId": "sess_abc123...",
  "userId": "user_xyz789...",
  "username": "alice@example.com",
  "email": "alice@example.com",
  "tier": "pro",
  "permissions": ["admin", "write"],
  "createdAt": "2026-07-29T06:40:00.000Z",
  "expiresAt": "2026-07-30T06:40:00.000Z"
}
```

### Session Data Structure

```typescript
interface SessionContext {
  sessionId: string;           // Unique session identifier
  userId: string;              // User ID from your user table
  username?: string;           // Display name (optional)
  email?: string;              // Email address (optional)
  tier: string;                // "free", "pro", "enterprise", etc.
  permissions?: string[];      // Role-based permissions
  createdAt: Date;             // When session was created
  expiresAt: Date;             // When session expires
}
```

---

## Configuration

### Environment Variables

```env
# HMAC signing key (leave empty to disable cookie validation)
COOKIE_SECRET=your-secure-random-key

# Session duration in milliseconds (default: 24 hours)
COOKIE_EXPIRES_MS=86400000

# Set cookie only over HTTPS (default: true)
COOKIE_SECURE=true

# Make cookie JS-inaccessible (default: true)
COOKIE_HTTP_ONLY=true

# SameSite policy: strict | lax | none (default: strict)
COOKIE_SAME_SITE=strict

# Cookie name in Set-Cookie header (default: soroban_session)
COOKIE_NAME=soroban_session
```

### Generate a Secure Secret

```bash
openssl rand -hex 32
# Output: 8f3e9c2d1a5b4f7e6d9c2a8e5f1b4c7e9a2d5f8b1c4e7a0d3f6b9c2e5a8f1d4
```

### Deployment Configuration

**Development (unsigned cookies, for testing)**
```env
# Leave COOKIE_SECRET empty
COOKIE_SECRET=
COOKIE_SECURE=false  # Allow HTTP in development
```

**Production (signed cookies, HTTPS-only)**
```env
COOKIE_SECRET=your-secure-random-key
COOKIE_SECURE=true
COOKIE_HTTP_ONLY=true
COOKIE_SAME_SITE=strict
```

---

## Usage

### Setting a Session Cookie

After user login/registration, set the session cookie in the response:

```typescript
import { setSessionCookie } from './middleware/cookieAuth';

// In your login endpoint handler
app.post('/api/v1/auth/login', async (req, res) => {
  // Authenticate user
  const user = await authenticateUser(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // Create session
  const session: SessionContext = {
    sessionId: generateId(),
    userId: user.id,
    username: user.email,
    email: user.email,
    tier: user.tier,
    permissions: user.permissions,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + COOKIE_CONFIG.expiresMs),
  };

  // Set the cookie on response
  setSessionCookie(res, session);

  res.json({
    status: 'logged_in',
    user: { id: user.id, email: user.email, tier: user.tier },
  });
});
```

### Requiring Session Authentication

Guard routes with session requirement:

```typescript
import { requireSession, requireSessionTier, requirePermission } from './middleware/cookieAuth';

// Require valid session
app.get('/api/v1/profile', requireSession, (req, res) => {
  res.json({
    userId: req.session!.userId,
    tier: req.session!.tier,
  });
});

// Require tier level
app.post('/api/v1/export', requireSessionTier('pro'), (req, res) => {
  // Only pro users and above can export
});

// Require specific permission
app.post('/api/v1/admin/users', requirePermission('admin'), (req, res) => {
  // Only users with admin permission
});
```

### Dual Authentication (Accept Either)

Allow both API keys and session cookies:

```typescript
import { dualAuth } from './middleware/cookieAuth';

app.get('/api/v1/transactions', dualAuth, (req, res) => {
  // Works with X-Api-Key header OR session cookie
  const tier = req.apiKey?.tier ?? req.session?.tier ?? 'unauthenticated';
  res.json({ tier });
});
```

### Clearing Session Cookie (Logout)

```typescript
import { clearSessionCookie } from './middleware/cookieAuth';

app.post('/api/v1/auth/logout', requireSession, (req, res) => {
  clearSessionCookie(res);
  res.json({ status: 'logged_out' });
});
```

---

## Security Considerations

### HMAC Signature Verification

- **Timing-safe comparison** — Uses `crypto.timingSafeEqual()` to prevent timing attacks
- **Base64 encoding** — Payload and signature both base64-encoded before HMAC
- **SHA-256 hashing** — Strong cryptographic hash (NIST approved)

### Cookie Security

| Setting | Default | Purpose |
|---------|---------|---------|
| **HttpOnly** | true | Prevents JavaScript access (XSS defense) |
| **Secure** | true | Only send over HTTPS (eavesdropping defense) |
| **SameSite=Strict** | strict | Prevents cross-site request forgery (CSRF defense) |
| **Path=/** | / | Cookie sent to all endpoints |

### Rotation Strategy

When rotating secrets:

1. Deploy new code with OLD secret in fallback position
2. New sessions use NEW secret
3. Wait 24 hours (session TTL) for all old sessions to expire
4. Remove fallback, keep NEW secret only

```typescript
// Temporary: Accept both old and new secrets during rotation
function verifyCookieWithFallback(value: string) {
  try {
    return verifyCookie(value, CURRENT_SECRET);
  } catch (err) {
    return verifyCookie(value, PREVIOUS_SECRET);
  }
}
```

---

## Troubleshooting

### "Invalid cookie format: expected 'payload.signature'"

**Cause**: Cookie present but not in expected format (not signed by this server).

**Solution**:
1. Check that COOKIE_SECRET is set consistently
2. Verify cookies are being set by `setSessionCookie()` function
3. Clear browser cookies and re-authenticate

### "Cookie signature verification failed"

**Cause**: HMAC signature doesn't match (cookie tampered with or secret changed).

**Solution**:
1. **Secret rotation**: Ensure secret wasn't just rotated — use fallback during rotation
2. **Client reset**: Browser cookies are stale — clear cookies and re-authenticate
3. **Multiple servers**: If using multiple backend instances, ensure they have the same COOKIE_SECRET

### "Cookie payload is not valid JSON"

**Cause**: Base64 payload decodes to invalid JSON.

**Solution**:
1. This is rare — indicates memory corruption or partial write
2. Check logs for any truncation or encoding errors
3. Clear cookies and re-authenticate

### Cookie not being sent by browser

**Cause**: Browser not including cookie in request.

**Possible solutions**:
1. **SameSite=Strict**: Cookies not sent to cross-site requests. Use `SameSite=Lax` for third-party embeds.
2. **Secure flag**: Browser won't send secure cookies over HTTP. Use HTTPS or disable in dev.
3. **Domain mismatch**: Cookie set for one domain, accessed from another (e.g., localhost vs 127.0.0.1).
4. **HttpOnly**: Cookies are correctly HttpOnly — check browser DevTools → Application → Cookies.

---

## Audit Logging

Session authentication events are logged at DEBUG and WARN levels:

```
[session-auth] Valid session cookie
  sessionId=sess_abc123
  userId=user_xyz789
  tier=pro

[session-auth] Invalid session cookie
  error=Cookie signature verification failed
  ip=203.0.113.42
```

Monitor for repeated "Invalid cookie" warnings which may indicate tampering attempts.

---

## Monitoring

### Metrics to Track

1. **Session validation success rate** — `valid_sessions / total_sessions`
2. **Cookie signature failures** — Could indicate secret mismatch across replicas
3. **Session expiry rate** — How many sessions expire vs. refresh
4. **Tier distribution** — What percentage of sessions are pro vs. free

### Example Prometheus Metrics

```typescript
import { Counter, Gauge } from 'prom-client';

const sessionCounter = new Counter({
  name: 'session_validations_total',
  help: 'Total session cookie validation attempts',
  labelNames: ['status'], // 'valid' or 'invalid'
});

const sessionTierGauge = new Gauge({
  name: 'active_sessions_by_tier',
  help: 'Number of active sessions by tier',
  labelNames: ['tier'],
});
```

---

## Testing

### Unit Test Example

```typescript
import { createSessionCookie, parseSessionCookie } from './cookieAuth';

test('session cookie round-trip', () => {
  const session: SessionContext = {
    sessionId: 'sess_123',
    userId: 'user_456',
    tier: 'pro',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  };

  const secret = 'test-secret';
  const cookie = createSessionCookie(session, secret);
  const decoded = parseSessionCookie({ soroban_session: cookie }, 'soroban_session', secret);

  expect(decoded.userId).toBe('user_456');
  expect(decoded.tier).toBe('pro');
});
```

### Integration Test Example

```typescript
import request from 'supertest';
import app from '../index';

test('login sets session cookie', async () => {
  const res = await request(app).post('/api/v1/auth/login').send({
    email: 'user@example.com',
    password: 'password123',
  });

  expect(res.status).toBe(200);
  expect(res.headers['set-cookie']).toBeDefined();
  expect(res.headers['set-cookie'][0]).toContain('soroban_session=');
  expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
  expect(res.headers['set-cookie'][0]).toContain('SameSite=Strict');
});

test('authenticated request with cookie', async () => {
  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email: 'user@example.com',
    password: 'password123',
  });

  const cookie = loginRes.headers['set-cookie'];

  const profileRes = await request(app)
    .get('/api/v1/profile')
    .set('Cookie', cookie);

  expect(profileRes.status).toBe(200);
  expect(profileRes.body.userId).toBeDefined();
});
```

---

## Migration Path

### Phase 1: Deploy (No Breaking Changes)

- Add `cookieParser` middleware
- Add `sessionCookieAuth` middleware
- Both are **no-ops** if no session cookie is present
- Existing API key auth continues to work unchanged

### Phase 2: Implement Session Endpoints (Opt-In)

- Create `/api/v1/auth/login` endpoint that sets session cookie
- Create `/api/v1/auth/logout` endpoint that clears cookie
- Update `/api/v1/profile` to accept session auth
- Document for existing clients

### Phase 3: Expand Coverage (Gradual)

- Start protecting new endpoints with session requirement
- Gradually migrate existing endpoints to support session auth
- Allow both header and cookie auth during transition

### Phase 4: Optional - Deprecate (Far Future)

- Announce deprecation of header auth (very long notice)
- Migrate all endpoints to session-preferred
- Keep header auth as fallback indefinitely

---

## FAQ

**Q: Do I need to remove X-Api-Key authentication?**  
A: No. Both methods coexist. Gradually migrate routes to support sessions.

**Q: What if COOKIE_SECRET is empty?**  
A: Cookies are not signed (development-only mode). Not recommended for production.

**Q: How do I handle multiple backend instances?**  
A: Ensure all instances have the same `COOKIE_SECRET`. Use a load balancer's sticky sessions or share session data via Redis.

**Q: Can I use this with GraphQL?**  
A: Yes. The sessionCookieAuth middleware runs before GraphQL handler, so `req.session` is available in resolvers.

**Q: How do I refresh an expiring session?**  
A: Issue a new cookie with updated `expiresAt` when user makes a request near expiry (e.g., if < 1 hour left, refresh).

---

## References

- **RFC 6265**: HTTP State Management Mechanism (cookies)
- **OWASP**: Session Management Cheat Sheet
- **MDN**: Cookies spec and security considerations
- **NIST**: FIPS 180-4 SHA-256 specification

---

## Related Issues

- Issue: "Currently only header-based auth is supported"
- Solution: Session Cookie Authentication (this document)
- Status: ✅ Implemented and production-ready
