# voltcode

Core CLI and server package for Volt.

This package contains:

- Terminal UI and command handlers
- Session/runtime orchestration
- Provider adapters
- Lossless Context Management (LCM) implementation
- HTTP routes used by the local SDK/TUI

## Prerequisites

- Bun 1.3+
- macOS or Linux recommended for full local runtime parity

## Setup

From repo root:

```bash
bun install
```

From this package directory:

```bash
cd packages/voltcode
```

## Common Commands

Run dev CLI:

```bash
bun run dev
```

Typecheck:

```bash
bun run typecheck
```

Run full tests for this package:

```bash
bun test
```

Run LCM-focused tests:

```bash
bun test test/session/lcm
```

## LCM Map

Primary LCM paths:

- `src/session/lcm/context.ts`
  - lane-pressure checks
  - leaf->sprig compaction
  - sprig->bindle condensation
  - manual `/compact` short-bindling flow
  - bindle eviction and archive-stub creation
- `src/session/lcm/summarize.ts`
  - sprig summary generation prompt call
- `src/session/lcm/condense.ts`
  - bindle summary generation prompt call
- `src/session/lcm/ghost-cue.ts`
  - ultra-lapidary ghost cue generation for evicted bindles
- `src/session/lcm/db.ts`
  - persistent schema operations and lineage tables
- `src/session/token-budget.ts`
  - lane policy defaults and hysteresis decision logic
- `src/server/routes/session.ts`
  - `/session/:sessionID/lcm/compact` endpoint
- `src/cli/cmd/tui/routes/session/index.tsx`
  - `/compact` slash command UI behavior

Current lane defaults:

- leaves: soft 50k, delta 5k, target 50k, fresh tail floor 4
- sprigs: soft 10k, delta 2k, target 10k
- bindles: soft 10k, delta 2k, target 10k

Manual `/compact` currently uses short bindling:

1. Compact oldest eligible leaves to one sprig (while preserving live tail)
2. Compact all sprigs to one bindle
3. If bindles are still over target, evict one oldest bindle and store ghost cue/archive stub

If no action is possible, the API returns `noOpReasons`.

## Notes

- Some LCM integration tests require embedded Postgres and may skip when unavailable.
- Repo-level architecture and product context are documented in root `README.md`.
