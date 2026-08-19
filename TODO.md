# TODO

(nothing pending)

# Done

## WiFi session cooldown (per client MAC) — DONE 2026-08-18

Implemented in api/server.js using the upstash-kv-coffee-jacket store.
Cooldown defaults to 30 minutes; override with the WIFI_COOLDOWN_SECONDS env
var (no redeploy needed beyond the env change). Cooldown page: api/cooldown.html.

**Design (agreed 2026-08-18):**
- Store `grant:<client_mac> = grant timestamp` in Upstash Redis (Vercel
  Marketplace, free tier — ~2 commands/submit, well under the 500K/month cap)
  with TTL = 30 min + cooldown.
- On submit: no record → grant; record < 30 min old → grant again (devices can
  get re-splashed mid-session when roaming between APs); record ≥ 30 min old →
  show a friendly "you've used your 30 minutes, come back in X" page styled
  like the splash page.
- Fail open: if Redis is unreachable or rate-limited, grant anyway (matches
  the Drip fail-open behavior — storage problems must not block park WiFi).
- Use the Upstash REST API via fetch; no new npm dependency.

**Known limitations (accepted):** iOS/Android private Wi-Fi addresses can
rotate the MAC (forget/rejoin network resets the cooldown); client_mac comes
from the referer query string so it is spoofable. It's a speed bump, not a wall.
