# Redis Deployment Guide

This document covers deploying and configuring Redis for the Soroban Smart Block Explorer backend, with support for three deployment modes: **Standalone**, **Sentinel**, and **Cluster**.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│            Soroban Backend (cache.ts)                       │
│  - In-process L1 cache (LRU, 10k entries)                   │
│  - Version tracking + pub/sub invalidation                  │
└──────────────────┬──────────────────────────────────────────┘
                   │
     ┌─────────────┴────────────────┬──────────────────────┐
     ▼                              ▼                      ▼
┌──────────┐  ┌──────────────────────────┐  ┌──────────────────────┐
│Standalone│  │    Sentinel Cluster      │  │  Redis Cluster       │
│  Redis   │  │ (Master + Replicas)      │  │  (Sharded)           │
│          │  │                          │  │                      │
│ Suitable │  │ HA + Auto Failover       │  │ HA + Horizontal      │
│ for dev  │  │ Suitable for prod        │  │ scale Suitable       │
│          │  │                          │  │ for large scale      │
└──────────┘  └──────────────────────────┘  └──────────────────────┘
```

## Configuration Modes

### 1. Standalone Redis

**Best for:** Local development, testing, or single-node deployments.

**URL Format:**
```
redis://[:password@]host:port[/db]
redis://localhost:6379
redis://:mypassword@redis.example.com:6379/0
```

**Environment Variables:**
```bash
# .env or .env.{network}
TESTNET_CACHE_URL=redis://localhost:6379
TESTNET_CACHE_MODE=standalone  # default

MAINNET_CACHE_URL=redis://:mypassword@redis.example.com:6379/0
MAINNET_CACHE_MODE=standalone
```

**Docker Compose Example:**
```yaml
cache:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  command: redis-server --appendonly yes
  volumes:
    - redis-data:/data
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 2s
    retries: 3
```

**Manual Start:**
```bash
redis-server --port 6379 --requirepass mypassword --appendonly yes
redis-cli ping  # verify connection
```

---

### 2. Redis Sentinel

**Best for:** Production deployments requiring automatic failover and high availability.

**What Sentinel provides:**
- Automatic master/replica detection
- Failover on master unavailability
- Client discovery (clients automatically find the master)
- Monitoring and health checks
- Configuration management

**URL Format:**
```
sentinel://host1:26379,host2:26379,host3:26379?sentinels=mymaster&password=xxx&sentinel-password=yyy
```

**URL Query Parameters:**
| Parameter | Description | Default |
|-----------|-------------|---------|
| `sentinels` | Sentinel master set name | `mymaster` |
| `password` | Redis password | (none) |
| `username` | Redis username (Redis 6.0+) | (none) |
| `sentinel-password` | Sentinel password | (none) |
| `db` | Database number | `0` |

**Environment Variables:**
```bash
# Testnet with Sentinel
TESTNET_CACHE_URL="sentinel://sentinel1.example.com:26379,sentinel2.example.com:26379,sentinel3.example.com:26379?sentinels=mymaster&password=redis_pass&sentinel-password=sentinel_pass&db=0"
TESTNET_CACHE_MODE=sentinel

# Mainnet high-availability setup
MAINNET_CACHE_URL="sentinel://10.0.1.10:26379,10.0.1.11:26379,10.0.1.12:26379?sentinels=soroban-cache&password=prodpass123&sentinel-password=sentinelpass456&username=default&db=1"
MAINNET_CACHE_MODE=sentinel
```

**Docker Compose Example:**

```yaml
version: '3.8'

services:
  redis-master:
    image: redis:7-alpine
    command: redis-server --port 6379 --requirepass redis_pass --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - redis-master-data:/data
    networks:
      - cache-network

  redis-slave-1:
    image: redis:7-alpine
    command: redis-server --port 6380 --slaveof redis-master 6379 --requirepass redis_pass --appendonly yes
    ports:
      - "6380:6380"
    depends_on:
      - redis-master
    volumes:
      - redis-slave1-data:/data
    networks:
      - cache-network

  redis-slave-2:
    image: redis:7-alpine
    command: redis-server --port 6381 --slaveof redis-master 6379 --requirepass redis_pass --appendonly yes
    ports:
      - "6381:6381"
    depends_on:
      - redis-master
    volumes:
      - redis-slave2-data:/data
    networks:
      - cache-network

  sentinel-1:
    image: redis:7-alpine
    command: redis-sentinel /etc/sentinel.conf
    ports:
      - "26379:26379"
    volumes:
      - ./sentinel-1.conf:/etc/sentinel.conf
    depends_on:
      - redis-master
    networks:
      - cache-network

  sentinel-2:
    image: redis:7-alpine
    command: redis-sentinel /etc/sentinel.conf
    ports:
      - "26380:26379"
    volumes:
      - ./sentinel-2.conf:/etc/sentinel.conf
    depends_on:
      - redis-master
    networks:
      - cache-network

  sentinel-3:
    image: redis:7-alpine
    command: redis-sentinel /etc/sentinel.conf
    ports:
      - "26381:26379"
    volumes:
      - ./sentinel-3.conf:/etc/sentinel.conf
    depends_on:
      - redis-master
    networks:
      - cache-network

volumes:
  redis-master-data:
  redis-slave1-data:
  redis-slave2-data:

networks:
  cache-network:
    driver: bridge
```

**Sentinel Configuration (`sentinel-1.conf`):**
```
port 26379
sentinel monitor mymaster 127.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel parallel-syncs mymaster 1
sentinel failover-timeout mymaster 10000
requirepass sentinel_pass
```

**Manual Setup (3-node Sentinel cluster):**

```bash
# Start Redis master
redis-server --port 6379 --requirepass redis_pass --appendonly yes

# Start Redis replicas (separate terminals)
redis-server --port 6380 --slaveof 127.0.0.1 6379 --requirepass redis_pass --appendonly yes
redis-server --port 6381 --slaveof 127.0.0.1 6379 --requirepass redis_pass --appendonly yes

# Start 3 Sentinel instances (separate terminals)
# Create sentinel-1.conf, sentinel-2.conf, sentinel-3.conf with the config above
redis-sentinel sentinel-1.conf
redis-sentinel sentinel-2.conf
redis-sentinel sentinel-3.conf

# Verify Sentinel cluster
redis-cli -p 26379 sentinel masters
redis-cli -p 26379 sentinel slaves mymaster
```

**Failover Testing:**

```bash
# Kill the master
pkill -f "redis-server --port 6379"

# Check Sentinel promotes a replica
redis-cli -p 26379 sentinel masters

# Restart the old master
redis-server --port 6379 --requirepass redis_pass --slaveof 127.0.0.1 6380 --appendonly yes
```

---

### 3. Redis Cluster

**Best for:** Large-scale deployments requiring data sharding and horizontal scalability.

**What Cluster provides:**
- Automatic data sharding (16,384 slots)
- No single point of failure
- Horizontal scalability (add nodes to expand capacity)
- Automatic rebalancing
- Multi-node failover (each shard has replicas)

**URL Format:**
```
cluster://node1:6379,node2:6379,node3:6379?password=xxx&username=yyy
```

**URL Query Parameters:**
| Parameter | Description | Default |
|-----------|-------------|---------|
| `password` | Cluster password | (none) |
| `username` | Cluster username (Redis 6.0+) | (none) |

**Environment Variables:**
```bash
# Testnet cluster
TESTNET_CACHE_URL="cluster://cluster1.example.com:6379,cluster2.example.com:6379,cluster3.example.com:6379?password=cluster_pass"
TESTNET_CACHE_MODE=cluster

# Mainnet large-scale cluster (6 nodes: 3 primaries + 3 replicas)
MAINNET_CACHE_URL="cluster://10.0.2.10:6379,10.0.2.11:6379,10.0.2.12:6379,10.0.2.13:6379,10.0.2.14:6379,10.0.2.15:6379?password=prodpass123&username=default"
MAINNET_CACHE_MODE=cluster
```

**Docker Compose Example:**

```yaml
version: '3.8'

services:
  redis-cluster-1:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6379:6379"
    volumes:
      - cluster-1-data:/data
    networks:
      - cluster-network

  redis-cluster-2:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6380:6379"
    volumes:
      - cluster-2-data:/data
    networks:
      - cluster-network

  redis-cluster-3:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6381:6379"
    volumes:
      - cluster-3-data:/data
    networks:
      - cluster-network

  redis-cluster-4:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6382:6379"
    volumes:
      - cluster-4-data:/data
    networks:
      - cluster-network

  redis-cluster-5:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6383:6379"
    volumes:
      - cluster-5-data:/data
    networks:
      - cluster-network

  redis-cluster-6:
    image: redis:7-alpine
    command: redis-server --port 6379 --cluster-enabled yes --cluster-config-file nodes.conf --appendonly yes --requirepass cluster_pass
    ports:
      - "6384:6379"
    volumes:
      - cluster-6-data:/data
    networks:
      - cluster-network

  # Cluster initialization helper
  cluster-init:
    image: redis:7-alpine
    command: >
      redis-cli -a cluster_pass --cluster create
        redis-cluster-1:6379
        redis-cluster-2:6379
        redis-cluster-3:6379
        redis-cluster-4:6379
        redis-cluster-5:6379
        redis-cluster-6:6379
        --cluster-replicas 1 --cluster-yes
    depends_on:
      - redis-cluster-1
      - redis-cluster-2
      - redis-cluster-3
      - redis-cluster-4
      - redis-cluster-5
      - redis-cluster-6
    networks:
      - cluster-network

volumes:
  cluster-1-data:
  cluster-2-data:
  cluster-3-data:
  cluster-4-data:
  cluster-5-data:
  cluster-6-data:

networks:
  cluster-network:
    driver: bridge
```

**Manual Setup (6-node Cluster):**

```bash
# Start 6 Redis instances with cluster mode enabled
for i in {1..6}; do
  redis-server --port $((6379 + i - 1)) --cluster-enabled yes --cluster-config-file nodes-$i.conf --appendonly yes --requirepass cluster_pass &
done

# Create cluster (3 masters, 3 replicas)
redis-cli -a cluster_pass --cluster create \
  127.0.0.1:6379 \
  127.0.0.1:6380 \
  127.0.0.1:6381 \
  127.0.0.1:6382 \
  127.0.0.1:6383 \
  127.0.0.1:6384 \
  --cluster-replicas 1 --cluster-yes

# Verify cluster
redis-cli -a cluster_pass -p 6379 cluster info
redis-cli -a cluster_pass -p 6379 cluster nodes
```

**Cluster Scaling:**

```bash
# Add a new node to the cluster
redis-server --port 6385 --cluster-enabled yes --cluster-config-file nodes-7.conf --appendonly yes --requirepass cluster_pass &

# Add the node to the cluster
redis-cli -a cluster_pass --cluster add-node 127.0.0.1:6385 127.0.0.1:6379

# Reshard (move slots to the new node)
redis-cli -a cluster_pass --cluster reshard 127.0.0.1:6379 --cluster-from <source-node-id> --cluster-to <target-node-id> --cluster-slots 5461 --cluster-yes
```

---

## Fallback & Fault Tolerance

The cache module automatically falls back to in-process memory caching if:
1. Redis is not available at startup
2. Redis connection fails at runtime
3. Cache URL is empty or set to `memory://`

**Behavior:**
- L1 in-process cache: 10,000 entries, LRU eviction, configurable TTL (default 300s)
- Memory-only caching: No shared state across instances
- Pub/sub invalidation: Disabled in memory mode

**Production Recommendation:**
For mainnet, always use **Sentinel** or **Cluster** mode to ensure:
- High availability
- Automatic failover
- Shared cache state across multiple backend instances

---

## Monitoring & Operations

### Health Checks

**Standalone:**
```bash
redis-cli ping
redis-cli info stats
redis-cli memory stats
```

**Sentinel:**
```bash
redis-cli -p 26379 sentinel masters
redis-cli -p 26379 sentinel slaves mymaster
redis-cli -p 26379 sentinel failovers mymaster
```

**Cluster:**
```bash
redis-cli -c cluster info
redis-cli -c cluster nodes
redis-cli -c cluster slots
```

### Prometheus Metrics

If using `redis_exporter`:
```yaml
redis_exporter:
  image: oliver006/redis_exporter:latest
  ports:
    - "9121:9121"
  environment:
    REDIS_ADDR: redis://localhost:6379
    REDIS_PASSWORD: mypassword
```

### Logging

The cache module logs all connections and errors:
```
[cache] Connected to Redis Sentinel { backend: 'sentinel', masterName: 'mymaster' }
[cache] Pub/sub listener registered { channel: '__cache:invalidate' }
[cache] Failed to read key from Redis { backend: 'sentinel', operation: 'get', key: 'tx:***', error: 'Connection timeout' }
```

---

## Performance Tuning

### Redis Configuration

**Standalone/Sentinel:**
```
# redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
appendonly yes
appendfsync everysec
```

**Cluster:**
```
# redis.conf (all nodes)
maxmemory 2gb
maxmemory-policy allkeys-lru
appendonly yes
appendfsync everysec
cluster-node-timeout 15000
```

### Backend Configuration

```bash
# Cache tuning
CACHE_MAX_SIZE=10000          # L1 entry limit (default: 1000)
CACHE_MEMORY_TTL=300          # Memory-only TTL in seconds (default: 300)
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Connection refused" | Verify Redis is running; check host/port in CACHE_URL |
| "Authentication failed" | Verify password in CACHE_URL; check `requirepass` in Redis config |
| "Sentinel master not found" | Verify sentinel master name in `sentinels` query param; check Sentinel is running |
| "Cluster slots misconfigured" | Run `redis-cli -c cluster nodes` to verify slot distribution |
| "Memory limit exceeded" | Increase `maxmemory`; adjust `maxmemory-policy` to `allkeys-lru` |
| "Pub/sub not working" | Verify pub/sub is enabled in Redis config; check for connection errors in logs |

---

## Deployment Checklist

- [ ] Choose deployment mode (standalone/sentinel/cluster)
- [ ] Configure `CACHE_URL` and `CACHE_MODE` in `.env.{network}`
- [ ] Set `requirepass` and authentication credentials
- [ ] Enable `appendonly` for data persistence
- [ ] Set up monitoring and alerting
- [ ] Test failover (if using Sentinel/Cluster)
- [ ] Configure max memory and eviction policy
- [ ] Set up backup/restore procedures
- [ ] Document connection strings (securely stored)
- [ ] Plan capacity based on cache size estimates

---

## Additional Resources

- [Redis Documentation](https://redis.io/documentation)
- [Redis Sentinel Documentation](https://redis.io/topics/sentinel)
- [Redis Cluster Documentation](https://redis.io/topics/cluster-tutorial)
- [Redis Node.js Client](https://github.com/redis/node-redis)
