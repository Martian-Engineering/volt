import postgres from "postgres"
import { Log } from "@/util/log"
import { LCM_DATABASE_URL, LCM_EXTERNAL_DATABASE } from "./config"

/**
 * User context for multi-tenant LCM database isolation.
 *
 * When running in cloud mode (LCM_EXTERNAL_DATABASE=true), each user gets their
 * own PostgreSQL schema containing all LCM tables. This provides complete data
 * isolation without modifying existing queries.
 *
 * Schema naming: user_{sanitized_user_id}
 *
 * For local development (embedded postgres), no user isolation is applied.
 */

const log = Log.create({ service: "lcm.user-context" })

// Cache of initialized user schemas
const initializedSchemas = new Set<string>()

// Current user context (thread-local style, set per request)
let currentUserId: string | null = null

/**
 * Sanitize user ID for use as PostgreSQL schema name.
 * Only allows alphanumeric and underscores, max 63 chars.
 */
function sanitizeSchemaName(userId: string): string {
  // Hash long user IDs or those with special characters
  const sanitized = userId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 50)
  return `user_${sanitized}`
}

/**
 * Get the schema name for a user ID.
 */
export function getUserSchema(userId: string): string {
  return sanitizeSchemaName(userId)
}

/**
 * Set the current user context for database operations.
 * Call this at the start of each request before any LCM operations.
 */
export function setCurrentUser(userId: string | null): void {
  currentUserId = userId
  if (userId) {
    log.debug("set user context", { userId, schema: getUserSchema(userId) })
  }
}

/**
 * Get the current user ID, or null if not in multi-tenant mode.
 */
export function getCurrentUser(): string | null {
  // Only return user ID in external database mode
  if (!LCM_EXTERNAL_DATABASE) return null
  return currentUserId
}

/**
 * Get the schema name for the current user, or "public" if not in multi-tenant mode.
 */
export function getCurrentSchema(): string {
  const userId = getCurrentUser()
  if (!userId) return "public"
  return getUserSchema(userId)
}

/**
 * SQL to set the search_path to the user's schema for a connection.
 */
export function getSearchPathSql(): string {
  const schema = getCurrentSchema()
  return `SET search_path TO ${schema}, public`
}

/**
 * Check if a user's schema has been initialized.
 */
export function isSchemaInitialized(userId: string): boolean {
  return initializedSchemas.has(getUserSchema(userId))
}

/**
 * Mark a user's schema as initialized.
 */
export function markSchemaInitialized(userId: string): void {
  initializedSchemas.add(getUserSchema(userId))
}

/**
 * Create a user's schema if it doesn't exist.
 * Also creates all required LCM tables within the schema.
 */
export async function ensureUserSchema(conn: postgres.Sql, userId: string): Promise<void> {
  const schema = getUserSchema(userId)

  if (initializedSchemas.has(schema)) {
    return
  }

  log.info("creating user schema", { userId, schema })

  // Create schema if not exists
  await conn.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

  // Set search path to new schema
  await conn.unsafe(`SET search_path TO ${schema}, public`)

  // Create all tables within this schema using the same migrations
  // The types (enums) are in public schema and shared across all users
  await conn.unsafe(`
    -- Ensure enums exist in public schema (shared)
    DO $$ BEGIN
      CREATE TYPE message_role AS ENUM ('system','user','assistant','tool');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE summary_kind AS ENUM ('leaf','condensed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE context_item_type AS ENUM ('message','summary');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- 1) Conversations (store per-session config)
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      title                text,
      model_name           text NOT NULL,
      model_ctx_max_tokens integer NOT NULL,
      ctx_cutoff_threshold numeric(5,4) NOT NULL DEFAULT 0.6000,
      parent_conversation_id bigint REFERENCES conversations(conversation_id) ON DELETE SET NULL,
      created_at           timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS conversations_parent_idx ON conversations(parent_conversation_id);

    -- 2) Full-fidelity messages (never deleted)
    CREATE TABLE IF NOT EXISTS messages (
      message_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      seq             bigint NOT NULL,
      role            public.message_role NOT NULL,
      content         text NOT NULL,
      token_count     integer NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
      UNIQUE (conversation_id, seq)
    );

    CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS messages_tsv_gin_idx ON messages USING GIN (content_tsv);

    -- 3) Summaries (deterministic string IDs)
    CREATE TABLE IF NOT EXISTS summaries (
      summary_id      text PRIMARY KEY,
      conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      kind            public.summary_kind NOT NULL,
      content         text NOT NULL,
      token_count     integer NOT NULL,
      file_ids        jsonb NOT NULL DEFAULT '[]',
      created_at      timestamptz NOT NULL DEFAULT now(),
      content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    );

    CREATE INDEX IF NOT EXISTS summaries_conv_created_idx ON summaries(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS summaries_tsv_gin_idx ON summaries USING GIN (content_tsv);

    -- 4) Leaf summaries -> messages (ordered)
    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id text   NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      message_id bigint NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
      ord        integer NOT NULL,
      PRIMARY KEY (summary_id, ord),
      UNIQUE (summary_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS summary_messages_message_idx ON summary_messages(message_id);

    -- 5) Condensed summaries -> parent summaries (ordered, high fan-out DAG)
    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id        text NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id text NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      ord               integer NOT NULL,
      PRIMARY KEY (summary_id, ord),
      UNIQUE (summary_id, parent_summary_id)
    );

    CREATE INDEX IF NOT EXISTS summary_parents_parent_idx ON summary_parents(parent_summary_id);

    -- 6) Current context (ordered list of message+summary items)
    CREATE TABLE IF NOT EXISTS context_items (
      conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      position        integer NOT NULL,
      item_type       public.context_item_type NOT NULL,
      message_id      bigint,
      summary_id      text,

      PRIMARY KEY (conversation_id, position),

      CONSTRAINT ctx_item_exactly_one_ref CHECK (
        (item_type = 'message'::public.context_item_type AND message_id IS NOT NULL AND summary_id IS NULL) OR
        (item_type = 'summary'::public.context_item_type AND summary_id IS NOT NULL AND message_id IS NULL)
      ),

      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE RESTRICT,
      FOREIGN KEY (summary_id) REFERENCES summaries(summary_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS ctx_items_conv_pos_idx ON context_items(conversation_id, position);
    CREATE INDEX IF NOT EXISTS ctx_items_summary_idx ON context_items(summary_id);
    CREATE INDEX IF NOT EXISTS ctx_items_message_idx ON context_items(message_id);

    -- 7) Large files (for files too big to fit in context)
    CREATE TABLE IF NOT EXISTS large_files (
      file_id         text PRIMARY KEY,
      conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      original_path   text NOT NULL,
      mime_type       text NOT NULL,
      content         text,
      binary_content  bytea,
      token_count     bigint NOT NULL,
      exploration_summary text,
      explorer_used   text,
      created_at      timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS large_files_conv_idx ON large_files(conversation_id);
    CREATE INDEX IF NOT EXISTS large_files_path_idx ON large_files(original_path);

    -- 8) Agentic map runs
    CREATE TABLE IF NOT EXISTS agentic_map_runs (
      map_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_started_at   timestamptz NOT NULL DEFAULT now(),
      status           text NOT NULL DEFAULT 'RUNNING',
      input_path       text NOT NULL,
      input_lcm_id     text NOT NULL,
      output_path      text NOT NULL,
      output_lcm_id    text,
      prompt           text NOT NULL,
      output_schema    jsonb NOT NULL,
      read_only        boolean NOT NULL,
      concurrency      integer NOT NULL,
      timeout_seconds  integer NOT NULL,
      max_attempts     integer NOT NULL
    );

    -- 9) Agentic map items
    CREATE TABLE IF NOT EXISTS agentic_map_items (
      map_id           uuid NOT NULL REFERENCES agentic_map_runs(map_id) ON DELETE CASCADE,
      item_index       integer NOT NULL,
      item             jsonb NOT NULL,
      status           text NOT NULL DEFAULT 'PENDING',
      attempts_used    integer NOT NULL DEFAULT 0,
      started_at       timestamptz,
      finished_at      timestamptz,
      result           jsonb,
      error            text,
      PRIMARY KEY (map_id, item_index)
    );

    CREATE INDEX IF NOT EXISTS agentic_map_items_status_idx
      ON agentic_map_items(map_id, status, item_index);

    -- 10) LLM map runs (non-agentic parallel map)
    CREATE TABLE IF NOT EXISTS llm_map_runs (
      map_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_started_at   timestamptz NOT NULL DEFAULT now(),
      status           text NOT NULL DEFAULT 'RUNNING',
      input_path       text NOT NULL,
      input_lcm_id     text NOT NULL,
      output_path      text NOT NULL,
      output_lcm_id    text,
      prompt           text NOT NULL,
      output_schema    jsonb NOT NULL,
      model            text,
      concurrency      integer NOT NULL,
      timeout_seconds  integer NOT NULL,
      max_attempts     integer NOT NULL,
      resolved_provider text,
      resolved_model   text,
      resolved_request_overrides jsonb
    );

    -- 11) LLM map items (one row per input line)
    CREATE TABLE IF NOT EXISTS llm_map_items (
      map_id           uuid NOT NULL REFERENCES llm_map_runs(map_id) ON DELETE CASCADE,
      item_index       integer NOT NULL,
      item             jsonb NOT NULL,
      status           text NOT NULL DEFAULT 'PENDING',
      attempts_used    integer NOT NULL DEFAULT 0,
      started_at       timestamptz,
      finished_at      timestamptz,
      result           jsonb,
      error            text,
      PRIMARY KEY (map_id, item_index)
    );

    CREATE INDEX IF NOT EXISTS llm_map_items_status_idx
      ON llm_map_items(map_id, status, item_index);
  `)

  initializedSchemas.add(schema)
  log.info("user schema initialized", { userId, schema })
}

/**
 * Wrapper to ensure user schema exists before running a query.
 * For use in multi-tenant mode.
 */
export async function withUserSchema<T>(conn: postgres.Sql, fn: () => Promise<T>): Promise<T> {
  const userId = getCurrentUser()

  // In single-tenant mode, just run the query
  if (!userId) {
    return fn()
  }

  // Ensure schema exists
  await ensureUserSchema(conn, userId)

  // Set search path and run query
  const schema = getUserSchema(userId)
  await conn.unsafe(`SET search_path TO ${schema}, public`)

  return fn()
}
