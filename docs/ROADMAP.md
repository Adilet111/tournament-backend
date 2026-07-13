# Roadmap

Where the project stands and what to build next, in order. The schema header
in `src/db/schema.ts` already names the missing tables:
`rating_events, sponsors, competition_sponsors, applications, payments,
matches, match_participants`.

## Now working

Google login → JWT sessions · per-sport profiles with questionnaire-seeded
ratings (football, basketball) · admin tournament CRUD with lifecycle ·
player registration with profile/rating/capacity gates (atomic, race-safe) ·
withdraw/reinstate · admin participant management and user lookup ·
occupied/free places tracking.

## 1. Matches & results (the core loop is incomplete without it)

- Tables: `matches` (tournamentId, round, scheduledAt, status, score),
  `match_participants` (matchId, userId, result).
- Admin endpoints: create/generate bracket from registered players, record
  results; public: view bracket/results.
- Replace the free-text `bracketInfo` with generated single-elimination
  pairings (seed by rating).

## 2. Rating updates from results

- `rating_events` table: one row per rating change (userId, sportId, delta,
  reason, matchId) — audit trail, enables rating history graphs.
- Elo update on match completion; reuse `place()` from `rating.ts` to
  recompute tier/division. The profile JSONs already carry `lpScale`/tiers.

## 3. Payments (paid tournaments)

- `payments` table (userId, tournamentId, amount, currency, provider,
  providerRef, status) + `applications` if registration should be
  pending-until-paid.
- Env already reserves a slot for the gateway key (see TODO in env.ts —
  e.g. IOKA for KZT). Flow: register → payment intent → webhook confirms →
  registration flips to `registered`. Idempotent webhook handling.

## 4. Hardening (small, high value)

- **Rate limiting**: `@fastify/rate-limit` on `/auth/login` and registration.
- **Apple sign-in**: `verifyToken` has the stub; verify against Apple JWKS.
- **Refresh tokens / re-login UX**: access tokens now expire (7d); decide
  between silent re-login via Google SDK or a refresh-token table.
- Drop the deprecated `competitions` table + route once the frontend stops
  calling `/api/competitions`.
- `GET /tournaments` pagination (`?limit=&offset=`) and filters
  (sport, city, date range) before the list grows.

## 5. Testing & CI

- Add vitest + fastify `app.inject()` integration tests against a dockerized
  Postgres (testcontainers or compose service). Priority coverage:
  registration gates (capacity race, rating bounds, re-register after
  withdraw), status transitions, onboarding scoring.
- GitHub Action: typecheck + tests + `npm audit` on PR.

## 6. Ops

- Structured deploy (the "redeploy" commits suggest manual): build image in
  CI, push to registry, `docker compose pull && up -d` on the VPS.
- Postgres backups (pg_dump cron or volume snapshots).
- `/health` should ping the DB (`select 1`) so the healthcheck means something.
- Observability: request-id logging is built into Fastify; add error alerting
  (e.g. Sentry) when there are real users.
