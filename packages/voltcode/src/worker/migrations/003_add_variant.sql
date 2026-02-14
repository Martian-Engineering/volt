-- Migration: 003_add_variant
-- Description: Add variant column for model-specific options (e.g., reasoning_effort)

ALTER TABLE runs ADD COLUMN IF NOT EXISTS variant TEXT;
