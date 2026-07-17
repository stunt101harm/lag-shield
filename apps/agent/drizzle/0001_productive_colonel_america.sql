CREATE TYPE "public"."decision_action" AS ENUM('none', 'widen', 'pause', 'begin_recovery', 'reopen');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('fixture.observed', 'odds.observed', 'score.observed');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('txline-historical', 'txline-snapshot', 'txline-live', 'simulation');--> statement-breakpoint
CREATE TYPE "public"."fixture_status" AS ENUM('scheduled', 'live', 'finished', 'cancelled', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('accepted', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."market_control_state" AS ENUM('OPEN', 'WIDENED', 'PAUSED', 'RECOVERY');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('open', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."order_settlement" AS ENUM('won', 'lost', 'void');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('back', 'lay');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('accepted', 'rejected', 'settled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."replay_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "decision_receipts" (
	"anchored_at_ms" bigint,
	"decision_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"proof_reference" text,
	"receipt_id" text PRIMARY KEY NOT NULL,
	"status" "receipt_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text PRIMARY KEY NOT NULL,
	"fixture_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer NOT NULL,
	"raw_ingest_id" text NOT NULL,
	"received_at_ms" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"source" "event_source" NOT NULL,
	"source_id" text NOT NULL,
	"source_priority" integer NOT NULL,
	"source_timestamp_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixture_score_state" (
	"action" text NOT NULL,
	"away_score" integer,
	"fixture_id" text PRIMARY KEY NOT NULL,
	"home_score" integer,
	"last_event_id" text NOT NULL,
	"last_idempotency_key" text NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_source_id" text NOT NULL,
	"last_source_priority" integer NOT NULL,
	"last_source_timestamp_ms" bigint NOT NULL,
	"period" integer,
	"status_id" integer,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"competition" text NOT NULL,
	"competition_id" text NOT NULL,
	"fixture_id" text PRIMARY KEY NOT NULL,
	"last_event_id" text NOT NULL,
	"last_idempotency_key" text NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_source_id" text NOT NULL,
	"last_source_priority" integer NOT NULL,
	"last_source_timestamp_ms" bigint NOT NULL,
	"participants" jsonb NOT NULL,
	"scheduled_at_ms" bigint NOT NULL,
	"status" "fixture_status" NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_control_states" (
	"fixture_id" text NOT NULL,
	"last_decision_id" text NOT NULL,
	"logical_timestamp_ms" bigint NOT NULL,
	"market_id" text PRIMARY KEY NOT NULL,
	"state" "market_control_state" NOT NULL,
	"state_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"fixture_id" text NOT NULL,
	"game_state" text,
	"in_running" boolean NOT NULL,
	"last_event_id" text NOT NULL,
	"last_idempotency_key" text NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_source_id" text NOT NULL,
	"last_source_priority" integer NOT NULL,
	"last_source_timestamp_ms" bigint NOT NULL,
	"market_id" text PRIMARY KEY NOT NULL,
	"market_type" text NOT NULL,
	"parameters" text,
	"period" text,
	"status" "market_status" NOT NULL,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_quote_observations" (
	"bookmaker_id" text NOT NULL,
	"bookmaker_name" text NOT NULL,
	"event_id" text NOT NULL,
	"fixture_id" text NOT NULL,
	"market_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"outcome_name" text NOT NULL,
	"price" integer NOT NULL,
	"price_encoding" text NOT NULL,
	"received_at_ms" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"source" "event_source" NOT NULL,
	"source_id" text NOT NULL,
	"source_priority" integer NOT NULL,
	"source_timestamp_ms" bigint NOT NULL,
	CONSTRAINT "outcome_quote_observations_event_id_outcome_id_pk" PRIMARY KEY("event_id","outcome_id")
);
--> statement-breakpoint
CREATE TABLE "raw_ingest_records" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixture_id" text,
	"idempotency_key" text NOT NULL,
	"ingest_id" text PRIMARY KEY NOT NULL,
	"payload_kind" text NOT NULL,
	"payload_version" integer NOT NULL,
	"quarantine_code" text,
	"quarantine_issues" jsonb,
	"raw_payload" jsonb NOT NULL,
	"received_at_ms" bigint NOT NULL,
	"source" "event_source" NOT NULL,
	"source_id" text NOT NULL,
	"source_timestamp_ms" bigint,
	"status" "ingest_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_runs" (
	"completed_at_ms" bigint,
	"config_hash" text NOT NULL,
	"event_count" bigint NOT NULL,
	"input_fixture_id" text NOT NULL,
	"last_event_id" text,
	"payload" jsonb NOT NULL,
	"run_id" text PRIMARY KEY NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"status" "replay_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_events" (
	"action" text NOT NULL,
	"away_score" integer,
	"event_id" text PRIMARY KEY NOT NULL,
	"fixture_id" text NOT NULL,
	"home_score" integer,
	"period" integer,
	"sequence" bigint NOT NULL,
	"source_priority" integer NOT NULL,
	"source_timestamp_ms" bigint NOT NULL,
	"stats" jsonb NOT NULL,
	"status_id" integer
);
--> statement-breakpoint
CREATE TABLE "simulated_orders" (
	"created_at_ms" bigint NOT NULL,
	"decision_id" text NOT NULL,
	"fixture_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"market_id" text NOT NULL,
	"order_id" text PRIMARY KEY NOT NULL,
	"outcome_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"price" integer NOT NULL,
	"settled_at_ms" bigint,
	"settlement" "order_settlement",
	"side" "order_side" NOT NULL,
	"stake_micros" bigint NOT NULL,
	"status" "order_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_decisions" (
	"action" "decision_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision_id" text PRIMARY KEY NOT NULL,
	"expected_state_version" integer NOT NULL,
	"fixture_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"logical_timestamp_ms" bigint NOT NULL,
	"market_id" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"next_state" "market_control_state" NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer NOT NULL,
	"policy_version" text NOT NULL,
	"previous_state" "market_control_state" NOT NULL,
	"reason_codes" text[] NOT NULL,
	"trigger_event_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_decision_id_strategy_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."strategy_decisions"("decision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_raw_ingest_id_raw_ingest_records_ingest_id_fk" FOREIGN KEY ("raw_ingest_id") REFERENCES "public"."raw_ingest_records"("ingest_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD CONSTRAINT "fixture_score_state_last_event_id_domain_events_event_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_last_event_id_domain_events_event_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_control_states" ADD CONSTRAINT "market_control_states_last_decision_id_strategy_decisions_decision_id_fk" FOREIGN KEY ("last_decision_id") REFERENCES "public"."strategy_decisions"("decision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_last_event_id_domain_events_event_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_quote_observations" ADD CONSTRAINT "outcome_quote_observations_event_id_domain_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_events" ADD CONSTRAINT "score_events_event_id_domain_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_decision_id_strategy_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."strategy_decisions"("decision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_trigger_event_id_domain_events_event_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_receipts_decision_uidx" ON "decision_receipts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "decision_receipts_status_idx" ON "decision_receipts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_idempotency_uidx" ON "domain_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_raw_ingest_uidx" ON "domain_events" USING btree ("raw_ingest_id");--> statement-breakpoint
CREATE INDEX "domain_events_fixture_order_idx" ON "domain_events" USING btree ("fixture_id","source_timestamp_ms","sequence","source_priority","source_id","idempotency_key","event_id");--> statement-breakpoint
CREATE INDEX "domain_events_kind_received_idx" ON "domain_events" USING btree ("kind","received_at_ms");--> statement-breakpoint
CREATE INDEX "fixtures_status_scheduled_idx" ON "fixtures" USING btree ("status","scheduled_at_ms");--> statement-breakpoint
CREATE INDEX "fixtures_competition_scheduled_idx" ON "fixtures" USING btree ("competition_id","scheduled_at_ms");--> statement-breakpoint
CREATE INDEX "market_control_fixture_state_idx" ON "market_control_states" USING btree ("fixture_id","state");--> statement-breakpoint
CREATE INDEX "markets_fixture_status_idx" ON "markets" USING btree ("fixture_id","status");--> statement-breakpoint
CREATE INDEX "markets_fixture_updated_idx" ON "markets" USING btree ("fixture_id","updated_at_ms");--> statement-breakpoint
CREATE INDEX "quotes_market_outcome_time_idx" ON "outcome_quote_observations" USING btree ("market_id","outcome_id","source_timestamp_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quotes_fixture_time_idx" ON "outcome_quote_observations" USING btree ("fixture_id","source_timestamp_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quotes_bookmaker_time_idx" ON "outcome_quote_observations" USING btree ("bookmaker_id","source_timestamp_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "raw_ingest_idempotency_uidx" ON "raw_ingest_records" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "raw_ingest_status_received_idx" ON "raw_ingest_records" USING btree ("status","received_at_ms");--> statement-breakpoint
CREATE INDEX "raw_ingest_fixture_received_idx" ON "raw_ingest_records" USING btree ("fixture_id","received_at_ms");--> statement-breakpoint
CREATE INDEX "replay_runs_fixture_started_idx" ON "replay_runs" USING btree ("input_fixture_id","started_at_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replay_runs_status_started_idx" ON "replay_runs" USING btree ("status","started_at_ms");--> statement-breakpoint
CREATE INDEX "score_events_fixture_order_idx" ON "score_events" USING btree ("fixture_id","source_timestamp_ms","sequence","event_id");--> statement-breakpoint
CREATE INDEX "score_events_fixture_action_idx" ON "score_events" USING btree ("fixture_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_orders_idempotency_uidx" ON "simulated_orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "simulated_orders_fixture_time_idx" ON "simulated_orders" USING btree ("fixture_id","created_at_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "simulated_orders_market_time_idx" ON "simulated_orders" USING btree ("market_id","created_at_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "simulated_orders_status_time_idx" ON "simulated_orders" USING btree ("status","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_decisions_idempotency_uidx" ON "strategy_decisions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "strategy_decisions_fixture_time_idx" ON "strategy_decisions" USING btree ("fixture_id","logical_timestamp_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "strategy_decisions_market_time_idx" ON "strategy_decisions" USING btree ("market_id","logical_timestamp_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "strategy_decisions_trigger_idx" ON "strategy_decisions" USING btree ("trigger_event_id");