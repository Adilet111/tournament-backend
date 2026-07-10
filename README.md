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
npm run dev                   # GET http://localhost:3000/api/health -> {"status":"ok3"}
```

## API endpoints

**All routes are served under the `/api` prefix** (e.g. `GET /api/tournaments`).
The paths in the tables below omit it for brevity.

Legend: 🔓 public · 🔒 any logged-in user · 👑 admin only.
Full request/response examples with curl live in [`docs/tournament-admin-api.md`](docs/tournament-admin-api.md).

**Health**

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | 🔓 | liveness check |

**Auth**

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/login` | 🔓 | exchange an OAuth id token for a session JWT |
| GET | `/auth/me` | 🔒 | current user from the token |

**Sports & profiles**

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/sports` | 🔓 | list sports |
| POST | `/sports` | 👑 | create a sport |
| GET | `/questions` | 🔓 | onboarding questions for every sport with a profile definition |
| GET | `/sports/:slug/questions` | 🔓 | onboarding questions for one sport |
| POST | `/sports/:slug/profile` | 🔒 | create/update your profile; returns rating + placement (tier/division/lp) |
| GET | `/sports/:slug/profile` | 🔒 | your profile for a sport |
| GET | `/profiles/:slug` | 🔒 | your profile for a sport (alias of the above) |
| GET | `/me/profiles` | 🔒 | all of your sport profiles |

**Tournaments — player**

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/tournaments` | 🔓 | list open tournaments |
| GET | `/tournaments/:id` | 🔓 | one tournament + registered count |
| POST | `/tournaments/:id/register` | 🔒 | self-register (rating- and capacity-gated) |
| POST | `/tournaments/:id/withdraw` | 🔒 | self-withdraw |

**Tournaments — admin**

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/tournaments` | 👑 | create a tournament |
| GET | `/admin/tournaments` | 👑 | list all tournaments (any status; `?status=` filter) |
| PATCH | `/tournaments/:id` | 👑 | edit fields + move through lifecycle status |
| DELETE | `/tournaments/:id` | 👑 | delete (only when it has no registrations) |
| GET | `/tournaments/:id/registrations` | 👑 | view participants (name, email, rating, status) |
| POST | `/tournaments/:id/registrations` | 👑 | add a participant (admin override) |
| PATCH | `/tournaments/:id/registrations/:userId` | 👑 | change a participant's status |
| DELETE | `/tournaments/:id/registrations/:userId` | 👑 | remove a participant |

**Users — admin**

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/admin/users/:id` | 👑 | one user's full record: account, all sport profiles, tournament history |

**Competitions** *(deprecated — superseded by tournaments)*

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/competitions` | 🔓 | list open competitions (legacy) |

## To extend

- **Add a table:** define it in `db/schema.ts`, run `npm run db:generate && npm run db:migrate`.
- **Add a feature:** create `src/modules/<name>/<name>.routes.ts` following
  `competitions.routes.ts` (zod validation, `requireRole` for admin actions,
  Drizzle queries), then `app.register(...)` it in `app.ts`.
- **Still to build:** sport profiles + rating engine, applications, payments
  (use a Kazakh gateway like ioka — Stripe isn't available to KZ businesses),
  sponsors, matches. The data model for these is noted at the top of `schema.ts`.

## TODO before production

1. Implement       "status": "open",                                                                                                                                                                                                             
      "createdAt": "2026-07-01T09:30:00.000Z",                                                                                                                                                                                      
      "freePlaces": 20                                                                                                                                                                                                              
    },                                                                                                                                                                                                                              
    {                                                                                                                                                                                                                               
      "id": "b7c6d5e4-3f2a-4b1c-9d8e-0f1a2b3c4d5e",                                                                                                                                                                                 
      "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",                                                                                                                                                                            
      "createdBy": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",                                                                                                                                                                          
      "title": "Open Play Ladder",                                                                                                                                                                                                  
      "description": null,                                                                                                                                                                                                          
      "type": "free",                                                                                                                                                                                                               
      "location": "Community Courts",                                                                                                                                                                                               
      "city": "Astana",                                                                                                                                                                                                             
      "startsAt": "2026-07-20T10:00:00.000Z",                                                                                                                                                                                       
      "prizePool": 0,                                                                                                                                                                                                               
      "entryFee": 0,                                                                                                                                                                                                                
      "currency": "KZT",                                                                                                                                                                                                            
      "bracketInfo": null,                                                                                                                                                                                                          
      "capacity": null,                                                                                                                                                                                                             
      "occupiedPlaces": 8,                                                                                                                                                                                                          
      "minRating": null,                                                                                                                                                                                                            
      "maxRating": null,                                                                                                                                                                                                            
      "status": "open",                                                                                                                                                                                                             
      "createdAt": "2026-07-05T12:00:00.000Z",                                                                                                                                                                                      
      "freePlaces": null                                                                                                                                                                                                            
    }                                                                                                                                                                                                                               
  ]    `verifyToken` in `auth.routes.ts` (Google + Apple signature checks).
2. Add the payment gateway + webhook.
3. Add a `pg_dump` backup cron (self-hosting means you own backups). 2
