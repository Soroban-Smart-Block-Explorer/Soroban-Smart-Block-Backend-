# Configuration Validation

This document describes the environment variable validation system implemented in the Soroban Smart Block Backend.

## Overview

All numeric environment variables are validated at startup using Zod schemas. Invalid or out-of-range values cause the application to fail immediately with actionable error messages, preventing runtime issues caused by `NaN` or invalid configuration values.

## Validation Rules

### Port Configuration

**Environment Variable**: `PORT`

- **Type**: Integer
- **Range**: 1 - 65535
- **Default**: 3000
- **Validation**: Must be a positive integer within valid port range

**Examples**:
```bash
# Valid
PORT=3000
PORT=8080

# Invalid - will cause startup failure
PORT=abc          # Not a number
PORT=0            # Not positive
PORT=70000        # Above maximum
PORT=-1           # Negative
```

### Indexer Configuration

#### Start Ledger

**Environment Variable**: `INDEXER_START_LEDGER`

- **Type**: Integer
- **Range**: ≥ 0
- **Default**: 0
- **Validation**: Must be a non-negative integer

**Examples**:
```bash
# Valid
INDEXER_START_LEDGER=0
INDEXER_START_LEDGER=1000000

# Invalid
INDEXER_START_LEDGER=-1       # Negative
INDEXER_START_LEDGER=abc      # Not a number
```

#### Poll Interval

**Environment Variable**: `INDEXER_POLL_INTERVAL_MS`

- **Type**: Integer (milliseconds)
- **Range**: ≥ 100
- **Default**: 5000
- **Validation**: Must be at least 100ms to prevent excessive polling

**Examples**:
```bash
# Valid
INDEXER_POLL_INTERVAL_MS=5000
INDEXER_POLL_INTERVAL_MS=1000

# Invalid
INDEXER_POLL_INTERVAL_MS=50   # Too small
INDEXER_POLL_INTERVAL_MS=0    # Not positive
INDEXER_POLL_INTERVAL_MS=abc  # Not a number
```

#### Batch Size

**Environment Variable**: `INDEXER_BATCH_SIZE`

- **Type**: Integer
- **Range**: 1 - 1000
- **Default**: 100
- **Validation**: Must be between 1 and 1000 to prevent memory issues

**Examples**:
```bash
# Valid
INDEXER_BATCH_SIZE=100
INDEXER_BATCH_SIZE=500

# Invalid
INDEXER_BATCH_SIZE=0          # Not positive
INDEXER_BATCH_SIZE=1500       # Above maximum
INDEXER_BATCH_SIZE=-50        # Negative
```

#### Catchup Workers

**Environment Variable**: `INDEXER_CATCHUP_WORKERS`

- **Type**: Integer
- **Range**: 1 - 32
- **Default**: 4
- **Validation**: Must be between 1 and 32 to prevent resource exhaustion

**Examples**:
```bash
# Valid
INDEXER_CATCHUP_WORKERS=4
INDEXER_CATCHUP_WORKERS=16

# Invalid
INDEXER_CATCHUP_WORKERS=0     # Not positive
INDEXER_CATCHUP_WORKERS=64    # Above maximum
INDEXER_CATCHUP_WORKERS=abc   # Not a number
```

### Micro-block Sync Configuration

**Environment Variable**: `MICRO_BLOCK_POLL_INTERVAL_MS`

- **Type**: Integer (milliseconds)
- **Range**: ≥ 100
- **Default**: 2500
- **Validation**: Must be at least 100ms

**Examples**:
```bash
# Valid
MICRO_BLOCK_POLL_INTERVAL_MS=2500
MICRO_BLOCK_POLL_INTERVAL_MS=1000

# Invalid
MICRO_BLOCK_POLL_INTERVAL_MS=50   # Too small
MICRO_BLOCK_POLL_INTERVAL_MS=0    # Not positive
```

### Rate Limiting Configuration

#### Window Duration

**Environment Variable**: `RATE_LIMIT_WINDOW_MS`

- **Type**: Integer (milliseconds)
- **Range**: ≥ 1000
- **Default**: 60000
- **Validation**: Must be at least 1000ms (1 second)

**Examples**:
```bash
# Valid
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_WINDOW_MS=300000

# Invalid
RATE_LIMIT_WINDOW_MS=500      # Too small
RATE_LIMIT_WINDOW_MS=0        # Not positive
```

#### Maximum Requests

**Environment Variable**: `RATE_LIMIT_MAX`

- **Type**: Integer
- **Range**: ≥ 1
- **Default**: 100
- **Validation**: Must be at least 1

**Examples**:
```bash
# Valid
RATE_LIMIT_MAX=100
RATE_LIMIT_MAX=1000

# Invalid
RATE_LIMIT_MAX=0              # Not positive
RATE_LIMIT_MAX=-10            # Negative
```

## Error Handling

### Startup Failure

When an invalid configuration value is detected, the application will:

1. **Exit immediately** with status code 1
2. **Display a formatted error message** with the specific issue
3. **Provide actionable guidance** for fixing the problem

### Error Message Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ CONFIGURATION ERROR: Invalid environment variable
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Invalid value for PORT: "abc" cannot be parsed as a number. 
Expected a valid integer. Using default value 3000 is recommended.

📋 Action required:
  1. Check your .env file or environment variables
  2. Ensure numeric values are valid integers
  3. Verify values are within acceptable ranges
  4. See .env.example for reference values

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Common Error Scenarios

#### Scenario 1: Non-numeric Value

**Problem**: Environment variable contains text instead of a number

```bash
PORT=abc
```

**Error**:
```
Invalid value for PORT: "abc" cannot be parsed as a number.
Expected a valid integer.
```

**Solution**: Set a valid numeric value
```bash
PORT=3000
```

#### Scenario 2: Out of Range Value

**Problem**: Number is outside the acceptable range

```bash
PORT=70000
```

**Error**:
```
Invalid value for PORT: 70000. Port must be between 1 and 65535.
```

**Solution**: Use a value within the valid range
```bash
PORT=8080
```

#### Scenario 3: Negative Value

**Problem**: Negative number where positive is required

```bash
INDEXER_BATCH_SIZE=-50
```

**Error**:
```
Invalid value for INDEXER_BATCH_SIZE: -50. Number must be greater than 0.
```

**Solution**: Use a positive value
```bash
INDEXER_BATCH_SIZE=100
```

#### Scenario 4: Zero Value

**Problem**: Zero where positive value is required

```bash
RATE_LIMIT_MAX=0
```

**Error**:
```
Invalid value for RATE_LIMIT_MAX: 0. Rate limit max must be at least 1.
```

**Solution**: Use a positive value
```bash
RATE_LIMIT_MAX=100
```

## Default Values

All numeric environment variables have sensible defaults. If an environment variable is **not set** or is **empty**, the default value is used without error.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | 3000 | Standard development port |
| `INDEXER_START_LEDGER` | 0 | Start from genesis |
| `INDEXER_POLL_INTERVAL_MS` | 5000 | 5 seconds |
| `INDEXER_BATCH_SIZE` | 100 | Balanced batch size |
| `INDEXER_CATCHUP_WORKERS` | 4 | Parallel workers |
| `MICRO_BLOCK_POLL_INTERVAL_MS` | 2500 | 2.5 seconds (Stellar block time) |
| `RATE_LIMIT_WINDOW_MS` | 60000 | 1 minute window |
| `RATE_LIMIT_MAX` | 100 | 100 requests per window |

### Using Defaults

To use default values, either:

1. **Omit the variable** from your `.env` file
2. **Leave it empty**: `PORT=`
3. **Comment it out**: `# PORT=3000`

**Example .env using defaults**:
```bash
# Using default PORT=3000
# PORT=

# Custom indexer settings
INDEXER_BATCH_SIZE=200

# Using default rate limits
# RATE_LIMIT_MAX=
```

## Best Practices

### Development

1. **Start with .env.example**: Copy and customize
   ```bash
   cp .env.example .env
   ```

2. **Leave defaults where appropriate**: Only override what you need
   ```bash
   # Good - only override what's needed
   PORT=3001
   INDEXER_BATCH_SIZE=200
   
   # Avoid - unnecessary overrides of defaults
   # INDEXER_POLL_INTERVAL_MS=5000  # This is the default anyway
   ```

3. **Test configuration changes**: Run the app after modifying `.env`
   ```bash
   npm run dev
   ```

### Production

1. **Validate before deployment**: Test configuration in staging environment

2. **Use explicit values**: Don't rely on defaults in production
   ```bash
   # Production .env should be explicit
   PORT=8080
   INDEXER_POLL_INTERVAL_MS=5000
   INDEXER_BATCH_SIZE=100
   RATE_LIMIT_MAX=1000
   ```

3. **Monitor configuration**: Log configuration on startup (non-sensitive values)

4. **Document overrides**: Comment why you're using non-default values
   ```bash
   # Increased for high-traffic production environment
   RATE_LIMIT_MAX=5000
   
   # Reduced for slower RPC provider
   INDEXER_BATCH_SIZE=50
   ```

### Docker/Container Environments

1. **Use environment variables**: Override .env with container env vars
   ```yaml
   # docker-compose.yml
   environment:
     - PORT=8080
     - INDEXER_BATCH_SIZE=200
   ```

2. **Validate in health checks**: Ensure startup succeeds
   ```yaml
   healthcheck:
     test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
     interval: 30s
     timeout: 10s
     retries: 3
     start_period: 40s
   ```

### Kubernetes

1. **Use ConfigMaps for non-sensitive config**:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: backend-config
   data:
     PORT: "8080"
     INDEXER_BATCH_SIZE: "200"
     RATE_LIMIT_MAX: "1000"
   ```

2. **Use Secrets for sensitive values**:
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: backend-secrets
   data:
     DATABASE_URL: <base64-encoded>
   ```

## Troubleshooting

### Application Won't Start

**Symptom**: Application exits immediately with configuration error

**Diagnosis**:
1. Check the error message for the specific variable and value
2. Verify the `.env` file has valid values
3. Check for typos in variable names
4. Ensure numeric values are actually numbers

**Solution**:
1. Fix the problematic value in `.env`
2. Or remove the variable to use the default
3. Restart the application

### Configuration Seems Ignored

**Symptom**: Changes to `.env` don't take effect

**Possible Causes**:
1. **Wrong network**: Check `STELLAR_NETWORK` value
   - Config loads `.env.testnet`, `.env.mainnet`, or `.env.devnet` first
   - Network-specific files override base `.env`

2. **Environment variable precedence**: System env vars override `.env`
   ```bash
   # Check for conflicting system env vars
   printenv | grep -i port
   ```

3. **Cached modules**: In development, modules might be cached
   ```bash
   # Clear cache and restart
   rm -rf node_modules/.cache
   npm run dev
   ```

### Testing Configuration Changes

```bash
# Test with custom configuration
PORT=4000 INDEXER_BATCH_SIZE=50 npm run dev

# Test with empty values (uses defaults)
PORT= INDEXER_BATCH_SIZE= npm run dev

# Test with invalid values (should fail)
PORT=abc npm run dev  # Should exit with error
```

## Implementation Details

### Validation Function

The `parseNumericEnv` function handles all numeric environment variable parsing:

```typescript
function parseNumericEnv(
  name: string,              // Variable name for error messages
  envValue: string | undefined,  // Raw env value
  defaultValue: number,      // Fallback if not set
  schema: z.ZodNumber,       // Zod schema for validation
): number
```

**Process**:
1. Check if value is empty → use default
2. Parse with `parseInt(envValue, 10)`
3. Check for `NaN` → throw error
4. Validate against Zod schema → throw error if invalid
5. Return validated number

### Schema Definitions

All schemas are defined in `src/config.ts`:

```typescript
const envSchemas = {
  port: z.number().int().positive().max(65535),
  indexerStartLedger: z.number().int().min(0),
  indexerPollIntervalMs: z.number().int().positive().min(100),
  // ... etc
};
```

### Extending Validation

To add validation for a new numeric environment variable:

1. **Add schema definition**:
   ```typescript
   const envSchemas = {
     // ... existing schemas
     myNewValue: z.number().int().positive().max(1000),
   };
   ```

2. **Parse the value**:
   ```typescript
   const myNewValue = parseNumericEnv(
     'MY_NEW_VALUE',
     process.env.MY_NEW_VALUE,
     100,  // default
     envSchemas.myNewValue,
   );
   ```

3. **Add to config object**:
   ```typescript
   export const config = {
     // ... existing config
     myNewValue,
   };
   ```

4. **Document in .env.example**:
   ```bash
   # My new configuration value
   MY_NEW_VALUE=100
   ```

5. **Update this documentation** with the new variable

## References

- [Zod Documentation](https://zod.dev/)
- [Environment Variables Best Practices](https://12factor.net/config)
- [Node.js Environment Variables](https://nodejs.org/api/process.html#processenv)
