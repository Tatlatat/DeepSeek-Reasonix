# Configuration Reference

Reasonix reads configuration from `~/.reasonix/config.json`. Per-project overrides live under `<project>/.reasonix/config.json`.

## Config Keys

### Cost & Pricing

- `contextTokens` (object, default none): override the context window for specific models. E.g. `{ "my-custom-model": 200000 }`.
- `pricingOverride` (object, default none): override pricing for specific models. E.g. `{ "my-custom-model": { "inputCacheHit": 0.001, "inputCacheMiss": 0.01, "output": 0.01 } }`.

### Cache Economics

- `cacheBustProbability` (number, default 0.15): probability the prompt cache expires before the next turn, used by fold economics. Higher values cause large sessions to fold sooner, keeping cache-bust reloads cheap. Set to `0` to disable the bust-risk term (legacy behavior).
- `keepaliveEnabled` (boolean, default true): keep the DeepSeek prompt cache warm during idle gaps by periodically pinging the prefix, so a long pause does not cause an expensive full-prompt cache miss on the next turn.
- `keepaliveIntervalMs` (number, default 240000): milliseconds between idle keepalive pings; keep it under the cache TTL (~5 minutes).
- `keepaliveMaxPings` (number, default 10): maximum consecutive idle pings before keepalive stops, so an abandoned session does not ping indefinitely.
