# Soroban Explorer Mobile SDK — Architecture Design Document

## 1. Overview

The Soroban Explorer Mobile SDK is a cross-platform TypeScript SDK targeting React Native, Flutter (via FFI), and web (PWA). It provides a unified interface for querying the Soroban blockchain explorer, subscribing to real-time events, managing authentication, receiving push notifications, and operating offline.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                      │
│  (React Native / Flutter / Web PWA)                       │
├─────────────────────────────────────────────────────────┤
│                    SorobanExplorer SDK                     │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ Client   │ Feed     │ Auth     │ Push     │ Offline       │
│ (REST/   │ (WS/SSE) │ (Bio/    │ (FCM/    │ (SQLite/      │
│  GraphQL)│          │  Key)    │  APNs)   │  CRDT)        │
├──────────┴──────────┴──────────┴──────────┴──────────────┤
│                    Transport Layer                          │
│         (HTTP/2, WebSocket, SSE, Background Sync)          │
├────────────────────────────────────────────────────────────┤
│                    Soroban Explorer API                     │
└────────────────────────────────────────────────────────────┘
```

## 3. Offline Sync Architecture

### 3.1 Local Database

- **Engine**: SQLite via `react-native-quick-sqlite` (RN) or `sql.js` (web)
- **WAL mode**: Enabled for concurrent read/write
- **Storage limit**: 100MB with LRU eviction policy
- **Tables**: Mirrors API entities (transactions, contracts, wallets, events, tokens, prices) with `lastSyncedAt` and `syncStatus` columns

### 3.2 Sync Strategy

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│  Local    │────▶│  Sync Engine  │────▶│  Server   │
│  SQLite   │     │  (CRDT-based) │     │  API      │
└──────────┘     └──────────────┘     └──────────┘
```

- **Initial sync**: Full fetch of user's watched wallets, contracts, and recent activity
- **Incremental sync**: Periodic polling (configurable interval, adaptive to battery)
- **CRDT conflict resolution**: Each record carries a Lamport timestamp + replica ID. Last-writer-wins (LWW) for scalar fields, observed-remove set (OR-Set) for collections.
- **Background sync**: Uses iOS BGTaskScheduler / Android WorkManager with battery-aware scheduling

### 2.1 Offline Queue

```
┌──────────┐    ┌──────────────┐    ┌──────────┐
│  User     │───▶│  Offline      │───▶│  Sync     │
│  Action   │    │  Queue (SQL)  │    │  Engine   │
└──────────┘    └──────────────┘    └──────────┘
                      │                    │
                      ▼                    ▼
               ┌──────────────┐    ┌──────────┐
               │  LRU Cache    │    │  Server   │
               │  (100MB max)  │    │  API      │
               └──────────────┘    └──────────┘
```

### 2.1 Offline Sync

- **Local DB**: SQLite with WAL mode for concurrent reads/writes
- **CRDT**: Each entity has a Lamport timestamp + replica UUID. Last-writer-wins (LWW) for scalars, observed-remove set (OR-Set) for collections
- **Sync flow**: On connectivity, the sync engine pulls delta from server (since `lastSyncTimestamp`), merges via CRDT rules, pushes local mutations
- **Storage limit**: 100MB with LRU eviction (oldest `lastAccessed` records removed first)
- **Battery-aware scheduling**: Uses platform APIs (BGTaskScheduler on iOS, WorkManager on Android) with adaptive intervals based on battery level

### 2.2 Conflict Resolution (CRDT)

Each entity has:
- `id`: stable identifier
- `lamport`: monotonic logical clock (server-assigned)
- `replicaId`: UUID of the writing replica
- `deleted`: tombstone flag

Merge rules:
- **LWW for scalars**: Higher `lamport` wins; if equal, higher `replicaId` wins
- **OR-Set for collections**: Add wins over remove; concurrent adds are unioned
- **Tombstones**: Deleted records are preserved for 30 days before compaction

## 3. Push Notification Infrastructure

### 3.1 Server-Side Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Event Stream  │───▶│  Subscription  │───▶│  Notification  │
│  (Kafka/Rabbit)│    │  Matcher      │    │  Router        │
└──────────────┘    └──────────────┘    └──────────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
             ┌──────────┐             ┌──────────┐             ┌──────────┐
             │  FCM      │             │  APNs     │             │  Web Push │
             │  Gateway  │             │  Gateway  │             │  Gateway  │
             └──────────┘             └──────────┘             └──────────┘
```

### 3.1 Subscription Types

| Type | Trigger | Example |
|------|---------|---------|
| `price_alert` | Price crosses threshold | XLM > $0.50 |
| `wallet_activity` | Transaction from watched wallet | GA... sends tx |
| `contract_event` | Contract emits specific event | Swap event |
| `governance_milestone` | Proposal passes/executes | Proposal #42 passed |
| `compliance_event` | Freeze/sanctions match | Address frozen |
| `gas_price_spike` | Fee > threshold | Base fee > 1000 stroops |
| `system_announcement` | Platform broadcast | Maintenance window |

### 3.2 Delivery Chain

1. Primary: FCM (Android) / APNs (iOS) / Web Push (PWA)
2. Fallback: WebSocket (if app is foregrounded)
3. Final fallback: Polling (configurable interval)

### 3.3 Notification Grouping

Notifications with the same `groupKey` are coalesced:
- `wallet_tx_{address}` — "3 transactions from GA...XYZ"
- `price_alert_{pair}` — "XLM up 5% in last hour"
- `contract_event_{address}` — "2 events from contract C..."

### 3.4 Quiet Hours

- Per-user configurable start/end time + timezone
- Emergency override for: compliance events, critical security alerts
- During quiet hours, notifications are queued and delivered as a digest

## 4. Security Model

### 4.1 Authentication

- **Biometric auth**: FaceID/TouchID (iOS), BiometricPrompt (Android)
- **Hardware-backed keys**: Keys stored in Secure Enclave (iOS) / TEE (Android) via `expo-secure-store` or `react-native-keychain`
- **Session tokens**: Short-lived JWT (15 min) + refresh token (7 days) stored in secure storage
- **App lock**: Auto-lock on background, configurable timeout (30s–5min)

### 4.2 Key Management

- Private keys NEVER leave the secure enclave
- API tokens stored in encrypted keychain
- Biometric authentication gates all key operations
- Remote wipe capability via server-issued revocation

## 5. Performance Budget

| Metric | Target |
|--------|--------|
| SDK init time | < 100ms (mid-range Android) |
| Battery drain | < 5% / day (iPhone 12) |
| Offline storage | ≤ 100MB (LRU eviction) |
| Push delivery | < 5s p99 latency |
| PWA Lighthouse | ≥ 95 score |
| Network batch | ≤ 50KB per request |

## 6. PWA Strategy

- **Service worker**: Cache-first for static assets, network-first for API, stale-while-revalidate for feed
- **Offline pages**: Cached landing page, cached recent searches, "you are offline" banner
- **Background sync**: `sync` event queues failed API calls, retries with exponential backoff
- **Push notifications**: Web Push API with VAPID keys
- **Install prompt**: Custom "Add to Home Screen" with splash screen

## 7. Data Flow

```
User Action → SDK Client → [Offline Queue] → [Network Request]
                                                    │
                                          ┌─────────▼─────────┐
                                          │  Response Cached    │
                                          │  in Local SQLite    │
                                          └────────────────────┘
                                                    │
                                          ┌─────────▼─────────┐
                                          │  UI Update          │
                                          └────────────────────┘
```

## 8. Directory Structure

```
src/sdk/mobile/
├── DESIGN.md
├── index.ts                    # Barrel exports
├── SorobanExplorerClient.ts    # REST/GraphQL client
├── SorobanExplorerFeed.ts      # WebSocket/SSE client
├── SorobanExplorerAuth.ts      # Biometric auth + key storage
├── SorobanExplorerPush.ts      # Push notification client
├── SorobanExplorerOffline.ts   # Offline-first data layer
├── types.ts                    # Shared types
└── __tests__/                  # Unit tests
