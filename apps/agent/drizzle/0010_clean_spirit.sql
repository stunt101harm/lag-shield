CREATE TABLE "evaluation_reports" (
	"created_at_ms" bigint NOT NULL,
	"evaluation_hash" text PRIMARY KEY NOT NULL,
	"fixture_id" text NOT NULL,
	"manifest_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"policy_configuration_hash" text,
	"policy_version" text NOT NULL,
	CONSTRAINT "evaluation_reports_created_at_check" CHECK ("evaluation_reports"."created_at_ms" >= 0),
	CONSTRAINT "evaluation_reports_hashes_check" CHECK ("evaluation_reports"."evaluation_hash" ~ '^[a-f0-9]{64}$' AND
          ("evaluation_reports"."policy_configuration_hash" IS NULL OR "evaluation_reports"."policy_configuration_hash" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_manifest_id_replay_manifests_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."replay_manifests"("manifest_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_reports_manifest_created_idx" ON "evaluation_reports" USING btree ("manifest_id","created_at_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evaluation_reports_fixture_created_idx" ON "evaluation_reports" USING btree ("fixture_id","created_at_ms" DESC NULLS LAST);