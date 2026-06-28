import { pgEnum, pgTable, text, timestamp, uuid, integer, unique } from 'drizzle-orm/pg-core';

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

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
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
    rating: integer('rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  location: text('location').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  prizePool: integer('prize_pool').notNull().default(0),
  entryFee: integer('entry_fee').notNull().default(0),
  currency: text('currency').notNull().default('KZT'),
  bracketInfo: text('bracket_info'),
  minRating: integer('min_rating'),
  status: tournamentStatusEnum('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  status: competitionStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
