# Soroban Smart Block Explorer — Backend

Human-readable Soroban contract explorer. Decodes raw XDR into plain English:
> "Address GABC... swapped 100 USDC → 98.7 XLM on StellarSwap at ledger 4521983."

## Overview

The Soroban Smart Block Explorer backend is a production-grade indexer and API server that:
- **Decodes Soroban transactions** from raw XDR into human-readable English
- **Indexes contract events** from the Stellar ledger in real-time
- **Provides REST APIs** for querying transactions, events, contracts, and tokens
- **Manages contract ABIs** with a registry system for better understanding
- **Analyzes MEV, privacy, and composability** patterns in Soroban contracts
- **Streams data** to a data lake (Iceberg/Parquet) for analytics and BI

**Live at**: https://explorer.sorobansmart.com  
**API Docs**: http://localhost:3000/api/docs (Swagger UI)  
**Analytics**: See [DATA_MESH_PLATFORM.md](./DATA_MESH_PLATFORM.md) for the data architecture

## Stack
- **Node.js + Express + TypeScript** — REST API framework
- **PostgreSQL + Prisma ORM** — Indexed transaction/event storage
- **Stellar SDK** — Soroban RPC client + XDR decoding
- **Docker Compose** — Local development environment
- **Apache Iceberg + Parquet** — Analytics data lake
- **Kafka + Debezium** — CDC pipeline for analytics
- **Redis** — Caching and rate limiting

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     SOROBAN SMART BLOCK EXPLORER               │
└─────────────────────────────────────────────────────────────────┘

┌─ API TIER (REST) ───────────────────────────────────────────────┐
│  GET /api/v1/transactions      List transactions (paginated)    │
│  GET /api/v1/transactions/:hash Detail + decoded events         │
│  GET /api/v1/events            List events with filtering       │
│  GET /api/v1/contracts         Contract registry + metadata     │
│  GET /api/v1/wallets/:addr     Account transaction history      │
│  GET /api/v1/tokens            Token summary and balances       │
│  POST /api/v1/contracts        Register contract ABI metadata   │
│  GET /api/docs                 Swagger UI (interactive docs)    │
└─────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ APPLICATION TIER ──────────────────────────────────────────────┐
│  src/api/                      Route handlers (Express)          │
│  src/middleware/               Auth, rate limiting, validation   │
│  src/services/                 Business logic                    │
│  src/cache.ts                  Redis caching layer              │
│  src/db.ts                     Prisma ORM + connection pooling  │
└─────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ INDEXER TIER ──────────────────────────────────────────────────┐
│  src/indexer/indexer.ts        Ledger polling loop              │
│  src/indexer/decoder.ts        XDR → human-readable             │
│  src/indexer/registry.ts       ABI registry + SEP-41 built-ins  │
│  src/indexer/rpc.ts            Stellar RPC client (retry logic) │
│  src/indexer/sep41-parser.ts   Token transfer detection         │
└─────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ STORAGE TIER ──────────────────────────────────────────────────┐
│  PostgreSQL                    Transactions, events, contracts   │
│  Redis                         Caching, rate limits, sessions   │
│  S3 (optional)                 Parquet/Iceberg data lake        │
└─────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ EXTERNAL CONNECTIONS ──────────────────────────────────────────┐
│  Stellar RPC                   getEvents, getTransaction         │
│  Stellar Horizon               account balances, ledger history  │
└─────────────────────────────────────────────────────────────────┘

Directory Structure:

src/
├── index.ts                    # Express app entry, middleware setup
├── config.ts                   # Configuration from env vars
├── db.ts                       # Prisma client (read/write instances)
│
├── api/                        # Route handlers (144 files)
│   ├── router.ts               # Main route aggregator
│   ├── transactions.ts         # GET /transactions (paginated, filters)
│   ├── events.ts               # GET /events (type-specific)
│   ├── contracts.ts            # GET/POST /contracts (registry)
│   ├── wallets.ts              # GET /wallets/:address (history)
│   ├── tokens.ts               # GET /tokens (SEP-41 summary)
│   ├── dex.ts                  # GET /dex/analyze (swap detection)
│   ├── mev.ts                  # MEV detection and analysis
│   ├── sandbox.ts              # Deterministic contract simulator
│   ├── privacy.ts              # Privacy protocol analysis
│   └── [140+ more endpoints]
│
├── indexer/                    # Ledger indexing & decoding
│   ├── indexer.ts              # Main polling loop + state machine
│   ├── decoder.ts              # XDR → human-readable logic
│   ├── registry.ts             # Contract ABI registry + resolution
│   ├── rpc.ts                  # Stellar RPC client (rate limits)
│   ├── sep41-parser.ts         # Token event parsing
│   ├── xdr-parser.ts           # Low-level XDR decoding
│   ├── token-metadata.ts       # Token symbol/decimal resolution
│   └── [15+ more modules]
│
├── middleware/                 # Express middleware
│   ├── asyncHandler.ts         # Try-catch wrapper for async handlers
│   ├── errorHandler.ts         # Global error handler
│   ├── rateLimit.ts            # Tiered rate limiting (Redis)
│   ├── apiKeyAuth.ts           # X-API-Key validation
│   ├── sanitize.ts             # Input validation/sanitization
│   └── [10+ more middleware]
│
├── services/                   # Business logic
│   ├── stripe-billing.ts       # SaaS billing integration
│   ├── pricing.ts              # Token price updates
│   └── [8+ more services]
│
├── cache.ts                    # Redis client + cache helpers
├── logger.ts                   # Structured logging
├── health.ts                   # Health check responses
└── [25+ more files]

prisma/
├── schema.prisma               # PostgreSQL schema (migrations)
├── migrations/                 # Prisma migration history
└── seed.ts                     # Database seeding (known contracts)
```

## Getting Started

### With Docker (Recommended)

Fastest way to get the full stack running locally:

```bash
# Clone repository
git clone <repo-url>
cd Soroban-Smart-Block-Backend-

# Copy environment template
cp .env.example .env

# Start all services (API, PostgreSQL, Redis, Indexer)
docker compose up
```

The system will be available at:
- **API**: http://localhost:3000/api/v1
- **Swagger UI**: http://localhost:3000/api/docs
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379

### Local Development

For development without Docker:

```bash
# Prerequisites
# - Node.js 18+
# - PostgreSQL 14+
# - Redis 6+

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your local settings

# Initialize database
npx prisma migrate dev

# Seed known contracts (StellarSwap, etc.)
npm run seed

# In terminal 1: Start API server
npm run dev

# In terminal 2: Start indexer
npm run index

# Optional: Start indexer in watch mode
npm run index:watch
```

Access the API at http://localhost:3000/api/v1

### Docker Development

For development with Docker containers but local code:

```bash
# Start services only (no app)
docker compose up postgres redis

# In your editor: npm run dev
# Services connect via localhost:5432 (postgres) and localhost:6379 (redis)
```

### Analytics Stack

To include the full data lake setup with Kafka, Debezium, and Trino:

```bash
docker compose --profile analytics up
```

Additional services:
- **Trino**: http://localhost:8080 (SQL over Iceberg)
- **Kafka UI**: http://localhost:8090 (Message broker monitoring)
- **Debezium**: http://localhost:8083 (CDC pipeline control)

### Verify Installation

```bash
# Check API is responsive
curl http://localhost:3000/api/v1/health

# List all available transactions
curl http://localhost:3000/api/v1/transactions?limit=5

# Access interactive API docs
open http://localhost:3000/api/docs
```

## API Documentation

### Quick Reference

Full interactive API documentation is available at:
- **Development**: http://localhost:3000/api/docs (Swagger UI)
- **Production**: https://explorer.sorobansmart.com/api/docs
- **Raw spec**: http://localhost:3000/api/docs.json (OpenAPI 3.0)

### Core Endpoints

| Endpoint | Purpose | Example |
|----------|---------|---------|
| `GET /api/v1/transactions` | List all transactions | `?limit=20&page=1` |
| `GET /api/v1/transactions/:hash` | Get transaction details | Show events & decoding |
| `GET /api/v1/events` | List contract events | `?contract=CXXX&type=transfer` |
| `GET /api/v1/contracts` | List registered contracts | Registry with ABIs |
| `GET /api/v1/contracts/:address` | Get contract details | Stats & recent activity |
| `POST /api/v1/contracts` | Register contract ABI | Add new contract metadata |
| `GET /api/v1/wallets/:address/transactions` | Wallet history | Account transaction history |
| `GET /api/v1/tokens` | List tokens | SEP-41 token summary |
| `GET /api/v1/dex/analyze` | DEX analytics | Swap analysis & patterns |
| `GET /api/v1/health` | Health check | Service status |

### Authentication

The API supports optional API key authentication via the `X-API-Key` header:

```bash
curl -H "X-API-Key: sk_live_xxxxx" http://localhost:3000/api/v1/transactions
```

Rate limit tiers:
- **Public** (no key): 100 req/min
- **Developer**: 300 req/min
- **Premium**: 1000 req/min

### Examples

**List recent transactions:**
```bash
curl "http://localhost:3000/api/v1/transactions?limit=10&page=1"
```

**Get transaction details:**
```bash
curl "http://localhost:3000/api/v1/transactions/0xabc123..."
```

**Register a contract ABI:**
```bash
curl -X POST http://localhost:3000/api/v1/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "address": "CXXX...",
    "name": "MyDEX",
    "abi": {
      "functions": [{
        "name": "swap",
        "inputs": [
          { "name": "from", "type": "address" },
          { "name": "amount_in", "type": "i128" }
        ]
      }]
    }
  }'
```

**Query wallet history:**
```bash
curl "http://localhost:3000/api/v1/wallets/GBZX.../transactions"
```

For more examples and full endpoint reference, see `/api/docs` or [API_REFERENCE.md](./docs/API_REFERENCE.md)

## Environment Variables

### Core Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development` or `production` |
| `PORT` | `3000` | Express server port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Database

| Variable | Default | Description |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `DATABASE_POOL_MIN` | `2` | Minimum connection pool size |
| `DATABASE_POOL_MAX` | `10` | Maximum connection pool size |

### Stellar Network

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_NETWORK` | `testnet` | `testnet`, `mainnet`, or `devnet` |
| `STELLAR_RPC_URL` | testnet RPC | Soroban RPC endpoint URL |
| `HORIZON_URL` | testnet Horizon | Horizon API endpoint |
| `NETWORK_PASSPHRASE` | testnet | Stellar network passphrase |

### Indexer Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_ENABLED` | `true` | Enable ledger indexing |
| `INDEXER_START_LEDGER` | `0` | Starting ledger sequence |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | Poll interval (5 seconds) |
| `INDEXER_BATCH_SIZE` | `100` | Ledgers per batch |
| `INDEXER_MAX_RETRIES` | `3` | RPC call retry attempts |
| `INDEXER_RETRY_DELAY_MS` | `1000` | Retry backoff (ms) |

### Caching (Redis)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `REDIS_ENABLED` | `true` | Enable Redis caching |
| `CACHE_TTL_SECONDS` | `3600` | Default cache TTL (1 hour) |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_PUBLIC` | `100` | Public tier: requests/minute |
| `RATE_LIMIT_DEVELOPER` | `300` | Developer tier (with API key) |
| `RATE_LIMIT_PREMIUM` | `1000` | Premium tier (with API key) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |

### Analytics & Data Lake

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYTICS_ENABLED` | `false` | Enable analytics pipeline |
| `ANALYTICS_S3_BUCKET` | — | S3 bucket for Parquet/Iceberg |
| `ANALYTICS_S3_PREFIX` | `iceberg` | S3 key prefix |
| `KAFKA_BROKERS` | `kafka:9092` | Kafka broker list |
| `GLUE_DATABASE` | `soroban_analytics` | AWS Glue database |
| `ATHENA_OUTPUT_BUCKET` | — | Athena query results S3 bucket |
| `TRINO_URL` | `http://trino:8080` | Trino coordinator URL |

### Authentication (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_API_KEYS` | `true` | Enable API key authentication |
| `JWT_SECRET` | — | JWT signing secret (if using JWT) |

### Testnet Configuration

```env
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.validationcloud.io:443
HORIZON_URL=https://horizon-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

### Mainnet Configuration

```env
STELLAR_NETWORK=mainnet
STELLAR_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
HORIZON_URL=https://horizon.stellar.org
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
INDEXER_START_LEDGER=1000  # Start from a recent ledger to save time
```

See [.env.example](./.env.example) for all available variables.

## Development Workflow

### Project Structure

```
├── src/
│   ├── api/               # Route handlers (144 endpoints)
│   ├── indexer/           # Ledger polling & XDR decoding
│   ├── middleware/        # Express middleware (auth, rate limit, etc.)
│   ├── services/          # Business logic
│   ├── index.ts           # Express app entry point
│   ├── config.ts          # Configuration loader
│   ├── db.ts              # Prisma ORM
│   ├── cache.ts           # Redis utilities
│   └── logger.ts          # Structured logging
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── migrations/        # Migration history
├── tests/                 # Test suites
├── docker-compose.yml     # Local development stack
├── package.json
├── tsconfig.json
└── README.md
```

### Common Development Tasks

**Run tests:**
```bash
npm run test              # Run test suite
npm run test:watch       # Watch mode
npm run test:coverage    # Generate coverage report
```

**Code quality:**
```bash
npm run lint             # ESLint check
npm run lint:fix         # ESLint fix
npm run format           # Prettier check
npm run format:fix       # Prettier fix
npm run build:strict     # TypeScript strict check
```

**Database operations:**
```bash
npx prisma migrate dev   # Create & apply migration
npx prisma studio       # Open Prisma Studio (visual DB explorer)
npx prisma seed         # Seed known contracts
```

**Indexing:**
```bash
npm run index            # Start indexer
npm run index:watch      # Watch mode (restart on code changes)
```

### Git Workflow

1. **Create feature branch**: `git checkout -b feature/description`
2. **Make changes**: Edit code, run tests locally
3. **Commit**: `git commit -m "feat: description"` (follows Conventional Commits)
4. **Push**: `git push origin feature/description`
5. **Create PR**: Include description of changes and related issue numbers
6. **CI checks**: PRs must pass ESLint, tests, and type checks
7. **Merge**: Squash and merge to main

### Debugging

**Enable debug logging:**
```bash
DEBUG=app:* npm run dev
```

**Inspect database:**
```bash
npx prisma studio     # Visual DB explorer at http://localhost:5555
```

**Check indexer status:**
```bash
curl http://localhost:3000/health
```

**Monitor Redis:**
```bash
redis-cli MONITOR      # Real-time command monitoring
```

## Deployment

### Prerequisites

- Docker & Docker Compose
- PostgreSQL 14+ (or use RDS)
- Redis 6+ (or use ElastiCache)
- Stellar RPC access (API key for Validation Cloud)
- AWS account (for analytics data lake, optional)

### Docker Deployment

**1. Build and push image:**
```bash
docker build -t soroban-explorer:latest .
docker tag soroban-explorer:latest <registry>/soroban-explorer:latest
docker push <registry>/soroban-explorer:latest
```

**2. Deploy with Docker Compose:**
```bash
# Create .env from template
cp .env.example .env
# Edit .env with production values

# Start services
docker compose -f docker-compose.yml up -d

# Verify
curl http://localhost:3000/api/v1/health
```

### Kubernetes Deployment

See [k8s/](./k8s/) directory for Kubernetes manifests:

```bash
# Apply configuration
kubectl apply -f k8s/

# Check status
kubectl get pods
kubectl logs -f deployment/soroban-explorer
```

### Cloud Deployment

**AWS ECS:**
```bash
# Push image to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag soroban-explorer:latest <account>.dkr.ecr.us-east-1.amazonaws.com/soroban-explorer:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/soroban-explorer:latest

# Create ECS service (via AWS Console or Terraform)
```

**AWS App Runner:**
```bash
# Deploy from ECR image
aws apprunner create-service \
  --service-name soroban-explorer \
  --source-configuration ImageRepository={ImageIdentifier=<ecr-uri>}
```

### Environment Setup for Production

```env
# Core
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Database (use RDS)
DATABASE_URL=postgresql://user:password@rds-endpoint:5432/soroban

# Stellar (Mainnet)
STELLAR_NETWORK=mainnet
STELLAR_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
HORIZON_URL=https://horizon.stellar.org
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

# Redis (use ElastiCache)
REDIS_URL=redis://elasticache-endpoint:6379

# Analytics (optional)
ANALYTICS_ENABLED=true
ANALYTICS_S3_BUCKET=my-org-soroban-analytics
AWS_REGION=us-east-1
```

### Health Checks

The application exposes health endpoints for monitoring:

```bash
# Liveness check (is app running?)
curl http://localhost:3000/health

# Readiness check (is app ready for traffic?)
curl http://localhost:3000/readyz

# Startup check
curl http://localhost:3000/startup
```

### Monitoring

**Metrics** (Prometheus format):
```bash
curl http://localhost:3000/metrics
```

**Logs** (structured JSON):
```bash
docker logs -f soroban-explorer
```

### Scaling

**Horizontal scaling:**
- Run multiple instances behind a load balancer
- Each instance connects to the same PostgreSQL/Redis
- Indexer should run on a single dedicated pod (leader election via Redis)

**Vertical scaling:**
- Increase `DATABASE_POOL_MAX` for more DB connections
- Adjust `INDEXER_BATCH_SIZE` for faster indexing (more memory usage)
- Monitor memory and CPU usage

## Data Architecture

### Analytics Data Lake

For detailed analytics architecture, see [DATA_MESH_PLATFORM.md](./DATA_MESH_PLATFORM.md)

The backend supports streaming indexed data to a data lake:

```
PostgreSQL → Debezium CDC → Kafka → Apache Iceberg (S3)
```

Enable with:
```bash
docker compose --profile analytics up
ANALYTICS_ENABLED=true npm run dev
```

Then query the data lake:
```bash
curl -X POST http://localhost:3000/api/v1/analytics/query \
  -H "X-API-Key: key" \
  -d '{
    "templateId": "top_contracts_by_dau",
    "params": { "date": "2026-07-28" }
  }'
```

See [ANALYTICS_ARCHITECTURE.md](./ANALYTICS_ARCHITECTURE.md) for full architecture.

## Documentation

- **[API_REFERENCE.md](./docs/API_REFERENCE.md)** — Comprehensive API endpoint documentation
- **[JSDOC_IMPLEMENTATION_GUIDE.md](./JSDOC_IMPLEMENTATION_GUIDE.md)** — JSDoc standards for route handlers
- **[SWAGGER_DOCUMENTATION_STRATEGY.md](./SWAGGER_DOCUMENTATION_STRATEGY.md)** — Swagger/OpenAPI documentation
- **[DATA_MESH_PLATFORM.md](./DATA_MESH_PLATFORM.md)** — Analytics data lake architecture
- **[ANALYTICS_ARCHITECTURE.md](./ANALYTICS_ARCHITECTURE.md)** — Detailed analytics pipeline
- **[docs/sandbox-jit-design.md](./docs/sandbox-jit-design.md)** — Future WASM sandbox JIT design
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Contribution guidelines
- **[LICENSE](./LICENSE)** — MIT License

## Troubleshooting

### Common Issues

**Database connection refused:**
```bash
# Check PostgreSQL is running
docker compose ps postgres

# Verify DATABASE_URL in .env
echo $DATABASE_URL
```

**Indexer stuck:**
```bash
# Check logs
docker logs soroban-indexer

# Reset indexer state (careful!)
npx prisma db seed
```

**Rate limiting errors:**
```bash
# Check Redis is running
docker compose ps redis

# Verify REDIS_URL
echo $REDIS_URL
```

### Getting Help

- Check logs: `docker compose logs -f`
- See GitHub issues: https://github.com/Soroban-Smart-Block-Explorer/issues
- Ask in Stellar Discord: #soroban-dev

## License

MIT License — See [LICENSE](./LICENSE)

## Sandbox Capabilities

The `src/sandbox/` module provides a **deterministic transactional state simulator** for Soroban contracts.

**What it is:**
- Pure TypeScript simulator — no WebAssembly execution
- Contracts dispatched by `templateId` to hardcoded logic (SEP-41 token, AMM, NFT, multisig, etc.)
- Deterministic by construction: same seed → same accounts, same results
- Gas metering via configurable cost table (`src/sandbox/gas-model.ts`) — approximates Soroban but does **not** match mainnet within 1%
- State isolation via copy-on-write snapshots
- Fuzzing, CI pipelines, invariant verification built on top

**What it is NOT:**
- A WASM JIT sandbox — does not execute WASM bytecode
- A mainnet replay oracle — `replayMainnet()` returns `{ equal: false, reason: 'sandbox substrate is not a WASM runtime' }`
- The sandbox router (`src/api/sandbox.ts`) is exported but **not mounted** in `router.ts`

**Design for a real WASM JIT sandbox** (issue #561):
See `docs/sandbox-jit-design.md` for the target architecture including:
- Tiered Cranelift compilation (baseline → optimizing + OSR)
- Precise per-instruction gas metering with prepay/refund
- Deterministic execution (float trapping, no wall clock, no threads)
- Mainnet replay parity (<10% real execution time)
- Side-channel hardening (constant-time metering, Spectre fences)
