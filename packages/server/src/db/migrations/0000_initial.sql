CREATE TABLE `ai_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`response` text NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_cache_expiry_idx` ON `ai_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`cache_hit` integer DEFAULT false NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error_code` text,
	`error` text,
	`prompt_hash` text,
	`schema_retries` integer DEFAULT 0 NOT NULL,
	`injection_detected` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_requests_time_idx` ON `ai_requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_requests_purpose_idx` ON `ai_requests` (`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_requests_ref_idx` ON `ai_requests` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`parameters` text,
	`result` text DEFAULT 'ok' NOT NULL,
	`result_detail` text,
	`model_version` text,
	`transaction_signature` text,
	`reason` text,
	`ip_address` text,
	`previous_hash` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_sequence_uq` ON `audit_log` (`sequence`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `bandit_arms` (
	`id` text PRIMARY KEY NOT NULL,
	`dimension` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`reward_sum` real DEFAULT 0 NOT NULL,
	`reward_count` integer DEFAULT 0 NOT NULL,
	`prior_alpha` real DEFAULT 1 NOT NULL,
	`prior_beta` real DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bandit_arm_uq` ON `bandit_arms` (`dimension`,`key`);--> statement-breakpoint
CREATE TABLE `competitor_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`mint` text,
	`name` text NOT NULL,
	`symbol` text NOT NULL,
	`description` text,
	`embedding` text,
	`created_on_chain_at` integer NOT NULL,
	`market_cap_usd` real,
	`volume_24h_usd` real,
	`liquidity_usd` real,
	`holders` integer,
	`graduated` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_mint_uq` ON `competitor_tokens` (`mint`);--> statement-breakpoint
CREATE INDEX `competitor_symbol_idx` ON `competitor_tokens` (`symbol`);--> statement-breakpoint
CREATE INDEX `competitor_created_idx` ON `competitor_tokens` (`created_on_chain_at`);--> statement-breakpoint
CREATE INDEX `competitor_observed_idx` ON `competitor_tokens` (`observed_at`);--> statement-breakpoint
CREATE TABLE `concept_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`sub_scores` text,
	`verdict` text,
	`summary` text,
	`concerns` text DEFAULT '[]' NOT NULL,
	`strengths` text DEFAULT '[]' NOT NULL,
	`risk_flags` text DEFAULT '[]' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concept_eval_concept_idx` ON `concept_evaluations` (`concept_id`);--> statement-breakpoint
CREATE INDEX `concept_eval_role_idx` ON `concept_evaluations` (`role`);--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`trend_id` text,
	`batch_id` text,
	`name` text NOT NULL,
	`symbol` text NOT NULL,
	`description` text NOT NULL,
	`narrative` text,
	`archetype` text DEFAULT 'unknown' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rejection_reason` text,
	`rejection_detail` text,
	`image_prompt` text,
	`image_path` text,
	`image_uri` text,
	`metadata_uri` text,
	`image_hash` text,
	`embedding` text,
	`embedding_model` text DEFAULT 'local-hash-v1' NOT NULL,
	`originality_score` real DEFAULT 0 NOT NULL,
	`saturation_score` real DEFAULT 0 NOT NULL,
	`opportunity_score` real DEFAULT 0 NOT NULL,
	`name_quality` real DEFAULT 0 NOT NULL,
	`ticker_quality` real DEFAULT 0 NOT NULL,
	`ai_panel_score` real DEFAULT 0 NOT NULL,
	`ai_panel_disagreement` real DEFAULT 0 NOT NULL,
	`meme_intensity` real DEFAULT 0 NOT NULL,
	`cultural_relevance` real DEFAULT 0 NOT NULL,
	`artwork_quality` real DEFAULT 0 NOT NULL,
	`risk_flags` text DEFAULT '[]' NOT NULL,
	`hard_collision` integer DEFAULT false NOT NULL,
	`requires_human_review` integer DEFAULT true NOT NULL,
	`saturation_detail` text,
	`originality_detail` text,
	`reasoning_summary` text,
	`generator_model` text,
	`generation_cost_usd` real DEFAULT 0 NOT NULL,
	`is_exploration` integer DEFAULT false NOT NULL,
	`exploration_arm` text,
	`approved_by` text,
	`approved_at` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`trend_id`) REFERENCES `trends`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `concepts_status_idx` ON `concepts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `concepts_trend_idx` ON `concepts` (`trend_id`);--> statement-breakpoint
CREATE INDEX `concepts_batch_idx` ON `concepts` (`batch_id`);--> statement-breakpoint
CREATE INDEX `concepts_symbol_idx` ON `concepts` (`symbol`);--> statement-breakpoint
CREATE TABLE `creator_fee_events` (
	`id` text PRIMARY KEY NOT NULL,
	`token_mint` text,
	`kind` text NOT NULL,
	`vault` text DEFAULT 'curve' NOT NULL,
	`vault_address` text,
	`wallet_address` text,
	`lamports` integer DEFAULT 0 NOT NULL,
	`claimable_lamports` integer DEFAULT 0 NOT NULL,
	`usd_value` real,
	`sol_price_usd` real,
	`transaction_signature` text,
	`network_fee_lamports` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'rpc' NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`token_mint`) REFERENCES `tokens`(`mint`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fee_events_token_idx` ON `creator_fee_events` (`token_mint`,`observed_at`);--> statement-breakpoint
CREATE INDEX `fee_events_kind_idx` ON `creator_fee_events` (`kind`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `fee_events_signature_uq` ON `creator_fee_events` (`transaction_signature`,`vault`);--> statement-breakpoint
CREATE TABLE `daily_metrics` (
	`day` text NOT NULL,
	`network` text NOT NULL,
	`launches` integer DEFAULT 0 NOT NULL,
	`launch_failures` integer DEFAULT 0 NOT NULL,
	`concepts_generated` integer DEFAULT 0 NOT NULL,
	`concepts_rejected` integer DEFAULT 0 NOT NULL,
	`trends_discovered` integer DEFAULT 0 NOT NULL,
	`creator_fees_lamports` integer DEFAULT 0 NOT NULL,
	`creator_fees_collected_lamports` integer DEFAULT 0 NOT NULL,
	`organic_volume_sol` real DEFAULT 0 NOT NULL,
	`spend_lamports` integer DEFAULT 0 NOT NULL,
	`ai_spend_usd` real DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`day`, `network`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`description` text,
	`amount_usd` real DEFAULT 0 NOT NULL,
	`amount_lamports` integer DEFAULT 0 NOT NULL,
	`sol_price_usd` real,
	`ref_type` text,
	`ref_id` text,
	`provider` text,
	`incurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `expenses_kind_time_idx` ON `expenses` (`kind`,`incurred_at`);--> statement-breakpoint
CREATE INDEX `expenses_ref_idx` ON `expenses` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `experiment_arms` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`reward_sum` real DEFAULT 0 NOT NULL,
	`reward_count` integer DEFAULT 0 NOT NULL,
	`prior_alpha` real DEFAULT 1 NOT NULL,
	`prior_beta` real DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_arm_uq` ON `experiment_arms` (`experiment_id`,`key`);--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`arm_id` text NOT NULL,
	`concept_id` text,
	`token_mint` text,
	`outcome_value` real,
	`outcome_success` integer,
	`outcome_at` integer,
	`assigned_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arm_id`) REFERENCES `experiment_arms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_assignment_uq` ON `experiment_assignments` (`experiment_id`,`concept_id`);--> statement-breakpoint
CREATE INDEX `experiment_assignment_arm_idx` ON `experiment_assignments` (`arm_id`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hypothesis` text NOT NULL,
	`factor` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`metric` text DEFAULT 'creator_fees_sol' NOT NULL,
	`min_samples_per_arm` integer DEFAULT 12 NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`conclusion` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `experiments_status_idx` ON `experiments` (`status`);--> statement-breakpoint
CREATE TABLE `holder_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`token_mint` text NOT NULL,
	`observed_at` integer NOT NULL,
	`holder_count` integer NOT NULL,
	`top10_share` real,
	`gini` real,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`token_mint`) REFERENCES `tokens`(`mint`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `holder_snap_token_time_idx` ON `holder_snapshots` (`token_mint`,`observed_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`result_ref` text,
	`result` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idempotency_scope_idx` ON `idempotency_keys` (`scope`);--> statement-breakpoint
CREATE INDEX `idempotency_expiry_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`lock_token` text,
	`trigger` text DEFAULT 'schedule' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`items_processed` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_name_time_idx` ON `job_runs` (`job_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_runs_status_idx` ON `job_runs` (`status`);--> statement-breakpoint
CREATE TABLE `job_state` (
	`job_name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_seconds` integer NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`last_status` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`lock_token` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `launches` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`prediction_id` text,
	`idempotency_key` text NOT NULL,
	`network` text NOT NULL,
	`adapter` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`mint_address` text,
	`mint_secret_encrypted` text,
	`creator_address` text,
	`transaction_signature` text,
	`blockhash` text,
	`last_valid_block_height` integer,
	`slot` integer,
	`metadata_uri` text,
	`image_uri` text,
	`dev_buy_lamports` integer DEFAULT 0 NOT NULL,
	`priority_fee_micro_lamports` integer DEFAULT 0 NOT NULL,
	`total_cost_lamports` integer DEFAULT 0 NOT NULL,
	`network_fee_lamports` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`error_code` text,
	`attempt_log` text DEFAULT '[]' NOT NULL,
	`approval_mode` text DEFAULT 'manual' NOT NULL,
	`initiated_by` text,
	`submitted_at` integer,
	`confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prediction_id`) REFERENCES `predictions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launches_idempotency_uq` ON `launches` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `launches_mint_uq` ON `launches` (`mint_address`);--> statement-breakpoint
CREATE INDEX `launches_status_idx` ON `launches` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `launches_network_idx` ON `launches` (`network`);--> statement-breakpoint
CREATE TABLE `market_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_mint` text NOT NULL,
	`observed_at` integer NOT NULL,
	`source` text NOT NULL,
	`price_sol` real,
	`price_usd` real,
	`market_cap_usd` real,
	`liquidity_usd` real,
	`volume_5m_sol` real,
	`volume_1h_sol` real,
	`volume_24h_sol` real,
	`holders` integer,
	`tx_count_24h` integer,
	`buys_24h` integer,
	`sells_24h` integer,
	`bonding_curve_progress` real,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`token_mint`) REFERENCES `tokens`(`mint`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `market_obs_token_time_idx` ON `market_observations` (`token_mint`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `market_obs_dedupe_uq` ON `market_observations` (`token_mint`,`source`,`observed_at`);--> statement-breakpoint
CREATE TABLE `market_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` integer NOT NULL,
	`launches_per_hour` real,
	`graduations_per_hour` real,
	`graduation_rate` real,
	`median_time_to_first_buy_minutes` real,
	`sol_price_usd` real,
	`sol_price_change_24h` real,
	`regime_score` real,
	`category_breakdown` text,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_snapshots_time_idx` ON `market_snapshots` (`observed_at`);--> statement-breakpoint
CREATE TABLE `model_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`kind` text DEFAULT 'success_bundle' NOT NULL,
	`state` text NOT NULL,
	`trained_on` integer DEFAULT 0 NOT NULL,
	`metrics` text,
	`notes` text,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_versions_version_uq` ON `model_versions` (`version`);--> statement-breakpoint
CREATE INDEX `model_versions_active_idx` ON `model_versions` (`active`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_status_idx` ON `notification_deliveries` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`dedupe_key` text,
	`ref_type` text,
	`ref_id` text,
	`data` text,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_event_time_idx` ON `notifications` (`event`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_dedupe_idx` ON `notifications` (`dedupe_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `prediction_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`prediction_id` text NOT NULL,
	`token_mint` text,
	`horizon_hours` real NOT NULL,
	`y_first_buy` integer,
	`y_ten_holders` integer,
	`y_hundred_holders` integer,
	`y_graduation` integer,
	`actual_volume_24h_sol` real,
	`actual_creator_fees_sol` real,
	`actual_lifespan_hours` real,
	`applied_to_model` integer DEFAULT false NOT NULL,
	`applied_model_version` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`prediction_id`) REFERENCES `predictions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prediction_outcome_uq` ON `prediction_outcomes` (`prediction_id`,`horizon_hours`);--> statement-breakpoint
CREATE INDEX `prediction_outcome_applied_idx` ON `prediction_outcomes` (`applied_to_model`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`model_version` text NOT NULL,
	`features` text NOT NULL,
	`p_first_buy` real DEFAULT 0 NOT NULL,
	`p_ten_holders` real DEFAULT 0 NOT NULL,
	`p_hundred_holders` real DEFAULT 0 NOT NULL,
	`p_graduation` real DEFAULT 0 NOT NULL,
	`expected_volume_1h_sol` real DEFAULT 0 NOT NULL,
	`expected_volume_24h_sol` real DEFAULT 0 NOT NULL,
	`expected_volume_7d_sol` real DEFAULT 0 NOT NULL,
	`expected_creator_fees_sol` real DEFAULT 0 NOT NULL,
	`creator_fees_p10_sol` real DEFAULT 0 NOT NULL,
	`creator_fees_p90_sol` real DEFAULT 0 NOT NULL,
	`creator_fees_median_sol` real DEFAULT 0 NOT NULL,
	`expected_lifespan_hours` real DEFAULT 0 NOT NULL,
	`expected_value_sol` real DEFAULT 0 NOT NULL,
	`probability_profitable` real DEFAULT 0 NOT NULL,
	`tail_concentration` real DEFAULT 0 NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`drivers` text,
	`economics` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `predictions_concept_idx` ON `predictions` (`concept_id`);--> statement-breakpoint
CREATE INDEX `predictions_model_idx` ON `predictions` (`model_version`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`detail` text,
	`latency_ms` integer,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`circuit_open_until` integer,
	`rate_limit_reset_at` integer,
	`last_success_at` integer,
	`last_failure_at` integer,
	`checked_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`salt` text NOT NULL,
	`kdf` text DEFAULT 'scrypt' NOT NULL,
	`hint` text,
	`category` text DEFAULT 'api_key' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `secrets_category_idx` ON `secrets` (`category`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `setting_history` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`previous_value` text,
	`new_value` text,
	`changed_by` text,
	`actor_type` text DEFAULT 'user' NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `setting_history_path_idx` ON `setting_history` (`path`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`component` text NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`ref_type` text,
	`ref_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_events_time_idx` ON `system_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `system_events_level_idx` ON `system_events` (`level`,`created_at`);--> statement-breakpoint
CREATE INDEX `system_events_component_idx` ON `system_events` (`component`,`created_at`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`mint` text PRIMARY KEY NOT NULL,
	`launch_id` text,
	`concept_id` text,
	`trend_id` text,
	`network` text NOT NULL,
	`name` text NOT NULL,
	`symbol` text NOT NULL,
	`metadata_uri` text,
	`image_uri` text,
	`creator_address` text NOT NULL,
	`lifecycle` text DEFAULT 'new' NOT NULL,
	`bonding_curve_address` text,
	`pool_address` text,
	`pool_is_canonical` integer,
	`created_on_chain_at` integer,
	`first_trade_at` integer,
	`last_trade_at` integer,
	`graduated_at` integer,
	`dormant_at` integer,
	`holders` integer DEFAULT 0 NOT NULL,
	`peak_holders` integer DEFAULT 0 NOT NULL,
	`unique_buyers` integer DEFAULT 0 NOT NULL,
	`market_cap_usd` real DEFAULT 0 NOT NULL,
	`peak_market_cap_usd` real DEFAULT 0 NOT NULL,
	`price_sol` real DEFAULT 0 NOT NULL,
	`liquidity_usd` real DEFAULT 0 NOT NULL,
	`volume_1h_sol` real DEFAULT 0 NOT NULL,
	`volume_24h_sol` real DEFAULT 0 NOT NULL,
	`volume_total_sol` real DEFAULT 0 NOT NULL,
	`peak_volume_24h_sol` real DEFAULT 0 NOT NULL,
	`tx_count` integer DEFAULT 0 NOT NULL,
	`buy_count` integer DEFAULT 0 NOT NULL,
	`sell_count` integer DEFAULT 0 NOT NULL,
	`holder_gini` real DEFAULT 0 NOT NULL,
	`creator_fees_accrued_lamports` integer DEFAULT 0 NOT NULL,
	`creator_fees_collected_lamports` integer DEFAULT 0 NOT NULL,
	`last_fee_check_at` integer,
	`last_fee_collection_at` integer,
	`monitor_tier` text DEFAULT 'hot' NOT NULL,
	`next_poll_at` integer,
	`poll_failure_count` integer DEFAULT 0 NOT NULL,
	`data_source` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trend_id`) REFERENCES `trends`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tokens_lifecycle_idx` ON `tokens` (`lifecycle`);--> statement-breakpoint
CREATE INDEX `tokens_next_poll_idx` ON `tokens` (`next_poll_at`);--> statement-breakpoint
CREATE INDEX `tokens_network_idx` ON `tokens` (`network`);--> statement-breakpoint
CREATE INDEX `tokens_created_idx` ON `tokens` (`created_at`);--> statement-breakpoint
CREATE TABLE `trend_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`trend_id` text NOT NULL,
	`source` text NOT NULL,
	`observed_at` integer NOT NULL,
	`raw_value` real NOT NULL,
	`normalised_value` real DEFAULT 0 NOT NULL,
	`rank` integer,
	`engagement` real,
	`audience` real,
	`excerpt` text,
	`url` text,
	`external_id` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`trend_id`) REFERENCES `trends`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trend_obs_trend_time_idx` ON `trend_observations` (`trend_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `trend_obs_source_time_idx` ON `trend_observations` (`source`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `trend_obs_dedupe_uq` ON `trend_observations` (`trend_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `trends` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`category` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`phase` text DEFAULT 'nascent' NOT NULL,
	`embedding` text,
	`embedding_model` text DEFAULT 'local-hash-v1' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`opportunity_score` real DEFAULT 0 NOT NULL,
	`raw_opportunity_score` real DEFAULT 0 NOT NULL,
	`saturation_score` real DEFAULT 0 NOT NULL,
	`velocity` real DEFAULT 0 NOT NULL,
	`acceleration` real DEFAULT 0 NOT NULL,
	`consistency` real DEFAULT 0 NOT NULL,
	`novelty` real DEFAULT 0 NOT NULL,
	`audience_estimate` real DEFAULT 0 NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`engagement` real DEFAULT 0 NOT NULL,
	`memeability` real DEFAULT 0 NOT NULL,
	`remaining_lifespan_hours` real DEFAULT 0 NOT NULL,
	`score_breakdown` text,
	`ai_summary` text,
	`injection_flagged` integer DEFAULT false NOT NULL,
	`scored_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trends_slug_uq` ON `trends` (`slug`);--> statement-breakpoint
CREATE INDEX `trends_status_score_idx` ON `trends` (`status`,`opportunity_score`);--> statement-breakpoint
CREATE INDEX `trends_last_seen_idx` ON `trends` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `trends_category_idx` ON `trends` (`category`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`password_hash` text NOT NULL,
	`password_params` text NOT NULL,
	`totp_secret_encrypted` text,
	`active` integer DEFAULT true NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `wallet_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`address` text NOT NULL,
	`label` text NOT NULL,
	`network` text NOT NULL,
	`has_signing_key` integer DEFAULT false NOT NULL,
	`custody` text DEFAULT 'watch_only' NOT NULL,
	`balance_lamports` integer DEFAULT 0 NOT NULL,
	`balance_checked_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_address_network_uq` ON `wallet_accounts` (`address`,`network`);--> statement-breakpoint
CREATE INDEX `wallet_role_idx` ON `wallet_accounts` (`role`);--> statement-breakpoint
CREATE TABLE `wallet_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`network` text NOT NULL,
	`signature` text,
	`direction` text NOT NULL,
	`purpose` text NOT NULL,
	`lamports` integer NOT NULL,
	`fee_lamports` integer DEFAULT 0 NOT NULL,
	`counterparty` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`idempotency_key` text,
	`initiated_by` text,
	`error` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_tx_signature_uq` ON `wallet_transactions` (`signature`);--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_tx_idempotency_uq` ON `wallet_transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `wallet_tx_wallet_time_idx` ON `wallet_transactions` (`wallet_address`,`occurred_at`);