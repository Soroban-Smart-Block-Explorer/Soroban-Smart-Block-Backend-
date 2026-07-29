# API Versioning Policy

This document outlines the API versioning strategy, Accept-Version header negotiation, deprecation headers, and the lifecycle policy for the Soroban Smart Block Explorer API.

## Versioning Strategy

The API supports two methods of versioning:
1. **Path-Based Versioning**: Routes are mounted under `/api/v1`.
2. **Header-Based Version Negotiation**: Clients can request specific versions via the `Accept-Version` HTTP header (e.g., `Accept-Version: v1`, `Accept-Version: 1.0`, or `Accept-Version: 1.x`).

If the request path does not explicitly start with `/v1/`, the versioning middleware negotiates the version based on the `Accept-Version` header (defaulting to `v1`) and rewrites the path internally to route it to the appropriate versioned router.

If a client requests an unsupported API version (e.g. `v2`), the server will reject the request with status code `406 Not Acceptable`.

## Response Headers

For every negotiated request, the API includes metadata about the version and its lifecycle status in the response headers:

- `X-API-Version`: The version that was negotiated and served (e.g., `v1`).
- `Deprecation`: If `true`, indicates that this version is deprecated.
- `Sunset`: The date/time when this version will be completely retired (RFC 7231 format).
- `Link`: A link relation referencing this policy for deprecation details.

Example headers on a deprecated `v1` endpoint response:
```http
X-API-Version: v1
Deprecation: true
Sunset: Wed, 11 Nov 2026 23:59:59 GMT
Link: <https://api.example.com/docs/versioning>; rel="deprecation"; type="text/html"
```

## Lifecycle Policy

To allow the platform to evolve while supporting existing integrations, versions transition through three stages:

1. **Active**: The version is fully supported, actively maintained, and recommended for new integrations.
2. **Deprecated**: The version is functional but scheduled for retirement. A `Deprecation` header is attached, and a `Sunset` date is set. New features are not backported.
3. **Retired**: The version is no longer available. Requests to retired paths or versions will return `406 Not Acceptable` or `404 Not Found`.
