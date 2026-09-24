# Webhook subscriptions

Self-service management of on-chain contract-event deliveries. All endpoints
require an API key (`X-Api-Key`) and are scoped to the key that owns the
subscription.

Base path: `/webhooks`

## Endpoints

| Method | Path                       | Purpose                                                     |
| ------ | -------------------------- | ----------------------------------------------------------- |
| POST   | `/webhooks`                | Create a subscription (returns the signing secret **once**) |
| GET    | `/webhooks`                | List subscriptions (secrets omitted)                        |
| PATCH  | `/webhooks/:id`            | Update URL, filters, or active state                        |
| DELETE | `/webhooks/:id`            | Delete a subscription                                       |
| POST   | `/webhooks/:id/verify`     | Challenge/response URL verification                         |
| POST   | `/webhooks/:id/ping`       | Send a synthetic test event                                 |
| GET    | `/webhooks/:id/preview`    | Preview the exact body + signing headers                    |
| GET    | `/webhooks/:id/deliveries` | Recent delivery attempts (last 50)                          |
| GET    | `/webhooks/sdk`            | Integration guide + verification snippets                   |

### Create

```bash
curl -X POST https://api.example.com/webhooks \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","eventType":"transfer"}'
```

The response includes `secret`. It is shown **only once** — store it in your
secret manager. If omitted, the server generates a 256-bit secret.

New subscriptions start `verified: false`.

### Update

```bash
curl -X PATCH https://api.example.com/webhooks/$SUB_ID \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"mint","active":true}'
```

`url`, `contractAddress`, `eventType`, and `topicSymbol` may be updated; pass
`null` to clear a filter. Changing the `url` resets verification — run the
handshake again. Deactivating (`active: false`) immediately cancels pending
deliveries.

## Verification handshake (challenge/response)

Prove you own the destination URL before relying on deliveries:

1. `POST /webhooks/:id/verify`.
2. The server sends a signed request to your URL:

   ```json
   {
     "type": "webhook.verification",
     "subscriptionId": "019...",
     "challenge": "<random hex>",
     "timestamp": "2026-09-24T00:00:00.000Z"
   }
   ```

   It carries the same `X-Webhook-Signature` and `X-Webhook-Timestamp` headers
   as a normal delivery.

3. Respond with HTTP 2xx and echo the challenge back:

   ```json
   { "challenge": "<the value you received>" }
   ```

   A plain-text response equal to the challenge is also accepted. Challenges
   expire after 15 minutes.

4. On success the subscription is marked `verified` and `GET /webhooks` reports
   `verified: true` / `verifiedAt`.

Only the SHA-256 digest of the in-flight challenge is stored server-side, so a
database leak cannot be used to forge a response. Comparison is constant-time.

## Test send (ping)

```bash
curl -X POST https://api.example.com/webhooks/$SUB_ID/ping \
  -H "X-Api-Key: $SOROBAN_API_KEY"
```

Sends one signed synthetic event and records it as a delivery. **No retry is
scheduled** — a ping is a one-shot connectivity/signature test. The response
reports `success`, `httpStatus`, `durationMs`, and `deliveryId`. Requests to
SSRF-blocked URLs return `400`.

## Payload preview

```bash
curl https://api.example.com/webhooks/$SUB_ID/preview \
  -H "X-Api-Key: $SOROBAN_API_KEY"
```

Returns the sample `event`, the exact `rawBody`, and the `X-Webhook-Signature` /
`X-Webhook-Timestamp` headers — with a real signature over the sample body — so
you can unit-test your receiver before receiving live traffic.

## Delivery envelope

```json
{
  "event": {
    "id": "string",
    "contractAddress": "string",
    "eventType": "string",
    "topicSymbol": "string | null",
    "decoded": {},
    "ledgerSequence": 0,
    "ledgerCloseTime": "ISO-8601 string",
    "transactionHash": "string"
  },
  "attempt": 1
}
```

Headers:

- `X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the raw body>`
- `X-Webhook-Timestamp: <unix epoch ms>`

## Verifying signatures

Sign the **raw request body bytes** (before JSON parsing) with HMAC-SHA256 using
your signing secret, then compare in constant time against the
`X-Webhook-Signature` value. Reject requests whose `X-Webhook-Timestamp` is
outside the tolerance window and cache accepted signatures for that window to
reject replays.

TypeScript:

```ts
import crypto from 'crypto';

export function verifyWebhook(
  rawBody: Buffer,
  secret: string,
  signature: string,
  timestamp: string,
  toleranceMs = 5 * 60 * 1000,
) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs) {
    throw new Error('Timestamp outside tolerance window');
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid signature');
  }
}
```

Python and Go snippets, plus the full envelope reference, are served live from
`GET /webhooks/sdk` so they stay in sync with the retry policy and tolerance
window configured on the server.

## Retries

Failed deliveries are retried with exponential backoff (`10s, 30s, 90s, 270s`
up to 5 attempts). `RETRY` stops for inactive subscriptions and for URLs blocked
by the SSRF guard. Inspect results via `GET /webhooks/:id/deliveries`.
