ALTER TABLE "tournaments" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "type" "competition_type" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "max_rating" integer;