# TODO

## WiFi session cooldown (per client MAC)

Prevent guests from immediately rejoining after using their 30-minute session.

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

**Blocked on:**
1. Provision Upstash Redis: Vercel project → Storage tab → Create Database →
   Upstash for Redis (free plan). Injects REST URL/token env vars.
2. Decide cooldown length (30 min? 1 hour?).
3. Copy for the cooldown page.

**Known limitations (accepted):** iOS/Android private Wi-Fi addresses can
rotate the MAC (forget/rejoin network resets the cooldown); client_mac comes
from the referer query string so it is spoofable. It's a speed bump, not a wall.
