# Health Check Endpoints

This document describes the health check endpoints available in the Soroban Smart Block Backend API.

## Overview

The backend provides three types of health check endpoints, each serving different purposes for monitoring and orchestration:

1. **`/health`** - Comprehensive dependency health check
2. **`/livez`** - Liveness probe (should the service be restarted?)
3. **`/readyz`** - Readiness probe (can the service handle traffic?)
4. **`/ready`** - Legacy readiness probe (backwards compatibility)

## Endpoint Details

### `/health` - Comprehensive Health Check

Returns detailed health status of all system dependencies.

**Purpose**: Complete visibility into the health of all backend components. Useful for dashboards, alerting, and diagnostics.

**HTTP Status Codes**:
- `200 OK` - Service is healthy or degraded (non-critical issues)
- `503 Service Unavailable` - Service is unhealthy or shutting down

**Response Structure**:

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "network": "testnet",
  "dependencies": {
    "database": {
      "status": "healthy" | "degraded" | "unhealthy",
      "message": "Database responsive",
      "details": {
        "responseTimeMs": 45,
        "readReplica": "connected",
        "writePrimary": "connected"
      },
      "lastChecked": "2026-06-29T12:00:00.000Z"
    },
    "cache": {
      "status": "healthy" | "degraded" | "unhealthy",
      "message": "Cache operational",
      "details": {
        "ready": true,
        "type": "redis"
      },
      "lastChecked": "2026-06-29T12:00:00.000Z"
    },
    "indexer": {
      "status": "healthy" | "degraded" | "unhealthy",
      "message": "Indexer operational",
      "details": {
        "healthy": true
      },
      "lastChecked": "2026-06-29T12:00:00.000Z"
    },
    "worker": {
      "status": "healthy" | "degraded" | "unhealthy",
      "message": "Workers operational",
      "details": {},
      "lastChecked": "2026-06-29T12:00:00.000Z"
    }
  },
  "readiness": {
    "ready": true,
    "dependencies": {
      "db": true,
      "cache": true,
      "indexer": true,
      "coldStorage": true
    }
  }
}
```

**Dependency Status Meanings**:
- **`healthy`** - Component is fully operational
- **`degraded`** - Component has non-critical issues (e.g., high latency, fallback mode)
- **`unhealthy`** - Component is not operational

**Usage**:
```bash
curl http://localhost:8080/health
```

---

### `/livez` - Liveness Probe

Simple check to determine if the service is alive and should not be restarted.

**Purpose**: Used by container orchestrators (Kubernetes, Docker Swarm) to determine if the service needs to be restarted. A failing liveness check typically triggers a container restart.

**HTTP Status Codes**:
- `200 OK` - Service is alive
- `503 Service Unavailable` - Service is dead or shutting down

**Response Structure**:

```json
{
  "status": "alive" | "dead",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "uptime": 3600
}
```

**Fields**:
- `status` - Current liveness state
- `timestamp` - Current server time
- `uptime` - Service uptime in seconds

**Usage**:
```bash
curl http://localhost:8080/livez
```

**Kubernetes Example**:
```yaml
livenessProbe:
  httpGet:
    path: /livez
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

---

### `/readyz` - Readiness Probe

Detailed check to determine if the service is ready to handle traffic.

**Purpose**: Used by load balancers and orchestrators to determine if the service should receive traffic. A failing readiness check removes the service from the load balancer pool without restarting it.

**HTTP Status Codes**:
- `200 OK` - Service is ready to handle traffic
- `503 Service Unavailable` - Service is not ready (still initializing or dependencies unavailable)

**Response Structure**:

```json
{
  "status": "ready" | "not_ready",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "dependencies": {
    "db": true,
    "cache": true,
    "indexer": true,
    "coldStorage": true
  },
  "blockers": ["indexer", "coldStorage"]
}
```

**Fields**:
- `status` - Current readiness state
- `timestamp` - Current server time
- `dependencies` - Boolean status of each required dependency
- `blockers` - (Optional) List of dependencies that are preventing readiness

**Usage**:
```bash
curl http://localhost:8080/readyz
```

**Kubernetes Example**:
```yaml
readinessProbe:
  httpGet:
    path: /readyz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
  successThreshold: 1
```

---

### `/ready` - Legacy Readiness Probe

Legacy endpoint for backwards compatibility. Focuses primarily on indexer status.

**Purpose**: Maintained for backwards compatibility with existing monitoring systems.

**HTTP Status Codes**:
- `200 OK` - Indexer is healthy
- `503 Service Unavailable` - Indexer has failed

**Response Structure**:

```json
{
  "status": "ready" | "unavailable",
  "reason": "optional failure reason",
  "disabledServices": []
}
```

**Usage**:
```bash
curl http://localhost:8080/ready
```

---

## Health Status Semantics

### Liveness vs Readiness

Understanding the distinction between liveness and readiness is crucial for proper orchestration:

| Aspect | Liveness (`/livez`) | Readiness (`/readyz`) |
|--------|---------------------|----------------------|
| **Question** | Is the process alive? | Can it handle traffic? |
| **Action on Failure** | Restart the container | Remove from load balancer |
| **Use Case** | Detect deadlocks, infinite loops | Detect initialization delays, dependency outages |
| **Recovery** | Process restart | Wait for dependencies |
| **Example Failure** | Out of memory, deadlock | Database connection lost, still starting up |

**Key Principle**: A service can be alive but not ready. Never restart a service just because it's not ready.

### Health Check Best Practices

1. **Use `/health` for monitoring and alerting** - Get detailed information about all components
2. **Use `/livez` for container orchestration liveness probes** - Only fails when service is truly broken
3. **Use `/readyz` for load balancer and traffic management** - Removes unhealthy instances from rotation
4. **Set appropriate timeouts and thresholds** - Avoid flapping during transient issues

### Example Health Scenarios

#### Scenario 1: Database Connection Lost
- `/health` → 503 (unhealthy - database dependency failed)
- `/livez` → 200 (alive - service is running)
- `/readyz` → 503 (not ready - missing required dependency)

**Action**: Service stays running, removed from load balancer until database reconnects.

#### Scenario 2: High Database Latency
- `/health` → 200 (degraded - database slow but functional)
- `/livez` → 200 (alive)
- `/readyz` → 200 (ready - can still serve traffic)

**Action**: Service continues operating, alerts may be triggered for investigation.

#### Scenario 3: Graceful Shutdown
- `/health` → 503 (status: shutting_down)
- `/livez` → 503 (dead)
- `/readyz` → 503 (not_ready)

**Action**: Service is terminating, no new traffic, no restart.

#### Scenario 4: Redis Cache Unavailable (with in-memory fallback)
- `/health` → 200 (degraded - cache using fallback)
- `/livez` → 200 (alive)
- `/readyz` → 200 (ready - can serve traffic with degraded performance)

**Action**: Service continues with in-memory cache, monitoring alert for Redis restoration.

---

## Integration Examples

### Docker Compose

```yaml
services:
  backend:
    image: soroban-backend:latest
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: soroban-backend
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: backend
        image: soroban-backend:latest
        ports:
        - containerPort: 8080
        livenessProbe:
          httpGet:
            path: /livez
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
          successThreshold: 1
```

### Prometheus Monitoring

```yaml
scrape_configs:
  - job_name: 'soroban-backend-health'
    metrics_path: '/health'
    scrape_interval: 30s
    static_configs:
      - targets: ['backend:8080']
```

### HAProxy Load Balancer

```
backend soroban_backend
    option httpchk GET /readyz
    http-check expect status 200
    server backend1 10.0.0.1:8080 check inter 5s fall 3 rise 2
    server backend2 10.0.0.2:8080 check inter 5s fall 3 rise 2
```

---

## Troubleshooting

### Service Reports Unhealthy

1. Check `/health` endpoint for detailed dependency status
2. Review the `details` field for each unhealthy dependency
3. Check application logs for connection errors
4. Verify database/cache connectivity from the host
5. Check database migrations are up to date

### Service Not Receiving Traffic

1. Check `/readyz` endpoint - should return 200
2. Review `blockers` field if status is `not_ready`
3. Allow time for service initialization (30-60 seconds typical)
4. Check that all dependencies are accessible

### Frequent Restarts

1. Review liveness probe configuration - may be too aggressive
2. Check `/livez` endpoint manually during restart cycle
3. Increase `initialDelaySeconds` and `failureThreshold`
4. Review application logs for crash causes

---

## Implementation Details

### Health Check Components

The health check system consists of:

1. **`src/health.ts`** - Core health check logic
   - Database connectivity tests
   - Cache availability checks
   - Indexer status monitoring
   - Worker health verification

2. **`src/readiness.ts`** - Readiness state management
   - Tracks initialization progress
   - Manages dependency ready flags

3. **`src/indexer-state.ts`** - Indexer health tracking
   - Monitors indexer failures
   - Records failure reasons

4. **`src/index.ts`** - Endpoint definitions
   - Routes health check requests
   - Applies proper HTTP status codes

### Adding New Dependency Checks

To add a new dependency check:

1. Add the dependency type to `DependencyName` in `src/readiness.ts`
2. Implement a health check function in `src/health.ts`
3. Add the check to `getHealthStatus()` function
4. Update this documentation

Example:
```typescript
// In src/health.ts
function checkNewDependencyHealth(): DependencyHealth {
  try {
    // Check dependency
    return {
      status: 'healthy',
      message: 'Dependency operational',
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: `Dependency failed: ${error.message}`,
      lastChecked: new Date().toISOString(),
    };
  }
}
```

---

## References

- [Kubernetes Liveness and Readiness Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Docker Health Checks](https://docs.docker.com/engine/reference/builder/#healthcheck)
- [Health Check Response Format for HTTP APIs (draft-inadarei-api-health-check)](https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check)
