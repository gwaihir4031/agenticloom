# Auth API redesign

The current auth API has the following issues:

1. JWT tokens are signed with HS256 — symmetric algorithm, secret shared across all services
2. No token revocation mechanism — once issued, tokens are valid until expiry (15 min)
3. Refresh tokens are stored as plaintext in the database
4. CORS is configured to wildcard origin in dev, easy to forget when promoting to prod

## Goal

Replace HS256 with RS256 (asymmetric). Add token revocation list with TTL matching refresh-token expiry. Encrypt refresh tokens at rest using AES-256-GCM. Lock CORS origins per environment via config.

## Constraints

- Must remain backward-compatible with mobile clients during transition (180-day overlap window)
- All migration work coordinated with platform team — see SLO impact section
