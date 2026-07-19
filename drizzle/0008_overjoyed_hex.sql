CREATE TYPE "public"."match_outcome" AS ENUM('win', 'loss', 'draw');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending', 'completed', 'walkover');--> statement-breakpoint
CREATE TYPE "public"."participant_type" AS ENUM('solo', 'team');--> statement-breakpoint
CREATE TYPE "public"."team_member_role" AS ENUM('captain', 'member');--> statement-breakpoint
CREATE TYPE "public"."team_member_status" AS ENUM('invited', 'active', 'declined', 'left', 'removed');--> statement-breakpoint
CREATE TABLE "match_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"score" integer,
	"outcome" "match_outcome",
	CONSTRAINT "match_participants_match_slot_unique" UNIQUE("match_id","slot"),
	CONSTRAINT "match_participants_match_entry_unique" UNIQUE("match_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"next_match_id" uuid,
	"next_match_slot" integer,
	"status" "match_status" DEFAULT 'pending' NOT NULL,
	"played_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_tournament_round_position_unique" UNIQUE("tournament_id","round","position")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_member_role" DEFAULT 'member' NOT NULL,
	"status" "team_member_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_user_unique" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"invite_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_invite_token_unique" UNIQUE("invite_token"),
	CONSTRAINT "teams_sport_name_unique" UNIQUE("sport_id","name")
);
--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"registration_id" uuid,
	"team_registration_id" uuid,
	"display_name" text NOT NULL,
	"seed" integer,
	"final_rank" integer,
	CONSTRAINT "tournament_entries_registration_id_unique" UNIQUE("registration_id"),
	CONSTRAINT "tournament_entries_team_registration_id_unique" UNIQUE("team_registration_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_team_registration_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"tournament_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "ttr_members_tournament_user_unique" UNIQUE("tournament_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_team_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"status" "registration_status" DEFAULT 'registered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ttr_tournament_team_unique" UNIQUE("tournament_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "participant_type" "participant_type" DEFAULT 'solo' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "team_size" integer;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_entry_id_tournament_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."tournament_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_next_match_id_matches_id_fk" FOREIGN KEY ("next_match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_registration_id_tournament_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."tournament_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_team_registration_id_tournament_team_registrations_id_fk" FOREIGN KEY ("team_registration_id") REFERENCES "public"."tournament_team_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_team_registration_members" ADD CONSTRAINT "tournament_team_registration_members_registration_id_tournament_team_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."tournament_team_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_team_registration_members" ADD CONSTRAINT "tournament_team_registration_members_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_team_registration_members" ADD CONSTRAINT "tournament_team_registration_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_team_registrations" ADD CONSTRAINT "tournament_team_registrations_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_team_registrations" ADD CONSTRAINT "tournament_team_registrations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_team_size_matches_type_check" CHECK ((participant_type = 'team') = (team_size IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_source_xor_check" CHECK (num_nonnulls(registration_id, team_registration_id) = 1);
