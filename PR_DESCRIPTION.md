# Fix: Replace hardcoded "simulated" status with real Soroban RPC simulation

## Issue
[#636] `protocol26-state-extension` returns hardcoded `"simulated"` status on line 166 of `src/api/protocol26-state-extension.ts`.

## Changes

### `src/api/protocol26-state-extension.ts`
- **Replaced the hardcoded stub** in `POST /contracts/:contractId/extend-ttl` with a real Soroban RPC `simulateTransaction` call
- **Builds a proper Stellar transaction** with `ExtendFootprintTTLOp` using the `@stellar/stellar-sdk` `TransactionBuilder`, including:
  - Correct `LedgerKey` construction based on `entryType` (instance/persistent/temporary)
  - Proper `SorobanTransactionData` with footprint
  - Dummy source account for simulation-only transactions (never submitted)
- **Returns real simulation results** including:
  - `status: 'success'` with CPU instructions, memory bytes, min resource fee, and transaction XDR
  - `status: 'failed'` with RPC error diagnostics (HTTP 422)
  - `status: 'error'` for network/timeout failures (HTTP 502/504)
- **Wrapped handler** with `asyncHandler` for proper error propagation
- **Added imports** for `SorobanRpc`, `TransactionBuilder`, `Account`, `Operation`, `BASE_FEE`, `xdr` from `@stellar/stellar-sdk`, and `rpc` from `../indexer/rpc`

### `tests/api/protocol26-state-extension.test.ts` (new)
- **Comprehensive test suite** covering all endpoints:
  - `GET /protocol26` - service info
  - `GET /contracts/:contractId/ttl` - TTL info
  - `POST /contracts/:contractId/extend-ttl` - **the main fix**:
    - Validation errors (missing fields, invalid ranges, invalid hex contract IDs)
    - Successful simulation (200)
    - Restore simulation (200)
    - All entry types (instance, persistent, temporary)
    - Simulation error (422)
    - Network error (502)
    - Timeout (504)
    - Default entryType
  - `GET /contracts/:contractId/entries` - storage entries
  - `GET /archive/stats` - archive statistics
  - `POST /footprint/optimize` - footprint optimization
  - `GET /expiring` - expiring contracts

## Testing
- All existing tests continue to pass
- New unit tests mock the RPC layer and verify all response paths
- The `orphaned-routers-integration.test.ts` tests for protocol26 routes remain unchanged and compatible

## Breaking Changes
None. The API contract is preserved - the response shape is enhanced with real simulation data instead of hardcoded values.