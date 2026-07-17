CREATE TYPE "public"."proof_kind" AS ENUM('odds', 'score');--> statement-breakpoint
CREATE TYPE "public"."proof_network" AS ENUM('devnet', 'mainnet');--> statement-breakpoint
ALTER TYPE "public"."receipt_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."receipt_status" ADD VALUE 'unavailable';--> statement-breakpoint
ALTER TYPE "public"."receipt_status" ADD VALUE 'error';--> statement-breakpoint
DROP INDEX "decision_receipts_status_idx";--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "attempted_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "completed_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "created_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "explorer_account_url" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "explorer_program_url" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "payload_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "program_id" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "proof_kind" "proof_kind";--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "proof_material" jsonb;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "proof_material_hash" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "proof_network" "proof_network";--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "root_account" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "simulation_slot" bigint;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "source_timestamp_ms" bigint;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD COLUMN "updated_at_ms" bigint;--> statement-breakpoint
CREATE INDEX "decision_receipts_status_idx" ON "decision_receipts" USING btree ("status","updated_at_ms");--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_attempt_count_check" CHECK ("decision_receipts"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_timestamps_check" CHECK (("decision_receipts"."created_at_ms" IS NULL OR "decision_receipts"."created_at_ms" >= 0) AND
          ("decision_receipts"."attempted_at_ms" IS NULL OR "decision_receipts"."attempted_at_ms" >= 0) AND
          ("decision_receipts"."completed_at_ms" IS NULL OR "decision_receipts"."completed_at_ms" >= 0) AND
          ("decision_receipts"."updated_at_ms" IS NULL OR "decision_receipts"."updated_at_ms" >= 0) AND
          ("decision_receipts"."source_timestamp_ms" IS NULL OR "decision_receipts"."source_timestamp_ms" >= 0) AND
          ("decision_receipts"."simulation_slot" IS NULL OR "decision_receipts"."simulation_slot" >= 0));--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_payload_version_check" CHECK ("decision_receipts"."payload_version" > 0);--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_v2_fields_check" CHECK ("decision_receipts"."payload_version" < 2 OR (
        "decision_receipts"."created_at_ms" IS NOT NULL AND
        "decision_receipts"."summary" IS NOT NULL AND
        "decision_receipts"."updated_at_ms" IS NOT NULL
      ));