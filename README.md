# Tournament platform — backend (backbone)

A minimal but runnable skeleton: Fastify + Drizzle (Postgres) + TypeScript.
It boots, has auth/RBAC scaffolding, a typed config, a DB layer, and one
example module. Build the rest of the domain on top of these patterns.

## Layout

```
src/
  index.ts                 entrypoint
  app.ts                   Fastify wiring + error handler (register routes here)
  config/env.ts            typed env (zod)
  db/
    schema.ts              core tables (users, auth_identities, sports, competitions)
    client.ts              drizzle client
    migrate.ts             migration runner
  plugins/auth.ts          JWT + authenticate / requireRole
  lib/                     AppError, zod parse helper
  modules/
    auth/auth.routes.ts    OAuth login backbone (verify is a TODO stub)
    competitions/          example module — copy its shape for the rest
```

## Run it

```bash
cp .env.example .env          # set JWT_SECRET and ADMIN_EMAILS
docker compose up -d db
npm install
npm run db:generate           # SQL from schema
npm run db:migrate
npm run dev                   # GET http://localhost:3000/health -> {"status":"ok"}
```

## To extend

- **Add a table:** define it in `db/schema.ts`, run `npm run db:generate && npm run db:migrate`.
- **Add a feature:** create `src/modules/<name>/<name>.routes.ts` following
  `competitions.routes.ts` (zod validation, `requireRole` for admin actions,
  Drizzle queries), then `app.register(...)` it in `app.ts`.
- **Still to build:** sport profiles + rating engine, applications, payments
  (use a Kazakh gateway like ioka — Stripe isn't available to KZ businesses),
  sponsors, matches. The data model for these is noted at the top of `schema.ts`.

## TODO before production

1. Implement `verifyToken` in `auth.routes.ts` (Google + Apple signature checks).
2. Add the payment gateway + webhook.
3. Add a `pg_dump` backup cron (self-hosting means you own backups).
