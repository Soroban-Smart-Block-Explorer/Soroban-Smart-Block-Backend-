# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Installs all dependencies (including devDeps), generates the Prisma client,
# and compiles TypeScript.
FROM node:20-slim AS builder

RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates > /dev/null && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Only schema is needed for prisma generate — migrations/seed are not required
COPY prisma/schema.prisma ./prisma/schema.prisma
# audit-check.js + .auditignore are copied ahead of the full source so the
# audit step below can apply the same tracked, dated exceptions as CI
# (#897) without needing the rest of the source tree yet.
COPY scripts/audit-check.js ./scripts/audit-check.js
COPY .auditignore ./.auditignore

RUN npm ci && node scripts/audit-check.js

COPY . .

# Generate Prisma client into node_modules/.prisma
RUN npx prisma generate

RUN npm run build

# ── Stage 2: security-scan ────────────────────────────────────────────────────
# Trivy vulnerability scan; fails the build on CRITICAL findings.
FROM node:20-slim AS security-scan

RUN apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg lsb-release > /dev/null 2>&1 && \
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin && \
    trivy --version && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

RUN trivy filesystem --exit-code 1 --severity CRITICAL --no-progress --format json --output /trivy-report.json /app

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
# Lean production image:
#   • npm ci --omit=dev  → production deps only (strips devDeps)
#   • .prisma copied from builder so the pre-generated client is available
#     without needing the 'prisma' devDep at runtime (#702)
#   • Only prisma/schema.prisma copied — migrations and seed scripts are NOT
#     needed at runtime and bloat the image (#701)
FROM node:20-slim

RUN addgroup --gid 1001 appgroup && \
    adduser --uid 1001 --gid 1001 --disabled-password --no-create-home --gecos "" --shell /sbin/nologin appuser

RUN apt-get update -qq && apt-get install -y -qq openssl wget ca-certificates > /dev/null && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Same tracked audit exceptions as the builder stage (#897) — see above.
COPY scripts/audit-check.js ./scripts/audit-check.js
COPY .auditignore ./.auditignore

# Install production deps only.
# --ignore-scripts prevents the postinstall 'prisma generate' from running
# (which would fail without the prisma devDep).  The pre-generated client is
# copied from the builder stage below instead.
RUN npm ci --omit=dev --ignore-scripts && node scripts/audit-check.js --omit=dev

# Copy compiled application output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-esm ./dist-esm

# #702: copy the pre-generated Prisma client from builder so it survives
# npm ci --omit=dev (which strips the 'prisma' devDep used to generate it)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# #701: only copy schema.prisma — migrations/ and seed.ts are not needed at runtime
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN mkdir -p /app/data/p2p && chown -R appuser:appgroup /app

RUN mkdir -p /tmp/.npm && chmod 1777 /tmp

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# 4001: libp2p listen port (P2P_LISTEN_ADDR), only relevant when P2P_ENABLED=true.
EXPOSE 3000 4001

CMD ["node", "dist/index.js"]
