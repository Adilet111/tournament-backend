ALTER TABLE "tournaments" ADD COLUMN "occupied_places" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill occupied_places from the existing registered rows.
UPDATE "tournaments" t SET "occupied_places" = (
  SELECT count(*) FROM "tournament_registrations" r
  WHERE r."tournament_id" = t."id" AND r."status" = 'registered'
);
