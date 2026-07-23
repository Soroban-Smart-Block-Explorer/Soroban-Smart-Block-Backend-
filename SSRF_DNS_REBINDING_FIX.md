# DNS Rebinding and Redirect-Based SSRF Vulnerability Fix

## Executive Summary

This document describes a critical SSRF (Server-Side Request Forgery) vulnerability related to DNS rebinding attacks and redirect-based bypasses, and the comprehensive fix implemented in `src/webhooks/ssrf-guard.ts`.

## Vulnerability Overview

### 1. DNS Rebinding (Time-of-Check-Time-of-Use - TOCTOU)

**Attack Scenario:**
An attacker controls an authoritative DNS nameserver for a domain (e.g., `evil.com`). The attack exploits the time gap between DNS validation and HTTP connection:

```
T0 (Check Time):  Application validates evil.com → DNS returns 8.8.8.8 (public IP, passes validation)
T1 (Use Time):    Application connects to evil.com → DNS returns 169.254.169.254 (AWS metadata IP)
```

**Impact:**
- Access to AWS/GCP/Azure metadata endpoints (credentials, API keys)
- Access to internal services on private networks
- Data exfiltration from internal systems
- Potential for privilege escalation

**Root Cause:**
The original code performed DNS resolution during the validation check but didn't enforce the use of those validated IPs during the actual HTTP connection. The HTTP client performed its own DNS lookup, which could return a different (malicious) IP.

### 2. Redirect-Based SSRF Bypass

**Attack Scenario:**
An attacker serves a legitimate-looking URL that redirects to an internal resource:

```
Initial Request:  https://evil.com/webhook (public IP 8.8.8.8, passes validation)
HTTP Response:    302 Redirect to http://169.254.169.254/latest/meta-data/
```

**Impact:**
- Bypass of initial URL validation
- Access to internal services via redirect chain
- Multiple redirect hops can obfuscate the final destination

**Root Cause:**
The original code created a single HTTP client instance for all requests in the redirect chain, and while it validated each redirect URL, it didn't create fresh DNS-pinned clients for each new hostname in the chain.

## The Fix

### Architecture

The fix implements a defense-in-depth approach with multiple security layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                          safePost()                              │
│  Entry point for all outbound webhook HTTP requests             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Redirect Loop       │
              │  (max 5 hops)        │
              └──────────┬───────────┘
                         │
                         ▼
         ┌───────────────────────────────────┐
         │   Per-Hop Security Validation     │
         └───────────────┬───────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
┌─────────────────┐            ┌──────────────────────┐
│ assertSafeUrl() │            │ buildSafeAxios()     │
│                 │            │                      │
│ 1. Parse URL    │            │ 1. Create pinned     │
│ 2. Resolve DNS  │            │    DNS lookup        │
│ 3. Validate IPs │            │ 2. HTTP/HTTPS agents │
│ 4. Cache result │            │    with pinned DNS   │
└─────────────────┘            └──────────────────────┘
        │                                 │
        └────────────────┬────────────────┘
                         │
                         ▼
                 ┌───────────────┐
                 │  HTTP Request │
                 │  (pinned IP)  │
                 └───────────────┘
```

### Key Security Features

#### 1. DNS Pinning with Cache

```typescript
const dnsCache = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 5000; // 5 seconds
```

- **Cache validated IPs**: After DNS resolution and validation, IPs are cached for 5 seconds
- **Prevent rebinding window**: Short TTL balances security (prevent stale IPs) vs attack window
- **Per-hostname isolation**: Each hostname has its own cache entry

#### 2. Forced IP Connection

```typescript
function createPinnedLookup(hostname: string, pinnedIps: string[]): LookupFunction {
  return (lookupHostname, options, callback) => {
    if (lookupHostname !== hostname) {
      // Block unexpected DNS lookups
      const error = new Error(`Unexpected hostname lookup: ${lookupHostname}`);
      return callback(error, '', 0);
    }
    
    // Use pinned IP from validation
    const ip = pinnedIps[0];
    callback(null, ip, family);
  };
}
```

- **Custom DNS lookup function**: Overrides Node.js DNS resolution
- **Forces pinned IPs**: HTTP client MUST use the validated IP
- **Blocks unexpected lookups**: Any DNS request for other hostnames is rejected
- **No fallback**: No fallback to system DNS prevents bypass

#### 3. Per-Redirect Validation and Pinning

```typescript
export async function safePost(...) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 1. Validate and get pinned IPs for current URL
    const pinnedIps = await assertSafeUrl(currentUrl);
    
    // 2. Extract hostname for this specific hop
    const parsed = new URL(currentUrl);
    const hostname = parsed.hostname;
    
    // 3. Create FRESH client with DNS pinned to THIS hostname
    const client = buildSafeAxios(timeoutMs, hostname, pinnedIps);
    
    // 4. Make request with pinned client
    const response = await client.post(currentUrl, body, { headers });
    
    // 5. Check for redirect and validate new target
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      currentUrl = new URL(location, currentUrl).toString();
      continue; // Loop creates new client for next hop
    }
    
    return response;
  }
}
```

**Key points:**
- Each redirect creates a **new HTTP client** with DNS pinned to that specific hostname
- DNS validation is performed **before** each HTTP request
- No possibility for DNS rebinding between hops

#### 4. Comprehensive IP Blocking

```typescript
const BLOCKED_IPV4_RANGES: Ipv4Range[] = [
  makeRange('0.0.0.0/8'),       // unspecified
  makeRange('10.0.0.0/8'),      // private
  makeRange('127.0.0.0/8'),     // loopback
  makeRange('169.254.0.0/16'),  // link-local / AWS metadata
  makeRange('172.16.0.0/12'),   // private
  makeRange('192.168.0.0/16'),  // private
  // ... more ranges
];
```

**Blocked ranges:**
- Private networks (RFC 1918)
- Loopback addresses
- Link-local addresses (includes cloud metadata)
- IPv6 equivalent ranges
- Special-use addresses

#### 5. All-or-Nothing IP Validation

```typescript
// Validate ALL resolved IPs - if even one is blocked, reject the entire hostname
for (const ip of results) {
  if (isBlockedIp(ip)) {
    throw new SsrfBlockedError(`Hostname "${hostname}" resolves to blocked IP ${ip}`);
  }
}
```

**Prevents mixed-IP attacks:**
An attacker might configure DNS to return multiple A records:
```
evil.com. IN A 8.8.8.8         # Public (legitimate)
evil.com. IN A 10.0.0.1        # Private (malicious)
```

If we only checked the first IP, the connection might use the second one. Our fix validates **ALL** IPs.

## Attack Scenarios Prevented

### Scenario 1: Classic DNS Rebinding

**Attack:**
```bash
# Attacker's DNS server
evil.com A 8.8.8.8 (TTL: 0)     # First query returns public IP
evil.com A 169.254.169.254      # Second query returns metadata IP
```

**Before Fix:**
```typescript
// Validation: DNS lookup returns 8.8.8.8 ✓
await assertSafeUrl('https://evil.com');

// Connection: HTTP client does new DNS lookup, gets 169.254.169.254 ✗
await axios.post('https://evil.com/webhook', data);
```

**After Fix:**
```typescript
// Validation: DNS lookup returns 8.8.8.8 ✓
const pinnedIps = await assertSafeUrl('https://evil.com');

// Connection: HTTP client uses pinned 8.8.8.8, ignores new DNS ✓
const client = buildSafeAxios(timeout, 'evil.com', ['8.8.8.8']);
await client.post('https://evil.com/webhook', data);
```

### Scenario 2: Redirect to Metadata Endpoint

**Attack:**
```
1. POST https://evil.com/webhook → 302 to http://169.254.169.254/latest/meta-data/
2. Retrieve IAM credentials from metadata endpoint
```

**Before Fix:**
```typescript
// Initial URL validated ✓
// But redirect not re-validated ✗
```

**After Fix:**
```typescript
// Hop 0: Validate evil.com, pin DNS ✓
// Hop 1: Validate 169.254.169.254 → BLOCKED ✓
```

### Scenario 3: Multi-Hop Obfuscation

**Attack:**
```
1. https://evil1.com → 302 to https://evil2.com
2. https://evil2.com → 302 to http://internal.corp/admin
3. https://internal.corp/admin → 302 to http://10.0.0.5/secrets
```

**Before Fix:**
Might validate first hop only.

**After Fix:**
Validates and pins DNS for **each hop**, blocking at the first internal redirect.

### Scenario 4: Time-Extended DNS Rebinding

**Attack:**
```
# Attacker's strategy
T0: Return public IP (pass validation, cache expires in 5s)
T6: After cache expiry, validation happens again, attacker returns private IP
```

**Protection:**
Even if cache expires, the **pinned DNS lookup** in the HTTP agent prevents the client from using the new (malicious) IP. The connection would still use the originally validated IP.

## Testing

### Unit Tests

Comprehensive test suite in `src/webhooks/ssrf-guard.test.ts`:

- **IP Blocking Tests**: Verify all private/internal ranges blocked
- **DNS Rebinding Tests**: Simulate rebinding attacks
- **Redirect Tests**: Verify per-hop validation
- **Protocol Tests**: Ensure HTTPS enforcement
- **Cache Tests**: Verify DNS cache behavior
- **Integration Tests**: Full redirect chain scenarios

### Running Tests

```bash
npm test src/webhooks/ssrf-guard.test.ts
```

### Manual Testing

To manually test the protection:

```typescript
// Should succeed
await safePost('https://httpbin.org/post', '{}', {}, 5000);

// Should fail - private IP
await safePost('https://10.0.0.1/webhook', '{}', {}, 5000);

// Should fail - metadata endpoint
await safePost('http://169.254.169.254/latest/meta-data/', '{}', {}, 5000);
```

## Performance Considerations

### DNS Cache Impact

- **Cache TTL**: 5 seconds
- **Memory**: Minimal (hostname + IPs)
- **Cleanup**: Automatic every 10 seconds
- **Trade-off**: Security vs staleness (5s is safe for webhooks)

### Per-Redirect Client Creation

- **Overhead**: Creating new axios client per redirect
- **Mitigation**: 
  - Redirects are rare in webhook scenarios
  - Security benefit outweighs performance cost
  - Max 5 redirects prevents abuse

### DNS Resolution

- **Dual-stack**: Both IPv4 and IPv6 resolved
- **Parallel**: `Promise.allSettled` for concurrent resolution
- **Cached**: Most webhooks hit same endpoints repeatedly

## Security Best Practices

### Deployment Recommendations

1. **Monitor DNS cache hit rate**: High cache hit rate indicates normal behavior
2. **Alert on excessive redirects**: More than 2-3 redirects might indicate attack
3. **Log blocked requests**: Track SSRF attempts for threat intelligence
4. **Rate limit webhook destinations**: Prevent rapid probing of internal networks

### Configuration

```typescript
// In production, ensure HTTPS enforcement
process.env.NETWORK_PROFILE = 'mainnet';

// In dev/test, HTTP is allowed
process.env.NETWORK_PROFILE = 'devnet';
```

### Monitoring Queries

```sql
-- Track SSRF blocks
SELECT COUNT(*) 
FROM logs 
WHERE message LIKE '%SSRF blocked%' 
  AND timestamp > NOW() - INTERVAL '1 hour';

-- Identify frequent attackers
SELECT webhook_url, COUNT(*) as attempts
FROM webhook_deliveries
WHERE status = 'failed'
  AND error_message LIKE '%SSRF%'
GROUP BY webhook_url
ORDER BY attempts DESC;
```

## Future Enhancements

1. **DNS-over-HTTPS (DoH)**: Use DoH to prevent DNS spoofing at network level
2. **DNSSEC Validation**: Verify DNS responses are signed and authentic
3. **Configurable Allowlist**: Allow specific internal IPs for testing
4. **Metrics Dashboard**: Real-time SSRF attempt tracking
5. **Dynamic IP Range Updates**: Fetch latest cloud provider IP ranges

## References

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [DNS Rebinding Attacks](https://en.wikipedia.org/wiki/DNS_rebinding)
- [AWS IMDS (Instance Metadata Service)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html)
- [RFC 1918: Private Address Space](https://datatracker.ietf.org/doc/html/rfc1918)

## Conclusion

This fix provides comprehensive protection against DNS rebinding and redirect-based SSRF attacks through:

1. ✅ **DNS Pinning**: Force HTTP client to use validated IPs
2. ✅ **Per-Hop Validation**: Re-check every redirect target
3. ✅ **Per-Hop Pinning**: Fresh DNS-pinned client per redirect
4. ✅ **Comprehensive Blocking**: All private/internal IP ranges
5. ✅ **Cache Protection**: Short-lived cache prevents rebinding window
6. ✅ **All-IP Validation**: No mixed-IP bypass possible

The implementation follows defense-in-depth principles with multiple security layers, ensuring even if one layer fails, others provide protection.
