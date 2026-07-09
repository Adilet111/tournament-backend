# Tournament Management & Viewing API

Admin management + full visibility over tournaments and participants.

## Conventions

All routes are served under the **`/api`** prefix — it's baked into `$BASE` below.

```bash
# Set these first
BASE=https://ainura-the-best.kz/api       # or http://localhost:3000/api
TOKEN=<player-jwt>                        # from POST /api/auth/login
ADMIN_TOKEN=<admin-jwt>                   # a user whose role is "admin"
TID=<tournament-uuid>
UID=<user-uuid>
```

- **Auth:** `Authorization: Bearer <token>`. Admin routes require a token whose `role` is `admin` (else `403 forbidden`); missing/invalid token → `401 unauthorized`.
- **Bodies:** JSON. For `POST`/`PATCH` send `Content-Type: application/json`. Never send that header with an empty body — send `{}` or omit the header (Fastify rejects an empty JSON body).
- **Statuses:** tournament = `draft | open | closed | completed | cancelled`; registration = `registered | withdrawn`.

---

## Public / player

### List open tournaments
Only `open` tournaments; sorted by start date.
```bash
curl -s "$BASE/tournaments" | jq
```

### Get one tournament (+ registered count)
```bash
curl -s "$BASE/tournaments/$TID" | jq
```
`200` → the tournament plus `"registeredCount": <n>`. `404` if not found.

### Register (player, self)
No body. Requires an `open` tournament, a sport profile in that sport, rating within band (if set), a free slot (if capacity set).
```bash
curl -s -X POST "$BASE/tournaments/$TID/register" \
  -H "Authorization: Bearer $TOKEN"
```
`201` registration row · `403` no profile / rating out of band · `409` not open / already registered / full.

### Withdraw (player, self)
```bash
curl -s -X POST "$BASE/tournaments/$TID/withdraw" \
  -H "Authorization: Bearer $TOKEN"
```
`200` → registration with `status: "withdrawn"` · `404` if you weren't registered.

---

## Admin — manage tournaments

### Create
```bash
curl -s -X POST "$BASE/tournaments" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "sportId": "<sport-uuid>",
    "title": "Summer Cup",
    "description": "City-wide 5v5",
    "type": "paid",
    "location": "Central Arena",
    "city": "Almaty",
    "startsAt": "2026-08-01T15:00:00Z",
    "prizePool": 200000,
    "entryFee": 5000,
    "currency": "KZT",
    "capacity": 32,
    "minRating": 1200,
    "maxRating": 2000
  }'
```
`201` created (starts as `open`). Paid tournaments require a positive `entryFee`.

### List ALL tournaments (any status)
Admin-only; includes drafts/closed/etc. Optional `?status=` filter.
```bash
curl -s "$BASE/admin/tournaments" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

curl -s "$BASE/admin/tournaments?status=draft" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

### Update fields (partial)
Send only what changes. All fields optional. Nullable fields (`description`, `city`, `bracketInfo`, `capacity`, `minRating`, `maxRating`) accept `null` to clear.
```bash
curl -s -X PATCH "$BASE/tournaments/$TID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Summer Cup 2026",
    "capacity": 48,
    "prizePool": 300000,
    "maxRating": null
  }'
```
Guards: `capacity` can't be set below the current registered count (`409`); `minRating <= maxRating`; paid needs positive `entryFee`.

### Change status (lifecycle)
Same `PATCH`, using `status`. Allowed moves:
`draft → open | cancelled` · `open → closed | cancelled` · `closed → completed | open | cancelled` · `completed`/`cancelled` are terminal.
```bash
# open registration
curl -s -X PATCH "$BASE/tournaments/$TID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"open"}'

# close registration
curl -s -X PATCH "$BASE/tournaments/$TID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"closed"}'

# cancel
curl -s -X PATCH "$BASE/tournaments/$TID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"cancelled"}'
```
Illegal transition → `409 cannot change status from X to Y`.

### Delete
Only when the tournament has **no** registrations; otherwise cancel it instead.
```bash
curl -s -i -X DELETE "$BASE/tournaments/$TID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
`204` deleted · `409` has registrations · `404` not found.

---

## Admin — manage & view participants

### View everyone registered
Name, email, per-sport rating, status, when they registered. Optional `?status=registered|withdrawn`.
```bash
curl -s "$BASE/tournaments/$TID/registrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

curl -s "$BASE/tournaments/$TID/registrations?status=registered" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
Response items:
```json
{
  "registrationId": "…",
  "userId": "…",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "status": "registered",
  "rating": 1750,
  "registeredAt": "2026-07-09T08:30:00.000Z"
}
```

### Add a participant (admin override)
Registers a player on their behalf. Bypasses open-status / rating / capacity gates, but the user must have a profile in the tournament's sport.
```bash
curl -s -X POST "$BASE/tournaments/$TID/registrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"'"$UID"'"}'
```
`201` registration · `404` user/tournament not found · `400` user has no profile in that sport · `409` already registered.

### Change a participant's status (withdraw / reinstate)
```bash
# withdraw a player
curl -s -X PATCH "$BASE/tournaments/$TID/registrations/$UID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"withdrawn"}'

# reinstate
curl -s -X PATCH "$BASE/tournaments/$TID/registrations/$UID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"registered"}'
```
`200` updated · `404` registration not found.

### Remove a participant entirely
Deletes the registration row (vs. withdrawing).
```bash
curl -s -i -X DELETE "$BASE/tournaments/$TID/registrations/$UID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
`204` removed · `404` registration not found.

### Look up a single registrant (full record)
Use the `userId` from the registrations list to fetch everything about that user:
their account, all their sport profiles (rating per sport), and their tournament history.
```bash
curl -s "$BASE/admin/users/$UID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
Response shape:
```json
{
  "user": { "id": "…", "email": "jane@example.com", "name": "Jane Doe", "role": "player", "createdAt": "…" },
  "profiles": [
    { "sportSlug": "football", "sportName": "Football", "rating": 1750, "attributes": { }, "updatedAt": "…" }
  ],
  "registrations": [
    { "tournamentId": "…", "title": "Summer Cup", "status": "registered", "tournamentStatus": "open", "startsAt": "…", "registeredAt": "…" }
  ]
}
```
`200` → the record · `404` if no such user.

---

## Endpoint summary

| Method & path | Who | Purpose |
|---|---|---|
| `GET /tournaments` | public | list open tournaments |
| `GET /tournaments/:id` | public | one tournament + registered count |
| `POST /tournaments/:id/register` | player | self-register (rating + capacity gated) |
| `POST /tournaments/:id/withdraw` | player | self-withdraw |
| `POST /tournaments` | admin | create |
| `GET /admin/tournaments` | admin | list all (any status, `?status=`) |
| `PATCH /tournaments/:id` | admin | edit fields + lifecycle status |
| `DELETE /tournaments/:id` | admin | delete (only if no registrations) |
| `GET /tournaments/:id/registrations` | admin | view participants (name/email/rating/status) |
| `POST /tournaments/:id/registrations` | admin | add participant (override) |
| `PATCH /tournaments/:id/registrations/:userId` | admin | change participant status |
| `DELETE /tournaments/:id/registrations/:userId` | admin | remove participant |
| `GET /admin/users/:id` | admin | one user's full record (account, profiles, tournament history) |
