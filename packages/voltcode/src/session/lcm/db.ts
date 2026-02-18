import { createHash } from "crypto"
import postgres from "postgres"
import z from "zod"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { NamedError } from "@opencode-ai/util/error"
import { LargeFileThreshold } from "./large-file-threshold"
import { LCM_DATABASE_URL, LCM_EXTERNAL_DATABASE } from "./config"
import {
  getCurrentUser,
  getUserSchema,
  ensureUserSchema,
  isSchemaInitialized,
  markSchemaInitialized,
} from "./user-context"

export namespace LcmDb {
  const log = Log.create({ service: "lcm.db" })

  /** Escape null bytes (0x00) which PostgreSQL text columns reject */
  const escNull = (s: string) => s.replaceAll("\0", "\\x00")
  const escNullOpt = (s: string | null | undefined) => (s != null ? escNull(s) : s)

  // Error types
  export const ConnectionError = NamedError.create(
    "LcmDbConnectionError",
    z.object({
      message: z.string(),
    }),
  )

  export const NotFoundError = NamedError.create(
    "LcmDbNotFoundError",
    z.object({
      entity: z.string(),
      id: z.string(),
    }),
  )

  export const QueryError = NamedError.create(
    "LcmDbQueryError",
    z.object({
      message: z.string(),
      query: z.string().optional(),
    }),
  )

  export const InvariantError = NamedError.create(
    "LcmDbInvariantError",
    z.object({
      message: z.string(),
      summaryIds: z.array(z.string()).optional(),
    }),
  )

  // Enums matching the PostgreSQL types
  export const MessageRole = z.enum(["system", "user", "assistant", "tool"])
  export type MessageRole = z.infer<typeof MessageRole>

  export const SummaryKind = z.enum(["leaf", "condensed"])
  export type SummaryKind = z.infer<typeof SummaryKind>

  /**
   * Dolt summary lane. L1 = leaf summaries (turn compaction), L2 = bindles.
   * Legacy rows map via `kind`: leaf -> leaf, condensed -> bindle.
   */
  export const SummaryLevel = z.enum(["leaf", "bindle"])
  export type SummaryLevel = z.infer<typeof SummaryLevel>

  /**
   * Dolt summary node type.
   * - leaf: L1 summary over turns/messages
   * - bindle: L2 summary over leaves
   * - archive_stub: short off-context pointer node for evicted bindles
   */
  export const SummaryType = z.enum(["leaf", "bindle", "archive_stub"])
  export type SummaryType = z.infer<typeof SummaryType>

  /**
   * Archive and lineage pointer kinds for traversal.
   */
  export const SummaryLineagePointerKind = z.enum(["archive_stub", "archive_full", "lineage_parent"])
  export type SummaryLineagePointerKind = z.infer<typeof SummaryLineagePointerKind>

  export const ContextItemType = z.enum(["message", "summary"])
  export type ContextItemType = z.infer<typeof ContextItemType>

  export const MessagePartType = z.enum([
    "text",
    "reasoning",
    "tool",
    "patch",
    "file",
    "subtask",
    "compaction",
    "step_start",
    "step_finish",
    "snapshot",
    "agent",
    "retry",
  ])
  export type MessagePartType = z.infer<typeof MessagePartType>

  // Schema types

  export const MessagePart = z.object({
    part_id: z.string(),
    message_id: z.number(),
    session_id: z.string(),
    part_type: MessagePartType,
    ordinal: z.number(),
    text_content: z.string().nullable(),
    is_ignored: z.boolean().nullable(),
    is_synthetic: z.boolean().nullable(),
    tool_call_id: z.string().nullable(),
    tool_name: z.string().nullable(),
    tool_status: z.string().nullable(),
    tool_input: z.unknown().nullable(),
    tool_output: z.string().nullable(),
    tool_error: z.string().nullable(),
    tool_title: z.string().nullable(),
    patch_hash: z.string().nullable(),
    patch_files: z.string().array().nullable(),
    file_mime: z.string().nullable(),
    file_name: z.string().nullable(),
    file_url: z.string().nullable(),
    subtask_prompt: z.string().nullable(),
    subtask_desc: z.string().nullable(),
    subtask_agent: z.string().nullable(),
    step_reason: z.string().nullable(),
    step_cost: z.number().nullable(),
    step_tokens_in: z.number().nullable(),
    step_tokens_out: z.number().nullable(),
    snapshot_hash: z.string().nullable(),
    compaction_auto: z.boolean().nullable(),
    metadata: z.unknown().nullable(),
  })
  export type MessagePart = z.infer<typeof MessagePart>
  export const LargeFile = z.object({
    file_id: z.string(),
    conversation_id: z.number(),
    storage_kind: z.enum(["path", "inline_text", "inline_binary"]),
    original_path: z.string().nullable(),
    mime_type: z.string(),
    content: z.string().nullable(),
    binary_content: z.instanceof(Uint8Array).nullable(),
    token_count: z.coerce.bigint(), // BIGINT to support files with billions of tokens
    created_at: z.date(),
    exploration_summary: z.string().nullable(),
    explorer_used: z.string().nullable(),
  })
  export type LargeFile = z.infer<typeof LargeFile>

  export const Conversation = z.object({
    conversation_id: z.number(),
    title: z.string().nullable(),
    model_name: z.string(),
    model_ctx_max_tokens: z.number(),
    ctx_cutoff_threshold: z.string(), // numeric comes as string
    created_at: z.date(),
  })
  export type Conversation = z.infer<typeof Conversation>

  export const Message = z.object({
    message_id: z.number(),
    conversation_id: z.number(),
    seq: z.number(),
    role: MessageRole,
    content: z.string(),
    token_count: z.number(),
    created_at: z.date(),
  })
  export type Message = z.infer<typeof Message>

  export const Summary = z.object({
    summary_id: z.string(),
    conversation_id: z.number(),
    kind: SummaryKind,
    summary_level: SummaryLevel,
    summary_type: SummaryType,
    content: z.string(),
    token_count: z.number(),
    file_ids: z.array(z.string()).default([]),
    qmd_doc_id: z.string().nullable(),
    qmd_doc_version: z.number().nullable(),
    is_off_context: z.boolean(),
    created_at: z.date(),
  })
  export type Summary = z.infer<typeof Summary>

  export const SummaryLineagePointer = z.object({
    summary_id: z.string(),
    points_to_summary_id: z.string(),
    pointer_kind: SummaryLineagePointerKind,
    ord: z.number(),
    created_at: z.date(),
  })
  export type SummaryLineagePointer = z.infer<typeof SummaryLineagePointer>

  export const ContextItem = z.object({
    conversation_id: z.number(),
    position: z.number(),
    item_type: ContextItemType,
    message_id: z.number().nullable(),
    summary_id: z.string().nullable(),
  })
  export type ContextItem = z.infer<typeof ContextItem>

  // Context view types
  export const ContextEntry = z.object({
    position: z.number(),
    item_type: ContextItemType,
    message_id: z.number().nullable(),
    role: z.string(),
    content: z.string(),
    token_count: z.number(),
  })
  export type ContextEntry = z.infer<typeof ContextEntry>

  export const MessageSearchResult = z.object({
    message_id: z.number(),
    seq: z.number(),
    role: MessageRole,
  })
  export type MessageSearchResult = z.infer<typeof MessageSearchResult>

  export const SummarySearchResult = z.object({
    summary_id: z.string(),
    kind: SummaryKind,
  })
  export type SummarySearchResult = z.infer<typeof SummarySearchResult>

  // Track if database has been initialized
  let dbInitialized = false

  /**
   * Ensure the LCM database exists, creating it if necessary.
   * This connects to the default 'postgres' database to check/create.
   */
  async function ensureDatabase(): Promise<void> {
    if (dbInitialized) return

    const url = LCM_DATABASE_URL
    if (!url) {
      throw new ConnectionError({ message: "LCM database URL is not configured" })
    }

    // Parse the URL to get database name
    const urlObj = new URL(url)
    const dbName = urlObj.pathname.slice(1) // Remove leading /
    if (!dbName) {
      throw new ConnectionError({ message: "LCM database URL must specify a database name" })
    }

    // Connect to default 'postgres' database to check/create
    urlObj.pathname = "/postgres"
    const adminUrl = urlObj.toString()

    log.info("checking if database exists", { database: dbName })
    const adminConn = postgres(adminUrl, {
      max: 1,
      connect_timeout: 10,
      prepare: LCM_EXTERNAL_DATABASE ? false : undefined, // Disable prepared statements for RDS Proxy
      onnotice: () => {}, // Suppress NOTICE messages from appearing in stdout
    })

    try {
      // Check if database exists
      const result = await adminConn<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_database WHERE datname = ${dbName}
        ) AS exists
      `

      if (!result[0]?.exists) {
        log.info("creating database", { database: dbName })
        // CREATE DATABASE can't run in a transaction.
        // Another instance may create it concurrently — handle "already exists" gracefully.
        await adminConn.unsafe(`CREATE DATABASE "${dbName}"`).catch((e: any) => {
          if (e?.message?.includes("already exists")) {
            log.info("database created by another instance", { database: dbName })
            return
          }
          throw e
        })
        log.info("database created", { database: dbName })
      } else {
        log.info("database already exists", { database: dbName })
      }
    } finally {
      await adminConn.end()
    }

    dbInitialized = true
  }

  // Lazy connection pool
  const sql = lazy(() => {
    const url = LCM_DATABASE_URL
    if (!url) {
      throw new ConnectionError({ message: "LCM database URL is not configured" })
    }
    log.info("connecting to database")

    // Set statement_timeout to prevent queries from blocking indefinitely.
    // RDS Proxy doesn't support command-line options, so use connection parameter instead.
    const connectionUrl = LCM_EXTERNAL_DATABASE
      ? url
      : (() => {
          const urlWithTimeout = new URL(url)
          urlWithTimeout.searchParams.set("options", "-c statement_timeout=30000")
          return urlWithTimeout.toString()
        })()

    return postgres(connectionUrl, {
      max: 10,
      idle_timeout: 0, // Disable idle timeout to prevent stale reconnect timing bug in postgres lib
      connect_timeout: 10,
      max_lifetime: 60 * 30, // 30 minutes max connection lifetime
      prepare: LCM_EXTERNAL_DATABASE ? false : undefined, // Disable prepared statements for RDS Proxy compatibility
      // Note: statement_timeout is only set for embedded postgres (via URL options).
      // RDS Proxy doesn't support connection-level options, so we skip it for external DBs.
      transform: {
        undefined: null,
      },
      onnotice: () => {}, // Suppress NOTICE messages from appearing in stdout
    })
  })

  export function getConnection() {
    return sql()
  }

  /**
   * Get a connection with the search_path set for the current user (multi-tenant mode).
   * In single-tenant mode, returns the regular connection.
   *
   * IMPORTANT: For multi-tenant operations, use this instead of getConnection() directly,
   * or use withUserContext() to wrap your queries.
   */
  export async function getConnectionForUser(): Promise<postgres.Sql> {
    const conn = sql()
    const userId = getCurrentUser()

    if (!userId || !LCM_EXTERNAL_DATABASE) {
      return conn
    }

    // Ensure user schema exists
    if (!isSchemaInitialized(userId)) {
      await ensureUserSchema(conn, userId)
    }

    // Set search path for this connection
    const schema = getUserSchema(userId)
    await conn.unsafe(`SET search_path TO ${schema}, public`)

    return conn
  }

  /**
   * Execute a function with the user's schema context.
   * Automatically sets search_path before executing and ensures schema exists.
   */
  export async function withUserContext<T>(fn: (conn: postgres.Sql) => Promise<T>): Promise<T> {
    const conn = await getConnectionForUser()
    return fn(conn)
  }

  export async function close() {
    const conn = sql()
    await conn.end()
    sql.reset()
    dbInitialized = false
    log.info("database connection closed")
  }

  /**
   * Initialize the LCM database - creates database if needed and runs migrations.
   * Safe to call multiple times; will only run once.
   *
   * In multi-tenant mode (external database), this only creates the public schema
   * with shared enum types. User-specific schemas are created on-demand.
   */
  export async function initialize(): Promise<void> {
    await ensureDatabase()
    await migrate()
  }

  // Migration function to create tables if they don't exist
  export async function migrate() {
    const conn = sql()
    log.info("running migrations")

    await conn.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
        created_at           timestamptz NOT NULL DEFAULT now()
      );

      -- Migration: add parent_conversation_id for hierarchical file/summary access
      DO $$ BEGIN
        ALTER TABLE conversations ADD COLUMN parent_conversation_id bigint REFERENCES conversations(conversation_id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      CREATE INDEX IF NOT EXISTS conversations_parent_idx ON conversations(parent_conversation_id);

      -- 2) Full-fidelity messages (never deleted)
      CREATE TABLE IF NOT EXISTS messages (
        message_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq             bigint NOT NULL,
        role            message_role NOT NULL,
        content         text NOT NULL,
        token_count     integer NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (conversation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages(conversation_id, seq);

      -- FTS column for messages
      DO $$ BEGIN
        ALTER TABLE messages
          ADD COLUMN content_tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      CREATE INDEX IF NOT EXISTS messages_tsv_gin_idx ON messages USING GIN (content_tsv);

      -- 3) Summaries (deterministic string IDs)
      CREATE TABLE IF NOT EXISTS summaries (
        summary_id      text PRIMARY KEY,
        conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        kind            summary_kind NOT NULL,
        content         text NOT NULL,
        token_count     integer NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS summaries_conv_created_idx ON summaries(conversation_id, created_at);

      -- FTS on summaries
      DO $$ BEGIN
        ALTER TABLE summaries
          ADD COLUMN content_tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      CREATE INDEX IF NOT EXISTS summaries_tsv_gin_idx ON summaries USING GIN (content_tsv);

      -- Migration: add file_ids column for tracking LCM file references in summaries
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN file_ids jsonb NOT NULL DEFAULT '[]';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      -- Dolt migration: add explicit level/type metadata for leaf vs bindle semantics
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN summary_level text NOT NULL DEFAULT 'leaf';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN summary_type text NOT NULL DEFAULT 'leaf';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries
          ADD CONSTRAINT summaries_summary_level_check
          CHECK (summary_level IN ('leaf', 'bindle'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries
          ADD CONSTRAINT summaries_summary_type_check
          CHECK (summary_type IN ('leaf', 'bindle', 'archive_stub'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- Dolt migration: retrieval metadata for qmd mapping + off-context exclusion
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN qmd_doc_id text;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN qmd_doc_version integer;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries ADD COLUMN is_off_context boolean NOT NULL DEFAULT false;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE summaries
          ADD CONSTRAINT summaries_qmd_doc_version_nonnegative_check
          CHECK (qmd_doc_version IS NULL OR qmd_doc_version >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- Backfill legacy rows so existing leaf/condensed data remains readable.
      UPDATE summaries
      SET summary_level = CASE WHEN kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END,
          summary_type = CASE WHEN kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END
      WHERE summary_level IS NULL
         OR summary_type IS NULL
         OR summary_level NOT IN ('leaf', 'bindle')
         OR summary_type NOT IN ('leaf', 'bindle', 'archive_stub')
         OR (kind = 'condensed'::summary_kind AND (summary_level <> 'bindle' OR summary_type <> 'bindle'))
         OR (kind = 'leaf'::summary_kind AND (summary_level <> 'leaf' OR summary_type <> 'leaf'));

      CREATE INDEX IF NOT EXISTS summaries_off_context_idx
        ON summaries (is_off_context, summary_level, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS summaries_qmd_doc_id_uq
        ON summaries (qmd_doc_id) WHERE qmd_doc_id IS NOT NULL;

      -- Dolt migration: lineage pointers for archive stubs and bindle traversal.
      CREATE TABLE IF NOT EXISTS summary_lineage_pointers (
        summary_id            text NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        points_to_summary_id  text NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        pointer_kind          text NOT NULL,
        ord                   integer NOT NULL DEFAULT 1,
        created_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (summary_id, pointer_kind, points_to_summary_id),
        CONSTRAINT summary_lineage_no_self_pointer CHECK (summary_id <> points_to_summary_id),
        CONSTRAINT summary_lineage_pointer_kind_not_empty CHECK (length(pointer_kind) > 0),
        CONSTRAINT summary_lineage_ord_positive CHECK (ord > 0)
      );
      CREATE INDEX IF NOT EXISTS summary_lineage_points_to_idx
        ON summary_lineage_pointers(points_to_summary_id);
      CREATE INDEX IF NOT EXISTS summary_lineage_summary_ord_idx
        ON summary_lineage_pointers(summary_id, ord);

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
        item_type       context_item_type NOT NULL,
        message_id      bigint,
        summary_id      text,

        PRIMARY KEY (conversation_id, position),

        CONSTRAINT ctx_item_exactly_one_ref CHECK (
          (item_type = 'message'::context_item_type AND message_id IS NOT NULL AND summary_id IS NULL) OR
          (item_type = 'summary'::context_item_type AND summary_id IS NOT NULL AND message_id IS NULL)
        ),

        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE RESTRICT,
        FOREIGN KEY (summary_id) REFERENCES summaries(summary_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS ctx_items_conv_pos_idx ON context_items(conversation_id, position);
      CREATE INDEX IF NOT EXISTS ctx_items_summary_idx ON context_items(summary_id);
      CREATE INDEX IF NOT EXISTS ctx_items_message_idx ON context_items(message_id);

      -- 7) Large files (for files too big to fit in context)
      -- Stores path-backed files and inline payloads (text/binary) under one ID space.
      CREATE TABLE IF NOT EXISTS large_files (
        file_id         text PRIMARY KEY,
        conversation_id bigint NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        storage_kind    text NOT NULL DEFAULT 'path', -- path | inline_text | inline_binary
        original_path   text,           -- Path to the file on disk (for storage_kind='path')
        mime_type       text NOT NULL,
        content         text,           -- Inline text payload
        binary_content  bytea,          -- Inline binary payload
        token_count     bigint NOT NULL, -- BIGINT to support files with billions of tokens
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      -- Migration: change token_count from integer to bigint if needed
      DO $$ BEGIN
        ALTER TABLE large_files ALTER COLUMN token_count TYPE bigint;
      EXCEPTION WHEN others THEN NULL; END $$;

      -- Migration: drop the old content check constraint to allow path-only storage (avoid NOTICE spam)
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'large_file_content_check'
            AND conrelid = 'large_files'::regclass
        ) THEN
          EXECUTE 'ALTER TABLE large_files DROP CONSTRAINT large_file_content_check';
        END IF;
      END $$;

      -- Migration: add storage_kind for explicit payload mode (path/inline_text/inline_binary)
      DO $$ BEGIN
        ALTER TABLE large_files ADD COLUMN storage_kind text;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      -- Migration: backfill storage_kind from existing data
      UPDATE large_files
      SET storage_kind = CASE
        WHEN content IS NOT NULL THEN 'inline_text'
        WHEN binary_content IS NOT NULL THEN 'inline_binary'
        ELSE 'path'
      END
      WHERE storage_kind IS NULL;

      -- Migration: default + NOT NULL for storage_kind
      DO $$ BEGIN
        ALTER TABLE large_files ALTER COLUMN storage_kind SET DEFAULT 'path';
      EXCEPTION WHEN others THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE large_files ALTER COLUMN storage_kind SET NOT NULL;
      EXCEPTION WHEN others THEN NULL; END $$;

      -- Migration: original_path is optional for inline payloads
      DO $$ BEGIN
        ALTER TABLE large_files ALTER COLUMN original_path DROP NOT NULL;
      EXCEPTION WHEN others THEN NULL; END $$;

      -- Migration: enforce coherent large_files row shape by storage_kind
      DO $$ DECLARE
        current_def text;
        normalized_current_def text;
        normalized_desired_def text := regexp_replace(
          lower(
            'CHECK (
              (storage_kind = ''path'' AND original_path IS NOT NULL AND content IS NULL AND binary_content IS NULL) OR
              (storage_kind = ''inline_text'' AND content IS NOT NULL AND binary_content IS NULL) OR
              (storage_kind = ''inline_binary'' AND binary_content IS NOT NULL AND content IS NULL)
            )'
          ),
          '[[:space:]()]',
          '',
          'g'
        );
      BEGIN
        SELECT pg_get_constraintdef(oid)
          INTO current_def
        FROM pg_constraint
        WHERE conname = 'large_files_storage_shape_check'
          AND conrelid = 'large_files'::regclass;

        IF current_def IS NOT NULL THEN
          normalized_current_def := regexp_replace(
            lower(replace(current_def, '::text', '')),
            '[[:space:]()]',
            '',
            'g'
          );
        END IF;

        IF current_def IS NULL OR normalized_current_def != normalized_desired_def THEN
          IF current_def IS NOT NULL THEN
            EXECUTE 'ALTER TABLE large_files DROP CONSTRAINT large_files_storage_shape_check';
          END IF;

          BEGIN
            ALTER TABLE large_files
              ADD CONSTRAINT large_files_storage_shape_check CHECK (
                (storage_kind = 'path' AND original_path IS NOT NULL AND content IS NULL AND binary_content IS NULL) OR
                (storage_kind = 'inline_text' AND content IS NOT NULL AND binary_content IS NULL) OR
                (storage_kind = 'inline_binary' AND binary_content IS NOT NULL AND content IS NULL)
              );
          EXCEPTION WHEN duplicate_object THEN NULL; END;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS large_files_conv_idx ON large_files(conversation_id);
      CREATE INDEX IF NOT EXISTS large_files_path_idx ON large_files(original_path);

      -- 8) Message parts (structured storage for message content)
      DO $$ BEGIN
        CREATE TYPE message_part_type AS ENUM (
          'text','reasoning','tool','patch','file',
          'subtask','compaction','step_start','step_finish',
          'snapshot','agent','retry'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS message_parts (
        part_id         text PRIMARY KEY,
        message_id      bigint NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        session_id      text NOT NULL,
        part_type       message_part_type NOT NULL,
        ordinal         integer NOT NULL,

        -- TextPart / ReasoningPart
        text_content    text,
        is_ignored      boolean,
        is_synthetic    boolean,

        -- ToolPart
        tool_call_id    text,
        tool_name       text,
        tool_status     text,
        tool_input      jsonb,
        tool_output     text,
        tool_error      text,
        tool_title      text,

        -- PatchPart
        patch_hash      text,
        patch_files     text[],

        -- FilePart
        file_mime       text,
        file_name       text,
        file_url        text,

        -- SubtaskPart
        subtask_prompt  text,
        subtask_desc    text,
        subtask_agent   text,

        -- StepFinishPart
        step_reason     text,
        step_cost       numeric,
        step_tokens_in  integer,
        step_tokens_out integer,

        -- SnapshotPart / StepStartPart
        snapshot_hash   text,

        -- CompactionPart
        compaction_auto boolean,

        -- Catch-all for metadata bags (Record<string, any>)
        metadata        jsonb,

        UNIQUE (message_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS message_parts_message_idx ON message_parts(message_id);
      CREATE INDEX IF NOT EXISTS message_parts_type_idx ON message_parts(part_type);

      -- Migration: add exploration_summary column for storing file analysis results
      DO $$ BEGIN
        ALTER TABLE large_files ADD COLUMN exploration_summary text;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      -- Migration: add explorer_used column for storing which explorer analyzed the file
      DO $$ BEGIN
        ALTER TABLE large_files ADD COLUMN explorer_used text;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;

      -- 9) Agentic map runs (parallel map over JSONL items)
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

      -- 10) Agentic map items (one row per input line)
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

      -- 11) LLM map runs (non-agentic parallel map over JSONL items)
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

      -- Migration: rename effort → model in llm_map_runs
      DO $$ BEGIN
        ALTER TABLE llm_map_runs RENAME COLUMN effort TO model;
      EXCEPTION WHEN undefined_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE llm_map_runs ALTER COLUMN model DROP NOT NULL;
      EXCEPTION WHEN others THEN NULL; END $$;

      -- 12) LLM map items (one row per input line)
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

    log.info("migrations completed")
  }

  // Query functions

  /**
   * Create a new conversation
   */
  export async function createConversation(input: {
    title?: string
    modelName: string
    modelCtxMaxTokens: number
    ctxCutoffThreshold?: number
    parentConversationId?: number
  }): Promise<number> {
    const conn = sql()
    const threshold = input.ctxCutoffThreshold ?? 0.6
    const [row] = await conn<{ conversation_id: number }[]>`
      INSERT INTO conversations (title, model_name, model_ctx_max_tokens, ctx_cutoff_threshold, parent_conversation_id)
      VALUES (${input.title ?? null}, ${input.modelName}, ${input.modelCtxMaxTokens}, ${threshold}, ${input.parentConversationId ?? null})
      RETURNING conversation_id
    `
    log.info("created conversation", {
      conversationId: row.conversation_id,
      parentConversationId: input.parentConversationId,
    })
    return row.conversation_id
  }

  /**
   * Get all ancestor conversation IDs for a conversation (including itself).
   * Returns IDs in order from the given conversation up to the root.
   */
  export async function getAncestorConversationIds(conversationId: number): Promise<number[]> {
    const conn = sql()
    const rows = await conn<{ conversation_id: number }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT conversation_id, parent_conversation_id
        FROM conversations
        WHERE conversation_id = ${conversationId}
        UNION ALL
        SELECT c.conversation_id, c.parent_conversation_id
        FROM conversations c
        JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
      )
      SELECT conversation_id FROM ancestors
    `
    return rows.map((r) => r.conversation_id)
  }

  /**
   * Append a message to a conversation and add it to the current context
   */
  export async function appendMessage(input: {
    conversationId: number
    role: MessageRole
    content: string
    tokenCount: number
  }): Promise<number> {
    const conn = sql()
    // Use a transaction with explicit row locking on the conversation to prevent race conditions
    const [row] = await conn.begin(async (tx) => {
      // Lock the conversation row to serialize concurrent appends
      await tx`
        SELECT conversation_id FROM conversations
        WHERE conversation_id = ${input.conversationId}
        FOR UPDATE
      `

      // Get next sequence number
      const [seqRow] = await tx<{ next_seq: number }[]>`
        SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
        FROM messages
        WHERE conversation_id = ${input.conversationId}
      `
      const nextSeq = seqRow?.next_seq ?? 1

      // Insert the message
      const [msgRow] = await tx<{ message_id: number }[]>`
        INSERT INTO messages (conversation_id, seq, role, content, token_count)
        VALUES (${input.conversationId}, ${nextSeq}, ${input.role}::message_role, ${escNull(input.content)}, ${input.tokenCount})
        RETURNING message_id
      `

      // Get next context position
      const [posRow] = await tx<{ next_pos: number }[]>`
        SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
        FROM context_items
        WHERE conversation_id = ${input.conversationId}
      `
      const nextPos = posRow?.next_pos ?? 0

      // Insert context item
      await tx`
        INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
        VALUES (${input.conversationId}, ${nextPos}, 'message'::context_item_type, ${msgRow.message_id}, NULL)
      `

      return [msgRow]
    })
    log.debug("appended message", { conversationId: input.conversationId, messageId: row.message_id })
    return row.message_id
  }

  /**
   * Input type for inserting a message part row.
   */
  export interface MessagePartInput {
    partId: string
    sessionId: string
    partType: MessagePartType
    ordinal: number
    textContent?: string | null
    isIgnored?: boolean | null
    isSynthetic?: boolean | null
    toolCallId?: string | null
    toolName?: string | null
    toolStatus?: string | null
    toolInput?: unknown | null
    toolOutput?: string | null
    toolError?: string | null
    toolTitle?: string | null
    patchHash?: string | null
    patchFiles?: string[] | null
    fileMime?: string | null
    fileName?: string | null
    fileUrl?: string | null
    subtaskPrompt?: string | null
    subtaskDesc?: string | null
    subtaskAgent?: string | null
    stepReason?: string | null
    stepCost?: number | null
    stepTokensIn?: number | null
    stepTokensOut?: number | null
    snapshotHash?: string | null
    compactionAuto?: boolean | null
    metadata?: unknown | null
  }

  /**
   * Insert structured parts for a message into the message_parts table.
   */
  export async function insertMessageParts(messageId: number, parts: MessagePartInput[]): Promise<void> {
    if (parts.length === 0) return
    const conn = sql()
    for (const p of parts) {
      await conn`
        INSERT INTO message_parts (
          part_id, message_id, session_id, part_type, ordinal,
          text_content, is_ignored, is_synthetic,
          tool_call_id, tool_name, tool_status, tool_input, tool_output, tool_error, tool_title,
          patch_hash, patch_files,
          file_mime, file_name, file_url,
          subtask_prompt, subtask_desc, subtask_agent,
          step_reason, step_cost, step_tokens_in, step_tokens_out,
          snapshot_hash, compaction_auto,
          metadata
        ) VALUES (
          ${p.partId}, ${messageId}, ${p.sessionId}, ${p.partType}::message_part_type, ${p.ordinal},
          ${escNullOpt(p.textContent) ?? null}, ${p.isIgnored ?? null}, ${p.isSynthetic ?? null},
          ${p.toolCallId ?? null}, ${p.toolName ?? null}, ${p.toolStatus ?? null},
          ${p.toolInput != null ? conn.json(p.toolInput as postgres.JSONValue) : null},
          ${escNullOpt(p.toolOutput) ?? null}, ${escNullOpt(p.toolError) ?? null}, ${p.toolTitle ?? null},
          ${p.patchHash ?? null}, ${p.patchFiles ?? null},
          ${p.fileMime ?? null}, ${p.fileName ?? null}, ${p.fileUrl ?? null},
          ${p.subtaskPrompt ?? null}, ${p.subtaskDesc ?? null}, ${p.subtaskAgent ?? null},
          ${p.stepReason ?? null}, ${p.stepCost ?? null}, ${p.stepTokensIn ?? null}, ${p.stepTokensOut ?? null},
          ${p.snapshotHash ?? null}, ${p.compactionAuto ?? null},
          ${p.metadata != null ? conn.json(p.metadata as postgres.JSONValue) : null}
        )
      `
    }
  }

  /**
   * Get structured parts for a message, ordered by ordinal.
   * Returns null if no parts exist (old message without structured storage).
   */
  export async function getMessageParts(messageId: number): Promise<MessagePart[] | null> {
    const conn = sql()
    const rows = await conn<MessagePart[]>`
      SELECT * FROM message_parts
      WHERE message_id = ${messageId}
      ORDER BY ordinal
    `
    return rows.length > 0 ? rows : null
  }

  /**
   * Get structured parts for multiple messages at once.
   * Returns a map of messageId -> parts array. Messages without parts are omitted.
   */
  export async function getMessagePartsForMessages(messageIds: number[]): Promise<Map<number, MessagePart[]>> {
    if (messageIds.length === 0) return new Map()
    const conn = sql()
    const rows = await conn<MessagePart[]>`
      SELECT * FROM message_parts
      WHERE message_id = ANY(${messageIds})
      ORDER BY message_id, ordinal
    `
    const result = new Map<number, MessagePart[]>()
    for (const row of rows) {
      const existing = result.get(row.message_id)
      if (existing) {
        existing.push(row)
      } else {
        result.set(row.message_id, [row])
      }
    }
    return result
  }

  /**
   * Get the current context for a conversation as the LLM should see it.
   *
   * For summary items, the content is formatted with the summary ID and parent IDs
   * at the beginning to ensure the model always has access to all summary IDs for retrieval.
   * Format: [Summary ID: sum_xxx]\n[Parent Summaries: sum_a, sum_b]\n\n<content>
   */
  export async function getCurrentContext(conversationId: number): Promise<ContextEntry[]> {
    const conn = sql()

    // Extended query to include summary_id and kind for formatting, plus message_id
    interface ContextEntryRaw {
      position: number
      item_type: ContextItemType
      message_id: number | null
      role: string
      content: string
      token_count: number
      summary_id: string | null
      summary_kind: SummaryKind | null
    }

    const rows = await conn<ContextEntryRaw[]>`
      SELECT
        ci.position,
        ci.item_type,
        ci.message_id,
        COALESCE(m.role::text, 'summary') AS role,
        COALESCE(m.content, s.content)    AS content,
        COALESCE(m.token_count, s.token_count) AS token_count,
        ci.summary_id,
        s.kind AS summary_kind
      FROM context_items ci
      LEFT JOIN messages  m ON m.message_id = ci.message_id
      LEFT JOIN summaries s ON s.summary_id = ci.summary_id
      WHERE ci.conversation_id = ${conversationId}
      ORDER BY ci.position
    `

    // For summary items, we need to format the content with ID injection
    const result: ContextEntry[] = []
    for (const row of rows) {
      if (row.item_type === "summary" && row.summary_id) {
        // Get parent summary IDs for condensed summaries
        const parents = row.summary_kind === "condensed" ? await getSummaryParentIds(row.summary_id) : []

        // Format content with ID injection
        const formattedContent = formatSummaryContentForContext(row.summary_id, row.content, parents)
        // Include formatting overhead in token count to match actual context size
        const formattingOverhead = getSummaryFormattingOverhead(row.summary_id, parents)
        result.push({
          position: row.position,
          item_type: row.item_type,
          message_id: null,
          role: row.role,
          content: formattedContent,
          token_count: row.token_count + formattingOverhead,
        })
      } else {
        result.push({
          position: row.position,
          item_type: row.item_type,
          message_id: row.message_id,
          role: row.role,
          content: row.content,
          token_count: row.token_count,
        })
      }
    }

    return result
  }

  /**
   * Format summary content with ID injection for context.
   *
   * This deterministically includes the summary ID and parent IDs at the beginning
   * of the content, ensuring the model always has access to all IDs for retrieval.
   *
   * @param summaryId - The summary's ID
   * @param content - The raw summary content
   * @param parents - Parent summary IDs (for condensed summaries)
   * @returns Formatted string for context injection
   */
  function formatSummaryContentForContext(summaryId: string, content: string, parents: string[]): string {
    const lines: string[] = []
    lines.push(`[Summary ID: ${summaryId}]`)
    if (parents.length > 0) {
      lines.push(`[Parent Summaries: ${parents.join(", ")}]`)
    }
    lines.push("")
    lines.push(content)
    return lines.join("\n")
  }

  /**
   * Compute the token overhead added by formatSummaryContentForContext.
   *
   * This calculates the additional tokens from the `[Summary ID: ...]` header
   * and optionally the `[Parent Summaries: ...]` header, plus newlines.
   *
   * @param summaryId - The summary's ID
   * @param parents - Parent summary IDs (for condensed summaries)
   * @returns Estimated token count for the formatting overhead
   */
  function getSummaryFormattingOverhead(summaryId: string, parents: string[]): number {
    // Build the formatting text without the actual content
    const lines: string[] = []
    lines.push(`[Summary ID: ${summaryId}]`)
    if (parents.length > 0) {
      lines.push(`[Parent Summaries: ${parents.join(", ")}]`)
    }
    lines.push("") // Empty line before content
    const formattingText = lines.join("\n")
    return LargeFileThreshold.estimateTokenCount(formattingText)
  }

  /**
   * Compute the total token count for the current context.
   *
   * This includes the formatting overhead for summary entries, which add
   * `[Summary ID: ...]` and optionally `[Parent Summaries: ...]` headers
   * when injected into context.
   */
  export async function getContextTokenCount(conversationId: number): Promise<number> {
    const conn = sql()

    // Get base token counts plus summary metadata needed for formatting overhead
    interface ContextTokenRow {
      item_type: ContextItemType
      token_count: number
      summary_id: string | null
      summary_kind: SummaryKind | null
    }

    const rows = await conn<ContextTokenRow[]>`
      SELECT
        ci.item_type,
        COALESCE(m.token_count, s.token_count) AS token_count,
        ci.summary_id,
        s.kind AS summary_kind
      FROM context_items ci
      LEFT JOIN messages  m ON m.message_id = ci.message_id
      LEFT JOIN summaries s ON s.summary_id = ci.summary_id
      WHERE ci.conversation_id = ${conversationId}
    `

    let total = 0
    for (const row of rows) {
      total += row.token_count

      // Add formatting overhead for summary entries
      if (row.item_type === "summary" && row.summary_id) {
        const parents = row.summary_kind === "condensed" ? await getSummaryParentIds(row.summary_id) : []
        total += getSummaryFormattingOverhead(row.summary_id, parents)
      }
    }

    return total
  }

  /**
   * Get the earliest messages in context to summarize (prefix within a token budget)
   */
  export async function getMessagesToSummarize(
    conversationId: number,
    tokenBudget: number,
  ): Promise<{ position: number; messageId: number }[]> {
    const conn = sql()
    const rows = await conn<{ position: number; message_id: number }[]>`
      WITH msgs AS (
        SELECT
          ci.position,
          ci.message_id,
          m.token_count,
          SUM(m.token_count) OVER (ORDER BY ci.position) AS running_tokens
        FROM context_items ci
        JOIN messages m ON m.message_id = ci.message_id
        WHERE ci.conversation_id = ${conversationId}
          AND ci.item_type = 'message'::context_item_type
        ORDER BY ci.position
      )
      SELECT position, message_id
      FROM msgs
      WHERE running_tokens <= ${tokenBudget}
      ORDER BY position
    `
    if (rows.length > 0) {
      return rows.map((r) => ({ position: r.position, messageId: r.message_id }))
    }

    // Fallback: if the oldest message exceeds the budget, still summarize it to make progress
    const fallback = await conn<{ position: number; message_id: number }[]>`
      SELECT position, message_id
      FROM context_items
      WHERE conversation_id = ${conversationId}
        AND item_type = 'message'::context_item_type
      ORDER BY position
      LIMIT 1
    `
    return fallback.map((r) => ({ position: r.position, messageId: r.message_id }))
  }

  /**
   * Get the count of messages stored for a conversation.
   */
  export async function getMessageCount(conversationId: number): Promise<number> {
    const conn = sql()
    const rows = await conn<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM messages
      WHERE conversation_id = ${conversationId}
    `
    return rows[0]?.count ?? 0
  }

  /**
   * Insert a new leaf summary and link it to messages
   */
  export async function insertLeafSummary(input: {
    summaryId: string
    conversationId: number
    content: string
    tokenCount: number
    messageIds: number[]
    fileIds?: string[]
  }): Promise<void> {
    const conn = sql()
    const fileIds = JSON.stringify(input.fileIds ?? [])
    await conn.begin(async (tx) => {
      await tx`
        INSERT INTO summaries (
          summary_id,
          conversation_id,
          kind,
          summary_level,
          summary_type,
          content,
          token_count,
          file_ids,
          is_off_context
        )
        VALUES (
          ${input.summaryId},
          ${input.conversationId},
          'leaf',
          'leaf',
          'leaf',
          ${escNull(input.content)},
          ${input.tokenCount},
          ${fileIds}::jsonb,
          false
        )
      `
      if (input.messageIds.length > 0) {
        const values = input.messageIds.map((id, i) => ({ summary_id: input.summaryId, message_id: id, ord: i + 1 }))
        await tx`
          INSERT INTO summary_messages ${tx(values)}
        `
      }
    })
    log.debug("inserted leaf summary", { summaryId: input.summaryId, messageCount: input.messageIds.length })
  }

  /**
   * Insert a new condensed summary and link it to parent summaries
   */
  export async function insertCondensedSummary(input: {
    summaryId: string
    conversationId: number
    content: string
    tokenCount: number
    parentSummaryIds: string[]
    fileIds?: string[]
  }): Promise<void> {
    const conn = sql()
    const fileIds = JSON.stringify(input.fileIds ?? [])
    await conn.begin(async (tx) => {
      if (input.parentSummaryIds.length > 0) {
        const parentRows = await tx<{ summary_id: string; summary_level: SummaryLevel; summary_type: SummaryType }[]>`
          SELECT
            s.summary_id,
            COALESCE(s.summary_level, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_level,
            COALESCE(s.summary_type, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_type
          FROM summaries s
          WHERE s.summary_id = ANY(${input.parentSummaryIds})
        `

        const foundParentIds = new Set(parentRows.map((row) => row.summary_id))
        const missingParentIds = input.parentSummaryIds.filter((summaryId) => !foundParentIds.has(summaryId))
        if (missingParentIds.length > 0) {
          throw new InvariantError({
            message: "Cannot create bindle summary with unknown parent summaries",
            summaryIds: missingParentIds,
          })
        }

        const nonLeafParentIds = parentRows
          .filter((row) => row.summary_level !== "leaf" || row.summary_type !== "leaf")
          .map((row) => row.summary_id)
        if (nonLeafParentIds.length > 0) {
          throw new InvariantError({
            message: "Cannot aggregate bindle summaries; bindles may only be created from leaf summaries",
            summaryIds: nonLeafParentIds,
          })
        }
      }

      await tx`
        INSERT INTO summaries (
          summary_id,
          conversation_id,
          kind,
          summary_level,
          summary_type,
          content,
          token_count,
          file_ids,
          is_off_context
        )
        VALUES (
          ${input.summaryId},
          ${input.conversationId},
          'condensed',
          'bindle',
          'bindle',
          ${escNull(input.content)},
          ${input.tokenCount},
          ${fileIds}::jsonb,
          false
        )
      `
      if (input.parentSummaryIds.length > 0) {
        const values = input.parentSummaryIds.map((id, i) => ({
          summary_id: input.summaryId,
          parent_summary_id: id,
          ord: i + 1,
        }))
        await tx`
          INSERT INTO summary_parents ${tx(values)}
        `
      }
    })
    log.debug("inserted condensed summary", { summaryId: input.summaryId, parentCount: input.parentSummaryIds.length })
  }

  /**
   * Replace a range of context items with a summary
   */
  export async function replaceContextWithSummary(input: {
    conversationId: number
    startPosition: number
    endPosition: number
    summaryId: string
  }): Promise<void> {
    const conn = sql()
    await conn.begin(async (tx) => {
      // First, collect the items to keep (outside the range) plus the new summary
      const items = await tx<
        { position: number; item_type: ContextItemType; message_id: number | null; summary_id: string | null }[]
      >`
        SELECT position, item_type, message_id, summary_id
        FROM context_items
        WHERE conversation_id = ${input.conversationId}
          AND NOT (position BETWEEN ${input.startPosition} AND ${input.endPosition})
        ORDER BY position
      `

      // Delete all context items for this conversation
      await tx`DELETE FROM context_items WHERE conversation_id = ${input.conversationId}`

      // Build the new context with renumbered positions
      const newItems: {
        position: number
        item_type: ContextItemType
        message_id: number | null
        summary_id: string | null
      }[] = []

      // Add items before the replacement point
      for (const item of items.filter((i) => i.position < input.startPosition)) {
        newItems.push(item)
      }

      // Add the summary at the replacement point
      newItems.push({
        position: input.startPosition, // Will be renumbered
        item_type: "summary",
        message_id: null,
        summary_id: input.summaryId,
      })

      // Add items after the replacement point
      for (const item of items.filter((i) => i.position > input.endPosition)) {
        newItems.push(item)
      }

      // Insert with renumbered positions
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i]
        await tx`
          INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
          VALUES (${input.conversationId}, ${i}, ${item.item_type}::context_item_type, ${item.message_id}, ${item.summary_id})
        `
      }
    })
    log.debug("replaced context with summary", {
      conversationId: input.conversationId,
      startPosition: input.startPosition,
      endPosition: input.endPosition,
      summaryId: input.summaryId,
    })
  }

  /**
   * Replace specific context positions with a summary, preserving items between them.
   *
   * Unlike replaceContextWithSummary which replaces a contiguous range,
   * this function only removes items at the specified positions, keeping
   * any items that happen to be between them.
   *
   * @param input.conversationId - The conversation ID
   * @param input.positions - The specific positions to remove (non-contiguous allowed)
   * @param input.summaryId - The summary ID to insert at the earliest position
   */
  export async function replacePositionsWithSummary(input: {
    conversationId: number
    positions: number[]
    summaryId: string
  }): Promise<void> {
    if (input.positions.length === 0) return

    const conn = sql()
    const insertPosition = Math.min(...input.positions)
    const positionsSet = new Set(input.positions)

    await conn.begin(async (tx) => {
      // Collect items to keep (NOT in the positions list)
      const items = await tx<
        { position: number; item_type: ContextItemType; message_id: number | null; summary_id: string | null }[]
      >`
        SELECT position, item_type, message_id, summary_id
        FROM context_items
        WHERE conversation_id = ${input.conversationId}
        ORDER BY position
      `

      // Delete all context items for this conversation
      await tx`DELETE FROM context_items WHERE conversation_id = ${input.conversationId}`

      // Build new context: keep items not in positions, insert summary at earliest position
      const newItems: {
        position: number
        item_type: ContextItemType
        message_id: number | null
        summary_id: string | null
      }[] = []
      let summaryInserted = false

      for (const item of items) {
        // Skip items being replaced
        if (positionsSet.has(item.position)) {
          // Insert summary at the first position being replaced
          if (!summaryInserted && item.position === insertPosition) {
            newItems.push({
              position: item.position,
              item_type: "summary",
              message_id: null,
              summary_id: input.summaryId,
            })
            summaryInserted = true
          }
          continue
        }

        // If we haven't inserted the summary yet and we've passed its position, insert it now
        if (!summaryInserted && item.position > insertPosition) {
          newItems.push({
            position: insertPosition,
            item_type: "summary",
            message_id: null,
            summary_id: input.summaryId,
          })
          summaryInserted = true
        }

        newItems.push(item)
      }

      // If summary wasn't inserted yet (all positions to replace are at the end), insert it now
      if (!summaryInserted) {
        newItems.push({
          position: insertPosition,
          item_type: "summary",
          message_id: null,
          summary_id: input.summaryId,
        })
      }

      // Sort by original position and renumber
      newItems.sort((a, b) => a.position - b.position)

      // Insert with renumbered positions
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i]
        await tx`
          INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
          VALUES (${input.conversationId}, ${i}, ${item.item_type}::context_item_type, ${item.message_id}, ${item.summary_id})
        `
      }
    })
    log.debug("replaced positions with summary", {
      conversationId: input.conversationId,
      positions: input.positions,
      summaryId: input.summaryId,
    })
  }

  /**
   * Retrieve a summary by ID
   *
   * @param summaryId - The summary ID to retrieve
   * @param conversationId - Optional conversation ID to scope the lookup to this conversation and its ancestors
   */
  export async function getSummaryById(summaryId: string, conversationId?: number): Promise<Summary | null> {
    const conn = sql()

    // If no conversationId provided, just do a simple lookup (backwards compatible)
    if (conversationId === undefined) {
      const rows = await conn<Summary[]>`
        SELECT
          summary_id,
          conversation_id,
          kind,
          COALESCE(summary_level, CASE WHEN kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_level,
          COALESCE(summary_type, CASE WHEN kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_type,
          content,
          token_count,
          file_ids,
          qmd_doc_id,
          qmd_doc_version,
          COALESCE(is_off_context, false) AS is_off_context,
          created_at
        FROM summaries
        WHERE summary_id = ${summaryId}
      `
      return rows[0] ?? null
    }

    // Look up summary in the conversation and all its ancestors
    const rows = await conn<Summary[]>`
      WITH RECURSIVE ancestors AS (
        SELECT conversation_id, parent_conversation_id
        FROM conversations
        WHERE conversation_id = ${conversationId}
        UNION ALL
        SELECT c.conversation_id, c.parent_conversation_id
        FROM conversations c
        JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
      )
      SELECT
        s.summary_id,
        s.conversation_id,
        s.kind,
        COALESCE(s.summary_level, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_level,
        COALESCE(s.summary_type, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_type,
        s.content,
        s.token_count,
        s.file_ids,
        s.qmd_doc_id,
        s.qmd_doc_version,
        COALESCE(s.is_off_context, false) AS is_off_context,
        s.created_at
      FROM summaries s
      JOIN ancestors a ON s.conversation_id = a.conversation_id
      WHERE s.summary_id = ${summaryId}
    `
    return rows[0] ?? null
  }

  /**
   * Recursively expand a summary into its underlying messages
   */
  export async function expandSummaryToMessages(
    summaryId: string,
  ): Promise<{ conversationId: number; seq: number; role: MessageRole; content: string; createdAt: Date }[]> {
    const conn = sql()
    const rows = await conn<
      { conversation_id: number; seq: number; role: MessageRole; content: string; created_at: Date }[]
    >`
      WITH RECURSIVE walk(summary_id) AS (
        SELECT ${summaryId}::text
        UNION
        SELECT sp.parent_summary_id
        FROM summary_parents sp
        JOIN walk w ON sp.summary_id = w.summary_id
        UNION
        SELECT sl.points_to_summary_id
        FROM summary_lineage_pointers sl
        JOIN walk w ON sl.summary_id = w.summary_id
      ),
      leaf_messages AS (
        SELECT DISTINCT sm.message_id
        FROM walk w
        JOIN summary_messages sm ON sm.summary_id = w.summary_id
      )
      SELECT DISTINCT m.conversation_id, m.seq, m.role, m.content, m.created_at
      FROM leaf_messages lm
      JOIN messages m ON m.message_id = lm.message_id
      ORDER BY m.seq
    `
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  /**
   * Search messages using full-text search
   */
  export async function searchMessages(
    conversationId: number,
    query: string,
    limit = 50,
  ): Promise<MessageSearchResult[]> {
    const conn = sql()
    const rows = await conn<MessageSearchResult[]>`
      SELECT message_id, seq, role
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND content_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY seq
      LIMIT ${limit}
    `
    return rows
  }

  /**
   * Search summaries using full-text search
   */
  export async function searchSummaries(
    conversationId: number,
    query: string,
    limit = 50,
  ): Promise<SummarySearchResult[]> {
    const conn = sql()
    const rows = await conn<SummarySearchResult[]>`
      SELECT summary_id, kind
      FROM summaries
      WHERE conversation_id = ${conversationId}
        AND content_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    return rows
  }

  /**
   * Get a conversation by ID
   */
  export async function getConversation(conversationId: number): Promise<Conversation | null> {
    const conn = sql()
    const rows = await conn<Conversation[]>`
      SELECT conversation_id, title, model_name, model_ctx_max_tokens, ctx_cutoff_threshold, created_at
      FROM conversations
      WHERE conversation_id = ${conversationId}
    `
    return rows[0] ?? null
  }

  /**
   * Get a message by ID
   */
  export async function getMessage(messageId: number): Promise<Message | null> {
    const conn = sql()
    const rows = await conn<Message[]>`
      SELECT message_id, conversation_id, seq, role, content, token_count, created_at
      FROM messages
      WHERE message_id = ${messageId}
    `
    return rows[0] ?? null
  }

  /**
   * Get all messages for a conversation
   */
  export async function getMessages(conversationId: number): Promise<Message[]> {
    const conn = sql()
    const rows = await conn<Message[]>`
      SELECT message_id, conversation_id, seq, role, content, token_count, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY seq
    `
    return rows
  }

  /**
   * Get message IDs linked to a leaf summary
   */
  export async function getSummaryMessageIds(summaryId: string): Promise<number[]> {
    const conn = sql()
    const rows = await conn<{ message_id: number }[]>`
      SELECT message_id
      FROM summary_messages
      WHERE summary_id = ${summaryId}
      ORDER BY ord
    `
    return rows.map((r) => r.message_id)
  }

  /**
   * Get parent summary IDs for a condensed summary
   */
  export async function getSummaryParentIds(summaryId: string): Promise<string[]> {
    const conn = sql()
    const rows = await conn<{ parent_summary_id: string }[]>`
      SELECT parent_summary_id
      FROM summary_parents
      WHERE summary_id = ${summaryId}
      ORDER BY ord
    `
    return rows.map((r) => r.parent_summary_id)
  }

  /**
   * Get child summary IDs that have this summary as a parent.
   * This returns summaries that were condensed from this summary.
   */
  export async function getChildSummaryIds(summaryId: string): Promise<string[]> {
    const conn = sql()
    const rows = await conn<{ summary_id: string }[]>`
      SELECT summary_id
      FROM summary_parents
      WHERE parent_summary_id = ${summaryId}
      ORDER BY ord
    `
    return rows.map((r) => r.summary_id)
  }

  /**
   * Attach or update lineage pointers for a summary.
   * Used by archive stubs to point at full bindles and preserve traversal.
   */
  export async function upsertSummaryLineagePointers(input: {
    summaryId: string
    pointers: { pointsToSummaryId: string; pointerKind: SummaryLineagePointerKind; ord?: number }[]
  }): Promise<void> {
    if (input.pointers.length === 0) return
    const conn = sql()

    await conn.begin(async (tx) => {
      for (const [index, pointer] of input.pointers.entries()) {
        await tx`
          INSERT INTO summary_lineage_pointers (summary_id, points_to_summary_id, pointer_kind, ord)
          VALUES (${input.summaryId}, ${pointer.pointsToSummaryId}, ${pointer.pointerKind}, ${pointer.ord ?? index + 1})
          ON CONFLICT (summary_id, pointer_kind, points_to_summary_id)
          DO UPDATE SET ord = EXCLUDED.ord
        `
      }
    })
  }

  /**
   * Get outgoing lineage pointers for a summary in ordinal order.
   */
  export async function getSummaryLineagePointers(summaryId: string): Promise<SummaryLineagePointer[]> {
    const conn = sql()
    return conn<SummaryLineagePointer[]>`
      SELECT summary_id, points_to_summary_id, pointer_kind, ord, created_at
      FROM summary_lineage_pointers
      WHERE summary_id = ${summaryId}
      ORDER BY ord
    `
  }

  /**
   * Traverse full lineage from a summary via both parent and archive pointer edges.
   * Returns the reachable summary IDs including the starting summary.
   */
  export async function getSummaryLineageIds(summaryId: string): Promise<string[]> {
    const conn = sql()
    const rows = await conn<{ summary_id: string }[]>`
      WITH RECURSIVE walk(summary_id) AS (
        SELECT ${summaryId}::text
        UNION
        SELECT sp.parent_summary_id
        FROM summary_parents sp
        JOIN walk w ON sp.summary_id = w.summary_id
        UNION
        SELECT sl.points_to_summary_id
        FROM summary_lineage_pointers sl
        JOIN walk w ON sl.summary_id = w.summary_id
      )
      SELECT summary_id FROM walk
    `
    return rows.map((r) => r.summary_id)
  }

  /**
   * Update retrieval mapping metadata for a summary.
   * qmd_doc_id links a summary to a deterministic qmd recall artifact.
   */
  export async function setSummaryQmdDocMapping(input: {
    summaryId: string
    qmdDocId: string | null
    qmdDocVersion?: number | null
  }): Promise<void> {
    const conn = sql()
    await conn`
      UPDATE summaries
      SET qmd_doc_id = ${input.qmdDocId},
          qmd_doc_version = ${input.qmdDocVersion ?? null}
      WHERE summary_id = ${input.summaryId}
    `
  }

  /**
   * Mark a summary as an archive stub for bindle eviction lineage.
   */
  export async function markSummaryAsArchiveStub(summaryId: string): Promise<void> {
    const conn = sql()
    await conn`
      UPDATE summaries
      SET summary_level = 'bindle',
          summary_type = 'archive_stub',
          is_off_context = true
      WHERE summary_id = ${summaryId}
    `
  }

  /**
   * Mark summaries as active-context or off-context for retrieval filtering.
   * Off-context summaries are eligible for retrieval hooks and qmd vector recall.
   */
  export async function setSummariesOffContext(summaryIds: string[], isOffContext: boolean): Promise<void> {
    if (summaryIds.length === 0) return
    const conn = sql()
    await conn`
      UPDATE summaries
      SET is_off_context = ${isOffContext}
      WHERE summary_id = ANY(${summaryIds})
    `
  }

  /**
   * Fetch off-context summaries for retrieval, optionally restricted by lane.
   */
  export async function getOffContextSummaries(input: {
    conversationId: number
    summaryLevel?: SummaryLevel
    limit?: number
  }): Promise<Summary[]> {
    const conn = sql()
    const limit = input.limit ?? 50
    const rows = await conn<Summary[]>`
      WITH RECURSIVE ancestors AS (
        SELECT conversation_id, parent_conversation_id
        FROM conversations
        WHERE conversation_id = ${input.conversationId}
        UNION ALL
        SELECT c.conversation_id, c.parent_conversation_id
        FROM conversations c
        JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
      )
      SELECT
        s.summary_id,
        s.conversation_id,
        s.kind,
        COALESCE(s.summary_level, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_level,
        COALESCE(s.summary_type, CASE WHEN s.kind = 'condensed'::summary_kind THEN 'bindle' ELSE 'leaf' END) AS summary_type,
        s.content,
        s.token_count,
        s.file_ids,
        s.qmd_doc_id,
        s.qmd_doc_version,
        COALESCE(s.is_off_context, false) AS is_off_context,
        s.created_at
      FROM summaries s
      JOIN ancestors a ON s.conversation_id = a.conversation_id
      WHERE COALESCE(s.is_off_context, false) = true
        AND (${input.summaryLevel ?? null}::text IS NULL OR s.summary_level = ${input.summaryLevel ?? null})
      ORDER BY s.created_at DESC
      LIMIT ${limit}
    `
    return rows
  }

  /**
   * Find the covering summary for a message - the smallest (most specific) summary
   * that directly or indirectly contains the message.
   *
   * Returns null if the message is not covered by any summary.
   */
  export async function getCoveringSummary(messageId: number): Promise<string | null> {
    const conn = sql()
    // Find the leaf summary that directly contains this message
    const rows = await conn<{ summary_id: string }[]>`
      SELECT sm.summary_id
      FROM summary_messages sm
      WHERE sm.message_id = ${messageId}
      LIMIT 1
    `
    return rows[0]?.summary_id ?? null
  }

  /**
   * Search messages using regex pattern.
   * Optionally scoped to messages covered by a specific summary.
   */
  export async function regexSearchMessages(
    conversationId: number,
    pattern: string,
    summaryId?: string,
    limit = 100,
    offset = 0,
  ): Promise<
    { messageId: number; seq: number; role: MessageRole; content: string; coveringSummaryId: string | null }[]
  > {
    const conn = sql()

    if (summaryId) {
      // Search only messages within the scope of this summary
      const rows = await conn<
        { message_id: number; seq: number; role: MessageRole; content: string; covering_summary_id: string | null }[]
      >`
        WITH RECURSIVE walk(summary_id) AS (
          SELECT ${summaryId}::text
          UNION
          SELECT sp.parent_summary_id
          FROM summary_parents sp
          JOIN walk w ON sp.summary_id = w.summary_id
          UNION
          SELECT sl.points_to_summary_id
          FROM summary_lineage_pointers sl
          JOIN walk w ON sl.summary_id = w.summary_id
        ),
        scoped_messages AS (
          SELECT DISTINCT sm.message_id
          FROM walk w
          JOIN summary_messages sm ON sm.summary_id = w.summary_id
        )
        SELECT m.message_id, m.seq, m.role, m.content, sm2.summary_id as covering_summary_id
        FROM messages m
        JOIN scoped_messages sc ON m.message_id = sc.message_id
        LEFT JOIN summary_messages sm2 ON sm2.message_id = m.message_id
        WHERE m.conversation_id = ${conversationId}
          AND m.content ~ ${pattern}
        ORDER BY m.seq
        LIMIT ${limit}
        OFFSET ${offset}
      `
      return rows.map((r) => ({
        messageId: r.message_id,
        seq: r.seq,
        role: r.role,
        content: r.content,
        coveringSummaryId: r.covering_summary_id,
      }))
    }

    // Search all messages in the conversation
    const rows = await conn<
      { message_id: number; seq: number; role: MessageRole; content: string; covering_summary_id: string | null }[]
    >`
      SELECT m.message_id, m.seq, m.role, m.content, sm.summary_id as covering_summary_id
      FROM messages m
      LEFT JOIN summary_messages sm ON sm.message_id = m.message_id
      WHERE m.conversation_id = ${conversationId}
        AND m.content ~ ${pattern}
      ORDER BY m.seq
      LIMIT ${limit}
      OFFSET ${offset}
    `
    return rows.map((r) => ({
      messageId: r.message_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      coveringSummaryId: r.covering_summary_id,
    }))
  }

  // ============================================================================
  // Large File Functions
  // ============================================================================

  /**
   * Generate a deterministic file ID based on file path, size, and mtime.
   *
   * The ID format is: "file_" + first 16 chars of SHA-256 hash
   * Hash input: conversationId + ":" + filePath + ":" + fileSize + ":" + mtime
   *
   * This ensures:
   * - Same file in same conversation = same ID (idempotent/deduplication)
   * - Same file in different conversations = different IDs (conversation isolation)
   * - Modified files = different ID (detects changes)
   * - IDs are filesystem-safe and URL-safe
   *
   * @param conversationId - The conversation ID to scope the file to
   * @param filePath - The absolute path to the file
   * @param fileSize - The file size in bytes
   * @param mtime - The file modification time
   * @returns Deterministic file ID prefixed with "file_"
   */
  export async function generateFileIdFromPath(
    conversationId: number,
    filePath: string,
    fileSize: number,
    mtime: Date,
  ): Promise<string> {
    const hash = new Bun.CryptoHasher("sha256")
    hash.update(`${conversationId}:${filePath}:${fileSize}:${mtime.getTime()}`)
    return `file_${hash.digest("hex").slice(0, 16)}`
  }

  /**
   * @deprecated Use insertLargeFileFromPath instead. This function is kept for backwards compatibility.
   * Generate a deterministic file ID based on content hash and conversation ID.
   */
  export function generateFileId(conversationId: number, content: string): string {
    const hash = createHash("sha256").update(`${conversationId}:${content}`).digest("hex").slice(0, 16)
    return `file_${hash}`
  }

  /**
   * @deprecated Use insertLargeFileFromPath instead. This function is kept for backwards compatibility.
   * Generate a deterministic file ID for binary content scoped to a conversation.
   */
  export function generateBinaryFileId(conversationId: number, content: Uint8Array): string {
    const hash = createHash("sha256").update(`${conversationId}:`).update(content).digest("hex").slice(0, 16)
    return `file_${hash}`
  }

  /**
   * @deprecated No longer used. Large files now always store path references only.
   * Kept for backwards compatibility.
   */
  export const MAX_MEMORY_FILE_SIZE = 100 * 1024 * 1024

  /**
   * @deprecated Use insertLargeFileFromPath instead.
   * Insert a large text file into the database. This stores actual content which can fail for huge files.
   */
  export async function insertLargeFile(input: {
    conversationId: number
    originalPath?: string
    mimeType: string
    content: string
    tokenCount: number
  }): Promise<string> {
    const conn = sql()
    const fileId = generateFileId(input.conversationId, input.content)

    await conn`
      INSERT INTO large_files (file_id, conversation_id, storage_kind, original_path, mime_type, content, token_count)
      VALUES (${fileId}, ${input.conversationId}, 'inline_text', ${input.originalPath ?? null}, ${input.mimeType}, ${escNull(input.content)}, ${input.tokenCount})
      ON CONFLICT (file_id) DO NOTHING
    `
    log.debug("inserted large file", { fileId, conversationId: input.conversationId, originalPath: input.originalPath })
    return fileId
  }

  /**
   * Insert large text content directly into the database.
   *
   * This function is for storing inline text content (e.g., from user prompts)
   * that doesn't come from a file on disk. The content is stored directly in
   * the database.
   *
   * Note: For very large content (>100MB), this may fail. Use insertLargeFileFromPath
   * for disk-based files instead.
   *
   * @param input - The text content and metadata
   * @returns Object with file_id and token count
   */
  export async function insertLargeTextContent(input: {
    conversationId: number
    content: string
    mimeType?: string
    label?: string
  }): Promise<{ fileId: string; tokenCount: number }> {
    const conn = sql()
    const tokenCount = LargeFileThreshold.estimateTokenCount(input.content)
    const fileId = generateFileId(input.conversationId, input.content)

    // Don't store labels as original_path — that field is for actual file paths on disk.
    // Inline content is stored in the content column and read from there.
    const originalPath = null

    await conn`
      INSERT INTO large_files (file_id, conversation_id, storage_kind, original_path, mime_type, content, binary_content, token_count)
      VALUES (${fileId}, ${input.conversationId}, 'inline_text', ${originalPath}, ${input.mimeType ?? "text/plain"}, ${escNull(input.content)}, NULL, ${tokenCount})
      ON CONFLICT (file_id) DO NOTHING
    `
    log.debug("inserted large text content", {
      fileId,
      conversationId: input.conversationId,
      label: input.label,
      tokenCount,
      contentLength: input.content.length,
    })
    return { fileId, tokenCount }
  }

  /**
   * Insert a large file from a file path.
   *
   * This function ALWAYS stores only the file path reference, never the content.
   * Content is read from disk on demand via getLargeFileContent.
   * This approach handles files of any size (including 28GB+) without memory issues.
   *
   * @param input - The file path and metadata
   * @returns Object with file_id and token count (bigint for huge files)
   */
  export async function insertLargeFileFromPath(input: {
    conversationId: number
    filePath: string
    mimeType: string
  }): Promise<{ fileId: string; tokenCount: bigint }> {
    const conn = sql()
    const file = Bun.file(input.filePath)
    let stat: { size: number; mtime: Date }
    try {
      stat = await file.stat()
    } catch (e) {
      throw new Error(
        `Cannot stat file for large file storage: ${input.filePath}: ${e instanceof Error ? e.message : e}`,
      )
    }
    const fileSize = stat.size

    // Estimate token count from file size (~4 chars per token)
    // Use BigInt for huge files that could have billions of tokens
    const tokenCount = BigInt(Math.ceil(fileSize / 4))

    // Generate file ID from path + size + mtime for uniqueness
    const fileId = await generateFileIdFromPath(input.conversationId, input.filePath, fileSize, stat.mtime)

    // Store only the path reference, never the content
    // Convert bigint to string for postgres since it handles numeric types correctly
    await conn`
      INSERT INTO large_files (file_id, conversation_id, storage_kind, original_path, mime_type, content, binary_content, token_count)
      VALUES (${fileId}, ${input.conversationId}, 'path', ${input.filePath}, ${input.mimeType}, NULL, NULL, ${tokenCount.toString()})
      ON CONFLICT (file_id) DO NOTHING
    `
    log.debug("inserted large file path reference", {
      fileId,
      filePath: input.filePath,
      fileSize,
      tokenCount: tokenCount.toString(),
    })
    return { fileId, tokenCount }
  }

  /**
   * Update the exploration summary for a large file.
   * Called after the file has been explored to store the analysis results.
   */
  export async function updateLargeFileExploration(input: {
    fileId: string
    explorationSummary: string
    explorerUsed: string
  }): Promise<void> {
    const conn = sql()
    await conn`
      UPDATE large_files
      SET exploration_summary = ${input.explorationSummary},
          explorer_used = ${input.explorerUsed}
      WHERE file_id = ${input.fileId}
    `
    log.debug("updated large file exploration", {
      fileId: input.fileId,
      explorerUsed: input.explorerUsed,
    })
  }

  /**
   * @deprecated Use insertLargeFileFromPath instead.
   * Insert a large binary file into the database. This stores actual content which can fail for huge files.
   */
  export async function insertLargeBinaryFile(input: {
    conversationId: number
    originalPath?: string
    mimeType: string
    binaryContent: Uint8Array
    tokenCount: number
  }): Promise<string> {
    const conn = sql()
    const fileId = generateBinaryFileId(input.conversationId, input.binaryContent)

    await conn`
      INSERT INTO large_files (file_id, conversation_id, storage_kind, original_path, mime_type, binary_content, token_count)
      VALUES (${fileId}, ${input.conversationId}, 'inline_binary', ${input.originalPath ?? null}, ${input.mimeType}, ${input.binaryContent}, ${input.tokenCount})
      ON CONFLICT (file_id) DO NOTHING
    `
    log.debug("inserted large binary file", {
      fileId,
      conversationId: input.conversationId,
      originalPath: input.originalPath,
    })
    return fileId
  }

  /**
   * Get a large file record by ID.
   *
   * Note: For path-based files, the content and binary_content fields will be null.
   * Use getLargeFileContent to read content from disk.
   *
   * @param fileId - The file ID to retrieve
   * @param conversationId - Optional conversation ID to scope the lookup to this conversation and its ancestors
   * @returns The file record or null if not found
   */
  export async function getLargeFile(fileId: string, conversationId?: number): Promise<LargeFile | null> {
    const conn = sql()

    // If no conversationId provided, just do a simple lookup (backwards compatible)
    if (conversationId === undefined) {
      const rows = await conn<LargeFile[]>`
        SELECT file_id, conversation_id, storage_kind, original_path, mime_type, content, binary_content, token_count, created_at, exploration_summary, explorer_used
        FROM large_files
        WHERE file_id = ${fileId}
      `
      return rows[0] ?? null
    }

    // Look up file in the conversation and all its ancestors
    const rows = await conn<LargeFile[]>`
      WITH RECURSIVE ancestors AS (
        SELECT conversation_id, parent_conversation_id
        FROM conversations
        WHERE conversation_id = ${conversationId}
        UNION ALL
        SELECT c.conversation_id, c.parent_conversation_id
        FROM conversations c
        JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
      )
      SELECT lf.file_id, lf.conversation_id, lf.storage_kind, lf.original_path, lf.mime_type, lf.content, lf.binary_content, lf.token_count, lf.created_at, lf.exploration_summary, lf.explorer_used
      FROM large_files lf
      JOIN ancestors a ON lf.conversation_id = a.conversation_id
      WHERE lf.file_id = ${fileId}
    `
    return rows[0] ?? null
  }

  /**
   * Get the content of a large text file by ID.
   *
   * This function reads content from disk using the stored file path.
   * For legacy records with inline content, it returns the stored content.
   *
   * @param fileId - The file ID to retrieve content for
   * @param maxBytes - Optional maximum bytes to read (default: no limit, but capped at 100MB for safety)
   * @param conversationId - Optional conversation ID to scope the lookup to this conversation and its ancestors
   * @returns The file content or null if not found or file doesn't exist on disk
   */
  export async function getLargeFileContent(
    fileId: string,
    maxBytes?: number,
    conversationId?: number,
  ): Promise<{ content: string; truncated: boolean; totalSize: number } | null> {
    const conn = sql()

    // If no conversationId provided, just do a simple lookup (backwards compatible)
    const rows =
      conversationId === undefined
        ? await conn<{ storage_kind: string; content: string | null; original_path: string | null }[]>`
            SELECT storage_kind, content, original_path
            FROM large_files
            WHERE file_id = ${fileId}
          `
        : await conn<{ storage_kind: string; content: string | null; original_path: string | null }[]>`
            WITH RECURSIVE ancestors AS (
              SELECT conversation_id, parent_conversation_id
              FROM conversations
              WHERE conversation_id = ${conversationId}
              UNION ALL
              SELECT c.conversation_id, c.parent_conversation_id
              FROM conversations c
              JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
            )
            SELECT lf.storage_kind, lf.content, lf.original_path
            FROM large_files lf
            JOIN ancestors a ON lf.conversation_id = a.conversation_id
            WHERE lf.file_id = ${fileId}
          `
    const row = rows[0]
    if (!row) return null

    // Inline text payloads are returned directly from the DB.
    if (row.storage_kind === "inline_text" || (row.storage_kind !== "path" && row.content !== null)) {
      if (row.content === null) {
        return null
      }
      const limit = maxBytes ?? row.content.length
      const truncated = row.content.length > limit
      return {
        content: truncated ? row.content.slice(0, limit) : row.content,
        truncated,
        totalSize: row.content.length,
      }
    }

    if (row.storage_kind === "inline_binary") {
      // Binary content cannot be returned as text.
      return null
    }

    // Path-backed payloads are loaded from disk on demand.
    if (row.storage_kind === "path" && row.original_path) {
      const file = Bun.file(row.original_path)
      const exists = await file.exists()
      if (!exists) {
        log.warn("large file not found on disk", { fileId, path: row.original_path })
        return null
      }

      const stat = await file.stat()
      const totalSize = stat.size

      // Cap at 100MB for safety, or use the provided maxBytes
      const safeMax = Math.min(maxBytes ?? 100 * 1024 * 1024, 100 * 1024 * 1024)
      const bytesToRead = Math.min(totalSize, safeMax)
      const truncated = totalSize > bytesToRead

      if (truncated) {
        // Use slice to read only the needed portion
        const sliced = file.slice(0, bytesToRead)
        const content = await sliced.text()
        log.info("read partial file content", { fileId, bytesToRead, totalSize })
        return { content, truncated, totalSize }
      }

      const content = await file.text()
      return { content, truncated: false, totalSize }
    }

    return null
  }

  /**
   * Get all large files for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns Array of large file records
   */
  export async function getLargeFilesByConversation(conversationId: number): Promise<LargeFile[]> {
    const conn = sql()
    const rows = await conn<LargeFile[]>`
      SELECT file_id, conversation_id, storage_kind, original_path, mime_type, content, binary_content, token_count, created_at, exploration_summary, explorer_used
      FROM large_files
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at
    `
    return rows
  }

  /**
   * Check if a large file exists by ID.
   *
   * @param fileId - The file ID to check
   * @param conversationId - Optional conversation ID to scope the lookup to this conversation and its ancestors
   * @returns True if the file exists
   */
  export async function largeFileExists(fileId: string, conversationId?: number): Promise<boolean> {
    const conn = sql()

    // If no conversationId provided, just do a simple lookup (backwards compatible)
    if (conversationId === undefined) {
      const rows = await conn<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM large_files WHERE file_id = ${fileId}) AS exists
      `
      return rows[0]?.exists ?? false
    }

    // Check if file exists in the conversation or any of its ancestors
    const rows = await conn<{ exists: boolean }[]>`
      SELECT EXISTS(
        WITH RECURSIVE ancestors AS (
          SELECT conversation_id, parent_conversation_id
          FROM conversations
          WHERE conversation_id = ${conversationId}
          UNION ALL
          SELECT c.conversation_id, c.parent_conversation_id
          FROM conversations c
          JOIN ancestors a ON c.conversation_id = a.parent_conversation_id
        )
        SELECT 1
        FROM large_files lf
        JOIN ancestors a ON lf.conversation_id = a.conversation_id
        WHERE lf.file_id = ${fileId}
      ) AS exists
    `
    return rows[0]?.exists ?? false
  }
}
