# Agent Architecture Design Document

## 1. Overview

The Agent Runtime enables users to deploy autonomous agents that interact with Soroban smart contracts through the explorer platform. Agents execute in a WASM-based sandbox with fine-grained permissions, deterministic execution, and full audit trails.

### Key Design Principles

- **Deterministic**: Given identical input state, an agent produces identical decisions and actions
- **Verifiable**: Third-party verification nodes can independently validate execution traces
- **Secure**: Agents cannot exceed granted permissions or resource limits
- **Auditable**: Every action is logged with reasoning, input state, and cryptographic signature
- **Composable**: Agents communicate via asynchronous message bus for complex workflows

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Runtime Engine                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Lifecycle │  │ Permission│  │ Resource │  │   Audit   │ │
│  │  Manager  │  │   Guard   │  │  Enforcer│  │   Logger  │ │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │              │              │              │        │
│  ┌────▼──────────────▼──────────────▼──────────────▼─────┐ │
│  │                 Sandbox Runtime (WASM)                 │ │
│  │     ┌──────────────┐  ┌──────────────┐                │ │
│  │     │  Execution   │  │  State Store │                │ │
│  │     │  Sandbox     │  │  (In-memory) │                │ │
│  │     └──────────────┘  └──────────────┘                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐
│   Agent-to-Agent  │  │    Marketplace   │  │  Monitoring & │
│   Message Bus     │  │   & Templates    │  │   Analytics   │
│  ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌───────────┐ │
│  │Discovery     │ │  │ │Template      │ │  │ │Dashboard  │ │
│  │Registry      │ │  │ │Repository    │ │  │ │Alerts     │ │
│  │Negotiation   │ │  │ │Billing       │ │  │ │Traces     │ │
│  │Reputation    │ │  │ │Auth          │ │  │ │Metrics    │ │
│  └──────────────┘ │  │ └──────────────┘ │  │ └───────────┘ │
└──────────────────┘  └──────────────────┘  └───────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Verification Network                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ Verifier 1 │  │ Verifier 2 │  │ Verifier N │            │
│  └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## 3. Agent Lifecycle

```
Deploy ──► Validate ──► Activate ──► Running ──► Paused ──► Terminated ──► Archived
               │                       │            │              │
               │                       │            │              │
               ▼                       ▼            ▼              ▼
           (failed)              (auto-pause)  (manual/auto)   (after 30d)
```

### States

| State | Description | Transition |
|-------|-------------|------------|
| `deployed` | Agent code uploaded, not yet validated | → `validating` |
| `validating` | Deterministic execution test running | → `active` or `terminated` |
| `active` | Validated, ready to start | → `running` |
| `running` | Executing actions per schedule | → `paused` or `terminated` |
| `paused` | Temporarily halted (manual or auto) | → `running` or `terminated` |
| `terminated` | Stopped permanently | → `archived` |
| `archived` | Data preserved, no longer active | — |

## 4. Permissions Model

### Capability Tokens

Each permission is a structured capability token signed by the agent owner:

```
{
  "capability": "can_swap" | "can_lend" | "can_vote" |
                "can_transfer" | "can_deploy",
  "agentId": "uuid",
  "maxAmount": "1000",           // Optional: per-action limit
  "contracts": ["CA...", ...],   // Optional: allowed contracts
  "expiresAt": 1712345678,       // Optional: expiration timestamp
  "nonce": "random",
  "signature": "owner_signature" // Ed25519 signature by owner
}
```

### Permission Enforcement

When an agent attempts an action, the Permission Guard:

1. Extracts the required capability from the action
2. Finds the matching capability token in the agent's permissions
3. Verifies the owner's signature on the token
4. Checks action against token constraints (amount, contract, expiry)
5. Rejects with clear error if any check fails

### Default Permission Sets

| Template | Permissions |
|----------|-------------|
| DCA | `can_swap` (limited to specific pairs, daily limit) |
| Governance | `can_vote` (only enabled proposals) |
| Yield Optimizer | `can_swap`, `can_lend` |
| MEV Protector | `can_transfer` (wrapping transactions) |
| Stop-loss | `can_swap` (only liquidation actions) |
| Liquidation Sniper | `can_swap`, `can_transfer` |
| Compliance | none (monitor-only) |

## 5. Resource Limits

Each agent has configurable resource limits:

```json
{
  "maxGasPerExecution": 1000000,
  "maxGasPerDay": 10000000,
  "maxExecutionsPerDay": 100,
  "maxStorageBytes": 1048576,
  "maxConcurrentCalls": 5,
  "maxDrawdownPercent": 20.0
}
```

Limits are enforced by the Resource Enforcer before every execution. Exceeding any limit pauses the agent and triggers an alert.

## 6. Agent-to-Agent Communication Protocol

### Message Types

- `request`: Agent A requests a service from Agent B
- `negotiate`: Agents negotiate terms (price, scope, duration)
- `accept` / `reject`: Response to negotiation
- `execute`: Service execution notification
- `complete`: Service delivery confirmation
- `escalate`: Agent escalates to human operator
- `rate`: Post-interaction rating

### Message Format

```json
{
  "id": "uuid",
  "type": "request",
  "fromAgentId": "uuid",
  "toAgentId": "uuid",
  "subject": "string",
  "body": {
    "serviceType": "mev_protection",
    "params": { "transactions": 100, "budget": "500" },
    "deadline": "ISO8601"
  },
  "signature": "agent_signature",
  "timestamp": "ISO8601"
}
```

### Discovery Registry

Agents register capabilities in a registry:

```json
{
  "agentId": "uuid",
  "capabilities": ["mev_protection", "flashbots"],
  "pricePerCall": "0.5",
  "rating": 4.8,
  "totalJobsCompleted": 152
}
```

### Negotiation Flow

1. Agent A queries registry for agents with required capability
2. Agent A sends `request` with proposed terms
3. Agent B responds with `negotiate` (counter-offer) or `accept`
4. After agreement, agents proceed with service execution
5. Upon completion, both agents submit mutual ratings

## 7. Deterministic Execution & Verification

### Determinism Requirements

For an execution to be deterministic:

1. **Input state** must be fully captured (JSON-serialized sandbox state snapshot)
2. **Agent code** must be pure with respect to state (no random, no time, no external calls except through defined interfaces)
3. **Decisions** must be deterministic functions of (input_state + agent_config)
4. **Output action** must be uniquely determined by decision

### Verification Protocol

1. Agent executes action, produces execution trace
2. Trace is hashed and signed by the agent runtime
3. Verification nodes independently replay the execution from the same input state snapshot
4. Nodes compare their output hash with the agent's claimed output hash
5. Nodes sign their verification result
6. If verification fails, the agent is flagged and circuit breaker may trigger

### Execution Trace Structure

```json
{
  "executionId": "uuid",
  "agentId": "uuid",
  "inputStateHash": "sha256",
  "steps": [
    {
      "stepIndex": 0,
      "description": "Check pool reserves",
      "input": { "pool": "CA...", "reserveA": "1000", "reserveB": "2000" },
      "reasoning": "Pool has sufficient liquidity for swap",
      "output": { "decision": "proceed" },
      "gasUsed": 5000
    },
    {
      "stepIndex": 1,
      "description": "Execute swap",
      "input": { "tokenIn": "CA...", "amountIn": "100" },
      "reasoning": "Swap 100 TokenA for ~50 TokenB at current rate, within 0.5% slippage",
      "output": { "action": "swap", "contractId": "CA...", "args": { ... } },
      "gasUsed": 45000
    }
  ],
  "outputAction": { "type": "swap", "params": { ... } },
  "finalStateHash": "sha256",
  "signature": "runtime_signature"
}
```

## 8. Agent Templates

### Template Format

Each template defines:
- **Code**: WASM binary (or DSL script) implementing agent logic
- **Schema**: JSON Schema for user configuration
- **ABI**: Function signatures for the agent's interface
- **Permissions**: Required capability tokens
- **Resource hints**: Suggested resource limits
- **Verification**: Expected behavior for validation

### Built-in Templates

| Template | Description | Key Config |
|----------|-------------|------------|
| **DCA** | Dollar-cost average buys on schedule | pair, amount, frequency, total buys |
| **Governance** | Auto-vote on proposals | voting strategy, delegate list |
| **Yield Optimizer** | Auto-compound, rebalance lending | pools, target APY, rebalance threshold |
| **MEV Protector** | Wrap txs to prevent frontrunning | private mempool, tip, gas strategy |
| **Stop-loss** | Health-factor based liquidation protection | position, health threshold, swap config |
| **Liquidation Sniper** | Claim undercollateralized positions | min profit, max gas, target pools |
| **Compliance** | Monitor and freeze suspicious activity | risk threshold, freeze strategy |

## 9. Circuit Breakers

### Automatic Circuit Breakers

- **Max drawdown**: If P&L drops below `-maxDrawdownPercent`, agent pauses
- **Failure rate**: If failure rate exceeds 10% in last 20 executions, agent pauses
- **Gas budget**: If daily gas cost exceeds limit, agent pauses
- **Verification failure**: If verification nodes detect discrepancy, agent flags

### Manual Circuit Breakers

- Owner can `pause` or `terminate` agent at any time
- Platform admin can `pause` agent with reason

## 10. Data Flow

```
1. User configures agent via API → Agent config stored in DB
2. Scheduler triggers agent execution → Runtime loads agent state
3. Permission Guard validates capability tokens
4. Resource Enforcer checks limits
5. Sandbox executes agent decision logic
6. Audit Logger records full execution trace
7. Output action is emitted (swap, vote, transfer, etc.)
8. Verification nodes validate trace asynchronously
9. Monitoring updates dashboard metrics
10. Agent registers rating if interacting with another agent
```

## 11. Security Considerations

- **Capability tokens** are signed client-side; runtime only verifies signatures
- **Execution sandbox** prevents agents from accessing DB, filesystem, or network
- **Resource limits** prevent DoS via runaway execution
- **Deterministic replay** enables fraud detection
- **Rate limiting** prevents spam on agent message bus
- **Escalation audit** logs all human interventions

## 12. API Endpoints

```
POST   /api/v1/agents                     # Deploy agent
GET    /api/v1/agents                     # List user's agents
GET    /api/v1/agents/:id                 # Get agent details
PATCH  /api/v1/agents/:id                 # Update agent config
POST   /api/v1/agents/:id/pause           # Pause agent
POST   /api/v1/agents/:id/terminate       # Terminate agent
POST   /api/v1/agents/:id/execute         # Manual execution trigger

GET    /api/v1/agents/:id/executions      # Execution history
GET    /api/v1/agents/:id/trace/:execId   # Full execution trace

GET    /api/v1/agents/templates           # List templates
GET    /api/v1/agents/templates/:id       # Get template details

POST   /api/v1/agents/messages            # Send agent message
GET    /api/v1/agents/messages            # List agent messages
GET    /api/v1/agents/messages/:id        # Get message detail

GET    /api/v1/agents/registry            # Capability registry
POST   /api/v1/agents/registry           # Register capabilities
POST   /api/v1/agents/ratings            # Submit rating

GET    /api/v1/agents/monitoring/dashboard # Metrics dashboard
GET    /api/v1/agents/monitoring/alerts   # Health alerts
GET    /api/v1/agents/monitoring/analytics # Strategy analytics

POST   /api/v1/agents/escalations         # Human handoff
GET    /api/v1/agents/escalations/:id     # Get escalation

GET    /api/v1/agents/verification/:execId # Verification status
POST   /api/v1/agents/verification/:execId/verify # Submit verification
```
