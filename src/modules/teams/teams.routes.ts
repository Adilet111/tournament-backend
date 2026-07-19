import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  sportProfiles,
  sports,
  teamMembers,
  teams,
  tournamentTeamRegistrations,
  users,
} from '../../db/schema';

const idParam = z.object({ id: z.string().uuid() });
const memberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const tokenParam = z.object({ token: z.string().min(1) });

const createBody = z.object({
  sportId: z.string().uuid(),
  name: z.string().min(1).max(80),
  logoUrl: z.string().url().optional(),
});

// The secret in the join URL. base64url keeps it copy-paste and URL safe.
function newInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

async function loadTeamOr404(id: string) {
  const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!team) throw new AppError('team not found', 404);
  return team;
}

// The caller's membership row in a team, if any (any status).
async function findMembership(teamId: string, userId: string) {
  const [row] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return row;
}

// Captain-only actions (invite link, roster management, deletion) 403 for
// everyone else, including regular members.
async function requireCaptain(teamId: string, userId: string) {
  const membership = await findMembership(teamId, userId);
  if (!membership || membership.status !== 'active' || membership.role !== 'captain') {
    throw new AppError('only the team captain can do this', 403, 'not_captain');
  }
  return membership;
}

// Active roster with per-member profile rating in the team's sport.
async function activeRoster(teamId: string, sportId: string) {
  return db
    .select({
      userId: teamMembers.userId,
      name: users.name,
      email: users.email,
      role: teamMembers.role,
      rating: sportProfiles.rating,
      joinedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .leftJoin(
      sportProfiles,
      and(eq(sportProfiles.userId, teamMembers.userId), eq(sportProfiles.sportId, sportId)),
    )
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.status, 'active')))
    .orderBy(desc(teamMembers.role), teamMembers.createdAt);
}

export async function teamsRoutes(app: FastifyInstance) {
  // Authenticated: create a team in a sport. The creator becomes its captain.
  // Joining is by invite link only — the response includes the initial token.
  app.post('/teams', { preHandler: app.authenticate }, async (req, reply) => {
    const body = parse(createBody, req.body);

    const [sport] = await db.select().from(sports).where(eq(sports.id, body.sportId)).limit(1);
    if (!sport) throw new AppError('sport not found', 404);

    const [existing] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.sportId, body.sportId), eq(teams.name, body.name)))
      .limit(1);
    if (existing) {
      throw new AppError('a team with this name already exists in this sport', 409, 'team_name_taken');
    }

    const team = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(teams)
        .values({
          sportId: body.sportId,
          createdBy: req.user.sub,
          name: body.name,
          logoUrl: body.logoUrl,
          inviteToken: newInviteToken(),
        })
        .returning();
      await tx.insert(teamMembers).values({
        teamId: created.id,
        userId: req.user.sub,
        role: 'captain',
        status: 'active',
      });
      return created;
    });

    req.log.info(
      { teamId: team.id, sportId: body.sportId, userId: req.user.sub, name: body.name },
      'team created',
    );
    return reply.code(201).send(team);
  });

  // Authenticated: the teams you are an active member of.
  app.get('/teams/mine', { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({
        team: teams,
        role: teamMembers.role,
        sportName: sports.name,
        sportSlug: sports.slug,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(sports, eq(sports.id, teams.sportId))
      .where(and(eq(teamMembers.userId, req.user.sub), eq(teamMembers.status, 'active')))
      .orderBy(desc(teams.createdAt));

    return Promise.all(
      rows.map(async ({ team, role, sportName, sportSlug }) => {
        const [members] = await db
          .select({ value: count() })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.status, 'active')));
        // The invite token is captain-only; hide it from plain members here.
        const { inviteToken, ...publicTeam } = team;
        return {
          ...publicTeam,
          myRole: role,
          sportName,
          sportSlug,
          memberCount: members?.value ?? 0,
        };
      }),
    );
  });

  // Authenticated: team details + active roster. Members only — the roster
  // (names, emails, ratings) is not public.
  app.get('/teams/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    const team = await loadTeamOr404(id);

    const membership = await findMembership(id, req.user.sub);
    const isMember = membership?.status === 'active';
    if (!isMember && req.user.role !== 'admin') {
      throw new AppError('you are not a member of this team', 403, 'not_team_member');
    }

    const roster = await activeRoster(id, team.sportId);
    const { inviteToken, ...publicTeam } = team;
    return {
      ...publicTeam,
      myRole: membership?.role ?? null,
      members: roster,
    };
  });

  // Captain: the current invite link secret. Share `joinPath` (the frontend
  // turns it into a full URL). Rotating invalidates previously shared links.
  app.get('/teams/:id/invite', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    const team = await loadTeamOr404(id);
    await requireCaptain(id, req.user.sub);
    return { inviteToken: team.inviteToken, joinPath: `/teams/join/${team.inviteToken}` };
  });

  app.post('/teams/:id/invite/rotate', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    await loadTeamOr404(id);
    await requireCaptain(id, req.user.sub);

    const token = newInviteToken();
    await db.update(teams).set({ inviteToken: token }).where(eq(teams.id, id));
    req.log.info({ teamId: id, userId: req.user.sub }, 'team invite link rotated');
    return { inviteToken: token, joinPath: `/teams/join/${token}` };
  });

  // Authenticated: join a team via its invite link — the ONLY way to join.
  // A member who left may rejoin through a valid link; one removed by the
  // captain may not (rotating the link alone wouldn't stop them otherwise).
  app.post('/teams/join/:token', { preHandler: app.authenticate }, async (req, reply) => {
    const { token } = parse(tokenParam, req.params);

    const [team] = await db.select().from(teams).where(eq(teams.inviteToken, token)).limit(1);
    if (!team) throw new AppError('invalid or expired invite link', 404, 'invalid_invite');

    const existing = await findMembership(team.id, req.user.sub);
    if (existing?.status === 'active') {
      throw new AppError('you are already a member of this team', 409, 'already_member');
    }
    if (existing?.status === 'removed') {
      throw new AppError('you were removed from this team', 403, 'removed_from_team');
    }

    const membership = existing
      ? (
          await db
            .update(teamMembers)
            .set({ status: 'active' })
            .where(eq(teamMembers.id, existing.id))
            .returning()
        )[0]
      : (
          await db
            .insert(teamMembers)
            .values({ teamId: team.id, userId: req.user.sub, status: 'active' })
            .returning()
        )[0];

    req.log.info(
      { teamId: team.id, userId: req.user.sub, rejoined: Boolean(existing) },
      'user joined team via invite link',
    );
    const { inviteToken, ...publicTeam } = team;
    return reply.code(201).send({ team: publicTeam, membership });
  });

  // Authenticated member: leave a team. The captain can't leave — transfer
  // captaincy first (or delete the team).
  app.post('/teams/:id/leave', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    await loadTeamOr404(id);

    const membership = await findMembership(id, req.user.sub);
    if (!membership || membership.status !== 'active') {
      throw new AppError('you are not a member of this team', 404, 'not_team_member');
    }
    if (membership.role === 'captain') {
      throw new AppError(
        'the captain cannot leave; transfer captaincy or delete the team',
        409,
        'captain_cannot_leave',
      );
    }

    const [left] = await db
      .update(teamMembers)
      .set({ status: 'left' })
      .where(eq(teamMembers.id, membership.id))
      .returning();
    req.log.info({ teamId: id, userId: req.user.sub }, 'user left team');
    return left;
  });

  // Captain: hand captaincy to another active member; you become a member.
  app.post('/teams/:id/transfer-captain', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    await loadTeamOr404(id);
    const captain = await requireCaptain(id, req.user.sub);
    if (userId === req.user.sub) {
      throw new AppError('you are already the captain', 409);
    }

    const target = await findMembership(id, userId);
    if (!target || target.status !== 'active') {
      throw new AppError('target user is not an active member of this team', 404);
    }

    await db.transaction(async (tx) => {
      await tx.update(teamMembers).set({ role: 'member' }).where(eq(teamMembers.id, captain.id));
      await tx.update(teamMembers).set({ role: 'captain' }).where(eq(teamMembers.id, target.id));
    });
    req.log.info({ teamId: id, from: req.user.sub, to: userId }, 'team captaincy transferred');
    return { ok: true };
  });

  // Captain: remove a member. Removal is a ban — they can't rejoin even with
  // a valid link. Rotate the invite link too if it may have leaked.
  app.delete('/teams/:id/members/:userId', { preHandler: app.authenticate }, async (req) => {
    const { id, userId } = parse(memberParams, req.params);
    await loadTeamOr404(id);
    await requireCaptain(id, req.user.sub);
    if (userId === req.user.sub) {
      throw new AppError('use leave or delete instead of removing yourself', 409);
    }

    const target = await findMembership(id, userId);
    if (!target || target.status !== 'active') {
      throw new AppError('this user is not an active member of the team', 404);
    }

    const [removed] = await db
      .update(teamMembers)
      .set({ status: 'removed' })
      .where(eq(teamMembers.id, target.id))
      .returning();
    req.log.info({ teamId: id, removedUserId: userId, byUserId: req.user.sub }, 'team member removed');
    return removed;
  });

  // Captain: delete a team. Blocked once it has any tournament registration —
  // cancel/withdraw those first — so completed-tournament history survives.
  app.delete('/teams/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await loadTeamOr404(id);
    await requireCaptain(id, req.user.sub);

    const [regs] = await db
      .select({ value: count() })
      .from(tournamentTeamRegistrations)
      .where(eq(tournamentTeamRegistrations.teamId, id));
    if ((regs?.value ?? 0) > 0) {
      throw new AppError(
        'cannot delete a team that has tournament registrations',
        409,
        'team_has_registrations',
      );
    }

    await db.delete(teams).where(eq(teams.id, id));
    req.log.info({ teamId: id, userId: req.user.sub }, 'team deleted');
    return reply.code(204).send();
  });
}
