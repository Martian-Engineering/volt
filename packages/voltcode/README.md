# voltcode

`packages/voltcode` is Volt's runtime package. It is not just a CLI wrapper; it is the execution runtime for sessions, providers, tools, local server APIs, and LCM.

For product-level context, see repo-root `README.md`.

## Runtime Surface

Major subsystems in this package:

- CLI and command handling: `src/index.ts`, `src/cli/cmd/*`
- Session orchestration and model request pipeline: `src/session/*`
- LCM runtime and storage: `src/session/lcm/*`
- HTTP server (Hono) and routes: `src/server/*`
- Provider/model adapters: `src/provider/*`
- Tool registry and implementations: `src/tool/*`
- Agent framework and prompts: `src/agent/*`
- Skill discovery/runtime: `src/skill/*`
- Permission gating: `src/permission/*`
- MCP integration: `src/mcp/*`
- ACP integration: `src/acp/*`
- Plugin adapters (Codex/Copilot): `src/plugin/*`
- LSP integration: `src/lsp/*`
- Snapshot system: `src/snapshot/*`
- Worktree helpers: `src/worktree/*`
- Worker and control-plane runtimes: `src/worker/*`, `src/control-plane/*`

## Prerequisites

- Bun `1.3+`
- Embedded Postgres support requires:
- `process.platform` in `{darwin, linux}`
- `process.arch` in `{x64, arm64}`

If embedded Postgres is unsupported, use external Postgres (`LCM_DATABASE_URL` or `RDS_*`).

## Filesystem Paths (`Global.Path.*`)

`Global.Path` comes from XDG base dirs (`src/global/index.ts`):

- `Global.Path.data`: XDG data dir for `voltcode`
- `Global.Path.log`: `<Global.Path.data>/log`
- `Global.Path.config`: XDG config dir for `voltcode`
- `Global.Path.state`: XDG state dir for `voltcode`

Typical local default on many dev machines:

- `~/.local/share/voltcode/` as data root

All README path references using `Global.Path.*` resolve under those XDG directories.

## Install

From repo root:

```bash
bun install
```

From package directory for commands below:

```bash
cd packages/voltcode
```

## Run Volt

Launch interactive TUI in this package directory:

```bash
bun dev
```

Launch interactive TUI targeting a specific directory:

```bash
bun dev <directory>
```

Launch interactive TUI targeting current repo:

```bash
bun dev .
```

Run a one-shot prompt in the current directory:

```bash
bun run dev run "hello"
```

`"hello"` above is the actual user prompt sent to the session.

Run headless server:

```bash
bun run dev serve
```

Run web mode (starts server + opens browser):

```bash
bun run dev web
```

Typecheck:

```bash
bun run typecheck
```

Run package tests:

```bash
bun test
```

Run LCM tests only:

```bash
bun test test/session/lcm
```

Build standalone binary:

```bash
bun run script/build.ts
```

Regenerate SDK artifacts after API route changes (run from repo root):

```bash
./script/generate.ts
```

## Server Defaults, Port Discovery, and Auth

Defaults:

- Base URL fallback if no server is started: `http://localhost:4096`
- `serve`/`web` network defaults: `hostname=127.0.0.1`, `port=0`
- `port=0` means OS-assigned ephemeral port

How to discover the actual bound port:

- `serve` prints: `volt server listening on http://<host>:<port>`
- `web` prints local/network URLs in terminal output

Basic auth:

- Set `VOLTCODE_SERVER_PASSWORD` to require auth
- Username defaults to `voltcode`
- Override username with `VOLTCODE_SERVER_USERNAME`

Core route groups and intent:

- `/session`: create/update/list sessions, prompts, compaction, integrity
- `/provider`: provider auth, model/provider metadata
- `/project`: project/worktree scoped operations
- `/mcp`: MCP server/session lifecycle and auth callbacks
- `/pty`: terminal process/PTY operations
- `/config`: resolved runtime config surface
- `/permission`: permission checks and permission workflow
- `/question`: interactive question/answer prompts
- `/tui`: TUI-specific route surface
- `/global`: global environment/runtime paths and metadata

## LCM Terminology and Levels

- `leaf`: basal in-context unit, represented by `messages` rows
- `sprig`: d1 summary (summary over grouped leaves)
- `bindle`: d2+ summary (summary over grouped sprigs/bindles)
- `d1`, `d2`, `d3+`: condensation depth levels
- `lane`: token budget partition (`leaves`, `sprigs`, `bindles`)
- `condensation DAG`: parent/child summary graph across d-levels
- `lineage`: traversal chain through summary parents/pointers
- `archive stub`: summary row that points to evicted bindle lineage
- `ghost cue`: short narrative cue for evicted bindle (Dolt only)

Context ordering invariant is always:

- `bindles -> sprigs -> leaves`

## LCM End-to-End Runtime Story

This is the concrete runtime path from turn ingestion to compaction/retrieval.

1. Incoming session messages are synced into LCM leaves.

- Source: `src/session/prompt.ts` (`syncSessionMessagesToLcm`)
- Includes user/assistant turns and normalized text extracted from tool/reasoning/message parts
- Appends `messages` + `message_parts` rows

2. A context snapshot is written after each appended leaf.

- Source: `src/session/lcm/context-snapshot.ts`
- Output file: `Global.Path.data/lcm/context.json`
- Reason emitted on append: `leaf_appended`

3. Large file thresholding can externalize content before it bloats context.

- Sources: `src/session/lcm/large-file-threshold.ts`, `src/session/lcm/large-file.ts`, `src/session/lcm/explore/*`
- Default thresholds: `25000` estimated tokens or `100000` bytes
- Large content is stored as LCM file artifacts and replaced by compact markers/references

4. Per-turn token budget is computed.

- Source: `src/session/token-budget.ts`
- `overhead = systemPromptTokens + toolTokens`
- `reserve = output reserve` (default baseline `20000`, capped by model limits)
- `hardLimit = contextWindow - overhead - reserve`
- `softThreshold = min(hardLimit, floor(contextWindow * cutoff) - overhead)`

5. Lane pressure is evaluated with hysteresis.

- Source: `src/session/token-budget.ts` (`evaluateDoltLaneDecisions`)
- Compaction trigger band: `soft + delta`
- Compaction stop target: `target`
- Hard-limit risk bypasses hysteresis when total tokens approach hard limit

6. Threshold behavior branches.

- Over soft threshold: async compaction job scheduled; request continues
- Over hard limit: blocking compaction loop runs before proceeding
- Async compaction is deduplicated per `conversationId` (`inFlightCompactions`)

7. Summaries are generated by LLM calls (not truncation).

- Leaves -> sprig: `src/session/lcm/summarize.ts`
- Sprigs/bindles -> bindle: `src/session/lcm/condense.ts`
- Prompts injected as `system` message; source payload injected as `user`

8. Dolt mode may evict bindles under pressure.

- Source: `src/session/lcm/context.ts`
- Eviction writes archive stubs and optionally ghost cues
- Ghost cue generation has fallback: if LLM cue generation fails, a deterministic excerpt fallback is used

9. Pre-response memory cues can be injected.

- Source: `src/session/prompt.ts` (`buildPreResponseRetrievalQuery`, `formatPreResponseMemoryCueBlock`, `injectPreResponseMemoryCueBlock`)
- Flow: query retrieval using latest user text, filter by thresholds, inject `<memory-cues>` block before final user message in model input

## LCM Modes (`dolt` vs `upward`)

Set mode:

```bash
export VOLTCODE_LCM_MODE=upward
# or
export VOLTCODE_LCM_MODE=dolt
```

If unset, defaults to `upward`. Invalid values fail fast.

### Behavioral Differences

| Capability                 | `dolt`                                    | `upward`                                               |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Threshold compaction style | bounded lane compaction + bindle eviction | recursive upward condensation by depth (d1->d2->d3...) |
| Manual `/compact` mode     | `short_bindle`                            | `forced_recursive`                                     |
| Off-context retrieval      | enabled                                   | disabled (`off_context_unavailable`)                   |
| Ghost cues                 | enabled for evicted bindles               | disabled (hard-off)                                    |
| Bindle eviction            | yes                                       | no                                                     |
| Active context order       | `bindles -> sprigs -> leaves`             | same invariant                                         |

What “recursive upward” means:

- Upward leaf selection uses `VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS` as the raw chunk budget
- Upward attempts condensation at each depth level while Upward fanout constraints are satisfied
- Condensed chunk floor is derived as `minChunkTokens = max(condensedTargetTokens, floor(leafChunkTokens * 0.1))`
- It stops naturally once a level lacks enough parents
- It does not evict bindles to archive in this mode

## Dual-Mode Operator Playbook

### Mode Selection (Runnable)

Run either mode explicitly from `packages/voltcode`:

```bash
# Dolt mode
VOLTCODE_LCM_MODE=dolt bun test test/session/lcm/cross-mode-matrix.test.ts

# Upward mode
VOLTCODE_LCM_MODE=upward bun test test/session/lcm/cross-mode-matrix.test.ts
```

Both runs use the same deterministic matrix fixture and enforce mode-specific behavior instead of silent fallback.

### Pressure, Hysteresis, and Minimum Tuning (Runnable)

```bash
# Example: tighten Dolt bindle hysteresis to force earlier compaction
VOLTCODE_LCM_MODE=dolt \
VOLTCODE_LCM_DOLT_BINDLES_SOFT=8000 \
VOLTCODE_LCM_DOLT_BINDLES_DELTA=500 \
VOLTCODE_LCM_DOLT_BINDLES_TARGET=7000 \
VOLTCODE_LCM_DOLT_BINDLES_MIN_FANOUT=2 \
bun test test/session/lcm/cross-mode-matrix.test.ts

# Example: tighten Upward recursion thresholds
VOLTCODE_LCM_MODE=upward \
VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS=12000 \
VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT=6 \
VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT=4 \
VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD=2 \
VOLTCODE_LCM_UPWARD_CONDENSED_TARGET_TOKENS=1800 \
bun test test/session/lcm/cross-mode-matrix.test.ts
```

### Behavioral Invariants and Intentional Mode Differences

- Invariant (both modes): active context ordering remains `bindles -> sprigs -> leaves`.
- Invariant (both modes): fresh live-tail leaves are preserved during compaction.
- Dolt-only behavior: bindle eviction + ghost cue archival can occur under pressure.
- Upward-only behavior: recursive condensation executes without bindle eviction.
- Retrieval difference: Dolt supports off-context retrieval; Upward returns explicit `off_context_unavailable`.

### Troubleshooting Mode Misconfiguration

- Invalid mode value: startup fails fast with `VOLTCODE_LCM_MODE must be one of: dolt, upward`.
- Unexpected Dolt behavior while expecting Upward: verify shell export with `echo "$VOLTCODE_LCM_MODE"`.
- Unexpected Dolt behavior while expecting Upward: verify process env in the same shell where `bun` starts.
- Retrieval returns empty in Upward: expected by design; check diagnostics for `off_context_unavailable`.
- Ghost cues missing in Upward: expected by design; Upward hard-disables ghost cue archival.

## Lane Policy Semantics (Exact)

For each lane (`leaves`, `sprigs`, `bindles`) policy has:

- `soft`: baseline pressure threshold
- `delta`: hysteresis band above `soft`
- `target`: stop point after compaction starts
- `minFanout`: minimum group size required for a legal compaction step

Computation:

- `upperBound = soft + delta`
- `overUpperBand = laneTokens > upperBound`
- `overTarget = laneTokens > target`
- `shouldCompact = overTarget && (overUpperBand || continuingCompaction || hardLimitRiskBypass)`

Hard-limit risk:

- `riskThreshold = hardLimit - hardLimitRiskBuffer`
- `hardLimitRisk = totalLaneTokens >= riskThreshold`

Leaves lane adds:

- `cap`: non-negative clamp for leaf lane
- `freshTailFloor`: minimum count of most-recent leaves excluded from compaction

## Defaults (As Built)

Runtime defaults parsed from `src/session/lcm/config.ts`:

- `defaultCtxCutoffThreshold = 0.6`
- `targetFreePercentage = 0.25`
- `minMessagesToSummarize = 3`
- `minProtectedTailLeaves = 2`
- `criticalThresholdMultiplier = 1.2`
- `maxCompactionRounds = 10`
- `summaryMaxOutputTokens = 2200`
- `condenseMaxOutputTokens = 2200`

Dolt lane defaults:

- leaves: `soft=50000`, `delta=5000`, `target=50000`, `minFanout=2`, `cap=50000`, `freshTailFloor=4`
- sprigs: `soft=10000`, `delta=2000`, `target=10000`, `minFanout=2`
- bindles: `soft=10000`, `delta=2000`, `target=10000`, `minFanout=2`
- `hardLimitRiskBuffer=0`
- `ghostCueArchiveEnabled=true`

Upward defaults:

- `leafChunkTokens=20000` (`VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS`)
- `leafMinFanout=8` (`VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT`)
- `condensedMinFanout=4` (`VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT`)
- `condensedMinFanoutHard=2` (`VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD`)
- `condensedTargetTokens=2000` (`VOLTCODE_LCM_UPWARD_CONDENSED_TARGET_TOKENS`)
- `minChunkTokens = max(condensedTargetTokens, floor(leafChunkTokens * 0.1))`
- `ghostCueArchiveEnabled=false` always

Important runtime usage note:

- `minProtectedTailLeaves` is actively used in selection logic
- `targetFreePercentage`, `minMessagesToSummarize`, `criticalThresholdMultiplier` are parsed into runtime policy but are not currently central in lane-decision gating paths after lane-policy refactor

## Manual `/compact` Contract

Endpoint:

- `POST /session/:sessionID/lcm/compact`

Response fields:

- `strategy`: `dolt|upward`
- `mode`: `short_bindle|forced_recursive`
- `status`: `executed|no_op`
- `noOpReasons`: explicit reasons for skipped steps

TUI behavior:

- Slash command `/compact`
- Result persisted to `Global.Path.log/compact-result.json`
- UI toasts include strategy/status and no-op reasons

### Dolt `short_bindle` flow

1. Compact oldest eligible leaves into one sprig, preserving fresh tail.
2. Compact all active sprigs into one bindle.
3. If bindle lane still over target, evict one oldest bindle.
4. For evicted bindle, write archive stub + ghost cue.

### Upward `forced_recursive` flow

1. Compact eligible leaves into sprig.
2. Condense recursively across depth levels while fanout allows.
3. No bindle eviction.
4. No ghost cues.

Common `noOpReasons`:

- `eligible_leaves_below_min`
- `leaf_summary_not_smaller_than_input`
- `no_sprigs_to_bindle`
- `bindles_within_target`
- `bindles_over_target_but_no_evictable_bindle`
- `sprigs_below_min_fanout`
- `dN_below_min_fanout` (example: `d2_below_min_fanout`)
- `sprig_condensation_not_smaller_than_input`
- `dN_condensation_not_smaller_than_input`
- `no_legal_compaction_group`

## Summarization, Condensation, and Ghost Cues

Summaries are generated by LLM calls.

- Summarize request builder: `createSummarizeLlmRequest(...)` in `src/session/lcm/summarize.ts`
- Condense request builder: `createCondenseLlmRequest(...)` in `src/session/lcm/condense.ts`
- Both are `generateText(...)` calls with prompt-as-system + payload-as-user
- Both enforce max output tokens via policy (`2200` default)

Which model is used:

- Uses the session’s active model/provider path
- There is a programmatic override parameter in summarize path, but no operator-facing env var for a separate dedicated summary model

Ghost cue specifics:

- Max output tokens: `220`
- Prompt file: `src/session/lcm/prompts/ghost-cue.txt`
- Stored format includes YAML frontmatter:

```text
---
bindle_id: <bindle-id>
---
<narrative>
```

## Prompt Registry and Depth Policy

Registry file:

- `src/session/lcm/prompt-registry.ts`

Mappings:

- `dolt:summarize:d1 -> prompts/dolt/summarize/d1.txt`
- `dolt:condense:d2 -> prompts/dolt/condense/d2.txt`
- `upward:summarize:d1 -> prompts/upward/summarize/d1.txt`
- `upward:condense:d2 -> prompts/upward/condense/d2.txt`
- `upward:condense:d3 -> prompts/upward/condense/d3.txt`

Finite-depth reuse:

- Upward condense `d3+` normalizes to `d3` prompt template

## Retrieval and Tooling

### LCM Retrieval Behavior

Mode-aware retrieval facade:

- `src/session/lcm/retrieval-facade.ts`

Behavior:

- Dolt: off-context bindle retrieval is enabled
- Upward: off-context retrieval is unavailable; only active condensation DAG summaries are eligible

### LCM Tool Surface

LCM-focused tools:

- `lcm_describe`
- `lcm_expand`
- `lcm_expand_query`
- `lcm_grep`

Operator workflow:

1. Use `lcm_describe` to inspect conversation/summary state.
2. Use `lcm_expand_query` to find candidate summary IDs from query text.
3. Use `lcm_expand` to expand specific summary IDs and inspect lineage.
4. Use `lcm_grep` for targeted content matching across LCM artifacts.

Tool sources:

- `src/tool/lcm-describe.ts`
- `src/tool/lcm-expand.ts`
- `src/tool/lcm-expand-query.ts`
- `src/tool/lcm-grep.ts`

Other high-utility operator tools:

- `llm_map`: parallel non-agentic JSONL processing with one LLM call per item, schema-validated output, and no tool/file I/O
- `agentic_map`: parallel JSONL processing with one sub-agent per item, tool-capable execution, and schema-validated output
- `tasks`: parallel execution of multiple independent sub-agent tasks in one call

Sources:

- `src/tool/llm-map.ts`
- `src/tool/agentic-map.ts`
- `src/tool/tasks.ts`

## Context Snapshot Output (`context.json`)

Snapshot writer:

- `src/session/lcm/context-snapshot.ts`

Default file:

- `Global.Path.data/lcm/context.json`

Snapshot includes:

- lane token counts
- lane item counts
- context item count
- ordering invariant (`bindles_sprigs_leaves`)
- referenced tables and conversation id

Write triggers commonly seen:

- `leaf_appended`
- `compaction_hard_limit`
- `compaction_async_complete`

## LCM Environment Variables (Complete)

Parsed in `src/session/lcm/config.ts` unless noted.

### Database Selection

| Variable           | Default        | Type       | Notes                                    |
| ------------------ | -------------- | ---------- | ---------------------------------------- |
| `LCM_DATABASE_URL` | embedded URL   | string     | If set, embedded Postgres is skipped     |
| `RDS_ENDPOINT`     | unset          | string     | Used with username/password to build URL |
| `RDS_PORT`         | `5432`         | string/int | Used only in RDS URL construction        |
| `RDS_USERNAME`     | unset          | string     | Used only in RDS URL construction        |
| `RDS_PASSWORD`     | unset          | string     | URL-encoded in constructed URL           |
| `RDS_DATABASE`     | `voltcode_lcm` | string     | Used only in RDS URL construction        |

URL precedence:

1. `LCM_DATABASE_URL`
2. Construct from `RDS_*` trio (`ENDPOINT`, `USERNAME`, `PASSWORD`)
3. Embedded URL (`postgres://voltcode@127.0.0.1:54329/voltcode_lcm`)

### Mode and Runtime Policy

| Variable | Default | Type constraint |
|---|---|---|
| `VOLTCODE_LCM_MODE` | `upward` | enum: `dolt|upward` |
| `VOLTCODE_LCM_DEFAULT_CTX_CUTOFF_THRESHOLD` | `0.6` | finite float in `[0,1]` |
| `VOLTCODE_LCM_TARGET_FREE_PERCENTAGE` | `0.25` | finite float in `[0,1]` |
| `VOLTCODE_LCM_MIN_MESSAGES_TO_SUMMARIZE` | `3` | integer `>=1` |
| `VOLTCODE_LCM_MIN_PROTECTED_TAIL_LEAVES` | `2` | integer `>=1` |
| `VOLTCODE_LCM_CRITICAL_THRESHOLD_MULTIPLIER` | `1.2` | finite float `>0` |
| `VOLTCODE_LCM_MAX_COMPACTION_ROUNDS` | `10` | integer `>=1` |
| `VOLTCODE_LCM_SUMMARY_MAX_OUTPUT_TOKENS` | `2200` | integer `>=1` |
| `VOLTCODE_LCM_CONDENSE_MAX_OUTPUT_TOKENS` | `2200` | integer `>=1` |

### Upward Recursive Controls (Exact)

| Variable                                        | Default | Type constraint |
| ----------------------------------------------- | ------- | --------------- |
| `VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS`         | `20000` | integer `>0`    |
| `VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT`           | `8`     | integer `>0`    |
| `VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT`      | `4`     | integer `>0`    |
| `VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD` | `2`     | integer `>0`    |
| `VOLTCODE_LCM_UPWARD_CONDENSED_TARGET_TOKENS`   | `2000`  | integer `>0`    |

Derived upward condensed floor:

- `minChunkTokens = max(condensedTargetTokens, floor(leafChunkTokens * 0.1))`

### Per-Mode Lane Policy

Prefixes:

- `VOLTCODE_LCM_DOLT_*`
- `VOLTCODE_LCM_UPWARD_*`

Leaves lane vars:

- `<PREFIX>LEAVES_SOFT` (default `50000`)
- `<PREFIX>LEAVES_DELTA` (default `5000`)
- `<PREFIX>LEAVES_TARGET` (default `50000`)
- `<PREFIX>LEAVES_MIN_FANOUT` (default `2`)
- `<PREFIX>LEAVES_CAP` (default `50000`)
- `<PREFIX>LEAVES_FRESH_TAIL_FLOOR` (default `4`)

Sprigs lane vars:

- `<PREFIX>SPRIGS_SOFT` (default `10000`)
- `<PREFIX>SPRIGS_DELTA` (default `2000`)
- `<PREFIX>SPRIGS_TARGET` (default `10000`)
- `<PREFIX>SPRIGS_MIN_FANOUT` (default `2`)

Bindles lane vars:

- `<PREFIX>BINDLES_SOFT` (default `10000`)
- `<PREFIX>BINDLES_DELTA` (default `2000`)
- `<PREFIX>BINDLES_TARGET` (default `10000`)
- `<PREFIX>BINDLES_MIN_FANOUT` (default `2`)

Additional per-mode:

- `<PREFIX>HARD_LIMIT_RISK_BUFFER` (default `0`)
- `VOLTCODE_LCM_DOLT_GHOST_CUE_ARCHIVE_ENABLED` (boolean string `true|false`, default `true`)
- `VOLTCODE_LCM_UPWARD_GHOST_CUE_ARCHIVE_ENABLED` is not read for behavior; upward hardcodes false and setting this has no effect

### Retrieval and Pre-Response Hook Tuning

| Variable                                      | Default                  | Type               |
| --------------------------------------------- | ------------------------ | ------------------ |
| `VOLTCODE_LCM_RETRIEVAL_QMD_INDEX_PREFIX`     | `voltcode-lcm-retrieval` | string             |
| `VOLTCODE_LCM_RETRIEVAL_QMD_COLLECTION_NAME`  | `off-context-bindles`    | string             |
| `VOLTCODE_LCM_RETRIEVAL_TOP_K`                | `3`                      | positive integer   |
| `VOLTCODE_LCM_RETRIEVAL_MIN_SCORE`            | `0.3`                    | float in `[0,1]`   |
| `VOLTCODE_LCM_RETRIEVAL_MAX_DISTANCE`         | unset                    | non-negative float |
| `VOLTCODE_LCM_PRE_RESPONSE_HOOK_TOP_K`        | `3`                      | positive integer   |
| `VOLTCODE_LCM_PRE_RESPONSE_HOOK_MIN_SCORE`    | retrieval min score      | float in `[0,1]`   |
| `VOLTCODE_LCM_PRE_RESPONSE_HOOK_MAX_DISTANCE` | unset                    | non-negative float |

### Other LCM-Adjacent Flags

| Variable                         | Source             | Meaning                                                                  |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `VOLTCODE_LCM_CONTEXT_THRESHOLD` | `src/flag/flag.ts` | token override for soft threshold (`--context-threshold` also sets this) |
| `VOLTCODE_DISABLE_AUTOCOMPACT`   | `src/flag/flag.ts` | disables automatic compaction in config layer                            |

### Server Auth Flags

| Variable                   | Default    | Meaning                   |
| -------------------------- | ---------- | ------------------------- |
| `VOLTCODE_SERVER_PASSWORD` | unset      | enables basic auth if set |
| `VOLTCODE_SERVER_USERNAME` | `voltcode` | basic auth username       |

## Embedded vs External Postgres

Embedded Postgres constants:

- Version: `17.7`
- Build: `1`
- Host: `127.0.0.1`
- Port: `54329`
- DB name: `voltcode_lcm`
- User: `voltcode`

Paths:

- root: `Global.Path.data/postgres/17.7/`
- binaries: `.../bin`
- data dir: `.../data`
- log: `Global.Path.log/postgres.log`
- install lock: `.../install.lock`

Startup behavior:

1. `ensureLcmReady()` resolves runtime strategy.
2. If external DB config exists, embedded bootstrap is skipped.
3. Otherwise embedded binaries/cluster/startup are ensured.
4. `LcmDb.initialize()` is called.
5. `LcmDb.initialize()` runs `migrate()` automatically.

Sources:

- `src/session/lcm/runtime.ts`
- `src/session/lcm/embedded-postgres.ts`
- `src/session/lcm/db.ts`

## Testing Dual-Mode LCM

Run from `packages/voltcode`.

```bash
LCM_DATABASE_URL='postgres://<user>@127.0.0.1:5432/postgres' bun test \
  test/session/lcm/retrieval-facade.test.ts \
  test/tool/lcm-expand-query.test.ts \
  test/session/lcm/config.test.ts \
  test/session/lcm/context.test.ts \
  test/session/lcm/strategy.test.ts \
  test/session/lcm/strategy-upward-manual.test.ts \
  test/session/lcm/strategy-dolt.test.ts \
  test/session/lcm/cross-mode-matrix.test.ts
```

Notes:

- These tests require a reachable Postgres URL if embedded DB is unavailable.
- `cross-mode-matrix.test.ts` validates deterministic seed behavior across Dolt and Upward.

Regression lock suite (`volt-dc7.13.7`):

```bash
bun test ./test/session/lcm/dolt-validation.test.ts \
  ./test/session/lcm/cross-mode-matrix.test.ts \
  ./test/session/lcm/strategy.test.ts \
  ./test/session/lcm/upward-phase1-chunk-loop.test.ts \
  ./test/session/lcm/upward-depth-selectors.test.ts \
  ./test/session/lcm/upward-phase2-shallowest-first.test.ts \
  ./test/session/lcm/upward-hard-trigger-parity.test.ts \
  ./test/session/lcm/runtime-invalid-mode.test.ts
```

## Code Map (Where to Change What)

LCM policy and dispatch:

- `src/session/lcm/config.ts`: env parsing, defaults, strict validation
- `src/session/token-budget.ts`: budget math, lane decisions, hysteresis logic
- `src/session/lcm/strategy.ts`: mode dispatch and hard-limit compaction loop
- `src/session/lcm/strategy-dolt.ts`: Dolt adapter implementation

LCM compaction internals:

- `src/session/lcm/context.ts`: threshold compaction, manual `/compact`, selection, eviction
- `src/session/lcm/summarize.ts`: leaves->sprig LLM summarize path
- `src/session/lcm/condense.ts`: summary->bindle LLM condense path
- `src/session/lcm/ghost-cue.ts`: ghost cue generation, fallback, frontmatter wrapping

LCM persistence and retrieval:

- `src/session/lcm/db.ts`: schema access/migrations/context ordering/lineage tables
- `src/session/lcm/retrieval.ts`: off-context retrieval implementation
- `src/session/lcm/retrieval-facade.ts`: mode-aware retrieval contract
- `src/session/lcm/context-snapshot.ts`: snapshot read/write (`context.json`)
- `src/session/lcm/integrity.ts`: lineage/integrity checks

Large-file path:

- `src/session/lcm/large-file-threshold.ts`: large-file thresholding
- `src/session/lcm/large-file.ts`: large-file data model and references
- `src/session/lcm/explore/*`: type-aware file explorers and summaries

Prompt path:

- `src/session/lcm/prompt-registry.ts`: prompt key mapping + d3+ normalization
- `src/session/lcm/prompts/dolt/*`: Dolt prompts
- `src/session/lcm/prompts/upward/*`: Upward prompts
- `src/session/lcm/prompts/ghost-cue.txt`: ghost cue prompt

Session + UI/API integration:

- `src/session/prompt.ts`: message sync, compaction scheduling, pre-response cue injection
- `src/server/routes/session.ts`: `/session/:sessionID/lcm/compact`, integrity route
- `src/cli/cmd/tui/routes/session/index.tsx`: `/compact` UI status/no-op reporting

Tooling surface:

- `src/tool/lcm-describe.ts`, `src/tool/lcm-expand.ts`, `src/tool/lcm-expand-query.ts`, `src/tool/lcm-grep.ts`
- `src/tool/llm-map.ts`, `src/tool/agentic-map.ts`, `src/tool/tasks.ts`

## Notes

- Startup policy parsing is strict. Invalid enum/numeric values throw explicit errors.
- Upward mode intentionally disables off-context retrieval and ghost-cue archival behavior.
- `VOLTCODE_LCM_UPWARD_GHOST_CUE_ARCHIVE_ENABLED` is currently non-operative by design.
