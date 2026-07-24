FROM node:20-slim AS builder
RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates > /dev/null && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci && npm audit --audit-level=high
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-slim AS security-scan
RUN apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg lsb-release > /dev/null 2>&1 && \
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin && \
    trivy --version && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /app /app
RUN trivy filesystem --exit-code 1 --severity CRITICAL --no-progress --format json --output /trivy-report.json /app

FROM node:20-slim
RUN addgroup --gid 1001 appgroup && \
    adduser --uid 1001 --gid 1001 --disabled-password --no-create-home --gecos "" --shell /sbin/nologin appuser

RUN apt-get update -qq && apt-get install -y -qq openssl wget ca-certificates > /dev/null && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm audit --omit=dev --audit-level=high

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-esm ./dist-esm
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

RUN mkdir -p /app/data/p2p && chown -R appuser:appgroup /app

RUN mkdir -p /tmp/.npm && chmod 1777 /tmp

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# 4001: libp2p listen port (P2P_LISTEN_ADDR), only relevant when P2P_ENABLED=true.
EXPOSE 3000 4001
CMD ["node", "dist/index.js"]
