ALTER TYPE "public"."replay_status" ADD VALUE 'paused' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."replay_status" ADD VALUE 'stopped' BEFORE 'failed';