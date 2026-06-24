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
