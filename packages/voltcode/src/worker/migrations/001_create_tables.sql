-- Migration: 001_create_tables
-- Description: Create core tables for eval worker system

-- Runs table: tracks individual evaluation runs
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  context_length INT NOT NULL,
  context_window_id TEXT,
  seed INT,
  status TEXT NOT NULL DEFAULT 'pending',
  start_ts TIMESTAMPTZ,
  end_ts TIMESTAMPTZ,
  duration_s FLOAT,
  tokens_in BIGINT,
  tokens_out BIGINT,
  success BOOLEAN,
  score FLOAT,
  retry_count INT DEFAULT 0,
  error_message TEXT,
  s3_prefix TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Worker heartbeats table: tracks worker health and activity
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  instance_id TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMPTZ NOT NULL,
  in_flight_jobs INT,
  completed_since_last INT,
  failed_since_last INT,
  cpu_percent FLOAT,
  mem_percent FLOAT,
  healthy BOOLEAN DEFAULT true
);
