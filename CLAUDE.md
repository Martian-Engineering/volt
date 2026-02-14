# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies (requires Bun 1.3+)
bun install

# Run Volt TUI (default: runs in packages/voltcode)
bun dev
bun dev <directory>   # Run against specific directory
bun dev .             # Run against this repo

# Type checking
bun typecheck

# Testing (DO NOT run from root - will fail intentionally)
bun test test/tool/tool.test.ts   # Run specific test in packages/voltcode

# Web UI development
bun run --cwd packages/app dev    # Dev server @ localhost:5173

# Desktop app (requires Tauri/Rust toolchain)
bun run --cwd packages/desktop tauri dev   # Full native app
bun run --cwd packages/desktop dev         # Web dev server only

# Build standalone executable
./packages/voltcode/script/build.ts --single

# Regenerate SDK after modifying server endpoints
./script/generate.ts
```

## Monorepo Structure

Turbo-managed monorepo with Bun workspaces:

- **packages/voltcode** - Core CLI/server (Bun + Hono backend)
- **packages/app** - Shared web UI components (SolidJS + Tailwind)
- **packages/desktop** - Native desktop wrapper (Tauri v2)
- **packages/plugin** - Plugin API (`@opencode-ai/plugin`)
- **packages/sdk/js** - Generated TypeScript SDK (auto-generated, don't edit directly)
- **packages/ui** - Reusable UI component library
- **packages/util** - Shared utilities

## Architecture

**Volt Core** (`packages/voltcode/src/`):

- Namespace-based organization: `Tool.define()`, `Session.create()`, `App.provide()`
- Zod schemas for all validation
- Result patterns for error handling (avoid throwing)
- Logging: `Log.create({ service: "name" })`
- Storage: `Storage` namespace for persistence
- CLI commands in `/src/cli/cmd/`

**LCM (Lossless Context Management)** (`packages/voltcode/src/session/lcm/`):

LCM is Volt's core differentiator — a deterministic context management engine that replaces OpenCode's default session handling. Key files:

- `db.ts` — Embedded PostgreSQL-backed immutable store (messages, summaries, file references)
- `context.ts` — Active context assembly: merges recent messages with summary nodes
- `condense.ts` — Summary DAG compaction: builds hierarchical summaries from older messages
- `summarize.ts` — Three-level escalation protocol (normal → aggressive → deterministic truncation)
- `large-file.ts` / `large-file-threshold.ts` — Large file handling: stores files externally, inserts content-addressed references with exploration summaries
- `explore/` — Type-aware file explorers (Python, TypeScript, Go, Rust, etc.) that generate exploration summaries
- `integrity.ts` — Referential integrity checks for the summary DAG
- `config.ts` — Soft/hard token thresholds, compaction parameters

**Operator-Level Recursion** (`packages/voltcode/src/tool/`):

- `llm-map.ts` — Parallel stateless LLM calls over JSONL input with schema validation and retries
- `agentic-map.ts` — Parallel sub-agent sessions per item, with tool access and read_only controls
- `map-shared.ts` — Shared infrastructure for both map tools (worker pool, concurrency, output registration)
- `tasks.ts` — Task delegation with infinite-recursion guard (scope-reduction invariant)

**TUI**: SolidJS + OpenTUI (terminal UI framework)

**Server/API**: Hono HTTP server communicates with clients via `@opencode-ai/sdk`

## Code Style

- Avoid `let` - use `const` with ternaries
- Avoid `else` - use early returns
- Prefer single-word identifiers
- Avoid unnecessary destructuring - use `obj.a` instead of `const { a } = obj`
- Prefer `.catch()` over `try/catch`
- Avoid `any` types
- Use Bun APIs (`Bun.file()`, etc.)

## Key Workflows

- **SDK changes**: After modifying `packages/voltcode/src/server/server.ts`, run `./script/generate.ts`
- **Internal packages**: Use `workspace:*` for dependencies
- **Shared deps**: Must use catalog versions from root package.json
- **Default branch**: `dev` (not main)
- **Parallel tools**: Always use when applicable

## PR Conventions

Titles follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
Optional scope: `feat(app):`, `fix(desktop):`

All PRs must reference an existing issue via `Fixes #123` or `Closes #123`.
