ALTER TABLE "fixture_score_state" ADD COLUMN "action_id" text;--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD COLUMN "confirmed" boolean;--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "score_events" ADD COLUMN "action_id" text;--> statement-breakpoint
ALTER TABLE "score_events" ADD COLUMN "confirmed" boolean;--> statement-breakpoint
ALTER TABLE "score_events" ADD COLUMN "details" jsonb;