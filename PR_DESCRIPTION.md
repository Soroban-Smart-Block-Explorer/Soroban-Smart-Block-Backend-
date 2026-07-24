# Pull Request: Fix DNS Rebinding and Redirect-Based SSRF Vulnerabilities

## 🔒 Security Issue

This PR fixes critical SSRF (Server-Side Request Forgery) vulnerabilities in the webhook delivery system that could allow attackers to:

- Access AWS/GCP/Azure metadata endpoints (169.254.169.254)
- Reach internal services on private networks (10.x, 192.168.x, 172.16.x)
- Exfiltrate data from internal systems
- Bypass security controls via redirect chains

## 🐛 Vulnerabilities Fixed

### 1. DNS Rebinding (TOCTOU Attack)

**Problem:** Attacker-controlled DNS nameserver could return different IPs between validation check and actual connection.

**Attack Flow:**
```
T0 (check-time):  evil.com → 8.8.8.8 (public, passes validation)
T1 (use-time):    evil.com → 169.254.169.254 (AWS metadata)
```

**Root Cause:** `safePost()` called `buildSafeAxios(timeoutMs)` without passing the hostname and pinned IPs, so DNS pinning wasn't working.

### 2. Redirect-Based SSRF Bypass

**Problem:** Redirects to internal IPs could bypass initial URL validation.

**Attack Flow:**
```
Initial:   https://evil.com/webhook (public IP, passes)
Redirect:  302 → http://169.254.169.254/latest/meta-data/
```

**Root Cause:** Single HTTP client reused across redirect chain without per-hop DNS pinning.

## ✅ Solution

### Key Changes

1. **Per-Hop DNS Pinning**
   - Each redirect creates a fresh HTTP client with DNS pinned to validated IPs
   - `safePost()` now passes `hostname` and `pinnedIps` to `buildSafeAxios()`
   - Forces HTTP client to connect to exact validated IP

2. **Enhanced DNS Lookup Security**
   - Custom lookup function blocks unexpected DNS queries
   - No fallback to system DNS prevents bypass
   - Validates ALL resolved IPs (prevents mixed-IP attacks)

3. **Per-Redirect Validation**
   - Each redirect target is validated before following
   - Fresh DNS resolution and pinning for each new hostname
   - Maximum 5 redirects to prevent infinite loops

### Code Changes

#### Before (Vulnerable):
```typescript
export async function safePost(...) {
  const client = buildSafeAxios(timeoutMs); // ❌ Missing hostname & IPs
  
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl); // ✓ Validates but doesn't pin
    const response = await client.post(currentUrl, body, { headers });
    // ... redirect handling
  }
}
```

#### After (Secure):
```typescript
export async function safePost(...) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinnedIps = await assertSafeUrl(currentUrl); // ✓ Get validated IPs
    const hostname = new URL(currentUrl).hostname;
    
    // ✓ Fresh client with DNS pinned for THIS hostname
    const client = buildSafeAxios(timeoutMs, hostname, pinnedIps);
    const response = await client.post(currentUrl, body, { headers });
    // ... redirect handling
  }
}
```

## 🧪 Testing

### New Test Suite

Added comprehensive tests in `src/webhooks/ssrf-guard.test.ts`:

- ✅ IP blocking (loopback, private, metadata endpoints)
- ✅ DNS rebinding attack scenarios
- ✅ Redirect validation and blocking
- ✅ Mixed-IP attack prevention
- ✅ Protocol enforcement (HTTPS)
- ✅ DNS caching behavior
- ✅ Per-hop client creation

### Test Coverage

- **IP Blocking**: 10+ test cases
- **DNS Rebinding**: 6 test cases
- **Redirect Protection**: 7 test cases
- **Protocol Validation**: 4 test cases
- **Integration**: 2 end-to-end scenarios

### Running Tests

```bash
npm test src/webhooks/ssrf-guard.test.ts
```

## 📊 Security Impact

### Attack Scenarios Prevented

| Attack Type | Before | After |
|------------|--------|-------|
| DNS Rebinding to AWS Metadata | ❌ Vulnerable | ✅ Blocked |
| Redirect to Private IP | ❌ Vulnerable | ✅ Blocked |
| Multi-hop Redirect Obfuscation | ❌ Vulnerable | ✅ Blocked |
| Mixed-IP DNS Response | ❌ Vulnerable | ✅ Blocked |
| IPv6 Metadata Access | ❌ Vulnerable | ✅ Blocked |

### Defense Layers

1. **Pre-flight DNS validation** - Resolve and validate before connection
2. **DNS cache** - 5-second TTL prevents immediate rebinding
3. **DNS pinning** - Force connection to validated IP
4. **Per-redirect validation** - Each hop validated independently
5. **Strict hostname matching** - Block unexpected DNS lookups
6. **Comprehensive IP blocking** - All private/internal ranges blocked

## 📚 Documentation

### New Documentation

- **SSRF_DNS_REBINDING_FIX.md** - Comprehensive technical documentation
  - Vulnerability analysis
  - Fix architecture
  - Attack scenarios with examples
  - Testing guide
  - Deployment recommendations
  - Future enhancements

### Updated Code Documentation

- Enhanced inline comments explaining security measures
- Attack scenario examples in docstrings
- Security considerations for each function

## 🔍 Files Changed

```
src/webhooks/ssrf-guard.ts           | 85 +++++++----
src/webhooks/ssrf-guard.test.ts      | 565 +++++++++++++ (new)
SSRF_DNS_REBINDING_FIX.md           | 296 ++++++++++ (new)
```

### Summary:
- **Modified**: 1 file (core security logic)
- **Added**: 2 files (tests + documentation)
- **Total**: 946 insertions, 14 deletions

## 🚀 Deployment

### Breaking Changes
None - fully backward compatible

### Configuration Required
None - works with existing configuration

### Monitoring Recommendations

1. Monitor DNS cache hit rate
2. Alert on excessive redirects (>3)
3. Log blocked SSRF attempts
4. Track webhook delivery failures

### Performance Impact

- **DNS caching**: Minimal memory overhead
- **Per-redirect clients**: Negligible (redirects are rare)
- **DNS resolution**: Cached for repeat endpoints

## ✨ Benefits

1. **Security First**: Comprehensive SSRF protection
2. **Zero Configuration**: Works out of the box
3. **Performance Optimized**: Smart caching strategy
4. **Well Tested**: Extensive test coverage
5. **Well Documented**: Clear explanation of security measures
6. **Future Proof**: Follows OWASP best practices

## 🔗 References

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [DNS Rebinding Attacks](https://en.wikipedia.org/wiki/DNS_rebinding)
- [AWS IMDS Security](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html)

## 📝 Checklist

- [x] Code implements per-hop DNS pinning
- [x] All resolved IPs are validated (no mixed-IP bypass)
- [x] Redirect targets are validated before following
- [x] Comprehensive test suite added
- [x] Documentation created
- [x] No breaking changes
- [x] Backward compatible
- [x] Performance optimized
- [x] Security best practices followed

## 🎯 Reviewer Focus Areas

1. **Security Logic**: Review DNS pinning implementation in `safePost()`
2. **Edge Cases**: Check redirect handling and error conditions
3. **Test Coverage**: Verify all attack scenarios are tested
4. **Performance**: Confirm caching strategy is sound

---

**Ready for Review** ✅

This PR provides production-ready, comprehensive protection against DNS rebinding and redirect-based SSRF attacks. The fix is well-tested, documented, and follows security best practices.
