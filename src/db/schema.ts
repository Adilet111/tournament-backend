import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  unique,
  date,
  boolean,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Core tables to get you running. Extend with the rest of the model following
 * the same patterns:
 *   sport_profiles, rating_assessments, rating_events,
 *   sponsors, competition_sponsors, applications, payments,
 *   matches, match_participants
 */

export const roleEnum = pgEnum('role', ['player', 'admin']);
export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'apple']);
export const competitionTypeEnum = pgEnum('competition_type', ['free', 'paid']);
export const competitionStatusEnum = pgEnum('competition_status', [
  'draft',
  'open',
  'closed',
  'completed',
  'cancelled',
]);
export const tournamentStatusEnum = pgEnum('tournament_status', [
  'draft',
  'open',
  'closed',
  'completed',
  'cancelled',
]);
export const registrationStatusEnum = pgEnum('registration_status', [
  'registered',
  'withdrawn',
]);
// Whether a tournament is played 1v1 (solo) or between teams.
export const participantTypeEnum = pgEnum('participant_type', ['solo', 'team']);
export const teamMemberRoleEnum = pgEnum('team_member_role', ['captain', 'member']);
// 'invited'/'declined' are reserved for a future direct-invite flow; today the
// only way in is the invite link, which creates members as 'active' directly.
export const teamMemberStatusEnum = pgEnum('team_member_status', [
  'invited',
  'active',
  'declined',
  'left',
  'removed',
]);
export const matchStatusEnum = pgEnum('match_status', ['pending', 'completed', 'walkover']);
export const matchOutcomeEnum = pgEnum('match_outcome', ['win', 'loss', 'draw']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  // Date-only (YYYY-MM-DD), captured at Google sign-in. Nullable: pre-existing
  // users and anyone who signed in before providing it won't have one, which
  // blocks registering for age-restricted tournaments until they set it.
  birthDate: date('birth_date'),
  role: roleEnum('role').notNull().default('player'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    providerUid: text('provider_uid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerUnique: unique('auth_provider_uid_unique').on(t.provider, t.providerUid),
  }),
);

export const sports = pgTable('sports', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A player's profile for a given sport. A user can only register for a
 * tournament in a sport they have a profile in. `rating` is optional and is
 * what gets compared against a tournament's `minRating` when one is set.
 */
export const sportProfiles = pgTable(
  'sport_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sportId: uuid('sport_id')
      .notNull()
      .references(() => sports.id, { onDelete: 'cascade' }),
    // The sport-specific questionnaire answers (shape validated per-sport in code).
    attributes: jsonb('attributes').notNull().default({}),
    // Seeded from the answers on creation, later updated from match results.
    rating: integer('rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSportUnique: unique('sport_profiles_user_sport_unique').on(t.userId, t.sportId),
  }),
);

/**
 * A tournament created by an admin. `minRating` is optional: when null, anyone
 * with a profile in the sport may register; when set, the player's sport
 * profile rating must be at least this value. `bracketInfo` is a free-text
 * block describing the bracket for now.
 */
export const tournaments = pgTable('tournaments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sportId: uuid('sport_id')
    .notNull()
    .references(() => sports.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
  description: text('description'),
  type: competitionTypeEnum('type').notNull().default('free'),
  location: text('location').notNull(),
  city: text('city'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  prizePool: integer('prize_pool').notNull().default(0),
  entryFee: integer('entry_fee').notNull().default(0),
  currency: text('currency').notNull().default('KZT'),
  bracketInfo: text('bracket_info'),
  // solo = 1v1 tournament (players register themselves), team = teams register.
  // CHECK (hand-written in migration): (participant_type = 'team') = (team_size IS NOT NULL).
  participantType: participantTypeEnum('participant_type').notNull().default('solo'),
  // Roster size a team must field at registration. Null for solo tournaments.
  teamSize: integer('team_size'),
  // Max number of competing units (players for solo, teams for team
  // tournaments). Null means no limit.
  capacity: integer('capacity'),
  // Denormalized count of players currently holding a slot (status =
  // registered). Kept in sync with tournament_registrations on every change.
  occupiedPlaces: integer('occupied_places').notNull().default(0),
  // Inclusive rating range for eligibility. Defaults span the full range
  // (0..100000) so an unbounded tournament lets anyone in. See src/lib/eligibility.ts.
  minRating: integer('min_rating').notNull().default(0),
  maxRating: integer('max_rating').notNull().default(100000),
  // Inclusive age range for eligibility. Defaults (0..120) mean no restriction.
  minAge: integer('min_age').notNull().default(0),
  maxAge: integer('max_age').notNull().default(120),
  status: tournamentStatusEnum('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A persistent team, scoped to one sport. A user may belong to any number of
 * teams (even within one sport) — exclusivity is enforced per tournament via
 * the roster snapshot, not here. Joining is by invite link only: anyone who
 * has `inviteToken` may join, so the captain shares (and can rotate) the link.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sportId: uuid('sport_id')
      .notNull()
      .references(() => sports.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    // Random secret in the join URL. Rotating it invalidates old links.
    inviteToken: text('invite_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sportNameUnique: unique('teams_sport_name_unique').on(t.sportId, t.name),
  }),
);

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: teamMemberRoleEnum('role').notNull().default('member'),
    status: teamMemberStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    teamUserUnique: unique('team_members_team_user_unique').on(t.teamId, t.userId),
  }),
);

/**
 * A player's registration for a tournament. One row per (tournament, user).
 */
export const tournamentRegistrations = pgTable(
  'tournament_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: registrationStatusEnum('status').notNull().default('registered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tournamentUserUnique: unique('tournament_registrations_tournament_user_unique').on(
      t.tournamentId,
      t.userId,
    ),
  }),
);

/**
 * A team's registration for a team tournament. One row per (tournament, team),
 * written by the captain through the same locked-transaction pattern as solo
 * registrations so capacity can't be overbooked.
 */
export const tournamentTeamRegistrations = pgTable(
  'tournament_team_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    status: registrationStatusEnum('status').notNull().default('registered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tournamentTeamUnique: unique('ttr_tournament_team_unique').on(t.tournamentId, t.teamId),
  }),
);

/**
 * The roster snapshot frozen at team registration. Later team_members changes
 * never affect a registered tournament; stats and eligibility read this table.
 * UQ (tournament_id, user_id) is THE rule that stops one person entering the
 * same tournament twice via different teams (tournament_id is denormalized
 * from the registration precisely to make that constraint possible). Rows are
 * deleted when the team withdraws, freeing the players for another team.
 */
export const tournamentTeamRegistrationMembers = pgTable(
  'tournament_team_registration_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => tournamentTeamRegistrations.id, { onDelete: 'cascade' }),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    tournamentUserUnique: unique('ttr_members_tournament_user_unique').on(
      t.tournamentId,
      t.userId,
    ),
  }),
);

/**
 * One competitor slot in a tournament's bracket, hiding solo vs team: exactly
 * one of registrationId / teamRegistrationId is set (hand-written CHECK).
 * Bracket and match code reference entries only. `displayName` is frozen at
 * bracket generation so renames don't rewrite history.
 */
export const tournamentEntries = pgTable('tournament_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tournamentId: uuid('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  registrationId: uuid('registration_id')
    .unique()
    .references(() => tournamentRegistrations.id, { onDelete: 'cascade' }),
  teamRegistrationId: uuid('team_registration_id')
    .unique()
    .references(() => tournamentTeamRegistrations.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  // 1 = strongest. Assigned at bracket generation (by rating, nulls last).
  seed: integer('seed'),
  // Filled as the bracket resolves: 1 = champion, 2 = runner-up, etc.
  finalRank: integer('final_rank'),
});

/**
 * The whole single-elimination bracket is created up front. `round` 1 is the
 * first round; `position` is 0-based within the round. Winners advance to
 * `nextMatchId` slot `nextMatchSlot` (null next match = the final). Byes are
 * matches resolved immediately as 'walkover'.
 */
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    position: integer('position').notNull(),
    nextMatchId: uuid('next_match_id').references((): AnyPgColumn => matches.id),
    nextMatchSlot: integer('next_match_slot'),
    status: matchStatusEnum('status').notNull().default('pending'),
    playedAt: timestamp('played_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bracketSlotUnique: unique('matches_tournament_round_position_unique').on(
      t.tournamentId,
      t.round,
      t.position,
    ),
  }),
);

/**
 * The 0–2 sides of a match. Rows appear as slots resolve (first round at
 * bracket generation, later rounds as winners advance).
 */
export const matchParticipants = pgTable(
  'match_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => tournamentEntries.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    score: integer('score'),
    outcome: matchOutcomeEnum('outcome'),
  },
  (t) => ({
    matchSlotUnique: unique('match_participants_match_slot_unique').on(t.matchId, t.slot),
    matchEntryUnique: unique('match_participants_match_entry_unique').on(t.matchId, t.entryId),
  }),
);

/**
 * Audit + notification queue for players auto-removed from a tournament when an
 * admin tightened its age limit below their eligibility. One row per removal;
 * `notified` flips to true once they've been contacted (e.g. via a social
 * network). The `age`/`minAge`/`maxAge` snapshot lets the message explain why.
 */
export const registrationRemovals = pgTable('registration_removals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tournamentId: uuid('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Why removed: 'age_too_low' | 'age_too_high' | 'age_unknown' (no birth date).
  reason: text('reason').notNull(),
  // Snapshot at removal time. `age` is null when the birth date is unknown.
  age: integer('age'),
  minAge: integer('min_age').notNull(),
  maxAge: integer('max_age').notNull(),
  notified: boolean('notified').notNull().default(false),
  removedAt: timestamp('removed_at', { withTimezone: true }).notNull().defaultNow(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
});

export const competitions = pgTable('competitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sportId: uuid('sport_id')
    .notNull()
    .references(() => sports.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
  description: text('description'),
  type: competitionTypeEnum('type').notNull().default('free'),
  entryFee: integer('entry_fee').notNull().default(0),
  currency: text('currency').notNull().default('KZT'),
  city: text('city'),
  // Max number of players. Null means no limit.
  capacity: integer('capacity'),
  // Optional rating range for eligibility. Null bound means open on that side.
  minRating: integer('min_rating'),
  maxRating: integer('max_rating'),
  status: competitionStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
