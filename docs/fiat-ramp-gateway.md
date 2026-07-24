# Fiat On/Off-Ramp Gateway — Design Doc

## Overview

This document covers the architecture, provider evaluation, regulatory analysis, and design
decisions for the multi-provider fiat on/off-ramp gateway built into the Soroban Block Explorer.

---

## Architecture

```
                           ┌─────────────────────────────┐
                           │      Client (Browser)        │
                           │  On-ramp / Off-ramp widget   │
                           └────────────┬────────────────┘
                                        │ HTTPS (JWT auth)
                           ┌────────────▼────────────────┐
                           │   POST /api/v1/ramp/quote    │
                           │   POST /api/v1/ramp/execute  │
                           │   GET  /api/v1/ramp/orders/  │
                           │   POST /api/v1/ramp/refund   │
                           │   GET  /api/v1/ramp/providers│
                           │   POST /api/v1/ramp/kyc/…    │
                           └────────────┬────────────────┘
                                        │
             ┌──────────────────────────▼──────────────────────────┐
             │              Multi-Provider Gateway                   │
             │  aggregateQuotes() → sorted by effectiveRate         │
             │  selectBestProvider() → routing decision             │
             │  executeOrder() → provider-specific HTTP call        │
             └──────┬──────────┬──────────┬──────────┬─────────────┘
                    │          │          │          │
             MoonPay     Transak     Ramp Net.   Banxa    Stripe
             Adapter     Adapter     Adapter     Adapter  Adapter
```

### Components

| Component | File | Responsibility |
|---|---|---|
| API Router | `src/api/ramp.ts` | HTTP route definitions, auth gates, request validation |
| Provider Gateway | `src/services/ramp/gateway.ts` | Parallel quote aggregation, smart routing, provider delegation |
| KYC Service | `src/services/ramp/kyc.ts` | Tiered KYC state, jurisdiction enforcement, limit tracking |
| Order Management | `src/services/ramp/order-management.ts` | Order lifecycle FSM, immutable audit log |
| AML Monitor | `src/services/ramp/aml.ts` | Async pattern detection, flag creation |
| Reconciliation | `src/services/ramp/reconciliation.ts` | Daily provider state sync, auto-heal, error rate |
| Provider Adapters | `src/services/ramp/providers/` | Per-provider HTTP clients behind unified interface |
| Types | `src/services/ramp/types.ts` | Shared TypeScript interfaces |

---

## Provider Evaluation

### MoonPay
- **Geographic coverage**: 160+ countries, 40+ fiat currencies
- **Payment methods**: Card, SEPA, ACH, Apple Pay, Google Pay, Open Banking
- **Stellar support**: XLM, USDC native
- **Buy + sell**: Yes
- **KYC**: Built-in inline widget; provider-side customer ID stored in `providerKycIds`
- **Fees**: 4.5% card / 1.5% bank transfer (approximate)
- **Strengths**: Best global coverage, battle-tested API, strong Stellar/USDC support
- **Weaknesses**: Higher card fees vs. Transak

### Transak
- **Geographic coverage**: 160+ countries
- **Payment methods**: Card, SEPA, ACH, Open Banking, Apple Pay, Google Pay
- **Stellar support**: XLM, USDC
- **Buy + sell**: Yes (buy primary, sell via off-ramp module)
- **KYC**: In-widget KYC with liveness check; session-based
- **Fees**: 0.99%–5.5% depending on method and geography
- **Strengths**: Competitive fees, strong developer tooling, extensive PM coverage
- **Weaknesses**: Sell flow less mature than MoonPay

### Ramp Network
- **Geographic coverage**: 150+ countries
- **Payment methods**: Card, Open Banking, SEPA
- **Stellar support**: XLM, USDC via hosted widget
- **Buy + sell**: Buy only (on-ramp focused)
- **KYC**: Provider-managed; no separate integration needed
- **Fees**: 0.9%–2.9%
- **Strengths**: Lowest fee structure; good UX; strong UK/EU presence
- **Weaknesses**: No sell/off-ramp; US coverage limited

### Banxa
- **Geographic coverage**: 100+ countries
- **Payment methods**: Card, bank transfer, POLi, OSKO
- **Stellar support**: XLM, USDC
- **Buy + sell**: Yes
- **KYC**: HMAC-signed API with server-side order creation
- **Fees**: 2%–3.5%
- **Strengths**: Strong APAC coverage (AU, NZ, SG); reliable off-ramp; institutional grade
- **Weaknesses**: API less developer-friendly; smaller European footprint

### Stripe Crypto On-ramp
- **Geographic coverage**: US only (expanding)
- **Payment methods**: Card, Apple Pay, Google Pay
- **Stellar support**: USDC, XLM (via hosted session)
- **Buy + sell**: Buy only
- **KYC**: Stripe-managed; uses existing Stripe customer identity
- **Fees**: 1.5% card / network fee pass-through
- **Strengths**: Lowest US card fees; seamless integration if Stripe billing is already used; fastest completion (< 2 min)
- **Weaknesses**: US only; buy only; limited asset support

### Provider Selection Summary

| Provider | Global | Buy | Sell | Stellar | Fees |
|---|---|---|---|---|---|
| MoonPay | ✅ | ✅ | ✅ | ✅ | Medium |
| Transak | ✅ | ✅ | ✅ | ✅ | Low-Med |
| Ramp Network | ✅ | ✅ | ❌ | ✅ | Low |
| Banxa | ✅ (APAC+) | ✅ | ✅ | ✅ | Medium |
| Stripe | 🇺🇸 US only | ✅ | ❌ | ✅ | Low |

---

## Smart Order Routing

Routing decisions are weighted across four factors:

1. **Effective exchange rate** (60%): `totalCostUsd / cryptoAmount` — lowest wins for buy
2. **Provider availability gate**: jurisdiction + payment method must be supported
3. **Completion speed** (20%): estimated minutes to crypto delivery
4. **Reliability** (20%): future — degraded provider health signals reduce score

For large orders (> $100k) the RFQ mechanism returns available providers; the user selects
explicitly. Split execution across providers is reserved for a follow-up.

---

## KYC Architecture

```
User KYC Record (ramp_kyc_records)
  ├── tier: tier1 | tier2 | tier3
  ├── status: pending | submitted | approved | rejected | expired
  ├── providerKycIds: { moonpay: "mp_cust_abc", transak: "trn_xyz" }
  ├── dailyUsedUsd, monthlyUsedUsd  ← rolling counters
  └── verifiedAt, expiresAt (1 year)
```

**Tier gates:**

| Tier | Daily Limit | Monthly Limit | Requirements |
|---|---|---|---|
| Tier 1 | $1,000 | $10,000 | Email + phone only |
| Tier 2 | $10,000 | $100,000 | Government ID + liveness check |
| Tier 3 | $500,000 | $5,000,000 | Full KYC + source of funds declaration |

**Cross-provider KYC reuse**: Once approved via one provider, `providerKycIds` stores the
provider-side customer ID. When the user transacts via a different provider, the existing
verified tier is reused — no re-verification required (with user consent captured at session).

---

## AML Monitoring

Five automated checks run async after every order creation:

| Flag Type | Trigger | Severity |
|---|---|---|
| `structuring` | Multiple sub-$1k orders summing > $3k/24h | High |
| `rapid_in_out` | Sell within 10 min of a buy | Medium |
| `high_risk_jurisdiction` | Transaction from FATF-monitored country | Medium |
| `large_single` | Single transaction > $50k | High / Critical |
| `velocity` | > 5 orders in 1 hour | Medium |

Flags are written to `ramp_aml_flags` and resolved manually by compliance staff. Unresolved
critical flags trigger account block via `blockKyc()`.

---

## Regulatory Compliance

### Jurisdiction Enforcement
FATF grey/black-listed and OFAC-sanctioned countries are blocked at the KYC gate before any
order is created. Current blocked list: `IR, KP, SY, CU, SD, MM, RU, BY, VE, AF, YE, LY, SO, SS, ZW`.

### Daily/Monthly Limits
Enforced per-user per-tier by `checkKycAllowance()`. Counters reset daily (rolling window
tracked via `usageResetAt`).

### Travel Rule Compliance
Transfers > $3,000 trigger a `large_single` AML flag. Originator/beneficiary info is already
present in the `RampOrder` record (`userId` → `RampKycRecord` contains verified identity data).
The `TravelRuleRecord` model (existing in the schema) can be linked for VASP-to-VASP reporting.

### Regulatory Reporting
The existing `ComplianceReport` model supports FinCEN / FCA / BaFin / MAS report generation.
Ramp order data is queryable via `prismaRead.rampOrder` with date range filters.

---

## Reconciliation

Daily reconciliation runs per-provider via `runDailyReconciliation()`. The process:

1. Fetches all platform orders for the provider on the prior calendar day
2. Polls each order's status from the provider API
3. Detects divergences (platform state ≠ provider state)
4. Auto-heals: advances `processing → completed` or `pending → failed` when provider confirms
5. Writes `RampReconciliation` record with error rate

Target: < 0.1% error rate per provider per day.

---

## Database Schema

Five new tables added via migration `20260716000000_fiat_ramp_gateway`:

- `ramp_kyc_records` — one per user; tracks tier, status, usage counters
- `ramp_orders` — full order lifecycle; status FSM
- `ramp_order_events` — immutable audit log of every state transition
- `ramp_reconciliations` — daily provider reconciliation results
- `ramp_aml_flags` — AML monitoring alerts

---

## Security Notes

- `providerKycIds` is never returned in API responses (stripped in `POST /kyc/status`)
- Provider webhook signatures verified via `crypto.timingSafeEqual` (constant-time comparison)
- All state transitions are gated via `ALLOWED_TRANSITIONS` map (no direct status writes)
- `userIp` stored on orders but never logged at info level
- Platform fee percentage is configurable via `RAMP_PLATFORM_FEE_PCT` env var
- All provider API keys sourced from environment variables — never hardcoded

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/ramp/quote` | JWT | Get quotes from all providers |
| POST | `/api/v1/ramp/execute` | JWT | Execute order with chosen provider |
| GET | `/api/v1/ramp/orders` | JWT | List caller's orders |
| GET | `/api/v1/ramp/orders/:id` | JWT | Get single order with audit log |
| POST | `/api/v1/ramp/refund` | JWT | Initiate refund |
| GET | `/api/v1/ramp/providers` | JWT | List provider availability |
| POST | `/api/v1/ramp/kyc/status` | JWT | Get/create KYC record |
| POST | `/api/v1/ramp/webhook/:provider` | HMAC | Receive provider callbacks |
