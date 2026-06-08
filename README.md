# alias-proxy-api

Production alias indexer for `alias.ecash.mx`. Downstream clients such as Tonalli Wallet alias payments, `ecash.mx/identidad`, `reputation.ecash.mx`, and assembly/reputation flows depend on this service continuing to resolve aliases during Chronik outages or process restarts.

## Configuration

```env
PORT=3014
CHRONIK_URL=https://chronik.xolosarmy.xyz
ALLOWED_ORIGIN=https://ecash.mx,https://cartera.xolosarmy.xyz,https://app.tonalli.cash,http://localhost:5173,http://127.0.0.1:5173
ALIAS_REFRESH_INTERVAL_MS=300000
```

`ALLOWED_ORIGIN` accepts a comma-separated list of trusted frontend origins for CORS.

`ALIAS_REFRESH_INTERVAL_MS` controls the automatic background refresh cadence. It defaults to `300000` ms.

## Snapshot And Refresh Behavior

On startup, the service first tries to load `data/alias-index-snapshot.json`. If the snapshot is valid, confirmed aliases are served immediately from disk and `snapshotLoaded` is reported in `/health`. If the snapshot is missing or corrupted, startup continues and the service attempts a Chronik refresh in the background.

Refreshes are fail-safe: the current in-memory alias maps are not replaced until a full Chronik scan succeeds and a new snapshot is written atomically through `data/alias-index-snapshot.json.tmp` followed by rename. If Chronik is unavailable, the previous cache remains available, `/health` reports `lastRefreshError`, and `/refresh` returns `cachePreserved: true`.

The server starts listening before the initial Chronik refresh finishes. Automatic refreshes run on an interval and are skipped when another refresh is already in progress.

## Endpoints

- `GET /health` returns cache counts, refresh state, snapshot state, and the configured refresh interval.
- `GET /refresh` triggers a manual refresh. Successful responses include `snapshotWritten: true`; failed Chronik refreshes preserve the current cache; overlapping refreshes return `Refresh already in progress`.
- `GET /alias/:alias` resolves a confirmed alias, or a pending alias when present.
- `GET /aliases` lists aliases and supports `includePending=true`.
- `GET /aliases/search?q=<query>` searches aliases and supports `includePending=true`.
