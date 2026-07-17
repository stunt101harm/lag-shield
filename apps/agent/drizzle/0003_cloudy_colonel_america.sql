CREATE TABLE "replay_manifests" (
	"created_at_ms" bigint NOT NULL,
	"event_count" bigint NOT NULL,
	"event_sequence_hash" text NOT NULL,
	"fixture_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"manifest_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"retention_expires_at_ms" bigint,
	"source_end_ms" bigint NOT NULL,
	"source_start_ms" bigint NOT NULL,
	CONSTRAINT "replay_manifests_created_at_check" CHECK ("replay_manifests"."created_at_ms" >= 0),
	CONSTRAINT "replay_manifests_event_count_check" CHECK ("replay_manifests"."event_count" >= 0),
	CONSTRAINT "replay_manifests_hashes_check" CHECK ("replay_manifests"."input_hash" ~ '^[a-f0-9]{64}$' AND "replay_manifests"."event_sequence_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "replay_manifests_source_range_check" CHECK ("replay_manifests"."source_start_ms" >= 0 AND "replay_manifests"."source_end_ms" >= "replay_manifests"."source_start_ms"),
	CONSTRAINT "replay_manifests_retention_check" CHECK ("replay_manifests"."retention_expires_at_ms" IS NULL OR "replay_manifests"."retention_expires_at_ms" >= "replay_manifests"."created_at_ms")
);
--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ALTER COLUMN "raw_payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD COLUMN "payload_retained" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD COLUMN "raw_payload_hash" text;--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD COLUMN "retention_expires_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "input_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "manifest_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "namespace" text NOT NULL;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "speed" text NOT NULL;--> statement-breakpoint
CREATE INDEX "replay_manifests_fixture_source_idx" ON "replay_manifests" USING btree ("fixture_id","source_start_ms");--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_manifest_id_replay_manifests_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."replay_manifests"("manifest_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raw_ingest_retention_idx" ON "raw_ingest_records" USING btree ("payload_retained","retention_expires_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_runs_namespace_uidx" ON "replay_runs" USING btree ("namespace");--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_payload_retention_check" CHECK (("raw_ingest_records"."payload_retained" AND "raw_ingest_records"."raw_payload" IS NOT NULL)
        OR (NOT "raw_ingest_records"."payload_retained" AND "raw_ingest_records"."raw_payload" IS NULL AND "raw_ingest_records"."raw_payload_hash" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_payload_hash_check" CHECK ("raw_ingest_records"."raw_payload_hash" IS NULL OR "raw_ingest_records"."raw_payload_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_retention_expiry_check" CHECK ("raw_ingest_records"."retention_expires_at_ms" IS NULL OR "raw_ingest_records"."retention_expires_at_ms" >= "raw_ingest_records"."received_at_ms");--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_hashes_check" CHECK ("replay_runs"."config_hash" ~ '^[a-f0-9]{64}$' AND "replay_runs"."input_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_namespace_check" CHECK ("replay_runs"."namespace" = 'replay:' || "replay_runs"."run_id");--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_speed_check" CHECK ("replay_runs"."speed" = 'maximum' OR "replay_runs"."speed" ~ '^[0-9]+(\.[0-9]+)?$');