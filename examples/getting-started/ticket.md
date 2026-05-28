# Ticket: in-memory rate limiter middleware

**As an** API operator
**I want** a per-IP rate limiter for our Express API
**so that** a single client cannot exhaust the service.

## Requirements
- Token-bucket algorithm, in-memory (no Redis).
- Configurable: requests-per-window and window length (ms).
- Keyed per client IP (`req.ip`).
- On limit exceeded: respond `429 Too Many Requests` with a
  `Retry-After` header (seconds until a token frees up).
- Exported as Express middleware: `rateLimiter(opts) => (req,res,next)`.

## Out of scope
- Distributed/multi-process coordination.
- Per-route or per-user (vs per-IP) limits.
