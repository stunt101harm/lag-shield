ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_anchored_at_check" CHECK ("decision_receipts"."anchored_at_ms" IS NULL OR "decision_receipts"."anchored_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_payload_version_check" CHECK ("domain_events"."payload_version" > 0);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_received_at_check" CHECK ("domain_events"."received_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_sequence_check" CHECK ("domain_events"."sequence" >= 0);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_source_timestamp_check" CHECK ("domain_events"."source_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_source_priority_check" CHECK (("domain_events"."source" = 'simulation' AND "domain_events"."source_priority" = 0)
        OR ("domain_events"."source" = 'txline-historical' AND "domain_events"."source_priority" = 10)
        OR ("domain_events"."source" = 'txline-snapshot' AND "domain_events"."source_priority" = 20)
        OR ("domain_events"."source" = 'txline-live' AND "domain_events"."source_priority" = 30));--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD CONSTRAINT "fixture_score_home_check" CHECK ("fixture_score_state"."home_score" IS NULL OR "fixture_score_state"."home_score" >= 0);--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD CONSTRAINT "fixture_score_away_check" CHECK ("fixture_score_state"."away_score" IS NULL OR "fixture_score_state"."away_score" >= 0);--> statement-breakpoint
ALTER TABLE "fixture_score_state" ADD CONSTRAINT "fixture_score_updated_at_check" CHECK ("fixture_score_state"."updated_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_scheduled_at_check" CHECK ("fixtures"."scheduled_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_updated_at_check" CHECK ("fixtures"."updated_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "market_control_states" ADD CONSTRAINT "market_control_state_version_check" CHECK ("market_control_states"."state_version" > 0);--> statement-breakpoint
ALTER TABLE "market_control_states" ADD CONSTRAINT "market_control_logical_timestamp_check" CHECK ("market_control_states"."logical_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_updated_at_check" CHECK ("markets"."updated_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "outcome_quote_observations" ADD CONSTRAINT "quotes_received_at_check" CHECK ("outcome_quote_observations"."received_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "outcome_quote_observations" ADD CONSTRAINT "quotes_sequence_check" CHECK ("outcome_quote_observations"."sequence" >= 0);--> statement-breakpoint
ALTER TABLE "outcome_quote_observations" ADD CONSTRAINT "quotes_source_timestamp_check" CHECK ("outcome_quote_observations"."source_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_payload_version_check" CHECK ("raw_ingest_records"."payload_version" > 0);--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_received_at_check" CHECK ("raw_ingest_records"."received_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "raw_ingest_records" ADD CONSTRAINT "raw_ingest_source_timestamp_check" CHECK ("raw_ingest_records"."source_timestamp_ms" IS NULL OR "raw_ingest_records"."source_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_event_count_check" CHECK ("replay_runs"."event_count" >= 0);--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_started_at_check" CHECK ("replay_runs"."started_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_completed_at_check" CHECK ("replay_runs"."completed_at_ms" IS NULL OR "replay_runs"."completed_at_ms" >= "replay_runs"."started_at_ms");--> statement-breakpoint
ALTER TABLE "score_events" ADD CONSTRAINT "score_events_home_score_check" CHECK ("score_events"."home_score" IS NULL OR "score_events"."home_score" >= 0);--> statement-breakpoint
ALTER TABLE "score_events" ADD CONSTRAINT "score_events_away_score_check" CHECK ("score_events"."away_score" IS NULL OR "score_events"."away_score" >= 0);--> statement-breakpoint
ALTER TABLE "score_events" ADD CONSTRAINT "score_events_sequence_check" CHECK ("score_events"."sequence" >= 0);--> statement-breakpoint
ALTER TABLE "score_events" ADD CONSTRAINT "score_events_source_timestamp_check" CHECK ("score_events"."source_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_created_at_check" CHECK ("simulated_orders"."created_at_ms" >= 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_stake_check" CHECK ("simulated_orders"."stake_micros" > 0);--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_settled_at_check" CHECK ("simulated_orders"."settled_at_ms" IS NULL OR "simulated_orders"."settled_at_ms" >= "simulated_orders"."created_at_ms");--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_state_version_check" CHECK ("strategy_decisions"."expected_state_version" >= 0);--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_logical_timestamp_check" CHECK ("strategy_decisions"."logical_timestamp_ms" >= 0);--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_payload_version_check" CHECK ("strategy_decisions"."payload_version" > 0);