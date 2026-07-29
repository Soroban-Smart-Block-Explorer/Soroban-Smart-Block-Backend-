# ADR-004: RBAC vs API Key Auth Split

## Status
Accepted

## Context
The platform serves two distinct client types: end-user browsers (human sessions) and programmatic API consumers (servers, bots). A single auth mechanism cannot optimally serve both.

## Decision
Split authentication into two parallel systems:
- **RBAC / session auth** — JWT + refresh tokens for human users via `/login`, `/register`, protected by `requireAuth` middleware
- **API key auth** — scoped API keys (`public`, `developer`, `premium`) with tiered rate limits, validated via `requireApiKey` middleware

Both systems share the same user model but enforce different authorization rules. Admin routes require RBAC with elevated roles.

## Consequences
- Human and machine clients get auth mechanisms tailored to their needs
- Rate limiting can be tiered independently
- Security surface is smaller because each middleware only handles one auth model
