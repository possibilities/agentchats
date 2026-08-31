#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  assertCassWriterLock,
  expectedRawMirrorRoot,
  retiredConversationIds as rawRetiredConversationIds,
} from "./retire-pi-raw-mirror.mjs";

const CASS_DATA_COMPONENTS = [
  "Library",
  "Application Support",
  "com.coding-agent-search.coding-agent-search",
];
const DATABASE_NAME = "agent_search.db";
const ALLOWED_SIDECARS = new Set([
  "-journal",
  "-fsqlite-ns-gate",
  "-fsqlite-ns-use",
  "-shm",
  "-wal",
  "-wal-cert",
  "-wal-cert-head",
]);

// Cass 0.6.25's canonical archive is schema v20. These signatures come from
// SQLite's own introspection surfaces, not sqlite_schema text formatting, so a
// rebuilt table cannot smuggle in a changed column, key, default, index, or
// foreign-key contract under a familiar name.
const TABLE_XINFO = new Map([
  ["meta", "0:key:TEXT:0:∅:1:0;1:value:TEXT:1:∅:0:0"],
  ["_schema_migrations", "0:version:INTEGER:0:∅:1:0;1:name:TEXT:1:∅:0:0;2:applied_at:TEXT:1:strftime('%Y-%m-%dT%H:%M:%SZ', 'now'):0:0"],
  ["agents", "0:id:INTEGER:0:∅:1:0;1:slug:TEXT:1:∅:0:0;2:name:TEXT:1:∅:0:0;3:version:TEXT:0:∅:0:0;4:kind:TEXT:1:∅:0:0;5:created_at:INTEGER:1:∅:0:0;6:updated_at:INTEGER:1:∅:0:0"],
  ["conversations", "0:id:INTEGER:0:∅:1:0;1:agent_id:INTEGER:1:∅:0:0;2:workspace_id:INTEGER:0:∅:0:0;3:source_id:TEXT:1:'local':0:0;4:external_id:TEXT:0:∅:0:0;5:title:TEXT:0:∅:0:0;6:source_path:TEXT:1:∅:0:0;7:started_at:INTEGER:0:∅:0:0;8:ended_at:INTEGER:0:∅:0:0;9:approx_tokens:INTEGER:0:∅:0:0;10:metadata_json:TEXT:0:∅:0:0;11:origin_host:TEXT:0:∅:0:0;12:metadata_bin:BLOB:0:∅:0:0;13:total_input_tokens:INTEGER:0:∅:0:0;14:total_output_tokens:INTEGER:0:∅:0:0;15:total_cache_read_tokens:INTEGER:0:∅:0:0;16:total_cache_creation_tokens:INTEGER:0:∅:0:0;17:grand_total_tokens:INTEGER:0:∅:0:0;18:estimated_cost_usd:REAL:0:∅:0:0;19:primary_model:TEXT:0:∅:0:0;20:api_call_count:INTEGER:0:∅:0:0;21:tool_call_count:INTEGER:0:∅:0:0;22:user_message_count:INTEGER:0:∅:0:0;23:assistant_message_count:INTEGER:0:∅:0:0;24:last_message_idx:INTEGER:0:∅:0:0;25:last_message_created_at:INTEGER:0:∅:0:0"],
  ["messages", "0:id:INTEGER:0:∅:1:0;1:conversation_id:INTEGER:1:∅:0:0;2:idx:INTEGER:1:∅:0:0;3:role:TEXT:1:∅:0:0;4:author:TEXT:0:∅:0:0;5:created_at:INTEGER:0:∅:0:0;6:content:TEXT:1:∅:0:0;7:extra_json:TEXT:0:∅:0:0;8:extra_bin:BLOB:0:∅:0:0"],
  ["daily_stats", "0:day_id:INTEGER:1:∅:1:0;1:agent_slug:TEXT:1:∅:2:0;2:source_id:TEXT:1:'all':3:0;3:session_count:INTEGER:1:0:0:0;4:message_count:INTEGER:1:0:0:0;5:total_chars:INTEGER:1:0:0:0;6:last_updated:INTEGER:1:∅:0:0"],
  ["token_daily_stats", "0:day_id:INTEGER:1:∅:1:0;1:agent_slug:TEXT:1:∅:2:0;2:source_id:TEXT:1:'all':3:0;3:model_family:TEXT:1:'all':4:0;4:api_call_count:INTEGER:1:0:0:0;5:user_message_count:INTEGER:1:0:0:0;6:assistant_message_count:INTEGER:1:0:0:0;7:tool_message_count:INTEGER:1:0:0:0;8:total_input_tokens:INTEGER:1:0:0:0;9:total_output_tokens:INTEGER:1:0:0:0;10:total_cache_read_tokens:INTEGER:1:0:0:0;11:total_cache_creation_tokens:INTEGER:1:0:0:0;12:total_thinking_tokens:INTEGER:1:0:0:0;13:grand_total_tokens:INTEGER:1:0:0:0;14:total_content_chars:INTEGER:1:0:0:0;15:total_tool_calls:INTEGER:1:0:0:0;16:estimated_cost_usd:REAL:1:0.0:0:0;17:session_count:INTEGER:1:0:0:0;18:last_updated:INTEGER:1:∅:0:0"],
  ["message_metrics", "0:message_id:INTEGER:0:∅:1:0;1:created_at_ms:INTEGER:1:∅:0:0;2:hour_id:INTEGER:1:∅:0:0;3:day_id:INTEGER:1:∅:0:0;4:agent_slug:TEXT:1:∅:0:0;5:workspace_id:INTEGER:1:0:0:0;6:source_id:TEXT:1:'local':0:0;7:role:TEXT:1:∅:0:0;8:content_chars:INTEGER:1:∅:0:0;9:content_tokens_est:INTEGER:1:∅:0:0;10:api_input_tokens:INTEGER:0:∅:0:0;11:api_output_tokens:INTEGER:0:∅:0:0;12:api_cache_read_tokens:INTEGER:0:∅:0:0;13:api_cache_creation_tokens:INTEGER:0:∅:0:0;14:api_thinking_tokens:INTEGER:0:∅:0:0;15:api_service_tier:TEXT:0:∅:0:0;16:api_data_source:TEXT:1:'estimated':0:0;17:tool_call_count:INTEGER:1:0:0:0;18:has_tool_calls:INTEGER:1:0:0:0;19:has_plan:INTEGER:1:0:0:0;20:model_name:TEXT:0:∅:0:0;21:model_family:TEXT:1:'unknown':0:0;22:model_tier:TEXT:1:'unknown':0:0;23:provider:TEXT:1:'unknown':0:0"],
  ["usage_hourly", "0:hour_id:INTEGER:1:∅:1:0;1:agent_slug:TEXT:1:∅:2:0;2:workspace_id:INTEGER:1:0:3:0;3:source_id:TEXT:1:'local':4:0;4:message_count:INTEGER:1:0:0:0;5:user_message_count:INTEGER:1:0:0:0;6:assistant_message_count:INTEGER:1:0:0:0;7:tool_call_count:INTEGER:1:0:0:0;8:plan_message_count:INTEGER:1:0:0:0;9:api_coverage_message_count:INTEGER:1:0:0:0;10:content_tokens_est_total:INTEGER:1:0:0:0;11:content_tokens_est_user:INTEGER:1:0:0:0;12:content_tokens_est_assistant:INTEGER:1:0:0:0;13:api_tokens_total:INTEGER:1:0:0:0;14:api_input_tokens_total:INTEGER:1:0:0:0;15:api_output_tokens_total:INTEGER:1:0:0:0;16:api_cache_read_tokens_total:INTEGER:1:0:0:0;17:api_cache_creation_tokens_total:INTEGER:1:0:0:0;18:api_thinking_tokens_total:INTEGER:1:0:0:0;19:last_updated:INTEGER:1:0:0:0;20:plan_content_tokens_est_total:INTEGER:1:0:0:0;21:plan_api_tokens_total:INTEGER:1:0:0:0"],
  ["usage_daily", "0:day_id:INTEGER:1:∅:1:0;1:agent_slug:TEXT:1:∅:2:0;2:workspace_id:INTEGER:1:0:3:0;3:source_id:TEXT:1:'local':4:0;4:message_count:INTEGER:1:0:0:0;5:user_message_count:INTEGER:1:0:0:0;6:assistant_message_count:INTEGER:1:0:0:0;7:tool_call_count:INTEGER:1:0:0:0;8:plan_message_count:INTEGER:1:0:0:0;9:api_coverage_message_count:INTEGER:1:0:0:0;10:content_tokens_est_total:INTEGER:1:0:0:0;11:content_tokens_est_user:INTEGER:1:0:0:0;12:content_tokens_est_assistant:INTEGER:1:0:0:0;13:api_tokens_total:INTEGER:1:0:0:0;14:api_input_tokens_total:INTEGER:1:0:0:0;15:api_output_tokens_total:INTEGER:1:0:0:0;16:api_cache_read_tokens_total:INTEGER:1:0:0:0;17:api_cache_creation_tokens_total:INTEGER:1:0:0:0;18:api_thinking_tokens_total:INTEGER:1:0:0:0;19:last_updated:INTEGER:1:0:0:0;20:plan_content_tokens_est_total:INTEGER:1:0:0:0;21:plan_api_tokens_total:INTEGER:1:0:0:0"],
  ["usage_models_daily", "0:day_id:INTEGER:1:∅:1:0;1:agent_slug:TEXT:1:∅:2:0;2:workspace_id:INTEGER:1:0:3:0;3:source_id:TEXT:1:'local':4:0;4:model_family:TEXT:1:'unknown':5:0;5:model_tier:TEXT:1:'unknown':6:0;6:message_count:INTEGER:1:0:0:0;7:user_message_count:INTEGER:1:0:0:0;8:assistant_message_count:INTEGER:1:0:0:0;9:tool_call_count:INTEGER:1:0:0:0;10:plan_message_count:INTEGER:1:0:0:0;11:api_coverage_message_count:INTEGER:1:0:0:0;12:content_tokens_est_total:INTEGER:1:0:0:0;13:content_tokens_est_user:INTEGER:1:0:0:0;14:content_tokens_est_assistant:INTEGER:1:0:0:0;15:api_tokens_total:INTEGER:1:0:0:0;16:api_input_tokens_total:INTEGER:1:0:0:0;17:api_output_tokens_total:INTEGER:1:0:0:0;18:api_cache_read_tokens_total:INTEGER:1:0:0:0;19:api_cache_creation_tokens_total:INTEGER:1:0:0:0;20:api_thinking_tokens_total:INTEGER:1:0:0:0;21:last_updated:INTEGER:1:0:0:0"],
  ["token_usage", "0:id:INTEGER:0:∅:1:0;1:message_id:INTEGER:1:∅:0:0;2:conversation_id:INTEGER:1:∅:0:0;3:agent_id:INTEGER:1:∅:0:0;4:workspace_id:INTEGER:0:∅:0:0;5:source_id:TEXT:1:'local':0:0;6:timestamp_ms:INTEGER:1:∅:0:0;7:day_id:INTEGER:1:∅:0:0;8:model_name:TEXT:0:∅:0:0;9:model_family:TEXT:0:∅:0:0;10:model_tier:TEXT:0:∅:0:0;11:service_tier:TEXT:0:∅:0:0;12:provider:TEXT:0:∅:0:0;13:input_tokens:INTEGER:0:∅:0:0;14:output_tokens:INTEGER:0:∅:0:0;15:cache_read_tokens:INTEGER:0:∅:0:0;16:cache_creation_tokens:INTEGER:0:∅:0:0;17:thinking_tokens:INTEGER:0:∅:0:0;18:total_tokens:INTEGER:0:∅:0:0;19:estimated_cost_usd:REAL:0:∅:0:0;20:role:TEXT:1:∅:0:0;21:content_chars:INTEGER:1:∅:0:0;22:has_tool_calls:INTEGER:1:0:0:0;23:tool_call_count:INTEGER:1:0:0:0;24:data_source:TEXT:1:'api':0:0"],
  ["embedding_jobs", "0:id:INTEGER:0:∅:1:0;1:db_path:TEXT:1:∅:0:0;2:model_id:TEXT:1:∅:0:0;3:status:TEXT:1:'pending':0:0;4:total_docs:INTEGER:1:0:0:0;5:completed_docs:INTEGER:1:0:0:0;6:error_message:TEXT:0:∅:0:0;7:created_at:TEXT:1:datetime('now'):0:0;8:started_at:TEXT:0:∅:0:0;9:completed_at:TEXT:0:∅:0:0"],
]);

const FOREIGN_KEYS = new Map([
  ["agents", ""],
  ["conversations", "0:0:sources:source_id:id:NO ACTION:NO ACTION:NONE;1:0:workspaces:workspace_id:id:NO ACTION:NO ACTION:NONE;2:0:agents:agent_id:id:NO ACTION:NO ACTION:NONE"],
  ["messages", "0:0:conversations:conversation_id:id:NO ACTION:CASCADE:NONE"],
  ["daily_stats", ""],
  ["token_daily_stats", ""],
  ["message_metrics", "0:0:messages:message_id:id:NO ACTION:CASCADE:NONE"],
  ["usage_hourly", ""],
  ["usage_daily", ""],
  ["usage_models_daily", ""],
  ["token_usage", "0:0:messages:message_id:id:NO ACTION:CASCADE:NONE"],
  ["embedding_jobs", ""],
]);

const INDEX_SIGNATURES = new Map([
  ["meta", "sqlite_autoindex_meta_1:1:pk:0:0/0/key/0/BINARY/1;1/-1/∅/0/BINARY/0"],
  ["_schema_migrations", ""],
  ["agents", "sqlite_autoindex_agents_1:1:u:0:0/1/slug/0/BINARY/1;1/-1/∅/0/BINARY/0"],
  ["conversations", "idx_conversations_agent_started:0:c:0:0/1/agent_id/0/BINARY/1;1/7/started_at/1/BINARY/1;2/-1/∅/0/BINARY/0|idx_conversations_provenance:1:c:0:0/3/source_id/0/BINARY/1;1/1/agent_id/0/BINARY/1;2/4/external_id/0/BINARY/1;3/-1/∅/0/BINARY/0|idx_conversations_source_id:0:c:0:0/3/source_id/0/BINARY/1;1/-1/∅/0/BINARY/0|idx_conversations_source_path:0:c:0:0/6/source_path/0/BINARY/1;1/-1/∅/0/BINARY/0"],
  ["messages", "sqlite_autoindex_messages_1:1:u:0:0/1/conversation_id/0/BINARY/1;1/2/idx/0/BINARY/1;2/-1/∅/0/BINARY/0"],
  ["daily_stats", "idx_daily_stats_agent:0:c:0:0/1/agent_slug/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_daily_stats_source:0:c:0:0/2/source_id/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_daily_stats_1:1:pk:0:0/0/day_id/0/BINARY/1;1/1/agent_slug/0/BINARY/1;2/2/source_id/0/BINARY/1;3/-1/∅/0/BINARY/0"],
  ["token_daily_stats", "idx_token_daily_stats_agent:0:c:0:0/1/agent_slug/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_token_daily_stats_model:0:c:0:0/3/model_family/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_token_daily_stats_1:1:pk:0:0/0/day_id/0/BINARY/1;1/1/agent_slug/0/BINARY/1;2/2/source_id/0/BINARY/1;3/3/model_family/0/BINARY/1;4/-1/∅/0/BINARY/0"],
  ["message_metrics", "idx_mm_agent_day:0:c:0:0/4/agent_slug/0/BINARY/1;1/3/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_mm_agent_hour:0:c:0:0/4/agent_slug/0/BINARY/1;1/2/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_mm_day:0:c:0:0/3/day_id/0/BINARY/1;1/-1/∅/0/BINARY/0|idx_mm_hour:0:c:0:0/2/hour_id/0/BINARY/1;1/-1/∅/0/BINARY/0|idx_mm_model_family_day:0:c:0:0/21/model_family/0/BINARY/1;1/3/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_mm_provider_day:0:c:0:0/23/provider/0/BINARY/1;1/3/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_mm_source_hour:0:c:0:0/6/source_id/0/BINARY/1;1/2/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_mm_workspace_hour:0:c:0:0/5/workspace_id/0/BINARY/1;1/2/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0"],
  ["usage_hourly", "idx_uh_agent:0:c:0:0/1/agent_slug/0/BINARY/1;1/0/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_uh_source:0:c:0:0/3/source_id/0/BINARY/1;1/0/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_uh_workspace:0:c:0:0/2/workspace_id/0/BINARY/1;1/0/hour_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_usage_hourly_1:1:pk:0:0/0/hour_id/0/BINARY/1;1/1/agent_slug/0/BINARY/1;2/2/workspace_id/0/BINARY/1;3/3/source_id/0/BINARY/1;4/-1/∅/0/BINARY/0"],
  ["usage_daily", "idx_ud_agent:0:c:0:0/1/agent_slug/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_ud_source:0:c:0:0/3/source_id/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_ud_workspace:0:c:0:0/2/workspace_id/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_usage_daily_1:1:pk:0:0/0/day_id/0/BINARY/1;1/1/agent_slug/0/BINARY/1;2/2/workspace_id/0/BINARY/1;3/3/source_id/0/BINARY/1;4/-1/∅/0/BINARY/0"],
  ["usage_models_daily", "idx_umd_agent_day:0:c:0:0/1/agent_slug/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_umd_model_day:0:c:0:0/4/model_family/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_umd_source_day:0:c:0:0/3/source_id/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_umd_workspace_day:0:c:0:0/2/workspace_id/0/BINARY/1;1/0/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_usage_models_daily_1:1:pk:0:0/0/day_id/0/BINARY/1;1/1/agent_slug/0/BINARY/1;2/2/workspace_id/0/BINARY/1;3/3/source_id/0/BINARY/1;4/4/model_family/0/BINARY/1;5/5/model_tier/0/BINARY/1;6/-1/∅/0/BINARY/0"],
  ["token_usage", "idx_token_usage_conv:0:c:0:0/2/conversation_id/0/BINARY/1;1/-1/∅/0/BINARY/0|idx_token_usage_day:0:c:0:0/7/day_id/0/BINARY/1;1/3/agent_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_token_usage_model:0:c:0:0/9/model_family/0/BINARY/1;1/7/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|idx_token_usage_timestamp:0:c:0:0/6/timestamp_ms/0/BINARY/1;1/-1/∅/0/BINARY/0|idx_token_usage_workspace:0:c:0:0/4/workspace_id/0/BINARY/1;1/7/day_id/0/BINARY/1;2/-1/∅/0/BINARY/0|sqlite_autoindex_token_usage_1:1:u:0:0/1/message_id/0/BINARY/1;1/-1/∅/0/BINARY/0"],
  ["embedding_jobs", "idx_embedding_jobs_active:1:c:1:0/1/db_path/0/BINARY/1;1/2/model_id/0/BINARY/1;2/-1/∅/0/BINARY/0"],
]);

const NAMED_INDEX_SQL = new Map([
  ["idx_conversations_agent_started", "CREATE INDEX IF NOT EXISTS idx_conversations_agent_started ON conversations(agent_id, started_at DESC)"],
  ["idx_conversations_provenance", "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provenance ON conversations(source_id, agent_id, external_id)"],
  ["idx_conversations_source_id", "CREATE INDEX IF NOT EXISTS idx_conversations_source_id ON conversations(source_id)"],
  ["idx_conversations_source_path", "CREATE INDEX IF NOT EXISTS idx_conversations_source_path ON conversations(source_path)"],
  ["idx_daily_stats_agent", "CREATE INDEX IF NOT EXISTS idx_daily_stats_agent ON daily_stats(agent_slug, day_id)"],
  ["idx_daily_stats_source", "CREATE INDEX IF NOT EXISTS idx_daily_stats_source ON daily_stats(source_id, day_id)"],
  ["idx_embedding_jobs_active", "CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_jobs_active ON embedding_jobs(db_path, model_id) WHERE status IN ('pending', 'running')"],
  ["idx_mm_agent_day", "CREATE INDEX IF NOT EXISTS idx_mm_agent_day ON message_metrics(agent_slug, day_id)"],
  ["idx_mm_agent_hour", "CREATE INDEX IF NOT EXISTS idx_mm_agent_hour ON message_metrics(agent_slug, hour_id)"],
  ["idx_mm_day", "CREATE INDEX IF NOT EXISTS idx_mm_day ON message_metrics(day_id)"],
  ["idx_mm_hour", "CREATE INDEX IF NOT EXISTS idx_mm_hour ON message_metrics(hour_id)"],
  ["idx_mm_model_family_day", "CREATE INDEX IF NOT EXISTS idx_mm_model_family_day ON message_metrics(model_family, day_id)"],
  ["idx_mm_provider_day", "CREATE INDEX IF NOT EXISTS idx_mm_provider_day ON message_metrics(provider, day_id)"],
  ["idx_mm_source_hour", "CREATE INDEX IF NOT EXISTS idx_mm_source_hour ON message_metrics(source_id, hour_id)"],
  ["idx_mm_workspace_hour", "CREATE INDEX IF NOT EXISTS idx_mm_workspace_hour ON message_metrics(workspace_id, hour_id)"],
  ["idx_token_daily_stats_agent", "CREATE INDEX IF NOT EXISTS idx_token_daily_stats_agent ON token_daily_stats(agent_slug, day_id)"],
  ["idx_token_daily_stats_model", "CREATE INDEX IF NOT EXISTS idx_token_daily_stats_model ON token_daily_stats(model_family, day_id)"],
  ["idx_token_usage_conv", "CREATE INDEX IF NOT EXISTS idx_token_usage_conv ON token_usage(conversation_id)"],
  ["idx_token_usage_day", "CREATE INDEX IF NOT EXISTS idx_token_usage_day ON token_usage(day_id, agent_id)"],
  ["idx_token_usage_model", "CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model_family, day_id)"],
  ["idx_token_usage_timestamp", "CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp_ms)"],
  ["idx_token_usage_workspace", "CREATE INDEX IF NOT EXISTS idx_token_usage_workspace ON token_usage(workspace_id, day_id)"],
  ["idx_ud_agent", "CREATE INDEX IF NOT EXISTS idx_ud_agent ON usage_daily(agent_slug, day_id)"],
  ["idx_ud_source", "CREATE INDEX IF NOT EXISTS idx_ud_source ON usage_daily(source_id, day_id)"],
  ["idx_ud_workspace", "CREATE INDEX IF NOT EXISTS idx_ud_workspace ON usage_daily(workspace_id, day_id)"],
  ["idx_uh_agent", "CREATE INDEX IF NOT EXISTS idx_uh_agent ON usage_hourly(agent_slug, hour_id)"],
  ["idx_uh_source", "CREATE INDEX IF NOT EXISTS idx_uh_source ON usage_hourly(source_id, hour_id)"],
  ["idx_uh_workspace", "CREATE INDEX IF NOT EXISTS idx_uh_workspace ON usage_hourly(workspace_id, hour_id)"],
  ["idx_umd_agent_day", "CREATE INDEX IF NOT EXISTS idx_umd_agent_day ON usage_models_daily(agent_slug, day_id)"],
  ["idx_umd_model_day", "CREATE INDEX IF NOT EXISTS idx_umd_model_day ON usage_models_daily(model_family, day_id)"],
  ["idx_umd_source_day", "CREATE INDEX IF NOT EXISTS idx_umd_source_day ON usage_models_daily(source_id, day_id)"],
  ["idx_umd_workspace_day", "CREATE INDEX IF NOT EXISTS idx_umd_workspace_day ON usage_models_daily(workspace_id, day_id)"],
]);

// Every schema-v20 table column that can directly name an agent, conversation,
// or message. Comparing the complete cross-schema projection (rather than only
// the tables we delete from) makes an added table with a familiar reference
// column a refusal: direct SQL must not guess whether that new surface carries
// retirement state. The tail and external lookup tables deliberately have no
// foreign keys in Cass, so they are part of the projection and receive an
// explicit referential proof below.
const REFERENCE_COLUMN_SIGNATURE = [
  "conversation_external_lookup:conversation_id",
  "conversation_external_tail_lookup:conversation_id",
  "conversation_tags:conversation_id",
  "conversation_tail_state:conversation_id",
  "conversations:agent_id",
  "daily_stats:agent_slug",
  "message_metrics:message_id",
  "message_metrics:agent_slug",
  "messages:conversation_id",
  "snippets:message_id",
  "token_daily_stats:agent_slug",
  "token_usage:message_id",
  "token_usage:conversation_id",
  "token_usage:agent_id",
  "usage_daily:agent_slug",
  "usage_hourly:agent_slug",
  "usage_models_daily:agent_slug",
].join("|");

const FRESH_MIGRATIONS = "13:full_schema_v13|14:fts_contentless|15:conversation_tail_state_cache|16:drop_redundant_message_conv_idx|17:drop_message_created_idx|18:conversation_tail_state_hot_table|19:conversation_external_lookup|20:conversation_external_tail_lookup";
const LEGACY_MIGRATIONS = "1:core_tables|2:fts_messages|3:fts_messages_rebuild|4:sources|5:provenance_columns|6:source_path_index|7:msgpack_columns|8:daily_stats|9:embedding_jobs|10:token_analytics|11:message_metrics|12:model_dimensions|13:plan_token_rollups|14:fts_contentless|15:conversation_tail_state_cache|16:drop_redundant_message_conv_idx|17:drop_message_created_idx|18:conversation_tail_state_hot_table|19:conversation_external_lookup|20:conversation_external_tail_lookup";

const RETIREMENT_CRITICAL_ENV = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "CASS_DATA_DIR",
  "CASS_DB_PATH",
  "CASS_HOME",
  "CASS_IGNORE_SOURCES_CONFIG",
  "CASS_EXCLUDE_PATH",
  "CASS_EXCLUDE_PATHS",
  "CASS_DAEMON_SOCKET",
  "CASS_AIDER_DATA_ROOT",
  "CASS_ANTIGRAVITY_DATA_ROOT",
  "CASS_CURSOR_PROJECTS_ROOT",
  "CASS_OPENHANDS_DATA_ROOT",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_HOME",
  "CODEX_HOME",
  "GEMINI_HOME",
  "GOOSE_PATH_ROOT",
  "GROK_HOME",
  "HERMES_HOME",
  "KIMI_CODE_HOME",
  "OPENCODE_STORAGE_ROOT",
  "PI_CODING_AGENT_DIR",
  "PI_SESSIONS_DIR",
];

export class CassOrphanDeletionRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "CassOrphanDeletionRefusal";
  }
}

function refuse(message) {
  throw new CassOrphanDeletionRefusal(message);
}

function modeBits(metadata) {
  return Number(metadata.mode & 0o777n);
}

function currentUid() {
  if (typeof process.getuid !== "function") refuse("Cass ownership checks require a Unix uid");
  return BigInt(process.getuid());
}

function requireOwnedDirectory(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    refuse(`Cass path component is not a real directory: ${path}`);
  }
  if (metadata.uid !== currentUid()) refuse(`Cass path component has foreign ownership: ${path}`);
  if ((modeBits(metadata) & 0o022) !== 0) {
    refuse(`Cass path component is group/world writable: ${path}`);
  }
  if (realpathSync(path) !== path) refuse(`Cass path component is non-canonical: ${path}`);
}

function requireCanonicalDatabasePath(home, databasePath) {
  const resolvedHome = resolve(home);
  if (realpathSync(resolvedHome) !== resolvedHome) refuse(`target home is non-canonical: ${home}`);
  requireOwnedDirectory(resolvedHome);
  let current = resolvedHome;
  for (const component of CASS_DATA_COMPONENTS) {
    current = join(current, component);
    requireOwnedDirectory(current);
  }
  const expected = join(current, DATABASE_NAME);
  if (databasePath !== expected) refuse(`refusing unexpected Cass database path: ${databasePath}`);
  return current;
}

function fileIdentity(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    refuse(`Cass database occupant is not a regular file: ${path}`);
  }
  if (metadata.uid !== currentUid()) refuse(`Cass database occupant has foreign ownership: ${path}`);
  if ((modeBits(metadata) & 0o022) !== 0) {
    refuse(`Cass database occupant is group/world writable: ${path}`);
  }
  if (metadata.nlink !== 1n) refuse(`Cass database occupant has hard links: ${path}`);
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    uid: metadata.uid.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
  };
}

function databaseBundleSnapshot(home, databasePath) {
  const dataDirectory = requireCanonicalDatabasePath(home, databasePath);
  const entries = readdirSync(dataDirectory)
    .filter((name) => name === DATABASE_NAME || name.startsWith(DATABASE_NAME))
    .sort();
  if (!entries.includes(DATABASE_NAME)) refuse(`Cass database is missing: ${databasePath}`);
  const snapshot = new Map();
  for (const name of entries) {
    const suffix = name.slice(DATABASE_NAME.length);
    if (suffix !== "" && !ALLOWED_SIDECARS.has(suffix)) {
      refuse(`unknown Cass database sidecar: ${join(dataDirectory, name)}`);
    }
    snapshot.set(name, fileIdentity(join(dataDirectory, name)));
  }
  return snapshot;
}

function requireSameBundle(
  expected,
  home,
  databasePath,
  {
    compareMode = true,
    allowNewSidecars = new Set(),
    allowMissingSidecars = new Set(),
  } = {},
) {
  const actual = databaseBundleSnapshot(home, databasePath);
  for (const name of actual.keys()) {
    if (!expected.has(name) && !allowNewSidecars.has(name)) {
      refuse(`Cass database bundle gained an unexpected sidecar: ${name}`);
    }
  }
  for (const name of expected.keys()) {
    if (!actual.has(name) && !allowMissingSidecars.has(name)) {
      refuse("Cass database bundle changed while open");
    }
  }
  for (const [name, identity] of expected) {
    const observed = actual.get(name);
    if (!observed && allowMissingSidecars.has(name)) continue;
    if (
      !observed ||
      observed.dev !== identity.dev ||
      observed.ino !== identity.ino ||
      observed.uid !== identity.uid ||
      (compareMode && observed.mode !== identity.mode) ||
      observed.nlink !== identity.nlink
    ) {
      refuse(
        `Cass database occupant changed while open: ${name} (${JSON.stringify(identity)} -> ${JSON.stringify(observed)})`,
      );
    }
  }
  return actual;
}

function sanitizedChildEnvironment(home) {
  const environment = { ...process.env, HOME: home };
  for (const variable of RETIREMENT_CRITICAL_ENV) delete environment[variable];
  return environment;
}

function requireNoRootDotenv() {
  try {
    lstatSync("/.env");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    refuse(`could not prove the sanitized dotenv boundary: ${error.message}`);
  }
  refuse("refusing Cass execution while the sanitized working directory has /.env");
}

function requireCass0625(cassBin, home) {
  if (typeof cassBin !== "string" || !cassBin.startsWith("/")) {
    refuse("orphan cleanup requires the absolute Cass binary path");
  }
  requireNoRootDotenv();
  const result = spawnSync(cassBin, ["--version"], {
    cwd: "/",
    encoding: "utf8",
    env: sanitizedChildEnvironment(home),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.error) refuse(`could not prove the Cass version: ${result.error.message}`);
  if (result.status !== 0) {
    refuse(`could not prove the Cass version: ${(result.stderr || result.stdout).trim()}`);
  }
  const version = result.stdout.trim();
  if (version !== "cass 0.6.25") {
    refuse(`direct orphan cleanup is pinned to cass 0.6.25, found ${version || "no version"}`);
  }
}

function requireRetirementAuthority({ home, cassBin, flockBin }) {
  try {
    assertCassWriterLock({ root: expectedRawMirrorRoot(home), flockBin });
  } catch (error) {
    refuse(error.message);
  }
  requireCass0625(cassBin, home);
}

function exactCount(value, description) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) refuse(`${description} returned an invalid count`);
  return Number(value);
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function xinfoSql(table) {
  return `SELECT coalesce(group_concat(cid||':'||name||':'||type||':'||"notnull"||':'||coalesce(dflt_value,'∅')||':'||pk||':'||hidden,';'),'') FROM (SELECT * FROM pragma_table_xinfo(${sqlString(table)}) ORDER BY cid);`;
}

function foreignKeySql(table) {
  return `SELECT coalesce(group_concat(id||':'||seq||':'||"table"||':'||"from"||':'||"to"||':'||on_update||':'||on_delete||':'||match,';'),'') FROM (SELECT * FROM pragma_foreign_key_list(${sqlString(table)}) ORDER BY id,seq);`;
}

function indexSql(table) {
  return `SELECT coalesce(group_concat(name||':'||"unique"||':'||origin||':'||partial||':'||(SELECT group_concat(seqno||'/'||cid||'/'||coalesce(name,'∅')||'/'||desc||'/'||coll||'/'||key,';') FROM (SELECT * FROM pragma_index_xinfo(il.name) ORDER BY seqno)),'|'),'') FROM (SELECT * FROM pragma_index_list(${sqlString(table)}) ORDER BY name) il;`;
}

async function proveSchema(child, iterator, stderr, timeoutMs) {
  const preflight = await runStage(
    child,
    iterator,
    stderr,
    [
      ".bail on",
      ".mode list",
      "PRAGMA trusted_schema = OFF;",
      "PRAGMA foreign_keys = ON;",
      "BEGIN IMMEDIATE;",
      "PRAGMA trusted_schema;",
      "PRAGMA foreign_keys;",
      "PRAGMA user_version;",
      "PRAGMA quick_check;",
      "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger';",
      "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'view';",
      "SELECT COUNT(*) FROM meta WHERE key = 'schema_version' AND value = '20';",
      "SELECT coalesce(group_concat(version||':'||name,'|'),'') FROM (SELECT version,name FROM _schema_migrations ORDER BY version);",
      `SELECT coalesce(group_concat(table_name||':'||column_name,'|'),'') FROM (
         SELECT s.name AS table_name, p.name AS column_name, p.cid AS cid
           FROM sqlite_schema s
           JOIN pragma_table_xinfo(s.name) p
          WHERE s.type = 'table'
            AND p.name IN ('agent_id','agent_slug','conversation_id','message_id')
          ORDER BY s.name, p.cid
       );`,
      ".filectrl has_moved",
    ].join("\n"),
    timeoutMs,
  );
  if (preflight.length !== 10) refuse("sqlite returned an unexpected schema-preflight shape");
  if (preflight[0] !== "0") refuse("sqlite trusted_schema could not be disabled");
  if (preflight[1] !== "1") refuse("sqlite foreign_keys could not be enabled");
  if (preflight[2] !== "0") refuse("Cass 0.6.25 archive has an unexpected PRAGMA user_version");
  if (preflight[3] !== "ok") refuse("Cass archive failed PRAGMA quick_check");
  if (preflight[4] !== "0") refuse("Cass archive contains a trigger");
  if (preflight[5] !== "0") refuse("Cass archive contains a view");
  if (preflight[6] !== "1") refuse("Cass meta schema_version is not exactly 20");
  if (![FRESH_MIGRATIONS, LEGACY_MIGRATIONS].includes(preflight[7])) {
    refuse("Cass _schema_migrations is inconsistent with schema v20");
  }
  if (preflight[8] !== REFERENCE_COLUMN_SIGNATURE) {
    refuse("Cass schema has an unexpected retirement-reference surface");
  }
  if (preflight[9] !== "0") refuse("sqlite reports that its open Cass database has moved");

  for (const [table, expected] of TABLE_XINFO) {
    const result = await runStage(child, iterator, stderr, xinfoSql(table), timeoutMs);
    if (result.length !== 1 || result[0] !== expected) {
      refuse(`Cass 0.6.25 table_xinfo mismatch: ${table}`);
    }
  }
  for (const [table, expected] of FOREIGN_KEYS) {
    const result = await runStage(child, iterator, stderr, foreignKeySql(table), timeoutMs);
    if (result.length !== 1 || result[0] !== expected) {
      refuse(`Cass 0.6.25 foreign-key schema mismatch: ${table}`);
    }
  }
  for (const [table, expected] of INDEX_SIGNATURES) {
    const result = await runStage(child, iterator, stderr, indexSql(table), timeoutMs);
    if (result.length !== 1 || result[0] !== expected) {
      refuse(`Cass 0.6.25 index schema mismatch: ${table}`);
    }
  }
  for (const [index, expected] of NAMED_INDEX_SQL) {
    const result = await runStage(
      child,
      iterator,
      stderr,
      `SELECT coalesce(sql, '') FROM sqlite_schema WHERE type = 'index' AND name = ${sqlString(index)};`,
      timeoutMs,
    );
    if (
      result.length !== 1 ||
      ![expected, expected.replace(" IF NOT EXISTS", "")].includes(result[0])
    ) {
      refuse(`Cass 0.6.25 index definition mismatch: ${index}`);
    }
  }
}

async function nextLine(iterator, child, stderr, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for staged sqlite proof")), timeoutMs);
      }),
    ]);
    if (result.done) {
      refuse(`sqlite exited before its proof marker: ${stderr.value.trim() || child.exitCode}`);
    }
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

async function runStage(child, iterator, stderr, sql, timeoutMs) {
  const marker = `__agentchats_${randomBytes(16).toString("hex")}__`;
  child.stdin.write(`${sql}\n.print ${marker}\n`);
  const lines = [];
  for (;;) {
    const line = await nextLine(iterator, child, stderr, timeoutMs);
    if (line === marker) return lines;
    lines.push(line);
  }
}

async function stopSqlite(child, exitPromise, { rollback = false } = {}) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.stdin.end(`${rollback ? "ROLLBACK;\n" : ""}.quit\n`);
    } catch {
      child.kill("SIGTERM");
    }
  }
  let timer;
  try {
    await Promise.race([
      exitPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

const RETIREMENT_COUNT_FIELDS = [
  "agents",
  "conversations",
  "snippets",
  "conversation_tags",
  "conversation_tail_state",
  "conversation_external_lookup",
  "conversation_external_tail_lookup",
  "daily_stats",
  "token_daily_stats",
  "message_metrics",
  "usage_hourly",
  "usage_daily",
  "usage_models_daily",
  "token_usage",
  "active_embedding_jobs",
  "token_usage_inconsistencies",
  "message_metrics_inconsistencies",
  "snippets_inconsistencies",
  "conversation_tags_inconsistencies",
  "conversation_tail_state_inconsistencies",
  "conversation_external_lookup_inconsistencies",
  "conversation_external_tail_lookup_inconsistencies",
  "foreign_key_violations",
];

const IMPLICIT_CONSISTENCY_FIELDS = [
  "token_usage_inconsistencies",
  "message_metrics_inconsistencies",
  "snippets_inconsistencies",
  "conversation_tags_inconsistencies",
  "conversation_tail_state_inconsistencies",
  "conversation_external_lookup_inconsistencies",
  "conversation_external_tail_lookup_inconsistencies",
];

function normalizedRetiredConversationIds(ids) {
  if (ids === undefined || ids === null) return null;
  if (!Array.isArray(ids)) refuse("retired conversation ids must be an array");
  const normalized = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0) {
      refuse("retired conversation ids must be nonnegative safe integers");
    }
    normalized.push(id);
  }
  return [...new Set(normalized)].sort((left, right) => left - right);
}

function retiredTailCleanupSql(ids) {
  if (ids.length === 0) return null;
  return [
    "DELETE FROM conversation_tail_state",
    ` WHERE conversation_id IN (${ids.join(",")})`,
    "   AND NOT EXISTS (SELECT 1 FROM conversations WHERE conversations.id = conversation_tail_state.conversation_id);",
    "SELECT changes();",
  ].join("\n");
}

function retiredDailyStatsCleanupSql() {
  return [
    "DELETE FROM daily_stats WHERE agent_slug = 'pi_agent';",
    "SELECT changes();",
  ].join("\n");
}

function retirementCountSql() {
  return [
    "SELECT COUNT(*) FROM agents WHERE slug = 'pi_agent';",
    "SELECT COUNT(*) FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM snippets s JOIN messages m ON m.id = s.message_id JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM conversation_tags ct JOIN conversations c ON c.id = ct.conversation_id JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM conversation_tail_state ts JOIN conversations c ON c.id = ts.conversation_id JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM conversation_external_lookup el JOIN conversations c ON c.id = el.conversation_id JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM conversation_external_tail_lookup etl JOIN conversations c ON c.id = etl.conversation_id JOIN agents a ON a.id = c.agent_id WHERE a.slug = 'pi_agent';",
    "SELECT COUNT(*) FROM daily_stats WHERE agent_slug = 'pi_agent';",
    "SELECT COUNT(*) FROM token_daily_stats WHERE agent_slug = 'pi_agent';",
    "SELECT COUNT(*) FROM message_metrics mm WHERE mm.agent_slug = 'pi_agent' OR EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id WHERE m.id = mm.message_id AND a.slug = 'pi_agent');",
    "SELECT COUNT(*) FROM usage_hourly WHERE agent_slug = 'pi_agent';",
    "SELECT COUNT(*) FROM usage_daily WHERE agent_slug = 'pi_agent';",
    "SELECT COUNT(*) FROM usage_models_daily WHERE agent_slug = 'pi_agent';",
    "SELECT COUNT(*) FROM token_usage tu WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = tu.agent_id AND a.slug = 'pi_agent') OR EXISTS (SELECT 1 FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = tu.conversation_id AND a.slug = 'pi_agent') OR EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id WHERE m.id = tu.message_id AND a.slug = 'pi_agent');",
    "SELECT COUNT(*) FROM embedding_jobs WHERE status IN ('pending','running');",
    "SELECT COUNT(*) FROM token_usage tu LEFT JOIN agents a ON a.id = tu.agent_id LEFT JOIN conversations c ON c.id = tu.conversation_id LEFT JOIN messages m ON m.id = tu.message_id WHERE a.id IS NULL OR c.id IS NULL OR m.id IS NULL OR m.conversation_id <> tu.conversation_id OR c.agent_id <> tu.agent_id;",
    "SELECT COUNT(*) FROM message_metrics mm LEFT JOIN messages m ON m.id = mm.message_id LEFT JOIN conversations c ON c.id = m.conversation_id LEFT JOIN agents a ON a.id = c.agent_id WHERE m.id IS NULL OR c.id IS NULL OR a.id IS NULL OR mm.agent_slug <> a.slug;",
    "SELECT COUNT(*) FROM snippets s LEFT JOIN messages m ON m.id = s.message_id WHERE m.id IS NULL;",
    "SELECT COUNT(*) FROM conversation_tags ct LEFT JOIN conversations c ON c.id = ct.conversation_id WHERE c.id IS NULL;",
    "SELECT COUNT(*) FROM conversation_tail_state ts LEFT JOIN conversations c ON c.id = ts.conversation_id WHERE c.id IS NULL;",
    "SELECT COUNT(*) FROM conversation_external_lookup el LEFT JOIN conversations c ON c.id = el.conversation_id WHERE c.id IS NULL OR c.external_id IS NULL OR el.lookup_key <> CAST(length(c.source_id) AS TEXT) || ':' || c.source_id || ':' || CAST(c.agent_id AS TEXT) || ':' || CAST(length(c.external_id) AS TEXT) || ':' || c.external_id;",
    "SELECT COUNT(*) FROM conversation_external_tail_lookup etl LEFT JOIN conversations c ON c.id = etl.conversation_id WHERE c.id IS NULL OR c.external_id IS NULL OR etl.lookup_key <> CAST(length(c.source_id) AS TEXT) || ':' || c.source_id || ':' || CAST(c.agent_id AS TEXT) || ':' || CAST(length(c.external_id) AS TEXT) || ':' || c.external_id;",
    "SELECT COUNT(*) FROM pragma_foreign_key_check;",
  ].join("\n");
}

function parseRetirementCounts(lines, description) {
  if (lines.length !== RETIREMENT_COUNT_FIELDS.length) {
    refuse(`sqlite returned an unexpected ${description} shape`);
  }
  const counts = Object.fromEntries(
    RETIREMENT_COUNT_FIELDS.map((field, index) => [
      field,
      exactCount(lines[index], `${description} ${field}`),
    ]),
  );
  counts.referential_inconsistencies = IMPLICIT_CONSISTENCY_FIELDS.reduce(
    (total, field) => total + counts[field],
    0,
  );
  return counts;
}

function requireRetirementReferencesEmpty(
  counts,
  { allowAgent = false, allowRetiredTail = false, allowRetiredDailyStats = false } = {},
) {
  if ((!allowAgent && counts.agents !== 0) || (allowAgent && counts.agents > 1)) {
    refuse(`unexpected retired agent-row count: ${counts.agents}`);
  }
  for (const field of [
    "conversations",
    "snippets",
    "conversation_tags",
    "conversation_tail_state",
    "conversation_external_lookup",
    "conversation_external_tail_lookup",
    ...(allowRetiredDailyStats ? [] : ["daily_stats"]),
    "token_daily_stats",
    "message_metrics",
    "usage_hourly",
    "usage_daily",
    "usage_models_daily",
    "token_usage",
  ]) {
    if (counts[field] !== 0) refuse(`retired connector still has ${field} rows: ${counts[field]}`);
  }
  requireArchiveConsistency(counts, { allowRetiredTail });
}

function requireArchiveConsistency(counts, { allowRetiredTail = false } = {}) {
  if (counts.active_embedding_jobs !== 0) {
    refuse(`Cass still has active embedding jobs: ${counts.active_embedding_jobs}`);
  }
  if (counts.referential_inconsistencies !== 0) {
    const detail = IMPLICIT_CONSISTENCY_FIELDS
      .filter((field) => !allowRetiredTail || field !== "conversation_tail_state_inconsistencies")
      .filter((field) => counts[field] !== 0)
      .map((field) => `${field}=${counts[field]}`)
      .join(", ");
    if (detail) refuse(`Cass has implicit referential inconsistencies: ${detail}`);
  }
  if (counts.foreign_key_violations !== 0) {
    refuse(`Cass has foreign-key violations: ${counts.foreign_key_violations}`);
  }
}

async function readRetirementCounts(child, iterator, stderr, timeoutMs, description) {
  return parseRetirementCounts(
    await runStage(child, iterator, stderr, retirementCountSql(), timeoutMs),
    description,
  );
}

async function provePostDeleteIntegrity(child, iterator, stderr, timeoutMs, description) {
  const integrity = await runStage(
    child,
    iterator,
    stderr,
    `PRAGMA quick_check;\n${retirementCountSql()}\n.filectrl has_moved`,
    timeoutMs,
  );
  if (integrity.length !== RETIREMENT_COUNT_FIELDS.length + 2) {
    refuse(`sqlite returned an unexpected ${description} integrity shape`);
  }
  if (integrity[0] !== "ok") refuse(`Cass archive failed ${description} PRAGMA quick_check`);
  const counts = parseRetirementCounts(integrity.slice(1, -1), description);
  requireRetirementReferencesEmpty(counts);
  if (integrity.at(-1) !== "0") refuse(`sqlite reports a Cass database move ${description}`);
  return counts;
}

export async function deleteCass0625OrphanAgent({
  home = homedir(),
  databasePath = join(resolve(home), ...CASS_DATA_COMPONENTS, DATABASE_NAME),
  cassBin,
  flockBin = process.env.FLOCK_BIN || "/opt/homebrew/bin/flock",
  sqliteBin = "/usr/bin/sqlite3",
  stageTimeoutMs = 30000,
  mode = "delete",
  retiredConversationIds,
  hooks = {},
} = {}) {
  if (!["delete", "cleanup", "proof", "inspect"].includes(mode)) {
    refuse(`invalid orphan-cleanup mode: ${mode}`);
  }
  const resolvedHome = resolve(home);
  requireRetirementAuthority({ home: resolvedHome, cassBin, flockBin });
  let expected = databaseBundleSnapshot(resolvedHome, databasePath);
  hooks.afterPreflight?.({ databasePath });

  requireNoRootDotenv();
  const child = spawn(sqliteBin, ["-batch", "-nofollow", "-init", "/dev/null", databasePath], {
    cwd: "/",
    env: sanitizedChildEnvironment(resolvedHome),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitPromise = once(child, "exit");
  const stderr = { value: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value += chunk;
  });
  child.stdout.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let transactionOpen = false;
  let normalizedRetiredIds = normalizedRetiredConversationIds(retiredConversationIds);

  try {
    await proveSchema(child, iterator, stderr, stageTimeoutMs);
    transactionOpen = true;

    // SQLite can harden an existing WAL/SHM mode as it opens the bundle. Take
    // that one self-owned transition before any test hook or destructive SQL,
    // while still requiring every occupant identity to be unchanged. From
    // this post-open baseline onward, mode is part of the exact identity.
    expected = requireSameBundle(expected, resolvedHome, databasePath, { compareMode: false });
    hooks.afterConnectionOpen?.({ databasePath, child });
    requireSameBundle(expected, resolvedHome, databasePath);
    const openedRecheck = await runStage(
      child,
      iterator,
      stderr,
      ".filectrl has_moved",
      stageTimeoutMs,
    );
    if (openedRecheck.length !== 1 || openedRecheck[0] !== "0") {
      refuse("sqlite reports a Cass database move after connection-open proof");
    }

    let before = await readRetirementCounts(
      child,
      iterator,
      stderr,
      stageTimeoutMs,
      "pre-delete retirement proof",
    );
    if (mode === "delete" && before.agents !== 1) {
      refuse(`expected one orphaned retired agent, found ${before.agents}`);
    }
    const tailInconsistencyPresent = before.conversation_tail_state_inconsistencies > 0;
    if (mode === "cleanup" && tailInconsistencyPresent && normalizedRetiredIds === null) {
      normalizedRetiredIds = normalizedRetiredConversationIds(
        rawRetiredConversationIds({ home: resolvedHome }),
      );
    }
    const allowRetiredTail = mode === "cleanup" && tailInconsistencyPresent;
    // Cass 0.6.25 can leave denormalized daily rollups for an excluded
    // connector even after its canonical agent and conversations are gone.
    // They are safe to remove only in the provenance-gated cleanup mode and
    // only when no retired conversation remains. Other derived surfaces still
    // fail closed below.
    const allowRetiredDailyStats =
      mode === "cleanup" && before.agents <= 1 && before.conversations === 0 && before.daily_stats > 0;
    if (mode === "inspect") {
      if (before.agents > 1) refuse(`unexpected retired agent-row count: ${before.agents}`);
      requireArchiveConsistency(before);
    } else {
      requireRetirementReferencesEmpty(before, {
        allowAgent: mode !== "proof",
        allowRetiredTail,
        allowRetiredDailyStats,
      });
    }

    hooks.beforeDelete?.({ databasePath, child });
    requireRetirementAuthority({ home: resolvedHome, cassBin, flockBin });
    requireSameBundle(expected, resolvedHome, databasePath);
    const moveCheck = await runStage(
      child,
      iterator,
      stderr,
      ".filectrl has_moved",
      stageTimeoutMs,
    );
    if (moveCheck.length !== 1 || moveCheck[0] !== "0") {
      refuse("sqlite reports a Cass database move before deletion");
    }

    if (allowRetiredTail && normalizedRetiredIds.length > 0) {
      const repaired = await runStage(
        child,
        iterator,
        stderr,
        retiredTailCleanupSql(normalizedRetiredIds),
        stageTimeoutMs,
      );
      if (repaired.length !== 1) refuse("sqlite returned an unexpected retired tail cleanup shape");
      exactCount(repaired[0], "retired tail cleanup");
      before = await readRetirementCounts(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "post-tail-cleanup retirement proof",
      );
      requireRetirementReferencesEmpty(before, {
        allowAgent: mode !== "proof",
        allowRetiredDailyStats,
      });
      expected = requireSameBundle(expected, resolvedHome, databasePath, {
        allowNewSidecars: new Set([`${DATABASE_NAME}-journal`]),
      });
    }

    if (allowRetiredDailyStats) {
      const repaired = await runStage(
        child,
        iterator,
        stderr,
        retiredDailyStatsCleanupSql(),
        stageTimeoutMs,
      );
      if (repaired.length !== 1) refuse("sqlite returned an unexpected retired daily-stats cleanup shape");
      exactCount(repaired[0], "retired daily-stats cleanup");
      before = await readRetirementCounts(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "post-daily-stats-cleanup retirement proof",
      );
      requireRetirementReferencesEmpty(before, { allowAgent: mode !== "proof" });
      expected = requireSameBundle(expected, resolvedHome, databasePath, {
        allowNewSidecars: new Set([`${DATABASE_NAME}-journal`]),
      });
    }

    let deletedCount = 0;
    if (!["proof", "inspect"].includes(mode) && before.agents === 1) {
      const deleted = await runStage(
        child,
        iterator,
        stderr,
        [
          "DELETE FROM agents WHERE slug = 'pi_agent'",
          "  AND NOT EXISTS (SELECT 1 FROM conversations WHERE conversations.agent_id = agents.id)",
          "  AND NOT EXISTS (SELECT 1 FROM daily_stats WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM token_daily_stats WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM message_metrics WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM usage_hourly WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM usage_daily WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM usage_models_daily WHERE agent_slug = agents.slug)",
          "  AND NOT EXISTS (SELECT 1 FROM token_usage WHERE token_usage.agent_id = agents.id);",
          "SELECT changes();",
        ].join("\n"),
        stageTimeoutMs,
      );
      if (deleted.length !== 1 || exactCount(deleted[0], "orphan deletion") !== 1) {
        refuse("sqlite deleted an unexpected retired agent-row count");
      }
      deletedCount = 1;
    }

    hooks.afterDeleteBeforeCommit?.({ databasePath, child });
    requireRetirementAuthority({ home: resolvedHome, cassBin, flockBin });
    requireSameBundle(expected, resolvedHome, databasePath);
    let finalCounts;
    if (mode === "inspect") {
      finalCounts = await readRetirementCounts(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "inspection reproof",
      );
      requireArchiveConsistency(finalCounts);
    } else {
      finalCounts = await provePostDeleteIntegrity(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "before commit",
      );
    }

    const committed = await runStage(
      child,
      iterator,
      stderr,
      "COMMIT;\n.filectrl has_moved",
      stageTimeoutMs,
    );
    transactionOpen = false;
    if (committed.length !== 1 || committed[0] !== "0") {
      refuse("sqlite reports a Cass database move at commit");
    }
    requireSameBundle(expected, resolvedHome, databasePath, {
      allowMissingSidecars: new Set([`${DATABASE_NAME}-journal`]),
    });
    if (mode === "inspect") {
      finalCounts = await readRetirementCounts(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "post-commit inspection",
      );
      requireArchiveConsistency(finalCounts);
    } else {
      finalCounts = await provePostDeleteIntegrity(
        child,
        iterator,
        stderr,
        stageTimeoutMs,
        "after commit",
      );
    }
    await stopSqlite(child, exitPromise);
    if (child.exitCode !== 0) refuse(`sqlite failed after commit: ${stderr.value.trim()}`);
    return {
      schema_version: 20,
      deleted: deletedCount,
      ...Object.fromEntries(
        [
          "agents",
          "conversations",
          "snippets",
          "conversation_tags",
          "conversation_tail_state",
          "conversation_external_lookup",
          "conversation_external_tail_lookup",
          "daily_stats",
          "token_daily_stats",
          "message_metrics",
          "usage_hourly",
          "usage_daily",
          "usage_models_daily",
          "token_usage",
          "active_embedding_jobs",
          "foreign_key_violations",
          "referential_inconsistencies",
        ].map((field) => [field, finalCounts[field]]),
      ),
      quick_check: "ok",
    };
  } catch (error) {
    await stopSqlite(child, exitPromise, { rollback: transactionOpen });
    if (error instanceof CassOrphanDeletionRefusal) throw error;
    refuse(error.message);
  } finally {
    lines.close();
  }
}

function usage() {
  process.stdout.write(
    "Usage: scripts/delete-retired-pi-cass-orphan.mjs --database <absolute-path> --cass-bin <absolute-path> [--mode delete|cleanup|proof|inspect]\n",
  );
}

function parseArguments(argv) {
  if (![4, 6].includes(argv.length)) return undefined;
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--database", "--cass-bin", "--mode"].includes(flag) || parsed[flag]) {
      return undefined;
    }
    if (flag === "--mode") {
      if (!["delete", "cleanup", "proof", "inspect"].includes(value)) return undefined;
    } else if (!value?.startsWith("/")) {
      return undefined;
    }
    parsed[flag] = value;
  }
  if (!parsed["--database"] || !parsed["--cass-bin"]) return undefined;
  return {
    databasePath: parsed["--database"],
    cassBin: parsed["--cass-bin"],
    mode: parsed["--mode"] || "delete",
  };
}

async function main(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    usage();
    return;
  }
  const options = parseArguments(argv);
  if (!options) {
    usage();
    process.exitCode = 64;
    return;
  }
  const result = await deleteCass0625OrphanAgent(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Cass orphan retirement: ${error.message}\n`);
    process.exitCode = 1;
  });
}
