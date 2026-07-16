-- Backfill existing open (NULL) rating bounds to the new "open" sentinels
-- before adding the NOT NULL constraints.
UPDATE "tournaments" SET "min_rating" = 0 WHERE "min_rating" IS NULL;--> statement-breakpoint
UPDATE "tournaments" SET "max_rating" = 100000 WHERE "max_rating" IS NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "min_rating" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "min_rating" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "max_rating" SET DEFAULT 100000;--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "max_rating" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "min_age" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "max_age" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birth_date" date;
