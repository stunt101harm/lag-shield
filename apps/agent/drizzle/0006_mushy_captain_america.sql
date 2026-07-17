ALTER TYPE "public"."order_status" ADD VALUE 'stale' BEFORE 'settled';--> statement-breakpoint
DROP INDEX "simulated_orders_idempotency_uidx";--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "admission_latency_ms" bigint;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "admission_reason_code" text;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "circuit_breaker_receipt_id" text;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "market_state" "market_control_state";--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "market_state_version" integer;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "namespace" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "payload_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD COLUMN "requested_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_circuit_breaker_receipt_id_decision_receipts_receipt_id_fk" FOREIGN KEY ("circuit_breaker_receipt_id") REFERENCES "public"."decision_receipts"("receipt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_orders_namespace_idempotency_uidx" ON "simulated_orders" USING btree ("namespace","idempotency_key");--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_admission_latency_check" CHECK ("simulated_orders"."admission_latency_ms" IS NULL OR "simulated_orders"."admission_latency_ms" >= 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_market_state_version_check" CHECK ("simulated_orders"."market_state_version" IS NULL OR "simulated_orders"."market_state_version" > 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_payload_version_check" CHECK ("simulated_orders"."payload_version" > 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_v2_audit_fields_check" CHECK ("simulated_orders"."payload_version" < 2 OR (
        "simulated_orders"."admission_latency_ms" IS NOT NULL AND
        "simulated_orders"."admission_reason_code" IS NOT NULL AND
        "simulated_orders"."circuit_breaker_receipt_id" IS NOT NULL AND
        "simulated_orders"."market_state" IS NOT NULL AND
        "simulated_orders"."market_state_version" IS NOT NULL AND
        "simulated_orders"."request_hash" IS NOT NULL AND
        "simulated_orders"."requested_at_ms" IS NOT NULL
      ));