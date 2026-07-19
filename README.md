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
Teams, team tournaments, brackets and stats have their own full curl reference
below: [Teams, team tournaments, brackets & stats — API reference](#teams-team-tournaments-brackets--stats--api-reference).

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

<!-- ============================================================= -->
<!-- COPY FROM HERE — Teams / Brackets / Stats frontend reference  -->
<!-- ============================================================= -->

## Teams, team tournaments, brackets & stats — API reference

Base URL: `http://localhost:3000/api` (prod: your domain, nginx proxies `/api`).
Auth: send the session JWT as `Authorization: Bearer $TOKEN` **or** rely on the
`auth_token` httpOnly cookie set by `/auth/login` (add `-b cookies.txt` to curl).
Legend: 🔓 public · 🔒 any logged-in user · Ⓒ team captain · 👑 admin.

Every error is `{ "error": "<human message>", "code": "<stable code>" }` with the
HTTP status shown. Branch on `code`, not on the message — messages may change.
Auth failures everywhere: `401 unauthorized` / `401 token_expired`, and admin
routes return `403 forbidden` for non-admins.

```bash
TOKEN="eyJ..."           # from POST /auth/login
API="http://localhost:3000/api"
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"
```

### Quick index

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/teams` | 🔒 | create a team (creator becomes captain) |
| GET | `/teams/mine` | 🔒 | teams I'm an active member of |
| GET | `/teams/:id` | 🔒 member/👑 | team detail + roster |
| GET | `/teams/:id/invite` | Ⓒ | current invite link |
| POST | `/teams/:id/invite/rotate` | Ⓒ | invalidate old links, mint a new one |
| POST | `/teams/join/:token` | 🔒 | join a team — **the only way in** |
| POST | `/teams/:id/leave` | 🔒 | leave a team (captain can't) |
| POST | `/teams/:id/transfer-captain` | Ⓒ | hand captaincy to another member |
| DELETE | `/teams/:id/members/:userId` | Ⓒ | remove (ban) a member |
| DELETE | `/teams/:id` | Ⓒ | delete a team (no tournament history only) |
| POST | `/tournaments` | 👑 | create — now takes `participantType` + `teamSize` |
| POST | `/tournaments/:id/register-team` | Ⓒ | register a roster for a team tournament |
| POST | `/tournaments/:id/withdraw-team` | Ⓒ | withdraw the team, frees its players |
| GET | `/tournaments/:id/team-registrations` | 👑 | team registrations + frozen rosters |
| POST | `/tournaments/:id/bracket` | 👑 | generate the single-elimination bracket |
| GET | `/tournaments/:id/bracket` | 🔓 | the bracket, grouped by round |
| DELETE | `/tournaments/:id/bracket` | 👑 | delete bracket (until a match is played) |
| POST | `/matches/:id/result` | 👑 | report a result, winner advances |
| GET | `/me/stats` | 🔒 | my tournament/match statistics + score |
| GET | `/users/:id/stats` | 👑 | any user's statistics |

Changed existing endpoints: `POST /tournaments/:id/register` now returns
`409 team_tournament` on team tournaments; `GET /me/tournaments` items now carry
`teamId`/`teamName` (null for solo); tournament objects everywhere now include
`participantType` (`"solo" | "team"`) and `teamSize` (int, null for solo);
`capacity`/`occupiedPlaces`/`freePlaces` count **teams** on team tournaments.

---

### 1. Create a team — `POST /teams` 🔒

One team = one sport. The creator becomes captain and gets the invite token in
this response (the only place a plain 201 exposes it — store it or re-fetch via
`/teams/:id/invite`). A user may create/join any number of teams.

```bash
curl -X POST "$API/teams" -H "$AUTH" -H "$JSON" -d '{
  "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
  "name": "Astana Wolves",
  "logoUrl": "https://cdn.example.com/wolves.png"
}'
```

`201`:

```json
{
  "id": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
  "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
  "createdBy": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
  "name": "Astana Wolves",
  "logoUrl": "https://cdn.example.com/wolves.png",
  "inviteToken": "Nq8xK2vR5tY7uW9zB1cD4eF6",
  "createdAt": "2026-07-19T10:00:00.000Z"
}
```

| Status | code | When |
|---|---|---|
| 400 | `bad_request` | invalid body (missing name, bad url, …) |
| 404 | `not_found` | `sportId` doesn't exist |
| 409 | `team_name_taken` | another team in this sport already has the name |

### 2. My teams — `GET /teams/mine` 🔒

```bash
curl "$API/teams/mine" -H "$AUTH"
```

`200` (no `inviteToken` here — captains fetch it via `/invite`):

```json
[
  {
    "id": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
    "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
    "createdBy": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    "name": "Astana Wolves",
    "logoUrl": null,
    "createdAt": "2026-07-19T10:00:00.000Z",
    "myRole": "captain",
    "sportName": "Football",
    "sportSlug": "football",
    "memberCount": 7
  }
]
```

### 3. Team detail + roster — `GET /teams/:id` 🔒 (members & admins only)

```bash
curl "$API/teams/3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0" -H "$AUTH"
```

`200`:

```json
{
  "id": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
  "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
  "createdBy": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
  "name": "Astana Wolves",
  "logoUrl": null,
  "createdAt": "2026-07-19T10:00:00.000Z",
  "myRole": "member",
  "members": [
    {
      "userId": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      "name": "Aigerim S.",
      "email": "aigerim@example.com",
      "role": "captain",
      "rating": 1480,
      "joinedAt": "2026-07-19T10:00:00.000Z"
    },
    {
      "userId": "0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
      "name": "Daniyar K.",
      "email": "daniyar@example.com",
      "role": "member",
      "rating": null,
      "joinedAt": "2026-07-19T11:20:00.000Z"
    }
  ]
}
```

`rating` is the member's profile rating in the **team's** sport (null = no
rating yet).

| Status | code | When |
|---|---|---|
| 403 | `not_team_member` | caller is not an active member (and not admin) |
| 404 | `not_found` | team doesn't exist |

### 4. Invite link — `GET /teams/:id/invite` Ⓒ / `POST /teams/:id/invite/rotate` Ⓒ

Joining is **by link only** — there is no "invite user" or "add member"
endpoint. The frontend builds the shareable URL from `joinPath` (e.g.
`https://app.example.com/teams/join/<token>` on your side) and calls
`POST /teams/join/:token` when the invitee opens it. Rotate after removing
someone or if the link leaked; old links die instantly.

```bash
curl "$API/teams/3f2a4b1c-.../invite" -H "$AUTH"
curl -X POST "$API/teams/3f2a4b1c-.../invite/rotate" -H "$AUTH"
```

`200` (both):

```json
{ "inviteToken": "Nq8xK2vR5tY7uW9zB1cD4eF6", "joinPath": "/teams/join/Nq8xK2vR5tY7uW9zB1cD4eF6" }
```

| Status | code | When |
|---|---|---|
| 403 | `not_captain` | caller isn't the team's active captain |
| 404 | `not_found` | team doesn't exist |

### 5. Join by link — `POST /teams/join/:token` 🔒

```bash
curl -X POST "$API/teams/join/Nq8xK2vR5tY7uW9zB1cD4eF6" -H "$AUTH"
```

`201`:

```json
{
  "team": {
    "id": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
    "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
    "createdBy": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    "name": "Astana Wolves",
    "logoUrl": null,
    "createdAt": "2026-07-19T10:00:00.000Z"
  },
  "membership": {
    "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
    "teamId": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
    "userId": "0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
    "role": "member",
    "status": "active",
    "createdAt": "2026-07-19T11:20:00.000Z"
  }
}
```

| Status | code | When |
|---|---|---|
| 404 | `invalid_invite` | token unknown (bad link or rotated since) |
| 409 | `already_member` | caller is already an active member |
| 403 | `removed_from_team` | caller was removed (banned) by the captain — rejoin impossible even with a valid link |

Someone who **left** voluntarily can rejoin through a valid link.

### 6. Leave — `POST /teams/:id/leave` 🔒

```bash
curl -X POST "$API/teams/3f2a4b1c-.../leave" -H "$AUTH"
```

`200` → the membership row with `"status": "left"`.

| Status | code | When |
|---|---|---|
| 404 | `not_team_member` | caller isn't an active member |
| 409 | `captain_cannot_leave` | captain must transfer captaincy or delete the team first |

### 7. Transfer captaincy — `POST /teams/:id/transfer-captain` Ⓒ

```bash
curl -X POST "$API/teams/3f2a4b1c-.../transfer-captain" -H "$AUTH" -H "$JSON" \
  -d '{"userId": "0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c"}'
```

`200` → `{ "ok": true }`. Caller becomes a plain member.

| Status | code | When |
|---|---|---|
| 403 | `not_captain` | caller isn't the captain |
| 404 | `not_found` | target isn't an active member of this team |
| 409 | `conflict` | target is yourself |

### 8. Remove a member — `DELETE /teams/:id/members/:userId` Ⓒ

Removal is a **ban**: the row stays with `status: "removed"` and blocks
rejoining forever (see §5). Rotate the invite link too if it may have leaked.
Does **not** touch tournaments the member was already snapshotted into.

```bash
curl -X DELETE "$API/teams/3f2a4b1c-.../members/0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c" -H "$AUTH"
```

`200` → the membership row with `"status": "removed"`.

| Status | code | When |
|---|---|---|
| 403 | `not_captain` | caller isn't the captain |
| 404 | `not_found` | target isn't an active member |
| 409 | `conflict` | target is yourself (use leave/delete) |

### 9. Delete a team — `DELETE /teams/:id` Ⓒ

`204` on success. Blocked once the team has **any** tournament registration
(even withdrawn) so history survives.

```bash
curl -X DELETE "$API/teams/3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0" -H "$AUTH"
```

| Status | code | When |
|---|---|---|
| 403 | `not_captain` | caller isn't the captain |
| 409 | `team_has_registrations` | team has tournament history |

---

### 10. Create a team tournament — `POST /tournaments` 👑

Same endpoint as before, two new fields. `participantType` defaults to
`"solo"` and is **immutable after creation**. `teamSize` is required for team
tournaments (min 2) and forbidden for solo. On team tournaments `capacity`
means **number of teams**.

```bash
curl -X POST "$API/tournaments" -H "$AUTH" -H "$JSON" -d '{
  "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
  "title": "City Cup 5v5",
  "location": "Central Arena",
  "city": "almaty",
  "startsAt": "2026-08-01T15:00:00Z",
  "participantType": "team",
  "teamSize": 5,
  "capacity": 16
}'
```

`201` → the tournament object, now with `"participantType": "team",
"teamSize": 5`. New error on top of the existing ones:

| Status | code | When |
|---|---|---|
| 400 | `bad_request` | `teamSize` missing on team / present on solo (message: *teamSize is required for team tournaments and not allowed for solo ones*) |

`PATCH /tournaments/:id` 👑 additionally accepts `teamSize`:
`400 bad_request` on solo tournaments, `409 conflict` once any team is
registered. `participantType` is not patchable.

### 11. Register a team — `POST /tournaments/:id/register-team` Ⓒ

The captain submits exactly `teamSize` **active** members (may include or omit
themself). The roster is **frozen as a snapshot** — later team changes don't
affect this tournament. A player already snapshotted into this tournament via
*any* team blocks the whole roster. Capacity is checked atomically (no
overbooking under concurrency).

```bash
curl -X POST "$API/tournaments/e29b41d4-.../register-team" -H "$AUTH" -H "$JSON" -d '{
  "teamId": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
  "memberIds": [
    "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    "0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
    "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    "3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f"
  ]
}'
```

`201`:

```json
{
  "id": "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
  "tournamentId": "e29b41d4-a716-4466-8551-426614174000",
  "teamId": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
  "status": "registered",
  "createdAt": "2026-07-19T12:00:00.000Z"
}
```

Errors, in the order the backend checks them (surface the message — it names
the offending players where relevant):

| Status | code | When |
|---|---|---|
| 404 | `not_found` | tournament / team doesn't exist |
| 409 | `solo_tournament` | this is a 1v1 tournament — use `/register` |
| 409 | `tournament_not_open` | status isn't `open` |
| 400 | `sport_mismatch` | team's sport ≠ tournament's sport |
| 403 | `not_captain` | caller isn't the team's active captain |
| 409 | `already_registered` | this team already holds a slot |
| 400 | `bad_request` | duplicate ids in `memberIds` |
| 400 | `wrong_roster_size` | roster ≠ `teamSize` players |
| 400 | `not_team_member` | some roster players aren't active team members |
| 403 | `member_no_sport_profile` | named players lack a profile in this sport |
| 403 | `member_rating_out_of_range` | named players outside min/max rating |
| 403 | `member_age_out_of_range` | named players outside min/max age (or no birth date) |
| 409 | `player_already_in_tournament` | named players already entered via another team |
| 409 | `tournament_full` | no team slots left |

Solo self-registration on a team tournament now fails first with
`409 team_tournament` (*"this is a team tournament; a team captain must
register the team"*).

### 12. Withdraw a team — `POST /tournaments/:id/withdraw-team` Ⓒ

Deletes the roster snapshot, so those players may enter with another team.

```bash
curl -X POST "$API/tournaments/e29b41d4-.../withdraw-team" -H "$AUTH" -H "$JSON" \
  -d '{"teamId": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0"}'
```

`200` → the registration row with `"status": "withdrawn"`.

| Status | code | When |
|---|---|---|
| 403 | `not_captain` | caller isn't the captain |
| 404 | `not_found` | tournament missing, or team not registered |
| 409 | `bracket_generated` | bracket exists — withdrawal window is closed |

### 13. Team registrations (admin) — `GET /tournaments/:id/team-registrations` 👑

Optional `?status=registered|withdrawn`.

```bash
curl "$API/tournaments/e29b41d4-.../team-registrations?status=registered" -H "$AUTH"
```

`200`:

```json
[
  {
    "registrationId": "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
    "teamId": "3f2a4b1c-9d8e-4f1a-b3c4-d5e6f7a8b9c0",
    "teamName": "Astana Wolves",
    "status": "registered",
    "registeredAt": "2026-07-19T12:00:00.000Z",
    "roster": [
      { "userId": "7d8e9f0a-...", "name": "Aigerim S.", "email": "aigerim@example.com" },
      { "userId": "0f1a2b3c-...", "name": "Daniyar K.", "email": "daniyar@example.com" }
    ]
  }
]
```

---

### 14. Generate the bracket — `POST /tournaments/:id/bracket` 👑

Tournament must be `closed` (PATCH `status: "closed"` first). Freezes the
entries (solo: player display name; team: team name), seeds by rating
(teams: average of the snapshot roster; unrated seeds last), creates every
round up front; byes resolve immediately as walkovers.

```bash
curl -X POST "$API/tournaments/e29b41d4-.../bracket" -H "$AUTH"
```

`201`:

```json
{
  "tournamentId": "e29b41d4-a716-4466-8551-426614174000",
  "bracketSize": 8,
  "rounds": 3,
  "entries": 6,
  "matches": 7,
  "walkovers": 2
}
```

| Status | code | When |
|---|---|---|
| 409 | `tournament_not_closed` | close registration first |
| 409 | `bracket_exists` | already generated (DELETE it to redo) |
| 409 | `conflict` | fewer than 2 registered participants |

### 15. View the bracket — `GET /tournaments/:id/bracket` 🔓

```bash
curl "$API/tournaments/e29b41d4-.../bracket"
```

`200` before generation: `{ "generated": false, "entries": [], "rounds": [] }`.
After:

```json
{
  "generated": true,
  "entries": [
    {
      "id": "aa11bb22-cc33-4d44-8e55-ff6677889900",
      "tournamentId": "e29b41d4-a716-4466-8551-426614174000",
      "registrationId": null,
      "teamRegistrationId": "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      "displayName": "Astana Wolves",
      "seed": 1,
      "finalRank": null
    }
  ],
  "rounds": [
    {
      "round": 1,
      "matches": [
        {
          "id": "bb22cc33-dd44-4e55-8f66-001122334455",
          "round": 1,
          "position": 0,
          "status": "pending",
          "playedAt": null,
          "nextMatchId": "cc33dd44-ee55-4f66-8a77-112233445566",
          "participants": [
            { "slot": 1, "entryId": "aa11bb22-...", "displayName": "Astana Wolves", "score": null, "outcome": null },
            { "slot": 2, "entryId": "dd44ee55-...", "displayName": "Steppe Eagles", "score": null, "outcome": null }
          ]
        }
      ]
    }
  ]
}
```

Rendering notes: `round` 1 is the first round; the match with
`nextMatchId: null` is the final. `status` is `pending | completed |
walkover` (walkover = bye, don't render a playable card). A pending match can
have 0–2 `participants` — empty slots are "winner of …" placeholders resolved
via other matches' `nextMatchId` + slot. `finalRank` on entries: 1 champion,
2 runner-up, 3 semifinal losers, 5 quarterfinal losers, …

### 16. Delete the bracket — `DELETE /tournaments/:id/bracket` 👑

For late withdrawals before play starts; regenerate afterwards. `204`.

```bash
curl -X DELETE "$API/tournaments/e29b41d4-.../bracket" -H "$AUTH"
```

| Status | code | When |
|---|---|---|
| 409 | `bracket_in_progress` | at least one match already completed |

### 17. Report a result — `POST /matches/:id/result` 👑

Scores are optional (some sports may only record the winner). The winner is
advanced into the next round automatically; the loser gets its `finalRank`.
Winning the final sets `finalRank: 1` — then move the tournament to
`completed` via `PATCH /tournaments/:id`.

```bash
curl -X POST "$API/matches/bb22cc33-.../result" -H "$AUTH" -H "$JSON" \
  -d '{"winnerSlot": 1, "score1": 3, "score2": 1}'
```

`200`:

```json
{
  "id": "bb22cc33-dd44-4e55-8f66-001122334455",
  "tournamentId": "e29b41d4-a716-4466-8551-426614174000",
  "round": 1,
  "position": 0,
  "nextMatchId": "cc33dd44-ee55-4f66-8a77-112233445566",
  "nextMatchSlot": 1,
  "status": "completed",
  "playedAt": "2026-08-01T16:05:00.000Z",
  "createdAt": "2026-07-19T13:00:00.000Z"
}
```

| Status | code | When |
|---|---|---|
| 404 | `not_found` | match doesn't exist |
| 409 | `match_completed` | result already reported (immutable) |
| 409 | `match_walkover` | it was a bye — nothing to report |
| 409 | `match_not_ready` | one or both sides not decided yet |

---

### 18. Statistics — `GET /me/stats` 🔒 / `GET /users/:id/stats` 👑

Fully derived from played matches — always current, nothing to refresh.
Walkovers don't count as played. `score` = 10 per tournament entered + 5 per
match win + placement bonus (50 champion / 30 runner-up / 20 semifinal).
`winRate` is 0..1 (2 decimals) or null before any match.

```bash
curl "$API/me/stats" -H "$AUTH"
curl "$API/users/0f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c/stats" -H "$AUTH"   # admin
```

`200`:

```json
{
  "userId": "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
  "overall": {
    "tournamentsPlayed": 3,
    "tournamentsWon": 1,
    "podiumFinishes": 2,
    "matchesPlayed": 9,
    "matchesWon": 7,
    "matchesLost": 2,
    "winRate": 0.78,
    "score": 145
  },
  "bySport": [
    {
      "sportId": "a1c9e0d2-4b6f-4e88-9a10-2c3d4e5f6a7b",
      "sportName": "Football",
      "sportSlug": "football",
      "rating": 1480,
      "tournamentsPlayed": 2,
      "tournamentsWon": 1,
      "podiumFinishes": 2,
      "matchesPlayed": 6,
      "matchesWon": 5,
      "matchesLost": 1,
      "winRate": 0.83,
      "score": 125
    }
  ],
  "tournaments": [
    {
      "tournamentId": "e29b41d4-a716-4466-8551-426614174000",
      "title": "City Cup 5v5",
      "status": "completed",
      "startsAt": "2026-08-01T15:00:00.000Z",
      "participantType": "team",
      "sportSlug": "football",
      "teamName": "Astana Wolves",
      "seed": 1,
      "finalRank": 1,
      "matchesPlayed": 3,
      "matchesWon": 3
    }
  ]
}
```

`tournamentsPlayed` counts tournaments where the user was in the generated
bracket (solo entry, or on a team's frozen roster). `teamName` is null for
solo tournaments. `/users/:id/stats` errors: `404 not_found` (unknown user),
`403 forbidden` (non-admin).

### Happy-path order (frontend flows)

1. **Captain**: create team → fetch `/invite` → share link.
2. **Players**: open link → `POST /teams/join/:token`.
3. **Captain**: pick `teamSize` members from `/teams/:id` roster →
   `POST /tournaments/:id/register-team` (map the 4xx codes above to field-level
   UI; `member_*` and `player_already_in_tournament` messages name the players).
4. **Admin**: `PATCH` status `closed` → `POST .../bracket` → report results
   round by round → `PATCH` status `completed`.
5. **Anyone**: poll `GET .../bracket` for live rendering; `GET /me/stats` after.

<!-- ============================================================ -->
<!-- COPY UNTIL HERE                                              -->
<!-- ============================================================ -->

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
redeploy