RATE-1: Token bucket rate limiting on /api/v1/\*

As a platform operator I want to cap how many requests a single client
can make against our public API so a misbehaving client cannot exhaust
resources for the rest.

Behaviour:

- Applies to every route under /api/v1/\*.
- Client identity is the value of the X-Api-Key request header. A
  request with no key is rejected with 401 before the limiter runs.
- Default limit: 100 requests per 60-second window per key. Sliding
  window via token bucket (steady refill, not fixed 60-second resets).
- Per-tier overrides: free 100/min, pro 1000/min, enterprise 10000/min.
  Tier is looked up from the existing api_keys table.
- When the limit is exceeded, respond with HTTP 429 and a
  Retry-After header (integer seconds until the next token).
- Limit and tier configuration must be reloadable without a deploy
  (config file watcher or admin endpoint — open question for design).
- Emit a metric `rate_limit.exceeded{tier,key_hash}` on every 429 so
  the existing observability dashboards pick it up.

Non-goals for this ticket:

- Per-route limits (every /api/v1/\* route shares one bucket per key).
- IP-based limiting (key-based only).
- Cluster-wide coordination (single-process counters are acceptable
  for v1; multi-process is a follow-up).
