# API Key Rotation Guide

This document describes the self-service API key rotation functionality, which allows developers to securely rotate compromised or expired API keys without manual intervention.

## Overview

Key rotation is a critical security practice that:
- **Limits exposure window** when a key is compromised
- **Enforces key hygiene** with rotation policies
- **Maintains audit trails** for compliance
- **Preserves permissions** during rotation (no reconfig needed)

## Endpoints

### POST /developer/keys/rotate/self

Self-service key rotation endpoint. Validates the current key, revokes it, and issues a new key with all settings preserved.

**Authentication:** The current API key being rotated (sent in request body, not header)

**Request Body:**
```json
{
  "currentKey": "sk_...",
  "reason": "compromised"
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `currentKey` | string | ✅ Yes | The API key to rotate out |
| `reason` | enum | ❌ No | `"manual"`, `"compromised"`, `"rotation_policy"`, `"security_review"` (default: `"manual"`) |

**Success Response (201 Created):**
```json
{
  "id": "key_abc123",
  "name": "My API Key",
  "keyPrefix": "sk_abc12",
  "status": "active",
  "createdAt": "2026-07-29T06:45:00Z",
  "key": "sk_...",
  "message": "Key rotated successfully. Old key has been revoked. Store this new key securely."
}
```

**Error Responses:**

| Status | Scenario | Response |
|--------|----------|----------|
| 400 | Invalid request body | `{ "error": "Invalid request", "details": {...} }` |
| 401 | Key not found, revoked, or expired | `{ "error": "Invalid or revoked API key" }` |
| 429 | Rate limit exceeded (>5 rotations/hour) | `{ "error": "Rate limit exceeded", "message": "...", "retryAfterSeconds": 3600 }` |
| 500 | Rotation failed | `{ "error": "Key rotation failed", "message": "..." }` |

**Rate Limiting:**
- **Limit:** 5 rotations per developer per hour
- **Window:** 60 minutes
- **Response Header:** `Retry-After: {seconds}` on 429 responses

## Usage Examples

### cURL

**Rotate a key due to compromise:**
```bash
curl -X POST https://api.soroban.network/developer/keys/rotate/self \
  -H "Content-Type: application/json" \
  -d '{
    "currentKey": "sk_1234567890abcdef",
    "reason": "compromised"
  }'
```

**Rotate a key for routine maintenance:**
```bash
curl -X POST https://api.soroban.network/developer/keys/rotate/self \
  -H "Content-Type: application/json" \
  -d '{
    "currentKey": "sk_1234567890abcdef",
    "reason": "rotation_policy"
  }'
```

### JavaScript

```javascript
async function rotateApiKey(currentKey, reason = 'manual') {
  const response = await fetch('https://api.soroban.network/developer/keys/rotate/self', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentKey,
      reason,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    if (response.status === 429) {
      console.error(`Rate limited. Retry after ${error.retryAfterSeconds} seconds`);
    }
    throw new Error(error.error);
  }

  const result = await response.json();
  console.log('Old key revoked, new key issued:', result.key);
  return result;
}

// Usage
await rotateApiKey('sk_...', 'compromised');
```

### Python

```python
import requests
import json

def rotate_api_key(current_key, reason='manual'):
    response = requests.post(
        'https://api.soroban.network/developer/keys/rotate/self',
        json={
            'currentKey': current_key,
            'reason': reason,
        }
    )
    
    if response.status_code == 429:
        retry_after = response.json().get('retryAfterSeconds')
        raise Exception(f'Rate limited. Retry after {retry_after} seconds')
    
    response.raise_for_status()
    return response.json()

# Usage
new_key_data = rotate_api_key('sk_...', reason='compromised')
print(f"New key: {new_key_data['key']}")
```

## Audit Logging

Every key rotation attempt is logged in the `KeyRotationAudit` table with:

| Field | Description |
|-------|-------------|
| `id` | Unique audit entry ID |
| `developerId` | Developer who performed the rotation |
| `oldKeyId` | ID of the revoked key |
| `newKeyId` | ID of the newly created key |
| `reason` | Rotation reason (`"manual"`, `"compromised"`, etc.) |
| `ipAddress` | Client IP address |
| `userAgent` | HTTP User-Agent header |
| `wasSuccessful` | Whether the rotation succeeded |
| `errorMessage` | Error details if rotation failed |
| `metadata` | Additional context (rotation type, timestamp, etc.) |
| `rotatedAt` | Timestamp of the rotation attempt |

**Query rotation history:**
```sql
SELECT * FROM "KeyRotationAudit"
WHERE "developerId" = 'dev_123'
  AND "rotatedAt" > NOW() - INTERVAL '30 days'
ORDER BY "rotatedAt" DESC
LIMIT 50;
```

## What Gets Preserved

When a key is rotated, the following settings are preserved on the new key:

- ✅ **Key name** – Same name (no "rotated" suffix added)
- ✅ **Permissions** – Exact same permission set
- ✅ **IP whitelist** – Same allowed IPs/CIDR ranges
- ✅ **Domain whitelist** – Same allowed domains
- ✅ **Endpoint whitelist** – Same allowed endpoints
- ✅ **Rate limit tier** – Same tier (free, developer, pro, enterprise)
- ✅ **Custom rate limit override** – Same if configured

## What Changes

- 🔄 **API key value** – Completely new, random value (never exposed again)
- 🔄 **Key prefix** – Regenerated (used for logging/UI display)
- 🔄 **Created timestamp** – Set to rotation time
- 🔄 **Usage stats** – Reset to 0
- ❌ **Old key status** – Changed to `"revoked"`

## Security Considerations

### Immediate Effect
- Cache is invalidated immediately
- Old key is rejected on next API request
- No grace period (set `reason: "compromised"` for urgent rotations)

### Atomicity
- Rotation happens in a database transaction
- If any step fails, both old key revocation and new key creation are rolled back
- Ensures no orphaned or duplicate keys

### Audit Trail
- All rotation attempts are logged (success and failure)
- Includes IP address and user agent for forensics
- Accessible for compliance reports

### Rate Limiting
- Max 5 rotations per developer per hour
- Prevents abuse/spam rotation attacks
- Returns clear retry-after guidance

## Best Practices

### 1. Rotate Periodically
Establish a key rotation policy (e.g., every 90 days):
```bash
# Cron job: rotate keys every 90 days
0 0 1 */3 * /usr/local/bin/rotate-api-keys.sh
```

### 2. Rotate on Compromise
If a key is exposed:
```bash
curl -X POST https://api.soroban.network/developer/keys/rotate/self \
  -d '{"currentKey":"sk_...", "reason":"compromised"}'
```

### 3. Store New Key Immediately
The raw key is only shown once. Store it securely:
```bash
# ✅ Good: Save to secure vault
aws secretsmanager put-secret --name soroban/api-key --secret-string "sk_..."

# ❌ Avoid: Logging or pasting elsewhere
echo "sk_..." > ~/api-key.txt  # Don't do this!
```

### 4. Update Dependent Services
After rotation, update any services using the old key:
```bash
# Stop old clients
systemctl stop service-using-old-key

# Update config with new key
sed -i 's/old_key/new_key/g' /etc/myapp/config.env

# Restart
systemctl start service-using-old-key
```

### 5. Monitor Rotation Events
Query audit logs for unauthorized rotations:
```sql
SELECT * FROM "KeyRotationAudit"
WHERE "wasSuccessful" = false
  OR "ipAddress" NOT IN ('10.0.0.0/8', '172.16.0.0/12')
ORDER BY "rotatedAt" DESC;
```

## Integration Patterns

### Kubernetes Secret Rotation
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: rotate-api-keys
spec:
  schedule: "0 0 1 */3 * ?"  # Monthly
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: soroban-client
          containers:
          - name: rotator
            image: curlimages/curl
            command:
            - /bin/sh
            - -c
            - |
              CURRENT_KEY=$(kubectl get secret soroban-api-key -o jsonpath='{.data.key}' | base64 -d)
              NEW_KEY_RESPONSE=$(curl -s -X POST https://api.soroban.network/developer/keys/rotate/self \
                -d "{\"currentKey\":\"$CURRENT_KEY\", \"reason\":\"rotation_policy\"}")
              NEW_KEY=$(echo "$NEW_KEY_RESPONSE" | jq -r '.key')
              kubectl patch secret soroban-api-key -p "{\"data\": {\"key\": \"$(echo -n $NEW_KEY | base64)\"}}\"
```

### GitHub Actions
```yaml
name: Rotate API Key
on:
  schedule:
    - cron: '0 0 1 */3 *'  # Monthly

jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - name: Rotate API Key
        run: |
          NEW_KEY_RESPONSE=$(curl -s -X POST \
            https://api.soroban.network/developer/keys/rotate/self \
            -H "Content-Type: application/json" \
            -d "{
              \"currentKey\": \"${{ secrets.SOROBAN_API_KEY }}\",
              \"reason\": \"rotation_policy\"
            }")
          
          NEW_KEY=$(echo "$NEW_KEY_RESPONSE" | jq -r '.key')
          echo "::add-mask::$NEW_KEY"
          echo "SOROBAN_API_KEY=$NEW_KEY" >> $GITHUB_OUTPUT
          
      - name: Update Secret
        uses: actions/github-script@v6
        with:
          script: |
            const newKey = '${{ steps.rotate.outputs.SOROBAN_API_KEY }}';
            // Store in GitHub Actions secrets or vault
```

## Troubleshooting

### "Invalid or revoked API key"
- The key may already be revoked or expired
- Verify the key hasn't been manually deleted
- Check the key status: `GET /developer/keys?developerId=...`

### "Rate limit exceeded"
- You've rotated more than 5 times in the last hour
- Use the `retryAfterSeconds` value before trying again
- Consider using fewer rotations or spreading them out

### "Key rotation failed" (500 error)
- Database connection issue
- Contact support with the request ID (in logs)
- Check `/health` endpoint for service status

### Old key still working after rotation
- Cache invalidation can take up to 10 seconds
- Check that the new key is being used in your client
- Verify the old key's status is `"revoked"` in the API key list

## FAQ

**Q: How long until the old key is completely blocked?**  
A: Immediately. The revocation is synchronous; cache is invalidated within 10ms.

**Q: Can I rotate a key without the current key?**  
A: No. You must provide the current key for security. This prevents unauthorized rotations. If you've lost the key, use the `/developer/keys/:id/rotate` admin endpoint (requires dashboard login).

**Q: Is the old key recoverable?**  
A: No. Once revoked, the old key cannot be used or recovered. The raw key value is never stored in plain text.

**Q: What happens to my usage statistics?**  
A: Usage stats are reset on the new key. Historical stats for the old key are retained in `UsageRecord` table.

**Q: Can I rotate multiple keys at once?**  
A: No. Call the endpoint once per key. However, you can parallelize requests if your client supports concurrent requests.

**Q: Does rotation affect my rate limits?**  
A: No. Your tier and rate limit settings are preserved. The new key inherits the old key's tier.

## API Reference

See `/api/docs` (Swagger UI) for interactive documentation and live testing.

Quick links:
- `POST /developer/keys/rotate/self` – Self-service rotation (this guide)
- `POST /developer/keys/:id/rotate` – Admin rotation (requires auth)
- `GET /developer/keys` – List keys
- `DELETE /developer/keys/:id` – Revoke key
