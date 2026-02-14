-- Migration: 002_create_indexes
-- Description: Create indexes for efficient querying

-- Runs table indexes
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_backend ON runs(backend);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_context_window_id ON runs(context_window_id);
CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_backend_status ON runs(backend, status);

-- Worker heartbeats indexes
CREATE INDEX IF NOT EXISTS idx_heartbeats_last_heartbeat ON worker_heartbeats(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_heartbeats_healthy ON worker_heartbeats(healthy);
