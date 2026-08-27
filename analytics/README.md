# Analytics (Phase 5 — not yet implemented)

The point of the whole system (spec §6): correlate **events** (what I did) with
**snapshots/stats** (what happened). Deliver as SQL views / materialized views
first; dashboard later.

- **Before/after:** window an entity's metrics around an event (`photo_changed`,
  `price_change`, `ad_on`) — N days before vs after (views, favorites,
  conversion, revenue).
- **Control group:** untouched, comparable listings over the same period to net
  out seasonality/traffic trend. *"Net effect = treated Δ − control Δ."*
- **Shop-level strategy tracking:** change points on `stats_daily` vs trend breaks.
- **Cohort/segment:** personalized vs standard, by section, by price band.
- **Health scores:** response time, review average/trend, active-listing ratio,
  deactivation ratio.
- **Response time (§5.1):** first `out` after an `in`, per thread; summarize in a
  materialized view (avg, median, first-response).
