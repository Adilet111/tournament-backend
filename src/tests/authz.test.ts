/**
 * Authorization gate tests. These verify that every admin endpoint rejects
 * unauthenticated (401) and non-admin (403) callers, and that the httpOnly
 * cookie is accepted as a session credential.
 *
 * Most cases need no database: the auth preHandlers reject before any handler
 * (and therefore any query) runs. GET /auth/me is the exception — its success
 * path reads the current user row (for firstName/lastName/birthDate), so this
 * suite needs a real Postgres reachable at DATABASE_URL with migrations
 * applied (see .github/workflows/ci.yml). Locally: `docker compose up db -d`
 * then `npm run db:migrate` before `npm test`.
 *
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Matches docker-compose.yml's defaults, so `docker compose up db -d` is
// enough locally without needing a .env file just to run tests.
process.env.DATABASE_URL ??= 'postgresql://app:app@localhost:5432/tournament';
process.env.JWT_SECRET ??= 'test-secret-at-least-16-chars';
process.env.NODE_ENV = 'test';

const SOME_UUID = '00000000-0000-4000-8000-000000000000';

// Every admin-only endpoint. New admin routes must be added here — the test
// fails closed, so forgetting is caught in review, not production.
const ADMIN_ENDPOINTS: [string, string][] = [
  ['POST', '/api/tournaments'],
  ['PATCH', `/api/tournaments/${SOME_UUID}`],
  ['DELETE', `/api/tournaments/${SOME_UUID}`],
  ['GET', '/api/admin/tournaments'],
  ['GET', `/api/tournaments/${SOME_UUID}/registrations`],
  ['POST', `/api/tournaments/${SOME_UUID}/registrations`],
  ['PATCH', `/api/tournaments/${SOME_UUID}/registrations/${SOME_UUID}`],
  ['DELETE', `/api/tournaments/${SOME_UUID}/registrations/${SOME_UUID}`],
  ['POST', '/api/sports'],
  ['GET', `/api/admin/users/${SOME_UUID}`],
  ['POST', `/api/admin/users/${SOME_UUID}/sports/football/rating/adjust`],
];

// Authenticated (non-admin) endpoints: must 401 without a token.
const PLAYER_ENDPOINTS: [string, string][] = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/me/profiles'],
  ['GET', '/api/me/tournaments'],
  ['POST', `/api/tournaments/${SOME_UUID}/register`],
  ['POST', `/api/tournaments/${SOME_UUID}/withdraw`],
];

let app: FastifyInstance;
let playerToken: string;

before(async () => {
  const { buildApp } = await import('../app');
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');

  // GET /auth/me reads the current row, so it needs one to find.
  await db
    .insert(users)
    .values({
      id: SOME_UUID,
      email: 'player@example.com',
      firstName: 'Test',
      lastName: 'Player',
      role: 'player',
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { firstName: 'Test', lastName: 'Player', role: 'player' },
    });

  app = buildApp();
  await app.ready();
  playerToken = app.jwt.sign({
    sub: SOME_UUID,
    email: 'player@example.com',
    role: 'player',
  });

  after(async () => {
    await db.delete(users).where(eq(users.id, SOME_UUID));
    await app.close();
  });
});

for (const [method, url] of ADMIN_ENDPOINTS) {
  test(`${method} ${url} → 401 without a token`, async () => {
    const res = await app.inject({ method: method as any, url });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'unauthorized');
  });

  test(`${method} ${url} → 403 with a player token`, async () => {
    const res = await app.inject({
      method: method as any,
      url,
      headers: { authorization: `Bearer ${playerToken}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'forbidden');
  });
}

for (const [method, url] of PLAYER_ENDPOINTS) {
  test(`${method} ${url} → 401 without a token`, async () => {
    const res = await app.inject({ method: method as any, url });
    assert.equal(res.statusCode, 401);
  });
}

test('GET /api/auth/me → 200 with a Bearer token, includes firstName/lastName', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${playerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { user } = res.json();
  assert.equal(user.role, 'player');
  assert.equal(user.firstName, 'Test');
  assert.equal(user.lastName, 'Player');
});

test('GET /api/auth/me → 200 with the httpOnly session cookie', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { auth_token: playerToken },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.id, SOME_UUID);
});

test('expired token → 401 with code token_expired', async () => {
  const expired = app.jwt.sign(
    { sub: SOME_UUID, email: 'player@example.com', role: 'player' },
    { expiresIn: '1ms' },
  );
  await new Promise((r) => setTimeout(r, 20));
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${expired}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'token_expired');
});

test('POST /api/auth/logout clears the session cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'expected a Set-Cookie header');
  assert.match(String(setCookie), /auth_token=;/);
});

test('API responses carry security headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.ok(res.headers['content-security-policy']);
});
