# tournament_backend

Sports tournament platform API. Players sign in with Google, create per-sport
profiles (a questionnaire seeds an Elo-style rating), and register for
tournaments created by admins.

**Stack:** Fastify 5 + Drizzle ORM (postgres-js) + PostgreSQL 16 + Zod, TypeScript, Node 20.

## Commands

```bash
npm run dev          # tsx watch src/index.ts (reads .env, reloads on change)
npm run build        # tsc + copy profile JSONs into dist (copy:assets)
npm run typecheck    # tsc --noEmit — run after every change
npm run db:generate  # drizzle-kit: diff src/db/schema.ts -> new SQL in drizzle/
npm run db:migrate   # apply migrations from drizzle/ (tsx src/db/migrate.ts)
npm start            # node dist/index.js (production)
```

There are no automated tests yet. Verify with `npm run typecheck`, then boot
the app and `app.inject()` or curl `/api/health`.

## Architecture

- `src/index.ts` → `src/app.ts` (`buildApp()`): CORS, JWT plugin, error
  handler, then every module route under the **`/api` prefix** (nginx proxies
  `/api` to this service; the frontend owns `/`).
- `src/modules/<name>/<name>.routes.ts` — one file per domain, each exports an
  `async function xxxRoutes(app)`. Registered in `app.ts`.
- `src/db/schema.ts` — single Drizzle schema file for all tables.
- `src/plugins/auth.ts` — decorates `app.authenticate` and
  `app.requireRole('admin')`; use as `preHandler`. JWTs carry
  `{ sub, email, role }` and expire after `JWT_TTL` (default 7d).
- `src/lib/validate.ts` `parse(schema, data)` — Zod parse that throws
  `AppError(400)`. `src/lib/errors.ts` `AppError(message, statusCode)` is the
  one error type; the global handler turns it into `{ error: message }`.

### Domain rules (keep these invariants)

- **Tournaments** are the real entity. **Competitions are deprecated** — only a
  read-only list route remains; don't build on them.
- Registration requires: tournament `open` → sport profile exists → rating
  within `minRating..maxRating` (when set) → not already registered → capacity
  free. Error order and messages matter to the frontend.
- `tournaments.occupiedPlaces` is a **denormalized count** of
  `status='registered'` rows. Every write to `tournament_registrations` must
  keep it in sync (see `syncOccupiedPlaces` / `registerAtomically` in
  `tournaments.routes.ts`). Player registration goes through
  `registerAtomically` — a transaction that locks the tournament row so
  capacity can't be overbooked. Admin flows bypass the capacity/rating gates
  by design.
- Status lifecycles are enforced via `ALLOWED_TRANSITIONS`
  (draft→open→closed→completed, cancel from any active state).
- Admin role is granted at **first sign-in** to emails in `ADMIN_EMAILS`.
  Role lives in the JWT, so role changes need a re-login.

### Sport profiles / rating engine

- Each sport = one `src/modules/profiles/definitions/<sport>.profile.json`.
  `rating.ts` loads them all at startup keyed by the JSON's `sport` field and
  **caches the registry** — a running server won't see a new file until restart.
- Adding a sport needs BOTH the JSON file AND a `sports` DB row whose `slug`
  exactly matches the JSON's `sport` value (`POST /sports`, admin).
- Scoring: `core = (anchor + beforeRustAdditives - BASE) * rust;
  elo = clamp(BASE + core + afterRustAdditives, FLOOR, CAP)`.

## Gotchas

- `dist/` is what runs in production. Profile JSONs reach it only via the
  `copy:assets` build step — after adding a definition, rebuild (or use
  `npm run dev`, which reads `src/` directly).
- Migrations: edit `src/db/schema.ts`, run `npm run db:generate`, review the
  SQL (add backfills by hand — e.g. `0005` backfills `occupied_places`), then
  `npm run db:migrate`. Never edit applied migrations.
- `docker-compose.yml` binds Postgres to `127.0.0.1` on purpose — Docker
  bypasses ufw, so `0.0.0.0` would expose it to the internet.
- First deploy run: `docker compose run --rm api node dist/db/migrate.js`.
- Set `CORS_ORIGINS` in production; empty means "reflect any origin" (dev only).

## Environment (.env, validated in src/config/env.ts)

`DATABASE_URL`, `JWT_SECRET` (required); `PORT`, `HOST`, `NODE_ENV`,
`JWT_TTL`, `ADMIN_EMAILS`, `CORS_ORIGINS`, `GOOGLE_CLIENT_ID`,
`APPLE_CLIENT_ID` (optional). Invalid env kills the process at startup.
