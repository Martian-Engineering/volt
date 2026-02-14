# VoltCode Evaluation Suite

Internal evaluation benchmarks for testing VoltCode agent capabilities. **These are NOT included in the user-facing executable build.**

## Supported Benchmarks

| Benchmark              | Description                       | Tasks | Source                                                    |
| ---------------------- | --------------------------------- | ----- | --------------------------------------------------------- |
| **SWE-bench Verified** | Real GitHub issue resolution      | 500   | [swebench.com](https://www.swebench.com/)                 |
| **MCP Atlas**          | Multi-tool MCP server tasks       | 1000  | [scale.com](https://scale.com/blog/mcp-atlas)             |
| **LoCoBench-Agent**    | Long-context software engineering | 8000  | [arxiv](https://arxiv.org/abs/2511.13998)                 |
| **Context-Bench**      | Context engineering proficiency   | ~50   | [letta.com](https://www.letta.com/blog/context-bench)     |
| **Terminal-Bench 2.0** | Terminal/CLI task completion      | 89    | [tbench.ai](https://www.tbench.ai/)                       |
| **Aider Polyglot**     | Multi-language coding problems    | 225   | [aider.chat](https://aider.chat/2024/12/21/polyglot.html) |

## Usage

```bash
# From packages/voltcode directory

# List available benchmarks
bun evals/cli.ts list

# Run a specific benchmark
bun evals/cli.ts swe-bench --limit 10

# Run with a specific model
bun evals/cli.ts aider-polyglot --model anthropic/claude-sonnet-4 --limit 20

# Run all benchmarks (limited for testing)
bun evals/cli.ts all --limit 5
```

## Options

| Option              | Description         | Default        |
| ------------------- | ------------------- | -------------- |
| `--limit <n>`       | Max tasks to run    | All            |
| `--model <model>`   | Model (provider/id) | Default        |
| `--timeout <ms>`    | Timeout per task    | 600000         |
| `--concurrency <n>` | Parallel tasks      | 1              |
| `--output <dir>`    | Results directory   | ./eval-results |
| `--tasks <ids>`     | Specific task IDs   | All            |

## Benchmark Details

### SWE-bench Verified

Tests ability to resolve real GitHub issues by generating patches.

**Evaluation:**

- FAIL_TO_PASS tests must pass (issue resolved)
- PASS_TO_PASS tests must pass (no regressions)

**Requirements:** Python, pytest, git

### MCP Atlas

Tests tool-use capabilities across 36 MCP servers with 220+ tools.

**Evaluation:**

- LLM-as-judge evaluates claims against ground truth
- Pass if coverage score >= 75%

**Requirements:** Node.js (for MCP servers)

### LoCoBench-Agent

Tests long-context software engineering across 10 languages.

**Evaluation:**

- Comprehension metrics (5 types)
- Efficiency metrics (4 types)
- Context lengths from 10K to 1M tokens

### Context-Bench

Tests context management and memory efficiency.

**Task types:**

- File chaining
- Entity relationship tracing
- Multi-step information retrieval
- Memory management
- Context switching

### Terminal-Bench 2.0

Tests terminal task completion in Docker environments.

**Categories:**

- Compilation
- ML training
- Server setup
- Scientific workflows
- Networking
- Security
- Data analysis

**Requirements:** Docker

### Aider Polyglot

Tests coding across 6 languages with 2 attempts per problem.

**Languages:** C++, Go, Java, JavaScript, Python, Rust

**Evaluation:** Unit tests per language

**Requirements:** Language toolchains (gcc, go, javac, node, python, rustc)

## Architecture

```
evals/
├── index.ts           # Main exports
├── types.ts           # Common types and interfaces
├── runner.ts          # Central benchmark runner
├── cli.ts             # CLI interface
├── swe-bench/         # SWE-bench implementation
├── mcp-atlas/         # MCP Atlas implementation
├── locobench-agent/   # LoCoBench-Agent implementation
├── context-bench/     # Context-Bench implementation
├── terminal-bench/    # Terminal-Bench implementation
└── aider-polyglot/    # Aider Polyglot implementation
```

## Adding New Benchmarks

1. Create a new directory under `evals/`
2. Implement `EvalTypes.BenchmarkRunner` interface
3. Export from `evals/index.ts`
4. Register in `evals/runner.ts`

```typescript
export namespace NewBenchmark {
  export class Runner implements EvalTypes.BenchmarkRunner {
    name = "new-benchmark"
    version = "1.0.0"
    description = "Description here"

    async setup(): Promise<void> {
      /* ... */
    }
    async listTasks(): Promise<string[]> {
      /* ... */
    }
    async runTask(taskId: string, config: RunConfig): Promise<TaskResult> {
      /* ... */
    }
    async run(config: RunConfig): Promise<BenchmarkResult> {
      /* ... */
    }
    async cleanup(): Promise<void> {
      /* ... */
    }
  }
}
```

## Results Format

Results are saved as JSON with the following structure:

```json
{
  "benchmark": "swe-bench-verified",
  "version": "1.0.0",
  "model": "anthropic/claude-sonnet-4",
  "startedAt": "2025-01-26T10:00:00.000Z",
  "completedAt": "2025-01-26T12:00:00.000Z",
  "totalTasks": 100,
  "passedTasks": 65,
  "passRate": 0.65,
  "averageScore": 0.72,
  "totalDuration": 7200000,
  "tasks": [
    {
      "taskId": "django__django-12345",
      "passed": true,
      "score": 1.0,
      "duration": 45000,
      "metadata": { ... }
    }
  ]
}
```

## Why Not In Build?

These evals are excluded from the main executable because:

1. **Size**: Benchmark code and data would significantly increase binary size
2. **Dependencies**: Some benchmarks need Python, Docker, language toolchains
3. **Internal use**: Only needed for development/testing, not end users
4. **Isolation**: Keeps evaluation separate from production code

The build system uses tree-shaking from `src/index.ts`, so this `evals/` directory (outside `src/`) is automatically excluded.
